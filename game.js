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
import { createAudio } from './src/audio.js';
import {
  BOT_NAMES,
  BOT_RANGE_BAND,
  DIFFICULTY,
  createBotRuntime,
} from './src/bots.js';
import { createEffects } from './src/effects.js';
import { createHud } from './src/hud.js';
import { createMapController, createMapRuntime } from './src/maps.js';
import {
  mapBodies,
  world,
} from './src/physics.js';
import { markShared } from './src/rendering.js';
import {
  ZONE_MULT,
  createProjectileRuntime,
} from './src/projectiles.js';
import { createPickupRuntime } from './src/pickups.js';
import { createPlayerRuntime, createPlayerState } from './src/player.js';
import { createUiRuntime } from './src/ui.js';
import {
  ADS_FOV,
  CONFIG,
  FIXED_DT,
  HIP_FOV,
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
import { lerp, rand } from './src/utils.js';
import {
  WEAPON_BY_ID,
  WEAPONS,
  createWeaponPresentation,
} from './src/weapons.js';

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
  losClear,
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
  clearMapItems: () => clearMapPickups(),
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

const {
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
} = createWeaponPresentation({ scene, vmScene, modelLoader });


/* ================================================================== *
 * === PLAYER ===
 * ================================================================== */


const player = createPlayerState();
combatants.push(player);

const {
  clearBullets,
  stepBullets,
  fireWeapon,
  throwGrenade,
  clearGrenades,
  explode,
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
  currentWeapon: (...args) => currentWeapon(...args),
  losClear,
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
  currentWeapon,
  startReload,
  finishReload,
  switchWeapon,
  tryFire,
  startCook,
  releaseCook,
  bindInput,
  requestLock,
  pollGamepad,
  applyLook,
  cameraEuler: _camE,
  isAiming,
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
  explode,
  spawnSmoke,
  throwGrenade,
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
    stopFiring();
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
    el.pCta.style.display = isPointerLocked() ? 'none' : '';
    if (player.respawnTimer <= 0) {
      respawnPlayer();
      el.pCta.style.display = '';
      if (isPointerLocked()) el.pause.classList.remove('on');
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
  stepGrenades(dt);
}

function updateViewModel(dt) {
  const w = currentWeapon();
  for (const id in vmModels) vmModels[id].visible = (id === w.id) && player.alive;

  const aiming = isAiming();
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

  updateMuzzleFlash(dt);
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
  const aiming = isAiming();
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

    for (const b of bots) b.renderStep(dt);
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






