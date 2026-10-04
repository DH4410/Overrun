import * as THREE from 'three';

import { buildGunModel } from './gunmodels.js';
import { matte } from './rendering.js';
import { clamp, rand } from './utils.js';
import { WEAPONS } from './sim/weaponData.js';

/** The weapon table and accuracy model live in sim/weaponData.js, shared with the server. */
export * from './sim/weaponData.js';

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
  smg: new THREE.Vector3(0.14, -0.15, -0.3),
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
