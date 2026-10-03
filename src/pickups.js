import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import { CONFIG } from './config.js';
import { RAY_OPTS, world } from './physics.js';
import { matte } from './rendering.js';
import { rand } from './utils.js';
import { WEAPON_BY_ID } from './weapons.js';

/** Dropped weapons, ammo chests, and health/shield consumables. */
export function createPickupRuntime({
  scene,
  camera,
  player,
  Audio,
  buildBotGun,
  currentWeapon,
  inBlocker,
  getSpawnCastY,
  addLightEmitter,
  removeLightEmitter,
  showToast,
  updateAmmoHud,
  updateVitals,
  getHudElements,
}) {
const _spFrom = new CANNON.Vec3();
const _spTo = new CANNON.Vec3();
const _spRes = new CANNON.RaycastResult();

/* --------------------------- weapon pickups --------------------------- */

const pickups = [];

function spawnPickup(pos, weaponId) {
  const w = WEAPON_BY_ID[weaponId];
  const g = new THREE.Group();
  const gun = buildBotGun(weaponId);
  gun.scale.setScalar(1.1);
  gun.rotation.z = 0.35;
  g.add(gun);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 12, 9),
    new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.16, depthWrite: false }),
  );
  g.add(glow);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 2.4, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffb454, transparent: true, opacity: 0.10,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  beam.position.y = 1.0;
  g.add(beam);
  g.position.set(pos.x, 0.75, pos.z);
  scene.add(g);
  pickups.push({ mesh: g, weaponId, life: 25, name: w.name });
}

function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.life -= dt;
    p.mesh.rotation.y += dt * 1.4;
    p.mesh.position.y = 0.75 + Math.sin(performance.now() * 0.003) * 0.09;

    if (player.alive && p.mesh.position.distanceTo(player.body.position) < 1.6) {
      const a = player.ammo[p.weaponId];
      const w = WEAPON_BY_ID[p.weaponId];
      a.reserve = Math.min(w.reserve * 1.5, a.reserve + Math.ceil(w.mag * 1.5));
      if (a.mag === 0) a.mag = w.mag;
      Audio.pickup();
      showToast(`PICKED UP ${w.name}`);
      updateAmmoHud();
      scene.remove(p.mesh); pickups.splice(i, 1);
      continue;
    }
    if (p.life <= 0) { scene.remove(p.mesh); pickups.splice(i, 1); }
  }
}

function clearPickups() {
  for (const p of pickups) scene.remove(p.mesh);
  pickups.length = 0;
}

/* ------------------------- ammo chests ------------------------- */

/**
 * Fixed resupply points, unlike the dropped-weapon pickups above: a chest is never consumed,
 * it just goes dark for AMMO_CHEST_RESPAWN seconds after someone loots it. The pirate kit the
 * task text pointed at is a dead URL, so these are procedural — a banded crate with a glowing
 * seam, which reads clearly against both the warehouse concrete and a dark dungeon.
 */
const ammoChests = [];
const AMMO_CHEST_RESPAWN = 25;
const AMMO_CHEST_RANGE = 1.5;
const AMMO_CHEST_PROMPT = 2.5;

function buildAmmoChest() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.42, 0.44),
    matte(0x6a5326, 0.65, 0.45),
  );
  body.castShadow = true;
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(0.66, 0.12, 0.48),
    matte(0x4a3a1c, 0.6, 0.55),
  );
  lid.position.y = 0.26;
  // Glowing seam — the part that actually catches the eye across a room.
  const seam = new THREE.Mesh(
    new THREE.BoxGeometry(0.68, 0.035, 0.50),
    new THREE.MeshBasicMaterial({ color: 0xffcf5a }),
  );
  seam.position.y = 0.17;
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 12, 9),
    new THREE.MeshBasicMaterial({ color: 0xffcf5a, transparent: true, opacity: 0.12, depthWrite: false }),
  );
  g.add(body, lid, seam, glow);
  return g;
}

function spawnAmmoChests(positions, max = 6) {
  for (const [x, z] of positions) {
    if (ammoChests.length >= max) break;
    if (inBlocker(x, z, 1.2)) continue;              // never bury a chest inside a crate
    _spFrom.set(x, getSpawnCastY(), z);
    _spTo.set(x, -1, z);
    _spRes.reset();
    world.raycastClosest(_spFrom, _spTo, RAY_OPTS, _spRes);
    if (!_spRes.hasHit) continue;
    const mesh = buildAmmoChest();
    const baseY = _spRes.hitPointWorld.y + 0.45;
    mesh.position.set(x, baseY, z);
    scene.add(mesh);
    const emitter = addLightEmitter({
      x, y: baseY + 0.3, z, color: 0xffcf5a, intensity: 26, distance: 5, priority: 0,
    });
    ammoChests.push({ mesh, baseY, cooldown: 0, phase: rand(0, Math.PI * 2), emitter });
  }
}

/** `visualOnly`: multiplayer, where the server owns pickups; only the bob and the light run. */
function updateAmmoChests(dt, visualOnly = false) {
  const t = performance.now() * 0.001;
  let prompt = false;

  for (const c of ammoChests) {
    if (c.cooldown > 0) {
      c.cooldown -= dt;
      if (c.cooldown <= 0) { c.mesh.visible = true; c.emitter.intensity = 26; }
      continue;
    }
    const camDist = c.mesh.position.distanceTo(camera.position);
    c.mesh.visible = camDist < PICKUP_DRAW_DIST;
    if (!c.mesh.visible) continue;
    c.mesh.rotation.y += dt * 0.5;
    c.mesh.position.y = c.baseY + Math.sin(t * (Math.PI * 2 / 1.5) + c.phase) * 0.2;
    c.emitter.intensity = 22 + Math.sin(t * 3 + c.phase) * 7;
    c.emitter.y = c.mesh.position.y + 0.3;

    if (!player.alive || visualOnly) continue;
    const d = c.mesh.position.distanceTo(player.body.position);
    if (d < AMMO_CHEST_PROMPT) prompt = true;
    if (d > AMMO_CHEST_RANGE) continue;

    // Top up the carried weapon: full magazine, plus 30% of that gun's reserve capacity.
    const w = currentWeapon();
    const a = player.ammo[w.id];
    if (a) {
      a.mag = w.mag;
      a.reserve = Math.min(w.reserve * 1.5, a.reserve + Math.ceil(w.reserve * 0.3));
    }
    player.fragCount = Math.min(3, player.fragCount + 1);
    Audio.pickup();
    showToast('AMMO RESUPPLIED');
    updateAmmoHud();
    c.mesh.visible = false;
    c.emitter.intensity = 0;                   // frees its slot for something on screen
    c.cooldown = AMMO_CHEST_RESPAWN;
    prompt = false;
  }

  ammoPromptActive = prompt ? 'AMMO' : null;
}

/** Ammo chests and consumables share one on-screen prompt; whichever is nearer wins. */
let ammoPromptActive = null;

function updatePickupPrompt(consumableLabel) {
  const el = getHudElements();
  if (!el?.ammoPrompt) return;
  const label = consumableLabel || ammoPromptActive;
  el.ammoPrompt.style.opacity = label ? '1' : '0';
  if (label && el.ammoPromptLabel) el.ammoPromptLabel.textContent = label;
}

function resetAmmoChests() {
  for (const c of ammoChests) { c.cooldown = 0; c.mesh.visible = true; c.emitter.intensity = 26; }
}

/* --------------------- health and shield pickups --------------------- */

/**
 * Consumables, on the same lease-a-light / respawn-on-a-timer pattern as the ammo chests.
 *
 * Health is capped at MAX_HEALTH so it can only undo damage, but shield stacks on top of the
 * armour you spawn with, which gives a reason to cross the map for one. Both are picked up by
 * walking over them, and both refuse the pickup when you are already full so you cannot waste
 * a respawn cycle by brushing past.
 */
const consumables = [];

const CONSUMABLE_KINDS = {
  health: {
    label: 'HEALTH', color: 0x46e07a, amount: 35, respawn: 22,
    wanted: (p) => p.health < CONFIG.MAX_HEALTH,
    apply(p) {
      if (!this.wanted(p)) return false;
      p.health = Math.min(CONFIG.MAX_HEALTH, p.health + this.amount);
      return true;
    },
  },
  shield: {
    label: 'SHIELD', color: 0x4db4ff, amount: 40, respawn: 30,
    wanted: (p) => p.armor < CONFIG.MAX_ARMOR,
    apply(p) {
      if (!this.wanted(p)) return false;
      p.armor = Math.min(CONFIG.MAX_ARMOR, p.armor + this.amount);
      return true;
    },
  },
};

/** Potion-ish vial: tinted glass body, glowing core, floating ring. */
function buildConsumableMesh(kind) {
  const spec = CONSUMABLE_KINDS[kind];
  const g = new THREE.Group();
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.21, 0.34, 12),
    // Opaque, not transparent glass. Transparency here meant a blended pass with no early-z
    // for 8 objects, measured at ~3 ms of a 4.9 ms frame at 400x300 — and that scales with
    // resolution, so it is much worse on a real display. A strong emissive reads as "glowing
    // vial" just as well and costs a normal opaque draw.
    new THREE.MeshStandardMaterial({
      color: spec.color, roughness: 0.25, metalness: 0.1,
      emissive: spec.color, emissiveIntensity: 0.7,
    }),
  );
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.09, 0.12, 10),
    matte(0xdad6cc, 0.6, 0.2),
  );
  neck.position.y = 0.22;
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 10, 8),
    new THREE.MeshBasicMaterial({ color: spec.color }),
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.30, 0.018, 6, 22),
    new THREE.MeshBasicMaterial({ color: spec.color }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.16;
  // No additive glow sprite here, deliberately. An earlier version had one and it was
  // catastrophic: 8 pickups took a 400x300 frame from 1.8 ms to 77 ms, because a camera-facing
  // additive sprite is pure overdraw and eight of them covered the screen several times over.
  // The emissive core plus the light this pickup leases carry the same read for nothing.
  g.add(glass, neck, core, ring);
  g.userData.ring = ring;
  return g;
}

/** Pickups past this are not worth drawing; they are dots on screen and pure overdraw. */
const PICKUP_DRAW_DIST = 34;

function spawnConsumables(entries, max = 8) {
  for (const [kind, x, z] of entries) {
    if (consumables.length >= max) break;
    if (inBlocker(x, z, 1.2)) continue;
    _spFrom.set(x, getSpawnCastY(), z);
    _spTo.set(x, -1, z);
    _spRes.reset();
    world.raycastClosest(_spFrom, _spTo, RAY_OPTS, _spRes);
    if (!_spRes.hasHit) continue;
    const spec = CONSUMABLE_KINDS[kind];
    const mesh = buildConsumableMesh(kind);
    const baseY = _spRes.hitPointWorld.y + 0.5;
    mesh.position.set(x, baseY, z);
    scene.add(mesh);
    const emitter = addLightEmitter({
      x, y: baseY + 0.2, z, color: spec.color, intensity: 18, distance: 4.5, priority: 0,
    });
    consumables.push({ kind, spec, mesh, baseY, cooldown: 0, phase: rand(0, Math.PI * 2), emitter });
  }
}

function updateConsumables(dt, visualOnly = false) {
  const t = performance.now() * 0.001;
  let prompt = null;

  for (const c of consumables) {
    if (c.cooldown > 0) {
      c.cooldown -= dt;
      if (c.cooldown <= 0) { c.mesh.visible = true; c.emitter.intensity = 18; }
      continue;
    }
    // Cull by distance before doing any per-frame work on it.
    const camDist = c.mesh.position.distanceTo(camera.position);
    c.mesh.visible = camDist < PICKUP_DRAW_DIST;
    if (!c.mesh.visible) continue;
    c.mesh.rotation.y += dt * 0.9;
    c.mesh.position.y = c.baseY + Math.sin(t * 2.0 + c.phase) * 0.14;
    c.mesh.userData.ring.rotation.z += dt * 1.6;
    c.emitter.y = c.mesh.position.y + 0.2;

    if (!player.alive || visualOnly) continue;
    const d = c.mesh.position.distanceTo(player.body.position);
    // Only offer what can actually be taken: "walk in to collect" at full health was a promise
    // the pickup then refused.
    if (d < 2.4 && c.spec.wanted(player)) prompt = c.spec.label;
    if (d > 1.5) continue;

    if (!c.spec.apply(player)) continue;      // already full — leave it for later
    Audio.pickup();
    showToast(`+${c.spec.amount} ${c.spec.label}`);
    updateVitals();
    c.mesh.visible = false;
    c.emitter.intensity = 0;
    c.cooldown = c.spec.respawn;
    prompt = null;
  }

  return prompt;
}

function resetConsumables() {
  for (const c of consumables) { c.cooldown = 0; c.mesh.visible = true; c.emitter.intensity = 18; }
}

function clearMapPickups() {
  for (const c of ammoChests) { scene.remove(c.mesh); removeLightEmitter(c.emitter); }
  ammoChests.length = 0;
  for (const c of consumables) { scene.remove(c.mesh); removeLightEmitter(c.emitter); }
  consumables.length = 0;
  clearPickups();
}

return {
  ammoChests,
  consumables,
  spawnPickup,
  updatePickups,
  clearPickups,
  spawnAmmoChests,
  updateAmmoChests,
  updatePickupPrompt,
  resetAmmoChests,
  spawnConsumables,
  updateConsumables,
  resetConsumables,
  clearMapPickups,
};
}
