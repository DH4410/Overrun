import * as THREE from 'three';

import { matte } from './rendering.js';
import { clamp, rand } from './utils.js';

/** Weapon tuning and inventory definitions shared by player, bots, HUD, and tests. */
/**
 * === PLAYER ACCURACY MODEL ===
 *
 * `spread` is still the cone fireWeapon() applies by default, and the bots still drive it
 * through their own aim profile (see AIM in bots.js). The PLAYER no longer uses it. A single
 * multiplied cone cannot express the thing that makes a tactical shooter feel tactical: that
 * standing still and tapping is pinpoint, and that moving, jumping or holding the trigger is
 * not. So the player's cone is built additively from these, in radians:
 *
 *   rest   — standing, settled, first shot. Small enough to be effectively pinpoint.
 *   move   — per m/s of planar speed. Walking is survivable; sprinting is not.
 *   air    — flat penalty while off the ground. Jump-peeking should not be free.
 *   bloomStep / bloomMax / bloomDecay — spray cost per shot, its ceiling, and how fast it
 *            recovers once you let go. This is what makes bursting beat holding.
 *
 * `pattern` is the recoil the gun kicks per shot, as [yaw, pitch] multiples of `recoil`,
 * indexed by shot number and held at the last entry. Deterministic on purpose: a pattern can
 * be learned and pulled against, where the old random kick could only be endured.
 */
export const WEAPONS = [
  {
    id: 'pistol', name: 'PISTOL', slot: 1, auto: false,
    damage: 15, speed: 400, cooldown: 0.22, mag: 15, reserve: 90, reload: 1.2,
    spread: 0.006, pellets: 1, recoil: 0.017, kick: 0.05, zoom: false,
    rest: 0.0016, move: 0.010, air: 0.050,
    bloomStep: 0.0040, bloomMax: 0.030, bloomDecay: 0.090,
    pattern: [[0, 1], [0.2, 0.9], [-0.3, 0.8], [0.35, 0.7]],
    color: 0x2b3038, sound: 'pistol',
  },
  {
    id: 'ar', name: 'ASSAULT RIFLE', slot: 2, auto: true,
    damage: 26, speed: 380, cooldown: 0.09, mag: 30, reserve: 180, reload: 2.0,
    spread: 0.025, pellets: 1, recoil: 0.014, kick: 0.045, zoom: false,
    rest: 0.0018, move: 0.013, air: 0.070,
    bloomStep: 0.0035, bloomMax: 0.042, bloomDecay: 0.110,
    // Climbs hard for the first eight, then breaks left and right — the classic shape, so
    // the counter is the classic one: burst, or pull down and counter the sway.
    pattern: [
      [0, 1.0], [0, 1.15], [0, 1.25], [0.1, 1.2], [0.25, 1.05], [0.45, 0.9],
      [0.3, 0.7], [-0.15, 0.6], [-0.55, 0.5], [-0.8, 0.45], [-0.6, 0.4],
      [-0.1, 0.4], [0.5, 0.4], [0.8, 0.4], [0.5, 0.35], [-0.2, 0.35],
    ],
    color: 0x33372f, sound: 'ar',
  },
  {
    id: 'shotgun', name: 'SHOTGUN', slot: 3, auto: false,
    damage: 10, speed: 280, cooldown: 0.9, mag: 8, reserve: 40, reload: 2.5,
    spread: 0.08, pellets: 8, recoil: 0.06, kick: 0.16, zoom: false,
    // `rest` IS the pellet pattern here, not an error term — a shotgun is supposed to
    // spread. Moving barely matters for the same reason.
    rest: 0.0750, move: 0.012, air: 0.050,
    bloomStep: 0.0020, bloomMax: 0.020, bloomDecay: 0.080,
    pattern: [[0, 1], [0.4, 0.9], [-0.4, 0.9]],
    color: 0x4a3123, sound: 'shotgun',
  },
  {
    id: 'sniper', name: 'SNIPER RIFLE', slot: 4, auto: false,
    // 110 so a body shot kills an unarmoured target, which is the sniper's whole job.
    damage: 110, speed: 700, cooldown: 1.4, mag: 5, reserve: 25, reload: 2.8,
    spread: 0.0015, pellets: 1, recoil: 0.075, kick: 0.2, zoom: true, zoomFov: 25,
    // The heaviest movement penalty in the game: a sniper that can be run-and-gunned makes
    // every other gun pointless.
    rest: 0.0006, move: 0.030, air: 0.120,
    bloomStep: 0.0200, bloomMax: 0.060, bloomDecay: 0.150,
    pattern: [[0, 1]],
    color: 0x232a24, sound: 'sniper',
  },
  {
    id: 'frag', name: 'FRAG GRENADE', slot: 5, auto: false,
    damage: 0, speed: 0, cooldown: 0.8, mag: 3, reserve: 0, reload: 0,
    spread: 0, pellets: 0, recoil: 0, kick: 0, zoom: false,
    color: 0x3d4a33, sound: 'pistol', thrown: true,
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((weapon) => [weapon.id, weapon]));

/** Aiming tightens the cone; it does not remove the movement or spray penalty. */
export const ADS_SPREAD_MULT = 0.45;
/** Crouching steadies the gun — the cheapest way to convert movement error into accuracy. */
export const CROUCH_SPREAD_MULT = 0.70;

/**
 * The player's absolute firing cone in radians, from the additive model above.
 *
 * Returned as an absolute angle rather than a multiplier on `weapon.spread`, because the
 * whole point is that a settled tap is far tighter than the gun's nominal cone while a
 * sprinting spray is far wider — a single multiplier cannot span both.
 */
export function playerSpread(weapon, { speed = 0, grounded = true, aiming = false, crouching = false, bloom = 0 }) {
  if (!weapon || weapon.rest === undefined) return weapon?.spread ?? 0;
  let cone = weapon.rest + speed * weapon.move + bloom;
  if (!grounded) cone += weapon.air;
  if (crouching) cone *= CROUCH_SPREAD_MULT;
  if (aiming) cone *= ADS_SPREAD_MULT;
  return cone;
}

/** Recoil for shot `index` of a burst, as [yaw, pitch] multiples of `weapon.recoil`. */
export function recoilStep(weapon, index) {
  const pattern = weapon.pattern;
  if (!pattern || !pattern.length) return [0, 1];
  return pattern[Math.min(index, pattern.length - 1)];
}

/** Slots 1-4 are the guns bots may spawn with. */
export const BOT_GUN_IDS = ['pistol', 'ar', 'shotgun', 'sniper'];


/** First-person weapon models, muzzle flash, and viewmodel brass presentation. */
export function createWeaponPresentation({ scene, vmScene, modelLoader }) {
/* ----------------------- first-person models ----------------------- */

const GUN_DARK = matte(0x33383f, 0.5, 0.55);
const GUN_GRIP = matte(0x24272c, 0.85, 0.08);
const GUN_ACC = matte(0x9aa2ab, 0.3, 0.85);

function boxPart(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cylPart(r1, r2, h, x, y, z, mat, axis = 'z') {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, 12), mat);
  m.position.set(x, y, z);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  return m;
}

/** Distinct low-poly viewmodels. -Z is forward; the muzzle marker drives flash + tracers. */
function buildViewModel(id) {
  const g = new THREE.Group();
  const body = matte(WEAPON_BY_ID[id].color, 0.6, 0.4);
  let muzzleZ = -0.4;

  if (id === 'pistol') {
    g.add(boxPart(0.075, 0.10, 0.30, 0, 0, -0.10, body));
    g.add(cylPart(0.022, 0.022, 0.20, 0, 0.012, -0.30, GUN_DARK));
    g.add(boxPart(0.065, 0.19, 0.09, 0, -0.13, 0.02, GUN_GRIP));
    g.add(boxPart(0.045, 0.10, 0.05, 0, -0.09, -0.02, GUN_ACC));   // magwell
    g.add(boxPart(0.012, 0.022, 0.012, 0, 0.062, -0.24, GUN_ACC)); // front sight
    muzzleZ = -0.40;
  } else if (id === 'ar') {
    g.add(boxPart(0.085, 0.11, 0.52, 0, 0, -0.12, body));
    g.add(cylPart(0.019, 0.019, 0.40, 0, 0.015, -0.50, GUN_DARK));
    g.add(cylPart(0.032, 0.032, 0.09, 0, 0.015, -0.70, GUN_ACC));  // flash hider
    g.add(boxPart(0.062, 0.20, 0.10, 0, -0.14, 0.02, GUN_GRIP));
    g.add(boxPart(0.055, 0.22, 0.09, 0, -0.15, -0.20, GUN_ACC));   // curved mag
    g.add(boxPart(0.085, 0.12, 0.26, 0, -0.01, 0.26, GUN_DARK));   // stock
    g.add(boxPart(0.02, 0.05, 0.22, 0, 0.075, -0.10, GUN_ACC));    // rail
    muzzleZ = -0.76;
  } else if (id === 'shotgun') {
    g.add(boxPart(0.10, 0.13, 0.42, 0, 0, -0.08, body));
    g.add(cylPart(0.030, 0.030, 0.62, 0, 0.030, -0.55, GUN_DARK));
    g.add(cylPart(0.026, 0.026, 0.56, 0, -0.022, -0.52, GUN_ACC)); // tube magazine
    g.add(boxPart(0.075, 0.20, 0.11, 0, -0.14, 0.02, GUN_GRIP));
    g.add(boxPart(0.075, 0.09, 0.16, 0, -0.055, -0.40, GUN_GRIP)); // pump
    g.add(boxPart(0.10, 0.15, 0.30, 0, -0.03, 0.26, body));
    muzzleZ = -0.86;
  } else if (id === 'sniper') {
    g.add(boxPart(0.075, 0.10, 0.60, 0, 0, -0.14, body));
    g.add(cylPart(0.016, 0.016, 0.72, 0, 0.010, -0.72, GUN_DARK));
    g.add(cylPart(0.028, 0.028, 0.12, 0, 0.010, -1.06, GUN_ACC));  // muzzle brake
    g.add(cylPart(0.042, 0.042, 0.34, 0, 0.105, -0.24, GUN_DARK)); // scope tube
    g.add(cylPart(0.050, 0.050, 0.05, 0, 0.105, -0.42, GUN_ACC));  // objective bell
    g.add(boxPart(0.018, 0.050, 0.018, 0, 0.062, -0.14, GUN_ACC));
    g.add(boxPart(0.018, 0.050, 0.018, 0, 0.062, -0.34, GUN_ACC));
    g.add(boxPart(0.062, 0.20, 0.10, 0, -0.14, 0.04, GUN_GRIP));
    g.add(boxPart(0.085, 0.16, 0.34, 0, -0.03, 0.32, body));
    g.add(boxPart(0.022, 0.055, 0.10, 0.055, 0.02, 0.08, GUN_ACC)); // bolt handle
    muzzleZ = -1.14;
  } else {                                                          // frag
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 10), matte(0x3d4a33, 0.85, 0.2));
    ball.position.set(0, -0.03, -0.10);
    g.add(ball);
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.TorusGeometry(0.063, 0.006, 6, 18), GUN_DARK);
      b.position.copy(ball.position);
      b.rotation.y = (i * Math.PI) / 3;
      b.rotation.x = Math.PI / 2;
      g.add(b);
    }
    g.add(boxPart(0.014, 0.05, 0.014, 0, 0.045, -0.10, GUN_ACC));  // spoon
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.005, 6, 12), GUN_ACC));
    g.children[g.children.length - 1].position.set(0.03, 0.058, -0.10);
    muzzleZ = -0.16;
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, muzzleZ);
  g.add(muzzle);
  g.userData.muzzle = muzzle;

  // A dead-on rear view of a gun is an unreadable silhouette; a few degrees of yaw and roll
  // give it the three-quarter presentation every shooter uses.
  g.rotation.set(-0.03, 0.09, 0.04);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

/* ------------------------- viewmodel rig ------------------------- */

const vmRig = new THREE.Group();      // sway + recoil + reload dip all stack here
vmScene.add(vmRig);
const vmModels = {};
for (const w of WEAPONS) {
  const m = buildViewModel(w.id);
  m.visible = false;
  vmRig.add(m);
  vmModels[w.id] = m;
}
const VM_HOME = new THREE.Vector3(0.30, -0.25, -0.60);
const VM_ADS = new THREE.Vector3(0.0, -0.085, -0.46);

/* ------------------ Kenney Blaster Kit viewmodels ------------------ */

/**
 * Blaster GLBs used for the four guns, with the length each is fitted to and the Z the muzzle
 * tip is placed at (matched to the procedural models these replace, so recoil, the flash
 * sprite and the tracer origin all keep working unchanged).
 *
 * These four were chosen by measuring every blaster in the kit: all are modelled along Z, and
 * these have an unambiguous barrel end (the Y-extent of the front 18% of the mesh is roughly
 * half that of the back, i.e. a thin barrel against a bulky grip/stock) and their lengths form
 * a sensible pistol -> rifle -> shotgun -> sniper progression.
 */
const BLASTER_FILES = {
  // No pistol entry on purpose: the Kenney blaster reads as a toy ray gun in the one slot the
  // player looks at most, so the pistol keeps a hand-built model (see buildPistolModel).
  ar:      { file: 'blaster-h', len: 0.95, muzzleZ: -0.76 },
  shotgun: { file: 'blaster-p', len: 1.05, muzzleZ: -0.86 },
  sniper:  { file: 'blaster-f', len: 1.35, muzzleZ: -1.14 },
};

/**
 * Hand-built sidearm.
 *
 * This is the model the player stares at for the whole match, and both the original blocky
 * version and the Kenney blaster were wrong for it — one was a stack of grey boxes, the other
 * a toy ray gun. This is a real handgun silhouette: a tapered slide with cut serrations, a
 * dust-cover frame, a raked grip with checkering, a proper trigger guard built from an arc,
 * and three-dot sights. It is ~40 small meshes, which costs nothing in a viewmodel scene that
 * only ever draws one gun.
 */
function buildPistolModel() {
  const g = new THREE.Group();
  const steel = matte(0x2b2f36, 0.38, 0.85);
  const dark = matte(0x1b1e23, 0.55, 0.6);
  const poly = matte(0x24262b, 0.9, 0.05);
  const dot = new THREE.MeshBasicMaterial({ color: 0xf2f6ff });
  const brassMat2 = matte(0xc9a227, 0.35, 0.95);

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };

  // ---- slide: main block, tapered nose, and a raised rib along the top ----
  add(new THREE.BoxGeometry(0.072, 0.078, 0.30), steel, 0, 0.012, -0.10);
  add(new THREE.BoxGeometry(0.066, 0.062, 0.075), steel, 0, 0.008, -0.275);
  add(new THREE.BoxGeometry(0.040, 0.012, 0.28), dark, 0, 0.050, -0.11);
  // Ejection port.
  add(new THREE.BoxGeometry(0.010, 0.040, 0.085), dark, 0.034, 0.020, -0.13);
  // Slide serrations — the detail that makes it read as a pistol rather than a block.
  for (let i = 0; i < 7; i++) {
    add(new THREE.BoxGeometry(0.075, 0.055, 0.006), dark, 0, 0.012, 0.012 - i * 0.017);
  }

  // ---- frame / dust cover under the slide ----
  add(new THREE.BoxGeometry(0.060, 0.036, 0.26), poly, 0, -0.040, -0.12);
  add(new THREE.BoxGeometry(0.030, 0.018, 0.10), dark, 0, -0.056, -0.21);   // accessory rail
  for (let i = 0; i < 3; i++) {
    add(new THREE.BoxGeometry(0.032, 0.006, 0.006), poly, 0, -0.066, -0.17 - i * 0.022);
  }

  // ---- barrel and crown ----
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0155, 0.0155, 0.075, 12), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.008, -0.325);
  g.add(barrel);
  const crown = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.004, 6, 14), steel);
  crown.position.set(0, 0.008, -0.360);
  g.add(crown);

  // ---- grip, raked back the way a real one is, with checkering ----
  const grip = add(new THREE.BoxGeometry(0.058, 0.185, 0.085), poly, 0, -0.135, 0.048, 0.30);
  grip.geometry.translate(0, 0, 0);
  for (let r = 0; r < 5; r++) {
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(0.004, 0.020, 0.058), dark,
        sx * 0.030, -0.100 - r * 0.028, 0.040 + r * 0.0085, 0.30);
    }
  }
  // Magazine baseplate and a hint of brass at the top of the mag well.
  add(new THREE.BoxGeometry(0.062, 0.014, 0.092), dark, 0, -0.228, 0.075, 0.30);
  add(new THREE.BoxGeometry(0.030, 0.010, 0.030), brassMat2, 0, -0.052, 0.020, 0.30);

  // ---- trigger guard: an arc of short segments, so it is a real loop ----
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    add(new THREE.BoxGeometry(0.010, 0.012, 0.012), poly,
      0, -0.075 - Math.sin(a) * 0.042, -0.020 + Math.cos(a) * 0.046, 0, 0, 0);
  }
  add(new THREE.BoxGeometry(0.009, 0.032, 0.010), dark, 0, -0.062, -0.020, 0.18);  // trigger
  add(new THREE.BoxGeometry(0.012, 0.026, 0.014), steel, 0, -0.020, 0.055, 0.30);  // hammer

  // ---- three-dot sights ----
  add(new THREE.BoxGeometry(0.012, 0.016, 0.010), dark, 0, 0.064, -0.245);
  add(new THREE.SphereGeometry(0.0035, 6, 5), dot, 0, 0.068, -0.250);
  add(new THREE.BoxGeometry(0.030, 0.016, 0.012), dark, 0, 0.064, 0.020);
  add(new THREE.SphereGeometry(0.0032, 6, 5), dot, -0.010, 0.068, 0.016);
  add(new THREE.SphereGeometry(0.0032, 6, 5), dot, 0.010, 0.068, 0.016);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.008, -0.40);
  g.add(muzzle);
  g.userData.muzzle = muzzle;

  g.add(buildHand(0.045, -0.155, 0.10, -0.32));
  g.rotation.set(-0.03, 0.09, 0.04);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

const SKIN_MAT = matte(0x9a6b4f, 0.85, 0.0);
const SLEEVE_MAT = matte(0x2f3640, 0.9, 0.05);

/** Forearm + fist, so the blaster reads as held rather than floating. */
function buildHand(x, y, z, pitch) {
  const g = new THREE.Group();
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.30, 10), SLEEVE_MAT);
  upper.rotation.x = Math.PI / 2;
  upper.position.set(0, -0.03, 0.19);
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.043, 0.16, 10), SKIN_MAT);
  lower.rotation.x = Math.PI / 2;
  lower.position.set(0, -0.01, 0.03);
  const fist = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.09), SKIN_MAT);
  fist.position.set(0, 0, -0.04);
  g.add(upper, lower, fist);
  g.position.set(x, y, z);
  g.rotation.x = pitch;
  return g;
}

/**
 * Scale and seat a loaded blaster so it occupies the same space the procedural gun did.
 * Everything is derived from the model's own bounding box rather than hand-tuned numbers,
 * which is what makes it safe to swap a different GLB in later.
 */
function fitBlaster(root, spec) {
  const g = new THREE.Group();
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const s = spec.len / Math.max(size.z, 1e-4);

  root.scale.setScalar(s);
  // Centre on X/Y, then slide along Z so the barrel tip lands exactly on the old muzzle point.
  root.position.set(-centre.x * s, -centre.y * s - 0.02, -centre.z * s);
  const frontZ = (box.min.z - centre.z) * s;          // front tip relative to the new centre
  root.position.z += spec.muzzleZ - frontZ;
  g.add(root);

  g.add(buildHand(0.055, -0.13, spec.muzzleZ * 0.18 + 0.10, -0.25));

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, spec.muzzleZ);
  g.add(muzzle);
  g.userData.muzzle = muzzle;

  g.rotation.set(-0.03, 0.09, 0.04);                  // same three-quarter presentation
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

/** Swap the procedural guns for the Kenney blasters. Any failure leaves the fallback in place. */
async function loadBlasterViewModels() {
  const loaded = [];
  // The sidearm is always the hand-built model, never a kit blaster.
  const pistol = buildPistolModel();
  pistol.visible = false;
  vmRig.remove(vmModels.pistol);
  vmRig.add(pistol);
  vmModels.pistol = pistol;
  loaded.push('pistol(custom)');
  await Promise.all(Object.entries(BLASTER_FILES).map(async ([id, spec]) => {
    try {
      const gltf = await modelLoader.loadAsync(`./assets/models/blaster/${spec.file}.glb`);
      const fitted = fitBlaster(gltf.scene, spec);
      fitted.visible = false;
      vmRig.remove(vmModels[id]);
      vmRig.add(fitted);
      vmModels[id] = fitted;
      loaded.push(id);
    } catch {
      /* keep the procedural viewmodel */
    }
  }));
  return loaded;
}

// Muzzle flash: one light in the viewmodel scene (lights the gun) and one in the world
// (lights the room). Both are pulsed for 0.05 s.
const vmFlash = new THREE.PointLight(0xffb144, 0, 3.2, 2);
vmScene.add(vmFlash);
const worldFlash = new THREE.PointLight(0xffa93a, 0, 14, 2);
scene.add(worldFlash);
const flashSprite = new THREE.Mesh(
  new THREE.SphereGeometry(0.075, 8, 6),
  new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0 }),
);
vmScene.add(flashSprite);   // sibling of vmRig, so it can be placed in viewmodel world space
let flashTimer = 0;

/* --------------------------- brass ejection --------------------------- */

const brass = [];
const brassGeo = new THREE.BoxGeometry(0.016, 0.016, 0.038);
const brassMat = matte(0xd9a441, 0.35, 0.9);

function ejectBrass(from) {
  const m = new THREE.Mesh(brassGeo, brassMat);
  m.position.copy(from);
  vmScene.add(m);
  brass.push({
    mesh: m,
    vel: new THREE.Vector3(rand(1.1, 2.0), rand(1.0, 1.7), rand(-0.4, 0.5)),
    spin: new THREE.Vector3(rand(-12, 12), rand(-12, 12), rand(-12, 12)),
    life: 0.9,
  });
}

function updateBrass(dt) {
  for (let i = brass.length - 1; i >= 0; i--) {
    const b = brass[i];
    b.vel.y -= 9.0 * dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    b.mesh.rotation.x += b.spin.x * dt;
    b.mesh.rotation.y += b.spin.y * dt;
    b.life -= dt;
    if (b.life <= 0) { vmScene.remove(b.mesh); brass.splice(i, 1); }
  }
}

function clearBrass() {
  for (const b of brass) vmScene.remove(b.mesh);
  brass.length = 0;
}

function triggerMuzzleFlash(muzzleLocal, worldPosition) {
  flashTimer = 0.05;
  flashSprite.position.copy(muzzleLocal);
  vmFlash.position.copy(muzzleLocal).add(new THREE.Vector3(0, 0.06, 0.08));
  worldFlash.position.copy(worldPosition);
}

function updateMuzzleFlash(dt) {
  if (flashTimer > 0) {
    flashTimer -= dt;
    const k = clamp(flashTimer / 0.05, 0, 1);
    vmFlash.intensity = 9 * k;
    worldFlash.intensity = 120 * k;
    flashSprite.material.opacity = 0.9 * k;
    flashSprite.scale.setScalar(1 + (1 - k) * 1.4);
  } else {
    vmFlash.intensity = 0;
    worldFlash.intensity = 0;
    flashSprite.material.opacity = 0;
  }
}

return {
  vmRig,
  vmModels,
  homePosition: VM_HOME,
  adsPosition: VM_ADS,
  loadBlasterViewModels,
  ejectBrass,
  updateBrass,
  clearBrass,
  triggerMuzzleFlash,
  updateMuzzleFlash,
};
}
