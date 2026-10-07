import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import { RAY_OPTS, world } from './physics.js';
import { matte } from './rendering.js';
import { rand } from './utils.js';
import { ITEM, ITEMS, TIERS, addItem, canCarry, lootFor, rollDrop } from './sim/items.js';
import { WEAPON_IDS } from './sim/protocol.js';
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

/* ----------------------------- loot models ----------------------------- */

/**
 * Everything on the floor is opaque and self-lit: a transparent or additive glow is a blended
 * pass with no early-z, and eight of them once cost most of a frame (see buildConsumableMesh).
 * Rarity and item kind are read from colour and silhouette instead, plus a thin lit column that
 * shows from across the map.
 */
const hex = (c) => new THREE.Color(c);
const lit = (c, k = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.15, emissive: c, emissiveIntensity: k });

function ringOf(color, r, y) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.016, 6, 24), new THREE.MeshBasicMaterial({ color }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = y;
  return ring;
}

/** The four healing items, each with its own silhouette. */
function buildItemMesh(kind) {
  const it = ITEMS[kind];
  const g = new THREE.Group();
  if (kind === ITEM.BANDAGE) {
    // A roll of gauze with a loose tail and a red stripe.
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.16, 16), matte(0xf2eee6, 0.7, 0.05));
    roll.rotation.z = Math.PI / 2;
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.17, 10), matte(0x6b6358, 0.9, 0));
    hole.rotation.z = Math.PI / 2;
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.153, 0.153, 0.04, 16), lit(0xe5484d, 0.5));
    stripe.rotation.z = Math.PI / 2;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.09), matte(0xf2eee6, 0.7, 0.05));
    tail.position.set(0, -0.14, 0.12);
    tail.rotation.x = 0.35;
    g.add(roll, hole, stripe, tail);
  } else if (kind === ITEM.MEDKIT) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.17), matte(0xeeeeee, 0.5, 0.1));
    const lidLine = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.012, 0.18), matte(0x9aa0a6, 0.5, 0.3));
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.05), matte(0x4a4f55, 0.5, 0.4));
    handle.position.y = 0.165;
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.19, 0.185), lit(it.color, 0.9));
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.07, 0.185), lit(it.color, 0.9));
    g.add(box, lidLine, handle, crossV, crossH);
  } else {
    // A flask: round body, glass neck, cork. The big one is a fat potion, the mini a slim vial.
    const big = kind === ITEM.BIG;
    const r = big ? 0.2 : 0.12;
    const body = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), lit(it.color, big ? 0.85 : 0.7));
    body.scale.y = big ? 1.0 : 1.25;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.38, r * 0.5, r * 0.9, 10), lit(it.color, 0.5));
    neck.position.y = r * (big ? 1.05 : 1.3);
    const cork = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.4, r * 0.34, r * 0.4, 8), matte(0x9a7a4a, 0.8, 0.05));
    cork.position.y = neck.position.y + r * 0.62;
    const core = new THREE.Mesh(new THREE.SphereGeometry(r * 0.5, 10, 8), new THREE.MeshBasicMaterial({ color: hex(it.color).lerp(new THREE.Color(0xffffff), 0.5) }));
    g.add(body, neck, cork, core);
    g.userData.ring = ringOf(it.color, r * 1.6, -r * 0.8);
    g.add(g.userData.ring);
  }
  return g;
}

/** A dropped gun or a few items, with a lit column in its rarity colour. */
function buildDropMesh(type, a, b) {
  const g = new THREE.Group();
  let color;
  if (type === 1) {
    const m = buildItemMesh(a);
    m.scale.setScalar(1.25);
    g.add(m);
    color = ITEMS[a].color;
  } else {
    color = TIERS[b].color;
    const gun = buildBotGun(WEAPON_IDS[a]);
    gun.scale.setScalar(1.3);
    gun.rotation.z = 0.3;
    g.add(gun);
    g.add(ringOf(color, 0.42, -0.1));
  }
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.7, 6), new THREE.MeshBasicMaterial({ color }));
  col.position.y = 0.9;
  g.add(col);
  g.userData.tint = color;
  return g;
}

function dropLabel(type, a, b) {
  if (type === 1) return `+${b} ${ITEMS[a].name}`;
  return `${TIERS[b].name} ${WEAPON_BY_ID[WEAPON_IDS[a]].name}`.trim();
}

/**
 * Single player: a bot's death drops what the server's rollDrop says (src/sim/items.js). A gun is
 * ammo for that gun and, if its tier beats yours, an upgrade; items go in the bag if there is room.
 */
function spawnPickup(pos, weaponId) {
  const drop = rollDrop(Math.max(0, WEAPON_IDS.indexOf(weaponId)), Math.random(), Math.random());
  const mesh = buildDropMesh(drop.type, drop.a, drop.b);
  mesh.position.set(pos.x, 0.75, pos.z);
  scene.add(mesh);
  pickups.push({ mesh, ...drop, life: 40 });
}

function takeDrop(d) {
  if (d.type === 1) return addItem(player, d.a, d.b) > 0;
  const w = WEAPON_BY_ID[WEAPON_IDS[d.a]];
  const a = player.ammo[w.id];
  if (!a) return false;
  const upgrade = d.b > (player.tiers[d.a] ?? 0);
  if (!upgrade && a.mag >= w.mag && a.reserve >= w.reserve * 1.5) return false;
  if (upgrade) player.tiers[d.a] = d.b;
  a.mag = w.mag;
  a.reserve = Math.min(w.reserve * 1.5, a.reserve + Math.ceil(w.mag * 1.5));
  return true;
}

function updatePickups(dt) {
  const t = performance.now() * 0.003;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.life -= dt;
    p.mesh.rotation.y += dt * 1.4;
    p.mesh.position.y = 0.75 + Math.sin(t + i) * 0.09;
    if (p.mesh.userData.ring) p.mesh.userData.ring.rotation.z += dt;

    if (player.alive && p.mesh.position.distanceTo(player.body.position) < 1.6 && takeDrop(p)) {
      Audio.pickup();
      showToast(dropLabel(p.type, p.a, p.b));
      updateAmmoHud();
      scene.remove(p.mesh); pickups.splice(i, 1);
      continue;
    }
    if (p.life <= 0) { scene.remove(p.mesh); pickups.splice(i, 1); }
  }
  // Multiplayer drops are the server's; they only need to turn and bob.
  for (const m of mpDrops.values()) {
    m.mesh.rotation.y += dt * 1.4;
    m.mesh.position.y = m.y + Math.sin(t + m.id) * 0.09;
  }
}

/** Multiplayer: show exactly the drops in the newest snapshot. */
const mpDrops = new Map();
function syncDrops(list) {
  const live = new Set();
  for (const k of list) {
    live.add(k.id);
    if (mpDrops.has(k.id)) continue;
    const mesh = buildDropMesh(k.type, k.a, k.b);
    const y = k.pos.y + 0.45;
    mesh.position.set(k.pos.x, y, k.pos.z);
    scene.add(mesh);
    mpDrops.set(k.id, { id: k.id, mesh, y });
  }
  for (const [id, m] of mpDrops) if (!live.has(id)) { scene.remove(m.mesh); mpDrops.delete(id); }
}

function clearPickups() {
  for (const p of pickups) scene.remove(p.mesh);
  pickups.length = 0;
  for (const m of mpDrops.values()) scene.remove(m.mesh);
  mpDrops.clear();
}

/* ------------------------- ammo chests');
if(i<0||j<0) throw new Error('markers');
t=t.slice(0,i)+blk+t.slice(j);
fs.writeFileSync(p,t);
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

// Seconds to come back. What a spot holds is src/sim/items.js lootFor(kind, index): it is shared with the server.
const CONSUMABLE_KINDS = {
  health: { color: 0x46e07a, respawn: 22 },
  shield: { color: 0x4db4ff, respawn: 30 },
};

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
    const loot = lootFor(kind, consumables.length);
    const mesh = buildItemMesh(loot.item);
    mesh.scale.setScalar(1.2);
    const baseY = _spRes.hitPointWorld.y + 0.5;
    mesh.position.set(x, baseY, z);
    scene.add(mesh);
    const emitter = addLightEmitter({
      x, y: baseY + 0.2, z, color: ITEMS[loot.item].color, intensity: 18, distance: 4.5, priority: 0,
    });
    consumables.push({ kind, spec, loot, index: consumables.length, mesh, baseY, cooldown: 0, phase: rand(0, Math.PI * 2), emitter });
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
    if (c.mesh.userData.ring) c.mesh.userData.ring.rotation.z += dt * 1.6;
    c.emitter.y = c.mesh.position.y + 0.2;

    if (!player.alive || visualOnly) continue;
    const d = c.mesh.position.distanceTo(player.body.position);
    // Only offer what can actually be taken: "walk in to collect" at full health was a promise
    // the pickup then refused.
    const room = canCarry(player, c.loot.item);
    if (d < 2.4 && room) prompt = ITEMS[c.loot.item].name;
    if (d > 1.5) continue;

    if (!room) continue;      // bag already full of these: leave it for later
    addItem(player, c.loot.item, c.loot.qty);
    Audio.pickup();
    showToast(`+${c.loot.qty} ${ITEMS[c.loot.item].name}`);
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
  syncDrops,
  buildItemMesh,
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
