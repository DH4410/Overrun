import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { markShared, matte } from './rendering.js';
import { ITEM, ITEMS } from './sim/items.js';

/**
 * The props: the four healing items, the ammo chest and the first-person gloved hands.
 *
 * The art is modelled in Blender (scripts/blender/build_items.py) and lives in assets/items/*.glb.
 * Every builder here returns a usable procedural model AT ONCE, with the same named parts the art
 * has (lid, cork, liquid, gauze_tail ...), and swaps in the glTF when it arrives. So a slow
 * connection, an offline first load or a 404 costs prettiness and never a pickup, and the
 * animation code in healAnim.js has one path for both.
 *
 * Rules the art follows (and this file enforces):
 *  - no alpha and no transmission on anything that sits on the floor: a `glass` part is hidden
 *    in the world and shown as a translucent shell in first person only;
 *  - first-person copies get their own materials, so animating a glow never lights every
 *    pickup on the map.
 */

const FILES = ['bandage', 'medkit', 'mini', 'big', 'chest', 'hands'];
const KIND_FILE = { [ITEM.BANDAGE]: 'bandage', [ITEM.MEDKIT]: 'medkit', [ITEM.MINI]: 'mini', [ITEM.BIG]: 'big' };

const templates = {};
let loadPromise = null;
/** Groups built before the art arrived: re-filled the moment it does. */
const pending = new Set();

export const itemArt = { ready: false, loaded: [] };

const hex = (c) => new THREE.Color(c);
const lit = (c, k = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.15, emissive: c, emissiveIntensity: k });

/** Start loading the GLBs. Safe to call twice; resolves to whether every file arrived. */
export function loadItemModels(base = 'assets/items/') {
  if (loadPromise) return loadPromise;
  const loader = new GLTFLoader();
  loadPromise = Promise.all(FILES.map(async (name) => {
    try {
      const gltf = await loader.loadAsync(`${base}${name}.glb`);
      gltf.scene.traverse((o) => { if (o.isMesh) markShared(o.geometry); });
      templates[name] = gltf.scene;
      itemArt.loaded.push(name);
      return true;
    } catch {
      return false;   // that one stays procedural
    }
  })).then((r) => {
    itemArt.ready = r.every(Boolean);
    for (const p of pending) p.refill();
    pending.clear();
    return itemArt.ready;
  });
  return loadPromise;
}

/** A named part of a built model, or null (the fallback lacks some of the art's finer parts). */
export const part = (root, name) => root.getObjectByName(name) ?? null;

/* ------------------------------------------------------------------ plumbing */

function ringOf(color, r, y) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.016, 6, 24), new THREE.MeshBasicMaterial({ color }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = y;
  return ring;
}

/** Empty a group. Geometry is left alone: glTF clones share the template's, the procedural bits are tiny. */
function disposeKids(g) {
  for (const c of [...g.children]) g.remove(c);
}

/** A glTF template, cloned for one use. fp = first person (translucent glass, own materials). */
function instantiate(name, fp) {
  const src = templates[name];
  if (!src) return null;
  const root = src.clone(true);
  const drop = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    if (o.material.name?.startsWith('glass')) {
      if (!fp) { drop.push(o); return; }
      o.material = o.material.clone();
      Object.assign(o.material, { transparent: true, opacity: 0.22, depthWrite: false });
      o.renderOrder = 3;
    } else if (fp) {
      o.material = o.material.clone();
    }
  });
  for (const o of drop) o.removeFromParent();
  return root;
}

/**
 * A group that holds a model for `kind`, procedural now and the art later.
 * `fill(group, fp)` puts the model into the group and returns nothing.
 */
function holder(fill, fp) {
  const g = new THREE.Group();
  const refill = () => {
    disposeKids(g);
    g.userData.ring = null;
    fill(g, fp);
  };
  refill();
  if (!itemArt.ready) pending.add({ refill });
  return g;
}

/* ------------------------------------------------------------------ the four items */

function proceduralItem(kind, g) {
  const it = ITEMS[kind];
  if (kind === ITEM.BANDAGE) {
    const gauze = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.14, 20), matte(0xf2eee6, 0.8, 0.05));
    gauze.name = 'gauze';
    gauze.rotation.z = Math.PI / 2;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.136, 0.136, 0.06, 20), matte(0xfbfaf6, 0.6, 0));
    band.rotation.z = Math.PI / 2;
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.01), lit(0xe5484d, 0.6));
    const cross2 = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.05, 0.01), lit(0xe5484d, 0.6));
    cross.position.z = cross2.position.z = 0.138;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.008, 0.16), matte(0xf2eee6, 0.7, 0.05));
    tail.name = 'gauze_tail';
    tail.position.set(0, -0.16, 0.12);
    tail.rotation.x = 0.5;
    g.add(gauze, band, cross, cross2, tail);
  } else if (kind === ITEM.MEDKIT) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.14), matte(0xeeeeee, 0.5, 0.1));
    body.name = 'body';
    body.position.y = -0.07;
    const lid = new THREE.Group();
    lid.name = 'lid';
    lid.position.set(0, 0, -0.06);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.14), matte(0xf4f4f4, 0.5, 0.1));
    top.position.set(0, 0.07, 0.06);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.04), matte(0x4a4f55, 0.5, 0.4));
    handle.position.set(0, 0.155, 0.06);
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.1, 0.152), lit(it.color, 0.9));
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.036, 0.152), lit(it.color, 0.9));
    crossV.position.set(0, 0.07, 0.06);
    crossH.position.set(0, 0.07, 0.06);
    lid.add(top, handle, crossV, crossH);
    g.add(body, lid);
  } else {
    const big = kind === ITEM.BIG;
    const r = big ? 0.135 : 0.045;
    const hgt = big ? 0.0 : 0.19;
    const liquid = new THREE.Group();
    liquid.name = 'liquid';
    const body = new THREE.Mesh(big ? new THREE.SphereGeometry(r, 16, 12) : new THREE.CylinderGeometry(r, r, hgt, 14),
      lit(it.color, 0.8));
    body.position.y = big ? r : hgt / 2;
    liquid.add(body);
    liquid.position.y = big ? -0.235 : -0.15;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(big ? 0.042 : 0.026, big ? 0.07 : 0.045, big ? 0.22 : 0.12, 10),
      lit(hex(it.color).lerp(new THREE.Color(0xffffff), 0.5), 0.35));
    neck.position.y = big ? 0.08 : 0.2;
    const cork = new THREE.Mesh(new THREE.CylinderGeometry(big ? 0.048 : 0.032, big ? 0.04 : 0.036, big ? 0.08 : 0.06, 10),
      matte(big ? 0x9a7a4a : 0xaeb6c0, 0.8, big ? 0.05 : 0.8));
    cork.name = big ? 'cork' : 'cap';
    cork.position.y = neck.position.y + (big ? 0.15 : 0.1);
    g.add(liquid, neck, cork);
  }
}

/**
 * One of the four healing items. Pickup scale (a medkit is 0.4 m wide); first person scales it down.
 * Flasks carry a thin ring in `userData.ring`, which the floor pickups spin.
 */
export function buildItemMesh(kind, { fp = false } = {}) {
  const file = KIND_FILE[kind];
  const fill = (g, isFp) => {
    const art = instantiate(file, isFp);
    if (art) g.add(art); else proceduralItem(kind, g);
    if (!isFp && (kind === ITEM.MINI || kind === ITEM.BIG)) {
      g.userData.ring = ringOf(ITEMS[kind].color, kind === ITEM.BIG ? 0.22 : 0.12, kind === ITEM.BIG ? -0.2 : -0.17);
      g.add(g.userData.ring);
    }
  };
  const g = holder(fill, fp);
  g.userData.kind = kind;
  return g;
}

/* ------------------------------------------------------------------ the ammo chest */

export function buildAmmoChest() {
  const fill = (g) => {
    const art = instantiate('chest', false);
    if (art) { g.add(art); return; }
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.42, 0.44), matte(0x6a5326, 0.65, 0.45));
    body.castShadow = true;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.12, 0.48), matte(0x4a3a1c, 0.6, 0.55));
    lid.position.y = 0.26;
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.035, 0.5), new THREE.MeshBasicMaterial({ color: 0xffcf5a }));
    seam.position.y = 0.17;
    g.add(body, lid, seam);
  };
  return holder(fill, false);
}

/* ------------------------------------------------------------------ first-person hands */

/**
 * A gloved hand in the glTF's frame: wrist at the origin, fingers along -Z, palm up (+Y). The
 * group is `hand_r` / `hand_l`; `fingers_*` and `thumb_*` pivot at the knuckles / thumb root and
 * `sleeve_*` is a unit cone along +Z. Returned as { root, hand, fingers, thumb, sleeve } per side.
 */
function proceduralHand(side) {
  const sfx = side > 0 ? 'r' : 'l';
  const glove = new THREE.MeshStandardMaterial({ color: 0x25282c, roughness: 0.86, metalness: 0.02 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x3a3f35, roughness: 0.93, metalness: 0 });
  const hand = new THREE.Group();
  hand.name = `hand_${sfx}`;
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.084, 0.034, 0.1), glove);
  palm.position.z = -0.052;
  const fingers = new THREE.Group();
  fingers.name = `fingers_${sfx}`;
  fingers.position.set(0, 0, -0.098);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.09), glove);
    f.position.set(side * (0.0315 - i * 0.0205), 0.03, -0.025);
    f.rotation.x = 0.9;
    fingers.add(f);
  }
  const thumb = new THREE.Group();
  thumb.name = `thumb_${sfx}`;
  thumb.position.set(side * 0.043, 0.004, -0.032);
  const tm = new THREE.Mesh(new THREE.BoxGeometry(0.021, 0.021, 0.06), glove);
  tm.position.set(0, 0.012, -0.028);
  tm.rotation.x = 0.5;
  thumb.add(tm);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.034, 12), glove);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = 0.012;
  hand.add(palm, fingers, thumb, cuff);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.036, 1, 12), sleeveMat);
  sleeve.geometry.rotateX(Math.PI / 2);
  sleeve.geometry.translate(0, 0, 0.5);
  sleeve.name = `sleeve_${sfx}`;
  return { hand, sleeve };
}

/**
 * Both hands, ready at once. `hands.r` / `hands.l` are { hand, fingers, thumb, sleeve }; the code
 * poses `hand` (a Group), curls `fingers` / `thumb` with rotation, and stretches `sleeve` from the
 * wrist back to an elbow it keeps off screen.
 */
export function buildHands() {
  const out = new THREE.Group();
  const hands = { root: out, r: null, l: null };
  const fill = () => {
    disposeKids(out);
    const art = instantiate('hands', true);
    for (const [side, sfx] of [[1, 'r'], [-1, 'l']]) {
      let hand, sleeve;
      if (art) {
        hand = part(art, `hand_${sfx}`);
        sleeve = part(art, `sleeve_${sfx}`);
        if (hand && sleeve) { hand.removeFromParent(); sleeve.removeFromParent(); }
        else ({ hand, sleeve } = proceduralHand(side));
      } else ({ hand, sleeve } = proceduralHand(side));
      sleeve.matrixAutoUpdate = true;
      out.add(hand, sleeve);
      hands[sfx] = { hand, fingers: part(hand, `fingers_${sfx}`), thumb: part(hand, `thumb_${sfx}`), sleeve };
    }
    hands.version = (hands.version ?? 0) + 1;
  };
  fill();
  if (!itemArt.ready) pending.add({ refill: fill });
  return hands;
}
