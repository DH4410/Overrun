import * as THREE from 'three';

import { buildHands, buildItemMesh, part } from './itemModels.js';
import { ITEM, ITEMS } from './sim/items.js';

/**
 * The first-person heal animation.
 *
 * `update(dt, view)` is driven by what the game already knows: `useKind` (which item, 0 = none),
 * `useP` (the channel's progress 0..1 - the server's word online, the local count in single
 * player) and the bag, so single player and multiplayer run exactly the same code. Everything is
 * time based (the eased state moves by dt, never by frame), and every pose is a pure function of
 * the item's progress `p`, so a hand never "plays" anything: it is placed.
 *
 * Phases: RAISE (hands and item come up from below while the gun sinks), the item's own action
 * sequence over p = 0..1, then either FINISH (the channel completed: a small pop, then lower
 * out) or CANCEL (anything else ended it: ease out from wherever the pose was). The lower-out is
 * the same ease in both cases, so there is never a snap.
 *
 * The gloved hands and the props are Blender models (itemModels.js) with named parts: lid,
 * latch, cork, liquid, gauze, ... Each item has one function below that places the item node,
 * both hands and those parts for a given p. A hand is either carried by the item (its pose is
 * item-local) or free (camera space); the forearm is a sleeve stretched from the wrist to an
 * elbow kept off screen, so the arms always connect.
 */

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const pulse = (a, b, c, d, x) => sm(a, b, x) - sm(c, d, x);       // 0 -> 1 between a..b, 1 until c, back to 0 by d

const ENTER_T = 0.3;        // seconds to raise
const EXIT_FINISH = 0.42;   // lower-out after a completed use
const EXIT_CANCEL = 0.26;   // lower-out after a cancel
const POP_T = 0.28;         // the completion pop, before lowering starts
const ELBOW = { r: new THREE.Vector3(0.36, -0.62, -0.08), l: new THREE.Vector3(-0.36, -0.62, -0.08) };
/** First-person size of each prop relative to its pickup size. */
const FP_SCALE = { [ITEM.BANDAGE]: 0.55, [ITEM.MEDKIT]: 0.62, [ITEM.MINI]: 0.62, [ITEM.BIG]: 0.5 };
/** Where the whole composition starts from (and returns to): below and to the right, tilted away. */
const OFFSCREEN = new THREE.Vector3(0.1, -0.36, 0.04);

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _Z = new THREE.Vector3(0, 0, 1);

/** The unscaled world frame of a node's point: translate by `local` (in the node's own units), keep rotation. */
function frameOf(node, local, out) {
  node.updateWorldMatrix(true, false);
  _v1.copy(local).applyMatrix4(node.matrixWorld);
  node.matrixWorld.decompose(_v2, _q1, _v3);
  return out.compose(_v1, _q1, _one);
}

/** A rotation matrix from euler angles (radians). */
const rotM = (x, y, z, out) => out.makeRotationFromEuler(_e1.set(x, y, z));

function eachMesh(node, fn) {
  node?.traverse((o) => { if (o.isMesh) fn(o); });
}

function setGlow(node, k) {
  eachMesh(node, (m) => {
    if (m.material.emissiveIntensity !== undefined) {
      m.userData.glow0 ??= m.material.emissiveIntensity;
      m.material.emissiveIntensity = m.userData.glow0 * k;
    }
  });
}

export function createHealAnim({ vmScene }) {
  const root = new THREE.Group();
  root.visible = false;
  vmScene.add(root);

  const hands = buildHands();
  root.add(hands.root);

  const item = new THREE.Group();           // the animated node: the held prop's transform
  root.add(item);
  const props = {};
  for (const kind of [ITEM.BANDAGE, ITEM.MEDKIT, ITEM.MINI, ITEM.BIG]) {
    const p = buildItemMesh(kind, { fp: true });
    p.scale.setScalar(FP_SCALE[kind]);
    p.visible = false;
    item.add(p);
    props[kind] = p;
  }

  const light = new THREE.PointLight(0xffffff, 0, 1.4, 2);
  root.add(light);

  // The bandage's unwinding gauze: a ribbon laid down as a helix round the left forearm, with a
  // free span back to the roll. Rebuilt in place every frame.
  const RIB_N = 120;
  const ribbonGeo = new THREE.BufferGeometry();
  ribbonGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RIB_N + 1) * 2 * 3), 3));
  const idx = [];
  for (let i = 0; i < RIB_N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  ribbonGeo.setIndex(idx);
  const ribbon = new THREE.Mesh(ribbonGeo, new THREE.MeshStandardMaterial({
    color: 0xf3eee3, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
  }));
  ribbon.frustumCulled = false;
  ribbon.visible = false;
  root.add(ribbon);

  // ----------------------------------------------------------- state
  const st = {
    kind: 0, phase: 'idle', enter: 0, prog: 0, last: 0, startItems: 0, fin: 0, t: 0,
    amount: 0,           // eased 0..1: how far the heal composition is up (the gun sinks by this)
  };

  const handM = new THREE.Matrix4();

  /** Put a hand at a world matrix, curl it, and stretch its sleeve to the elbow. */
  function placeHand(side, M, curl = 0.2, thumb = 0.1) {
    const h = hands[side];
    M.decompose(h.hand.position, h.hand.quaternion, _v4);
    h.hand.scale.set(1, 1, 1);
    if (h.fingers) h.fingers.rotation.x = curl;
    if (h.thumb) h.thumb.rotation.x = thumb;
    h.hand.updateMatrix();
    // the sleeve starts just behind the cuff and runs to the elbow
    _v1.set(0, 0, 0.026).applyMatrix4(M);
    _v2.copy(ELBOW[side]).sub(_v1);
    const len = _v2.length();
    h.sleeve.position.copy(_v1);
    h.sleeve.quaternion.setFromUnitVectors(_Z, _v2.multiplyScalar(1 / len));
    h.sleeve.scale.set(1, 1, len);
    h.hand.visible = h.sleeve.visible = true;
  }

  /** A free hand at a camera-space position, palm up and fingers forward unless rotated. */
  function freeHand(side, x, y, z, rx = 0, ry = 0, rz = 0) {
    rotM(rx, ry, rz, _m3);
    _m3.setPosition(x, y, z);
    return _m3;
  }

  function hideHands() {
    for (const s of ['r', 'l']) hands[s].hand.visible = hands[s].sleeve.visible = false;
  }

  /** The entry/exit offset: the whole composition rides this in and out. */
  const lift = new THREE.Vector3();

  /* ====================================================================== BANDAGE */

  const arm = {
    wrist: new THREE.Vector3(-0.07, -0.15, -0.42), a: new THREE.Vector3(), u: new THREE.Vector3(), v: new THREE.Vector3(),
    len: 0.5,
  };
  const ribP = new THREE.Vector3();

  function bandage(p, e, T) {
    const prop = props[ITEM.BANDAGE];
    const gauze = part(prop, 'gauze');
    part(prop, 'gauze_tail') && (part(prop, 'gauze_tail').visible = false);

    // The left forearm is held up and still; its axis is the wrist back to the elbow anchor.
    const wr = _v1.copy(arm.wrist).add(lift);
    arm.a.copy(ELBOW.l).sub(wr);
    arm.len = arm.a.length();
    arm.a.normalize();
    arm.u.crossVectors(arm.a, _Z).normalize();
    arm.v.crossVectors(arm.a, arm.u).normalize();
    // the left hand continues the forearm: +Z along the arm, palm turned in
    _v2.set(0.55, 0.75, 0.35);
    _v2.addScaledVector(arm.a, -_v2.dot(arm.a)).normalize();
    _v3.crossVectors(_v2, arm.a);
    _m1.makeBasis(_v3, _v2, arm.a).setPosition(wr);
    placeHand('l', _m1, 0.25, 0.05);

    const wrapA = sm(0.05, 0.9, p);                      // how much of the wrap is laid down
    const d0 = 0.05, d1 = 0.27, turns = 5.5;
    const armR = (d) => 0.036 + 0.019 * ((0.026 + d) / arm.len) + 0.004;
    const rollK = lerp(1, 0.5, wrapA);
    const rollR = 0.1 * 0.55 * 1.3 * rollK;
    const away = sm(0.9, 1.0, p);                        // the roll draws off the arm at the end

    // The roll orbits the forearm at the wrap head, axle along the arm, right hand on top of it.
    const d = lerp(d0, d1, wrapA);
    const th = 0.6 + turns * Math.PI * 2 * wrapA;
    const dist = armR(d) + rollR + 0.012 + away * 0.07;
    _v3.copy(arm.u).multiplyScalar(Math.cos(th)).addScaledVector(arm.v, Math.sin(th));          // radial
    _v4.copy(wr).addScaledVector(arm.a, 0.026 + d).addScaledVector(_v3, dist);
    _v4.y += away * 0.03;
    item.position.copy(_v4);
    // basis: X = axle (the arm), Y = radial, Z = X x Y
    _v2.crossVectors(arm.a, _v3);
    _m1.makeBasis(arm.a, _v3, _v2);
    item.quaternion.setFromRotationMatrix(_m1);
    item.updateMatrixWorld(true);
    if (gauze) {
      gauze.scale.set(1, rollK, rollK);
      gauze.rotation.x = -wrapA * 30;
    }

    // right hand: on the roll's outer face, palm down, fingers over the far side
    _m2.copy(item.matrixWorld);
    _m2.decompose(_v1, _q1, _v2);
    _m1.compose(_v1, _q1, _one);
    rotM(0, 0, Math.PI, _m2);
    _m2.setPosition(0, rollR + 0.016, 0.052);
    handM.multiplyMatrices(_m1, _m2);
    placeHand('r', handM, 0.35 + 0.1 * Math.sin(T * 6), 0.2);

    // the ribbon: the helix laid on the arm, then a free span to where the gauze leaves the roll
    const pos = ribbonGeo.attributes.position.array;
    const half = 0.026;
    let n = 0;
    const put = (c, w) => {
      pos[n++] = c.x - w.x * half; pos[n++] = c.y - w.y * half; pos[n++] = c.z - w.z * half;
      pos[n++] = c.x + w.x * half; pos[n++] = c.y + w.y * half; pos[n++] = c.z + w.z * half;
    };
    const steps = Math.max(2, Math.round(80 * wrapA));
    for (let i = 0; i <= steps; i++) {
      const f = (i / steps) * wrapA;
      const dd = lerp(d0, d1, f);
      const ang = 0.6 + turns * Math.PI * 2 * f;
      _v3.copy(arm.u).multiplyScalar(Math.cos(ang)).addScaledVector(arm.v, Math.sin(ang));
      ribP.copy(wr).addScaledVector(arm.a, 0.026 + dd).addScaledVector(_v3, armR(dd));
      put(ribP, arm.a);
    }
    // free span: head -> the roll's underside, sagging a little
    const free = Math.round(24 * (1 - away));
    if (free > 0 && wrapA > 0.001) {
      _v1.copy(ribP);
      _v2.set(0, -rollR * 0.9, 0).applyQuaternion(item.quaternion).add(item.position);
      for (let i = 1; i <= free; i++) {
        const t = (i / 24);
        ribP.lerpVectors(_v1, _v2, t);
        ribP.y -= Math.sin(t * Math.PI) * 0.025;
        put(ribP, arm.a);
      }
      n -= 0;
    }
    const total = n / 6;
    ribbonGeo.attributes.position.needsUpdate = true;
    ribbonGeo.setDrawRange(0, Math.max(0, (total - 1) * 6));
    ribbon.visible = total > 1;
    return wrapA;
  }

  /* ====================================================================== MEDKIT */

  const _lidAnchor = new THREE.Vector3(-0.045, 0.19, 0.06);   // on the handle, in the lid's own units

  function medkit(p, e, T) {
    const prop = props[ITEM.MEDKIT];
    const lid = part(prop, 'lid'), latch = part(prop, 'latch');
    const open = pulse(0.1, 0.27, 0.86, 0.95, p);
    const tilt = lerp(0.1, 0.95, sm(0.04, 0.2, p)) - 0.8 * sm(0.88, 0.97, p);
    item.position.set(lerp(0.02, 0.0, open), lerp(-0.12, -0.1, open), lerp(-0.4, -0.37, open));
    item.rotation.set(tilt, lerp(-0.12, 0, open), 0);
    item.position.add(lift);
    item.updateMatrixWorld(true);
    // a little overshoot as the lid arrives, and a bounce as it shuts
    const swing = 1.95 * open + 0.1 * Math.sin(sm(0.1, 0.27, p) * Math.PI) * open;
    const shut = (1 - sm(0.9, 0.95, p));
    if (lid) lid.rotation.x = -(swing * (p < 0.86 ? 1 : lerp(0, 1, shut)));
    if (latch) latch.rotation.x = 1.1 * (sm(0.05, 0.1, p) - sm(0.95, 0.98, p));

    // what lifts out, one at a time
    const lifts = [['item_a', 0.3], ['item_b', 0.44], ['item_c', 0.58]];
    const liftY = [];
    for (const [name, t0] of lifts) {
      const n = part(prop, name);
      const k = pulse(t0, t0 + 0.1, t0 + 0.2, t0 + 0.28, p);
      liftY.push(k);
      if (n) {
        n.position.y = (n.userData.y0 ??= n.position.y) + 0.2 * k;
        n.position.z = (n.userData.z0 ??= n.position.z) + 0.1 * k;
        n.rotation.z = 0.5 * k * Math.sin(T * 3 + t0);
      }
    }
    const cross = part(prop, 'cross');
    const act = pulse(0.2, 0.3, 0.85, 0.95, p);
    setGlow(cross, 1 + act * (1.2 + 1.4 * Math.sin(p * Math.PI * 9) ** 2));

    // right hand under the case; the left on the handle, then reaching in, then back to shut the lid
    rotM(0, 0, 0, _m2);
    _m2.setPosition(0.075, -0.1, 0.05);
    _m1.compose(item.position, item.quaternion, _one);
    handM.multiplyMatrices(_m1, _m2);
    placeHand('r', handM, 0.15, 0.1);

    // left: handle anchor (moves with the lid) <-> reach pose over the tray
    const reach = pulse(0.27, 0.34, 0.8, 0.86, p);
    frameOf(lid ?? prop, _lidAnchor, _m1);
    rotM(0, 0, Math.PI, _m2);
    handM.multiplyMatrices(_m1, _m2);
    handM.decompose(_v1, _q1, _v2);                        // grip pose on the handle
    // the reach pose: over the tray, following whichever item is up
    let target = null;
    for (let i = 0; i < 3; i++) if (liftY[i] > 0.02) target = part(prop, lifts[i][0]);
    if (target) target.getWorldPosition(_v3); else prop.localToWorld(_v3.set(0, 0.0, 0.0));
    _v3.y += 0.07;
    _v3.z += 0.07;
    _q2.setFromRotationMatrix(rotM(item.rotation.x - 0.35, 0, Math.PI, _m2));
    _v1.lerp(_v3, reach);
    _q1.slerp(_q2, reach);
    handM.compose(_v1, _q1, _one);
    placeHand('l', handM, 0.3 + 0.25 * reach * (0.5 + 0.5 * Math.sin(T * 7)), 0.15);
    light.position.set(item.position.x, item.position.y + 0.12, item.position.z + 0.2);
    return act;
  }

  /* ====================================================================== FLASKS */

  /**
   * Mini shield (a vial) and shield potion (a flask) share a shape: raise, uncork, tilt to the
   * mouth while the liquid level drops and the glow builds, lower the empty bottle.
   * `big` = the flask: its left hand cradles the base and the cork pops off.
   */
  function flask(kind, p, e, T) {
    const big = kind === ITEM.BIG;
    const prop = props[kind];
    const liquid = part(prop, 'liquid'), swirl = part(prop, 'swirl');
    const cork = part(prop, big ? 'cork' : 'cap');
    const uncork = big ? [0.08, 0.2] : [0.1, 0.24];
    const drink = pulse(big ? 0.28 : 0.3, big ? 0.46 : 0.46, big ? 0.72 : 0.7, big ? 0.9 : 0.86, p);
    const level = 1 - (big ? 0.9 : 0.86) * sm(big ? 0.46 : 0.46, big ? 0.74 : 0.7, p);
    const glow = sm(0.3, 0.95, p);

    const rest = big ? _v1.set(0.07, -0.11, -0.4) : _v1.set(0.075, -0.1, -0.36);
    const mouth = big ? _v2.set(0.0, -0.205, -0.21) : _v2.set(0.0, -0.17, -0.2);
    item.position.lerpVectors(rest, mouth, drink);
    item.position.y += 0.012 * Math.sin(T * 2.2) * (1 - drink);
    item.position.add(lift);
    item.rotation.set(lerp(-0.1, big ? 1.95 : 1.8, drink), lerp(0.25, 0.0, drink), lerp(-0.08, 0, drink));
    item.updateMatrixWorld(true);

    if (liquid) liquid.scale.y = Math.max(0.04, level);
    if (swirl) {
      swirl.scale.y = Math.max(0.04, level);
      swirl.rotation.y = T * (1.5 + 3 * glow);
      swirl.visible = level > 0.1;
    }
    setGlow(liquid, 1 + 2.4 * glow + 0.5 * Math.sin(T * 9) * glow);
    setGlow(part(prop, 'neck'), 1 + 1.6 * glow);
    setGlow(part(prop, 'emblem'), 1 + 1.4 * glow);
    // the cork pops off (a short arc, shrinking out of view); the vial's cap unscrews
    if (cork) {
      const k = sm(uncork[0], uncork[1], p);
      cork.userData.p0 ??= cork.position.clone();
      cork.position.set(cork.userData.p0.x + 0.1 * k, cork.userData.p0.y + (big ? 0.45 : 0.3) * Math.sin(Math.min(1, k) * Math.PI * 0.5) - 0.2 * k * k, cork.userData.p0.z + 0.2 * k);
      cork.rotation.set(5 * k, big ? 3 * k : 18 * k, 2 * k);
      cork.scale.setScalar(1 - sm(uncork[1] - 0.04, uncork[1] + 0.06, p));
    }

    // right hand wraps the bottle's side (palm turned in); the left cradles the base (potion only)
    rotM(0, 0, Math.PI / 2, _m2);
    _m2.setPosition((big ? 0.0675 : 0.034) + 0.017, big ? -0.02 : -0.035, 0.05);
    _m1.compose(item.position, item.quaternion, _one);
    handM.multiplyMatrices(_m1, _m2);
    placeHand('r', handM, big ? 0.15 : 0.35, 0.1);

    const lw = big ? sm(0.0, 0.12, p) * (1 - sm(0.9, 1.0, p)) : 0;
    if (big) {
      rotM(0, 0, 0, _m2);
      _m2.setPosition(-0.025, -0.1, 0.04);
      handM.multiplyMatrices(_m1, _m2);
      handM.decompose(_v3, _q1, _v4);
      _v3.lerp(_v4.set(-0.2, -0.36, -0.3).add(lift), 1 - lw);
      handM.compose(_v3, _q1, _one);
      placeHand('l', handM, 0.25, 0.2);
    } else {
      // a relaxed off hand in the lower left corner
      handM.copy(freeHand('l', -0.17, -0.27 + 0.01 * Math.sin(T * 1.7), -0.34, -0.15, 0.25, 0.1));
      handM.elements[13] += lift.y; handM.elements[12] += lift.x - 0.05;
      placeHand('l', handM, 0.5, 0.15);
    }
    light.position.set(item.position.x, item.position.y + 0.06, item.position.z + 0.1);
    return glow;
  }

  /* ====================================================================== driver */

  const GLOW_COLOR = {
    [ITEM.BANDAGE]: 0xffffff, [ITEM.MEDKIT]: 0xff6a70, [ITEM.MINI]: 0x62d0ff, [ITEM.BIG]: 0x4f7bff,
  };

  /**
   * Advance one frame. view = { useKind, useP, items, alive, hidden } (hidden: a scope is up).
   * Returns the eased amount 0..1 the caller sinks the gun by.
   */
  function update(dt, view) {
    const { useKind, alive } = view;
    if (!alive) { st.phase = 'idle'; st.enter = 0; }
    if (useKind && alive) {
      const it = ITEMS[useKind];
      if (st.kind !== useKind || st.phase === 'idle' || st.phase === 'finish' || st.phase === 'cancel') {
        const same = st.kind === useKind && st.enter > 0.02;
        st.kind = useKind;
        st.phase = 'use';
        st.startItems = view.items?.[useKind] ?? 0;
        st.fin = 0;
        // a fresh channel starts at 0; if the last one is still on screen, wind it back with the ease below
        st.prog = same ? Math.min(st.prog, 0.0) : 0;
        st.last = 0;
        st.t = 0;
      }
      // a local estimate that runs smooth between the server's updates, never ahead of it by much
      // and never backwards within one use
      const auth = view.useP ?? 0;
      st.prog = Math.min(1, st.prog + dt / it.time);
      st.prog = Math.min(st.prog, auth + 0.08);
      if (auth > st.prog) st.prog += (auth - st.prog) * (1 - Math.exp(-dt * 8));
      st.prog = Math.max(st.prog, st.last);
      st.last = st.prog;
      st.enter = Math.min(1, st.enter + dt / ENTER_T);
    } else if (st.phase === 'use') {
      // the channel ended this frame: completed (the bag went down, or it was nearly full) or cancelled
      const done = (view.items?.[st.kind] ?? 0) < st.startItems || st.prog >= 0.93;
      st.phase = done ? 'finish' : 'cancel';
      st.fin = 0;
      if (done) st.prog = 1;
    }
    if (st.phase === 'finish') {
      st.fin += dt;
      if (st.fin > POP_T) st.enter = Math.max(0, st.enter - dt / EXIT_FINISH);
    } else if (st.phase === 'cancel') {
      st.enter = Math.max(0, st.enter - dt / EXIT_CANCEL);
    }
    if ((st.phase === 'finish' || st.phase === 'cancel') && st.enter <= 0) st.phase = 'idle';
    if (st.phase === 'idle' && st.enter <= 0) {
      root.visible = false;
      st.amount = 0;
      return 0;
    }

    st.t += dt;
    const e = sm(0, 1, st.enter);
    st.amount = e;
    root.visible = !view.hidden;
    for (const k in props) props[k].visible = Number(k) === st.kind;
    ribbon.visible = false;
    // everything rides in from below and out again on `e`
    lift.copy(OFFSCREEN).multiplyScalar(1 - e);
    const T = performance.now() * 0.001;
    let glow = 0;
    const kind = st.kind;
    if (kind === ITEM.BANDAGE) glow = bandage(st.prog, e, T);
    else if (kind === ITEM.MEDKIT) glow = medkit(st.prog, e, T);
    else glow = flask(kind, st.prog, e, T);

    // the completion pop: the item swells a touch and the glow flashes
    let popK = 0;
    if (st.phase === 'finish') popK = Math.sin(clamp(st.fin / POP_T, 0, 1) * Math.PI);
    item.scale.setScalar(1 + 0.08 * popK);
    const col = GLOW_COLOR[kind];
    light.color.setHex(col);
    light.intensity = (kind === ITEM.BANDAGE ? 0.2 : 1.2) * (0.25 * glow + 1.2 * popK) * e;
    if (kind === ITEM.BANDAGE) light.position.copy(item.position).add(_v1.set(0, 0.1, 0.18));
    // hide the hand pair when the composition is almost out of view
    return e;
  }

  /** For the shader warm-up: everything on (compile walks only visible objects), then off again. */
  function showAll(on) {
    root.visible = on;
    for (const k in props) props[k].visible = on;
    ribbon.visible = on;
    for (const s of ['r', 'l']) hands[s].hand.visible = hands[s].sleeve.visible = on;
  }

  function reset() {
    st.phase = 'idle'; st.enter = 0; st.amount = 0; st.kind = 0; st.prog = 0; st.last = 0;
    root.visible = false;
  }

  return { root, props, update, reset, showAll, state: st, hands, hideHands };
}
