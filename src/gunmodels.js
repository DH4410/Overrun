import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Procedural firearms, shared by the first-person viewmodels and the guns bots carry.
 *
 * These replace the Kenney Blaster Kit, whose bright orange, green and white toy blasters were
 * the single least professional thing on screen. Every part is built from a real silhouette:
 * receivers, stocks, grips and magazines are side profiles extruded to the part's width with a
 * small bevel, which is what makes an edge catch light the way machined metal and moulded
 * polymer do. Dimensions are real-world, in metres.
 *
 * Frame: -Z is forward along the bore, +Y is up, the origin is where the top of the firing hand
 * sits on the grip. Profiles are authored as [s, v] pairs — s forward from the origin, v up —
 * because that is how a gun is drawn on paper.
 *
 * Each model's userData carries the points other code needs:
 *   muzzle  — Object3D at the bore's exit (flash, tracers)
 *   sight   — Vector3 on the sight line where the eye lines up (ADS placement)
 *   adsEye  — how far behind `sight` the eye sits when aiming
 *   grip    — where the firing hand holds it (bot IK)
 *   support — where the other hand holds it (bot IK)
 */

export function gunMaterials() {
  const m = {
    polymer: new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.74, metalness: 0.06 }),
    alloy: new THREE.MeshStandardMaterial({ color: 0x292c30, roughness: 0.46, metalness: 0.72 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x3b3e43, roughness: 0.3, metalness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.62, metalness: 0.35 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x3b2416, roughness: 0.58, metalness: 0.02 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x3c4130, roughness: 0.8, metalness: 0.04 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb08d3a, roughness: 0.35, metalness: 0.9 }),
    white: new THREE.MeshBasicMaterial({ color: 0xe8ecef }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x8fb3c9, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.16, depthWrite: false,
    }),
    // The red-dot reticle. Drawn over everything and never tone-mapped, the way an LED is.
    dot: new THREE.MeshBasicMaterial({ color: 0xff2414, depthTest: false, toneMapped: false }),
    glove: new THREE.MeshStandardMaterial({ color: 0x25282c, roughness: 0.86, metalness: 0.02 }),
    knuckle: new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.7, metalness: 0.05 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x3a3f35, roughness: 0.93, metalness: 0 }),
  };
  // The three roles a finish can repaint, each remembering its stock look (see applyGunSkin).
  for (const role of ['polymer', 'alloy', 'steel']) {
    const mat = m[role];
    mat.userData.skinRole = role;
    mat.userData.stock = [mat.color.getHex(), mat.roughness, mat.metalness];
  }
  return m;
}

/**
 * Repaint a gun (or a whole viewmodel) with a finish from src/rewards.js. `skin.slots` maps a role
 * to [colour, roughness, metalness, glow?]; a null `slots` (the stock finish), or a role it leaves out,
 * goes back to the gun's own colours. Safe to call again and again.
 */
export function applyGunSkin(root, skin) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      const role = mat?.userData?.skinRole;
      if (!role || seen.has(mat)) continue;
      seen.add(mat);
      const [hex, rough, metal, glow = 0] = skin?.slots?.[role] ?? mat.userData.stock;
      mat.color.setHex(hex);
      mat.roughness = rough;
      mat.metalness = metal;
      mat.emissive.setHex(glow);              // a rare skin can light up; every other one is unlit
    }
  });
}

/* ------------------------------ helpers ------------------------------ */

function shapeOf(points) {
  const sh = new THREE.Shape();
  sh.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.length === 4) sh.quadraticCurveTo(p[0], p[1], p[2], p[3]);   // [cs, cv, s, v]
    else sh.lineTo(p[0], p[1]);
  }
  sh.closePath();
  return sh;
}

/** A side profile extruded to `width`, centred on x = `x`, with bevelled edges. */
function slab(points, width, mat, { x = 0, bevel = 0.0025, holes = [] } = {}) {
  const sh = shapeOf(points);
  for (const h of holes) sh.holes.push(shapeOf(h));
  const b = Math.min(bevel, width * 0.3);
  const geo = new THREE.ExtrudeGeometry(sh, {
    depth: Math.max(1e-4, width - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b,
    bevelSegments: 2, curveSegments: 10,
  });
  // Profile x (forward) -> -Z, extrusion -> X.
  geo.rotateY(Math.PI / 2);
  geo.translate(x - width / 2 + b, 0, 0);
  const m = new THREE.Mesh(geo, mat);
  return m;
}

/** A box with rounded edges, `len` along the bore, centred at (x, v, s). */
function box(w, h, len, mat, s, v, x = 0, round = 0.002) {
  const r = Math.min(round, w / 2 - 1e-4, h / 2 - 1e-4, len / 2 - 1e-4);
  const geo = r > 0.0004
    ? new RoundedBoxGeometry(w, h, len, 2, r)
    : new THREE.BoxGeometry(w, h, len);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, v, -s);
  return m;
}

/** A cylinder along the bore from s0 to s1, radius rRear at s0 and rFront at s1. */
function tube(rRear, rFront, s0, s1, mat, v, x = 0, segs = 18, open = false) {
  const len = s1 - s0;
  const geo = new THREE.CylinderGeometry(rRear, rFront, len, segs, 1, open);
  geo.rotateX(Math.PI / 2);                  // +Y (the rRear end) -> +Z, the rear
  let material = mat;
  if (open) {
    material = mat.clone();
    material.side = THREE.DoubleSide;
  }
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, v, -(s0 + len / 2));
  return m;
}

/** A short cylinder standing up (+Y) or out to the side (+X): scope turrets, knobs. */
function post(r, h, mat, x, v, s, sideways = false) {
  const geo = new THREE.CylinderGeometry(r, r, h, 16);
  if (sideways) geo.rotateZ(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, v, -s);
  return m;
}

/** A ring around the bore axis at s. */
function ring(r, thick, s, mat, v, x = 0) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(r, thick, 8, 24), mat);
  m.position.set(x, v, -s);
  return m;
}

/** A disc facing along the bore at s (lenses, bore openings). */
function disc(r, s, mat, v, x = 0) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), mat);
  m.position.set(x, v, -s);
  return m;
}

function finish(g, { muzzle, sight, adsEye, grip, support, sightParts = [] }) {
  const mz = new THREE.Object3D();
  mz.position.copy(muzzle);
  g.add(mz);
  g.userData.muzzle = mz;
  g.userData.sight = sight;
  g.userData.adsEye = adsEye;
  g.userData.grip = grip;
  g.userData.support = support;
  // Parts that are MEANT to sit on the sight line when aiming (the optic's housing and lens,
  // iron sight posts). Everything else must stay clear of the middle of the screen.
  for (const p of sightParts) p.userData.sightPart = true;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

/* ------------------------------ rifle ------------------------------ */

/**
 * A 14.5" carbine in the M4 pattern: flat-top upper with a free-float octagonal handguard,
 * collapsible stock on a buffer tube, curved 30-round magazine and a tube red dot.
 */
function buildRifle(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  // Upper receiver, with the rear taper toward the charging handle.
  add(slab([[-0.058, 0.0], [0.205, 0.0], [0.205, 0.056], [-0.036, 0.056], [-0.058, 0.043]], 0.044, M.alloy));
  // Picatinny rail along the top, and its cross-slots.
  add(box(0.032, 0.011, 0.26, M.alloy, 0.074, 0.0615, 0, 0.0015));
  for (let i = 0; i < 15; i++) add(box(0.034, 0.004, 0.0055, M.dark, -0.05 + i * 0.0178, 0.0675, 0, 0));
  // Ejection port and dust cover (right side), forward assist.
  add(box(0.003, 0.021, 0.068, M.dark, 0.075, 0.03, 0.0225, 0.001));
  add(tube(0.0075, 0.0075, -0.03, 0.0, M.steel, 0.044, 0.025, 12));
  // Charging handle.
  add(box(0.036, 0.008, 0.022, M.polymer, -0.066, 0.05, 0, 0.002));

  // Lower receiver and magwell.
  add(slab([[-0.048, 0.0], [0.172, 0.0], [0.172, -0.018], [0.148, -0.03], [0.146, -0.078],
    [0.072, -0.078], [0.07, -0.034], [-0.03, -0.034], [-0.048, -0.02]], 0.042, M.alloy));
  // Trigger guard (a loop) and trigger.
  add(slab([[0.07, -0.034], [0.006, -0.034], [0.006, -0.058], [0.072, -0.058]], 0.012, M.alloy, {
    holes: [[[0.064, -0.038], [0.012, -0.038], [0.012, -0.053], [0.064, -0.053]]], bevel: 0.001,
  }));
  add(box(0.005, 0.02, 0.006, M.steel, 0.042, -0.043, 0, 0));
  // Pistol grip, raked back, with a slight palm swell.
  add(slab([[0.022, -0.03], [-0.022, -0.03], [-0.064, -0.142], [-0.052, -0.152], [-0.018, -0.15],
    [-0.012, -0.12, 0.0, -0.09], [0.022, -0.03]], 0.031, M.polymer, { bevel: 0.005 }));
  // Magazine: the curved 30-rounder.
  add(slab([[0.074, -0.078], [0.144, -0.078], [0.166, -0.19, 0.186, -0.255], [0.125, -0.262],
    [0.108, -0.19, 0.074, -0.078]], 0.025, M.polymer, { bevel: 0.003 }));
  add(box(0.029, 0.01, 0.068, M.dark, 0.157, -0.261, 0, 0.003));    // baseplate

  // Handguard: an octagon, free-floated, with M-LOK slots down each side.
  const oct = [];
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * Math.PI / 4;
    oct.push([Math.cos(a) * 0.031, Math.sin(a) * 0.033]);
  }
  const hgGeo = new THREE.ExtrudeGeometry(shapeOf(oct), { depth: 0.315, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
  hgGeo.translate(0, 0, -0.315);
  const hg = new THREE.Mesh(hgGeo, M.alloy);
  hg.position.set(0, 0.029, -0.205);
  add(hg);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) add(box(0.004, 0.009, 0.034, M.dark, 0.24 + i * 0.056, 0.029, side * 0.03, 0.002));
  }
  add(box(0.02, 0.009, 0.3, M.alloy, 0.36, 0.064, 0, 0.0015));      // top rail continues

  // Barrel, gas block and a three-prong flash hider.
  add(tube(0.0098, 0.0092, 0.52, 0.665, M.steel, 0.024));
  add(tube(0.0155, 0.0145, 0.665, 0.725, M.dark, 0.024));
  for (let i = 0; i < 3; i++) {
    const slot = box(0.003, 0.012, 0.04, M.polymer, 0.705, 0.024, 0, 0);
    slot.rotation.z = (i * Math.PI * 2) / 3;
    slot.position.x = Math.sin(slot.rotation.z) * 0.014;
    slot.position.y = 0.024 + Math.cos(slot.rotation.z) * 0.014;
    add(slot);
  }
  add(disc(0.0068, 0.7255, M.dark, 0.024));

  // Buffer tube and the collapsible stock, with its cheek riser and butt pad.
  add(tube(0.0165, 0.0165, -0.245, -0.05, M.alloy, 0.033));
  add(slab([[-0.135, 0.058], [-0.268, 0.058], [-0.287, 0.044], [-0.287, -0.062], [-0.266, -0.074],
    [-0.232, -0.03], [-0.17, 0.004], [-0.135, 0.01]], 0.043, M.polymer, { bevel: 0.004 }));
  add(box(0.045, 0.13, 0.014, M.dark, -0.291, -0.006, 0, 0.004));

  // Red dot: riser mount, a 30 mm tube open at both ends, lens, and the LED reticle on axis.
  const AXIS = 0.106;
  add(box(0.028, 0.017, 0.042, M.alloy, 0.105, 0.075, 0, 0.002));
  const housing = add(tube(0.0215, 0.0215, 0.078, 0.137, M.polymer, AXIS, 0, 28, true));
  const rearRing = add(ring(0.0215, 0.0032, 0.078, M.polymer, AXIS));
  const frontRing = add(ring(0.0215, 0.0032, 0.137, M.polymer, AXIS));
  const lens = add(disc(0.0205, 0.132, M.glass, AXIS));
  const turretUp = add(post(0.0085, 0.014, M.polymer, 0, AXIS + 0.026, 0.107));     // elevation
  const turretSide = add(post(0.0085, 0.014, M.polymer, 0.026, AXIS, 0.107, true));  // windage
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.00085, 10, 8), M.dot);
  dot.position.set(0, AXIS, -0.128);
  dot.renderOrder = 20;
  add(dot);
  lens.renderOrder = 10;

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.024, -0.726),
    sight: new THREE.Vector3(0, AXIS, -0.078),
    adsEye: 0.16,
    grip: new THREE.Vector3(0, -0.085, 0.03),
    support: new THREE.Vector3(0, 0.0, -0.36),
    sightParts: [housing, rearRing, frontRing, lens, dot, turretUp, turretSide],
  });
}

/* ------------------------------- SMG ------------------------------- */

/**
 * A compact 9 mm SMG: one boxy receiver, a straight 30-round stick ahead of the trigger, a
 * short shroud into a suppressor, a skeleton stock, and a small open reflex sight.
 */
function buildSmg(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  // Receiver, top rail and its cross-slots, and the side charging handle.
  add(box(0.046, 0.06, 0.3, M.alloy, 0.06, 0.024, 0, 0.004));
  add(box(0.03, 0.01, 0.2, M.alloy, 0.07, 0.059, 0, 0.0015));
  for (let i = 0; i < 10; i++) add(box(0.032, 0.004, 0.0055, M.dark, -0.02 + i * 0.02, 0.0645, 0, 0));
  add(box(0.012, 0.01, 0.03, M.polymer, 0.15, 0.036, -0.028, 0.002));
  add(box(0.003, 0.02, 0.06, M.dark, 0.05, 0.03, 0.0235, 0.001));      // ejection port

  // Lower frame, trigger guard and trigger, and the rifle's raked grip.
  add(slab([[-0.04, 0.0], [0.13, 0.0], [0.13, -0.032], [-0.04, -0.032]], 0.04, M.polymer, { bevel: 0.003 }));
  add(slab([[0.07, -0.032], [0.006, -0.032], [0.006, -0.056], [0.072, -0.056]], 0.012, M.polymer, {
    holes: [[[0.064, -0.036], [0.012, -0.036], [0.012, -0.051], [0.064, -0.051]]], bevel: 0.001,
  }));
  add(box(0.005, 0.019, 0.006, M.steel, 0.042, -0.041, 0, 0));
  add(slab([[0.022, -0.03], [-0.022, -0.03], [-0.064, -0.142], [-0.052, -0.152], [-0.018, -0.15],
    [-0.012, -0.12, 0.0, -0.09], [0.022, -0.03]], 0.031, M.polymer, { bevel: 0.005 }));

  // Straight stick magazine and its baseplate.
  add(slab([[0.082, -0.032], [0.118, -0.032], [0.126, -0.21], [0.088, -0.21]], 0.024, M.dark, { bevel: 0.003 }));
  add(box(0.028, 0.01, 0.046, M.polymer, 0.107, -0.212, 0, 0.003));

  // Shroud, barrel and a fat suppressor with an end cap.
  add(tube(0.021, 0.021, 0.21, 0.32, M.polymer, 0.026, 0, 20));
  for (let i = 0; i < 4; i++) add(box(0.044, 0.006, 0.014, M.dark, 0.23 + i * 0.025, 0.026, 0, 0.001));
  add(tube(0.009, 0.009, 0.32, 0.345, M.steel, 0.026));
  add(tube(0.02, 0.02, 0.345, 0.52, M.dark, 0.026, 0, 24));
  add(ring(0.02, 0.0025, 0.35, M.polymer, 0.026));
  add(disc(0.0065, 0.5205, M.polymer, 0.026));

  // Skeleton stock: two rods and a butt plate.
  for (const side of [-1, 1]) add(tube(0.0055, 0.0055, -0.27, -0.09, M.steel, 0.028, side * 0.016, 10));
  add(tube(0.0055, 0.0055, -0.27, -0.12, M.steel, -0.02, 0, 10));
  add(box(0.044, 0.1, 0.014, M.polymer, -0.276, 0.004, 0, 0.004));

  // Open reflex sight: a base, a square frame, the glass, and the dot on axis.
  const AXIS = 0.09;
  add(box(0.03, 0.012, 0.05, M.alloy, 0.085, 0.07, 0, 0.002));
  const postL = add(box(0.004, 0.036, 0.012, M.polymer, 0.095, AXIS, -0.016, 0.001));
  const postR = add(box(0.004, 0.036, 0.012, M.polymer, 0.095, AXIS, 0.016, 0.001));
  const bar = add(box(0.036, 0.004, 0.012, M.polymer, 0.095, AXIS + 0.018, 0, 0.001));
  const lens = add(box(0.028, 0.03, 0.0015, M.glass, 0.095, AXIS, 0, 0));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.00085, 10, 8), M.dot);
  dot.position.set(0, AXIS, -0.096);
  dot.renderOrder = 20;
  add(dot);
  lens.renderOrder = 10;

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.026, -0.521),
    sight: new THREE.Vector3(0, AXIS, -0.085),
    adsEye: 0.15,
    grip: new THREE.Vector3(0, -0.085, 0.03),
    support: new THREE.Vector3(0, 0.026, -0.27),
    sightParts: [postL, postR, bar, lens, dot],
  });
}

/* ------------------------------ pistol ------------------------------ */

/** A polymer-frame striker pistol: slide with cocking serrations, railed frame, 3-dot sights. */
function buildPistol(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  // Slide, with the front chamfer and a slight rear bevel.
  add(slab([[-0.03, 0.0], [0.156, 0.0], [0.156, 0.021], [0.147, 0.03], [-0.023, 0.03], [-0.03, 0.023]], 0.025, M.alloy, { bevel: 0.002 }));
  for (let i = 0; i < 6; i++) add(box(0.0265, 0.018, 0.0022, M.dark, -0.024 + i * 0.0045, 0.015, 0, 0));
  add(box(0.0025, 0.012, 0.03, M.dark, 0.035, 0.019, 0.0127, 0.0008));          // ejection port
  add(tube(0.0062, 0.0062, 0.15, 0.1575, M.dark, 0.014));                        // bore
  // Frame, with the accessory rail under the dust cover.
  add(slab([[-0.028, 0.0], [0.152, 0.0], [0.152, -0.017], [0.07, -0.018], [0.06, -0.022], [-0.02, -0.022], [-0.028, -0.014]], 0.027, M.polymer, { bevel: 0.002 }));
  for (let i = 0; i < 3; i++) add(box(0.02, 0.004, 0.004, M.dark, 0.1 + i * 0.016, -0.019, 0, 0));
  // Grip at the usual 22 degrees, with a beavertail and finger grooves.
  add(slab([[0.024, -0.016], [-0.026, -0.012], [-0.036, -0.004], [-0.052, -0.118], [-0.04, -0.128], [-0.008, -0.126],
    [-0.004, -0.1, 0.004, -0.09], [0.0, -0.074, 0.01, -0.062], [0.006, -0.048, 0.016, -0.036], [0.024, -0.016]], 0.03, M.polymer, { bevel: 0.004 }));
  add(box(0.031, 0.008, 0.042, M.dark, -0.025, -0.128, 0, 0.002));             // mag base
  // Trigger guard and trigger.
  add(slab([[0.064, -0.018], [0.006, -0.018], [0.006, -0.05], [0.07, -0.05], [0.074, -0.03]], 0.011, M.polymer, {
    holes: [[[0.058, -0.022], [0.012, -0.022], [0.012, -0.045], [0.064, -0.045], [0.066, -0.031]]], bevel: 0.001,
  }));
  add(box(0.004, 0.017, 0.005, M.dark, 0.036, -0.03, 0, 0));
  // Sights: front post with a white dot, rear notch with two.
  const front = add(box(0.0042, 0.0075, 0.005, M.dark, 0.146, 0.0335, 0, 0.0006));
  const fdot = add(disc(0.0011, 0.1436, M.white, 0.0348));
  const rearL = add(box(0.006, 0.0085, 0.006, M.dark, -0.017, 0.034, -0.0055, 0.0006));
  const rearR = add(box(0.006, 0.0085, 0.006, M.dark, -0.017, 0.034, 0.0055, 0.0006));
  add(disc(0.001, -0.02, M.white, 0.035, -0.0055), disc(0.001, -0.02, M.white, 0.035, 0.0055));

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.014, -0.158),
    // The sight line runs along the tops of the front and rear posts.
    sight: new THREE.Vector3(0, 0.0372, 0.017),
    adsEye: 0.4,
    grip: new THREE.Vector3(0, -0.062, 0.018),
    support: new THREE.Vector3(-0.024, -0.075, 0.02),
    sightParts: [front, fdot, rearL, rearR],
  });
}

/* ------------------------------ shotgun ------------------------------ */

/** A pump-action 12 gauge: alloy receiver, vent-rib barrel over a tube magazine, walnut. */
function buildShotgun(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  add(slab([[-0.02, -0.024], [0.205, -0.024], [0.205, 0.05], [0.02, 0.058], [-0.02, 0.052]], 0.046, M.alloy));
  add(box(0.003, 0.024, 0.07, M.dark, 0.1, 0.028, 0.0235, 0.001));              // loading port
  add(tube(0.0118, 0.0112, 0.205, 0.742, M.steel, 0.036));                        // barrel
  add(box(0.008, 0.004, 0.53, M.alloy, 0.47, 0.0505, 0, 0.001));                // vent rib
  add(disc(0.0082, 0.7425, M.dark, 0.036));
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 8, 6), M.brass);
  bead.position.set(0, 0.0545, -0.735);
  add(bead);
  add(tube(0.0128, 0.0128, 0.205, 0.64, M.alloy, 0.004));                         // magazine tube
  add(tube(0.0142, 0.0142, 0.64, 0.665, M.steel, 0.004));
  // Pump: walnut, with its grip grooves.
  add(slab([[0.3, -0.021], [0.475, -0.021], [0.485, 0.0], [0.475, 0.024], [0.3, 0.024], [0.29, 0.002]], 0.05, M.wood, { bevel: 0.006 }));
  for (let i = 0; i < 7; i++) add(box(0.052, 0.003, 0.004, M.dark, 0.32 + i * 0.022, -0.014, 0, 0));
  // Trigger guard and trigger.
  add(slab([[0.07, -0.024], [0.0, -0.024], [0.0, -0.05], [0.074, -0.05]], 0.012, M.alloy, {
    holes: [[[0.064, -0.028], [0.006, -0.028], [0.006, -0.045], [0.068, -0.045]]], bevel: 0.001,
  }));
  add(box(0.005, 0.018, 0.006, M.steel, 0.035, -0.036, 0, 0));
  // Walnut stock with a pistol-grip wrist.
  add(slab([[-0.02, 0.03], [-0.04, 0.008], [-0.1, -0.002], [-0.33, -0.006], [-0.345, -0.012], [-0.345, -0.124], [-0.33, -0.134],
    [-0.12, -0.062], [-0.07, -0.1], [-0.042, -0.102], [-0.02, -0.024]], 0.044, M.wood, { bevel: 0.006 }));
  add(box(0.046, 0.14, 0.014, M.dark, -0.352, -0.06, 0, 0.004));

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.036, -0.743),
    // Just above the receiver's bevelled top edge, looking down the rib at the bead.
    sight: new THREE.Vector3(0, 0.0625, 0.0),
    adsEye: 0.26,
    grip: new THREE.Vector3(0, -0.06, 0.055),
    support: new THREE.Vector3(0, -0.008, -0.39),
    sightParts: [bead],
  });
}

/* ------------------------------ sniper ------------------------------ */

/** A bolt-action .338 on an olive chassis: fluted barrel, muzzle brake, variable scope. */
function buildSniper(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  // Chassis forend, action bed and thumbhole stock, as one olive profile.
  add(slab([[0.33, 0.012], [0.33, -0.028], [0.06, -0.036], [0.058, -0.042], [-0.02, -0.042], [-0.03, -0.028],
    [-0.078, -0.15], [-0.062, -0.16], [-0.03, -0.158], [-0.02, -0.14, -0.035, -0.1], [-0.12, -0.08],
    [-0.36, -0.1], [-0.38, -0.09], [-0.38, 0.058], [-0.36, 0.068], [-0.2, 0.068], [-0.12, 0.03], [-0.05, 0.012]],
  0.05, M.olive, { bevel: 0.006, holes: [[[-0.07, -0.02], [-0.17, -0.03], [-0.17, -0.06], [-0.1, -0.062], [-0.06, -0.045]]] }));
  add(box(0.054, 0.15, 0.016, M.dark, -0.386, -0.016, 0, 0.004));             // butt pad
  // Receiver and bolt.
  add(tube(0.019, 0.019, -0.065, 0.165, M.dark, 0.026));
  add(post(0.004, 0.05, M.steel, 0.045, 0.028, -0.03, true));            // bolt handle
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.0095, 12, 10), M.dark);
  knob.position.set(0.07, 0.024, 0.03);
  add(knob);
  add(box(0.034, 0.06, 0.07, M.dark, 0.03, -0.06, 0, 0.003));                 // magazine
  // Barrel, fluted, and a two-port brake.
  add(tube(0.0145, 0.0112, 0.165, 0.8, M.steel, 0.026));
  for (let i = 0; i < 6; i++) {
    const f = box(0.0022, 0.0022, 0.36, M.dark, 0.5, 0.026, 0, 0);
    const a = (i / 6) * Math.PI * 2;
    f.position.x = Math.cos(a) * 0.0127;
    f.position.y = 0.026 + Math.sin(a) * 0.0127;
    add(f);
  }
  add(box(0.034, 0.03, 0.075, M.dark, 0.838, 0.026, 0, 0.004));
  for (const side of [-1, 1]) add(box(0.004, 0.018, 0.018, M.polymer, 0.83, 0.026, side * 0.0172, 0.001));
  // Folded bipod under the forend.
  for (const side of [-1, 1]) add(box(0.007, 0.007, 0.2, M.dark, 0.2, -0.042, side * 0.016, 0.002));
  // Scope: rings, tube, bells, turrets.
  const AXIS = 0.085;
  for (const s of [0.0, 0.13]) add(box(0.03, 0.036, 0.02, M.dark, s, 0.062, 0, 0.003));
  add(tube(0.0152, 0.0152, -0.06, 0.2, M.polymer, AXIS));
  add(tube(0.0152, 0.0262, 0.2, 0.3, M.polymer, AXIS));
  add(ring(0.026, 0.0025, 0.3, M.polymer, AXIS));
  const objLens = add(disc(0.0245, 0.298, M.glass, AXIS));
  objLens.rotation.y = Math.PI;
  add(tube(0.0195, 0.0152, -0.125, -0.06, M.polymer, AXIS));
  add(disc(0.0185, -0.1255, M.glass, AXIS));
  add(post(0.012, 0.02, M.polymer, 0, AXIS + 0.025, 0.085));
  add(post(0.012, 0.02, M.polymer, 0.025, AXIS, 0.085, true));

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.026, -0.876),
    sight: new THREE.Vector3(0, AXIS, 0.125),
    adsEye: 0.08,
    grip: new THREE.Vector3(0, -0.085, 0.052),
    support: new THREE.Vector3(0, -0.03, -0.24),
  });
}

/* ----------------------------- revolver ----------------------------- */

/** A six-shot .357: fluted cylinder, solid frame, 6" barrel on a full underlug, walnut grips. */
function buildRevolver(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  // Frame: top strap over the cylinder, solid web below it, and the hammer spur behind.
  add(slab([[-0.03, 0.034], [0.07, 0.036], [0.128, 0.036], [0.128, -0.016], [0.07, -0.026], [0.02, -0.03], [-0.03, -0.012]], 0.024, M.alloy, { bevel: 0.002 }));
  add(slab([[-0.026, 0.03], [-0.044, 0.04], [-0.052, 0.034], [-0.038, 0.016]], 0.008, M.steel, { bevel: 0.001 }));
  // Cylinder with its six flutes, and the chambers showing at the front.
  add(tube(0.0235, 0.0235, 0.058, 0.122, M.steel, 0.006, 0, 24));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const fl = box(0.006, 0.008, 0.04, M.dark, 0.09, 0.006, 0, 0);
    fl.position.x = Math.cos(a) * 0.0232;
    fl.position.y = 0.006 + Math.sin(a) * 0.0232;
    fl.rotation.z = a;
    add(fl);
    add(disc(0.0042, 0.1223, M.dark, 0.006 + Math.sin(a) * 0.0135, Math.cos(a) * 0.0135));
  }
  // Barrel, ventilated rib, underlug and ejector rod.
  add(tube(0.0098, 0.0092, 0.122, 0.405, M.steel, 0.022));
  add(box(0.007, 0.004, 0.28, M.alloy, 0.27, 0.0335, 0, 0.001));
  add(tube(0.0092, 0.0092, 0.122, 0.34, M.alloy, 0.0, 0, 14));
  add(disc(0.0068, 0.4052, M.dark, 0.022));
  // Sights: a ramped front blade and a square-notch rear on the top strap.
  const front = add(box(0.0035, 0.0125, 0.005, M.dark, 0.396, 0.0378, 0, 0.0005));
  const rearL = add(box(0.006, 0.007, 0.006, M.dark, -0.008, 0.0395, -0.0055, 0.0005));
  const rearR = add(box(0.006, 0.007, 0.006, M.dark, -0.008, 0.0395, 0.0055, 0.0005));
  // Trigger guard and trigger.
  add(slab([[0.07, -0.026], [0.006, -0.03], [0.006, -0.056], [0.074, -0.052], [0.08, -0.034]], 0.011, M.alloy, {
    holes: [[[0.064, -0.03], [0.012, -0.034], [0.012, -0.05], [0.068, -0.047], [0.072, -0.035]]], bevel: 0.001,
  }));
  add(box(0.004, 0.017, 0.005, M.steel, 0.036, -0.034, 0, 0));
  // Walnut round-butt grip with brass medallion.
  add(slab([[0.022, -0.016], [-0.026, -0.01], [-0.04, -0.004], [-0.074, -0.1], [-0.062, -0.13], [-0.022, -0.126],
    [-0.006, -0.1, 0.006, -0.082], [0.022, -0.016]], 0.032, M.wood, { bevel: 0.005 }));
  add(disc(0.006, 0.0, M.brass, -0.07, 0.0175)).rotation.y = Math.PI / 2;

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.022, -0.406),
    sight: new THREE.Vector3(0, 0.0436, 0.008),
    adsEye: 0.4,
    grip: new THREE.Vector3(0, -0.062, 0.018),
    support: new THREE.Vector3(-0.024, -0.075, 0.02),
    sightParts: [front, rearL, rearR],
  });
}

/* -------------------------- machine pistol -------------------------- */

/** The pistol's frame with a ported compensator and a 24-round stick, for full-auto. */
function buildMachinePistol(M) {
  const g = buildPistol(M);
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };
  add(slab([[-0.046, -0.126], [-0.006, -0.124], [0.004, -0.235], [-0.038, -0.238]], 0.024, M.dark, { bevel: 0.003 }));
  add(box(0.03, 0.008, 0.046, M.polymer, -0.021, -0.241, 0, 0.003));
  add(tube(0.0098, 0.0098, 0.156, 0.19, M.steel, 0.016, 0, 14));
  add(box(0.0245, 0.02, 0.034, M.dark, 0.173, 0.016, 0, 0.003));
  for (let i = 0; i < 3; i++) add(box(0.016, 0.003, 0.004, M.polymer, 0.162 + i * 0.011, 0.0265, 0, 0));
  g.userData.muzzle.position.set(0, 0.016, -0.191);
  return g;
}

/* -------------------------------- LMG -------------------------------- */

/** A belt-fed light machine gun: heavy barrel in a vented shroud, carry handle, bipod, box. */
function buildLmg(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  // Receiver and top cover.
  add(slab([[-0.07, 0.0], [0.27, 0.0], [0.27, 0.064], [-0.04, 0.064], [-0.07, 0.048]], 0.05, M.alloy));
  add(box(0.034, 0.01, 0.24, M.alloy, 0.07, 0.069, 0, 0.0015));
  add(box(0.003, 0.022, 0.07, M.dark, 0.08, 0.034, 0.0255, 0.001));
  add(box(0.014, 0.01, 0.034, M.polymer, 0.16, 0.044, 0.03, 0.002));     // charging handle
  // Lower, grip, guard and trigger.
  add(slab([[-0.048, 0.0], [0.2, 0.0], [0.2, -0.04], [-0.03, -0.04], [-0.048, -0.022]], 0.046, M.alloy));
  add(slab([[0.07, -0.04], [0.006, -0.04], [0.006, -0.064], [0.072, -0.064]], 0.012, M.alloy, {
    holes: [[[0.064, -0.044], [0.012, -0.044], [0.012, -0.059], [0.064, -0.059]]], bevel: 0.001,
  }));
  add(box(0.005, 0.02, 0.006, M.steel, 0.042, -0.049, 0, 0));
  add(slab([[0.022, -0.038], [-0.022, -0.038], [-0.064, -0.15], [-0.052, -0.16], [-0.018, -0.158],
    [-0.012, -0.128, 0.0, -0.098], [0.022, -0.038]], 0.032, M.polymer, { bevel: 0.005 }));
  // Ammunition box slung under the feed tray, with the belt running up into it.
  add(box(0.074, 0.12, 0.13, M.olive, 0.13, -0.1, 0, 0.006));
  add(box(0.078, 0.012, 0.136, M.dark, 0.13, -0.036, 0, 0.003));
  for (let i = 0; i < 5; i++) add(box(0.012, 0.012, 0.01, M.brass, 0.08 + i * 0.014, -0.02, 0.012, 0.002));
  // Heavy barrel inside a vented shroud, flash hider.
  add(tube(0.0125, 0.0115, 0.27, 0.8, M.steel, 0.034));
  add(tube(0.0265, 0.0265, 0.27, 0.52, M.polymer, 0.034, 0, 22));
  for (let i = 0; i < 5; i++) for (const side of [-1, 1]) add(box(0.004, 0.012, 0.024, M.dark, 0.31 + i * 0.043, 0.034, side * 0.0262, 0.001));
  add(tube(0.0175, 0.0175, 0.8, 0.86, M.dark, 0.034, 0, 16));
  add(disc(0.008, 0.8605, M.dark, 0.034));
  // A folded bipod under the shroud.
  for (const side of [-1, 1]) add(box(0.007, 0.007, 0.17, M.dark, 0.43, -0.014, side * 0.024, 0.002));
  // Fixed stock on a buffer tube.
  add(tube(0.0175, 0.0175, -0.2, -0.07, M.alloy, 0.03));
  add(slab([[-0.14, 0.06], [-0.3, 0.06], [-0.32, 0.046], [-0.32, -0.07], [-0.298, -0.082], [-0.25, -0.036],
    [-0.19, 0.0], [-0.14, 0.01]], 0.046, M.olive, { bevel: 0.004 }));
  add(box(0.048, 0.14, 0.014, M.dark, -0.325, -0.006, 0, 0.004));
  // Red dot on a riser, as on the rifle.
  const AXIS = 0.114;
  add(box(0.028, 0.02, 0.042, M.alloy, 0.105, 0.0825, 0, 0.002));
  const housing = add(tube(0.0215, 0.0215, 0.078, 0.137, M.polymer, AXIS, 0, 28, true));
  const rearRing = add(ring(0.0215, 0.0032, 0.078, M.polymer, AXIS));
  const frontRing = add(ring(0.0215, 0.0032, 0.137, M.polymer, AXIS));
  const lens = add(disc(0.0205, 0.132, M.glass, AXIS));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.00085, 10, 8), M.dot);
  dot.position.set(0, AXIS, -0.128);
  dot.renderOrder = 20;
  add(dot);
  lens.renderOrder = 10;

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.034, -0.862),
    sight: new THREE.Vector3(0, AXIS, -0.078),
    adsEye: 0.16,
    grip: new THREE.Vector3(0, -0.09, 0.03),
    support: new THREE.Vector3(0, 0.034, -0.4),
    sightParts: [housing, rearRing, frontRing, lens, dot],
  });
}

/* --------------------------- auto shotgun --------------------------- */

/** A semi-auto 12 gauge fed from a box magazine: vented shield over the barrel, polymer stock. */
function buildAutoShotgun(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  add(slab([[-0.04, -0.03], [0.285, -0.03], [0.285, 0.056], [-0.04, 0.056]], 0.05, M.alloy));
  add(box(0.003, 0.026, 0.09, M.dark, 0.12, 0.024, 0.0255, 0.001));
  add(box(0.012, 0.01, 0.034, M.polymer, 0.2, 0.04, 0.03, 0.002));
  // Barrel inside a vented heat shield, with a muzzle brake.
  add(tube(0.0125, 0.0125, 0.285, 0.68, M.steel, 0.034));
  add(tube(0.0225, 0.0225, 0.285, 0.57, M.polymer, 0.034, 0, 20));
  for (let i = 0; i < 6; i++) add(box(0.047, 0.004, 0.018, M.dark, 0.33 + i * 0.04, 0.034, 0, 0.001));
  add(tube(0.0165, 0.0165, 0.68, 0.72, M.dark, 0.034, 0, 16));
  add(disc(0.0095, 0.7205, M.dark, 0.034));
  // Box magazine ahead of the trigger.
  add(slab([[0.06, -0.03], [0.15, -0.03], [0.162, -0.19], [0.07, -0.19]], 0.042, M.dark, { bevel: 0.004 }));
  add(box(0.046, 0.01, 0.1, M.polymer, 0.116, -0.192, 0, 0.003));
  // Pistol grip, guard and trigger.
  add(slab([[0.07, -0.03], [0.006, -0.03], [0.006, -0.054], [0.072, -0.054]], 0.012, M.alloy, {
    holes: [[[0.064, -0.034], [0.012, -0.034], [0.012, -0.049], [0.064, -0.049]]], bevel: 0.001,
  }));
  add(box(0.005, 0.019, 0.006, M.steel, 0.038, -0.04, 0, 0));
  add(slab([[0.024, -0.028], [-0.02, -0.028], [-0.06, -0.14], [-0.048, -0.15], [-0.016, -0.148],
    [-0.01, -0.118, 0.0, -0.088], [0.024, -0.028]], 0.034, M.polymer, { bevel: 0.005 }));
  // Fixed polymer stock with a cheek weld.
  add(slab([[-0.04, 0.05], [-0.3, 0.054], [-0.318, 0.04], [-0.318, -0.07], [-0.296, -0.08], [-0.24, -0.032],
    [-0.12, -0.012], [-0.04, -0.02]], 0.042, M.polymer, { bevel: 0.005 }));
  add(box(0.046, 0.13, 0.014, M.dark, -0.323, -0.01, 0, 0.004));
  // Iron sights: a short post on the shield, a notch block on the receiver.
  const front = add(box(0.004, 0.0095, 0.006, M.dark, 0.545, 0.0603, 0, 0.0005));
  const rearL = add(box(0.006, 0.008, 0.006, M.dark, -0.012, 0.06, -0.007, 0.0005));
  const rearR = add(box(0.006, 0.008, 0.006, M.dark, -0.012, 0.06, 0.007, 0.0005));

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.034, -0.722),
    sight: new THREE.Vector3(0, 0.0645, 0.012),
    adsEye: 0.3,
    grip: new THREE.Vector3(0, -0.075, 0.02),
    support: new THREE.Vector3(0, 0.034, -0.4),
    sightParts: [front, rearL, rearR],
  });
}

/* -------------------------------- DMR -------------------------------- */

/** A 7.62 marksman rifle: long free-float rail, 20-round mag, compact 4x scope, brake. */
function buildDmr(M) {
  const g = new THREE.Group();
  const add = (...ms) => { for (const m of ms) g.add(m); return ms[0]; };

  add(slab([[-0.06, 0.0], [0.22, 0.0], [0.22, 0.058], [-0.036, 0.058], [-0.06, 0.044]], 0.046, M.alloy));
  add(box(0.03, 0.011, 0.34, M.alloy, 0.09, 0.0635, 0, 0.0015));
  for (let i = 0; i < 18; i++) add(box(0.032, 0.004, 0.0055, M.dark, -0.06 + i * 0.0185, 0.0695, 0, 0));
  add(box(0.003, 0.02, 0.07, M.dark, 0.08, 0.03, 0.0245, 0.001));
  add(slab([[-0.048, 0.0], [0.178, 0.0], [0.178, -0.02], [0.15, -0.032], [0.148, -0.08], [0.072, -0.08], [0.07, -0.036],
    [-0.03, -0.036], [-0.048, -0.02]], 0.044, M.alloy));
  add(slab([[0.07, -0.036], [0.006, -0.036], [0.006, -0.06], [0.072, -0.06]], 0.012, M.alloy, {
    holes: [[[0.064, -0.04], [0.012, -0.04], [0.012, -0.055], [0.064, -0.055]]], bevel: 0.001,
  }));
  add(box(0.005, 0.02, 0.006, M.steel, 0.042, -0.045, 0, 0));
  add(slab([[0.022, -0.032], [-0.022, -0.032], [-0.064, -0.144], [-0.052, -0.154], [-0.018, -0.152],
    [-0.012, -0.122, 0.0, -0.092], [0.022, -0.032]], 0.031, M.olive, { bevel: 0.005 }));
  add(slab([[0.076, -0.08], [0.146, -0.08], [0.156, -0.17, 0.162, -0.2], [0.118, -0.204], [0.108, -0.17, 0.076, -0.08]], 0.026, M.dark, { bevel: 0.003 }));
  // Free-float handguard with M-LOK slots, a long barrel, and a three-port brake.
  add(tube(0.0285, 0.0285, 0.22, 0.6, M.alloy, 0.029, 0, 12));
  for (const side of [-1, 1]) for (let i = 0; i < 6; i++) add(box(0.004, 0.009, 0.034, M.dark, 0.26 + i * 0.056, 0.029, side * 0.0285, 0.002));
  add(tube(0.0105, 0.0095, 0.6, 0.83, M.steel, 0.029));
  add(tube(0.0148, 0.0148, 0.83, 0.88, M.dark, 0.029, 0, 16));
  for (const side of [-1, 1]) add(box(0.004, 0.012, 0.012, M.polymer, 0.86, 0.029, side * 0.0146, 0.001));
  add(disc(0.007, 0.8805, M.dark, 0.029));
  // Fixed stock with a cheek riser, and the buffer tube.
  add(tube(0.017, 0.017, -0.24, -0.05, M.alloy, 0.033));
  add(slab([[-0.13, 0.062], [-0.29, 0.066], [-0.31, 0.05], [-0.31, -0.07], [-0.29, -0.082], [-0.24, -0.032],
    [-0.17, 0.004], [-0.13, 0.01]], 0.043, M.olive, { bevel: 0.004 }));
  add(box(0.045, 0.14, 0.014, M.dark, -0.315, -0.006, 0, 0.004));
  // 4x scope: mounts, tube, bells and turrets, with the lens on the sight line.
  const AXIS = 0.1;
  for (const sPos of [0.0, 0.1]) add(box(0.028, 0.017, 0.02, M.dark, sPos, 0.0775, 0, 0.003));
  add(tube(0.0158, 0.0158, -0.03, 0.18, M.polymer, AXIS));
  add(tube(0.0158, 0.0255, 0.18, 0.26, M.polymer, AXIS));
  add(ring(0.0255, 0.0024, 0.26, M.polymer, AXIS));
  add(disc(0.0245, 0.258, M.glass, AXIS)).rotation.y = Math.PI;
  add(tube(0.0198, 0.0158, -0.085, -0.03, M.polymer, AXIS));
  add(disc(0.0188, -0.0855, M.glass, AXIS));
  add(post(0.011, 0.018, M.polymer, 0, AXIS + 0.024, 0.07));
  add(post(0.011, 0.018, M.polymer, 0.024, AXIS, 0.07, true));

  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.029, -0.881),
    sight: new THREE.Vector3(0, AXIS, 0.085),
    adsEye: 0.08,
    grip: new THREE.Vector3(0, -0.085, 0.03),
    support: new THREE.Vector3(0, 0.0, -0.4),
  });
}

/* ------------------------------ frag ------------------------------ */

function buildFrag(M) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.034, 20, 14), M.olive);
  body.scale.set(1, 1.18, 1);
  body.position.set(0, -0.02, -0.06);
  g.add(body);
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.022, 12), M.steel);
  fuse.position.set(0, 0.024, -0.06);
  g.add(fuse);
  const spoon = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.07, 0.006, 2, 0.002), M.steel);
  spoon.position.set(0, 0.0, -0.028);
  spoon.rotation.x = 0.25;
  g.add(spoon);
  const pin = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0018, 6, 16), M.steel);
  pin.position.set(0.02, 0.03, -0.06);
  pin.rotation.y = Math.PI / 2;
  g.add(pin);
  return finish(g, {
    muzzle: new THREE.Vector3(0, 0.0, -0.1),
    sight: new THREE.Vector3(0, 0.03, -0.06),
    adsEye: 0.3,
    grip: new THREE.Vector3(0, -0.02, -0.06),
    support: new THREE.Vector3(-0.03, -0.03, -0.05),
  });
}

/* ------------------------------ hands ------------------------------ */

/**
 * A gloved hand closed round a cylinder of radius R, built in a canonical frame — the cylinder
 * runs along +Y through the origin, the palm is on the +X side, the knuckles face -Z and the
 * wrist is behind at +Z — and mirrored in X for the left hand (side = -1). placeHand() then
 * turns it onto the real grip, so the same hand fits a pistol grip, a handguard or a pump.
 */
function wrapHand(M, R, side) {
  const g = new THREE.Group();
  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.024, 0.088, 0.072, 3, 0.01), M.glove);
  palm.position.set(side * (R + 0.012), 0, 0.012);
  g.add(palm);
  // Four fingers, each a curled arc round the grip from the palm side, across the front, to
  // the far side — one continuous curve reads as a finger where a chain of capsules read as
  // a string of beads.
  const fingerGeo = new THREE.TorusGeometry(R + 0.0094, 0.0094, 8, 14, Math.PI * 0.92);
  fingerGeo.rotateX(-Math.PI / 2);
  fingerGeo.rotateY(Math.PI * 0.04);
  for (let i = 0; i < 4; i++) {
    const finger = new THREE.Mesh(fingerGeo, M.glove);
    finger.position.y = 0.031 - i * 0.021;
    if (side < 0) finger.scale.x = -1;
    g.add(finger);
    const knuckle = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.016, 0.012, 2, 0.004), M.knuckle);
    knuckle.position.set(side * (R + 0.008), finger.position.y, -(R + 0.002) * 0.6);
    g.add(knuckle);
  }
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.0098, 0.038, 3, 8), M.glove);
  thumb.rotation.x = Math.PI / 2 - 0.3;
  thumb.position.set(-side * (R + 0.005), 0.047, 0.0);
  g.add(thumb);
  g.userData.wrist = new THREE.Vector3(side * (R + 0.006), -0.004, R + 0.034);
  return g;
}

const _hx = new THREE.Vector3(), _hy = new THREE.Vector3(), _hz = new THREE.Vector3();
const _hm = new THREE.Matrix4();

/**
 * Put a wrapHand on a grip: centred at `centre`, the grip's long axis along `axis` (pointing
 * toward the top of the hand), the palm on the `palm` side of it. Adds the forearm sleeve,
 * running from the wrist along `forearm` far enough that its end is always off screen.
 */
function placeHand(g, M, { centre, axis, palm, radius, forearm }, side) {
  const hand = wrapHand(M, radius, side);
  _hy.set(...axis).normalize();
  _hx.set(...palm).multiplyScalar(side);
  _hx.addScaledVector(_hy, -_hx.dot(_hy)).normalize();
  _hz.crossVectors(_hx, _hy);
  _hm.makeBasis(_hx, _hy, _hz);
  hand.quaternion.setFromRotationMatrix(_hm);
  hand.position.set(...centre);
  g.add(hand);

  const wrist = hand.userData.wrist.clone().applyQuaternion(hand.quaternion).add(hand.position);
  const dir = new THREE.Vector3(...forearm).normalize();
  const LEN = 0.62;
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.031, 0.034, 16), M.glove);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.047, LEN, 16), M.sleeve);
  for (const [m, from, len] of [[cuff, 0, 0.034], [sleeve, 0.022, LEN]]) {
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
    m.position.copy(wrist).addScaledVector(dir, from + len / 2);
    g.add(m);
  }
}

/**
 * Where the hands go on each gun, in the gun's frame. `axis` runs up the grip; for a
 * handguard it runs forward. `palm` is the side the palm is on. Forearms come in from the
 * bottom corners of the screen, the way they do when you hold a long gun.
 */
const FIRING_FOREARM = [0.3, -0.36, 1];
const SUPPORT_FOREARM = [-0.34, -0.72, 0.6];
const HANDS = {
  ar: {
    right: { centre: [0, -0.086, 0.02], axis: [0, 0.115, -0.045], palm: [1, 0, 0], radius: 0.017, forearm: FIRING_FOREARM },
    left: { centre: [0, 0.029, -0.37], axis: [0, 0, -1], palm: [0, -1, 0], radius: 0.034, forearm: SUPPORT_FOREARM },
  },
  smg: {
    right: { centre: [0, -0.086, 0.02], axis: [0, 0.115, -0.045], palm: [1, 0, 0], radius: 0.017, forearm: FIRING_FOREARM },
    left: { centre: [0, 0.026, -0.27], axis: [0, 0, -1], palm: [0, -1, 0], radius: 0.024, forearm: SUPPORT_FOREARM },
  },
  pistol: {
    right: { centre: [0, -0.07, 0.006], axis: [0, 0.109, -0.05], palm: [1, 0, 0], radius: 0.016, forearm: [0.12, -0.95, 1] },
    left: { centre: [-0.012, -0.08, 0.004], axis: [0, 0.109, -0.05], palm: [-1, 0, 0], radius: 0.03, forearm: [-0.16, -0.95, 1] },
  },
  shotgun: {
    right: { centre: [0, -0.062, 0.046], axis: [0, 0.076, -0.05], palm: [1, 0, 0], radius: 0.02, forearm: FIRING_FOREARM },
    left: { centre: [0, 0.0015, -0.39], axis: [0, 0, -1], palm: [0, -1, 0], radius: 0.03, forearm: SUPPORT_FOREARM },
  },
  sniper: {
    right: { centre: [0, -0.09, 0.05], axis: [0, 0.127, -0.04], palm: [1, 0, 0], radius: 0.018, forearm: FIRING_FOREARM },
    left: { centre: [0, -0.008, -0.24], axis: [0, 0, -1], palm: [0, -1, 0], radius: 0.028, forearm: SUPPORT_FOREARM },
  },
  revolver: {
    right: { centre: [0, -0.07, 0.006], axis: [0, 0.109, -0.05], palm: [1, 0, 0], radius: 0.016, forearm: [0.12, -0.95, 1] },
    left: { centre: [-0.012, -0.08, 0.004], axis: [0, 0.109, -0.05], palm: [-1, 0, 0], radius: 0.03, forearm: [-0.16, -0.95, 1] },
  },
  mp: {
    right: { centre: [0, -0.07, 0.006], axis: [0, 0.109, -0.05], palm: [1, 0, 0], radius: 0.016, forearm: [0.12, -0.95, 1] },
    left: { centre: [-0.012, -0.08, 0.004], axis: [0, 0.109, -0.05], palm: [-1, 0, 0], radius: 0.03, forearm: [-0.16, -0.95, 1] },
  },
  lmg: {
    right: { centre: [0, -0.09, 0.02], axis: [0, 0.115, -0.045], palm: [1, 0, 0], radius: 0.017, forearm: FIRING_FOREARM },
    left: { centre: [0, 0.034, -0.4], axis: [0, 0, -1], palm: [0, -1, 0], radius: 0.036, forearm: SUPPORT_FOREARM },
  },
  ashotgun: {
    right: { centre: [0, -0.078, 0.014], axis: [0, 0.115, -0.045], palm: [1, 0, 0], radius: 0.018, forearm: FIRING_FOREARM },
    left: { centre: [0, 0.012, -0.4], axis: [0, 0, -1], palm: [0, -1, 0], radius: 0.026, forearm: SUPPORT_FOREARM },
  },
  dmr: {
    right: { centre: [0, -0.088, 0.02], axis: [0, 0.115, -0.045], palm: [1, 0, 0], radius: 0.017, forearm: FIRING_FOREARM },
    left: { centre: [0, 0.029, -0.4], axis: [0, 0, -1], palm: [0, -1, 0], radius: 0.034, forearm: SUPPORT_FOREARM },
  },
  frag: {
    right: { centre: [0, -0.02, -0.06], axis: [0, 1, 0], palm: [1, 0, 0], radius: 0.036, forearm: [0.3, -0.4, 1] },
  },
};

function addHands(g, id, M) {
  const spec = HANDS[id];
  if (!spec) return;
  if (spec.right) placeHand(g, M, spec.right, 1);
  if (spec.left) placeHand(g, M, spec.left, -1);
}

const BUILDERS = {
  ar: buildRifle, smg: buildSmg, pistol: buildPistol, shotgun: buildShotgun, sniper: buildSniper, frag: buildFrag,
  revolver: buildRevolver, mp: buildMachinePistol, lmg: buildLmg, ashotgun: buildAutoShotgun, dmr: buildDmr,
};

/**
 * Build a gun. `hands` adds gloved hands and sleeves (the first-person view); bots use their
 * own skeleton's hands. `materials` lets a caller own the materials — bots need their own set
 * per gun, because the death fade writes material opacity.
 */
export function buildGunModel(id, { hands = false, materials = null } = {}) {
  const M = materials ?? gunMaterials();
  const g = (BUILDERS[id] ?? buildPistol)(M);
  if (hands) addHands(g, id, M);
  g.userData.weaponId = id;
  return g;
}
