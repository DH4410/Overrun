import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * The first-person arms: assets/player/hands.glb (tools/blender/export_hands.py), two skinned gloved
 * arms on one rig. The rig carries no clips. Each frame this module is told where each wrist goes and
 * how the hand is turned and curled, and poses the skeleton to match: a two-bone solve from a fixed
 * shoulder (behind and below the camera) to the wrist, the elbow bending toward a pole, and a curl
 * angle for every finger joint.
 *
 * All the maths runs in the rig node's frame, which is the three.js one (the Blender-to-glTF axis
 * conversion sits on the `root` bone): a resting hand has its fingers along -Z and its palm facing -Y.
 * Callers pass points and directions in the gun's frame together with the viewmodel rig's matrix.
 */

let art = null;
try {
  art = (await new GLTFLoader().loadAsync('assets/player/hands.glb')).scene;
} catch {
  art = null;
}

export const handsLoaded = () => art !== null;

const FINGERS = ['idx', 'mid', 'rng', 'pnk', 'th'];
const SHOULDER = { r: new THREE.Vector3(0.29, -0.52, -0.05), l: new THREE.Vector3(-0.29, -0.52, -0.05) };
const POLE = { r: new THREE.Vector3(0.8, -0.6, 0.3), l: new THREE.Vector3(-0.8, -0.6, 0.3) };
/** A resting hand's palm direction, and its fingers' and side axes, in the rig's frame (see the note on frames above). */
const DOWN = new THREE.Vector3(0, -1, 0);
const REST_BASIS = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)));
const REST_BASIS_INV = REST_BASIS.clone().invert();
/** The arms are modelled a little big for a viewmodel scene, where the gun sits 0.3 m from the eye. */
const HAND_SCALE = 0.95;

const _v = new THREE.Vector3();
const _S = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** Bone rest data in the rig's frame, read once from the freshly cloned skeleton. */
function readRest(root, rig) {
  root.updateMatrixWorld(true);
  const inv = rig.matrixWorld.clone().invert();
  const rest = {};
  rig.traverse((b) => {
    if (!b.isBone) return;
    _m.multiplyMatrices(inv, b.matrixWorld);
    const head = new THREE.Vector3();
    const worldQ = new THREE.Quaternion();
    _m.decompose(head, worldQ, new THREE.Vector3());
    rest[b.name] = { bone: b, head, worldQ, localQ: b.quaternion.clone(), localPos: b.position.clone() };
  });
  return rest;
}

export function createHandRig() {
  if (!art) return null;
  const root = skeletonClone(art);
  root.scale.setScalar(HAND_SCALE);
  const rig = root.getObjectByName('Rig');
  root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; } });
  const rest = readRest(root, rig);
  const L1 = rest.upperarm_r.head.distanceTo(rest.forearm_r.head);
  const L2 = rest.forearm_r.head.distanceTo(rest.hand_r.head);

  // Each finger bone's curl axis in its own rest frame: toward the palm, whatever way the bone points.
  const curlAxis = {};
  for (const s of ['r', 'l']) {
    for (const f of FINGERS) {
      let dPrev = null;
      for (let i = 1; i <= 3; i++) {
        const nm = `${f}${i}_${s}`;
        const here = rest[nm];
        const next = rest[`${f}${i + 1}_${s}`];
        const d = next ? next.head.clone().sub(here.head).normalize() : dPrev.clone();
        dPrev = d;
        const axis = d.clone().cross(DOWN);
        if (axis.lengthSq() < 1e-6) axis.set(-1, 0, 0);
        axis.normalize().applyQuaternion(here.worldQ.clone().invert());
        curlAxis[nm] = axis;
      }
    }
  }
  // The last bone of a finger has no child bone: its direction is the previous one's (set above).

  const out = { root, rig };
  const rigInv = new THREE.Matrix4();
  const rigQInv = new THREE.Quaternion();
  const vmQ = new THREE.Quaternion();
  const toRigPoint = (p, vmMatrix, outV) => outV.copy(p).applyMatrix4(vmMatrix).applyMatrix4(rigInv);
  const toRigDir = (d, outV) => outV.copy(d).applyQuaternion(vmQ).applyQuaternion(rigQInv).normalize();

  const wrist = new THREE.Vector3();
  const fDir = new THREE.Vector3();
  const nDir = new THREE.Vector3();
  const E = new THREE.Vector3();
  const T = new THREE.Vector3();
  const ax = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const rootQ = rest.root.worldQ;
  const rootQInv = rootQ.clone().invert();

  /** Point `bone` from `head` toward `to`; returns its new world rotation. */
  function aim(name, from, to, parentQ, restDir) {
    const r = rest[name];
    _v.copy(to).sub(from).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(restDir, _v).multiply(r.worldQ);
    r.bone.quaternion.copy(parentQ.clone().invert().multiply(q));
    return q;
  }

  /**
   * Pose one arm. `h` = { p, f, n, curl } in gun space: p the wrist, f the way the fingers point, n
   * the way the palm faces, curl { idx: [a, b, c], mid, rng, pnk, th } in degrees (positive closes).
   */
  function poseArm(s, h, vmMatrix) {
    toRigPoint(h.p, vmMatrix, wrist);
    toRigDir(h.f, fDir);
    toRigDir(h.n, nDir);
    const S = _S.copy(SHOULDER[s]);
    const up = rest[`upperarm_${s}`];
    // An arm too short for the pose slides its shoulder along the line instead, keeping the hand where it was told.
    const reach = (L1 + L2) * 0.97;
    T.copy(wrist).sub(S);
    if (T.length() > reach) S.copy(wrist).addScaledVector(T.normalize(), -reach);
    // The shoulder moves: the bone's own offset from the root changes, its rotation does the aiming.
    up.bone.position.copy(S).sub(rest.root.head).applyQuaternion(rootQInv);

    // Two-bone solve (law of cosines), the elbow toward the pole.
    T.copy(wrist).sub(S);
    let d = T.length();
    d = Math.max(Math.abs(L1 - L2) + 1e-3, Math.min(L1 + L2 - 1e-3, d));
    ax.copy(T).normalize();
    nrm.copy(POLE[s]);
    nrm.addScaledVector(ax, -nrm.dot(ax));
    if (nrm.lengthSq() < 1e-6) nrm.set(0, 0, -1);
    nrm.normalize();
    const ca = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const sa = Math.sqrt(Math.max(0, 1 - ca * ca));
    E.copy(S).addScaledVector(ax, L1 * ca).addScaledVector(nrm, L1 * sa);
    const Tc = S.clone().addScaledVector(ax, d);

    const restDir = (a, b) => rest[b].head.clone().sub(rest[a].head).normalize();
    const qUp = aim(`upperarm_${s}`, S, E, rootQ, restDir(`upperarm_${s}`, `forearm_${s}`));
    const qFore = aim(`forearm_${s}`, E, Tc, qUp, restDir(`forearm_${s}`, `hand_${s}`));
    // The hand turns with the pose: fingers along f, palm toward n.
    const y = fDir;
    const z = _v.copy(nDir).negate();
    z.addScaledVector(y, -z.dot(y)).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    _m.makeBasis(x, y, z);
    const qHand = new THREE.Quaternion().setFromRotationMatrix(_m).multiply(REST_BASIS_INV).multiply(rest[`hand_${s}`].worldQ);
    rest[`hand_${s}`].bone.quaternion.copy(qFore.clone().invert().multiply(qHand));

    for (const f of FINGERS) {
      const angles = h.curl[f] ?? [0, 0, 0];
      for (let i = 1; i <= 3; i++) {
        const nm = `${f}${i}_${s}`;
        _q.setFromAxisAngle(curlAxis[nm], THREE.MathUtils.degToRad(angles[i - 1]));
        rest[nm].bone.quaternion.copy(rest[nm].localQ).multiply(_q);
      }
    }
  }

  /**
   * `poses` = { r, l } hand poses (or null to leave a hand where it was), `vmMatrix` the viewmodel
   * rig's world matrix (gun space -> scene).
   */
  out.update = (poses, vmMatrix) => {
    root.updateMatrixWorld(true);
    rigInv.copy(rig.matrixWorld).invert();
    rig.getWorldQuaternion(rigQInv).invert();
    vmQ.setFromRotationMatrix(vmMatrix);
    for (const s of ['r', 'l']) if (poses[s]) poseArm(s, poses[s], vmMatrix);
  };
  return out;
}
