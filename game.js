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

/* ================================================================== *
 * === CONFIG ===
 * ================================================================== */

const CONFIG = {
  GRAVITY: -9.82,
  PHYSICS_HZ: 120,
  MAX_SUBSTEPS: 3,
  MAX_FRAME_DT: 0.25,

  // Arena (metres). Outer shell is ARENA half-extent; the inner ring sits at RING.
  ARENA: 50,          // outer wall at +/- 50  => 100 x 100 floor
  RING: 34,           // inner ring wall at +/- 34 => ~68 x 68 plaza
  GAP: 9,             // half-width of the doorway in the middle of each ring wall
  CEIL: 10,

  // Player
  EYE_HEIGHT: 1.6,
  CROUCH_HEIGHT: 0.95,
  PLAYER_RADIUS: 0.5,
  CROUCH_RADIUS: 0.38,
  PLAYER_MASS: 80,
  WALK_SPEED: 5.0,
  SPRINT_MULT: 1.6,
  CROUCH_MULT: 0.5,
  MOVE_ACCEL: 60,
  JUMP_SPEED: 6.4,
  MAX_HEALTH: 100,
  MAX_ARMOR: 100,
  START_ARMOR: 50,
  ARMOR_ABSORB: 0.55,     // fraction of incoming damage soaked by armor

  // Bullets
  MAX_RANGE: 400,
  TRACER_RADIUS: 0.022,
  TRACER_MAX_LEN: 10,

  // Grenades
  FRAG_FUSE: 3.0,
  FRAG_DAMAGE: 80,
  FRAG_RADIUS: 8,
  FRAG_IMPULSE: 900,
  SMOKE_FUSE: 2.0,
  SMOKE_LIFE: 8.0,
  SMOKE_RADIUS: 4.0,

  // Match rules
  DM_TARGET: 20,
  TDM_TARGET: 25,
  MATCH_SECONDS: 300,
  RESPAWN_DELAY: 4.0,
  PLAYER_RESPAWN: 3.0,

  MAX_DECALS: 90,
  SENS: 0.0022,
};

/** Dungeon grid pitch and ceiling, measured from the Kenney Modular Dungeon Kit: every
 *  corridor piece is a 4 x 4 m footprint 4.15 m tall. Declared up here because PROP_FILES
 *  refers to the pitch, and that is evaluated at module load. */
const DUNGEON_TILE = 4;
const DUNGEON_CEIL = 4.15;

/** Seconds of spawn protection. Bots would otherwise have LOS on you before you can move. */
const SPAWN_INVULN = 3.0;

const FIXED_DT = 1 / CONFIG.PHYSICS_HZ;
/** cannon applies damping as v *= (1-d)^dt. We overwrite horizontal velocity every tick,
 *  so damping only ever touches Y — and there it would give a 3 m/s terminal velocity and
 *  a floaty jump. We divide it back out post-step. */
const PLAYER_DAMPING = 0.95;
const DAMP_PER_STEP = Math.pow(1 - PLAYER_DAMPING, FIXED_DT);

const TEAM = { SOLO: 0, BLUE: 1, RED: 2 };
const TEAM_COLOR = { 0: 0x52e08a, 1: 0x4d9dff, 2: 0xff4d4d };

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

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

const DIFFICULTY = {
  easy:   { label: 'EASY',   accuracy: 0.40, reaction: 0.80, bots: 3, aggression: 0.55, fireMult: 1.35 },
  medium: { label: 'MEDIUM', accuracy: 0.65, reaction: 0.50, bots: 4, aggression: 0.75, fireMult: 1.10 },
  hard:   { label: 'HARD',   accuracy: 0.85, reaction: 0.20, bots: 5, aggression: 0.95, fireMult: 1.0 },
};

const BOT_NAMES = [
  'VIPER', 'HAVOC', 'RAZOR', 'GHOST', 'TALON', 'ONYX', 'BRAVO', 'CIPHER',
  'DELTA', 'KILO', 'NOMAD', 'REAPER', 'SABLE', 'VECTOR', 'WRAITH', 'ZERO',
];

/* ================================================================== *
 * === AUDIO ===
 * Everything is synthesised through the WebAudio graph — zero external files.
 * ================================================================== */

const Audio = {
  ctx: null, master: null, noise: null, ambientGain: null, ready: false,

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * 1.0);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.ready = true;
  },

  /** One-shot filtered noise burst. */
  burst({ dur = 0.18, gain = 0.5, type = 'lowpass', freq = 1800, q = 1, decay = null, delay = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rand(0.85, 1.15);
    const flt = this.ctx.createBiquadFilter();
    flt.type = type; flt.frequency.value = freq; flt.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + (decay ?? dur));
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
  },

  /** One-shot pitch-swept oscillator. */
  tone({ f0 = 200, f1 = 40, dur = 0.2, gain = 0.4, type = 'sine', delay = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  /** Distance attenuation for anything that did not happen at the camera. */
  atten(dist) { return clamp(1 - dist / 70, 0.06, 1); },

  gunshot(id, dist = 0) {
    const v = this.atten(dist);
    if (v <= 0.06 && dist > 90) return;
    switch (id) {
      case 'pistol':                                   // sharp crack
        this.burst({ dur: 0.10, gain: 0.42 * v, type: 'highpass', freq: 1400, decay: 0.07 });
        this.tone({ f0: 320, f1: 70, dur: 0.09, gain: 0.30 * v, type: 'square' });
        break;
      case 'ar':                                       // medium, punchy
        this.burst({ dur: 0.13, gain: 0.36 * v, type: 'bandpass', freq: 1100, q: 0.8, decay: 0.09 });
        this.tone({ f0: 240, f1: 55, dur: 0.11, gain: 0.30 * v, type: 'sawtooth' });
        break;
      case 'shotgun':                                  // low boom + long tail
        this.burst({ dur: 0.34, gain: 0.55 * v, type: 'lowpass', freq: 900, decay: 0.28 });
        this.tone({ f0: 150, f1: 32, dur: 0.28, gain: 0.42 * v, type: 'sine' });
        break;
      case 'sniper':                                   // thunderclap: crack then rolling tail
        this.burst({ dur: 0.09, gain: 0.6 * v, type: 'highpass', freq: 2600, decay: 0.05 });
        this.tone({ f0: 420, f1: 40, dur: 0.30, gain: 0.5 * v, type: 'square' });
        this.burst({ dur: 0.6, gain: 0.24 * v, type: 'lowpass', freq: 420, decay: 0.55, delay: 0.04 });
        break;
    }
  },

  explosion(dist = 0) {
    const v = this.atten(dist * 0.55);
    this.tone({ f0: 110, f1: 24, dur: 0.7, gain: 0.7 * v, type: 'sine' });
    this.burst({ dur: 0.8, gain: 0.6 * v, type: 'lowpass', freq: 700, decay: 0.7 });
    this.burst({ dur: 0.25, gain: 0.35 * v, type: 'highpass', freq: 1800, decay: 0.2 });
  },
  pinPull()   { this.burst({ dur: 0.07, gain: 0.3, type: 'bandpass', freq: 3600, q: 6, decay: 0.06 }); },
  bounce(d)   { const v = this.atten(d); this.tone({ f0: 900, f1: 420, dur: 0.06, gain: 0.16 * v, type: 'square' }); },
  step()      { this.burst({ dur: 0.07, gain: 0.09, type: 'lowpass', freq: 420, decay: 0.06 }); },
  hit()       { this.tone({ f0: 1500, f1: 900, dur: 0.05, gain: 0.2, type: 'sine' }); },
  hurt()      { this.burst({ dur: 0.14, gain: 0.3, type: 'lowpass', freq: 500, decay: 0.12 });
                this.tone({ f0: 160, f1: 70, dur: 0.16, gain: 0.2, type: 'sine' }); },
  kill()      { this.tone({ f0: 880, f1: 880, dur: 0.09, gain: 0.22, type: 'triangle' });
                this.tone({ f0: 1320, f1: 1320, dur: 0.16, gain: 0.2, type: 'triangle', delay: 0.07 }); },
  reloadClick(){ this.burst({ dur: 0.05, gain: 0.14, type: 'bandpass', freq: 2400, q: 4, decay: 0.04 }); },
  pickup()    { this.tone({ f0: 660, f1: 1320, dur: 0.14, gain: 0.18, type: 'triangle' }); },
  smokePop(d) { const v = this.atten(d); this.burst({ dur: 0.9, gain: 0.3 * v, type: 'lowpass', freq: 600, decay: 0.85 }); },

  /** Very quiet low-passed white noise bed — the warehouse hum. */
  startAmbient() {
    if (!this.ready || this.ambientGain) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'lowpass'; flt.frequency.value = 40; flt.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.value = 0.0;
    g.gain.linearRampToValueAtTime(0.35, this.ctx.currentTime + 3);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start();
    this.ambientGain = g;
  },
};

/* ================================================================== *
 * === PHYSICS ===
 * ================================================================== */

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, CONFIG.GRAVITY, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
// Sleeping is fatal here: a sleeping body is dropped from the narrowphase, so the player's
// floor contact vanishes from world.contacts and playerGroundCheck() can never see ground
// again. grounded stays false, movement falls back to the 0.22x air-control accel, and the
// player crawls. Dynamic bodies in this game are few, so sleeping buys us nothing anyway.
world.allowSleep = false;
world.defaultContactMaterial.friction = 0.25;
world.defaultContactMaterial.restitution = 0;

const MAT_WORLD = new CANNON.Material('world');
const MAT_BODY = new CANNON.Material('body');
const MAT_NADE = new CANNON.Material('nade');

world.addContactMaterial(new CANNON.ContactMaterial(MAT_WORLD, MAT_NADE, { friction: 0.3, restitution: 0.45 }));
// Character bodies get ZERO friction against the level, and that is load-bearing.
//
// The movement controller writes X/Z velocity directly every tick, so a real friction
// coefficient does not "add grip" — it fights the controller inside the same solver step and
// wins. Measured on flat floor: friction 0.4 capped walking at 0.28 m/s against a 5.0 m/s
// target (6%); friction 0 gives 4.76 m/s, the remainder being linearDamping. It crippled the
// bots identically, since they are velocity-driven too.
//
// The old comment here claimed friction was needed to walk up ramps. It is the reverse:
// climbing the arena ramp from z=18, friction 0 reaches the top (y=3.7) while friction 0.4
// stalls halfway (y=1.91). Deceleration when you release the keys is supplied by the
// controller lerping toward zero, which is far more responsive than contact friction anyway.
world.addContactMaterial(new CANNON.ContactMaterial(MAT_WORLD, MAT_BODY, { friction: 0, restitution: 0 }));
world.addContactMaterial(new CANNON.ContactMaterial(MAT_BODY, MAT_BODY, { friction: 0.0, restitution: 0 }));
world.addContactMaterial(new CANNON.ContactMaterial(MAT_NADE, MAT_BODY, { friction: 0.3, restitution: 0.4 }));

/**
 * Collision groups. Every raycast in the game — bullet-vs-world and line-of-sight — must see
 * only the level, never the bodies of the shooter, the target or a grenade in flight.
 * Group 1 is the level, 2 is a combatant, 4 is thrown ordnance; rays are masked to 1.
 */
const G_WORLD = 1, G_BODY = 2, G_NADE = 4;
const RAY_OPTS = { skipBackfaces: true, collisionFilterGroup: -1, collisionFilterMask: G_WORLD };

/** Every static body the current map owns, so switching maps can take them all back out. */
const mapBodies = [];

function addStaticBox(halfX, halfY, halfZ, pos, quat = null) {
  const body = new CANNON.Body({ mass: 0, material: MAT_WORLD, collisionFilterGroup: G_WORLD });
  body.addShape(new CANNON.Box(new CANNON.Vec3(halfX, halfY, halfZ)));
  body.position.set(pos.x, pos.y, pos.z);
  if (quat) body.quaternion.copy(quat);
  world.addBody(body);
  mapBodies.push(body);
  return body;
}

function addStaticCylinder(radius, height, pos) {
  const body = new CANNON.Body({ mass: 0, material: MAT_WORLD, collisionFilterGroup: G_WORLD });
  body.addShape(new CANNON.Cylinder(radius, radius, height, 12));
  body.position.set(pos.x, pos.y, pos.z);
  world.addBody(body);
  mapBodies.push(body);
  return body;
}

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

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  vmCamera.aspect = innerWidth / innerHeight;
  vmCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  // Pooled particles size themselves in the shader, so they need the new viewport height.
  if (typeof particlesAdd !== 'undefined') {
    particlesAdd.mat.uniforms.uScale.value = innerHeight * 0.5;
    particlesNorm.mat.uniforms.uScale.value = innerHeight * 0.5;
  }
});

/* ================================================================== *
 * === MAP ===
 * ================================================================== */

const PH = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k';
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');

/**
 * A PBR material that is usable the instant it is created and upgrades itself as the
 * Poly Haven maps arrive. It starts as a flat `fallback` colour; when the albedo lands the
 * colour is neutralised so the texture shows through. If the network or CORS kills the
 * request the material simply stays the flat colour — the arena is never left untextured.
 *
 * The ARM map feeds roughnessMap/metalnessMap only. aoMap is skipped on purpose: in three
 * r169 it samples the `uv1` attribute, which none of these primitives have, so wiring it up
 * would render everything fully occluded.
 */
function pbrMat(slug, { repeat = 4, fallback = 0x8a8a8a, rough = 0.9, metal = 0.0, extra = {} } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: fallback, roughness: rough, metalness: metal, ...extra,
  });
  const base = `${PH}/${slug}/${slug}`;
  texLoader.load(
    `${base}_diff_1k.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
    },
    undefined,
    () => { mat.color.setHex(fallback); },
  );
  texLoader.load(
    `${base}_nor_gl_1k.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      mat.normalMap = t;
      mat.normalScale.set(0.8, 0.8);
      mat.needsUpdate = true;
    },
    undefined, () => {},
  );
  texLoader.load(
    `${base}_arm_1k.jpg`,
    (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = MAX_ANISO;
      mat.roughnessMap = t;
      mat.metalnessMap = t;
      mat.metalness = Math.max(metal, 0.35);   // metalnessMap multiplies, so give it headroom
      mat.needsUpdate = true;
    },
    undefined, () => {},
  );
  return mat;
}

const MATS = {
  floor: pbrMat('concrete_wall_006', { repeat: 8, fallback: 0x6a6f74, rough: 0.95 }),
  wall:  pbrMat('brick_wall_006',    { repeat: 6, fallback: 0x6d5a4e, rough: 0.92 }),
  metal: pbrMat('metal_plate',       { repeat: 3, fallback: 0x7b8894, rough: 0.5, metal: 0.6 }),
  ceiling: new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 1.0, metalness: 0.0, side: THREE.FrontSide }),
  trim: new THREE.MeshStandardMaterial({ color: 0xffb454, roughness: 0.6, metalness: 0.2 }),
};

/** Ground-plane footprints that block walking — used to lay out the bot waypoint graph. */
const blockers = [];
function addBlocker(cx, cz, hx, hz) { blockers.push({ x: cx, z: cz, hx, hz }); }
function inBlocker(x, z, pad = 0) {
  for (const b of blockers) {
    if (Math.abs(x - b.x) < b.hx + pad && Math.abs(z - b.z) < b.hz + pad) return true;
  }
  return false;
}

const mapGroup = new THREE.Group();
scene.add(mapGroup);

/**
 * Texture tiles per metre, per material. The maps already carry a `repeat`, so the per-mesh
 * UV scale has to be its reciprocal-ish: scale * repeat lands near 0.5 tiles/m (one tile
 * every two metres) for every surface, which is what keeps a 30 m wall from turning into
 * aliased noise while a 3 m crate still reads as brick.
 */
const UV_SCALE = new Map([
  [MATS.floor, 0.06],   // repeat 8  -> 0.48 tiles/m
  [MATS.wall, 0.08],    // repeat 6  -> 0.48
  [MATS.metal, 0.16],   // repeat 3  -> 0.48
  [MATS.trim, 0.25],
]);

/** Box mesh + matching static collider, with UV scaling so textures keep a constant density. */
function addSolid(w, h, d, x, y, z, mat, { block = true, uvScale = null, cast = true } = {}) {
  const uvs = uvScale ?? UV_SCALE.get(mat) ?? 0.15;
  const geo = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  mapGroup.add(m);
  addStaticBox(w / 2, h / 2, d / 2, { x, y, z });
  if (block && y + h / 2 > 0.7 && y - h / 2 < 2.4) addBlocker(x, z, w / 2, d / 2);
  // Scale the UVs per-instance so a 30 m wall does not show one stretched brick.
  const uv = geo.attributes.uv;
  const norm = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const ny = Math.abs(norm.getY(i));
    const su = ny > 0.5 ? w : (Math.abs(norm.getX(i)) > 0.5 ? d : w);
    const sv = ny > 0.5 ? d : h;
    uv.setXY(i, uv.getX(i) * su * uvs, uv.getY(i) * sv * uvs);
  }
  uv.needsUpdate = true;
  return m;
}

/** Inclined slab from (x0,y0,z0) up to (x1,y1,z1) — the only way onto the central hub. */
function addRamp(x0, y0, z0, x1, y1, z1, width, mat) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const run = Math.hypot(dx, dz);
  const len = Math.hypot(run, dy);
  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.atan2(dy, run);
  const euler = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  const quat = new THREE.Quaternion().setFromEuler(euler);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;

  const m = new THREE.Mesh(new THREE.BoxGeometry(width, 0.4, len), mat);
  m.position.set(cx, cy, cz);
  m.quaternion.copy(quat);
  m.castShadow = true; m.receiveShadow = true;
  mapGroup.add(m);

  const cq = new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w);
  addStaticBox(width / 2, 0.2, len / 2, { x: cx, y: cy, z: cz }, cq);
  addBlocker(cx, cz, width / 2, Math.max(Math.abs(dz) / 2, width / 2));
  return m;
}

function addPillar(x, z, radius, height, mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.12, height, 16), mat);
  m.position.set(x, height / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  mapGroup.add(m);
  addStaticCylinder(radius, height, { x, y: height / 2, z });
  addBlocker(x, z, radius, radius);
  return m;
}

/* --------------------------- GLB props --------------------------- */

const gltfLoader = new GLTFLoader();
/** name -> prepared THREE.Group (cloned per instance). Missing entries fall back to primitives. */
const propCache = {};

const PROP_FILES = {
  crate:   { file: 'box-large.glb',   size: 1.5 },
  crateSm: { file: 'box-small.glb',   size: 1.0 },
  crateLg: { file: 'box-wide.glb',    size: 2.0 },
  barrel:  { file: 'hopper-round.glb', size: 1.7 },
  tank:    { file: 'machine-fortified.glb', size: 2.6 },
  shelf:   { file: 'machine.glb',     size: 2.4 },
  piston:  { file: 'piston-round.glb', size: 2.2 },
  // Dungeon kit. Its floor tile is authored at exactly the 4 m grid pitch the dungeon map
  // uses, so normalising to size 4 is a no-op and the tiles butt up seamlessly.
  dungeonFloor: { file: 'dungeon/template-floor.glb', size: DUNGEON_TILE },
};

function loadProp(key) {
  const spec = PROP_FILES[key];
  return new Promise((resolve) => {
    gltfLoader.load(
      `assets/models/${spec.file}`,
      (gltf) => {
        const root = gltf.scene;
        // Kenney kits are authored on their own grid — normalise to the size we want and
        // re-seat the model so its origin sits on the floor at its centre.
        const box = new THREE.Box3().setFromObject(root);
        const dim = box.getSize(new THREE.Vector3());
        const biggest = Math.max(dim.x, dim.y, dim.z) || 1;
        const s = spec.size / biggest;
        root.scale.setScalar(s);
        const box2 = new THREE.Box3().setFromObject(root);
        const c = box2.getCenter(new THREE.Vector3());
        root.position.set(-c.x, -box2.min.y, -c.z);
        root.traverse((o) => {
          if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
        });
        const wrap = new THREE.Group();
        wrap.add(root);
        wrap.userData.size = new THREE.Vector3(
          box2.max.x - box2.min.x, box2.max.y - box2.min.y, box2.max.z - box2.min.z);
        propCache[key] = wrap;
        resolve(true);
      },
      undefined,
      () => resolve(false),   // missing/blocked file — the primitive fallback covers it
    );
  });
}

/** Place a prop: the GLB if it loaded, otherwise an equivalent primitive. Always collides. */
function placeProp(key, x, z, yaw = 0) {
  const spec = PROP_FILES[key];
  const cached = propCache[key];
  let hx, hy, hz;

  if (cached) {
    const inst = cached.clone(true);
    inst.position.set(x, 0, z);
    inst.rotation.y = yaw;
    mapGroup.add(inst);
    const s = cached.userData.size;
    // Yaw is a multiple of 90 deg for props, so swapping X/Z on the odd quarters is exact.
    const swap = Math.abs(Math.round(yaw / (Math.PI / 2))) % 2 === 1;
    hx = (swap ? s.z : s.x) / 2; hz = (swap ? s.x : s.z) / 2; hy = s.y / 2;
  } else {
    const sz = spec.size;
    const round = key === 'barrel' || key === 'piston';
    const geo = round
      ? new THREE.CylinderGeometry(sz * 0.36, sz * 0.4, sz, 14)
      : new THREE.BoxGeometry(sz, sz * 0.92, sz);
    const mat = round ? MATS.metal : MATS.wall;
    const m = new THREE.Mesh(geo, mat);
    hy = (round ? sz : sz * 0.92) / 2;
    m.position.set(x, hy, z);
    m.rotation.y = yaw;
    m.castShadow = true; m.receiveShadow = true;
    mapGroup.add(m);
    hx = hz = round ? sz * 0.4 : sz / 2;
  }

  addStaticBox(hx, hy, hz, { x, y: hy, z });
  addBlocker(x, z, hx, hz);
}

/* ------------------------- arena assembly ------------------------- */

const A = CONFIG.ARENA, R = CONFIG.RING, GAP = CONFIG.GAP, CH = CONFIG.CEIL;

const spawnPoints = [];
const sniperPerches = [];

function buildArena() {
  /* ---- floor ---- */
  const floorGeo = new THREE.PlaneGeometry(A * 2, A * 2);
  const floor = new THREE.Mesh(floorGeo, MATS.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  mapGroup.add(floor);
  addStaticBox(A, 0.5, A, { x: 0, y: -0.5, z: 0 });

  /* ---- ceiling: enclosed warehouse, no sky leaks ---- */
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(A * 2, A * 2), MATS.ceiling);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = CH;
  ceil.layers.set(L_CEIL);              // the minimap camera must be able to see past it
  mapGroup.add(ceil);
  addStaticBox(A, 0.5, A, { x: 0, y: CH + 0.5, z: 0 });

  // Roof trusses, purely visual.
  for (let i = -4; i <= 4; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(A * 2, 0.4, 0.5), MATS.metal);
    t.position.set(0, CH - 0.35, i * 11);
    t.layers.set(L_CEIL);
    t.castShadow = false;
    mapGroup.add(t);
  }

  /* ---- outer shell ---- */
  addSolid(A * 2, CH, 1.5, 0, CH / 2, -A, MATS.wall, { block: false });
  addSolid(A * 2, CH, 1.5, 0, CH / 2, A, MATS.wall, { block: false });
  addSolid(1.5, CH, A * 2, -A, CH / 2, 0, MATS.wall, { block: false });
  addSolid(1.5, CH, A * 2, A, CH / 2, 0, MATS.wall, { block: false });
  addBlocker(0, -A, A, 1.4); addBlocker(0, A, A, 1.4);
  addBlocker(-A, 0, 1.4, A); addBlocker(A, 0, 1.4, A);

  /* ---- inner ring: four walls, each split by a central doorway.
         The gap between the ring and the outer shell is a continuous corridor loop whose
         four corners are the flanking "arms". ---- */
  const RW = 6;                             // ring wall height
  const seg = (R - GAP) / 2;                // length of one half-wall
  const off = (R + GAP) / 2;                // its centre offset from the axis
  for (const s of [-1, 1]) {
    for (const o of [-off, off]) {
      addSolid(seg, RW, 1.4, o, RW / 2, s * R, MATS.wall);          // north / south
      addSolid(1.4, RW, seg, s * R, RW / 2, o, MATS.wall);          // east / west
    }
    // Doorway lintels so the openings read as gates rather than holes.
    addSolid(GAP * 2, 1.2, 1.4, 0, RW - 0.6, s * R, MATS.trim, { block: false });
    addSolid(1.4, 1.2, GAP * 2, s * R, RW - 0.6, 0, MATS.trim, { block: false });
  }

  /* ---- central hub: raised platform with four ramps ---- */
  addSolid(16, 3.2, 16, 0, 1.6, 0, MATS.metal);
  addRamp(0, 0.0, -15.5, 0, 3.2, -8.2, 5, MATS.metal);
  addRamp(0, 0.0, 15.5, 0, 3.2, 8.2, 5, MATS.metal);
  addRamp(-15.5, 0.0, 0, -8.2, 3.2, 0, 5, MATS.metal);
  addRamp(15.5, 0.0, 0, 8.2, 3.2, 0, 5, MATS.metal);
  // Chest-high cover on the hub so it is holdable but not a fortress.
  addSolid(6, 1.1, 0.6, 0, 3.75, -6.5, MATS.metal, { block: false });
  addSolid(6, 1.1, 0.6, 0, 3.75, 6.5, MATS.metal, { block: false });
  addSolid(0.6, 1.1, 6, -6.5, 3.75, 0, MATS.metal, { block: false });
  addSolid(0.6, 1.1, 6, 6.5, 3.75, 0, MATS.metal, { block: false });

  /* ---- four corner sniper perches + the catwalk ring that links them ---- */
  const P = 22, TOP = 4.6;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * P, pz = sz * P;
      addSolid(7, TOP, 7, px, TOP / 2, pz, MATS.metal);
      // Staircase of jumpable ledges: 1.15 -> 2.3 -> 3.45 -> deck.
      addSolid(3, 1.15, 3, px - sx * 5.0, 0.575, pz - sz * 5.0, MATS.metal);
      addSolid(3, 2.30, 3, px - sx * 5.0, 1.150, pz - sz * 2.2, MATS.metal);
      addSolid(3, 3.45, 3, px - sx * 2.2, 1.725, pz - sz * 5.0, MATS.metal);
      // Waist-high railing on the outer two edges.
      addSolid(7, 1.0, 0.4, px, TOP + 0.5, pz + sz * 3.3, MATS.trim, { block: false });
      addSolid(0.4, 1.0, 7, px + sx * 3.3, TOP + 0.5, pz, MATS.trim, { block: false });
      sniperPerches.push(new THREE.Vector3(px, TOP, pz));
    }
  }
  // Catwalk ring at deck height joining all four perches — 3 m wide, walk-through cover.
  for (const s of [-1, 1]) {
    addSolid(2 * P - 7, 0.4, 3, 0, TOP - 0.2, s * P, MATS.metal, { block: false });
    addSolid(3, 0.4, 2 * P - 7, s * P, TOP - 0.2, 0, MATS.metal, { block: false });
  }

  /* ---- structural pillars from floor to ceiling ---- */
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addPillar(sx * 13, sz * 13, 0.85, CH, MATS.metal);
    addPillar(sx * 42, sz * 42, 1.0, CH, MATS.metal);
  }

  // Low concrete walls that break the long plaza sight lines.
  addSolid(14, 1.3, 0.8, -16, 0.65, -6, MATS.floor);
  addSolid(14, 1.3, 0.8, 16, 0.65, 6, MATS.floor);
  addSolid(0.8, 1.3, 14, -6, 0.65, 16, MATS.floor);
  addSolid(0.8, 1.3, 14, 6, 0.65, -16, MATS.floor);

  buildLights();
}

/**
 * Spawn points, validated against the finished level rather than trusted.
 *
 * This runs after placeArenaProps() so the prop blockers exist — validating inside
 * buildArena() would happily approve a point that a crate later lands on. Every candidate
 * has to clear inBlocker() with a 2 m pad and have real floor under it; the floor height
 * comes from a downward ray, so a candidate on the raised hub spawns on the hub instead of
 * inside it.
 *
 * The old list put four spawns at (0,+/-44) and (+/-44,0), which face the ring wall from
 * ~10 m out, and four more in the corridor corners. Those are the "spawned facing a wall"
 * complaints. These candidates are spread across the plaza and the corridor ring.
 */
const SPAWN_CANDIDATES = [
  // plaza ring, off-axis so none of them sit on the four ramps
  [10, 10], [-10, 10], [10, -10], [-10, -10],
  [20, 20], [-20, 20], [20, -20], [-20, -20],
  [24, 0], [-24, 0], [0, 24], [0, -24],
  // corridor ring between the inner wall and the shell
  [42, 20], [-42, 20], [42, -20], [-42, -20],
  [20, 42], [-20, 42], [20, -42], [-20, -42],
  // fallbacks well inside the plaza
  [28, 10], [-28, 10], [10, 28], [-10, 28],
];

const _spFrom = new CANNON.Vec3();
const _spTo = new CANNON.Vec3();
const _spRes = new CANNON.RaycastResult();

function buildSpawnPoints() {
  let rejected = 0;
  for (const [x, z] of SPAWN_CANDIDATES) {
    if (inBlocker(x, z, 2.0)) { rejected++; continue; }        // pillar, ramp, crate, low wall
    _spFrom.set(x, CONFIG.CEIL - 0.5, z);
    _spTo.set(x, -1, z);
    _spRes.reset();
    world.raycastClosest(_spFrom, _spTo, RAY_OPTS, _spRes);
    if (!_spRes.hasHit) { rejected++; continue; }               // no floor under it at all
    spawnPoints.push(new THREE.Vector3(x, _spRes.hitPointWorld.y + 0.9, z));
  }
  // Never leave the game unable to spawn anyone.
  if (spawnPoints.length < 4) {
    for (const [x, z] of [[0, 28], [0, -28], [28, 0], [-28, 0]]) {
      spawnPoints.push(new THREE.Vector3(x, 0.9, z));
    }
  }
  return { accepted: spawnPoints.length, rejected };
}

/** Scattered cover — run once the GLBs have resolved, before the waypoint graph is laid out. */
function placeArenaProps() {
  const layout = [
    ['crateLg', -6, -20, 0], ['crate', -8.4, -20, 0.4], ['crateSm', -7, -22.3, 0],
    ['crateLg', 6, 20, 0], ['crate', 8.4, 20, 0.4], ['crateSm', 7, 22.3, 0],
    ['tank', -20, 6, Math.PI / 2], ['barrel', -22.5, 8.5, 0], ['barrel', -22.5, 3.5, 0],
    ['tank', 20, -6, -Math.PI / 2], ['barrel', 22.5, -8.5, 0], ['barrel', 22.5, -3.5, 0],
    ['shelf', -28, -28, Math.PI / 4], ['shelf', 28, 28, Math.PI / 4],
    ['piston', 0, -26, 0], ['piston', 0, 26, 0], ['piston', -26, 0, 0], ['piston', 26, 0, 0],
    // corridor loop
    ['crate', -42, -18, 0], ['crateSm', -42, -14, 0.6], ['crate', 42, 18, 0], ['crateSm', 42, 14, 0.6],
    ['barrel', -18, -42, 0], ['barrel', -14, -42, 0], ['barrel', 18, 42, 0], ['barrel', 14, 42, 0],
    ['tank', 42, -30, 0], ['tank', -42, 30, 0],
    ['crateLg', -30, 42, 0], ['crateLg', 30, -42, 0],
  ];
  for (const [key, x, z, yaw] of layout) placeProp(key, x, z, yaw);
  placeDressing();
}

/* ---------------------- environment dressing ---------------------- */

/**
 * Set dressing. None of it registers a blocker or a physics body: it is small enough to walk
 * through visually, and adding colliders here would silently invalidate spawn points and carve
 * holes in the nav graph for the sake of a soda can.
 */
const DRESS_MATS = {
  bin:      matte(0x3b4046, 0.85, 0.15),
  binLid:   matte(0x2b3036, 0.8, 0.25),
  alu:      matte(0xc0c0c0, 0.2, 0.9),
  duct:     matte(0x8b9299, 0.6, 0.55),
  cable:    matte(0x17191c, 0.9, 0.1),
  lampCase: matte(0x2a2e34, 0.7, 0.4),
  lampGlow: new THREE.MeshBasicMaterial({ color: 0xffdca8 }),
  drain:    new THREE.MeshBasicMaterial({ color: 0x0d1014 }),
};

/** Yellow/black hazard stripes, drawn once into a canvas and shared by every strip. */
const cautionTexture = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const x = c.getContext('2d');
  x.fillStyle = '#f2c200';
  x.fillRect(0, 0, 64, 16);
  x.fillStyle = '#141414';
  // Diagonal bars. Drawn as a skewed parallelogram so the stripe reads at a glance.
  for (let i = -16; i < 64; i += 16) {
    x.beginPath();
    x.moveTo(i, 0); x.lineTo(i + 8, 0); x.lineTo(i + 8 + 16, 16); x.lineTo(i + 16, 16);
    x.closePath(); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();

function addDeco(mesh, x, y, z, yaw = 0) {
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mapGroup.add(mesh);
  return mesh;
}

function addTrashCan(x, z) {
  const g = new THREE.Group();
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.8, 12), DRESS_MATS.bin);
  can.position.y = 0.4;
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.05, 12), DRESS_MATS.binLid);
  lid.position.y = 0.82;
  g.add(can, lid);
  addDeco(g, x, 0, z, rand(0, Math.PI));
}

function addSodaCans(x, y, z, n) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 12), DRESS_MATS.alu);
    can.position.set(rand(-0.22, 0.22), 0.06, rand(-0.22, 0.22));
    can.rotation.z = Math.random() < 0.35 ? Math.PI / 2 : 0;   // a few knocked over
    if (can.rotation.z !== 0) can.position.y = 0.04;
    g.add(can);
  }
  addDeco(g, x, y, z);
}

function addDuct(x, y, z, len, horizontalAlongX) {
  const geo = horizontalAlongX
    ? new THREE.BoxGeometry(len, 0.4, 0.4)
    : new THREE.BoxGeometry(0.4, 0.4, len);
  addDeco(new THREE.Mesh(geo, DRESS_MATS.duct), x, y, z);
}

function addCautionTape(x, y, z, len, yaw) {
  const mat = new THREE.MeshBasicMaterial({
    map: cautionTexture.clone(), side: THREE.DoubleSide, transparent: false,
  });
  mat.map.needsUpdate = true;
  mat.map.repeat.set(Math.max(1, Math.round(len / 0.6)), 1);
  addDeco(new THREE.Mesh(new THREE.PlaneGeometry(len, 0.15), mat), x, y, z, yaw);
}

function addCable(x, y, z, len, yaw, sag = 0.35) {
  // A slack cable is a quadratic bezier; three's TubeGeometry renders it for almost nothing.
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-len / 2, 0, 0),
    new THREE.Vector3(0, -sag, 0),
    new THREE.Vector3(len / 2, 0, 0),
  );
  addDeco(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.025, 6, false), DRESS_MATS.cable), x, y, z, yaw);
}

function addWallLamp(x, y, z, yaw) {
  const g = new THREE.Group();
  const casing = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.2), DRESS_MATS.lampCase);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), DRESS_MATS.lampGlow);
  tube.rotation.z = Math.PI / 2;
  tube.position.y = -0.08;
  g.add(casing, tube);
  addDeco(g, x, y, z, yaw);
}

function addFloorDrain(x, z) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), DRESS_MATS.drain);
  m.rotation.x = -Math.PI / 2;
  addDeco(m, x, 0.012, z);      // just above the floor so it does not z-fight
}

function placeDressing() {
  const R = CONFIG.RING, A = CONFIG.ARENA;

  for (const [x, z] of [[-R + 3, -12], [R - 3, 12], [-12, R - 3], [12, -R + 3],
                        [-A + 4, 24], [A - 4, -24]]) addTrashCan(x, z);

  for (const [x, y, z, n] of [[-6, 1.3, -20, 3], [6, 1.3, 20, 2], [-42, 1.3, -18, 4],
                              [42, 1.3, 18, 2], [-30, 1.3, 42, 3]]) addSodaCans(x, y, z, n);

  const ductY = CONFIG.CEIL - 1.2;
  for (const s of [-1, 1]) {
    addDuct(0, ductY, s * (R - 2), 40, true);
    addDuct(s * (R - 2), ductY, 0, 40, false);
    addDuct(0, ductY, s * (A - 3), 60, true);
  }

  for (const [x, y, z, len, yaw] of [
    [0, 1.15, -CONFIG.GAP - 0.2, 5, 0], [0, 1.15, CONFIG.GAP + 0.2, 5, 0],
    [-CONFIG.GAP - 0.2, 1.15, 0, 5, Math.PI / 2], [CONFIG.GAP + 0.2, 1.15, 0, 5, Math.PI / 2],
    [-16, 1.45, -6.2, 6, 0], [16, 1.45, 6.2, 6, 0],
  ]) addCautionTape(x, y, z, len, yaw);

  for (const s of [-1, 1]) {
    addCable(s * (A - 0.6), CONFIG.CEIL - 2.0, -20, 12, Math.PI / 2);
    addCable(s * (A - 0.6), CONFIG.CEIL - 2.4, 20, 12, Math.PI / 2);
    addCable(-20, CONFIG.CEIL - 2.2, s * (A - 0.6), 12, 0);
  }

  for (const s of [-1, 1]) {
    for (const d of [-24, 0, 24]) {
      addWallLamp(s * (A - 0.7), 4.2, d, s > 0 ? -Math.PI / 2 : Math.PI / 2);
      addWallLamp(d, 4.2, s * (A - 0.7), s > 0 ? Math.PI : 0);
    }
  }

  for (const [x, z] of [[-14, 14], [14, -14], [0, 0], [-30, -30], [30, 30]]) addFloorDrain(x, z);
}

function buildLights() {
  addMapLight(new THREE.AmbientLight(0x8ea6c0, 0.4));
  addMapLight(new THREE.HemisphereLight(0x7f9bb8, 0x232830, 0.75));

  // Four warm ceiling lamps, one per quadrant.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = new THREE.PointLight(0xffd9a8, 420, 78, 2);
    p.position.set(sx * 24, CH - 1.2, sz * 24);
    p.castShadow = false;                     // four shadowed point lights is a frame-rate trap
    addMapLight(p);
    const bulb = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.0, 0.6, 14),
      new THREE.MeshBasicMaterial({ color: 0xffe3bb }),
    );
    bulb.position.copy(p.position);
    bulb.layers.set(L_CEIL);
    addMapLight(bulb);
  }
  // Cool fill over the corridor loop so the outer ring is not a black void.
  const ring = new THREE.PointLight(0x9fc4ff, 260, 110, 2);
  ring.position.set(0, CH - 2, 0);
  addMapLight(ring);

  // Single shadow-casting key light through the (implied) roof lights.
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
  sun.position.set(38, 62, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 170;
  const S = A * 1.05;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;               // kills the banding on the big flat walls
  addMapLight(sun);
  addMapLight(sun.target);
}

/* ======================= MAP 2: DUNGEON ======================= */

/**
 * A tiled stone map built on the Kenney Modular Dungeon Kit's native grid.
 *
 * The kit measures out cleanly: every corridor piece is a 4 x 4 m footprint 4.15 m tall with
 * its origin centred on the tile and its floor on y=0, and the rooms are exact multiples
 * (room-small 12 m, room-large 20 m). So the map is authored as a character grid on a 4 m
 * pitch and each open cell gets a floor; walls go on the boundary between an open cell and a
 * closed one.
 *
 * Colliders are generated procedurally from that same grid rather than from the GLB meshes.
 * The art can then be swapped, or fail to load entirely, without any risk of the physics
 * disagreeing with what the player can see — a mesh collider built from an arbitrary GLB is
 * exactly the kind of thing that produces invisible walls.
 */
/* '#' solid rock, '.' floor, 'S' floor + spawn, 'A' floor + ammo chest, 'T' floor + torch. */
const DUNGEON_MAP = [
  '#################',
  '#....S###....S..#',
  '#.##.#T#.##T##.#.',
  '#.#A...........#.',
  '#.#.##.###.##..#.',
  '#T..#....A..#..T#',
  '#.#.#.##.##.#.##.',
  '#.#...#S...#...#.',
  '#.###.#.#.##.#.#.',
  '#S..T.....T...A.#',
  '#.#.###.###.###.#',
  '#.#...#.....#...#',
  '#.###.#.###.#.#.#',
  '#A....#..S..#..T#',
  '#.#T#.###.#.##..#',
  '#...........#..S#',
  '#################',
];

const DUNGEON_MATS = {
  floor: new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.96, metalness: 0.02 }),
  wall:  new THREE.MeshStandardMaterial({ color: 0x38352f, roughness: 0.94, metalness: 0.03 }),
  torch: new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.9, metalness: 0.1 }),
  flame: new THREE.MeshBasicMaterial({ color: 0xff9134 }),
  chain: new THREE.MeshStandardMaterial({ color: 0x51565c, roughness: 0.55, metalness: 0.85 }),
};

const dungeonTorches = [];     // flickered every frame
const dungeonChains = [];      // gently swayed

const dungeonCells = [];       // { x, z, char } for every open cell, in world coordinates

function dungeonGrid() {
  const rows = DUNGEON_MAP.length, cols = DUNGEON_MAP[0].length;
  const ox = -(cols - 1) / 2 * DUNGEON_TILE;
  const oz = -(rows - 1) / 2 * DUNGEON_TILE;
  return { rows, cols, ox, oz };
}

const dungeonAt = (r, c) => (DUNGEON_MAP[r] && DUNGEON_MAP[r][c]) || '#';
const dungeonOpen = (r, c) => dungeonAt(r, c) !== '#';

function addTorch(x, y, z, yaw) {
  const g = new THREE.Group();
  const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), DUNGEON_MATS.torch);
  bracket.rotation.x = 0.5;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 8), DUNGEON_MATS.flame);
  flame.position.set(0, 0.34, -0.11);
  const light = new THREE.PointLight(0xff8c2a, 26, 9, 2);
  light.position.set(0, 0.4, -0.15);
  g.add(bracket, flame, light);
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  mapGroup.add(g);
  dungeonTorches.push({ light, flame, base: 26, phase: rand(0, Math.PI * 2) });
}

function addHangingChain(x, z, links) {
  const g = new THREE.Group();
  for (let i = 0; i < links; i++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.018, 5, 10), DUNGEON_MATS.chain);
    t.position.y = -i * 0.1;
    t.rotation.x = Math.PI / 2;
    t.rotation.y = (i % 2) * Math.PI / 2;
    g.add(t);
  }
  g.position.set(x, DUNGEON_CEIL - 0.1, z);
  mapGroup.add(g);
  dungeonChains.push({ group: g, phase: rand(0, Math.PI * 2) });
}

function updateDungeonFx(dt) {
  const t = performance.now() * 0.001;
  for (const tc of dungeonTorches) {
    // Flicker: a fast sine plus a slower one so it never reads as a clean pulse.
    tc.light.intensity = tc.base * (1 + Math.sin(t * 8 + tc.phase) * 0.3 + Math.sin(t * 3.3 + tc.phase) * 0.12);
    tc.flame.scale.setScalar(1 + Math.sin(t * 11 + tc.phase) * 0.14);
  }
  for (const c of dungeonChains) {
    c.group.rotation.z = Math.sin(t * 0.8 + c.phase) * 0.06;
    c.group.rotation.x = Math.cos(t * 0.6 + c.phase) * 0.04;
  }
}

/** Instance a dungeon GLB on a tile. Silently does nothing if the kit failed to download. */
function placeDungeonPiece(key, x, z, yaw = 0) {
  const src = propCache[key];
  if (!src) return false;
  const m = src.clone(true);
  m.position.set(x, 0, z);
  m.rotation.y = yaw;
  m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  mapGroup.add(m);
  return true;
}

function buildDungeonMap() {
  const { rows, cols, ox, oz } = dungeonGrid();
  const H = DUNGEON_TILE / 2;
  dungeonCells.length = 0;
  dungeonTorches.length = 0;
  dungeonChains.length = 0;

  const torchSpots = [];
  const chestSpots = [];
  const spawnSpots = [];

  // Floor + ceiling slabs for the whole footprint, then per-cell art.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = dungeonAt(r, c);
      const x = ox + c * DUNGEON_TILE;
      const z = oz + r * DUNGEON_TILE;

      if (ch === '#') {
        // Solid rock: one collider per cell, plus a block of geometry to see.
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(DUNGEON_TILE, DUNGEON_CEIL, DUNGEON_TILE), DUNGEON_MATS.wall);
        m.position.set(x, DUNGEON_CEIL / 2, z);
        m.castShadow = true; m.receiveShadow = true;
        mapGroup.add(m);
        addStaticBox(H, DUNGEON_CEIL / 2, H, { x, y: DUNGEON_CEIL / 2, z });
        addBlocker(x, z, H, H);
        continue;
      }

      dungeonCells.push({ x, z, char: ch });
      if (ch === 'T') torchSpots.push([r, c, x, z]);
      if (ch === 'A') chestSpots.push([x, z]);
      if (ch === 'S') spawnSpots.push([x, z]);

      // Prefer the kit's own floor tile; fall back to a plain slab.
      if (!placeDungeonPiece('dungeonFloor', x, z)) {
        const f = new THREE.Mesh(new THREE.PlaneGeometry(DUNGEON_TILE, DUNGEON_TILE), DUNGEON_MATS.floor);
        f.rotation.x = -Math.PI / 2;
        f.position.set(x, 0.01, z);
        f.receiveShadow = true;
        mapGroup.add(f);
      }
      // Ceiling slab, so looking up is stone rather than sky.
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(DUNGEON_TILE, DUNGEON_TILE), DUNGEON_MATS.wall);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(x, DUNGEON_CEIL, z);
      ceil.layers.set(L_CEIL);
      mapGroup.add(ceil);
    }
  }

  // Outer shell: floor plate and a lid, so nothing can fall out of the level.
  addStaticBox(cols * DUNGEON_TILE, 0.5, rows * DUNGEON_TILE, { x: 0, y: -0.5, z: 0 });
  addStaticBox(cols * DUNGEON_TILE, 0.5, rows * DUNGEON_TILE,
    { x: 0, y: DUNGEON_CEIL + 0.5, z: 0 });

  // Torch sconces face into the corridor from an adjacent wall.
  for (const [r, c, x, z] of torchSpots) {
    const dirs = [[0, -1, 0], [0, 1, Math.PI], [-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2]];
    for (const [dc, dr, yaw] of dirs) {
      if (!dungeonOpen(r + dr, c + dc)) {
        addTorch(x + dc * (H - 0.25), 2.3, z + dr * (H - 0.25), yaw);
        break;
      }
    }
  }

  for (const { x, z, char } of dungeonCells) {
    if (char === '.' && Math.random() < 0.06) addHangingChain(x, z, 5 + randInt(0, 3));
  }

  // Props from the factory kit dress the rooms; they already have procedural fallbacks.
  let dressed = 0;
  for (const { x, z, char } of dungeonCells) {
    if (char !== '.' || dressed > 14 || Math.random() > 0.12) continue;
    placeProp(pick(['barrel', 'crate', 'crateSm']), x + rand(-0.8, 0.8), z + rand(-0.8, 0.8), rand(0, Math.PI));
    dressed++;
  }

  buildDungeonLights();

  // Spawns and chests come from the authored cells, still validated the usual way.
  for (const [x, z] of spawnSpots) {
    if (inBlocker(x, z, 0.8)) continue;
    spawnPoints.push(new THREE.Vector3(x, 0.9, z));
  }
  if (spawnPoints.length < 4) {
    for (const { x, z, char } of dungeonCells) {
      if (spawnPoints.length >= 8) break;
      if (char === '.' && !inBlocker(x, z, 0.8)) spawnPoints.push(new THREE.Vector3(x, 0.9, z));
    }
  }
  spawnAmmoChests(chestSpots, 6);
}

function buildDungeonLights() {
  addMapLight(new THREE.AmbientLight(0x3a2f26, 0.55));
  addMapLight(new THREE.HemisphereLight(0x4a3a2a, 0x14100c, 0.5));
  // One shadow-casting key, angled steeply so the corridors stay moody rather than flat.
  const key = new THREE.DirectionalLight(0xffb070, 0.5);
  key.position.set(20, 50, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 5;
  key.shadow.camera.far = 130;
  const S = (DUNGEON_MAP[0].length * DUNGEON_TILE) / 2 + 6;
  key.shadow.camera.left = -S; key.shadow.camera.right = S;
  key.shadow.camera.top = S; key.shadow.camera.bottom = -S;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.03;
  addMapLight(key);
  addMapLight(key.target);
}

/* --------------------- bot navigation waypoints --------------------- */
/**
 * The waypoint graph. Nodes sit on the floor plane only: bots never take the perches or the
 * catwalks, which is a deliberate design line — verticality is the human's edge, and it keeps
 * the AI off a class of pathing bugs. Bots still aim and throw grenades in full 3D, so a
 * camped perch is contested, not safe.
 */
const waypoints = [];       // { pos: Vector3, links: number[], cover: boolean }

function losClear(ax, ay, az, bx, by, bz) {
  _rayFrom.set(ax, ay, az);
  _rayTo.set(bx, by, bz);
  _rayResult.reset();
  world.raycastClosest(_rayFrom, _rayTo, RAY_OPTS, _rayResult);
  return !_rayResult.hasHit;
}

function buildWaypoints({ extent = 46, step = 8.5, pad = 1.1, coverPad = 3.6 } = {}) {
  for (let x = -extent; x <= extent; x += step) {
    for (let z = -extent; z <= extent; z += step) {
      if (inBlocker(x, z, pad)) continue;
      waypoints.push({
        pos: new THREE.Vector3(x, 0.9, z),
        links: [],
        cover: inBlocker(x, z, coverPad),     // hugging a solid = usable as a cover spot
      });
    }
  }
  // Connect each node to its three nearest neighbours, but only where the walk is actually
  // clear. Edges are added symmetrically so BFS can traverse either way.
  const N = 3;
  for (let i = 0; i < waypoints.length; i++) {
    const a = waypoints[i];
    const cands = [];
    for (let j = 0; j < waypoints.length; j++) {
      if (i === j) continue;
      const d = a.pos.distanceToSquared(waypoints[j].pos);
      if (d < step * step * 4.2) cands.push({ j, d });
    }
    cands.sort((p, q) => p.d - q.d);
    let added = 0;
    for (const c of cands) {
      if (added >= N) break;
      const b = waypoints[c.j];
      if (a.links.includes(c.j)) { added++; continue; }
      if (!losClear(a.pos.x, 1.0, a.pos.z, b.pos.x, 1.0, b.pos.z)) continue;
      a.links.push(c.j);
      if (!b.links.includes(i)) b.links.push(i);
      added++;
    }
  }
}

/**
 * Flat top-down floor plan for the minimap: one unlit plate per solid footprint, plus a
 * ground plate. Built from `blockers`, so the map always matches what actually blocks
 * movement. Materials opt out of fog — otherwise distance haze would grey the whole plan.
 */
const MAP_PLATE_GEO = new THREE.PlaneGeometry(1, 1);

function buildMapLayer(extent = A) {
  const g = new THREE.Group();

  const ground = new THREE.Mesh(MAP_PLATE_GEO,
    new THREE.MeshBasicMaterial({ color: 0x141a21, fog: false }));
  ground.scale.set(extent * 2, extent * 2, 1);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.02;
  g.add(ground);

  const solidMat = new THREE.MeshBasicMaterial({ color: 0x5c6b7a, fog: false });
  for (const b of blockers) {
    const m = new THREE.Mesh(MAP_PLATE_GEO, solidMat);
    m.scale.set(b.hx * 2, b.hz * 2, 1);
    m.rotation.x = -Math.PI / 2;
    m.position.set(b.x, 0.06, b.z);
    g.add(m);
  }

  g.traverse((o) => o.layers.set(L_MAP));
  scene.add(g);
  mapLayerGroup = g;
}

/* ======================= map lifecycle ======================= */

/**
 * Anything a map adds straight to the scene (lights, the minimap plate layer) is tracked so a
 * map switch can take it back out again. mapGroup holds the geometry, mapBodies the colliders;
 * these two arrays cover the rest.
 */
const mapLights = [];
let mapLayerGroup = null;

function addMapLight(obj) {
  mapLights.push(obj);
  scene.add(obj);
  return obj;
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      // Materials are frequently shared (MATS.*, DRESS_MATS.*) — disposing them here would
      // blank the next map. Geometry is per-mesh, so only that is safe to free.
    }
  });
}

/** Tear the current level down completely: colliders, meshes, lights, nav data, pickups. */
function clearMap() {
  for (const b of mapBodies) world.removeBody(b);
  mapBodies.length = 0;

  disposeTree(mapGroup);
  mapGroup.clear();

  for (const l of mapLights) scene.remove(l);
  mapLights.length = 0;

  if (mapLayerGroup) {
    scene.remove(mapLayerGroup);
    disposeTree(mapLayerGroup);
    mapLayerGroup = null;
  }

  for (const c of ammoChests) scene.remove(c.mesh);
  ammoChests.length = 0;

  blockers.length = 0;
  spawnPoints.length = 0;
  sniperPerches.length = 0;
  waypoints.length = 0;
  clearPickups();
}

function nearestWaypoint(pos, skip = -1) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < waypoints.length; i++) {
    if (i === skip) continue;
    const d = waypoints[i].pos.distanceToSquared(pos);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Breadth-first search across the waypoint graph. Returns an array of Vector3, or null. */
function findPath(fromPos, toPos) {
  const s = nearestWaypoint(fromPos);
  const g = nearestWaypoint(toPos);
  if (s < 0 || g < 0) return null;
  if (s === g) return [waypoints[g].pos];

  const prev = new Int32Array(waypoints.length).fill(-1);
  const seen = new Uint8Array(waypoints.length);
  const queue = [s];
  seen[s] = 1;
  let head = 0, found = false;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === g) { found = true; break; }
    for (const nx of waypoints[cur].links) {
      if (seen[nx]) continue;
      seen[nx] = 1; prev[nx] = cur; queue.push(nx);
    }
  }
  if (!found) return null;
  const out = [];
  for (let n = g; n !== -1; n = prev[n]) out.push(waypoints[n].pos);
  out.reverse();
  return out;
}

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
const HB_BOT = { bodyR: 0.34, bodyHalfH: 0.40, headR: 0.20, headY: 0.53 };

/** Nearest combatant the segment hits, honouring team and self filters. */
function nearestCombatantHit(o, d, len, shooter) {
  let best = null, bestT = Infinity, bestHead = false;
  for (const c of combatants) {
    if (!c.alive || c === shooter) continue;
    if (shooter && shooter.team !== TEAM.SOLO && c.team === shooter.team) continue;
    const p = c.pos, hb = c.hb;
    const th = segmentSphere(o, d, len, _v1.set(p.x, p.y + hb.headY, p.z), hb.headR);
    const tb = segmentCylinderY(o, d, len, p.x, p.y, p.z, hb.bodyR, hb.bodyHalfH);
    let t = -1, head = false;
    if (th >= 0 && (tb < 0 || th < tb)) { t = th; head = true; }
    else if (tb >= 0) { t = tb; }
    if (t >= 0 && t < bestT) { bestT = t; best = c; bestHead = head; }
  }
  return best ? { target: best, t: bestT, head: bestHead } : null;
}

/* ----------------------- first-person models ----------------------- */

function matte(color, rough = 0.65, metal = 0.35) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}
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
  pistol:  { file: 'blaster-b', len: 0.46, muzzleZ: -0.40 },
  ar:      { file: 'blaster-h', len: 0.95, muzzleZ: -0.76 },
  shotgun: { file: 'blaster-p', len: 1.05, muzzleZ: -0.86 },
  sniper:  { file: 'blaster-f', len: 1.35, muzzleZ: -1.14 },
};

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
      const dmg = b.damage * (cHit.head ? 1.8 : 1);
      spawnBlood(_hitPoint);
      applyDamage(cHit.target, dmg, b.owner, _hitPoint, cHit.head);
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
  const d = origin.distanceTo(camera.position);
  Audio.gunshot(weapon.sound, d);
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

function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.bounceCd = Math.max(0, g.bounceCd - dt);
    g.mesh.position.copy(g.body.position);
    g.mesh.quaternion.copy(g.body.quaternion);
    g.fuse -= dt;
    if (g.fuse <= 0) {
      if (g.kind === 'smoke') spawnSmoke(g.mesh.position, g.owner);
      else explode(g.mesh.position, g.owner);
      world.removeBody(g.body);
      scene.remove(g.mesh);
      grenades.splice(i, 1);
    }
  }
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
function applyDamage(target, amount, source, hitPos, headshot) {
  if (!target.alive || !match.running) return;
  // Spawn protection. Gated here as well as in Bot.canSee, because bullets already in flight
  // and grenades already thrown do not go back through target acquisition.
  if (target.invulnTimer > 0) return;

  let dmg = amount;
  if (target.armor > 0) {
    const soak = Math.min(target.armor, dmg * CONFIG.ARMOR_ABSORB);
    target.armor -= soak;
    dmg -= soak;
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
      showDamageNumber(hitPos || target.pos, dmg, headshot);
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

function setCrouch(on) {
  if (player.crouching === on) return;
  player.crouching = on;
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
  setCrouch(!!keys.KeyC);
  player.sprinting = !!keys.ShiftLeft && !player.crouching && !aiming;

  // Movement basis is camera yaw with the pitch stripped out.
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  let fx = -sy, fz = -cy;        // forward
  let rx = cy, rz = -sy;         // right
  let ix = 0, iz = 0;
  if (keys.KeyW) iz += 1;
  if (keys.KeyS) iz -= 1;
  if (keys.KeyD) ix += 1;
  if (keys.KeyA) ix -= 1;

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
  player.pos.set(b.position.x, b.position.y + PLAYER_CHEST, b.position.z);
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
  aiming = false;
  updateAmmoHud();
}

function tryFire() {
  if (!player.alive || !match.running || player.cooldown > 0 || player.reloading > 0) return;
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
    if (e.button === 2) { aiming = true; }
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      firing = false;
      if (player.cooking === 'frag' && !keys.KeyG) releaseCook();
    }
    if (e.button === 2) aiming = false;
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
    if (!pointerLocked && match.running) showPause(true);
    else showPause(false);
  });

  document.getElementById('pause').addEventListener('click', requestLock);
}

function requestLock() {
  if (!match.running) return;
  renderer.domElement.requestPointerLock();
  Audio.init();
}

/** Consume the accumulated mouse delta once per rendered frame. */
function applyLook(dt) {
  const sens = CONFIG.SENS * (aiming && currentWeapon().zoom ? 0.4 : (aiming ? 0.75 : 1));
  player.yaw -= mouseDX * sens;
  player.pitch -= mouseDY * sens;
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
const BOT_MESH_SCALE = 1.2;
const BOT_MESH_Y = 0.04;
const BOT_CHEST = 0.45;
const BOT_EYE = 0.95;

/* --------------------- rigged soldier bot mesh --------------------- */

/**
 * The three.js Soldier, used for the bot body when it loads. Measured, not guessed: the model
 * is 1.832 m tall with its feet on the model origin, and it faces -Z (its toes reach z=-0.219
 * against +0.123 at the heel, and the back of the skull protrudes further than the nose) —
 * which is the same convention the procedural mesh uses, so Bot.faceDir needs no change.
 */
let soldierGltf = null;

const SOLDIER_HEIGHT = 1.832;   // measured from the GLB's bounding box
const BOT_TARGET_HEIGHT = 1.8;
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
    o.material = o.material.clone();
    o.material.emissive = new THREE.Color(teamColor);
    o.material.emissiveIntensity = 0.55;      // team tell without washing out the texture
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;                  // skinned bounds are the bind pose, not the pose
  });
  g.add(model);

  // Shoulder lamp, same team tell the blocky mesh carries, readable at range and in the dark.
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6),
    new THREE.MeshBasicMaterial({ color: teamColor }));
  lamp.position.set(0.2, 0.5, 0);
  g.add(lamp);

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
      if (dc < 22) Audio.burst({ dur: 0.06, gain: 0.05 * Audio.atten(dc), type: 'lowpass', freq: 380, decay: 0.05 });
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
    const flight = muzzle.distanceTo(target.pos) / w.speed;
    _v2.copy(target.pos).addScaledVector(target.vel, flight * 0.85);
    _v2.y += 0.5 * 9.82 * flight * flight;              // compensate bullet drop
    _v2.sub(muzzle).normalize();

    const cone = (1 - this.diff.accuracy) * 0.085 + w.spread * 0.5;
    _v2.x += rand(-cone, cone); _v2.y += rand(-cone, cone); _v2.z += rand(-cone, cone);
    _v2.normalize();

    this.mag--;
    this.fireCd = w.cooldown * this.diff.fireMult * (w.auto ? 1 : rand(1.0, 1.5));
    fireWeapon(this, w, muzzle.clone(), _v2, 1);
    if (this.mag <= 0) this.reloading = w.reload;
  }

  /* --------------------------- state machine --------------------------- */

  update(dt) {
    this.updateTransforms();
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.stepTimer = Math.max(0, this.stepTimer - dt);
    this.stateTime += dt;
    this.repathTimer -= dt;
    this.nadeCd -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.mag = WEAPON_BY_ID[this.weaponId].mag;
    }

    if (!this.alive) {
      this.updateDeath(dt);
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
        this.followPath(3.0, dt);
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
        const done = this.followPath(5.0, dt);
        if (this.hasLOS) this.faceTarget(dt);
        if (done && !this.hasLOS) this.setState(ST.PATROL);
        break;
      }

      case ST.SHOOT: {
        this.setPlanarVelocity(0, 0);
        this.faceTarget(dt);
        if (hpFrac < 0.4) { this.setState(ST.COVER); break; }
        if (!this.hasLOS) {
          if (this.stateTime > 0.6) this.setState(ST.CHASE);
          break;
        }
        // Strafe a little so bots are not stationary targets.
        const s = Math.sin(this.stateTime * 1.7) * 2.0;
        this.setPlanarVelocity(Math.cos(this.yaw) * s, -Math.sin(this.yaw) * s);
        if (this.reactTimer <= 0) this.shootAt(this.target, dt);
        if (this.nadeCd <= 0 && dist > 6 && dist < 15) { this.setState(ST.NADE); break; }
        if (dist > 60) this.setState(ST.CHASE);
        break;
      }

      case ST.COVER: {
        if (this.stateTime === 0 || !this.path) this.findCover();
        const done = this.followPath(5.4, dt);
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
    this.animate(dt);
  }

  setState(s) { this.state = s; this.stateTime = 0; if (s === ST.COVER) this.findCover(); }

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

  updateDeath(dt) {
    this.deathTimer += dt;
    // Fall over across 0.3 s, then fade out over the next 2 s.
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
    this.respawnTimer -= dt;
  }

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

/* ======================= map registry ======================= */

/**
 * The two playable levels. Each entry owns everything that differs between them: how the
 * geometry is built, the sky/fog treatment, and the nav-graph and minimap tuning (the dungeon
 * is a 4 m corridor grid, so it needs a much finer graph than the open warehouse).
 */
const MAPS = {
  warehouse: {
    name: 'WAREHOUSE',
    blurb: 'Open industrial plaza, long sight lines, four ramps to the hub.',
    background: 0x0a0e14,
    fog: { color: 0x0a0e14, near: 55, far: 190 },
    mapView: 46,
    nav: { extent: 46, step: 8.5, pad: 1.1, coverPad: 3.6 },
    layerExtent: A,
    build() {
      buildArena();
      placeArenaProps();
      buildSpawnPoints();
      spawnAmmoChests([
        [0, 38], [0, -38], [38, 0], [-38, 0],
        [22, 22], [-22, -22], [22, -22], [-22, 22],
        [12, 12], [-12, -12], [12, -12], [-12, 12],
        [30, 12], [-30, 12], [12, 30], [-12, 30],
      ]);
    },
  },
  dungeon: {
    name: 'DUNGEON',
    blurb: 'Tight stone corridors, torchlight, choke points everywhere.',
    background: 0x0a0806,
    fog: { color: 0x140d07, near: 8, far: 60 },
    mapView: 40,
    nav: { extent: 32, step: DUNGEON_TILE, pad: 0.9, coverPad: 2.6 },
    layerExtent: 36,
    build() { buildDungeonMap(); },
  },
};

let currentMapId = 'warehouse';

/** Build a level from scratch. Assumes clearMap() has already run if one was loaded. */
function buildMap(id) {
  const m = MAPS[id];
  currentMapId = id;

  scene.background = new THREE.Color(m.background);
  scene.fog = new THREE.Fog(m.fog.color, m.fog.near, m.fog.far);

  mapCamera.left = -m.mapView / 2; mapCamera.right = m.mapView / 2;
  mapCamera.top = m.mapView / 2; mapCamera.bottom = -m.mapView / 2;
  mapCamera.updateProjectionMatrix();

  m.build();
  buildWaypoints(m.nav);
  buildMapLayer(m.layerExtent);
}

/** Swap levels. No-op when the requested map is already loaded. */
function switchMap(id) {
  if (id === currentMapId || !MAPS[id]) return;
  clearMap();
  buildMap(id);
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

/* ------------------------------ particles ------------------------------ */


/** One THREE.Points per burst: N particles, one draw call, hand-integrated with gravity. */
/**
 * Pooled particles.
 *
 * Every burst used to allocate a BufferGeometry, two Float32Arrays and a PointsMaterial, then
 * dispose all four ~0.4 s later. A frag grenade is 200 particles, so a firefight produced a
 * steady stream of garbage and the collector paid for it in visible hitches.
 *
 * Now there are exactly two Points objects for the whole game — one additive, one normal —
 * each with a fixed vertex budget. A burst leases a slice of the buffer; when a particle dies
 * its size drops to zero and the slot returns to the free list. No allocation at runtime.
 *
 * Per-particle colour and size (which a shared PointsMaterial cannot express) come from
 * vertex attributes, so pooling costs nothing in appearance.
 */
const PARTICLE_VS = `
  attribute float psize;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * (uScale / max(-mv.z, 0.001));
    gl_Position = projectionMatrix * mv;
  }`;

const PARTICLE_FS = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;          // round points, not squares
    gl_FragColor = vec4(vColor, vAlpha);
  }`;

class ParticlePool {
  constructor(capacity, additive) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.psize = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.free = new Int32Array(capacity);
    this.freeCount = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = i;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.psize, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, capacity);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: innerHeight * 0.5 } },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.active = 0;
  }

  emit(o) {
    if (this.freeCount === 0) return;                  // budget exhausted; drop silently
    const i = this.free[--this.freeCount];
    const i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx; this.vel[i3 + 1] = o.vy; this.vel[i3 + 2] = o.vz;
    this.col[i3] = o.r; this.col[i3 + 1] = o.g; this.col[i3 + 2] = o.b;
    this.life[i] = o.life; this.maxLife[i] = o.life;
    this.gravity[i] = o.gravity; this.drag[i] = o.drag;
    this.baseSize[i] = o.size;
    this.psize[i] = o.size;
    this.alpha[i] = 1;
    this.active++;
  }

  update(dt) {
    if (this.active === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      const damp = 1 - this.drag[i] * dt;
      this.vel[i3 + 1] += this.gravity[i] * dt;
      this.vel[i3] *= damp; this.vel[i3 + 1] *= damp; this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.psize[i] = 0;                             // invisible, and the slot comes back
        this.alpha[i] = 0;
        this.free[this.freeCount++] = i;
        this.active--;
      } else {
        this.alpha[i] = clamp(this.life[i] / this.maxLife[i], 0, 1);
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  clear() {
    this.freeCount = 0;
    for (let i = 0; i < this.capacity; i++) {
      this.life[i] = 0; this.psize[i] = 0; this.alpha[i] = 0;
      this.free[this.freeCount++] = i;
    }
    this.active = 0;
    this.geo.attributes.psize.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

const particlesAdd = new ParticlePool(900, true);
const particlesNorm = new ParticlePool(500, false);
const _pcol = new THREE.Color();

function spawnBurst({ origin, count, color, size, speed, spreadDir = null, cone = 1,
                      gravity = -9.0, life = 0.8, drag = 0.0, additive = true }) {
  const pool = additive ? particlesAdd : particlesNorm;
  _pcol.setHex(color);
  for (let i = 0; i < count; i++) {
    let dx = rand(-1, 1), dy = rand(-1, 1), dz = rand(-1, 1);
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    if (spreadDir) {
      dx = lerp(spreadDir.x, dx, cone);
      dy = lerp(spreadDir.y, dy, cone);
      dz = lerp(spreadDir.z, dz, cone);
    }
    const s = speed * rand(0.35, 1);
    pool.emit({
      x: origin.x, y: origin.y, z: origin.z,
      vx: dx * s, vy: dy * s, vz: dz * s,
      r: _pcol.r, g: _pcol.g, b: _pcol.b,
      size, life, gravity, drag,
    });
  }
}

function updateBursts(dt) {
  particlesAdd.update(dt);
  particlesNorm.update(dt);
}

function spawnSparks(pos, normal) {
  spawnBurst({
    origin: pos, count: 5, color: 0xffc474, size: 0.05, speed: 4.2,
    spreadDir: normal, cone: 0.65, gravity: -11, life: 0.35,
  });
}
function spawnBlood(pos) {
  spawnBurst({
    origin: pos, count: 12, color: 0xc0202a, size: 0.075, speed: 3.0,
    gravity: -12, life: 0.5, additive: false,
  });
}

/* ------------------------------- decals ------------------------------- */

const decalGeo = new THREE.CircleGeometry(0.05, 10);
const decalMat = new THREE.MeshBasicMaterial({
  color: 0x0b0b0d, transparent: true, opacity: 0.85, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -4,
});
const decals = [];

function spawnDecal(pos, normal) {
  const m = new THREE.Mesh(decalGeo, decalMat);
  m.position.copy(pos).addScaledVector(normal, 0.012);
  m.quaternion.setFromUnitVectors(_fwdZ, normal);
  m.rotateZ(rand(0, Math.PI * 2));
  scene.add(m);
  decals.push(m);
  if (decals.length > CONFIG.MAX_DECALS) scene.remove(decals.shift());
}
function clearDecals() {
  for (const d of decals) scene.remove(d);
  decals.length = 0;
}

/* ----------------------------- explosions ----------------------------- */

const shockGeo = new THREE.RingGeometry(0.6, 1.0, 40);
const shocks = [];
const blastLights = [];

function spawnExplosion(pos) {
  // Upward cone of fire.
  spawnBurst({
    origin: pos, count: 150, color: 0xffa22e, size: 0.20, speed: 15,
    spreadDir: new THREE.Vector3(0, 1, 0), cone: 0.85, gravity: -7, life: 0.9, drag: 1.4,
  });
  spawnBurst({
    origin: pos, count: 50, color: 0x3a3a3a, size: 0.55, speed: 6,
    spreadDir: new THREE.Vector3(0, 1, 0), cone: 0.9, gravity: -1.2, life: 1.6,
    drag: 1.8, additive: false,
  });

  const ring = new THREE.Mesh(shockGeo, new THREE.MeshBasicMaterial({
    color: 0xffd08a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
  }));
  ring.position.copy(pos); ring.position.y += 0.15;
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  shocks.push({ mesh: ring, t: 0 });

  const light = new THREE.PointLight(0xffffff, 900, 15, 2);
  light.position.copy(pos);
  scene.add(light);
  blastLights.push({ light, t: 0 });
}

function updateExplosionFx(dt) {
  for (let i = shocks.length - 1; i >= 0; i--) {
    const s = shocks[i];
    s.t += dt;
    const k = s.t / 0.4;
    s.mesh.scale.setScalar(1 + k * 9);
    s.mesh.material.opacity = clamp(0.9 * (1 - k), 0, 1);
    if (k >= 1) { scene.remove(s.mesh); s.mesh.material.dispose(); shocks.splice(i, 1); }
  }
  for (let i = blastLights.length - 1; i >= 0; i--) {
    const b = blastLights[i];
    b.t += dt;
    b.light.intensity = 900 * clamp(1 - b.t / 0.2, 0, 1);
    if (b.t >= 0.2) { scene.remove(b.light); blastLights.splice(i, 1); }
  }
}

/* ------------------------------- smoke ------------------------------- */

/** Soft radial puff, generated once and shared by every smoke sprite. */
const smokeTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.00, 'rgba(215,218,222,0.95)');
  grad.addColorStop(0.45, 'rgba(180,185,192,0.55)');
  grad.addColorStop(1.00, 'rgba(150,155,162,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const smokeClouds = [];

function spawnSmoke(pos, owner) {
  Audio.smokePop(pos.distanceTo(camera.position));
  const group = new THREE.Group();
  group.position.copy(pos);
  scene.add(group);

  const puffs = [];
  for (let i = 0; i < 20; i++) {
    const mat = new THREE.SpriteMaterial({
      map: smokeTexture, color: 0xd0d4d9, transparent: true,
      opacity: 0, depthWrite: false, rotation: rand(0, Math.PI * 2),
    });
    const s = new THREE.Sprite(mat);
    const dir = new THREE.Vector3(rand(-1, 1), rand(-0.35, 1), rand(-1, 1)).normalize();
    s.position.copy(dir).multiplyScalar(rand(0.1, 0.6));
    s.scale.setScalar(0.8);
    group.add(s);
    puffs.push({ sprite: s, dir, spin: rand(-0.5, 0.5), target: rand(0.55, 1.0) });
  }

  smokeClouds.push({
    group, puffs, t: 0, owner,
    center: pos.clone(), radius: CONFIG.SMOKE_RADIUS,
  });
}

function updateSmoke(dt) {
  for (let i = smokeClouds.length - 1; i >= 0; i--) {
    const c = smokeClouds[i];
    c.t += dt;
    // Expand to a full 4 m sphere over 2 s, hold, then fade across the final 2 s.
    const grow = clamp(c.t / 2.0, 0, 1);
    const fade = c.t > CONFIG.SMOKE_LIFE - 2
      ? clamp(1 - (c.t - (CONFIG.SMOKE_LIFE - 2)) / 2, 0, 1)
      : 1;
    c.radius = CONFIG.SMOKE_RADIUS * (0.25 + 0.75 * grow);
    for (const p of c.puffs) {
      const spread = c.radius * p.target;
      p.sprite.position.copy(p.dir).multiplyScalar(spread);
      p.sprite.position.y += grow * 0.8;                     // drift upward
      p.sprite.scale.setScalar(1.4 + grow * c.radius * 0.95);
      p.sprite.material.rotation += p.spin * dt;
      p.sprite.material.opacity = 0.62 * grow * fade;
    }
    c.group.position.y = c.center.y + grow * 0.5;
    if (c.t >= CONFIG.SMOKE_LIFE) {
      for (const p of c.puffs) p.sprite.material.dispose();
      scene.remove(c.group);
      smokeClouds.splice(i, 1);
    }
  }
}

/** True when the segment passes through any smoke that has actually built up. */
function smokeBlocks(from, to) {
  if (smokeClouds.length === 0) return false;
  _v3.subVectors(to, from);
  const len = _v3.length();
  if (len < 1e-4) return false;
  _v3.divideScalar(len);
  for (const c of smokeClouds) {
    if (c.t < 0.5) continue;                     // still deploying — not opaque yet
    _v1.set(c.center.x, c.center.y + 0.5, c.center.z);
    if (segmentSphere(from, _v3, len, _v1, c.radius * 0.85) >= 0) return true;
  }
  return false;
}

function clearSmoke() {
  for (const c of smokeClouds) { for (const p of c.puffs) p.sprite.material.dispose(); scene.remove(c.group); }
  smokeClouds.length = 0;
}

/* ---------------------------- screen shake ---------------------------- */

let shakeAmp = 0;
const _shakeOff = new THREE.Vector3();
function addShake(a) { shakeAmp = Math.min(0.35, shakeAmp + a); }
function updateShake(dt) {
  shakeAmp *= Math.pow(0.02, dt / 0.3);          // damped to ~nothing in 0.3 s
  if (shakeAmp < 0.0005) { shakeAmp = 0; _shakeOff.set(0, 0, 0); return; }
  _shakeOff.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(shakeAmp);
}

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
  const light = new THREE.PointLight(0xffcf5a, 2.2, 3.0, 2);
  light.position.y = 0.3;
  g.add(body, lid, seam, glow, light);
  g.userData.light = light;
  return g;
}

function spawnAmmoChests(positions, max = 6) {
  for (const [x, z] of positions) {
    if (ammoChests.length >= max) break;
    if (inBlocker(x, z, 1.2)) continue;              // never bury a chest inside a crate
    _spFrom.set(x, CONFIG.CEIL - 0.5, z);
    _spTo.set(x, -1, z);
    _spRes.reset();
    world.raycastClosest(_spFrom, _spTo, RAY_OPTS, _spRes);
    if (!_spRes.hasHit) continue;
    const mesh = buildAmmoChest();
    const baseY = _spRes.hitPointWorld.y + 0.45;
    mesh.position.set(x, baseY, z);
    scene.add(mesh);
    ammoChests.push({ mesh, baseY, cooldown: 0, phase: rand(0, Math.PI * 2) });
  }
}

function updateAmmoChests(dt) {
  const t = performance.now() * 0.001;
  let prompt = false;

  for (const c of ammoChests) {
    if (c.cooldown > 0) {
      c.cooldown -= dt;
      if (c.cooldown <= 0) { c.mesh.visible = true; Audio.pickup?.(); }
      continue;
    }
    c.mesh.rotation.y += dt * 0.5;
    c.mesh.position.y = c.baseY + Math.sin(t * (Math.PI * 2 / 1.5) + c.phase) * 0.2;
    c.mesh.userData.light.intensity = 1.8 + Math.sin(t * 3 + c.phase) * 0.6;

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
    c.cooldown = AMMO_CHEST_RESPAWN;
    prompt = false;
  }

  if (el.ammoPrompt) el.ammoPrompt.style.opacity = prompt ? '1' : '0';
}

function resetAmmoChests() {
  for (const c of ammoChests) { c.cooldown = 0; c.mesh.visible = true; }
}

function clearEffects() {
  particlesAdd.clear();
  particlesNorm.clear();
  for (const s of shocks) scene.remove(s.mesh);
  shocks.length = 0;
  for (const b of blastLights) scene.remove(b.light);
  blastLights.length = 0;
  for (const b of brass) vmScene.remove(b.mesh);
  brass.length = 0;
  clearSmoke(); clearDecals(); clearBullets(); clearGrenades(); clearPickups();
}

/* ================================================================== *
 * === MINIMAP ===
 * ================================================================== */

const MAP_PX = 180, MAP_MARGIN = 20;

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

  // setViewport/setScissor take CSS pixels — three multiplies by the pixel ratio itself.
  // The GL origin is bottom-left, so the CSS bottom margin is the y offset directly.
  const x = innerWidth - MAP_MARGIN - MAP_PX;
  const y = MAP_MARGIN;

  renderer.setViewport(x, y, MAP_PX, MAP_PX);
  renderer.setScissor(x, y, MAP_PX, MAP_PX);
  renderer.setScissorTest(true);
  renderer.clear(true, true, false);
  renderer.render(scene, mapCamera);
  renderer.setScissorTest(false);
}

/* ================================================================== *
 * === HUD ===
 * ================================================================== */

const $ = (id) => document.getElementById(id);
const el = {
  hud: $('hud'), menu: $('menu'), pause: $('pause'), board: $('board'),
  crosshair: $('crosshair'), scope: $('scope'), hitmarker: $('hitmarker'),
  hp: $('hpfill'), hptxt: $('hptxt'), ap: $('apfill'), aptxt: $('aptxt'), vname: $('v-name'),
  aname: $('a-name'), amag: $('a-mag'), ares: $('a-res'), areload: $('a-reload'), slots: $('slots'),
  tbMode: $('tb-mode'), tbA: $('tb-a'), tbB: $('tb-b'), tbTime: $('tb-time'),
  feed: $('feed'), plates: $('plates'), dmgwrap: $('dmgwrap'), lowhp: $('lowhp'),
  toast: $('toast'), bBody: $('b-body'), bTitle: $('b-title'), bSub: $('b-sub'),
  pBig: $('p-big'), pSm: $('p-sm'), pCta: $('p-cta'), loading: $('loading'), play: $('play'),
  nameInput: $('nameinput'), menuResult: $('menuresult'),
  dmgNums: $('dmgnums'), ammoPrompt: $('ammo-prompt'),
};

let hitmarkerTimer = 0, toastTimer = 0;

function showHitMarker(kill) {
  el.hitmarker.classList.toggle('kill', !!kill);
  el.hitmarker.style.opacity = '1';
  hitmarkerTimer = 0.15;
}

function showToast(text) {
  el.toast.textContent = text;
  el.toast.style.opacity = '1';
  toastTimer = 1.6;
}

function showDamageDirection(sourcePos) {
  const worldAng = Math.atan2(sourcePos.x - camera.position.x, sourcePos.z - camera.position.z);
  // Bearing relative to where the camera is looking — world space would spin as you turn.
  const rel = (player.yaw + Math.PI) - worldAng;
  const d = document.createElement('div');
  d.className = 'dmg';
  d.style.transform = `rotate(${rel}rad)`;
  el.dmgwrap.appendChild(d);
  requestAnimationFrame(() => { d.style.opacity = '0'; });
  setTimeout(() => d.remove(), 600);
}

const _dmgProj = new THREE.Vector3();

/** Float the damage dealt above the point of impact, projected to screen space. */
function showDamageNumber(worldPos, amount, headshot) {
  if (!el.dmgNums || amount <= 0) return;
  _dmgProj.copy(worldPos).project(camera);
  if (_dmgProj.z > 1) return;                       // behind the camera
  const d = document.createElement('div');
  d.className = headshot ? 'dmg-num head' : 'dmg-num';
  d.textContent = Math.round(amount);
  // A little horizontal jitter so a shotgun's pellets do not stack into one unreadable blob.
  d.style.left = `${(_dmgProj.x * 0.5 + 0.5) * innerWidth + rand(-14, 14)}px`;
  d.style.top = `${(-_dmgProj.y * 0.5 + 0.5) * innerHeight}px`;
  el.dmgNums.appendChild(d);
  setTimeout(() => d.remove(), 800);
}

function makePlate(name, color) {
  const root = document.createElement('div');
  root.className = 'plate';
  const n = document.createElement('div');
  n.className = 'pn';
  n.textContent = name;
  n.style.color = `#${color.toString(16).padStart(6, '0')}`;
  const bar = document.createElement('div');
  bar.className = 'ph';
  const fill = document.createElement('i');
  fill.style.background = n.style.color;
  bar.appendChild(fill);
  root.append(n, bar);
  el.plates.appendChild(root);
  return { root, fill };
}

const _proj = new THREE.Vector3();
let plateLosTimer = 0;

function updatePlates(dt) {
  // A plate drawn for a bot behind a wall is an aimbot. Gate it on the same G_WORLD-masked
  // raycast the AI uses, refreshed a few times a second rather than every frame — one ray
  // per bot per frame is real cost, and a 0.15 s stale plate is imperceptible.
  plateLosTimer -= dt;
  const recheck = plateLosTimer <= 0;
  if (recheck) plateLosTimer = 0.15;

  for (const b of bots) {
    const p = b.plate;
    if (!b.alive) { p.root.style.display = 'none'; continue; }
    _proj.set(b.pos.x, b.pos.y + 0.85, b.pos.z).project(camera);
    // z > 1 means it is behind the near plane — otherwise the plate mirrors behind you.
    if (_proj.z > 1 || Math.abs(_proj.x) > 1.3) { p.root.style.display = 'none'; continue; }
    const d = b.pos.distanceTo(camera.position);
    if (d > 55) { p.root.style.display = 'none'; continue; }
    if (recheck) {
      b.plateLos = losClear(player.eye.x, player.eye.y, player.eye.z, b.pos.x, b.pos.y, b.pos.z);
    }
    if (!b.plateLos) { p.root.style.display = 'none'; continue; }
    p.root.style.display = '';
    p.root.style.left = `${(_proj.x * 0.5 + 0.5) * innerWidth}px`;
    p.root.style.top = `${(-_proj.y * 0.5 + 0.5) * innerHeight}px`;
    p.root.style.opacity = String(clamp(1.15 - d / 55, 0.25, 1));
    p.fill.style.transform = `scaleX(${clamp(b.health / 100, 0, 1)})`;
  }
}

function updateVitals() {
  el.hp.style.transform = `scaleX(${clamp(player.health / CONFIG.MAX_HEALTH, 0, 1)})`;
  el.ap.style.transform = `scaleX(${clamp(player.armor / CONFIG.MAX_ARMOR, 0, 1)})`;
  el.hptxt.textContent = Math.ceil(player.health);
  el.aptxt.textContent = Math.ceil(player.armor);
  el.lowhp.style.opacity = player.alive && player.health < 40
    ? String(clamp((40 - player.health) / 40, 0, 1)) : '0';
}

function updateAmmoHud() {
  const w = currentWeapon();
  el.aname.textContent = w.name;
  if (w.thrown) {
    el.amag.textContent = player.fragCount;
    el.ares.textContent = '∞';
  } else {
    const a = player.ammo[w.id];
    el.amag.textContent = a.mag;
    el.ares.textContent = a.reserve;
  }
  // Slot strip.
  el.slots.innerHTML = '';
  for (const wp of WEAPONS) {
    const d = document.createElement('div');
    d.textContent = wp.slot;
    if (wp.id === player.current) d.className = 'on';
    else if (wp.thrown ? player.fragCount <= 0 : player.ammo[wp.id].mag + player.ammo[wp.id].reserve <= 0) {
      d.className = 'empty';
    }
    el.slots.appendChild(d);
  }
}

/* ------------------------------ kill feed ------------------------------ */

function feedClass(c) {
  if (c === player) return 'me';
  if (player.team !== TEAM.SOLO && c && c.team === player.team) return 'al';
  return 'en';
}

function addKillFeed(source, target, headshot) {
  const row = document.createElement('div');
  row.className = 'kf';
  const s = source ? `<span class="${feedClass(source)}">${source === player ? 'YOU' : source.name}</span>` : '<span>WORLD</span>';
  const t = `<span class="${feedClass(target)}">${target === player ? 'YOU' : target.name}</span>`;
  row.innerHTML = `${s}<span class="arrow">${headshot ? '✦' : '›'}</span>${t}`;
  el.feed.appendChild(row);
  while (el.feed.children.length > 5) el.feed.firstChild.remove();
  setTimeout(() => { row.style.opacity = '0'; }, 4200);
  setTimeout(() => row.remove(), 5000);
}

/* ----------------------------- scoreboard ----------------------------- */

function showBoard(on) { el.board.classList.toggle('on', !!on); if (on) refreshBoard(); }

function refreshBoard() {
  const rows = [player, ...bots].slice();
  rows.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
  el.bBody.innerHTML = '';
  for (const c of rows) {
    const tr = document.createElement('tr');
    if (c === player) tr.className = 'self';
    const color = `#${TEAM_COLOR[c.team].toString(16).padStart(6, '0')}`;
    const kd = c.deaths === 0 ? c.kills.toFixed(2) : (c.kills / c.deaths).toFixed(2);
    tr.innerHTML = `<td><span class="tag" style="background:${color}"></span>${c === player ? player.name : c.name}</td>` +
      `<td class="num">${c.kills}</td><td class="num">${c.deaths}</td><td class="num">${kd}</td>`;
    el.bBody.appendChild(tr);
  }
  el.bSub.textContent = match.mode === 'sv'
    ? `WAVE ${match.wave} · ${match.kills} KILLS`
    : `${MODE_LABEL[match.mode]} · ${match.diff.label}`;
}

function showPause(on) {
  el.pause.classList.toggle('on', !!on && match.running);
  if (on) { el.pBig.textContent = 'PAUSED'; el.pSm.textContent = ''; el.pCta.style.display = ''; }
}

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
  for (const b of bots) {
    b.dispose();
    const i = combatants.indexOf(b);
    if (i >= 0) combatants.splice(i, 1);
  }
  bots.length = 0;
}

function startMatch(mode, diffKey, name, mapId = currentMapId) {
  // Rebuilding the level has to happen before any bot is spawned or the player is placed:
  // both read spawnPoints, and switchMap() empties it.
  switchMap(mapId);

  match.mode = mode;
  match.diff = DIFFICULTY[diffKey];
  match.running = true;
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

  Audio.init();
  Audio.startAmbient();
  requestLock();
}

function endMatch(title, sub) {
  match.running = false;
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
      if (source.team === TEAM.BLUE) match.scoreA++;
      else if (source.team === TEAM.RED) match.scoreB++;
    } else if (match.mode === 'dm') {
      if (source === player) match.scoreA++; else match.scoreB = Math.max(match.scoreB, source.kills);
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
        const top = bots.reduce((a, b) => (b.kills > a.kills ? b : a), bots[0] || player);
        endMatch(player.kills >= top.kills ? 'TIME — YOU WIN' : 'TIME — YOU LOSE',
                 `${player.kills} kills`);
      } else {
        endMatch(match.scoreA >= match.scoreB ? 'TIME — BLUE WINS' : 'TIME — RED WINS',
                 `${match.scoreA} – ${match.scoreB}`);
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
    const top = bots.reduce((a, b) => (b.kills > (a ? a.kills : -1) ? b : a), null);
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
const _camPos = new THREE.Vector3();
const _vmTarget = new THREE.Vector3();

function fixedStep(dt) {
  stepPlayer(dt);
  world.step(dt);
  stepBullets(dt);
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
  const bob = Math.min(planar / CONFIG.WALK_SPEED, 1.6);
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
  const wantFov = scoped ? w.zoomFov : (aiming ? 68 : 78);
  camera.fov = lerp(camera.fov, wantFov, Math.min(1, 12 * dt));
  camera.updateProjectionMatrix();

  el.scope.classList.toggle('on', scoped);
  el.crosshair.classList.toggle('off', scoped || !player.alive);
}

function updateHudTimers(dt) {
  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= dt;
    if (hitmarkerTimer <= 0) el.hitmarker.style.opacity = '0';
  }
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) el.toast.style.opacity = '0';
  }
  if (player.reloading > 0) {
    const p = Math.round((1 - player.reloading / player.reloadTotal) * 100);
    el.areload.textContent = `RELOADING ${p}%`;
  } else if (player.cooking) {
    el.areload.textContent = `${player.cooking.toUpperCase()} COOKING ${player.cookTime.toFixed(1)}s`;
  } else {
    const w = currentWeapon();
    const a = !w.thrown && player.ammo[w.id];
    el.areload.textContent = (a && a.mag === 0) ? 'PRESS R' : '';
  }
  updateVitals();
}

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now() / 1000;
  let dt = Math.min(now - lastTime, CONFIG.MAX_FRAME_DT);
  lastTime = now;

  if (match.running) {
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

    for (const b of bots) b.update(dt);
    updateGrenades(dt);
    updateBursts(dt);
    updateExplosionFx(dt);
    updateSmoke(dt);
    updateBrass(dt);
    updatePickups(dt);
    updateAmmoChests(dt);
    if (currentMapId === 'dungeon') updateDungeonFx(dt);
    updateShake(dt);
    updateSpotting(dt);
    updateMatch(dt);
    updateViewModel(dt);
    updateCamera(dt);
    updatePlates(dt);
    updateHudTimers(dt);
  }

  // --- render: world, then viewmodel on a cleared depth buffer, then the minimap ---
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
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

function bindMenu() {
  let mode = 'dm', diff = 'medium', map = 'warehouse';

  const blurb = $('map-blurb');
  for (const b of document.querySelectorAll('#maps .pill')) {
    b.addEventListener('click', () => {
      map = b.dataset.map;
      document.querySelectorAll('#maps .pill').forEach((x) => x.classList.toggle('active', x === b));
      if (blurb) blurb.textContent = MAPS[map].blurb;
    });
  }
  if (blurb) blurb.textContent = MAPS[map].blurb;

  for (const b of document.querySelectorAll('.mode-btn')) {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
  }
  for (const b of document.querySelectorAll('#diffs .pill')) {
    b.addEventListener('click', () => {
      diff = b.dataset.diff;
      document.querySelectorAll('#diffs .pill').forEach((x) => x.classList.toggle('active', x === b));
    });
  }
  el.play.addEventListener('click', () => {
    Audio.init();
    startMatch(mode, diff, el.nameInput.value.trim(), map);
  });
}

async function boot() {
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
    currentMapId: () => currentMapId,
  };

  frame();
}

boot();






