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
 * the item's progress `p`, so nothing "plays": it is placed, and so can never fall out of step
 * with the channel the server is counting.
 *
 * Phases: RAISE (hands and item come up from below while the gun sinks), the item's own action
 * sequence over p = 0..1, then either FINISH (the channel completed: a small pop, then lower
 * out) or CANCEL (anything else ended it: ease out from wherever the pose was). The lower-out is
 * the same ease in both cases, so there is never a snap.
 *
 * The gloved hands and the props are Blender models (itemModels.js) with named parts: lid,
 * latch, cork, liquid, gauze, ... Each item has one function below that places the item node,
 * both hands and those parts for a given p. The forearm is a sleeve stretched from the wrist to an
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
const SLEEVE_K = 0.72;      // the forearm's thickness against the art's, so an arm reads as an arm and not a pipe
const SLEEVE_R = 0.055 * SLEEVE_K;
const elbow = { r: ELBOW.r.clone(), l: ELBOW.l.clone() };   // where each forearm goes off screen; an item may move them
/** First-person size of each prop relative to its pickup size. */
const FP_SCALE = { [ITEM.BANDAGE]: 0.34, [ITEM.MEDKIT]: 0.62, [ITEM.MINI]: 0.62, [ITEM.BIG]: 0.5 };
/** The whole composition rides this in and out: below and to the right. */
const OFFSCREEN = new THREE.Vector3(0.1, -0.36, 0.04);

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _Z = new THREE.Vector3(0, 0, 1);

/** A rotation matrix from euler angles (radians). */
const rotM = (x, y, z, out) => out.makeRotationFromEuler(_e1.set(x, y, z));

function eachMesh(node, fn) {
  node?.traverse((o) => { if (o.isMesh) fn(o); });
}

/**
 * Scale a part's emissive from its authored rest level. The art's liquids are authored bright for
 * the world; ACES turns a bright saturated blue into near white at close range, so the held copy
 * rests at `rest` of the authored level and `k` climbs from 1.
 */
function setGlow(node, k, rest = 1) {
  eachMesh(node, (m) => {
    const mat = m.material;
    if (mat.emissiveIntensity === undefined) return;
    if (m.userData.glow0 === undefined) {
      m.userData.glow0 = mat.emissiveIntensity * rest;
      if (rest < 1) mat.envMapIntensity = Math.min(mat.envMapIntensity ?? 1, 0.4);
    }
    mat.emissiveIntensity = m.userData.glow0 * k;
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

  // The bandage's unwinding gauze: a ribbon laid down as a helix round the left forearm, with a
  // free span back to the roll. Rebuilt in place every frame.
  const RIB_N = 140;
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
    kind: 0, phase: 'idle', enter: 0, prog: 0, last: 0, startItems: 0, fin: 0, t: 0, pop: 0,
    amount: 0,           // eased 0..1: how far the heal composition is up (the gun sinks by this)
  };

  const handM = new THREE.Matrix4();
  const lift = new THREE.Vector3();         // the entry/exit offset

  /** Put a hand at a matrix, curl it, and stretch its sleeve to the elbow. */
  function placeHand(side, M, curl = 0.2, thumb = 0.1) {
    const h = hands[side];
    M.decompose(h.hand.position, h.hand.quaternion, _v4);
    h.hand.scale.set(1, 1, 1);
    if (h.fingers) h.fingers.rotation.x = curl;
    if (h.thumb) h.thumb.rotation.x = thumb;
    // the sleeve starts just behind the cuff and runs to the elbow
    _v1.set(0, 0, 0.026).applyMatrix4(M);
    _v2.copy(elbow[side]).sub(_v1);
    const len = _v2.length();
    h.sleeve.position.copy(_v1);
    h.sleeve.quaternion.setFromUnitVectors(_Z, _v2.multiplyScalar(1 / len));
    h.sleeve.scale.set(SLEEVE_K, SLEEVE_K, len);
    h.hand.visible = h.sleeve.visible = true;
  }

  /** The item node's frame (no scale) combined with a local offset matrix: for hands the item carries. */
  function carried(local, out) {
    _m1.compose(item.position, item.quaternion, _one);
    return out.multiplyMatrices(_m1, local);
  }

  /* ====================================================================== BANDAGE */

  const wr = new THREE.Vector3();           // the left wrist
  const ax = new THREE.Vector3(), au = new THREE.Vector3(), av = new THREE.Vector3(), rad = new THREE.Vector3();
  const ribP = new THREE.Vector3(), head = new THREE.Vector3(), tail = new THREE.Vector3();

  function bandage(p) {
    const prop = props[ITEM.BANDAGE];
    const gauze = part(prop, 'gauze');
    const gt = part(prop, 'gauze_tail');
    if (gt) gt.visible = false;

    // The left forearm is held up and still. Its axis runs from the wrist back to the elbow.
    wr.set(0.0, 0.0, -0.44).add(lift);
    elbow.l.set(-0.58, -0.5, -0.02);
    ax.copy(elbow.l).sub(wr);
    const armLen = ax.length();
    ax.normalize();
    au.crossVectors(ax, _Z).normalize();
    av.crossVectors(ax, au).normalize();
    // the hand continues the forearm (its +Z along the arm), palm turned toward the player
    _v2.set(0.5, 0.35, 0.8);
    _v2.addScaledVector(ax, -_v2.dot(ax)).normalize();
    _v3.crossVectors(_v2, ax);
    _m1.makeBasis(_v3, _v2, ax).setPosition(wr);
    placeHand('l', _m1, 0.3, 0.1);

    const wrapA = sm(0.06, 0.92, p);                     // how much of the wrap is laid down
    const away = sm(0.92, 1.0, p);                       // the roll draws off the arm at the end
    const d0 = 0.05, d1 = 0.25, turns = 4;
    const armR = SLEEVE_R + 0.004;
    const rollK = lerp(1, 0.55, wrapA);
    const rollR = 0.132 * FP_SCALE[ITEM.BANDAGE] * rollK;

    // The roll rides round the forearm at the head of the wrap, its axle along the arm.
    const d = lerp(d0, d1, wrapA);
    const th = 0.5 + turns * Math.PI * 2 * wrapA;
    rad.copy(au).multiplyScalar(Math.cos(th)).addScaledVector(av, Math.sin(th));
    const dist = armR + rollR + 0.004 + away * 0.06;
    item.position.copy(wr).addScaledVector(ax, 0.026 + d).addScaledVector(rad, dist);
    item.position.y += away * 0.03;
    _v2.crossVectors(ax, rad);
    _m1.makeBasis(ax, rad, _v2);
    item.quaternion.setFromRotationMatrix(_m1);
    item.updateMatrixWorld(true);
    if (gauze) {
      gauze.scale.set(1, rollK, rollK);
      gauze.rotation.x = -wrapA * 24;
    }

    // right hand: over the roll, palm down onto its outer face, fingers wrapped past the middle
    rotM(0, 0, Math.PI, _m2);
    _m2.setPosition(0, rollR + 0.012, 0.045);
    carried(_m2, handM);
    placeHand('r', handM, 0.55, 0.3);

    // the ribbon: a helix laid on the arm, then a free span to where the gauze leaves the roll
    const pos = ribbonGeo.attributes.position.array;
    const half = 0.024;
    let n = 0;
    const put = (c) => {
      pos[n++] = c.x - ax.x * half; pos[n++] = c.y - ax.y * half; pos[n++] = c.z - ax.z * half;
      pos[n++] = c.x + ax.x * half; pos[n++] = c.y + ax.y * half; pos[n++] = c.z + ax.z * half;
    };
    const steps = Math.max(2, Math.round(90 * wrapA));
    for (let i = 0; i <= steps; i++) {
      const f = (i / steps) * wrapA;
      const ang = 0.5 + turns * Math.PI * 2 * f;
      _v3.copy(au).multiplyScalar(Math.cos(ang)).addScaledVector(av, Math.sin(ang));
      ribP.copy(wr).addScaledVector(ax, 0.026 + lerp(d0, d1, f)).addScaledVector(_v3, armR);
      put(ribP);
    }
    head.copy(ribP);
    const free = Math.round(18 * (1 - away));
    if (free > 0 && wrapA > 0.01) {
      // the gauze leaves the underside of the roll
      tail.set(0, -rollR, 0).applyQuaternion(item.quaternion).add(item.position);
      for (let i = 1; i <= free; i++) {
        const t = i / 18;
        ribP.lerpVectors(head, tail, t);
        ribP.addScaledVector(rad, Math.sin(t * Math.PI) * 0.01);
        put(ribP);
      }
    }
    const rows = n / 6;
    ribbonGeo.attributes.position.needsUpdate = true;
    ribbonGeo.setDrawRange(0, Math.max(0, (rows - 1) * 6));
    ribbon.visible = rows > 2;
    return wrapA + armLen * 0;
  }

  /* ====================================================================== MEDKIT */

  const _lidAnchor = new THREE.Vector3(-0.045, 0.19, 0.06);   // on the handle, in the lid's own units
  const reachP = new THREE.Vector3(), gripP = new THREE.Vector3(), gripQ = new THREE.Quaternion(), reachQ = new THREE.Quaternion();
  const LIFTS = [['item_a', 0.3], ['item_b', 0.44], ['item_c', 0.58]];

  function medkit(p, T) {
    const prop = props[ITEM.MEDKIT];
    const lid = part(prop, 'lid'), latch = part(prop, 'latch');
    const open = pulse(0.1, 0.27, 0.86, 0.95, p);
    const tilt = lerp(0.1, 0.95, sm(0.04, 0.2, p)) - 0.8 * sm(0.88, 0.97, p);
    item.position.set(lerp(0.02, 0.0, open), lerp(-0.12, -0.1, open), lerp(-0.4, -0.37, open)).add(lift);
    item.rotation.set(tilt, lerp(-0.12, 0, open), 0);
    item.updateMatrixWorld(true);
    // a little overshoot as the lid arrives, and a bounce as it shuts
    const swing = 1.95 * open + 0.1 * Math.sin(sm(0.1, 0.27, p) * Math.PI) * open;
    if (lid) lid.rotation.x = -(p < 0.86 ? swing : swing * (1 - sm(0.9, 0.95, p)));
    if (latch) latch.rotation.x = 1.1 * (sm(0.05, 0.1, p) - sm(0.95, 0.98, p));

    // what lifts out, one at a time
    let up = -1;
    LIFTS.forEach(([name, t0], i) => {
      const n = part(prop, name);
      const k = pulse(t0, t0 + 0.1, t0 + 0.2, t0 + 0.28, p);
      if (k > 0.02) up = i;
      if (n) {
        n.position.y = (n.userData.y0 ??= n.position.y) + 0.2 * k;
        n.position.z = (n.userData.z0 ??= n.position.z) + 0.1 * k;
        n.rotation.z = 0.5 * k * Math.sin(T * 3 + t0);
      }
    });
    const act = pulse(0.2, 0.3, 0.85, 0.95, p);
    setGlow(part(prop, 'cross'), 1 + act * (0.8 + 1.0 * Math.sin(p * Math.PI * 9) ** 2) + st.pop * 1.5);

    // right hand under the case
    rotM(0, 0, 0, _m2);
    _m2.setPosition(0.075, -0.1, 0.05);
    carried(_m2, handM);
    placeHand('r', handM, 0.15, 0.1);

    // left: on the handle (it rides the lid), then reaching in over the tray, then back to shut the lid
    const reach = pulse(0.27, 0.34, 0.8, 0.86, p);
    (lid ?? prop).updateWorldMatrix(true, false);
    _v1.copy(_lidAnchor).applyMatrix4((lid ?? prop).matrixWorld);
    gripP.copy(_v1);
    rotM(item.rotation.x + (lid ? lid.rotation.x : 0) + 0.2, 0, Math.PI, _m2);
    gripQ.setFromRotationMatrix(_m2);
    if (up >= 0) part(prop, LIFTS[up][0]).getWorldPosition(reachP);
    else prop.localToWorld(reachP.set(0, 0, 0));
    reachP.y += 0.07; reachP.z += 0.07;
    reachQ.setFromRotationMatrix(rotM(item.rotation.x - 0.35, 0, Math.PI, _m3));
    gripP.lerp(reachP, reach);
    gripQ.slerp(reachQ, reach);
    handM.compose(gripP, gripQ, _one);
    placeHand('l', handM, 0.3 + 0.25 * reach * (0.5 + 0.5 * Math.sin(T * 7)), 0.15);
    return act;
  }

  /* ====================================================================== FLASKS */

  /**
   * Mini shield (a vial) and shield potion (a flask) share a shape: raise, uncork, tilt to the
   * mouth while the liquid level drops and the glow builds, lower the empty bottle.
   * `big` = the flask: its left hand cradles the base and the cork pops off.
   */
  const _rest = new THREE.Vector3(), _mouth = new THREE.Vector3();
  function flask(kind, p, T) {
    const big = kind === ITEM.BIG;
    const prop = props[kind];
    const liquid = part(prop, 'liquid'), swirl = part(prop, 'swirl');
    const cork = part(prop, big ? 'cork' : 'cap');
    const uncork = big ? [0.08, 0.2] : [0.1, 0.24];
    const drink = pulse(0.3, 0.48, big ? 0.74 : 0.7, big ? 0.9 : 0.86, p);
    const level = 1 - (big ? 0.9 : 0.86) * sm(0.46, big ? 0.76 : 0.7, p);
    const glow = Math.max(sm(0.3, 0.95, p), st.pop);

    _rest.set(big ? 0.07 : 0.075, big ? -0.11 : -0.1, big ? -0.4 : -0.36);
    _mouth.set(big ? 0.03 : 0.04, big ? -0.04 : -0.045, big ? -0.3 : -0.27);
    item.position.lerpVectors(_rest, _mouth, drink);
    item.position.y += 0.012 * Math.sin(T * 2.2) * (1 - drink);
    item.position.add(lift);
    item.rotation.set(lerp(-0.1, big ? 1.25 : 1.3, drink), lerp(0.25, -0.35, drink), lerp(-0.08, 0.15, drink));
    item.updateMatrixWorld(true);

    if (liquid) liquid.scale.y = Math.max(0.04, level);
    if (swirl) {
      swirl.scale.y = Math.max(0.04, level);
      swirl.rotation.y = T * (1.5 + 3 * glow);
      swirl.visible = level > 0.1;
    }
    setGlow(liquid, 1 + 2.2 * glow + 0.4 * Math.sin(T * 9) * glow, 0.5);
    setGlow(swirl, 1 + 1.5 * glow, 0.6);
    setGlow(part(prop, 'neck'), 1 + 1.4 * glow, 0.6);
    setGlow(part(prop, 'emblem'), 1 + 1.4 * glow);
    // the cork pops off (a short arc, shrinking out of view); the vial's cap unscrews
    if (cork) {
      const k = sm(uncork[0], uncork[1], p);
      cork.userData.p0 ??= cork.position.clone();
      const o = cork.userData.p0;
      cork.position.set(o.x + 0.07 * k, o.y + (big ? 0.2 : 0.14) * Math.sin(Math.min(1, k) * Math.PI * 0.5) - 0.1 * k * k, o.z + 0.12 * k);
      cork.rotation.set(5 * k, big ? 3 * k : 18 * k, 2 * k);
      cork.scale.setScalar(1 - sm(uncork[1] - 0.04, uncork[1] + 0.06, p));
    }

    // right hand wraps the bottle's side (palm turned in); the left cradles the base (potion only)
    rotM(0, 0, Math.PI / 2, _m2);
    _m2.setPosition((big ? 0.0675 : 0.034) + 0.017, big ? -0.02 : -0.035, 0.05);
    carried(_m2, handM);
    placeHand('r', handM, big ? 0.15 : 0.35, 0.1);

    if (big) {
      rotM(0, 0, 0, _m2);
      _m2.setPosition(-0.025, -0.1, 0.04);
      carried(_m2, handM);
      handM.decompose(_v3, _q1, _v4);
      // before it takes the weight the off hand rests low in the corner
      const lw = sm(0.0, 0.14, p) * (1 - sm(0.9, 1.0, p));
      _v3.lerp(_v2.set(-0.22, -0.3, -0.3).add(lift), 1 - lw);
      handM.compose(_v3, _q1, _one);
      placeHand('l', handM, 0.25, 0.2);
    } else {
      // a relaxed off hand in the lower left corner
      rotM(-0.15, 0.25, 0.1, handM);
      handM.setPosition(-0.22 + lift.x, -0.27 + 0.01 * Math.sin(T * 1.7) + lift.y, -0.34);
      placeHand('l', handM, 0.5, 0.15);
    }
    return glow;
  }

  /* ====================================================================== driver */

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
        st.kind = useKind;
        st.phase = 'use';
        st.startItems = view.items?.[useKind] ?? 0;
        st.fin = 0;
        st.prog = 0;
        st.last = 0;
        st.t = 0;
      }
      // a local estimate that runs smooth between the server's updates, never far ahead of it
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
    elbow.r.copy(ELBOW.r);
    elbow.l.copy(ELBOW.l);
    lift.copy(OFFSCREEN).multiplyScalar(1 - e);
    const T = performance.now() * 0.001;

    // the completion pop: a swell of the item and a flash of its glow, then it lowers
    st.pop = st.phase === 'finish' ? Math.sin(clamp(st.fin / POP_T, 0, 1) * Math.PI) : 0;
    const kind = st.kind;
    if (kind === ITEM.BANDAGE) bandage(st.prog);
    else if (kind === ITEM.MEDKIT) medkit(st.prog, T);
    else flask(kind, st.prog, T);
    item.scale.setScalar(1 + 0.1 * st.pop);
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
    st.phase = 'idle'; st.enter = 0; st.amount = 0; st.kind = 0; st.prog = 0; st.last = 0; st.pop = 0;
    root.visible = false;
  }

  return { root, props, update, reset, showAll, state: st, hands };
}
