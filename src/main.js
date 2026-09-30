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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createAudio } from './audio.js';
import {
  AIM,
  BOT_RANGE_BAND,
  DIFFICULTY,
  aimProfile,
  createBotRuntime,
} from './bots.js';
import { createEffects } from './effects.js';
import { createHud } from './hud.js';
import { createMapController, createMapRuntime } from './maps.js';
import {
  APP_STATE,
  MODE_LABEL,
  createMatchRuntime,
  createMatchState,
} from './match.js';
import {
  mapBodies,
  world,
} from './physics.js';
import { IDLE_FPS, createFrameGate, createResScaler } from './perf.js';
import { markShared } from './rendering.js';
import {
  ZONE_MULT,
  createProjectileRuntime,
} from './projectiles.js';
import { createPickupRuntime } from './pickups.js';
import { createPlayerRuntime, createPlayerState } from './player.js';
import { createUiRuntime } from './ui.js';
import { createLocker } from './locker.js';
import { loadLoadout, saveLoadout, validLoadout } from './loadout.js';
import {
  ADS_FOV,
  CONFIG,
  FIXED_DT,
  HIP_FOV,
  TEAM,
} from './config.js';
import {
  QUALITY,
  loadSettings,
  saveSettings,
  settings,
} from './settings.js';
import { clamp, lerp, rand } from './utils.js';
import {
  WEAPON_BY_ID,
  WEAPONS,
  createWeaponPresentation,
  playerSpread,
  recoilStep,
} from './weapons.js';

// Character and viewmodel assets use their own loader; map props are owned by src/maps.js.
const modelLoader = new GLTFLoader();

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

/**
 * Settings are read before the renderer exists because two of them cannot be changed
 * afterwards: `antialias` and `powerPreference` are fixed when the WebGL context is created.
 * Both matter most on the machine this is aimed at — MSAA at native resolution is expensive on
 * an integrated GPU, and 'high-performance' asks a dual-GPU laptop to spin up its discrete card
 * and keep it running. The settings panel says these two apply on reload.
 */
loadSettings();
const bootQuality = QUALITY[settings.quality];

const renderer = new THREE.WebGLRenderer({
  antialias: bootQuality.antialias,
  powerPreference: settings.powerSaver ? 'low-power' : 'high-performance',
});
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
/**
 * Shadow maps are refreshed explicitly, once per frame, immediately before the world pass.
 *
 * Left on autoUpdate, three re-renders every shadow map on every render() call — and this game
 * makes three of those per frame. The minimap is the expensive mistake: it renders the same
 * `scene` from above through a layer mask, so it was paying for a second full shadow pass every
 * frame to draw a 150 px floor plan that contains no shadows at all.
 */
renderer.shadowMap.autoUpdate = false;
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
/**
 * Image-based light for the guns. Blued steel and black polymer are nearly black under direct
 * light alone — what makes them read as metal and plastic is what they reflect. A small studio
 * environment, prefiltered once at boot, gives every edge a highlight to catch.
 */
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  vmScene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  vmScene.environmentIntensity = 0.85;
  pmrem.dispose();
}
vmScene.add(new THREE.AmbientLight(0x8fa6bd, 0.35));
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
  losClear,
  findPath,
  buildArena,
  placeArenaProps,
  buildSpawnPoints,
  buildDungeonMap,
  buildFoundryMap,
  foundryHalf,
  foundryCeil,
  loadPort,
  buildPortMap,
  portReady,
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
  clearMapItems: () => clearMapPickups(),
});

const {
  MAPS,
  buildMap,
  switchMap,
  currentMapId: getCurrentMapId,
  defaultMapId,
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
  buildFoundryMap,
  foundryHalf,
  foundryCeil,
  buildPortMap,
  portReady,
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

const {
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
} = createWeaponPresentation({ scene, vmScene });


/* ================================================================== *
 * === PLAYER ===
 * ================================================================== */


const player = createPlayerState();
combatants.push(player);

const {
  bullets,
  clearBullets,
  stepBullets,
  fireWeapon,
  grenades,
  throwGrenade,
  clearGrenades,
  predictThrow,
  showThrowArc,
  stepGrenades,
  syncGrenades,
} = createProjectileRuntime({
  scene,
  camera,
  getPlayer: () => player,
  combatants,
  Audio,
  spawnBlood: (...args) => spawnBlood(...args),
  applyDamage: (...args) => applyDamage(...args),
  spawnDecal: (...args) => spawnDecal(...args),
  spawnSparks: (...args) => spawnSparks(...args),
  alertBots: (...args) => alertBots(...args),
  spawnExplosion: (...args) => spawnExplosion(...args),
  losClear,
  addShake: (...args) => addShake(...args),
  spawnSmoke: (...args) => spawnSmoke(...args),
});



const {
  bots,
  Bot,
  loadSoldier,
  loadedCharacters,
  buildCharacterMesh,
  registerBotClips,
  botClipNames,
  buildBotGun,
  alertBots,
} = createBotRuntime({
  scene,
  camera,
  modelLoader,
  blipLayer: L_BLIP,
  combatants,
  waypoints,
  findPath,
  losClear,
  smokeBlocks: (...args) => smokeBlocks(...args),
  fireWeapon,
  throwGrenade,
  pickSpawn: (...args) => pickSpawn(...args),
  spawnPickup: (...args) => spawnPickup(...args),
  makePlate: (...args) => makePlate(...args),
  Audio,
});

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
  baseRenderScale = q.renderScale;
  // A different preset is a different performance situation, so re-probe from the preset's own
  // resolution instead of inheriting a scale the previous one needed.
  resScaler.restore();
  applyRenderScale();

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

/**
 * Effective render scale: the quality preset's own value times whatever the adaptive scaler has
 * settled on. This single number is what resizeRenderer, the minimap rectangle and the particle
 * point size all derive from, so the three cannot disagree.
 */
let renderScale = 1;
let baseRenderScale = 1;
/** Scale of the corner HUD panels, and of the minimap drawn inside #mapframe. See resizeRenderer. */
let hudScale = 1;

const frameGate = createFrameGate();
const resScaler = createResScaler();

function applyRenderScale() {
  renderScale = baseRenderScale * resScaler.scale;
  resizeRenderer();
}

function resizeRenderer() {
  // The corner panels are sized for a ~1280x720 window and scale down below it (the CSS applies
  // this as `zoom`). The minimap is drawn by WebGL, not CSS, so renderMinimap reads it too.
  hudScale = clamp(Math.min(innerWidth / 1280, innerHeight / 720), 0.62, 1);
  document.documentElement.style.setProperty('--hud-scale', String(hudScale));
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
  clearEffectPools,
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
});

const {
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
} = createPickupRuntime({
  scene,
  camera,
  player,
  Audio,
  buildBotGun: (...args) => buildBotGun(...args),
  currentWeapon: (...args) => currentWeapon(...args),
  inBlocker,
  getSpawnCastY: () => spawnCastY,
  addLightEmitter,
  removeLightEmitter,
  showToast: (...args) => showToast(...args),
  updateAmmoHud: (...args) => updateAmmoHud(...args),
  updateVitals: (...args) => updateVitals(...args),
  getHudElements: () => el,
});


function clearEffects() {
  clearEffectPools();
  clearBrass();
  clearBullets();
  clearGrenades();
  clearPickups();
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
  const box = MAP_PX * hudScale * renderScale;
  const margin = MAP_MARGIN * hudScale * renderScale;
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

const match = createMatchState();
let appState = APP_STATE.MENU;

const {
  getElement: $,
  el,
  showHitMarker,
  showKillBanner,
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
  currentWeapon: (...args) => currentWeapon(...args),
  losClear,
  isAiming: (...args) => isAiming(...args),
  modeLabels: MODE_LABEL,
  setAppState: (state) => { appState = state; },
  pausedState: APP_STATE.PAUSED,
});

const {
  keys,
  createPlayerBody,
  resetPlayerAmmo,
  applyDamage,
  stepPlayer,
  syncPlayerPoints,
  resetStance,
  currentWeapon,
  startReload,
  finishReload,
  switchWeapon,
  tryFire,
  startCook,
  updateThrowPreview,
  bindInput,
  requestLock,
  pollGamepad,
  applyLook,
  cameraEuler: _camE,
  isAiming,
  setAiming,
  isFiring,
  isPointerLocked,
  isGamepadActive,
  stopFiring,
} = createPlayerRuntime({
  player,
  renderer,
  camera,
  Audio,
  getMatch: () => match,
  getAppState: () => appState,
  playingState: APP_STATE.PLAYING,
  pausedState: APP_STATE.PAUSED,
  resumePlay: (...args) => resumePlay(...args),
  respawnPlayer: (...args) => respawnPlayer(...args),
  killCombatant: (...args) => killCombatant(...args),
  showDamageDirection,
  addShake,
  showHitMarker,
  showKillBanner,
  showDamageNumber,
  updateAmmoHud,
  showBoard,
  showPause,
  vmModels,
  fireWeapon,
  triggerMuzzleFlash,
  ejectBrass,
  addViewModelRecoil: (amount) => { vmRecoil += amount; },
  losClear,
  smokeBlocks: (...args) => smokeBlocks(...args),
  // Aim assist needs to know who is shootable. Bots only — there is one player.
  getEnemies: () => bots,
  throwGrenade,
  showThrowArc,
});


const {
  addBot,
  clearBots,
  startDuelRound,
  startMatch,
  endMatch,
  respawnPlayer,
  killCombatant,
  dmLeader,
  checkWinConditions,
  updateMatch,
  updateOutro,
  formatTime,
} = createMatchRuntime({
  match,
  player,
  bots,
  Bot,
  combatants,
  allyMarks,
  pickSpawn,
  spawnPoints,
  switchMap,
  getCurrentMapId,
  setAppState: (state) => { appState = state; },
  resetPlayerAmmo,
  syncPlayerPoints,
  resetStance,
  clearEffects,
  resetAmmoChests,
  resetConsumables,
  playerBlip,
  warmUpShaders,
  Audio,
  requestLock,
  showBoard,
  showPause,
  showToast,
  updateAmmoHud,
  updateVitals,
  addKillFeed,
  refreshBoard,
  clearAlertsOn,
  stopFiring,
  isPointerLocked,
  elements: el,
});

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
const _v1 = new THREE.Vector3();

function fixedStep(dt) {
  // Every moving body's position before this step, so frames can be drawn between the two.
  player.prevBodyPos.copy(player.body.position);
  for (const b of bots) b.prevBodyPos.copy(b.body.position);
  // Bots set their body velocity here — must precede world.step so the solver sees it.
  for (const b of bots) b.simStep(dt);
  stepPlayer(dt);
  world.step(dt);
  stepBullets(dt);
  stepGrenades(dt);
}

/** 0 at the hip, 1 fully aimed. Eased, so the gun travels up to the eye rather than snapping. */
let vmAds = 0;
let vmReload = 0;
const _vmHip = new THREE.Vector3();
const _vmAim = new THREE.Vector3();

function updateViewModel(dt) {
  const w = currentWeapon();
  for (const id in vmModels) vmModels[id].visible = (id === w.id) && player.alive;

  const aiming = isAiming();
  const scoped = aiming && w.zoom;
  vmAds += ((aiming && !scoped ? 1 : 0) - vmAds) * (1 - Math.exp(-dt * 16));
  const hip = 1 - vmAds;

  // Hip and aimed positions, blended. The aimed one puts this gun's own sight on the axis.
  _vmHip.copy(VM_HOME[w.id] ?? VM_HOME.ar);
  adsPosition(w.id, _vmAim);
  _vmTarget.lerpVectors(_vmHip, _vmAim, vmAds);

  // Sway from mouse movement and a walking bob — both mostly gone when aimed, or the sight
  // would wander off the thing you are aiming at.
  const swayK = 0.02 * (0.25 + 0.75 * hip);
  _vmTarget.x += player.sway.x * swayK;
  _vmTarget.y += player.sway.y * swayK;
  const planar = Math.hypot(player.body.velocity.x, player.body.velocity.z);
  const bob = (settings.viewBob ? Math.min(planar / CONFIG.WALK_SPEED, 1.6) : 0) * (0.15 + 0.85 * hip);
  const t = performance.now() * 0.001;
  _vmTarget.x += Math.sin(t * 7) * 0.008 * bob;
  _vmTarget.y += Math.abs(Math.cos(t * 7)) * 0.007 * bob;
  // Landing: the gun dips with the camera and comes back a beat later.
  if (player.landTime < 0.35) _vmTarget.y -= player.landKick * 0.35 * Math.sin(Math.PI * player.landTime / 0.35);

  // Reload: down and rolled in, held, back up — driven off the reload's progress.
  let dip = 0;
  if (player.reloading > 0) {
    const p = 1 - player.reloading / player.reloadTotal;
    dip = p < 0.25 ? p / 0.25 : (p > 0.75 ? (1 - p) / 0.25 : 1);
  }
  vmReload += (dip - vmReload) * (1 - Math.exp(-dt * 14));
  _vmTarget.y -= 0.12 * vmReload;

  // Recoil: straight back into the shoulder, muzzle up, decaying fast.
  vmRecoil *= Math.pow(0.0005, dt);
  _vmTarget.z += vmRecoil * 0.6;
  vmRig.position.copy(_vmTarget);
  // The three-quarter hip presentation, which must be exactly zero when aimed so the sight
  // line stays on the axis.
  vmRig.rotation.set(
    -0.02 * hip + 0.35 * vmReload - vmRecoil * 1.1,
    0.07 * hip,
    0.03 * hip - 0.5 * vmReload,
  );
  vmRig.visible = !scoped && player.alive;     // the scope replaces the model entirely

  updateMuzzleFlash(dt);
}

/**
 * How far the physics accumulator is into the next fixed step, 0..1, set once per frame.
 * Everything that moves is drawn this far between its last two physics states — see
 * Bot.placeMesh for why that matters.
 */
let renderAlpha = 1;
const _renderBody = new THREE.Vector3();

// Smoothed camera height: eye height above the body, and the body's own height while grounded.
let camEye = CONFIG.EYE_HEIGHT;
let camBodyY = null;

function updateCamera(dt) {
  // Interpolated body position, snapping rather than smearing across a respawn.
  const bp = player.body.position, pp = player.prevBodyPos;
  if (pp.distanceToSquared(bp) > 4) _renderBody.set(bp.x, bp.y, bp.z);
  else _renderBody.set(pp.x + (bp.x - pp.x) * renderAlpha, pp.y + (bp.y - pp.y) * renderAlpha,
    pp.z + (bp.z - pp.z) * renderAlpha);

  /**
   * Vertical smoothing. Crouching used to drop the eye 0.77 m in a single frame, and stepOver()
   * lifts the body onto a ledge in a single physics step — both read as the camera jolting.
   * The eye height eases toward its target, and while grounded so does the body height, which
   * spreads a step-up over ~50 ms. Airborne it follows exactly: a jump must never lag, and a
   * large change (spawning, a long drop) snaps.
   */
  const wantEye = CONFIG.EYE_HEIGHT - (player.crouching ? CONFIG.EYE_HEIGHT - CONFIG.CROUCH_HEIGHT : 0);
  camEye += (wantEye - camEye) * (1 - Math.exp(-dt * 16));
  if (camBodyY === null || !player.grounded || Math.abs(_renderBody.y - camBodyY) > 0.8) {
    camBodyY = _renderBody.y;
  } else {
    camBodyY += (_renderBody.y - camBodyY) * (1 - Math.exp(-dt * 22));
  }
  // Landing dip: the knees take a hard landing, so the eye drops and comes back over ~0.3 s.
  const LAND_DIP_T = 0.3;
  const dip = player.landTime < LAND_DIP_T ? player.landKick * Math.sin(Math.PI * player.landTime / LAND_DIP_T) : 0;
  _camPos.set(_renderBody.x, camBodyY + camEye - dip, _renderBody.z);
  _camPos.add(_shakeOff);

  _camE.set(player.pitch + player.recoilPitch, player.yaw + player.recoilYaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(_camE);
  // Sway nudges the eye laterally by at most +/- 0.02 m in camera space.
  _v1.set(player.sway.x * 0.02, player.sway.y * 0.02, 0).applyQuaternion(camera.quaternion);
  camera.position.copy(_camPos).add(_v1);

  const w = currentWeapon();
  const aiming = isAiming();
  const scoped = aiming && w.zoom;
  const wantFov = scoped ? w.zoomFov : (aiming ? ADS_FOV : HIP_FOV);
  camera.fov = lerp(camera.fov, wantFov, Math.min(1, 12 * dt));
  camera.updateProjectionMatrix();

  el.scope.classList.toggle('on', scoped);
  el.crosshair.classList.toggle('off', scoped || !player.alive);
}

/**
 * Seconds per rendered frame being aimed at right now.
 *
 * Menus deliberately get IDLE_FPS. Nothing in the world updates while a menu is up — the whole
 * update block below is skipped — so redrawing a frozen scene at the panel's refresh rate is
 * pure battery burn, and 1/15 s is still instant to the eye.
 */
function frameBudget() {
  if (appState !== APP_STATE.PLAYING) return 1 / IDLE_FPS;
  return settings.frameCap > 0 ? 1 / settings.frameCap : 0;
}

let framesDrawn = 0;
let shadowFrame = 0;
const OUTRO_TIME_SCALE = 0.3;

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now() / 1000;
  const budget = frameBudget();
  // Under the cap for this refresh: draw nothing and, crucially, update nothing. lastTime is
  // left alone, so the time this frame represented is still handed to the physics accumulator
  // by the next frame that does run — capping the render rate must not slow the simulation.
  if (!frameGate.shouldRun(now, budget)) return;
  framesDrawn++;

  const interval = now - lastTime;
  let dt = Math.min(interval, CONFIG.MAX_FRAME_DT);
  lastTime = now;

  // Dynamic resolution, measured on frames actually drawn. Only steady-state play is a fair
  // sample: a menu frame, or the first frame after a pause, says nothing about cost.
  if (settings.adaptiveRes && appState === APP_STATE.PLAYING) {
    if (resScaler.sample(interval, budget || 1 / 60) !== null) applyRenderScale();
  } else {
    resScaler.reset();
  }

  if (appState === APP_STATE.PLAYING) {
    // The end-of-match outro: the world runs slowed, its timer runs on real time.
    const realDt = dt;
    if (match.outro) dt *= OUTRO_TIME_SCALE;
    pollGamepad(dt);
    applyLook(realDt);

    if (player.invulnTimer > 0) player.invulnTimer = Math.max(0, player.invulnTimer - dt);

    // Weapon timers. The fire cooldown carries its overshoot past zero into the next shot,
    // because it is polled once per rendered frame: without the carry, a 30 fps cap rounds the
    // AR's 0.09 s cooldown up to 0.1 s and the player quietly loses a tenth of their rate of
    // fire to a graphics setting, while the bots — which fire on the fixed clock — keep all of
    // theirs. The carry is at most one frame, so it can never bank rounds.
    if (player.cooldown > 0) {
      player.cooldown -= dt;
      player.fireCarry = player.cooldown < 0 ? -player.cooldown : 0;
      if (player.cooldown < 0) player.cooldown = 0;
    }
    if (player.reloading > 0) {
      player.reloading -= dt;
      if (player.reloading <= 0) { player.reloading = 0; finishReload(); updateAmmoHud(); }
    }
    if (isFiring() && currentWeapon().auto) tryFire();

    // Fixed-step physics, capped so a stall cannot spiral the accumulator.
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < CONFIG.MAX_SUBSTEPS) {
      fixedStep(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (accumulator > FIXED_DT * CONFIG.MAX_SUBSTEPS) accumulator = 0;
    renderAlpha = accumulator / FIXED_DT;

    for (const b of bots) b.renderStep(dt, renderAlpha);
    syncGrenades();
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
    updateThrowPreview(dt);
    updatePlates(dt);
    updateAllyMarkers();
    updateHudTimers(dt);
    updateOutro(realDt);
  }

  // The one shadow refresh of the frame (see renderer.shadowMap.autoUpdate), halved in battery
  // saver. A 30 Hz shadow update against walking bots is not something you can see, and shadows
  // are the single most expensive thing in the frame.
  shadowFrame++;
  renderer.shadowMap.needsUpdate = !settings.powerSaver || (shadowFrame & 1) === 0;

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
  defaultMap: defaultMapId,
  audio: Audio,
  startMatch,
  applySettings,
  match,
  setAppState: (state) => { appState = state; },
  settingsState: APP_STATE.SETTINGS,
  requestLock,
  endMatch,
});


// The locker opens from the lobby and from the pause screen. A change applies at once: keys
// 1-4 follow it, and if the gun in your hands was taken out you are handed slot 1.
player.loadout = loadLoadout();
const locker = createLocker({
  getLoadout: () => player.loadout,
  setLoadout: (list) => {
    if (!validLoadout(list)) return;
    player.loadout = list;
    saveLoadout(list);
    if (player.current !== 'frag' && !list.includes(player.current)) switchWeapon(list[0]);
    if (match.running) updateAmmoHud();
  },
  onOpen: () => {
    document.exitPointerLock?.();
    if (match.running) appState = APP_STATE.SETTINGS;
  },
  onClose: () => { if (match.running) requestLock(); },
});
$('locker-open')?.addEventListener('click', () => locker.open());
$('locker-open-pause')?.addEventListener('click', () => locker.open());

/**
 * Load optional extra bot animation clips.
 *
 * Driven by assets/bots/anim/manifest.json, a flat map of clip name to file, e.g.
 *   { "StrafeLeft": "strafe-left.fbx", "Death": "death.glb" }
 * Names must be ones the rig binds (see botClipNames); anything else is ignored.
 *
 * The rig in soldier.glb is stock Mixamo, and retargeting is by track name, so a clip
 * exported against any Mixamo skeleton binds to it directly with no bone remapping. Mixamo
 * serves FBX, which needs its own loader, so that is imported lazily — there is no point
 * paying for FBXLoader on a machine that has no clips to load.
 *
 * Every failure path here is non-fatal and silent by design, exactly like loadProp: no
 * manifest, an unreadable file or an unknown clip name each cost one animation, never the
 * match. The names that did load are reported on window.__game.assets.anims.
 */
async function loadBotAnimations() {
  let manifest;
  try {
    const resp = await fetch('./assets/bots/anim/manifest.json');
    if (!resp.ok) return [];
    manifest = await resp.json();
  } catch {
    return [];                                  // no manifest is the normal case
  }
  if (!manifest || typeof manifest !== 'object') return [];

  let FBXLoader = null;
  const clips = {};

  for (const [name, file] of Object.entries(manifest)) {
    if (!botClipNames.includes(name) || typeof file !== 'string') continue;
    const url = `./assets/bots/anim/${file}`;
    try {
      if (file.toLowerCase().endsWith('.fbx')) {
        if (!FBXLoader) ({ FBXLoader } = await import('three/addons/loaders/FBXLoader.js'));
        const group = await new FBXLoader().loadAsync(url);
        // Mixamo puts exactly one clip in an FBX; its own name is not useful here.
        if (group.animations?.length) {
          // Track names are left exactly as the exporter wrote them. Matching them to a
          // skeleton is done per character in retargetClips (src/bots.js), against the
          // live bone names rather than an assumed spelling.
          const clip = group.animations[0].clone();
          clip.name = name;
          clips[name] = clip;
        }
      } else {
        const gltf = await modelLoader.loadAsync(url);
        if (gltf.animations?.length) {
          const clip = gltf.animations[0].clone();
          clip.name = name;
          clips[name] = clip;
        }
      }
    } catch {
      // One bad file must not take the rest of the manifest with it.
    }
  }
  return registerBotClips(clips);
}

async function boot() {
  // Settings were already loaded at module scope, before the renderer was built.
  createPlayerBody();
  resetPlayerAmmo();

  el.loading.textContent = 'loading props…';
  const results = await Promise.all(Object.keys(PROP_FILES).map(loadProp));
  const ok = results.filter(Boolean).length;

  // Optional assets. Each resolves to "did it load", and every one of them has a working
  // fallback already in place, so a 404 costs a nicety and never the match.
  const [soldierOk, blasters, portOk] = await Promise.all([loadSoldier(), loadViewModels(), loadPort()]);
  // Extra bot animation clips, if any have been added. Must run after loadSoldier and
  // before the first Bot is constructed, because clips bind at mesh-build time.
  const extraAnims = soldierOk ? await loadBotAnimations() : [];

  // The level is built only after the GLBs resolve, so every prop uses its model when the
  // file exists and its primitive when it does not — a missing file costs one crate, never
  // the arena. Spawns, nav graph and minimap plan are all carved out of the finished
  // blocker set inside buildMap().
  buildMap(defaultMapId());
  const spawnStats = { accepted: spawnPoints.length };

  // Force every shader to compile now, while a loading screen is on screen, instead of the
  // first time each material happens to appear mid-fight.
  warmUpShaders();

  // Ready. (This line used to print nav-node and prop-model counts — debug output, shown to
  // the player. The same numbers are on window.__game for anyone who needs them.)
  el.loading.textContent = '';
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
    renderer, fixedStep, camera, spawnStats, THREE,
    assets: { soldier: soldierOk, blasters, props: `${ok}/${results.length}`, anims: extraAnims,
              characters: loadedCharacters(), port: portOk },
    registerBotClips, botClipNames, buildCharacterMesh,
    ammoChests, particlesAdd, particlesNorm,
    mapBodies, mapLights, mapGroup, blockers, MAPS, switchMap,
    lightSlots, lightEmitters, spawnExplosion, scene,
    settings, applySettings, QUALITY, vmCamera, vmScene, vmRig, vmModels, setAiming,
    getLightBudget: () => activeLightBudget, ZONE_MULT, BOT_RANGE_BAND, losClear, consumables,
    DIFFICULTY, AIM, aimProfile, startDuelRound, fireWeapon, combatants, killCombatant, bullets,
    WEAPONS, WEAPON_BY_ID, playerSpread, recoilStep, tryFire, switchWeapon, throwGrenade, clearGrenades,
    predictThrow, updateThrowPreview, grenades,
    forceHudTick: (dt) => updateHudTimers(dt),
    currentMapId: getCurrentMapId, findPath, respawnPlayer,
    forceUpdatePlates: (dt) => updatePlates(dt),
    // Everything that normally runs once per rendered frame, so a headless soak test can
    // exercise the same code paths the real loop does.
    forceRenderTick: (dt) => {
      updateBursts(dt); updateExplosionFx(dt); updateSmoke(dt); updateBrass(dt);
      updatePickups(dt); updateAmmoChests(dt); updateConsumables(dt);
      updateShake(dt); updateSpotting(dt); updateMatch(dt); updateLights(); updateOutro(dt);
    },
    forceUpdateConsumables: (dt) => updateConsumables(dt),
    // Frame pacing, so a test can prove the cap actually skips frames and that the adaptive
    // scaler actually moves. Functions rather than values: these change every frame.
    perf: {
      frames: () => framesDrawn,
      budget: () => frameBudget(),
      resScale: () => resScaler.scale,
      renderScale: () => renderScale,
    },
  };

  frame();
}

boot();
