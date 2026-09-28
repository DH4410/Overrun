import * as THREE from 'three';

import { buildGunModel } from './gunmodels.js';
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
export function createWeaponPresentation({ scene, vmScene }) {
/* ------------------------- viewmodel rig ------------------------- */

/**
 * The first-person guns: the procedural models in gunmodels.js, with gloved hands. They used to
 * be the Kenney Blaster Kit — bright orange and green toy blasters — which read as a toy at a
 * glance and, being chunky and fitted by length, rose into the middle of the screen when aiming.
 */
const vmRig = new THREE.Group();      // sway + recoil + reload dip all stack here
vmScene.add(vmRig);
const vmModels = {};
for (const w of WEAPONS) {
  const m = buildGunModel(w.id, { hands: true });
  m.visible = false;
  vmRig.add(m);
  vmModels[w.id] = m;
}

/**
 * Where each gun sits at the hip, in camera space. Real guns are different lengths, so one
 * position cannot frame them all: the rifle's stock has to reach the edge of the screen, the
 * pistol is held out in front.
 */
const VM_HOME = {
  pistol: new THREE.Vector3(0.12, -0.13, -0.3),
  ar: new THREE.Vector3(0.14, -0.155, -0.3),
  shotgun: new THREE.Vector3(0.14, -0.15, -0.3),
  sniper: new THREE.Vector3(0.15, -0.165, -0.36),
  frag: new THREE.Vector3(0.16, -0.14, -0.3),
};

/**
 * Where a gun sits when aimed: its sight line on the camera's axis, `adsEye` in front of the
 * eye. Derived from the model's own sight point, so the red dot or the front post lands exactly
 * on the centre of the screen and the rest of the gun sits below it.
 */
function adsPosition(id, out) {
  const ud = vmModels[id].userData;
  return out.set(-ud.sight.x, -ud.sight.y, -ud.sight.z - ud.adsEye);
}

/** Kept for the boot sequence's asset report; the models are built above, synchronously. */
async function loadViewModels() {
  return Object.keys(vmModels);
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
  homePositions: VM_HOME,
  adsPosition,
  loadViewModels,
  ejectBrass,
  updateBrass,
  clearBrass,
  triggerMuzzleFlash,
  updateMuzzleFlash,
};
}
