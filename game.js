/**
 * OVERRUN — a bot-deathmatch FPS built on three.js + cannon-es.
 *
 * Architecture notes
 *  - Rendering:  one main scene, plus a separate "viewmodel" scene rendered on top with a
 *                cleared depth buffer. That is what stops the first-person weapon from ever
 *                clipping into geometry, which a shared near-plane hack can only hide.
 *  - Collision:  cannon-es owns every static body (floor, walls, ceiling, props) plus the
 *                player, the bots and the grenades. Bullets are NOT rigid bodies — at
 *                700 m/s a body tunnels through a wall inside one step. Each bullet is
 *                integrated by hand and the segment it swept this tick is tested against
 *                combatants analytically and against the static world with raycastClosest.
 *                Nearest hit wins; that ordering is what prevents shooting through walls.
 *  - Timing:     fixed 120 Hz physics accumulator, max 3 steps per frame.
 *  - Bot AI:     the import map exposes `three-pathfinding`, but it is deliberately NOT
 *                imported: the CDN build bundles its own copy of three@0.164 (a second
 *                1.2 MB download whose classes are not identity-compatible with ours), and
 *                it needs an authored navmesh we do not have. The spec's documented
 *                fallback — a hand-placed waypoint graph with breadth-first search — is
 *                used instead. See === BOTS ===.
 *  - Props:      loaded from the Kenney Factory Kit GLBs in assets/models/. Every prop has
 *                a procedural fallback, so a missing file degrades one crate rather than
 *                blanking the arena.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Skinned meshes cannot be deep-copied with Object3D.clone(): every clone would share one
// skeleton and they would all animate as a single puppet. SkeletonUtils rebinds the bones.
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { createAudio } from './src/audio.js';
import { createEffects } from './src/effects.js';
import { createHud } from './src/hud.js';
import { createMapController, createMapRuntime } from './src/maps.js';
import {
  G_BODY,
  G_NADE,
  MAT_BODY,
  MAT_NADE,
  RAY_OPTS,
  addStaticBox,
  addStaticCylinder,
  mapBodies,
  world,
} from './src/physics.js';
import { disposeTree, markShared, matte } from './src/rendering.js';
import { createUiRuntime } from './src/ui.js';
import {
  ADS_FOV,
  CONFIG,
  DAMP_PER_STEP,
  FIXED_DT,
  HIP_FOV,
  PLAYER_DAMPING,
  SPAWN_INVULN,
  TEAM,
  TEAM_COLOR,
} from './src/config.js';
import {
  QUALITY,
  loadSettings,
  saveSettings,
  settings,
} from './src/settings.js';
import { clamp, lerp, pick, rand, randInt } from './src/utils.js';

/* ================================================================== *
 * === CONFIG ===
 * ================================================================== */

/**
 * Height the ground-finding raycasts in spawnAmmoChests / spawnConsumables start from.
 *
 * These cast straight down with raycastClosest and place the item on the first thing they
 * hit. That only finds the floor if the ray starts *below* the map's roof. The dungeon has a
 * full-map lid collider spanning y=4.15..5.15 (see buildDungeonMap), so a ray starting at the
 * warehouse's CONFIG.CEIL-0.5 = 9.5 hit the lid instead and every chest and consumable was
 * placed on top of the roof — visible from inside the level whenever you jumped.
 *
 * buildMap() sets this per level from MAPS[id].ceilY.
 */
let spawnCastY = CONFIG.CEIL - 0.5;

/* ---------------------------- weapons ---------------------------- */

const WEAPONS = [
  {
    id: 'pistol', name: 'PISTOL', slot: 1, auto: false,
    damage: 12, speed: 400, cooldown: 0.22, mag: 15, reserve: 90, reload: 1.2,
    spread: 0.006, pellets: 1, recoil: 0.017, kick: 0.05, zoom: false,
    color: 0x2b3038, sound: 'pistol',
  },
  {
    id: 'ar', name: 'ASSAULT RIFLE', slot: 2, auto: true,
    damage: 18, speed: 380, cooldown: 0.09, mag: 30, reserve: 180, reload: 2.0,
    spread: 0.025, pellets: 1, recoil: 0.014, kick: 0.045, zoom: false,
    color: 0x33372f, sound: 'ar',
  },
  {
    id: 'shotgun', name: 'SHOTGUN', slot: 3, auto: false,
    damage: 10, speed: 280, cooldown: 0.9, mag: 8, reserve: 40, reload: 2.5,
    spread: 0.08, pellets: 8, recoil: 0.06, kick: 0.16, zoom: false,
    color: 0x4a3123, sound: 'shotgun',
  },
  {
    id: 'sniper', name: 'SNIPER RIFLE', slot: 4, auto: false,
    damage: 95, speed: 700, cooldown: 1.4, mag: 5, reserve: 25, reload: 2.8,
    spread: 0.0015, pellets: 1, recoil: 0.075, kick: 0.2, zoom: true, zoomFov: 25,
    color: 0x232a24, sound: 'sniper',
  },
  {
    id: 'frag', name: 'FRAG GRENADE', slot: 5, auto: false,
    damage: 0, speed: 0, cooldown: 0.8, mag: 3, reserve: 0, reload: 0,
    spread: 0, pellets: 0, recoil: 0, kick: 0, zoom: false,
    color: 0x3d4a33, sound: 'pistol', thrown: true,
  },
];
const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
/** Slots 1-4 are the guns bots may spawn with. */
const BOT_GUN_IDS = ['pistol', 'ar', 'shotgun', 'sniper'];

/**
 * Bot aim error, in radians. These were tuned against a measured duel rather than guessed:
 * a single bot with a fixed AR, a verified clear lane, and a fixed range, counting hits per
 * round fired. Before tuning, a medium bot hit a stationary target 89% of the time at 15 m and
 * a hard bot 99.6% — which is exactly the "they never miss" complaint.
 *
 * Targets, per bullet at 15 m against a stationary player: easy ~15%, medium ~30%, hard ~50%.
 * Those look low written down, but a burst is many rounds and bots fight in groups.
 */
const AIM = {
  // A fixed angular error already gets harder to land as range grows, so the range term is
  // deliberately small — the first tuning pass double-counted it and bots became useless past
  // 30 m (2.8% per round at 35 m). The floor is what stops a hard bot being a hitscan laser.
  floor: 0.030,      // even a perfect bot is not a laser
  base: 0.15,        // scaled by (1 - skill)
  range: 0.06,       // per unit of (distance / 100), scaled by (1 - skill)
  tracking: 0.020,   // per m/s of target lateral speed
  snap: 0.12,        // penalty immediately after acquiring, decays as aim settles
};

/** The range each bot weapon wants to fight at. Inside min it backs off, beyond max it closes. */
const BOT_RANGE_BAND = {
  pistol:  { min: 5,  max: 16 },
  ar:      { min: 8,  max: 26 },
  shotgun: { min: 3,  max: 9  },
  sniper:  { min: 18, max: 50 },
};

const DIFFICULTY = {
  easy:   { label: 'EASY',   accuracy: 0.40, reaction: 0.80, bots: 3, aggression: 0.55, fireMult: 1.35, speed: 0.85 },
  medium: { label: 'MEDIUM', accuracy: 0.65, reaction: 0.50, bots: 4, aggression: 0.75, fireMult: 1.10, speed: 1.0 },
  hard:   { label: 'HARD',   accuracy: 0.85, reaction: 0.20, bots: 5, aggression: 0.95, fireMult: 1.0, speed: 1.18 },
};

const BOT_NAMES = [
  'VIPER', 'HAVOC', 'RAZOR', 'GHOST', 'TALON', 'ONYX', 'BRAVO', 'CIPHER',
  'DELTA', 'KILO', 'NOMAD', 'REAPER', 'SABLE', 'VECTOR', 'WRAITH', 'ZERO',
];

/* ================================================================== *
 * === AUDIO ===
 * ================================================================== */

const Audio = createAudio({
  getCamera: () => camera,
  getPlayer: () => player,
});


/* ================================================================== *
 * === PHYSICS ===
 * ================================================================== */


/* ================================================================== *
 * Renderer, scenes, cameras
 * ================================================================== */

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.autoClear = false;                       // we drive clears manually (3 passes/frame)
document.body.appendChild(renderer.domElement);

const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

/**
 * Render layers. 0 is the world the player sees; 1 is ceiling geometry, which only the main
 * camera enables. 2 and 3 belong to the minimap: 3 is a flat floor-plan of unlit plates and
 * 2 is the blips drawn over it. Rendering the real 3D scene from above was tried first and
 * is unreadable — from 50 m up you see the tops of pillars and catwalks, not a map.
 */
const L_WORLD = 0, L_CEIL = 1, L_BLIP = 2, L_MAP = 3;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e14);
scene.fog = new THREE.Fog(0x0a0e14, 55, 190);

const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.08, 500);
camera.layers.set(L_WORLD);
camera.layers.enable(L_CEIL);   // the player sees the roof; the minimap camera must not

// Viewmodel pass — its own scene/camera so the gun can never intersect the level.
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.01, 12);
vmScene.add(new THREE.AmbientLight(0x8fa6bd, 1.5));
const vmKey = new THREE.DirectionalLight(0xfff0dd, 2.4);
vmKey.position.set(1.6, 2.0, 1.2);
vmScene.add(vmKey);
const vmRim = new THREE.DirectionalLight(0x9fc4ff, 1.2);
vmRim.position.set(-1.4, 0.4, -1.0);
vmScene.add(vmRim);

// Top-down minimap camera.
const MAP_VIEW = 46;                              // metres visible across the minimap
const mapCamera = new THREE.OrthographicCamera(-MAP_VIEW / 2, MAP_VIEW / 2, MAP_VIEW / 2, -MAP_VIEW / 2, 1, 120);
mapCamera.up.set(0, 0, -1);
mapCamera.layers.set(L_MAP);
mapCamera.layers.enable(L_BLIP);

addEventListener('resize', () => resizeRenderer());

/* ================================================================== *
 * === LIGHTING RIG ===
 * ================================================================== */

/**
 * A fixed lighting budget for the entire game, created once and never added to or removed
 * from the scene.
 *
 * This is not a micro-optimisation, it is the fix for the single worst bug in the game.
 * three.js keys its shader programs on the scene's light counts, so adding or removing ANY
 * light invalidates every material and forces a full recompile. Measured here: adding one
 * PointLight cost 356 ms on the next frame against a 47 ms steady state, and compiled seven
 * new programs — and removing it compiled more. Every grenade did that twice, which is the
 * multi-second freeze on firing. Switching maps did it another dozen times.
 *
 * So: the ambient/hemisphere/sun rig exists once and maps only re-tint it, and every point
 * light in the game leases one of a fixed pool of slots. Nothing is ever added or removed at
 * runtime, so the program cache stays warm and the count never changes.
 */
const MAX_POINT_LIGHTS = 12;

/** Soft radial falloff, shared by every glow sprite (torches, chests, pickups). */
const glowTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

const rigAmbient = new THREE.AmbientLight(0x8ea6c0, 0.4);
const rigHemi = new THREE.HemisphereLight(0x7f9bb8, 0x232830, 0.75);
const rigSun = new THREE.DirectionalLight(0xfff1dc, 1.7);
rigSun.castShadow = true;
rigSun.shadow.mapSize.set(2048, 2048);
rigSun.shadow.camera.near = 10;
rigSun.shadow.camera.far = 170;
rigSun.shadow.bias = -0.0006;
rigSun.shadow.normalBias = 0.035;      // kills the banding on the big flat walls
scene.add(rigAmbient, rigHemi, rigSun, rigSun.target);

/** The pool. Slot 0..n are ordinary point lights; intensity 0 means "free". */
const lightSlots = [];
for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
  const l = new THREE.PointLight(0xffffff, 0, 10, 2);
  l.castShadow = false;                // shadow-casting point lights are a frame-rate trap
  scene.add(l);
  lightSlots.push(l);
}

/**
 * Things in the world that would like to be a light: torches, ceiling lamps, ammo chests,
 * explosions. There are usually more of these than there are slots, so every frame the
 * nearest few to the camera win. A torch two rooms away contributes nothing on screen but
 * costs every fragment shader the same as one at your feet.
 */
const lightEmitters = [];
let activeLightBudget = MAX_POINT_LIGHTS;

function addLightEmitter(e) {
  // { x, y, z, color, intensity, distance, priority, flicker }
  e.priority = e.priority ?? 0;
  lightEmitters.push(e);
  return e;
}

function removeLightEmitter(e) {
  const i = lightEmitters.indexOf(e);
  if (i >= 0) lightEmitters.splice(i, 1);
}

const _lightSort = [];

/** Assign the best emitters to the pool. Called every frame; cheap for a few dozen emitters. */
function updateLights() {
  _lightSort.length = 0;
  for (const e of lightEmitters) {
    if (e.intensity <= 0) continue;
    const dx = e.x - camera.position.x, dy = e.y - camera.position.y, dz = e.z - camera.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    // Anything outside its own falloff radius cannot contribute; skip it entirely.
    if (d2 > (e.distance + 6) * (e.distance + 6)) continue;
    _lightSort.push({ e, score: d2 - e.priority * 10000 });
  }
  _lightSort.sort((a, b) => a.score - b.score);

  const n = Math.min(activeLightBudget, _lightSort.length, lightSlots.length);
  for (let i = 0; i < n; i++) {
    const e = _lightSort[i].e;
    const l = lightSlots[i];
    l.position.set(e.x, e.y, e.z);
    l.color.setHex(e.color);
    l.intensity = e.intensity;
    l.distance = e.distance;
  }
  for (let i = n; i < lightSlots.length; i++) lightSlots[i].intensity = 0;
}

/* ================================================================== *
 * === MAP ===
 * ================================================================== */

const {
  arenaExtent: A,
  PROP_FILES,
  loadProp,
  mapGroup,
  blockers,
  inBlocker,
  spawnPoints,
  sniperPerches,
  updateDungeonFx,
  waypoints,
  mapLights,
  clearMap,
  findPath,
  buildArena,
  placeArenaProps,
  buildSpawnPoints,
  buildDungeonMap,
  buildWaypoints,
  buildMapLayer,
} = createMapRuntime({
  scene,
  maxAnisotropy: MAX_ANISO,
  ceilingLayer: L_CEIL,
  mapLayer: L_MAP,
  glowTexture,
  addLightEmitter,
  lightEmitters,
  lightSlots,
  spawnAmmoChests: (...args) => spawnAmmoChests(...args),
  spawnConsumables: (...args) => spawnConsumables(...args),
  clearMapItems: () => {
    for (const c of ammoChests) { scene.remove(c.mesh); removeLightEmitter(c.emitter); }
    ammoChests.length = 0;
    for (const c of consumables) { scene.remove(c.mesh); removeLightEmitter(c.emitter); }
    consumables.length = 0;
    clearPickups();
  },
});

const {
  MAPS,
  buildMap,
  switchMap,
  currentMapId: getCurrentMapId,
} = createMapController({
  scene,
  mapCamera,
  rigAmbient,
  rigHemi,
  rigSun,
  arenaExtent: A,
  buildArena,
  placeArenaProps,
  buildSpawnPoints,
  buildDungeonMap,
  buildWaypoints,
  buildMapLayer,
  clearMap,
  spawnAmmoChests: (...args) => spawnAmmoChests(...args),
  spawnConsumables: (...args) => spawnConsumables(...args),
  setSpawnCastY: (value) => { spawnCastY = value; },
});


/* ================================================================== *
 * === WEAPONS ===
 * ================================================================== */

/** Everything that can be shot: the player and every bot, in one list. */
const combatants = [];

/* ------------- analytic segment tests (shared scratch) ------------- */

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m = new THREE.Vector3();
const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();

/** Distance along the segment to the sphere, or -1. */
function segmentSphere(o, d, len, center, r) {
  _m.subVectors(o, center);
  const b = _m.dot(d);
  const c = _m.dot(_m) - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= len ? t : -1;
}

/** Y-axis finite cylinder: solve the infinite cylinder in XZ, then clamp to the height slab. */
function segmentCylinderY(o, d, len, cx, cy, cz, r, halfH) {
  const mx = o.x - cx, mz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  const b = 2 * (mx * d.x + mz * d.z);
  const c = mx * mx + mz * mz - r * r;
  let t;
  if (a < 1e-8) {
    if (c > 0) return -1;
    t = 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) t = (-b + Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > len) return -1;
  }
  const y = o.y + d.y * t;
  if (y < cy - halfH || y > cy + halfH) {
    if (Math.abs(d.y) < 1e-8) return -1;
    const capY = d.y > 0 ? cy - halfH : cy + halfH;
    const tc = (capY - o.y) / d.y;
    if (tc < 0 || tc > len) return -1;
    const px = o.x + d.x * tc - cx, pz = o.z + d.z * tc - cz;
    return (px * px + pz * pz <= r * r) ? tc : -1;
  }
  return t;
}

/**
 * Hitboxes are per-combatant, not global: the player's eye sits 1.6 m above a body origin
 * that rests half a metre up, while a bot mesh is a different height entirely. Sharing one
 * constant would float the bots' head boxes well above their visible heads.
 * Offsets are relative to `pos`, which is the chest.
 */
const HB_PLAYER = { bodyR: 0.42, bodyHalfH: 0.58, headR: 0.27, headY: 0.78 };
// Crouching profile: PLAYER_CHEST_CROUCH lowers pos so head sits near eye level (1.35 m).
const HB_PLAYER_CROUCH = { bodyR: 0.42, bodyHalfH: 0.38, headR: 0.27, headY: 0.45 };
// Scaled in lockstep with BOT_TARGET_HEIGHT. If these drift apart, bots either soak shots
// that visually connected or die to shots that visually missed.
const HB_BOT = { bodyR: 0.38, bodyHalfH: 0.45, headR: 0.22, headY: 0.62 };

/** Nearest combatant the segment hits, honouring team and self filters. */
/**
 * Locational damage. Three nested volumes per combatant, tested nearest-first:
 *  - a head sphere,
 *  - the torso cylinder,
 *  - a wider, shorter cylinder standing in for arms and legs.
 * A limb hit is a graze that should not kill as fast as a centre-mass hit, which is what
 * makes aim actually matter rather than every pixel of a silhouette being equal.
 */
const ZONE_MULT = { head: 2.4, body: 1.0, limb: 0.6 };

function nearestCombatantHit(o, d, len, shooter) {
  let best = null, bestT = Infinity, bestZone = 'body';
  for (const c of combatants) {
    if (!c.alive || c === shooter) continue;
    if (shooter && shooter.team !== TEAM.SOLO && c.team === shooter.team) continue;
    const p = c.pos, hb = c.hb;
    const th = segmentSphere(o, d, len, _v1.set(p.x, p.y + hb.headY, p.z), hb.headR);
    const tb = segmentCylinderY(o, d, len, p.x, p.y, p.z, hb.bodyR, hb.bodyHalfH);
    // Centred lower and made taller than the torso so legs are genuinely hittable — the
    // previous limb volume stopped at roughly hip height.
    const tl = segmentCylinderY(o, d, len, p.x, p.y - 0.25, p.z, hb.bodyR * 1.6, hb.bodyHalfH * 1.6);
    let t = -1, zone = 'body';
    // Nearest wins, and ties resolve toward the more specific volume.
    if (th >= 0) { t = th; zone = 'head'; }
    if (tb >= 0 && (t < 0 || tb < t)) { t = tb; zone = 'body'; }
    if (tl >= 0 && (t < 0 || tl < t - 1e-4)) { t = tl; zone = 'limb'; }
    if (t >= 0 && t < bestT) { bestT = t; best = c; bestZone = zone; }
  }
  return best ? { target: best, t: bestT, zone: bestZone, head: bestZone === 'head' } : null;
}

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
      const gltf = await gltfLoader.loadAsync(`./assets/models/blaster/${spec.file}.glb`);
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

/* ------------------------------ bullets ------------------------------ */

const bullets = [];
const tracerGeo = new THREE.SphereGeometry(1, 6, 4);
const tracerMats = {
  player: new THREE.MeshBasicMaterial({ color: 0xfff0b0 }),
  enemy: new THREE.MeshBasicMaterial({ color: 0xff9a6a }),
  ally: new THREE.MeshBasicMaterial({ color: 0x8fd0ff }),
};
const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _fwdZ = new THREE.Vector3(0, 0, 1);

function spawnBullet(origin, direction, weapon, owner, damage) {
  const kind = owner === player ? 'player' : (owner.team !== TEAM.SOLO && owner.team === player.team ? 'ally' : 'enemy');
  const mesh = new THREE.Mesh(tracerGeo, tracerMats[kind]);
  mesh.frustumCulled = false;
  scene.add(mesh);
  bullets.push({
    pos: origin.clone(), prev: origin.clone(),
    vel: direction.clone().multiplyScalar(weapon.speed),
    travelled: 0, damage, owner, weapon, mesh,
  });
}

function despawnBullet(i) {
  scene.remove(bullets[i].mesh);
  bullets.splice(i, 1);
}
function clearBullets() {
  for (const b of bullets) scene.remove(b.mesh);
  bullets.length = 0;
}

/**
 * One fixed step for every bullet. Gravity is integrated explicitly, then the segment swept
 * this tick is tested against combatants (analytic) and the static world (raycastClosest).
 * The nearer result wins — that ordering is the whole reason bullets cannot pass through walls.
 */
function stepBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.prev.copy(b.pos);
    b.vel.y += CONFIG.GRAVITY * dt;
    _step.copy(b.vel).multiplyScalar(dt);
    b.pos.add(_step);

    const len = _step.length();
    if (len < 1e-6) continue;
    _dir.copy(_step).divideScalar(len);

    const cHit = nearestCombatantHit(b.prev, _dir, len, b.owner);

    _rayFrom.set(b.prev.x, b.prev.y, b.prev.z);
    _rayTo.set(b.pos.x, b.pos.y, b.pos.z);
    _rayResult.reset();
    world.raycastClosest(_rayFrom, _rayTo, RAY_OPTS, _rayResult);
    const wallT = _rayResult.hasHit ? _rayResult.distance : Infinity;

    if (cHit && cHit.t <= wallT) {
      _hitPoint.copy(b.prev).addScaledVector(_dir, cHit.t);
      const dmg = b.damage * ZONE_MULT[cHit.zone];
      spawnBlood(_hitPoint);
      applyDamage(cHit.target, dmg, b.owner, _hitPoint, cHit.head, cHit.zone);
      despawnBullet(i);
      continue;
    }
    if (_rayResult.hasHit) {
      _hitPoint.set(_rayResult.hitPointWorld.x, _rayResult.hitPointWorld.y, _rayResult.hitPointWorld.z);
      _hitNormal.set(_rayResult.hitNormalWorld.x, _rayResult.hitNormalWorld.y, _rayResult.hitNormalWorld.z);
      spawnDecal(_hitPoint, _hitNormal);
      spawnSparks(_hitPoint, _hitNormal);
      despawnBullet(i);
      continue;
    }

    b.travelled += len;
    if (b.travelled > CONFIG.MAX_RANGE) { despawnBullet(i); continue; }

    // A 700 m/s point never renders twice in the same place, so stretch it into a streak
    // covering the ground it just crossed.
    const streak = Math.min(len, CONFIG.TRACER_MAX_LEN);
    _mid.copy(b.pos).addScaledVector(_dir, -streak / 2);
    b.mesh.position.copy(_mid);
    b.mesh.quaternion.setFromUnitVectors(_fwdZ, _dir);
    b.mesh.scale.set(CONFIG.TRACER_RADIUS, CONFIG.TRACER_RADIUS, streak / 2);
  }
}

/** Fire one weapon. `dirBase` is a unit vector; spread is applied per pellet. */
/**
 * `_fireDir` is a scratch vector of its own on purpose. Callers legitimately pass one of the
 * shared scratch vectors as `dirBase` (the bots aim in `_v2`), and reusing that same vector
 * here would make `copy(dirBase)` a no-op — every pellet would then inherit the previous
 * pellet's deviation and a shotgun would fire a compounding random walk instead of a cone.
 */
const _fireDir = new THREE.Vector3();

function fireWeapon(shooter, weapon, origin, dirBase, spreadMult = 1) {
  const spread = weapon.spread * spreadMult;
  for (let p = 0; p < weapon.pellets; p++) {
    _fireDir.copy(dirBase);
    if (spread > 0) {
      _fireDir.x += rand(-spread, spread);
      _fireDir.y += rand(-spread, spread);
      _fireDir.z += rand(-spread, spread);
      _fireDir.normalize();
    }
    spawnBullet(origin, _fireDir, weapon, shooter, weapon.damage);
  }
  // The player's own gun stays centred; everyone else's is placed in the stereo field so you
  // can tell which side you are being shot from before you see anyone.
  if (shooter === player) {
    Audio.gunshot(weapon.sound, 0, 0);
  } else {
    const sp = Audio.spatial(origin);
    Audio.gunshot(weapon.sound, sp.dist, sp.pan);
  }
  alertBots(origin, shooter);
}

/* ----------------------------- grenades ----------------------------- */

const grenades = [];
const fragGeo = new THREE.SphereGeometry(0.075, 12, 9);
const fragMat = matte(0x39452f, 0.85, 0.2);
const smokeCanGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.17, 10);
const smokeCanMat = matte(0xb8c4cf, 0.5, 0.6);

function throwGrenade(owner, origin, dir, power, kind, fuseLeft) {
  const body = new CANNON.Body({
    mass: 0.4, material: MAT_NADE,
    shape: new CANNON.Sphere(0.06),
    linearDamping: 0.02, angularDamping: 0.15,
    collisionFilterGroup: G_NADE,
  });
  body.position.set(origin.x, origin.y, origin.z);
  body.velocity.set(dir.x * power, dir.y * power + 1.6, dir.z * power);
  body.angularVelocity.set(rand(-9, 9), rand(-9, 9), rand(-9, 9));
  world.addBody(body);

  const mesh = new THREE.Mesh(
    kind === 'smoke' ? smokeCanGeo : fragGeo,
    kind === 'smoke' ? smokeCanMat : fragMat,
  );
  mesh.castShadow = true;
  scene.add(mesh);

  const g = { body, mesh, fuse: fuseLeft, owner, kind, bounceCd: 0 };
  grenades.push(g);
  body.addEventListener('collide', () => {
    if (g.bounceCd > 0) return;
    g.bounceCd = 0.12;
    const speed = body.velocity.length();
    if (speed > 1.4) Audio.bounce(mesh.position.distanceTo(camera.position));
  });
  return g;
}

function clearGrenades() {
  for (const g of grenades) { world.removeBody(g.body); scene.remove(g.mesh); }
  grenades.length = 0;
}

/** Radial damage with linear falloff, plus a 1/d^2 impulse on every dynamic body nearby. */
function explode(pos, owner) {
  spawnExplosion(pos);
  Audio.explosion(pos.distanceTo(camera.position));

  for (const c of combatants) {
    if (!c.alive) continue;
    // Skip teammates (but allow self-damage). Bullet code uses the same pattern.
    if (owner && c !== owner && owner.team !== TEAM.SOLO && c.team === owner.team) continue;
    _v1.set(c.pos.x, c.pos.y, c.pos.z);
    const d = _v1.distanceTo(pos);
    if (d > CONFIG.FRAG_RADIUS) continue;
    // Cover matters: no line of sight to the blast means no damage.
    if (!losClear(pos.x, pos.y, pos.z, c.pos.x, c.pos.y, c.pos.z)) continue;
    const dmg = CONFIG.FRAG_DAMAGE * (1 - d / CONFIG.FRAG_RADIUS);
    if (dmg > 1) applyDamage(c, dmg, owner, _v1, false);
  }

  for (const body of world.bodies) {
    if (body.mass <= 0) continue;
    _v2.set(body.position.x - pos.x, body.position.y - pos.y, body.position.z - pos.z);
    const d = _v2.length();
    if (d > CONFIG.FRAG_RADIUS * 1.6 || d < 1e-3) continue;
    _v2.divideScalar(d);
    const mag = CONFIG.FRAG_IMPULSE / (d * d + 1);
    body.applyImpulse(new CANNON.Vec3(_v2.x * mag, (_v2.y + 0.45) * mag, _v2.z * mag));
  }

  const camDist = pos.distanceTo(camera.position);
  if (camDist < 10) addShake(0.10 * (1 - camDist / 10));
}

/* ================================================================== *
 * === PLAYER ===
 * ================================================================== */

const keys = Object.create(null);
let mouseDX = 0, mouseDY = 0;
let firing = false, aiming = false;
let pointerLocked = false;

const player = {
  isPlayer: true,
  name: 'PLAYER',
  team: TEAM.SOLO,
  alive: true,
  health: CONFIG.MAX_HEALTH,
  armor: CONFIG.START_ARMOR,
  kills: 0, deaths: 0,
  hb: HB_PLAYER,
  pos: new THREE.Vector3(),          // chest — hitbox centre and what bots aim at
  eye: new THREE.Vector3(),          // muzzle / line-of-sight origin
  vel: new THREE.Vector3(),          // world velocity, so bots can lead their shots
  body: null,
  yaw: 0, pitch: 0,
  recoilPitch: 0, recoilYaw: 0,
  grounded: false, crouching: false, sprinting: false,
  current: 'pistol',
  ammo: {},
  cooldown: 0, reloading: 0, reloadTotal: 0,
  fragCount: 3, smokeCount: 1,
  cooking: null, cookTime: 0,
  respawnTimer: 0,
  invulnTimer: 0,                    // spawn protection — see SPAWN_INVULN
  stepTimer: 0,
  sway: new THREE.Vector2(),
};
combatants.push(player);

const PLAYER_CHEST = 0.75;
const PLAYER_CHEST_CROUCH = 0.52;  // lowers bots' aim point to match crouching camera height
const PLAYER_EYE_OFF = CONFIG.EYE_HEIGHT;

function createPlayerBody() {
  const b = new CANNON.Body({
    mass: CONFIG.PLAYER_MASS,
    material: MAT_BODY,
    shape: new CANNON.Sphere(CONFIG.PLAYER_RADIUS),
    linearDamping: PLAYER_DAMPING,
    angularDamping: 1,
    fixedRotation: true,
    collisionFilterGroup: G_BODY,
  });
  b.updateMassProperties();
  world.addBody(b);
  player.body = b;
}

function resetPlayerAmmo() {
  player.ammo = {};
  for (const w of WEAPONS) {
    if (w.thrown) continue;
    player.ammo[w.id] = { mag: w.mag, reserve: w.reserve };
  }
  player.fragCount = 3;
  player.smokeCount = 1;                 // one smoke per life — reset here, on every respawn
}

/* ------------------------- shared damage path ------------------------- */

/**
 * Route damage through armour, then health. Handles kill bookkeeping for whoever fired.
 * Used by bullets and by explosions, for the player and for bots alike.
 */
function applyDamage(target, amount, source, hitPos, headshot, zone = 'body') {
  if (!target.alive || !match.running) return;
  // Spawn protection. Gated here as well as in Bot.canSee, because bullets already in flight
  // and grenades already thrown do not go back through target acquisition.
  if (target.invulnTimer > 0) return;

  let dmg = amount;
  let soaked = 0;
  if (target.armor > 0) {
    const soak = Math.min(target.armor, dmg * CONFIG.ARMOR_ABSORB);
    target.armor -= soak;
    dmg -= soak;
    soaked = soak;
  }
  target.health -= dmg;

  if (target === player) {
    Audio.hurt();
    if (source && source !== player) showDamageDirection(source.pos);
    addShake(0.035);
  } else {
    if (source === player) {
      showHitMarker(false);
      Audio.hit();
      // zone was being dropped here, so every number rendered with the plain body style and a
      // headshot looked exactly like a graze. soaked tells the player *why* a centre-mass hit
      // landed for single digits — armour ate the rest — instead of it reading as a weak gun.
      showDamageNumber(hitPos || target.pos, dmg, headshot, zone, soaked > 0.5);
    }
    target.lastHurtBy = source;
    target.lastHurtAt = match.time;
  }

  if (target.health <= 0) {
    target.health = 0;
    killCombatant(target, source, headshot);
    if (source === player) { showHitMarker(true); Audio.kill(); }
  }
}

/* ----------------------------- movement ----------------------------- */

const _up = new CANNON.Vec3(0, 1, 0);
const _cn = new CANNON.Vec3();
const _wish = new THREE.Vector3();
let crouchLatch = false, sprintLatch = false;

function playerGroundCheck() {
  player.grounded = false;
  const b = player.body;
  for (const c of world.contacts) {
    if (c.bi === b) c.ni.negate(_cn);
    else if (c.bj === b) _cn.copy(c.ni);
    else continue;
    if (_cn.dot(_up) > 0.5) { player.grounded = true; return; }
  }
}

const _crouchFrom = new CANNON.Vec3();
const _crouchTo = new CANNON.Vec3();
const _crouchRes = new CANNON.RaycastResult();

function setCrouch(on) {
  if (player.crouching === on) return;

  if (!on) {
    // Overhead clearance: reject standup if there is geometry within the radius delta above us.
    const clearNeeded = CONFIG.PLAYER_RADIUS - CONFIG.CROUCH_RADIUS;  // 0.12 m
    _crouchFrom.set(player.body.position.x, player.body.position.y + CONFIG.CROUCH_RADIUS, player.body.position.z);
    _crouchTo.set(player.body.position.x, player.body.position.y + CONFIG.CROUCH_RADIUS + clearNeeded + 0.05, player.body.position.z);
    _crouchRes.reset();
    world.raycastClosest(_crouchFrom, _crouchTo, RAY_OPTS, _crouchRes);
    if (_crouchRes.hasHit) return;  // not enough clearance — stay crouched
  }

  player.crouching = on;
  player.hb = on ? HB_PLAYER_CROUCH : HB_PLAYER;
  const shape = player.body.shapes[0];
  const from = shape.radius;
  const to = on ? CONFIG.CROUCH_RADIUS : CONFIG.PLAYER_RADIUS;
  shape.radius = to;
  shape.updateBoundingSphereRadius();
  player.body.updateBoundingRadius();
  // The sphere grows about its centre, so standing up buries the lower half in the floor and
  // the solver answers by launching the body ~0.8 m into the air. Shift the centre by the
  // radius delta instead, which keeps the feet exactly where they were.
  player.body.position.y += to - from;
}

/* Ledge step-up (see call site in stepPlayer). */
const STEP_AHEAD = 0.55;      // how far along the move direction to probe
const STEP_MAX = 0.45;        // tallest lip we will climb
const _stepFrom = new CANNON.Vec3();
const _stepTo = new CANNON.Vec3();
const _stepRes = new CANNON.RaycastResult();

function stepOver(b) {
  const len = Math.hypot(_wish.x, _wish.z);
  if (len < 0.001) return;
  const ax = b.position.x + (_wish.x / len) * STEP_AHEAD;
  const az = b.position.z + (_wish.z / len) * STEP_AHEAD;
  const foot = b.position.y - CONFIG.PLAYER_RADIUS;

  // Straight down, from just above the tallest step we allow to just below the current foot.
  _stepFrom.set(ax, foot + STEP_MAX + 0.05, az);
  _stepTo.set(ax, foot - 0.10, az);
  _stepRes.reset();
  world.raycastClosest(_stepFrom, _stepTo, RAY_OPTS, _stepRes);
  if (!_stepRes.hasHit) return;

  const rise = _stepRes.hitPointWorld.y - foot;
  if (rise <= 0.04 || rise > STEP_MAX) return;   // flat ground, or too tall to climb

  b.position.y += rise + 0.02;
  if (b.velocity.y < 0) b.velocity.y = 0;        // don't fight gravity back down the step
}

function stepPlayer(dt) {
  const b = player.body;
  b.wakeUp();                     // belt-and-braces alongside world.allowSleep = false
  if (!player.alive) { b.velocity.x = 0; b.velocity.z = 0; b.velocity.y /= DAMP_PER_STEP; return; }

  playerGroundCheck();
  // Crouch and sprint read from a latch when the player has chosen toggle-style bindings
  // (see settings.toggleCrouch / toggleSprint), otherwise straight from the held key.
  setCrouch(settings.toggleCrouch ? crouchLatch : !!keys.KeyC);
  const wantSprint = settings.toggleSprint ? sprintLatch : !!keys.ShiftLeft;
  player.sprinting = wantSprint && !player.crouching && !aiming;

  // Movement basis is camera yaw with the pitch stripped out.
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  let fx = -sy, fz = -cy;        // forward
  let rx = cy, rz = -sy;         // right
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.GpForward || (settings.arrowKeys && keys.ArrowUp)) iz += 1;
  if (keys.KeyS || keys.GpBack || (settings.arrowKeys && keys.ArrowDown)) iz -= 1;
  if (keys.KeyD || keys.GpRight || (settings.arrowKeys && keys.ArrowRight)) ix += 1;
  if (keys.KeyA || keys.GpLeft || (settings.arrowKeys && keys.ArrowLeft)) ix -= 1;

  let speed = CONFIG.WALK_SPEED;
  if (player.sprinting) speed *= CONFIG.SPRINT_MULT;
  if (player.crouching) speed *= CONFIG.CROUCH_MULT;
  if (aiming) speed *= 0.55;

  _wish.set(fx * iz + rx * ix, 0, fz * iz + rz * ix);
  if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(speed);

  // Air control is deliberately weak so jumps commit.
  const accel = CONFIG.MOVE_ACCEL * (player.grounded ? 1 : 0.22);
  const k = Math.min(1, accel * dt);
  b.velocity.x = lerp(b.velocity.x, _wish.x, k);
  b.velocity.z = lerp(b.velocity.z, _wish.z, k);

  // Ledge step-up. A sphere collider catches on the lip of a crate: the contact normal points
  // back at you and the velocity controller just grinds against it. Probe a short way along
  // the direction we WANT to go, and if there is walkable ground within STEP_MAX above the
  // current foot, lift the body onto it. Cheap (one ray, only while actually walking).
  if (player.grounded && _wish.lengthSq() > 0) stepOver(b);

  if (keys.Space && player.grounded) {
    b.velocity.y = CONFIG.JUMP_SPEED;
    player.grounded = false;
  }
  // Cancel the vertical component of linearDamping (see DAMP_PER_STEP).
  b.velocity.y /= DAMP_PER_STEP;

  // Footsteps.
  const planar = Math.hypot(b.velocity.x, b.velocity.z);
  if (player.grounded && planar > 1.2) {
    player.stepTimer -= dt * (player.sprinting ? 1.5 : 1);
    if (player.stepTimer <= 0) { Audio.step(); player.stepTimer = 0.4; }
  } else {
    player.stepTimer = 0;
  }

  player.vel.set(b.velocity.x, b.velocity.y, b.velocity.z);
  player.pos.set(b.position.x, b.position.y + (player.crouching ? PLAYER_CHEST_CROUCH : PLAYER_CHEST), b.position.z);
  player.eye.set(b.position.x, b.position.y + PLAYER_EYE_OFF - (player.crouching ? 0.55 : 0), b.position.z);

  // Fall out of the world guard.
  if (b.position.y < -20) respawnPlayer();
}

/* ------------------------- aiming and firing ------------------------- */

const _camQ = new THREE.Quaternion();
const _camE = new THREE.Euler(0, 0, 0, 'YXZ');
const _aimDir = new THREE.Vector3();

function playerAimDirection(out) {
  _camE.set(player.pitch + player.recoilPitch, player.yaw + player.recoilYaw, 0, 'YXZ');
  _camQ.setFromEuler(_camE);
  return out.set(0, 0, -1).applyQuaternion(_camQ);
}

function currentWeapon() { return WEAPON_BY_ID[player.current]; }

function startReload() {
  const w = currentWeapon();
  if (w.thrown || player.reloading > 0) return;
  const a = player.ammo[w.id];
  if (a.mag >= w.mag || a.reserve <= 0) return;
  player.reloading = w.reload;
  player.reloadTotal = w.reload;
  Audio.reloadClick();
}

function finishReload() {
  const w = currentWeapon();
  const a = player.ammo[w.id];
  const need = w.mag - a.mag;
  const take = Math.min(need, a.reserve);
  a.mag += take; a.reserve -= take;
  Audio.reloadClick();
}

function switchWeapon(id) {
  if (player.current === id || !WEAPON_BY_ID[id]) return;
  if (id === 'frag' && player.fragCount <= 0) return;
  player.current = id;
  player.reloading = 0;
  player.cooldown = Math.max(player.cooldown, 0.25);
  aiming = false; crouchLatch = false; sprintLatch = false;
  updateAmmoHud();
}

function tryFire() {
  if (!player.alive || !match.running || player.cooldown > 0 || player.reloading > 0) return;
  player.invulnTimer = 0;  // firing cancels spawn protection
  const w = currentWeapon();
  if (w.thrown) return;                       // grenades are thrown with G, not LMB

  const a = player.ammo[w.id];
  if (a.mag <= 0) { startReload(); return; }

  a.mag--;
  player.cooldown = w.cooldown;

  playerAimDirection(_aimDir);
  const spreadMult = aiming ? 0.35 : (player.sprinting ? 1.9 : 1) * (player.grounded ? 1 : 1.6);

  // Fire from the muzzle marker so tracers leave the barrel, not the eyeball. The viewmodel
  // lives in its own scene whose camera sits at the origin, so its world position is already
  // camera-local: rotate by the aim quaternion and offset by the eye to reach world space.
  const mz = vmModels[w.id].userData.muzzle;
  const mzLocal = mz.getWorldPosition(new THREE.Vector3());
  _v3.copy(mzLocal).applyQuaternion(_camQ).add(camera.position);
  // Guard against the muzzle ending up inside geometry (up against a wall).
  if (!losClear(player.eye.x, player.eye.y, player.eye.z, _v3.x, _v3.y, _v3.z)) _v3.copy(player.eye);

  fireWeapon(player, w, _v3, _aimDir, spreadMult);

  player.recoilPitch += w.recoil;
  player.recoilYaw += rand(-w.recoil * 0.4, w.recoil * 0.4);
  vmRecoil += w.kick;
  flashTimer = 0.05;
  flashSprite.position.copy(mzLocal);
  vmFlash.position.copy(mzLocal).add(new THREE.Vector3(0, 0.06, 0.08));
  worldFlash.position.copy(_v3);
  ejectBrass(mzLocal.clone().add(new THREE.Vector3(0.05, 0.02, 0.12)));
  if (a.mag === 0) startReload();
  updateAmmoHud();
}

/* --------------------------- thrown ordnance --------------------------- */

function startCook(kind) {
  if (!player.alive || player.cooking) return;
  if (kind === 'frag' && player.fragCount <= 0) return;
  if (kind === 'smoke' && player.smokeCount <= 0) return;
  player.cooking = kind;
  player.cookTime = kind === 'frag' ? CONFIG.FRAG_FUSE : CONFIG.SMOKE_FUSE;
  Audio.pinPull();
}

function releaseCook(exploded = false) {
  const kind = player.cooking;
  if (!kind) return;
  player.cooking = null;

  if (kind === 'frag') player.fragCount--;
  else player.smokeCount--;

  if (exploded) {
    // Cooked it too long — it goes off in your hand.
    if (kind === 'frag') explode(player.eye, player);
    else spawnSmoke(player.eye, player);
  } else {
    player.invulnTimer = 0;  // throwing cancels spawn protection
    playerAimDirection(_aimDir);
    const origin = player.eye.clone().addScaledVector(_aimDir, 0.7);
    throwGrenade(player, origin, _aimDir, 17, kind, Math.max(0.35, player.cookTime));
  }
  if (player.current === 'frag' && player.fragCount <= 0) switchWeapon('pistol');
  updateAmmoHud();
}

/* ------------------------------ input ------------------------------ */

function bindInput() {
  const canvas = renderer.domElement;

  canvas.addEventListener('mousedown', (e) => {
    if (!pointerLocked) { requestLock(); return; }
    // With the frag selected, LMB cooks and releases exactly like G does.
    if (e.button === 0) {
      if (currentWeapon().thrown) startCook('frag');
      else { firing = true; tryFire(); }
    }
    if (e.button === 2) aiming = settings.toggleAim ? !aiming : true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      firing = false;
      if (player.cooking === 'frag' && !keys.KeyG) releaseCook();
    }
    if (e.button === 2 && !settings.toggleAim) aiming = false;
  });
  // Without this the browser context menu eats every right-click ADS.
  addEventListener('contextmenu', (e) => e.preventDefault());

  addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    mouseDX += e.movementX;
    mouseDY += e.movementY;
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'Tab') e.preventDefault();
    if (keys[e.code]) return;                    // ignore auto-repeat
    keys[e.code] = true;

    // Toggle latches for the trackpad-friendly bindings.
    if (e.code === 'KeyC' && settings.toggleCrouch) crouchLatch = !crouchLatch;
    if (e.code === 'ShiftLeft' && settings.toggleSprint) sprintLatch = !sprintLatch;

    switch (e.code) {
      case 'Digit1': switchWeapon('pistol'); break;
      case 'Digit2': switchWeapon('ar'); break;
      case 'Digit3': switchWeapon('shotgun'); break;
      case 'Digit4': switchWeapon('sniper'); break;
      case 'Digit5': switchWeapon('frag'); break;
      case 'KeyR': startReload(); break;
      case 'KeyG': startCook('frag'); break;
      case 'KeyF': startCook('smoke'); break;
      case 'Tab': showBoard(true); break;
    }
  });

  addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'KeyG' && player.cooking === 'frag') releaseCook();
    if (e.code === 'KeyF' && player.cooking === 'smoke') releaseCook();
    if (e.code === 'Tab') showBoard(false);
  });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    firing = false; aiming = false;
    if (pointerLocked && match.running) {
      resumePlay();
    } else if (!pointerLocked && appState === APP_STATE.PLAYING) {
      showPause(true);
    }
  });

  document.getElementById('pause').addEventListener('click', () => {
    if (appState === APP_STATE.PAUSED) requestLock();
  });
}

function requestLock() {
  if (!match.running) return;
  renderer.domElement.requestPointerLock();
  Audio.init();
}

/** Consume the accumulated mouse delta once per rendered frame. */
/* ---------------------------- gamepad ---------------------------- */

/**
 * Controller support, polled rather than event-driven because the Gamepad API has no events
 * for axis movement. Standard mapping: left stick moves, right stick looks, RT fires, LT aims,
 * A jumps, B crouches, LB throws a frag, right stick click sprints, D-pad swaps weapons.
 *
 * Sticks get a radial dead zone and the look axes are cubed — a linear stick makes fine aim
 * impossible, and squaring loses the sign.
 */
const GP_DEADZONE = 0.18;
const gpPrev = [];
let gamepadActive = false;

function gpAxis(v) {
  const a = Math.abs(v);
  if (a < GP_DEADZONE) return 0;
  const scaled = (a - GP_DEADZONE) / (1 - GP_DEADZONE);
  return Math.sign(v) * scaled;
}

function pollGamepad(dt) {
  const pads = navigator.getGamepads?.();
  if (!pads) return;
  let pad = null;
  for (const p of pads) if (p && p.connected) { pad = p; break; }
  if (!pad) { gamepadActive = false; return; }

  const ax = pad.axes, btn = pad.buttons;
  const moveX = gpAxis(ax[0] ?? 0), moveY = gpAxis(ax[1] ?? 0);
  const lookX = gpAxis(ax[2] ?? 0), lookY = gpAxis(ax[3] ?? 0);
  if (moveX || moveY || lookX || lookY) gamepadActive = true;

  // Movement is fed through the same key flags the keyboard sets, so nothing downstream
  // needs to know where the input came from.
  keys.GpForward = moveY < -0.1; keys.GpBack = moveY > 0.1;
  keys.GpLeft = moveX < -0.1; keys.GpRight = moveX > 0.1;

  const down = (i) => !!(btn[i] && btn[i].pressed);
  const pressed = (i) => { const d = down(i); const was = gpPrev[i]; gpPrev[i] = d; return d && !was; };

  // Look. Cubed for fine control, scaled by dt and by the same ADS multiplier as the mouse.
  const gpAdsMult = aiming && currentWeapon().zoom
    ? settings.adsSensitivity * (0.4 / 0.75)
    : (aiming ? settings.adsSensitivity : 1);
  const lookRate = 3.4 * settings.sensitivity * gpAdsMult * dt;
  player.yaw -= (lookX ** 3) * lookRate;
  player.pitch -= (lookY ** 3) * lookRate * (settings.invertY ? -1 : 1);
  player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

  // LT: toggle-ADS uses edge-triggered latch so pressing again actually toggles off.
  if (settings.toggleAim) { if (pressed(6)) aiming = !aiming; }
  else { aiming = down(6); }

  // RT: semi fires on press; auto fires via the frame() loop (firing flag, no double-call).
  if (down(7)) { if (!firing) { firing = true; tryFire(); } }
  else firing = false;

  keys.Space = down(0);                                     // A
  // B: gate on toggleCrouch so only one of crouchLatch or KeyC is driven at a time.
  if (settings.toggleCrouch) { if (pressed(1)) crouchLatch = !crouchLatch; }
  else { keys.KeyC = down(1); }
  keys.ShiftLeft = down(11);                                // right stick click sprints
  if (pressed(4)) startCook('frag');                        // LB
  if (!down(4) && player.cooking === 'frag') releaseCook();
  if (pressed(2)) startReload();                            // X
  if (pressed(3)) switchWeapon('frag');                     // Y
  if (pressed(12)) switchWeapon('pistol');
  if (pressed(13)) switchWeapon('ar');
  if (pressed(14)) switchWeapon('shotgun');
  if (pressed(15)) switchWeapon('sniper');
  if (pressed(9)) {                                          // start: pause or resume
    if (appState === APP_STATE.PLAYING) showPause(true);
    else if (appState === APP_STATE.PAUSED) requestLock();
  }
}

function applyLook(dt) {
  // Scope multiplier scales with adsSensitivity so the slider is predictable at all settings.
  // At the default (0.75) this equals the previous hardcoded 0.4.
  const adsMult = aiming && currentWeapon().zoom
    ? settings.adsSensitivity * (0.4 / 0.75)
    : (aiming ? settings.adsSensitivity : 1);
  const sens = CONFIG.SENS * settings.sensitivity * adsMult;
  player.yaw -= mouseDX * sens;
  player.pitch -= mouseDY * sens * (settings.invertY ? -1 : 1);
  player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

  // Weapon sway trails the mouse and settles back.
  player.sway.x = clamp(lerp(player.sway.x, -mouseDX * 0.0016, 0.35), -1, 1);
  player.sway.y = clamp(lerp(player.sway.y, -mouseDY * 0.0016, 0.35), -1, 1);
  player.sway.multiplyScalar(Math.pow(0.02, dt));

  mouseDX = 0; mouseDY = 0;

  const rec = Math.pow(0.0009, dt);      // exponential recovery toward the original aim
  player.recoilPitch *= rec;
  player.recoilYaw *= rec;
}

/* ================================================================== *
 * === BOTS ===
 * ================================================================== */

const bots = [];
// Mutual repulsion between bots — see setPlanarVelocity.
const SEP_RADIUS = 2.5;       // metres at which neighbours start pushing apart
const SEP_STRENGTH = 3.2;     // m/s of push at zero distance
const ST = {
  SPAWN: 'SPAWN', PATROL: 'PATROL', ALERT: 'ALERT', CHASE: 'CHASE',
  SHOOT: 'SHOOT', COVER: 'TAKE_COVER', NADE: 'THROW_GRENADE', DEAD: 'DEAD',
};

// The bot mesh is scaled 1.2x and its feet sit 0.04 m above the compound body's centre-of-
// rest, which puts the chest 0.45 m and the head/eye 0.95 m above that centre.
// Bot perception. 130 degrees total — generous enough that bots are not oblivious, narrow
// enough that flanking and back-lines actually work. Anything within BOT_AWARE_NEAR metres is
// noticed regardless of which way the bot is looking.
const BOT_FOV_COS = Math.cos((65 * Math.PI) / 180);
const BOT_AWARE_NEAR = 6;

// Planar speed (m/s) each locomotion clip in soldier.glb was authored for. Used to drive
// action.timeScale so playback rate tracks how fast the bot is actually travelling.
const WALK_CLIP_SPEED = 1.6;
const RUN_CLIP_SPEED = 4.4;

const BOT_MESH_SCALE = 1.2;
const BOT_MESH_Y = 0.04;
const BOT_CHEST = 0.50;
const BOT_EYE = 1.05;

/* --------------------- rigged soldier bot mesh --------------------- */

/**
 * The three.js Soldier, used for the bot body when it loads. Measured, not guessed: the model
 * is 1.832 m tall with its feet on the model origin, and it faces -Z (its toes reach z=-0.219
 * against +0.123 at the heel, and the back of the skull protrudes further than the nose) —
 * which is the same convention the procedural mesh uses, so Bot.faceDir needs no change.
 */
let soldierGltf = null;

const SOLDIER_HEIGHT = 1.832;   // measured from the GLB's bounding box
const BOT_TARGET_HEIGHT = 2.0;
const BOT_FOOT_Y = -0.65;       // where feet sit in mesh-local space (x BOT_MESH_SCALE = -0.78)

async function loadSoldier() {
  try {
    soldierGltf = await gltfLoader.loadAsync('./assets/bots/soldier.glb');
    return true;
  } catch {
    soldierGltf = null;         // fall back to the blocky humanoid
    return false;
  }
}

/**
 * One soldier instance. Materials are cloned per bot because the death fade writes
 * material.opacity and the team tint writes material.emissive — sharing them would fade and
 * recolour every bot at once.
 */
function buildSoldierMesh(teamColor) {
  const g = new THREE.Group();
  const model = skeletonClone(soldierGltf.scene);

  // Fitted so that after the group's BOT_MESH_SCALE the soldier stands BOT_TARGET_HEIGHT tall
  // with its feet exactly where the procedural mesh put them.
  model.scale.setScalar(BOT_TARGET_HEIGHT / (SOLDIER_HEIGHT * BOT_MESH_SCALE));
  model.position.y = BOT_FOOT_Y;

  model.traverse((o) => {
    if (!o.isMesh) return;
    // Cloned so the death fade (material.opacity) and any tint stay per-bot. The Vanguard
    // texture is left exactly as authored: tinting the whole body toward the team colour
    // turned every soldier into a flat red or blue mannequin. Team reads from the kit below.
    o.material = o.material.clone();
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;                  // skinned bounds are the bind pose, not the pose
  });
  g.add(model);

  // Team kit: a chest webbing band, shoulder pads and a small shoulder lamp. Enough to call
  // friend from foe in a glance without repainting the soldier.
  const kitMat = matte(teamColor, 0.55, 0.15);
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.13, 0.30), kitMat);
  band.position.set(0, 0.62, 0.01);
  const padL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.10, 0.22), kitMat);
  padL.position.set(-0.22, 0.78, 0);
  const padR = padL.clone();
  padR.position.x = 0.22;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6),
    new THREE.MeshBasicMaterial({ color: teamColor }));
  lamp.position.set(0.19, 0.80, 0.02);
  g.add(band, padL, padR, lamp);

  const mixer = new THREE.AnimationMixer(model);
  const clips = {};
  for (const name of ['Idle', 'Walk', 'Run']) {
    const clip = THREE.AnimationClip.findByName(soldierGltf.animations, name);
    if (clip) { clips[name] = mixer.clipAction(clip); clips[name].play(); clips[name].weight = 0; }
  }
  if (clips.Idle) clips.Idle.weight = 1;
  g.userData.mixer = mixer;
  g.userData.clips = clips;
  return g;
}

/** Blocky humanoid, tinted by team so allies and enemies read instantly. */
function buildBotMesh(teamColor) {
  if (soldierGltf) return buildSoldierMesh(teamColor);
  return buildBlockyBotMesh(teamColor);
}

function buildBlockyBotMesh(teamColor) {
  const g = new THREE.Group();
  const dark = matte(0x22262c, 0.85, 0.15);
  const accent = matte(teamColor, 0.55, 0.25);
  const skin = matte(0x3a4048, 0.9, 0.1);

  const torso = boxPart(0.52, 0.66, 0.30, 0, 0.30, 0, dark);
  const vest = boxPart(0.55, 0.34, 0.34, 0, 0.34, 0, accent);
  const head = boxPart(0.28, 0.28, 0.28, 0, 0.78, 0, skin);
  const visor = boxPart(0.22, 0.09, 0.03, 0, 0.80, -0.15, matte(teamColor, 0.25, 0.8));
  const armL = boxPart(0.14, 0.54, 0.16, -0.33, 0.26, 0, dark);
  const armR = boxPart(0.14, 0.54, 0.16, 0.33, 0.26, 0, dark);
  const legL = boxPart(0.19, 0.62, 0.20, -0.14, -0.34, 0, skin);
  const legR = boxPart(0.19, 0.62, 0.20, 0.14, -0.34, 0, skin);
  // Shoulder light — the team tell that survives at range and in the dark.
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6),
    new THREE.MeshBasicMaterial({ color: teamColor }));
  lamp.position.set(0.24, 0.60, 0);

  for (const p of [torso, vest, head, visor, armL, armR, legL, legR]) {
    p.castShadow = true; p.receiveShadow = true; g.add(p);
  }
  g.add(lamp);
  g.userData.legs = [legL, legR];
  g.userData.arms = [armL, armR];
  return g;
}

/** A stubby gun so you can tell at a glance what a bot is carrying. */
function buildBotGun(id) {
  const w = WEAPON_BY_ID[id];
  const g = new THREE.Group();
  const len = id === 'sniper' ? 1.0 : id === 'ar' ? 0.72 : id === 'shotgun' ? 0.8 : 0.34;
  // Fresh materials per gun: the death fade mutates opacity, and sharing would fade every bot.
  const barrelMat = matte(0x1b1e23, 0.55, 0.5);
  g.add(boxPart(0.09, 0.11, len * 0.55, 0, 0, -len * 0.22, matte(w.color, 0.6, 0.4)));
  g.add(cylPart(0.024, 0.024, len * 0.6, 0, 0.012, -len * 0.62, barrelMat));
  if (id === 'sniper') g.add(cylPart(0.04, 0.04, 0.26, 0, 0.10, -0.22, barrelMat));
  const mz = new THREE.Object3D();
  mz.position.set(0, 0.012, -len * 0.92);
  g.add(mz);
  g.userData.muzzle = mz;
  return g;
}

class Bot {
  constructor(name, team, diff) {
    this.isPlayer = false;
    this.name = name;
    this.team = team;
    this.diff = diff;
    this.alive = true;
    this.health = 100;
    this.armor = 0;
    this.kills = 0; this.deaths = 0;

    this.pos = new THREE.Vector3();
    this.eye = new THREE.Vector3();
    this.vel = new THREE.Vector3();

    this.state = ST.SPAWN;
    this.stateTime = 0;
    this.target = null;
    this.hasLOS = false;
    this.losTimer = 0;
    this.reactTimer = 0;
    this.lastKnown = new THREE.Vector3();

    this.path = null;
    this.pathIdx = 0;
    this.repathTimer = 0;
    this.patrolWp = randInt(0, Math.max(0, waypoints.length - 1));

    this.weaponId = pick(BOT_GUN_IDS);
    this.mag = WEAPON_BY_ID[this.weaponId].mag;
    this.reloading = 0;
    this.fireCd = 0;
    this.burst = 0;
    this.nadeCd = rand(6, 16);
    this.deathTimer = 0;
    this.respawnTimer = 0;
    this.aimOff = new THREE.Vector3();     // persistent aim error, random-walks while firing
    this.aimSettle = 0;                    // seconds spent tracking the current target
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = rand(0.5, 1.5);
    this.yaw = rand(-Math.PI, Math.PI);
    this.stepTimer = 0;

    const color = TEAM_COLOR[team];
    this.mesh = buildBotMesh(color);
    this.mesh.scale.setScalar(BOT_MESH_SCALE);
    this.hb = HB_BOT;
    this.gunMesh = buildBotGun(this.weaponId);
    this.gunMesh.position.copy(this.gunAnchor());
    this.mesh.add(this.gunMesh);
    scene.add(this.mesh);

    // Minimap blip, on the layer only the map camera renders.
    this.blip = new THREE.Mesh(
      new THREE.CircleGeometry(1.7, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    this.blip.rotation.x = -Math.PI / 2;
    this.blip.layers.set(L_BLIP);
    this.blip.renderOrder = 10;
    scene.add(this.blip);

    // Two stacked spheres approximate a capsule without a real capsule shape.
    this.body = new CANNON.Body({
      mass: 70, material: MAT_BODY, linearDamping: 0.0,
      angularDamping: 1, fixedRotation: true, collisionFilterGroup: G_BODY,
    });
    this.body.addShape(new CANNON.Sphere(0.36), new CANNON.Vec3(0, -0.38, 0));
    this.body.addShape(new CANNON.Sphere(0.36), new CANNON.Vec3(0, 0.34, 0));
    this.body.updateMassProperties();
    world.addBody(this.body);

    this.plate = makePlate(name, color);
    this.updateTransforms();
  }

  dispose() {
    scene.remove(this.mesh);
    scene.remove(this.blip);
    world.removeBody(this.body);
    this.plate.root.remove();
  }

  /** Where the carried gun hangs in mesh-local space. The rigged soldier's shoulders sit
   *  lower and further forward than the blocky mesh's, so the two need different anchors. */
  gunAnchor() {
    return this.mesh.userData.mixer
      ? new THREE.Vector3(0.26, 0.30, -0.26)
      : new THREE.Vector3(0.30, 0.42, -0.18);
  }

  updateTransforms() {
    const p = this.body.position;
    this.pos.set(p.x, p.y + BOT_CHEST, p.z);
    this.eye.set(p.x, p.y + BOT_EYE, p.z);
    this.vel.set(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z);
    this.mesh.position.set(p.x, p.y + BOT_MESH_Y, p.z);
    this.blip.position.set(p.x, 0.6, p.z);
  }

  /* --------------------------- perception --------------------------- */

  /** Enemies this bot is allowed to shoot. Team filtering happens here, once. */
  enemyList() {
    const out = [];
    for (const c of combatants) {
      if (!c.alive || c === this) continue;
      if (this.team !== TEAM.SOLO && c.team === this.team) continue;
      out.push(c);
    }
    return out;
  }

  canSee(target) {
    if (target.invulnTimer > 0) return false;   // spawn-protected: bots do not acquire you
    const d = this.eye.distanceTo(target.pos);
    if (d > 90) return false;
    // Vision cone. Without this a bot acquired anything it had line of sight to anywhere in a
    // 90 m *sphere* — including directly behind it — which is why standing still and watching
    // a bot got you shot: it had already seen you through the back of its head. Targets nearer
    // than BOT_AWARE_NEAR are still noticed regardless of facing, so you cannot walk up and
    // stand on someone. Bots that miss you this way are not blind: a gunshot within 20 m
    // routes them to ALERT via alertBots(), which walks them to lastKnown and re-acquires.
    if (d > BOT_AWARE_NEAR) {
      const dx = target.pos.x - this.body.position.x;
      const dz = target.pos.z - this.body.position.z;
      const inv = 1 / Math.max(1e-4, Math.hypot(dx, dz));
      // faceDir measures yaw from +Z, so forward is (sin yaw, cos yaw).
      const facing = dx * inv * Math.sin(this.yaw) + dz * inv * Math.cos(this.yaw);
      if (facing < BOT_FOV_COS) return false;
    }
    if (!losClear(this.eye.x, this.eye.y, this.eye.z, target.pos.x, target.pos.y, target.pos.z)) return false;
    return !smokeBlocks(this.eye, target.pos);
  }

  acquire() {
    const list = this.enemyList();
    let best = null, bd = Infinity;
    for (const c of list) {
      const d = this.eye.distanceToSquared(c.pos);
      if (d < bd && this.canSee(c)) { bd = d; best = c; }
    }
    if (best) { this.target = best; return true; }
    // No one visible: keep the current target if we still remember where it went.
    if (this.target && !this.target.alive) this.target = null;
    return false;
  }

  /* ---------------------------- navigation ---------------------------- */

  repath(destination) {
    this.path = findPath(this.body.position, destination);
    this.pathIdx = 0;
    this.repathTimer = 2.0;
  }

  /** Drive toward the next path node. Returns true once the path is exhausted. */
  followPath(speed, dt) {
    if (!this.path || this.pathIdx >= this.path.length) { this.setPlanarVelocity(0, 0); return true; }
    const node = this.path[this.pathIdx];
    const dx = node.x - this.body.position.x;
    const dz = node.z - this.body.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.6) { this.pathIdx++; return this.pathIdx >= this.path.length; }
    this.setPlanarVelocity((dx / dist) * speed, (dz / dist) * speed);
    this.faceDir(dx, dz, dt, 7);
    if (this.stepTimer <= 0) {
      this.stepTimer = 0.42;
      const dc = this.body.position.distanceTo(camera.position);
      if (dc < 22) {
        const sp = Audio.spatial(this.body.position);
        Audio.burst({ dur: 0.06, gain: 0.05 * Audio.atten(dc), type: 'lowpass', freq: 380, decay: 0.05, pan: sp.pan });
      }
    }
    return false;
  }

  /** Bots are moved by writing velocity, never by forces — no sliding, no slope drift.
   *  Separation is folded in here rather than in the path follower so it applies while
   *  standing still too: without it every bot chasing the same target converges on the
   *  same point and they end up standing inside one another. */
  setPlanarVelocity(vx, vz) {
    let sx = 0, sz = 0;
    for (const o of bots) {
      if (o === this || !o.alive) continue;
      const dx = this.body.position.x - o.body.position.x;
      const dz = this.body.position.z - o.body.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > SEP_RADIUS * SEP_RADIUS || d2 < 1e-6) continue;
      // Inverse-distance falloff: shoulder-to-shoulder pushes hard, a metre out barely at all.
      const d = Math.sqrt(d2);
      const w = (SEP_RADIUS - d) / SEP_RADIUS;
      sx += (dx / d) * w;
      sz += (dz / d) * w;
    }
    this.body.velocity.x = vx + sx * SEP_STRENGTH;
    this.body.velocity.z = vz + sz * SEP_STRENGTH;
    this.body.wakeUp();
  }

  faceDir(dx, dz, dt, rate = 9) {
    const want = Math.atan2(dx, dz);
    let diff = want - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, rate * dt);
    this.mesh.rotation.y = this.yaw + Math.PI;   // mesh faces -Z, yaw is measured from +Z
  }

  faceTarget(dt) {
    if (!this.target) return;
    this.faceDir(this.target.pos.x - this.body.position.x, this.target.pos.z - this.body.position.z, dt, 11);
  }

  /* ----------------------------- shooting ----------------------------- */

  /**
   * Aim with lead compensation, then degrade by (1 - accuracy). Difficulty is expressed as
   * cone width, so a "40% accuracy" bot genuinely misses instead of being handicapped by a
   * hidden dice roll after the fact.
   */
  shootAt(target, dt) {
    const w = WEAPON_BY_ID[this.weaponId];
    if (this.reloading > 0) return;
    if (this.mag <= 0) { this.reloading = w.reload; return; }
    if (this.fireCd > 0) return;

    const muzzle = this.gunMesh.userData.muzzle.getWorldPosition(_v1);
    const dist = muzzle.distanceTo(target.pos);
    const flight = dist / w.speed;

    // Imperfect lead. The old code led the target perfectly and compensated bullet drop
    // exactly, then applied a tight cone around that flawless solution — which is why bots
    // never missed. Both the lead and the drop compensation are now sloppy, and how sloppy
    // depends on the difficulty, so a bot mis-times a moving target the way a person does.
    const skill = this.diff.accuracy;
    const leadErr = lerp(0.45, 0.95, skill) * rand(0.75, 1.2);
    _v2.copy(target.pos).addScaledVector(target.vel, flight * leadErr);
    _v2.y += 0.5 * 9.82 * flight * flight * lerp(0.55, 1.0, skill);
    _v2.sub(muzzle).normalize();

    /**
     * Aim error has three parts, because a single per-shot random cone reads as a laser that
     * occasionally twitches rather than as someone aiming:
     *
     *  1. A persistent offset that random-walks. This is the bot's current "aim point", so a
     *     burst lands as a cluster slightly off target instead of every round being an
     *     independent coin flip. It is what makes a burst survivable.
     *  2. Distance scaling — holding a bead at 40 m is genuinely harder than at 5 m.
     *  3. Situational penalties: freshly acquired targets, and targets moving laterally.
     */
    const lateral = Math.hypot(target.vel.x, target.vel.z);
    const freshness = clamp(1 - this.aimSettle, 0, 1);           // 1 right after acquiring
    const spread = AIM.floor
                 + (1 - skill) * AIM.base
                 + (dist / 100) * (1 - skill) * AIM.range        // range penalty
                 + lateral * AIM.tracking * (1 - skill * 0.5)    // tracking penalty
                 + freshness * AIM.snap * (1 - skill * 0.6);     // snap-shot penalty

    // Random-walk the persistent offset, then clamp it so it cannot drift absurdly wide.
    const drift = spread * 0.55;
    this.aimOff.x = clamp(this.aimOff.x + rand(-drift, drift), -spread, spread);
    this.aimOff.y = clamp(this.aimOff.y + rand(-drift, drift), -spread, spread);
    this.aimOff.z = clamp(this.aimOff.z + rand(-drift, drift), -spread, spread);

    // Per-shot jitter on top, plus the weapon's own mechanical spread.
    const jitter = spread * 0.5 + w.spread * 0.5;
    _v2.x += this.aimOff.x + rand(-jitter, jitter);
    _v2.y += this.aimOff.y + rand(-jitter, jitter);
    _v2.z += this.aimOff.z + rand(-jitter, jitter);
    _v2.normalize();

    this.mag--;
    this.fireCd = w.cooldown * this.diff.fireMult * (w.auto ? 1 : rand(1.0, 1.5));
    fireWeapon(this, w, muzzle.clone(), _v2, 1);
    if (this.mag <= 0) this.reloading = w.reload;
  }

  /* --------------------------- state machine --------------------------- */

  // Game-logic step — called at fixed physics dt from fixedStep() so all timers are
  // coherent with the physics simulation.
  simStep(dt) {
    // Fall-out guard: teleport any bot that escapes the floor back to a spawn.
    if (this.body.position.y < -20) {
      const sp = pickSpawn(this.team);
      this.body.position.set(sp.x, sp.y + 0.6, sp.z);
      this.body.velocity.set(0, 0, 0);
      this.body.wakeUp();
      this.path = null;
    }

    this.fireCd = Math.max(0, this.fireCd - dt);
    // Aim settles the longer a bot holds the same target in view, and resets the moment it
    // loses them — so peeking a fresh angle is punished less than standing in the open.
    if (this.hasLOS && this.target === this._lastAimTarget) this.aimSettle += dt;
    else { this.aimSettle = 0; this.aimOff.set(0, 0, 0); }
    this._lastAimTarget = this.hasLOS ? this.target : null;
    this.stepTimer = Math.max(0, this.stepTimer - dt);
    this.stateTime += dt;
    this.repathTimer -= dt;
    this.nadeCd -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.mag = WEAPON_BY_ID[this.weaponId].mag;
    }

    if (!this.alive) {
      this.deathTimer += dt;
      this.respawnTimer -= dt;
      return;
    }

    // Line of sight is re-tested on a 0.3 s cadence, not every frame.
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.3;
      const had = this.hasLOS;
      this.hasLOS = this.acquire();
      if (this.hasLOS) {
        this.lastKnown.copy(this.target.pos);
        if (!had) this.reactTimer = this.diff.reaction;
      }
    }
    this.reactTimer = Math.max(0, this.reactTimer - dt);

    const hpFrac = this.health / 100;
    const dist = this.target ? this.body.position.distanceTo(this.target.pos) : Infinity;

    switch (this.state) {
      case ST.SPAWN:
        if (this.stateTime > 0.4) this.setState(ST.PATROL);
        break;

      case ST.PATROL: {
        if (this.hasLOS) { this.setState(ST.CHASE); break; }
        if (!this.path || this.repathTimer <= 0 || this.pathIdx >= (this.path?.length ?? 0)) {
          this.patrolWp = randInt(0, waypoints.length - 1);
          this.repath(waypoints[this.patrolWp].pos);
        }
        this.followPath(this.moveSpeed('patrol'), dt);
        break;
      }

      case ST.ALERT: {
        this.setPlanarVelocity(0, 0);
        // Sweep the area the noise came from.
        this.faceDir(
          this.lastKnown.x - this.body.position.x + Math.sin(this.stateTime * 4) * 6,
          this.lastKnown.z - this.body.position.z + Math.cos(this.stateTime * 4) * 6, dt, 4);
        if (this.hasLOS) { this.setState(ST.CHASE); break; }
        if (this.stateTime > 1.5) this.setState(ST.PATROL);
        break;
      }

      case ST.CHASE: {
        if (hpFrac < 0.4 && this.hasLOS) { this.setState(ST.COVER); break; }
        if (this.hasLOS && this.nadeCd <= 0 && dist > 6 && dist < 15
            && Math.random() < this.diff.aggression) { this.setState(ST.NADE); break; }
        if (this.hasLOS && this.reactTimer <= 0 && dist < 55) { this.setState(ST.SHOOT); break; }

        const dest = this.hasLOS ? this.target.pos : this.lastKnown;
        if (!this.path || this.repathTimer <= 0) this.repath(dest);
        const done = this.followPath(this.moveSpeed('chase'), dt);
        if (this.hasLOS) this.faceTarget(dt);
        if (done && !this.hasLOS) this.setState(ST.PATROL);
        break;
      }

      case ST.SHOOT: {
        this.faceTarget(dt);
        if (hpFrac < 0.4) { this.setState(ST.COVER); break; }
        if (!this.hasLOS) {
          if (this.stateTime > 0.6) this.setState(ST.CHASE);
          break;
        }
        this.combatMove(dist, dt);
        if (this.reactTimer <= 0) this.shootAt(this.target, dt);
        if (this.nadeCd <= 0 && dist > 6 && dist < 15) { this.setState(ST.NADE); break; }
        if (dist > 60) this.setState(ST.CHASE);
        break;
      }

      case ST.COVER: {
        if (this.stateTime === 0 || !this.path) this.findCover();
        const done = this.followPath(this.moveSpeed('cover'), dt);
        if (done || this.stateTime > 2.0) {
          this.health = Math.min(100, this.health + 12);   // catching breath
          this.setState(ST.CHASE);
        }
        break;
      }

      case ST.NADE: {
        this.setPlanarVelocity(0, 0);
        this.faceTarget(dt);
        if (this.stateTime > 0.7) {
          if (this.target) {
            const from = this.eye.clone();
            const to = this.lastKnown.clone();
            const d = to.clone().sub(from);
            const flat = Math.hypot(d.x, d.z);
            d.normalize();
            d.y += clamp(flat / 42, 0.18, 0.5);            // lob it
            d.normalize();
            throwGrenade(this, from.addScaledVector(d, 0.6), d, 15, 'frag', 1.8);
          }
          this.nadeCd = rand(11, 22);
          this.setState(ST.CHASE);
        }
        break;
      }
    }

    // Gravity is left to the solver; only X/Z are driven.
  }

  // Visual step — called once per rendered frame with the actual frame delta.
  renderStep(frameDt) {
    this.updateTransforms();
    if (!this.alive) {
      // Death fall-over and fade animation driven by deathTimer (advanced in simStep).
      const fall = Math.min(1, this.deathTimer / 0.3);
      this.mesh.rotation.x = -Math.PI / 2 * fall;
      this.mesh.position.y = this.body.position.y + BOT_MESH_Y - 0.45 * fall;
      if (this.deathTimer > 0.6) {
        const a = clamp(1 - (this.deathTimer - 0.6) / 2.0, 0, 1);
        this.mesh.traverse((o) => {
          if (o.isMesh) { o.material.transparent = true; o.material.opacity = a; }
        });
        if (a <= 0) this.mesh.visible = false;
      }
      return;
    }
    this.animate(frameDt);
  }

  setState(s) { this.state = s; this.stateTime = 0; if (s === ST.COVER) this.findCover(); }

  /**
   * Movement while actually engaging someone.
   *
   * The old version was `sin(stateTime * 1.7) * 2` sideways and nothing else, which is why a
   * bot you closed on appeared to shuffle left and right on the spot forever. Now it holds a
   * band of range that suits the gun it is carrying — a shotgun bot wants to be in your face,
   * a sniper wants to back off — and only strafes once it is inside that band. The strafe
   * direction flips on a randomised timer rather than a sine, so it does not read as a
   * metronome, and it reverses early if the bot walks into something.
   */
  combatMove(dist, dt) {
    const band = BOT_RANGE_BAND[this.weaponId] || BOT_RANGE_BAND.ar;
    const speed = this.moveSpeed(dist < band.min ? 'retreat' : 'combat');

    // Forward axis toward the target, and the perpendicular used for strafing.
    const dx = this.target.pos.x - this.body.position.x;
    const dz = this.target.pos.z - this.body.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    const rx = -fz, rz = fx;

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      this.strafeTimer = rand(0.7, 1.8);
    }

    let vx = 0, vz = 0;
    if (dist < band.min) {                 // too close — give ground while still firing
      vx -= fx * speed; vz -= fz * speed;
    } else if (dist > band.max) {           // too far — close in
      vx += fx * speed * 0.9; vz += fz * speed * 0.9;
    }
    // Always some lateral movement so a bot is never a stationary target.
    vx += rx * this.strafeDir * speed * 0.75;
    vz += rz * this.strafeDir * speed * 0.75;

    // If barely moving despite wanting to, we are against geometry — flip the strafe.
    const actual = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    if (actual < 0.6 && this.stateTime > 0.3) { this.strafeDir *= -1; this.strafeTimer = rand(0.5, 1.0); }

    this.setPlanarVelocity(vx, vz);
  }

  /** Bots run. Patrol is the only time they walk. Harder bots move faster. */
  moveSpeed(kind) {
    const m = this.diff.speed ?? 1;
    if (kind === 'patrol') return 3.6 * m;
    if (kind === 'combat') return 4.6 * m;
    if (kind === 'retreat') return 4.2 * m;
    if (kind === 'cover') return 7.2 * m;
    return 6.6 * m;                        // chase
  }

  /** Nearest waypoint flagged as cover that the current target cannot see into. */
  findCover() {
    let best = null, bd = Infinity;
    for (const wp of waypoints) {
      if (!wp.cover) continue;
      const d = wp.pos.distanceToSquared(this.pos);
      if (d > 900 || d >= bd) continue;
      if (this.target && losClear(this.target.pos.x, this.target.pos.y, this.target.pos.z,
                                 wp.pos.x, wp.pos.y + 0.5, wp.pos.z)) continue;
      bd = d; best = wp;
    }
    this.repath(best ? best.pos : waypoints[randInt(0, waypoints.length - 1)].pos);
  }

  animate(dt) {
    const speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);

    const mixer = this.mesh.userData.mixer;
    if (mixer) {
      // Rigged soldier: cross-fade idle -> walk -> run on planar speed. Weights are lerped
      // rather than switched so a bot changing pace does not pop between clips.
      const clips = this.mesh.userData.clips;
      const wRun = clamp((speed - 3.2) / 2.5, 0, 1);
      const wWalk = clamp((speed - 0.25) / 2.0, 0, 1) * (1 - wRun);
      const wIdle = 1 - wWalk - wRun;
      const k = Math.min(1, 8 * dt);
      if (clips.Idle) clips.Idle.weight = lerp(clips.Idle.weight, wIdle, k);
      if (clips.Walk) clips.Walk.weight = lerp(clips.Walk.weight, wWalk, k);
      if (clips.Run) clips.Run.weight = lerp(clips.Run.weight, wRun, k);
      // Foot-sliding fix: the clips were playing at their authored rate no matter how fast
      // the bot was actually moving, so the feet skated whenever the two disagreed. Drive
      // playback rate from real planar speed against the speed each clip was authored for.
      // Clamped because a bot shoved by an explosion should not windmill its legs.
      if (clips.Walk) clips.Walk.timeScale = clamp(speed / WALK_CLIP_SPEED, 0.6, 1.8);
      if (clips.Run) clips.Run.timeScale = clamp(speed / RUN_CLIP_SPEED, 0.6, 1.8);
      mixer.update(dt);
    } else {
      const t = performance.now() * 0.001;
      const swing = Math.sin(t * (4 + speed * 1.3)) * Math.min(0.6, speed * 0.13);
      this.mesh.userData.legs[0].rotation.x = swing;
      this.mesh.userData.legs[1].rotation.x = -swing;
      this.mesh.userData.arms[0].rotation.x = -swing * 0.5;
    }

    // Aim the gun at whatever we are shooting at.
    if (this.target && (this.state === ST.SHOOT || this.state === ST.NADE)) {
      const dy = this.target.pos.y - this.eye.y;
      const dh = Math.hypot(this.target.pos.x - this.body.position.x, this.target.pos.z - this.body.position.z);
      const pitch = clamp(Math.atan2(dy, dh), -1.1, 1.1);
      this.gunMesh.rotation.x = pitch;
      if (this.mesh.userData.arms) this.mesh.userData.arms[1].rotation.x = -pitch;
    } else {
      this.gunMesh.rotation.x = lerp(this.gunMesh.rotation.x, 0, Math.min(1, 6 * dt));
    }
  }

  /* ------------------------------ death ------------------------------ */

  die() {
    this.alive = false;
    this.state = ST.DEAD;
    this.deathTimer = 0;
    this.setPlanarVelocity(0, 0);
    this.body.collisionResponse = false;
    this.plate.root.style.display = 'none';
    this.blip.visible = false;
    this.dropWeapon();
  }

  dropWeapon() { spawnPickup(this.body.position, this.weaponId); }

  respawn(at) {
    this.alive = true;
    this.health = 100;
    this.state = ST.SPAWN;
    this.stateTime = 0;
    this.target = null; this.hasLOS = false; this.path = null;
    this.weaponId = pick(BOT_GUN_IDS);
    this.mag = WEAPON_BY_ID[this.weaponId].mag;
    this.reloading = 0;
    this.nadeCd = rand(6, 16);
    this.body.collisionResponse = true;
    this.body.velocity.set(0, 0, 0);
    this.body.position.set(at.x, at.y + 0.5, at.z);
    this.body.wakeUp();

    this.mesh.remove(this.gunMesh);
    this.gunMesh = buildBotGun(this.weaponId);
    this.gunMesh.position.copy(this.gunAnchor());
    this.mesh.add(this.gunMesh);
    this.mesh.rotation.x = 0;
    this.mesh.visible = true;
    this.mesh.traverse((o) => { if (o.isMesh) { o.material.opacity = 1; o.material.transparent = false; } });
    this.blip.visible = true;
    this.plate.root.style.display = '';
    this.updateTransforms();
  }
}

/** A gunshot is audible: everyone close enough who is not already engaged perks up. */
function alertBots(origin, shooter) {
  for (const b of bots) {
    if (!b.alive || b === shooter) continue;
    if (b.body.position.distanceTo(origin) > 20) continue;
    if (b.state === ST.SHOOT || b.state === ST.CHASE || b.state === ST.NADE) continue;
    b.lastKnown.set(origin.x, 1.0, origin.z);
    b.setState(ST.ALERT);
  }
}

/**
 * Compile every shader up front. three.js compiles a material's program the first time it is
 * actually rendered, so without this the first grenade, the first time a bot walks on screen
 * and the first particle burst each cost a compile stall in the middle of a fight. Calling it
 * behind the loading screen and again at match start moves that cost somewhere harmless.
 */
function warmUpShaders() {
  // Light every slot briefly: a material's program depends on how many lights are active, so
  // compiling with the pool dark would produce a different permutation than gameplay uses.
  const saved = lightSlots.map((l) => l.intensity);
  for (const l of lightSlots) if (l.intensity === 0) l.intensity = 0.001;

  // compile() walks the scene with traverseVisible and needs current world matrices, so make
  // sure everything is both visible and up to date first. Anything skipped here compiles on
  // the frame it first appears instead — which is a ~70 ms hitch in the middle of a fight.
  const hidden = [];
  for (const c of ammoChests) if (!c.mesh.visible) { c.mesh.visible = true; hidden.push(c.mesh); }
  for (const c of consumables) if (!c.mesh.visible) { c.mesh.visible = true; hidden.push(c.mesh); }
  scene.updateMatrixWorld(true);
  vmScene.updateMatrixWorld(true);

  renderer.compile(scene, camera);
  renderer.compile(vmScene, vmCamera);

  // compile() only covers what it can reach; actually drawing a frame is what proves it. This
  // runs behind the loading screen or at match start, so the cost is invisible.
  const vw = vmRig.visible;
  vmRig.visible = true;
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(vmScene, vmCamera);
  vmRig.visible = vw;

  for (const m of hidden) m.visible = false;
  lightSlots.forEach((l, i) => { l.intensity = saved[i]; });

  // Touch every particle slot once so the attribute buffers are allocated and uploaded now.
  // Without this the first explosion pays a ~130 ms upload even though nothing recompiles.
  for (const pool of [particlesAdd, particlesNorm]) {
    for (let i = 0; i < pool.capacity; i++) {
      pool.emit({ x: 0, y: -500, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1, size: 0.01, life: 0.001, gravity: 0, drag: 0 });
    }
    pool.update(0.002);      // expires them all and returns every slot
  }
}

/**
 * Push the current settings into the renderer, cameras and light budget.
 *
 * Toggling shadowMap.enabled does force a one-time shader recompile — that is unavoidable,
 * but it happens in the settings panel where a hitch costs nothing, unlike the mid-fight
 * recompiles the light pool exists to prevent.
 */
function applySettings() {
  const q = QUALITY[settings.quality];

  renderer.shadowMap.enabled = q.shadows;
  rigSun.castShadow = q.shadows;
  if (rigSun.shadow.mapSize.x !== q.shadowMap) {
    rigSun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    // The old depth texture has to go or three keeps rendering at the previous size.
    rigSun.shadow.map?.dispose();
    rigSun.shadow.map = null;
  }
  renderer.shadowMap.needsUpdate = true;

  renderer.setPixelRatio(Math.min(devicePixelRatio, q.maxPixelRatio));
  renderScale = q.renderScale;
  resizeRenderer();

  activeLightBudget = q.lights;
  CONFIG.MAX_DECALS = q.decals;

  camera.fov = HIP_FOV;         // updateCamera() overrides this every frame; set for first render
  camera.updateProjectionMatrix();
  // The viewmodel camera keeps a narrower FOV: originally framed the gun at 72 against HIP 78.
  vmCamera.fov = 72;
  vmCamera.updateProjectionMatrix();

  Audio.setVolume?.(settings.masterVolume);
  applyCrosshairStyle();
  saveSettings();
}

let renderScale = 1;

function resizeRenderer() {
  const w = Math.max(320, Math.round(innerWidth * renderScale));
  const h = Math.max(240, Math.round(innerHeight * renderScale));
  renderer.setSize(w, h, false);              // false: let CSS stretch it back to full size
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  vmCamera.aspect = innerWidth / innerHeight;
  vmCamera.updateProjectionMatrix();
  particlesAdd.mat.uniforms.uScale.value = h * 0.5;
  particlesNorm.mat.uniforms.uScale.value = h * 0.5;
}

/** Drop any lock bots already had on a combatant — used when it respawns elsewhere, so
 *  nobody keeps shooting at the coordinates of a corpse (or at your new spawn). */
function clearAlertsOn(who) {
  for (const b of bots) {
    if (b.target === who) { b.target = null; b.hasLOS = false; }
  }
}

/** Spawn as far as possible from every living enemy. */
function pickSpawn(forTeam) {
  let best = spawnPoints[0], bestScore = -Infinity;
  for (const sp of spawnPoints) {
    let score = Infinity;
    for (const c of combatants) {
      if (!c.alive) continue;
      if (forTeam !== TEAM.SOLO && c.team === forTeam) continue;
      score = Math.min(score, c.pos.distanceToSquared(sp));
    }
    if (score === Infinity) score = 1e6;
    score += rand(0, 120);                    // jitter so spawns are not deterministic
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  return best;
}

/* ================================================================== *
 * === EFFECTS ===
 * ================================================================== */

const {
  particlesAdd,
  particlesNorm,
  updateBursts,
  spawnSparks,
  spawnBlood,
  spawnDecal,
  clearDecals,
  spawnExplosion,
  updateExplosionFx,
  spawnSmoke,
  updateSmoke,
  smokeBlocks,
  clearSmoke,
  addShake,
  updateShake,
  shakeOffset: _shakeOff,
} = createEffects({
  scene,
  audio: Audio,
  camera,
  addLightEmitter,
  removeLightEmitter,
  markShared,
  segmentSphere,
});


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
    _spFrom.set(x, spawnCastY, z);
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

function updateAmmoChests(dt) {
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

    if (!player.alive) continue;
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
  if (!el.ammoPrompt) return;
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
    apply(p) {
      if (p.health >= CONFIG.MAX_HEALTH) return false;
      p.health = Math.min(CONFIG.MAX_HEALTH, p.health + this.amount);
      return true;
    },
  },
  shield: {
    label: 'SHIELD', color: 0x4db4ff, amount: 40, respawn: 30,
    apply(p) {
      if (p.armor >= CONFIG.MAX_ARMOR) return false;
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
    _spFrom.set(x, spawnCastY, z);
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

function updateConsumables(dt) {
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

    if (!player.alive) continue;
    const d = c.mesh.position.distanceTo(player.body.position);
    if (d < 2.4) prompt = c.spec.label;
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

function clearEffects() {
  particlesAdd.clear();
  particlesNorm.clear();
  for (const s of shocks) { s.slot.mesh.visible = false; s.slot.busy = false; }
  shocks.length = 0;
  for (const b of blastLights) removeLightEmitter(b.emitter);
  blastLights.length = 0;
  for (const b of brass) vmScene.remove(b.mesh);
  brass.length = 0;
  clearSmoke(); clearDecals(); clearBullets(); clearGrenades(); clearPickups();
}

/* ================================================================== *
 * === MINIMAP ===
 * ================================================================== */

const MAP_PX = 180, MAP_MARGIN = 20;
const _rendererSize = new THREE.Vector2();

/** Player blip: a triangle pointing where the player faces, on the minimap-only layer. */
const playerBlip = (() => {
  const g = new THREE.Group();
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 12),
    new THREE.MeshBasicMaterial({ color: 0x52e08a, depthTest: false }),
  );
  dot.rotation.x = -Math.PI / 2;
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(1.7, 3.8, 3),
    new THREE.MeshBasicMaterial({ color: 0x52e08a, depthTest: false }),
  );
  // Cone points +Y; lay it flat so it points along -Z, then the group yaw aims it.
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0, -2.9);
  g.add(dot, arrow);
  g.traverse((o) => { o.layers.set(L_BLIP); o.renderOrder = 11; });
  g.layers.set(L_BLIP);
  scene.add(g);
  return g;
})();

let spotTimer = 0;

/** Enemies show on the map inside 30 m, or once the player has actually laid eyes on them. */
function updateSpotting(dt) {
  spotTimer -= dt;
  const recheck = spotTimer <= 0;
  if (recheck) spotTimer = 0.25;
  for (const b of bots) {
    if (!b.alive) { b.blip.visible = false; continue; }
    const friendly = player.team !== TEAM.SOLO && b.team === player.team;
    if (friendly) { b.blip.visible = true; continue; }
    const d = b.pos.distanceTo(player.pos);
    if (recheck) {
      if (d < 30) b.spotted = true;
      else if (losClear(player.eye.x, player.eye.y, player.eye.z, b.pos.x, b.pos.y, b.pos.z)
               && !smokeBlocks(player.eye, b.pos)) b.spotted = true;
      else if (d > 42) b.spotted = false;
    }
    b.blip.visible = !!b.spotted;
  }
}

function renderMinimap() {
  const px = player.body.position.x, pz = player.body.position.z;
  // 50 m up keeps every blip inside scene.fog's near plane (55 m), so the map stays crisp
  // without having to swap the fog out and force a shader recompile every frame.
  mapCamera.position.set(px, 50, pz);
  mapCamera.lookAt(px, 0, pz);          // north-up; the player arrow carries the heading
  playerBlip.position.set(px, 0.6, pz);
  playerBlip.rotation.y = player.yaw;

  // setViewport/setScissor work in the renderer's own drawing-buffer units (three applies the
  // pixel ratio itself). With a render scale below 1 those are no longer CSS pixels, so the
  // minimap rectangle has to be scaled to match or it drifts off the corner.
  const size = renderer.getSize(_rendererSize);
  const box = MAP_PX * renderScale;
  const margin = MAP_MARGIN * renderScale;
  const x = size.x - margin - box;
  const y = margin;                    // GL origin is bottom-left

  renderer.setViewport(x, y, box, box);
  renderer.setScissor(x, y, box, box);
  renderer.setScissorTest(true);
  renderer.clear(true, true, false);
  renderer.render(scene, mapCamera);
  renderer.setScissorTest(false);
}

/* ================================================================== *
 * === HUD ===
 * ================================================================== */


/* ================================================================== *
 * === GAME MODES ===
 * ================================================================== */

const MODE_LABEL = { dm: 'DEATHMATCH', tdm: 'TEAM DEATHMATCH', sv: 'SURVIVAL' };

const match = {
  mode: 'dm',
  diff: DIFFICULTY.medium,
  running: false,
  time: 0,
  timeLeft: CONFIG.MATCH_SECONDS,
  scoreA: 0, scoreB: 0,
  kills: 0,
  wave: 1,
  waveBreak: 0,
};

const APP_STATE = Object.freeze({ MENU: 0, PLAYING: 1, PAUSED: 2, SETTINGS: 3 });
let appState = APP_STATE.MENU;

const {
  getElement: $,
  el,
  showHitMarker,
  showToast,
  showDamageDirection,
  applyCrosshairStyle,
  showDamageNumber,
  makePlate,
  updateAllyMarkers,
  allyMarks,
  updatePlates,
  updateVitals,
  updateAmmoHud,
  addKillFeed,
  showBoard,
  refreshBoard,
  showPause,
  updateHudTimers,
} = createHud({
  player,
  bots,
  camera,
  match,
  weapons: WEAPONS,
  currentWeapon,
  losClear,
  modeLabels: MODE_LABEL,
  setAppState: (state) => { appState = state; },
  pausedState: APP_STATE.PAUSED,
});

let nameSeed = 0;
function nextBotName() { return BOT_NAMES[(nameSeed++) % BOT_NAMES.length]; }

function addBot(team) {
  const b = new Bot(nextBotName(), team, match.diff);
  const sp = pickSpawn(team);
  b.body.position.set(sp.x, sp.y + 0.5, sp.z);
  b.updateTransforms();
  bots.push(b);
  combatants.push(b);
  return b;
}

function clearBots() {
  for (const [, m] of allyMarks) m.root.remove();
  allyMarks.clear();
  for (const b of bots) {
    b.dispose();
    const i = combatants.indexOf(b);
    if (i >= 0) combatants.splice(i, 1);
  }
  bots.length = 0;
}

function startMatch(mode, diffKey, name, mapId = getCurrentMapId()) {
  // Rebuilding the level has to happen before any bot is spawned or the player is placed:
  // both read spawnPoints, and switchMap() empties it.
  switchMap(mapId);

  match.mode = mode;
  match.diff = DIFFICULTY[diffKey];
  match.running = true;
  appState = APP_STATE.PLAYING;
  match.time = 0;
  match.timeLeft = CONFIG.MATCH_SECONDS;
  match.scoreA = 0; match.scoreB = 0;
  match.kills = 0; match.wave = 1; match.waveBreak = 0;
  nameSeed = 0;

  player.name = (name || 'PLAYER').toUpperCase().slice(0, 12);
  player.kills = 0; player.deaths = 0;
  player.team = mode === 'tdm' ? TEAM.BLUE : TEAM.SOLO;
  player.current = 'pistol';
  player.cooking = null;
  player.cooldown = 0; player.reloading = 0;
  player.recoilPitch = 0; player.recoilYaw = 0;
  resetPlayerAmmo();

  clearBots();
  clearEffects();
  resetAmmoChests();
  resetConsumables();
  el.feed.innerHTML = '';

  if (mode === 'tdm') {
    for (let i = 0; i < 2; i++) addBot(TEAM.BLUE);
    for (let i = 0; i < 3; i++) addBot(TEAM.RED);
  } else if (mode === 'dm') {
    for (let i = 0; i < match.diff.bots; i++) addBot(TEAM.SOLO);
  } else {
    for (let i = 0; i < 4; i++) addBot(TEAM.RED);
  }

  const playerBlipColor = TEAM_COLOR[player.team];
  playerBlip.traverse((o) => { if (o.material) o.material.color.setHex(playerBlipColor); });

  respawnPlayer(true);
  el.vname.textContent = player.name;
  el.tbMode.textContent = MODE_LABEL[mode];
  el.menu.classList.add('hidden');
  el.hud.classList.remove('hidden');
  updateAmmoHud();
  updateVitals();

  // Bots and their cloned materials only exist now, so compile once more before play starts.
  warmUpShaders();

  Audio.init();
  Audio.startAmbient();
  requestLock();
}

function endMatch(title, sub) {
  match.running = false;
  appState = APP_STATE.MENU;
  showBoard(false);
  showPause(false);
  document.exitPointerLock?.();
  el.hud.classList.add('hidden');
  el.menu.classList.remove('hidden');
  el.menuResult.textContent = `${title} — ${sub}`;
  clearEffects();
}

function respawnPlayer(immediate = false) {
  const sp = pickSpawn(player.team);
  player.body.position.set(sp.x, sp.y + 0.6, sp.z);
  player.body.velocity.set(0, 0, 0);
  player.body.wakeUp();
  player.alive = true;
  player.health = CONFIG.MAX_HEALTH;
  player.armor = CONFIG.START_ARMOR;
  player.respawnTimer = 0;
  player.invulnTimer = SPAWN_INVULN;   // bots ignore you while this runs
  clearAlertsOn(player);               // and drop any lock they already had
  player.cooking = null;
  player.reloading = 0;
  player.cooldown = 0.4;
  resetPlayerAmmo();                  // includes the one-smoke-per-life reset
  player.current = 'pistol';
  player.pitch = 0;
  // Face the middle of the arena, never the wall you happened to spawn against. Forward is
  // (-sin yaw, -cos yaw), so aiming it at the origin from (x, z) gives yaw = atan2(x, z).
  player.yaw = Math.atan2(sp.x, sp.z);
  if (!immediate) showPause(false);
  updateAmmoHud();
  updateVitals();
}

/** The single place a death is booked, for the player and for bots alike. */
function killCombatant(target, source, headshot) {
  if (source && source !== target) {
    source.kills++;
    if (match.mode === 'tdm') {
      // Teamkills do not award score — FF is now blocked in explode() but bullet damage
      // has no team filter, so this guard stays as the authoritative scoring check.
      const teamkill = source.team !== TEAM.SOLO && source.team === target.team;
      if (!teamkill) {
        if (source.team === TEAM.BLUE) match.scoreA++;
        else if (source.team === TEAM.RED) match.scoreB++;
      }
    } else if (match.mode === 'dm') {
      if (source === player) match.scoreA++;
      // scoreB is Red's score in TDM; don't write it here — dmLeader() reads kills directly.
    } else if (source === player) {
      match.kills++;
    }
  }
  target.deaths++;
  addKillFeed(source, target, headshot);

  if (target === player) {
    player.alive = false;
    player.respawnTimer = CONFIG.PLAYER_RESPAWN;
    if (player.cooking) player.cooking = null;
    firing = false;
  } else {
    target.die();
    target.respawnTimer = CONFIG.RESPAWN_DELAY;
  }
  refreshBoard();
  checkWinConditions();
}

/** Single source of truth for the DM leader so HUD, win-check and time-limit agree. */
function dmLeader() {
  return bots.reduce((a, b) => (b.kills > a.kills ? b : a), bots[0] || player);
}

function checkWinConditions() {
  if (!match.running) return;
  if (match.mode === 'dm') {
    if (player.kills >= CONFIG.DM_TARGET) return endMatch('VICTORY', `${player.kills} kills`);
    for (const b of bots) {
      if (b.kills >= CONFIG.DM_TARGET) return endMatch('DEFEAT', `${b.name} reached ${CONFIG.DM_TARGET}`);
    }
  } else if (match.mode === 'tdm') {
    if (match.scoreA >= CONFIG.TDM_TARGET) return endMatch('BLUE TEAM WINS', `${match.scoreA} – ${match.scoreB}`);
    if (match.scoreB >= CONFIG.TDM_TARGET) return endMatch('RED TEAM WINS', `${match.scoreB} – ${match.scoreA}`);
  }
}

function updateMatch(dt) {
  if (!match.running) return;
  match.time += dt;

  if (match.mode === 'sv') {
    // Endless waves: 4 -> 6 -> 8 ... with a short breather between them.
    const anyAlive = bots.some((b) => b.alive);
    if (!anyAlive) {
      if (match.waveBreak <= 0) {
        match.waveBreak = 3.0;
        showToast(`WAVE ${match.wave} CLEARED`);
      } else {
        match.waveBreak -= dt;
        if (match.waveBreak <= 0) {
          match.wave++;
          clearBots();
          const n = 2 + match.wave * 2;
          for (let i = 0; i < n; i++) addBot(TEAM.RED);
          showToast(`WAVE ${match.wave} — ${n} HOSTILES`);
          match.waveBreak = 0;
        }
      }
    }
  } else {
    match.timeLeft -= dt;
    if (match.timeLeft <= 0) {
      match.timeLeft = 0;
      if (match.mode === 'dm') {
        const top = dmLeader();
        if (player.kills > top.kills) endMatch('TIME — VICTORY', `${player.kills} kills`);
        else if (player.kills < top.kills) endMatch('TIME — DEFEAT', `${top.kills} kills`);
        else endMatch('TIME — DRAW', `Tied at ${player.kills} kills`);
      } else {
        if (match.scoreA > match.scoreB) endMatch('TIME — BLUE WINS', `${match.scoreA} – ${match.scoreB}`);
        else if (match.scoreB > match.scoreA) endMatch('TIME — RED WINS', `${match.scoreB} – ${match.scoreA}`);
        else endMatch('TIME — DRAW', `${match.scoreA} – ${match.scoreB}`);
      }
      return;
    }
  }

  // Respawns.
  if (!player.alive) {
    player.respawnTimer -= dt;
    el.pause.classList.add('on');
    el.pBig.textContent = 'ELIMINATED';
    el.pSm.textContent = `RESPAWNING IN ${player.respawnTimer.toFixed(1)}s`;
    // The death screen is not a pause — the resume prompt would just be confusing here.
    el.pCta.style.display = pointerLocked ? 'none' : '';
    if (player.respawnTimer <= 0) {
      respawnPlayer();
      el.pCta.style.display = '';
      if (pointerLocked) el.pause.classList.remove('on');
    }
  }
  for (const b of bots) {
    if (b.alive || match.mode === 'sv') continue;
    if (b.respawnTimer <= 0) b.respawn(pickSpawn(b.team));
  }

  // Top bar.
  if (match.mode === 'sv') {
    el.tbA.textContent = match.kills;
    el.tbB.textContent = `W${match.wave}`;
    el.tbTime.textContent = formatTime(match.time);
  } else if (match.mode === 'tdm') {
    el.tbA.textContent = match.scoreA;
    el.tbB.textContent = match.scoreB;
    el.tbTime.textContent = formatTime(match.timeLeft);
  } else {
    const top = bots.length ? dmLeader() : null;
    el.tbA.textContent = player.kills;
    el.tbB.textContent = top ? top.kills : 0;
    el.tbTime.textContent = formatTime(match.timeLeft);
  }
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/* ================================================================== *
 * === MAIN LOOP ===
 * ================================================================== */

let vmRecoil = 0;
let accumulator = 0;
let lastTime = performance.now() / 1000;

function resumePlay() {
  appState = APP_STATE.PLAYING;
  lastTime = performance.now() / 1000;  // prevent dt spike on resume
  accumulator = 0;
}
const _camPos = new THREE.Vector3();
const _vmTarget = new THREE.Vector3();

function fixedStep(dt) {
  // Bots set their body velocity here — must precede world.step so the solver sees it.
  for (const b of bots) b.simStep(dt);
  stepPlayer(dt);
  world.step(dt);
  stepBullets(dt);
  // Grenade fuse countdown on the same clock as physics (deterministic detonation).
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.bounceCd = Math.max(0, g.bounceCd - dt);
    g.fuse -= dt;
    if (g.fuse <= 0) {
      if (g.kind === 'smoke') spawnSmoke(g.body.position, g.owner);
      else explode(g.body.position, g.owner);
      world.removeBody(g.body);
      scene.remove(g.mesh);
      grenades.splice(i, 1);
    }
  }
}

function updateViewModel(dt) {
  const w = currentWeapon();
  for (const id in vmModels) vmModels[id].visible = (id === w.id) && player.alive;

  const scoped = aiming && w.zoom;
  const home = aiming && !scoped ? VM_ADS : VM_HOME;

  _vmTarget.copy(home);
  // Sway from mouse movement (+/- 0.02 m), plus a walking bob.
  _vmTarget.x += player.sway.x * 0.02;
  _vmTarget.y += player.sway.y * 0.02;
  const planar = Math.hypot(player.body.velocity.x, player.body.velocity.z);
  const bob = settings.viewBob ? Math.min(planar / CONFIG.WALK_SPEED, 1.6) : 0;
  const t = performance.now() * 0.001;
  _vmTarget.x += Math.sin(t * 7) * 0.012 * bob;
  _vmTarget.y += Math.abs(Math.cos(t * 7)) * 0.010 * bob;

  // Reload dip: down 0.3 m, hold, back up — driven off reloadProgress 0..1.
  if (player.reloading > 0) {
    const p = 1 - player.reloading / player.reloadTotal;         // reloadProgress
    const dip = p < 0.25 ? p / 0.25 : (p > 0.75 ? (1 - p) / 0.25 : 1);
    _vmTarget.y -= 0.30 * dip;
    vmRig.rotation.z = -0.5 * dip;
    vmRig.rotation.x = 0.35 * dip;
  } else {
    vmRig.rotation.z = lerp(vmRig.rotation.z, 0, Math.min(1, 14 * dt));
    vmRig.rotation.x = lerp(vmRig.rotation.x, 0, Math.min(1, 14 * dt));
  }

  vmRecoil *= Math.pow(0.0005, dt);
  _vmTarget.z += vmRecoil;                     // kick straight back toward the eye
  vmRig.rotation.x -= vmRecoil * 1.6;
  vmRig.position.lerp(_vmTarget, Math.min(1, 18 * dt));
  vmRig.visible = !scoped && player.alive;     // the scope replaces the model entirely

  // Muzzle flash decay.
  if (flashTimer > 0) {
    flashTimer -= dt;
    const k = clamp(flashTimer / 0.05, 0, 1);
    vmFlash.intensity = 9 * k;
    worldFlash.intensity = 120 * k;
    flashSprite.material.opacity = 0.9 * k;
    flashSprite.scale.setScalar(1 + (1 - k) * 1.4);
  } else {
    vmFlash.intensity = 0; worldFlash.intensity = 0; flashSprite.material.opacity = 0;
  }
}

function updateCamera(dt) {
  const eyeY = CONFIG.EYE_HEIGHT - (player.crouching ? CONFIG.EYE_HEIGHT - CONFIG.CROUCH_HEIGHT : 0);
  _camPos.set(player.body.position.x, player.body.position.y + eyeY, player.body.position.z);
  _camPos.add(_shakeOff);

  _camE.set(player.pitch + player.recoilPitch, player.yaw + player.recoilYaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(_camE);
  // Sway nudges the eye laterally by at most +/- 0.02 m in camera space.
  _v1.set(player.sway.x * 0.02, player.sway.y * 0.02, 0).applyQuaternion(camera.quaternion);
  camera.position.copy(_camPos).add(_v1);

  const w = currentWeapon();
  const scoped = aiming && w.zoom;
  const wantFov = scoped ? w.zoomFov : (aiming ? ADS_FOV : HIP_FOV);
  camera.fov = lerp(camera.fov, wantFov, Math.min(1, 12 * dt));
  camera.updateProjectionMatrix();

  el.scope.classList.toggle('on', scoped);
  el.crosshair.classList.toggle('off', scoped || !player.alive);
}

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now() / 1000;
  let dt = Math.min(now - lastTime, CONFIG.MAX_FRAME_DT);
  lastTime = now;

  if (appState === APP_STATE.PLAYING) {
    pollGamepad(dt);
    applyLook(dt);

    if (player.invulnTimer > 0) player.invulnTimer = Math.max(0, player.invulnTimer - dt);

    // Weapon timers.
    player.cooldown = Math.max(0, player.cooldown - dt);
    if (player.reloading > 0) {
      player.reloading -= dt;
      if (player.reloading <= 0) { player.reloading = 0; finishReload(); updateAmmoHud(); }
    }
    if (player.cooking) {
      player.cookTime -= dt;
      if (player.cookTime <= 0) releaseCook(true);
    }
    if (firing && currentWeapon().auto) tryFire();

    // Fixed-step physics, capped so a stall cannot spiral the accumulator.
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < CONFIG.MAX_SUBSTEPS) {
      fixedStep(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (accumulator > FIXED_DT * CONFIG.MAX_SUBSTEPS) accumulator = 0;

    for (const b of bots) b.renderStep(dt);
    // Sync grenade mesh transforms (fuse/physics handled in fixedStep).
    for (const g of grenades) { g.mesh.position.copy(g.body.position); g.mesh.quaternion.copy(g.body.quaternion); }
    updateBursts(dt);
    updateExplosionFx(dt);
    updateSmoke(dt);
    updateBrass(dt);
    updatePickups(dt);
    updateAmmoChests(dt);
    updatePickupPrompt(updateConsumables(dt));
    if (getCurrentMapId() === 'dungeon') updateDungeonFx(dt);
    updateLights();          // after every emitter has had its chance to move or flicker
    updateShake(dt);
    updateSpotting(dt);
    updateMatch(dt);
    updateViewModel(dt);
    updateCamera(dt);
    updatePlates(dt);
    updateAllyMarkers();
    updateHudTimers(dt);
  }

  // --- render: world, then viewmodel on a cleared depth buffer, then the minimap ---
  renderer.setScissorTest(false);
  const _rs = renderer.getSize(_rendererSize);
  renderer.setViewport(0, 0, _rs.x, _rs.y);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);

  if (match.running && vmRig.visible) {
    renderer.clearDepth();
    renderer.render(vmScene, vmCamera);
  }
  if (match.running) renderMinimap();
}

/* ================================================================== *
 * Boot
 * ================================================================== */

const {
  bindMenu,
  bindSettings,
} = createUiRuntime({
  elements: el,
  getElement: $,
  maps: MAPS,
  audio: Audio,
  startMatch,
  applySettings,
  match,
  setAppState: (state) => { appState = state; },
  settingsState: APP_STATE.SETTINGS,
  requestLock,
  endMatch,
});


async function boot() {
  loadSettings();
  createPlayerBody();
  resetPlayerAmmo();

  el.loading.textContent = 'loading props…';
  const results = await Promise.all(Object.keys(PROP_FILES).map(loadProp));
  const ok = results.filter(Boolean).length;

  // Optional assets. Each resolves to "did it load", and every one of them has a working
  // fallback already in place, so a 404 costs a nicety and never the match.
  const [soldierOk, blasters] = await Promise.all([loadSoldier(), loadBlasterViewModels()]);

  // The level is built only after the GLBs resolve, so every prop uses its model when the
  // file exists and its primitive when it does not — a missing file costs one crate, never
  // the arena. Spawns, nav graph and minimap plan are all carved out of the finished
  // blocker set inside buildMap().
  buildMap('warehouse');
  const spawnStats = { accepted: spawnPoints.length };

  // Force every shader to compile now, while a loading screen is on screen, instead of the
  // first time each material happens to appear mid-fight.
  warmUpShaders();

  el.loading.textContent = ok > 0
    ? `${waypoints.length} nav nodes · ${ok}/${results.length} prop models · ready`
    : `${waypoints.length} nav nodes · procedural props · ready`;
  el.play.disabled = false;
  el.play.textContent = 'DEPLOY';

  // A framed view of the arena sits behind the menu instead of the inside of a platform.
  camera.position.set(-40, 13, 40);
  camera.lookAt(0, 3, 0);

  bindInput();
  bindMenu();
  bindSettings();
  applySettings();

  // Debug handle. Everything in this file is module-scoped, so without this there is no way
  // to inspect or drive the sim from the console (or from an automated smoke test). Local
  // only — it hands out live references to the world and the match, which has no business
  // being reachable on a deployed copy.
  const isLocal = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  if (isLocal) window.__game = {
    player, bots, world, keys, match, startMatch, waypoints, spawnPoints, CONFIG,
    renderer, fixedStep, camera, spawnStats,
    assets: { soldier: soldierOk, blasters, props: `${ok}/${results.length}` },
    ammoChests, particlesAdd, particlesNorm,
    mapBodies, mapLights, mapGroup, blockers, MAPS, switchMap,
    lightSlots, lightEmitters, spawnExplosion, scene,
    settings, applySettings, QUALITY, vmCamera,
    getLightBudget: () => activeLightBudget, ZONE_MULT, BOT_RANGE_BAND, losClear, consumables,
    currentMapId: getCurrentMapId,
    forceUpdatePlates: (dt) => updatePlates(dt),
    // Everything that normally runs once per rendered frame, so a headless soak test can
    // exercise the same code paths the real loop does.
    forceRenderTick: (dt) => {
      updateBursts(dt); updateExplosionFx(dt); updateSmoke(dt); updateBrass(dt);
      updatePickups(dt); updateAmmoChests(dt); updateConsumables(dt);
      updateShake(dt); updateSpotting(dt); updateMatch(dt); updateLights();
    },
    forceUpdateConsumables: (dt) => updateConsumables(dt),
  };

  frame();
}

boot();






