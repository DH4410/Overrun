import * as THREE from 'three';
import { createHandRig } from './handRig.js';

/**
 * The first-person hands on the held gun: where each hand goes for each kind of gun, and what the
 * left hand does during a reload. handRig.js turns these poses into a skeleton pose.
 *
 * Everything here is in the gun's frame (metres, -Z forward, +Y up), so it follows the gun through
 * sway, recoil, the aim and the reload tilt. A hand is { p: wrist, f: way the fingers point, n: way
 * the palm faces, curl }; curl is degrees per joint, positive closes the hand.
 */

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const sm = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

const curl = (prox, mid, dist, th = [14, 22, 14], idx = null) => ({
  idx: idx ?? [prox, mid, dist], mid: [prox + 2, mid + 2, dist], rng: [prox + 4, mid + 3, dist + 2], pnk: [prox + 8, mid + 4, dist + 4], th,
});
const OPEN = curl(6, 8, 4, [4, 6, 4]);

/** Which hold each gun uses. */
const CLASS = {
  ar: 'rifle', smg: 'rifle', lmg: 'rifle', dmr: 'rifle', sniper: 'rifle', shotgun: 'rifle', ashotgun: 'rifle',
  pistol: 'pistol', revolver: 'pistol', mp: 'pistol', frag: 'frag',
};

/** A hand whose palm sits on `at`, fingers along f, palm toward n. The wrist is what the rig wants. */
function palmAt(at, f, n, curlSet, back = 0.052, lift = 0.03) {
  const ff = f.clone().normalize();
  const nn = n.clone().normalize();
  return { p: at.clone().addScaledVector(ff, -back).addScaledVector(nn, -lift), f: ff, n: nn, curl: curlSet };
}

const RIGHT_GRIP = { f: V(0.05, -0.3, -0.95), n: V(-1, 0.05, 0.02) };

function holdFor(cls, ud) {
  const g = ud.grip;
  const s = ud.support;
  const r = palmAt(g, RIGHT_GRIP.f, RIGHT_GRIP.n, curl(62, 72, 48, [16, 26, 16], [24, 30, 16]));
  if (cls === 'pistol') {
    // Both hands on the grip: the left wraps the right's fingers from the other side.
    const l = palmAt(g.clone().add(V(-0.012, -0.012, -0.006)), V(0.1, -0.2, -0.97), V(1, 0.05, 0), curl(70, 78, 52, [10, 22, 12]), 0.05, 0.034);
    return { r, l };
  }
  if (cls === 'frag') {
    const ball = g.clone().add(V(0, -0.012, 0));
    return {
      r: palmAt(ball, V(0, 0.12, -1), V(0, 1, 0.08), curl(48, 58, 38, [12, 22, 12]), 0.05, 0.04),
      l: { p: V(-0.12, -0.22, 0.16), f: V(0.35, 0.2, -0.9).normalize(), n: V(0.7, 0.6, 0).normalize(), curl: curl(24, 30, 18) },
    };
  }
  // Rifles and shotguns: support hand under the handguard, fingers wrapped up the far side.
  const l = palmAt(s.clone().add(V(0, 0, 0)), V(0, 0.03, -1), V(0.25, 0.95, 0), curl(40, 50, 34, [10, 20, 12]), 0.07, 0.048);
  return { r, l };
}

/** Where the magazine (or the loading port) is, and which way it comes out. */
function magAnchor(id, g, ud) {
  const mag = g.getObjectByName('mag');
  if (mag) {
    const box = new THREE.Box3().setFromObject(mag);
    const c = box.getCenter(new THREE.Vector3());
    return { p: c, out: V(-0.03, -1, 0.1).normalize(), travel: Math.max(0.12, (box.max.y - box.min.y) * 1.6), mag };
  }
  const cls = CLASS[id];
  if (cls === 'pistol') return { p: ud.grip.clone().add(V(0, -0.07, 0.005)), out: V(0, -1, 0.05).normalize(), travel: 0.14, mag: null };
  if (id === 'shotgun' || id === 'ashotgun') return { p: ud.grip.clone().add(V(0, -0.025, -0.1)), out: V(-0.1, -1, 0).normalize(), travel: 0.05, mag: null, port: true };
  return { p: ud.grip.clone().add(V(0, -0.045, -0.09)), out: V(0, -1, 0.1).normalize(), travel: 0.12, mag: null };
}

function lerpHand(a, b, t, out) {
  out.p.lerpVectors(a.p, b.p, t);
  out.f.lerpVectors(a.f, b.f, t).normalize();
  out.n.lerpVectors(a.n, b.n, t).normalize();
  for (const k of Object.keys(a.curl)) for (let i = 0; i < 3; i++) out.curl[k][i] = a.curl[k][i] + (b.curl[k][i] - a.curl[k][i]) * t;
  return out;
}

const mkHand = () => ({ p: new THREE.Vector3(), f: new THREE.Vector3(), n: new THREE.Vector3(), curl: curl(0, 0, 0) });

export function createViewHands({ vmScene, vmRig, vmModels }) {
  const rig = createHandRig();
  if (!rig) return null;
  vmScene.add(rig.root);
  rig.root.visible = false;

  const holds = {};
  const mags = {};
  vmRig.updateMatrixWorld(true);
  const inv = vmRig.matrixWorld.clone().invert();
  for (const id in vmModels) {
    const g = vmModels[id];
    const ud = g.userData;
    if (!ud.grip) continue;
    holds[id] = holdFor(CLASS[id] ?? 'rifle', ud);
    g.updateMatrixWorld(true);
    const m = magAnchor(id, g, ud);
    if (m.mag) { m.rest = m.mag.position.clone(); m.scale = m.mag.parent?.scale.x ?? 1; }
    if (m.mag) m.p.applyMatrix4(inv);
    mags[id] = m;
  }

  const left = mkHand();
  const right = mkHand();
  const pose = { r: right, l: left };

  /** The left hand on a reload, at progress p (0..1): to the magazine, off with it, a fresh one in, the action, back. */
  function reloadLeft(id, hold, p) {
    const m = mags[id];
    const home = hold.l;
    const down = m.out.clone().multiplyScalar(m.travel);
    const grab = { p: m.p.clone().add(V(-0.05, 0.02, 0.0)), f: V(0.1, -0.35, -0.93).normalize(), n: V(1, 0.1, 0).normalize(), curl: OPEN };
    const hold1 = { p: m.p.clone().add(V(-0.04, 0.0, 0)), f: V(0.1, -0.5, -0.86).normalize(), n: V(1, 0.1, 0).normalize(), curl: curl(52, 62, 40, [16, 26, 16]) };
    const out = mkHand();
    let magOff = null;
    if (m.port) {
      // Shotgun: shells go in under the receiver, three pushes, then the pump.
      const pushes = Math.abs(Math.sin(sm((p - 0.2) / 0.55) * Math.PI * 3));
      const port = { p: m.p.clone().add(V(-0.045, -0.035, 0)), f: V(0.3, 0.55, -0.78).normalize(), n: V(0.8, -0.1, 0.2).normalize(), curl: curl(46, 56, 36, [10, 20, 12]) };
      if (p < 0.2) lerpHand(home, port, sm(p / 0.2), out);
      else if (p < 0.78) { lerpHand(port, port, 0, out); out.p.addScaledVector(V(0.03, 0.045, -0.01), pushes); }
      else if (p < 0.9) {
        const k = sm((p - 0.78) / 0.12);
        lerpHand(port, home, k, out);
        out.p.z += 0.0;
      } else {
        // pump: back along the forend, then forward
        const k = (p - 0.9) / 0.1;
        lerpHand(home, home, 0, out);
        out.p.z += 0.09 * Math.sin(k * Math.PI);
      }
      return { hand: out, magOff };
    }
    const phase = (a, b) => sm((p - a) / (b - a));
    if (p < 0.16) lerpHand(home, grab, phase(0, 0.16), out);
    else if (p < 0.26) lerpHand(grab, hold1, phase(0.16, 0.26), out);
    else if (p < 0.46) {
      // pull the magazine out, down and away
      lerpHand(hold1, hold1, 0, out);
      const k = phase(0.26, 0.46);
      out.p.addScaledVector(down, k);
      magOff = down.clone().multiplyScalar(k);
    } else if (p < 0.6) {
      // the old one drops; the hand goes for a new one, which comes up from below
      const k = phase(0.46, 0.6);
      lerpHand(hold1, grab, k * 0.5, out);
      out.p.copy(m.p).addScaledVector(down, 1.3 - k * 0.3).add(V(-0.04, 0, 0));
      magOff = down.clone().multiplyScalar(1.3 - k * 0.3);
    } else if (p < 0.76) {
      const k = phase(0.6, 0.76);
      lerpHand(hold1, hold1, 0, out);
      out.p.copy(m.p).addScaledVector(down, 1.0 * (1 - k)).add(V(-0.04, 0, 0));
      magOff = down.clone().multiplyScalar(1.0 * (1 - k));
    } else if (p < 0.9) {
      // a slap on the charging handle: up to the receiver and back
      const k = Math.sin(phase(0.76, 0.9) * Math.PI);
      lerpHand(hold1, home, phase(0.76, 0.9), out);
      out.p.z += 0.05 * k;
    } else lerpHand(home, home, 0, out);
    return { hand: out, magOff };
  }

  /** `ctx`: id, vmMatrix (the viewmodel rig's world matrix), reload (0..1 progress, or -1), show. */
  function update(ctx) {
    const hold = holds[ctx.id];
    rig.root.visible = !!hold && ctx.show;
    if (!rig.root.visible) return;
    const m = mags[ctx.id];
    // Restore a moved magazine unless this frame moves it again.
    if (m?.mag) m.mag.position.copy(m.rest);
    right.p.copy(hold.r.p); right.f.copy(hold.r.f); right.n.copy(hold.r.n);
    for (const k of Object.keys(hold.r.curl)) for (let i = 0; i < 3; i++) right.curl[k][i] = hold.r.curl[k][i];
    if (ctx.reload >= 0 && m) {
      const r = reloadLeft(ctx.id, hold, ctx.reload);
      left.p.copy(r.hand.p); left.f.copy(r.hand.f); left.n.copy(r.hand.n);
      for (const k of Object.keys(r.hand.curl)) for (let i = 0; i < 3; i++) left.curl[k][i] = r.hand.curl[k][i];
      if (r.magOff && m.mag) m.mag.position.copy(m.rest).addScaledVector(r.magOff, 1 / m.scale);
    } else {
      left.p.copy(hold.l.p); left.f.copy(hold.l.f); left.n.copy(hold.l.n);
      for (const k of Object.keys(hold.l.curl)) for (let i = 0; i < 3; i++) left.curl[k][i] = hold.l.curl[k][i];
    }
    rig.update(pose, ctx.vmMatrix);
  }

  return { update, root: rig.root };
}
