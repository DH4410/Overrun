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
  MAX_SUBSTEPS: 4,  // 4 * 8.33 ms = 33.3 ms covers 30 fps without accumulator drift
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
  // v^2 / 2g is the apex: 6.4 m/s put it at 2.09 m, which is why jumping read as floaty and
  // unreal. 4.7 gives 1.12 m — still a game jump, but one a person could plausibly make.
  JUMP_SPEED: 4.7,
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
 * === SETTINGS ===
 * ================================================================== */

/**
 * Graphics presets, built from measurement rather than taste. Timing one frame at 400x300
 * with each knob isolated: baseline 33.8 ms, shadows off 1.9 ms, half resolution 3.4 ms.
 * Shadow rendering is ~95% of the frame, so that is the first thing every step down removes;
 * resolution scale is second, and the active point-light budget third.
 */
const QUALITY = {
  low: {
    label: 'PERFORMANCE',
    shadows: false, shadowMap: 512, maxPixelRatio: 1, renderScale: 0.75,
    lights: 4, particles: 0.35, aniso: 1, antialias: false, decals: 30,
  },
  medium: {
    label: 'BALANCED',
    shadows: true, shadowMap: 1024, maxPixelRatio: 1, renderScale: 1.0,
    lights: 8, particles: 0.7, aniso: 4, antialias: true, decals: 60,
  },
  high: {
    label: 'QUALITY',
    shadows: true, shadowMap: 2048, maxPixelRatio: 2, renderScale: 1.0,
    lights: 12, particles: 1.0, aniso: 16, antialias: true, decals: 90,
  },
};

const DEFAULT_SETTINGS = {
  quality: 'medium',
  sensitivity: 1.0,         // multiplier on CONFIG.SENS
  adsSensitivity: 0.75,     // extra multiplier while aiming
  // Fixed, not a user control. FOV changes how large every character reads on screen, so
  // letting it drift re-opens the "bots look small" problem and makes the crosshair
  // convergence and viewmodel framing inconsistent between players.
  fov: 68,
  invertY: false,
  crosshairColor: '#00ff87',
  crosshairGap: 8,
  showDamageNumbers: true,
  showEnemyHealth: false,   // enemies show a callsign only; damage numbers convey the rest
  masterVolume: 0.8,
  viewBob: true,
  // Laptop/trackpad friendly toggles. Holding a modifier while dragging a trackpad is
  // genuinely painful, so every hold-to-act binding can be made a press-to-toggle instead.
  toggleAim: false,
  // Toggle by default. Hold-to-crouch means holding a key through every angle-hold and every
  // peek, which is what the crouch mechanic is mostly used for; the hold binding is still
  // available in Settings for anyone who prefers it.
  toggleCrouch: true,
  toggleSprint: false,
  arrowKeys: false,          // arrows as a second movement set for laptops without WASD comfort
};

const settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem('overrun.settings');
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch { /* corrupt or unavailable storage just means defaults */ }
  // Never trust persisted data to name a preset that still exists.
  if (!QUALITY[settings.quality]) settings.quality = DEFAULT_SETTINGS.quality;
}

function saveSettings() {
  try { localStorage.setItem('overrun.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

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
    this.master.gain.value = 0.5 * (settings?.masterVolume ?? 1);
    this.master.connect(this.ctx.destination);

    const len = Math.floor(this.ctx.sampleRate * 1.0);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.ready = true;
  },

  setVolume(v) {
    if (this.master) this.master.gain.value = 0.5 * clamp(v, 0, 1);
  },

  /** One-shot filtered noise burst. */
  burst({ dur = 0.18, gain = 0.5, type = 'lowpass', freq = 1800, q = 1, decay = null, delay = 0, pan = 0 }) {
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
    src.connect(flt); flt.connect(g); g.connect(this._panner(pan) ?? this.master);
    src.start(t); src.stop(t + dur + 0.05);
  },

  /** One-shot pitch-swept oscillator. */
  tone({ f0 = 200, f1 = 40, dur = 0.2, gain = 0.4, type = 'sine', delay = 0, pan = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this._panner(pan) ?? this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  /** Distance attenuation for anything that did not happen at the camera. */
  atten(dist) { return clamp(1 - dist / 70, 0.06, 1); },

  /**
   * Stereo placement. A full PannerNode with a listener orientation is overkill here — what
   * actually matters in a shooter is "was that to my left or my right", so this projects the
   * direction to the sound onto the camera's right axis and pans by that. Sounds behind you
   * are pulled slightly wide, which stops front and back being indistinguishable.
   */
  spatial(worldPos) {
    const dx = worldPos.x - camera.position.x;
    const dy = worldPos.y - camera.position.y;
    const dz = worldPos.z - camera.position.z;
    const dist = Math.hypot(dx, dy, dz) || 0.001;
    // Camera right vector from yaw: forward is (-sin, -cos), so right is (cos, -sin).
    const cy = Math.cos(player.yaw), sy = Math.sin(player.yaw);
    const pan = clamp(((dx * cy) + (dz * -sy)) / dist, -1, 1);
    return { dist, pan: pan * 0.85 };
  },

  /** Optional stereo panner in front of the master bus. Null when unsupported or centred. */
  _panner(pan) {
    if (!pan || !this.ctx.createStereoPanner) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(this.master);
    return p;
  },

  gunshot(id, dist = 0, pan = 0) {
    const v = this.atten(dist);
    // Every layer of the shot has to carry the same pan or the sound smears across the field.
    const P = { pan };
    if (v <= 0.06 && dist > 90) return;
    switch (id) {
      case 'pistol':                                   // sharp crack
        this.burst({ dur: 0.10, gain: 0.42 * v, type: 'highpass', freq: 1400, decay: 0.07 , ...P });
        this.tone({ f0: 320, f1: 70, dur: 0.09, gain: 0.30 * v, type: 'square' , ...P });
        break;
      case 'ar':                                       // medium, punchy
        this.burst({ dur: 0.13, gain: 0.36 * v, type: 'bandpass', freq: 1100, q: 0.8, decay: 0.09 , ...P });
        this.tone({ f0: 240, f1: 55, dur: 0.11, gain: 0.30 * v, type: 'sawtooth' , ...P });
        break;
      case 'shotgun':                                  // low boom + long tail
        this.burst({ dur: 0.34, gain: 0.55 * v, type: 'lowpass', freq: 900, decay: 0.28 , ...P });
        this.tone({ f0: 150, f1: 32, dur: 0.28, gain: 0.42 * v, type: 'sine' , ...P });
        break;
      case 'sniper':                                   // thunderclap: crack then rolling tail
        this.burst({ dur: 0.09, gain: 0.6 * v, type: 'highpass', freq: 2600, decay: 0.05 , ...P });
        this.tone({ f0: 420, f1: 40, dur: 0.30, gain: 0.5 * v, type: 'square' , ...P });
        this.burst({ dur: 0.6, gain: 0.24 * v, type: 'lowpass', freq: 420, decay: 0.55, delay: 0.04 , ...P });
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
  let isRound = false;

  if (cached) {
    const inst = cached.clone(true);
    inst.position.set(x, 0, z);
    inst.rotation.y = yaw;
    mapGroup.add(inst);
    const s = cached.userData.size;
    // Use true model half-extents; rotation is handled by the body quaternion below.
    hx = s.x / 2; hz = s.z / 2; hy = s.y / 2;
  } else {
    const sz = spec.size;
    isRound = key === 'barrel' || key === 'piston';
    const geo = isRound
      ? new THREE.CylinderGeometry(sz * 0.36, sz * 0.4, sz, 14)
      : new THREE.BoxGeometry(sz, sz * 0.92, sz);
    const mat = isRound ? MATS.metal : MATS.wall;
    const m = new THREE.Mesh(geo, mat);
    hy = (isRound ? sz : sz * 0.92) / 2;
    m.position.set(x, hy, z);
    m.rotation.y = yaw;
    m.castShadow = true; m.receiveShadow = true;
    mapGroup.add(m);
    hx = hz = isRound ? sz * 0.4 : sz / 2;
  }

  // Rotate the physics body to match the visual mesh yaw.
  const quat = yaw ? new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw) : null;
  addStaticBox(hx, hy, hz, { x, y: hy, z }, quat);

  // Nav blocker: axis-aligned bounding box of the rotated rectangle (cylindrical props are
  // symmetric so their AABB does not change with yaw).
  if (isRound || !yaw) {
    addBlocker(x, z, hx, hz);
  } else {
    const cosA = Math.abs(Math.cos(yaw));
    const sinA = Math.abs(Math.sin(yaw));
    addBlocker(x, z, hx * cosA + hz * sinA, hx * sinA + hz * cosA);
  }
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
  // Ceiling lamps: four warm quadrant lights. The bulb geometry is map-owned, the light
  // itself is only a request for one of the shared slots.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 24, y = CH - 1.2, z = sz * 24;
    addLightEmitter({ x, y, z, color: 0xffd9a8, intensity: 420, distance: 78, priority: 1 });
    const bulb = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.0, 0.6, 14),
      new THREE.MeshBasicMaterial({ color: 0xffe3bb }),
    );
    bulb.position.set(x, y, z);
    bulb.layers.set(L_CEIL);
    mapGroup.add(bulb);
  }
  // Cool fill over the corridor loop so the outer ring is not a black void.
  addLightEmitter({ x: 0, y: CH - 2, z: 0, color: 0x9fc4ff, intensity: 260, distance: 110, priority: 1 });
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
/*
 * The layout is carved rather than hand-drawn as ASCII. Every corridor here is TWO tiles
 * (8 m) wide and the halls are far bigger, because the first pass at this map used 1-tile
 * corridors and they played like a drainpipe — you could not strafe, dodge or flank, and a
 * walk test could only cover 1.4 m before hitting stone.
 *
 * '#' solid rock, '.' floor, 'S' spawn, 'A' ammo chest, 'T' torch.
 */
const DUNGEON_COLS = 23, DUNGEON_ROWS = 23;

function carveDungeon() {
  const g = Array.from({ length: DUNGEON_ROWS }, () => Array(DUNGEON_COLS).fill('#'));
  const rect = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r > 0 && c > 0 && r < DUNGEON_ROWS - 1 && c < DUNGEON_COLS - 1) g[r][c] = '.';
      }
    }
  };

  // Outer ring corridor, 2 tiles wide, hugging the shell.
  rect(2, 2, 3, 20); rect(19, 2, 20, 20);
  rect(2, 2, 20, 3); rect(2, 19, 20, 20);

  // Central hall, 7x7 tiles (28 m) — the main fighting space.
  rect(8, 8, 14, 14);

  // Four 2-wide spokes from the ring into the hall.
  rect(3, 10, 8, 12); rect(14, 10, 20, 12);
  rect(10, 3, 12, 8); rect(10, 14, 12, 20);

  // Corner chambers, joined to the ring by short 2-wide necks.
  rect(5, 5, 7, 7);   rect(3, 5, 5, 6);   rect(5, 3, 6, 5);
  rect(5, 15, 7, 17); rect(3, 16, 5, 17); rect(5, 17, 6, 19);
  rect(15, 5, 17, 7); rect(17, 5, 19, 6); rect(15, 3, 16, 5);
  rect(15, 15, 17, 17); rect(17, 16, 19, 17); rect(15, 17, 16, 19);

  // Two pillars inside the hall so it is not a featureless box.
  g[10][10] = '#'; g[10][12] = '#'; g[12][10] = '#'; g[12][12] = '#';

  const put = (r, c, ch) => { if (g[r] && g[r][c] === '.') g[r][c] = ch; };
  // Spawns: spread around the ring and the corner chambers, never in the central hall.
  for (const [r, c] of [[2, 2], [2, 20], [20, 2], [20, 20], [2, 11], [20, 11],
                        [11, 2], [11, 20], [6, 6], [6, 16], [16, 6], [16, 16]]) put(r, c, 'S');
  // Ammo in the spokes and the hall corners — restocking means leaving cover.
  for (const [r, c] of [[6, 11], [16, 11], [11, 6], [11, 16], [9, 9], [13, 13]]) put(r, c, 'A');
  // Torches along the ring and the hall edge.
  for (const [r, c] of [[3, 6], [3, 16], [19, 6], [19, 16], [6, 3], [16, 3], [6, 19], [16, 19],
                        [8, 11], [14, 11], [11, 8], [11, 14], [2, 8], [20, 14]]) put(r, c, 'T');

  return g.map((row) => row.join(''));
}

const DUNGEON_MAP = carveDungeon();

// Shared geometry — one box, one plane, reused by every tile.
const dungeonWallGeo = new THREE.BoxGeometry(DUNGEON_TILE, DUNGEON_CEIL, DUNGEON_TILE);
const dungeonTileGeo = new THREE.PlaneGeometry(DUNGEON_TILE, DUNGEON_TILE);

/**
 * Procedural stone. The dungeon read as flat coloured boxes because it literally was flat
 * coloured boxes — no map of any kind. This draws a masonry pattern into a canvas once
 * (mortar courses, per-brick tone variation, speckle and a little wear) and derives a bump
 * map from it, which is what makes the surfaces catch the torchlight.
 *
 * Generated rather than downloaded so the map cannot end up untextured if a CDN is blocked.
 */
function makeStoneTexture({ size = 256, rows = 6, cols = 6, base = [122, 112, 96],
                            mortar = [58, 52, 44], jitter = 26, seedSpeckle = 0.16 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rgb = (a) => `rgb(${a[0]|0},${a[1]|0},${a[2]|0})`;

  g.fillStyle = rgb(mortar);
  g.fillRect(0, 0, size, size);

  const bw = size / cols, bh = size / rows, gap = Math.max(1.5, size * 0.008);
  for (let r = 0; r < rows; r++) {
    // Every other course is offset half a brick, the way real masonry is laid.
    const offset = (r % 2) * bw * 0.5;
    for (let i = -1; i <= cols; i++) {
      const x = i * bw + offset, y = r * bh;
      const v = (Math.random() - 0.5) * 2 * jitter;
      g.fillStyle = rgb([base[0] + v, base[1] + v, base[2] + v]);
      g.fillRect(x + gap, y + gap, bw - gap * 2, bh - gap * 2);
      // A darker corner wash so bricks are not perfectly flat.
      g.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.09})`;
      g.fillRect(x + gap, y + bh - gap * 3, bw - gap * 2, gap * 2);
    }
  }
  // Speckle for grain.
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.random() > seedSpeckle) continue;
    const n = (Math.random() - 0.5) * 42;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
  return tex;
}

const STONE_WALL_TEX = makeStoneTexture({ rows: 5, cols: 5, base: [126, 116, 99] });
const STONE_FLOOR_TEX = makeStoneTexture({ rows: 4, cols: 4, base: [138, 129, 112], jitter: 20 });
const STONE_CEIL_TEX = makeStoneTexture({ rows: 3, cols: 3, base: [86, 78, 66], jitter: 14 });
for (const [t, n] of [[STONE_WALL_TEX, 1], [STONE_FLOOR_TEX, 1], [STONE_CEIL_TEX, 1]]) t.repeat.set(n, n);

const DUNGEON_MATS = {
  // Textured stone, and deliberately mid-tone rather than "realistically" black — two passes
  // of this map came back as unplayably dark.
  floor: new THREE.MeshStandardMaterial({
    map: STONE_FLOOR_TEX, bumpMap: STONE_FLOOR_TEX, bumpScale: 0.04,
    color: 0xbfb6a4, roughness: 0.95, metalness: 0.02,
  }),
  wall: new THREE.MeshStandardMaterial({
    map: STONE_WALL_TEX, bumpMap: STONE_WALL_TEX, bumpScale: 0.06,
    color: 0xb3a893, roughness: 0.92, metalness: 0.03,
  }),
  ceiling: new THREE.MeshStandardMaterial({
    map: STONE_CEIL_TEX, color: 0x8d8477, roughness: 1.0, metalness: 0.0,
  }),
  torch: new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.75, metalness: 0.55 }),
  torchWood: new THREE.MeshStandardMaterial({ color: 0x3d2a1a, roughness: 0.95, metalness: 0.0 }),
  // Three nested cones read as fire far better than one flat one: deep ember at the edge,
  // orange body, near-white core.
  flameOuter: new THREE.MeshBasicMaterial({
    color: 0xc23a08, transparent: true, opacity: 0.45, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  flameMid: new THREE.MeshBasicMaterial({
    color: 0xff8a1e, transparent: true, opacity: 0.8, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  flameCore: new THREE.MeshBasicMaterial({ color: 0xffe6a8 }),
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

/**
 * Wall sconce: an iron bracket and cradle holding a burning log, with a layered flame.
 * The old version was a plain cone stuck on a stick. This one builds the flame from three
 * nested, differently-tinted cones (deep red at the base through to near-white at the core)
 * with a soft additive halo, which is what actually sells fire at a distance.
 */
function addTorch(x, y, z, yaw) {
  const g = new THREE.Group();

  // Wall plate and an S-curved arm out from it.
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.05), DUNGEON_MATS.torch);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.34, 6), DUNGEON_MATS.torch);
  arm.rotation.x = Math.PI / 2.6;
  arm.position.set(0, 0.06, -0.13);
  // Cradle ring the log sits in.
  const cradle = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 5, 10), DUNGEON_MATS.torch);
  cradle.rotation.x = Math.PI / 2;
  cradle.position.set(0, 0.20, -0.24);
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.26, 7), DUNGEON_MATS.torchWood);
  log.position.set(0, 0.16, -0.24);
  log.rotation.x = -0.12;
  g.add(plate, arm, cradle, log);

  // Flame: outer haze, mid body, bright core.
  const flame = new THREE.Group();
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 8), DUNGEON_MATS.flameOuter);
  const mid = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.30, 8), DUNGEON_MATS.flameMid);
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 8), DUNGEON_MATS.flameCore);
  outer.position.y = 0.21; mid.position.y = 0.15; core.position.y = 0.09;
  flame.add(outer, mid, core);
  flame.position.set(0, 0.30, -0.24);
  g.add(flame);

  // Soft glow billboard so the sconce reads as a light source, not a lit object.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: 0xff9a3c, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(1.5);
  halo.position.set(0, 0.34, -0.24);
  g.add(halo);

  g.position.set(x, y, z);
  g.rotation.y = yaw;
  mapGroup.add(g);

  // The actual illumination is a request for a shared slot, positioned in world space.
  const wx = x - Math.sin(yaw) * 0.24, wz = z - Math.cos(yaw) * 0.24;
  const emitter = addLightEmitter({
    x: wx, y: y + 0.34, z: wz, color: 0xff8c2a, intensity: 34, distance: 11, priority: 0,
  });
  dungeonTorches.push({ emitter, flame, halo, base: 34, phase: rand(0, Math.PI * 2) });
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
    const f = 1 + Math.sin(t * 8 + tc.phase) * 0.3 + Math.sin(t * 3.3 + tc.phase) * 0.12;
    tc.emitter.intensity = tc.base * f;
    // Flames stretch vertically as they gutter rather than scaling uniformly.
    tc.flame.scale.set(1 + Math.sin(t * 13 + tc.phase) * 0.09, f, 1 + Math.cos(t * 11 + tc.phase) * 0.09);
    tc.halo.material.opacity = 0.36 + f * 0.16;
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
        // Rock buried behind other rock is never seen and never touched, so it gets neither
        // geometry nor a collider — only cells with an open neighbour do. On this layout that
        // is roughly a third of the wall cells, and it is the difference between a map that
        // costs 400 draw calls and one that costs 140.
        const exposed = dungeonOpen(r - 1, c) || dungeonOpen(r + 1, c)
                     || dungeonOpen(r, c - 1) || dungeonOpen(r, c + 1)
                     || dungeonOpen(r - 1, c - 1) || dungeonOpen(r - 1, c + 1)
                     || dungeonOpen(r + 1, c - 1) || dungeonOpen(r + 1, c + 1);
        addBlocker(x, z, H, H);
        if (!exposed) continue;
        const m = new THREE.Mesh(dungeonWallGeo, DUNGEON_MATS.wall);
        m.position.set(x, DUNGEON_CEIL / 2, z);
        m.castShadow = true; m.receiveShadow = true;
        mapGroup.add(m);
        addStaticBox(H, DUNGEON_CEIL / 2, H, { x, y: DUNGEON_CEIL / 2, z });
        continue;
      }

      dungeonCells.push({ x, z, char: ch });
      if (ch === 'T') torchSpots.push([r, c, x, z]);
      if (ch === 'A') chestSpots.push([x, z]);
      if (ch === 'S') spawnSpots.push([x, z]);

      // Prefer the kit's own floor tile; fall back to a plain slab.
      if (!placeDungeonPiece('dungeonFloor', x, z)) {
        const f = new THREE.Mesh(dungeonTileGeo, DUNGEON_MATS.floor);
        f.rotation.x = -Math.PI / 2;
        f.position.set(x, 0.01, z);
        f.receiveShadow = true;
        mapGroup.add(f);
      }
      // Ceiling slab, so looking up is stone rather than sky.
      const ceil = new THREE.Mesh(dungeonTileGeo, DUNGEON_MATS.ceiling);
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

  // Health and shield go in the corner chambers, deliberately off the ammo route.
  const T = DUNGEON_TILE, gx = (c) => (c - (DUNGEON_COLS - 1) / 2) * T, gz = (r) => (r - (DUNGEON_ROWS - 1) / 2) * T;
  spawnConsumables([
    ['health', gx(6), gz(6)], ['health', gx(16), gz(16)],
    ['health', gx(11), gz(2)], ['health', gx(11), gz(20)],
    ['shield', gx(16), gz(6)], ['shield', gx(6), gz(16)],
    ['shield', gx(2), gz(11)], ['shield', gx(20), gz(11)],
  ]);
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

function buildMapLayer(extent = A, plates = { ground: 0x141a21, solid: 0x5c6b7a }) {
  const g = new THREE.Group();

  const ground = new THREE.Mesh(MAP_PLATE_GEO,
    new THREE.MeshBasicMaterial({ color: plates.ground, fog: false }));
  ground.scale.set(extent * 2, extent * 2, 1);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.02;
  g.add(ground);

  const solidMat = new THREE.MeshBasicMaterial({ color: plates.solid, fog: false });
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

/**
 * Geometry that outlives any single map. The dungeon reuses one box and one plane across
 * hundreds of tiles, so these must survive clearMap() or the second visit to a map renders
 * nothing. Anything not in here is per-mesh and safe to free.
 */
const SHARED_GEO = new Set();

function markShared(...geos) { for (const g of geos) SHARED_GEO.add(g); }
markShared(dungeonWallGeo, dungeonTileGeo, MAP_PLATE_GEO);

function disposeTree(root) {
  root.traverse((o) => {
    if (o.isMesh && o.geometry && !SHARED_GEO.has(o.geometry)) {
      o.geometry.dispose();
      // Materials are frequently shared (MATS.*, DRESS_MATS.*, DUNGEON_MATS.*) — disposing
      // them here would blank the next map. Geometry is usually per-mesh, so only that is
      // freed, and only when it is not in SHARED_GEO.
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

  // Every emitter belongs to the map that registered it; blast leases are transient and are
  // released by updateExplosionFx. Clearing the array is what keeps the slot pool honest.
  lightEmitters.length = 0;
  for (const l of lightSlots) l.intensity = 0;
  dungeonTorches.length = 0;
  dungeonChains.length = 0;

  if (mapLayerGroup) {
    scene.remove(mapLayerGroup);
    disposeTree(mapLayerGroup);
    mapLayerGroup = null;
  }

  for (const c of ammoChests) { scene.remove(c.mesh); removeLightEmitter(c.emitter); }
  ammoChests.length = 0;
  for (const c of consumables) { scene.remove(c.mesh); removeLightEmitter(c.emitter); }
  consumables.length = 0;

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

  document.getElementById('pause').addEventListener('click', requestLock);
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

  // Look. Cubed for fine control, and scaled by dt so it is frame-rate independent.
  const lookRate = 3.4 * settings.sensitivity * dt;
  player.yaw -= (lookX ** 3) * lookRate;
  player.pitch -= (lookY ** 3) * lookRate * (settings.invertY ? -1 : 1);
  player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

  const down = (i) => !!(btn[i] && btn[i].pressed);
  const pressed = (i) => { const d = down(i); const was = gpPrev[i]; gpPrev[i] = d; return d && !was; };

  aiming = down(6) || (settings.toggleAim && aiming);      // LT
  if (down(7)) { if (!firing) { firing = true; tryFire(); } }   // RT
  else firing = false;
  if (down(7) && currentWeapon().auto) tryFire();

  keys.Space = down(0);                                     // A
  if (pressed(1)) crouchLatch = !crouchLatch;               // B toggles crouch
  keys.KeyC = down(1);
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
  const adsMult = aiming && currentWeapon().zoom ? 0.4 : (aiming ? settings.adsSensitivity : 1);
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
    ceilY: CONFIG.CEIL,
    nav: { extent: 46, step: 8.5, pad: 1.1, coverPad: 3.6 },
    layerExtent: A,
    plates: { ground: 0x141a21, solid: 0x5c6b7a },
    lighting: {
      ambient: { color: 0x8ea6c0, intensity: 0.4 },
      hemi: { sky: 0x7f9bb8, ground: 0x232830, intensity: 0.75 },
      sun: { color: 0xfff1dc, intensity: 1.7, pos: [38, 62, 26], extent: A * 1.05, far: 170 },
    },
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
      // Health and shield sit away from the ammo, so topping up costs a separate trip.
      spawnConsumables([
        ['health', 0, 20], ['health', 0, -20], ['health', -34, -34], ['health', 34, 34],
        ['shield', 20, 0], ['shield', -20, 0], ['shield', 34, -34], ['shield', -34, 34],
      ]);
    },
  },
  dungeon: {
    name: 'DUNGEON',
    blurb: 'Tight stone corridors, torchlight, choke points everywhere.',
    background: 0x1a1410,
    fog: { color: 0x140d07, near: 8, far: 60 },
    mapView: 44,
    ceilY: DUNGEON_CEIL,
    nav: { extent: 40, step: DUNGEON_TILE, pad: 0.9, coverPad: 2.6 },
    layerExtent: 44,
    // High-contrast plan: on the warehouse palette the dungeon minimap was near-black on
    // near-black and unreadable.
    plates: { ground: 0x120d08, solid: 0xb08a52 },
    lighting: {
      // Deliberately much brighter than a "realistic" dungeon. Two passes of this map were
      // reported as unplayably black; atmosphere is worth nothing if you cannot see a target.
      ambient: { color: 0x9c8a72, intensity: 1.15 },
      hemi: { sky: 0xa08d70, ground: 0x3a2c20, intensity: 0.95 },
      sun: { color: 0xffd9ad, intensity: 0.95, pos: [20, 50, 14], extent: 46, far: 130 },
    },
    build() { buildDungeonMap(); },
  },
};

let currentMapId = 'warehouse';

/** Build a level from scratch. Assumes clearMap() has already run if one was loaded. */
function buildMap(id) {
  const m = MAPS[id];
  currentMapId = id;
  // Must be set before m.build() runs — the spawners below it cast down from here.
  spawnCastY = (m.ceilY ?? CONFIG.CEIL) - 0.5;

  scene.background = new THREE.Color(m.background);
  scene.fog = new THREE.Fog(m.fog.color, m.fog.near, m.fog.far);

  mapCamera.left = -m.mapView / 2; mapCamera.right = m.mapView / 2;
  mapCamera.top = m.mapView / 2; mapCamera.bottom = -m.mapView / 2;
  mapCamera.updateProjectionMatrix();

  // Re-tint the shared rig rather than swapping lights in and out — see MAX_POINT_LIGHTS.
  const L = m.lighting;
  rigAmbient.color.setHex(L.ambient.color);
  rigAmbient.intensity = L.ambient.intensity;
  rigHemi.color.setHex(L.hemi.sky);
  rigHemi.groundColor.setHex(L.hemi.ground);
  rigHemi.intensity = L.hemi.intensity;
  rigSun.color.setHex(L.sun.color);
  rigSun.intensity = L.sun.intensity;
  rigSun.position.set(...L.sun.pos);
  rigSun.shadow.camera.far = L.sun.far;
  rigSun.shadow.camera.left = -L.sun.extent; rigSun.shadow.camera.right = L.sun.extent;
  rigSun.shadow.camera.top = L.sun.extent; rigSun.shadow.camera.bottom = -L.sun.extent;
  rigSun.shadow.camera.updateProjectionMatrix();

  m.build();
  buildWaypoints(m.nav);
  buildMapLayer(m.layerExtent, m.plates);
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

  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
  // The viewmodel camera keeps its own, narrower FOV: it framed the gun at 72 against the
  // world's 78, so it tracks the world FOV by the same ratio rather than matching it.
  vmCamera.fov = clamp(settings.fov * (72 / 78), 40, 100);
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
  // Density scales with the graphics preset: fewer, slightly larger particles read almost
  // the same and cost proportionally less to integrate and upload.
  const n = Math.max(1, Math.round(count * QUALITY[settings.quality].particles));
  for (let i = 0; i < n; i++) {
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
markShared(decalGeo);
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
markShared(shockGeo);
const shocks = [];
const blastLights = [];

/**
 * Shock rings are pooled for the same reason the lights are: a fresh MeshBasicMaterial per
 * detonation meant a fresh shader program on the first one (measured at 208 ms). Eight rings
 * is more than can be on screen at once, and each keeps its own material so they can fade
 * independently.
 */
const SHOCK_POOL = 8;
const shockRings = [];
for (let i = 0; i < SHOCK_POOL; i++) {
  const m = new THREE.Mesh(shockGeo, new THREE.MeshBasicMaterial({
    color: 0xffd08a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
  }));
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  m.frustumCulled = false;
  scene.add(m);
  shockRings.push({ mesh: m, busy: false });
}

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

  const slot = shockRings.find((r) => !r.busy);
  if (slot) {
    slot.busy = true;
    slot.mesh.visible = true;
    slot.mesh.position.set(pos.x, pos.y + 0.15, pos.z);
    slot.mesh.scale.setScalar(1);
    slot.mesh.material.opacity = 0.9;
    shocks.push({ slot, t: 0 });
  }

  // Leases a slot rather than creating a light. Creating one here was costing a full shader
  // recompile on detonation and another when it was removed 0.2 s later.
  const emitter = addLightEmitter({
    x: pos.x, y: pos.y + 0.5, z: pos.z,
    color: 0xffd9a0, intensity: 900, distance: 18,
    priority: 10,                              // outbids torches and lamps for a slot
  });
  blastLights.push({ emitter, t: 0 });
}

function updateExplosionFx(dt) {
  for (let i = shocks.length - 1; i >= 0; i--) {
    const s = shocks[i];
    s.t += dt;
    const k = s.t / 0.4;
    s.slot.mesh.scale.setScalar(1 + k * 9);
    s.slot.mesh.material.opacity = clamp(0.9 * (1 - k), 0, 1);
    if (k >= 1) { s.slot.mesh.visible = false; s.slot.busy = false; shocks.splice(i, 1); }
  }
  for (let i = blastLights.length - 1; i >= 0; i--) {
    const b = blastLights[i];
    b.t += dt;
    b.emitter.intensity = 900 * clamp(1 - b.t / 0.2, 0, 1);
    if (b.t >= 0.2) { removeLightEmitter(b.emitter); blastLights.splice(i, 1); }
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
  dmgNums: $('dmgnums'), ammoPrompt: $('ammo-prompt'), allies: $('allies'),
  hitflash: $('hitflash'), vitals: $('vitals'), ammoPromptLabel: $('ammo-prompt-label'),
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
  setTimeout(() => d.remove(), 900);

  // Screen-edge pulse as well: the arc tells you where, this tells you THAT you were hit even
  // if your eyes are on the far side of the screen.
  if (el.hitflash) {
    el.hitflash.style.transition = 'none';
    el.hitflash.style.opacity = '1';
    requestAnimationFrame(() => {
      el.hitflash.style.transition = 'opacity .35s ease-out';
      el.hitflash.style.opacity = '0';
    });
  }
}

/** Crosshair colour and gap are driven from settings via CSS custom properties. */
function applyCrosshairStyle() {
  const root = document.documentElement.style;
  root.setProperty('--xhair', settings.crosshairColor);
  root.setProperty('--xhair-gap', `${settings.crosshairGap}px`);
}

const _dmgProj = new THREE.Vector3();

/** Float the damage dealt above the point of impact, projected to screen space. */
function showDamageNumber(worldPos, amount, headshot, zone = 'body', armored = false) {
  if (!el.dmgNums || amount <= 0 || !settings.showDamageNumbers) return;
  _dmgProj.copy(worldPos).project(camera);
  if (_dmgProj.z > 1) return;                       // behind the camera
  const d = document.createElement('div');
  d.className = `dmg-num ${headshot ? 'head' : zone}${armored ? ' armored' : ''}`;
  // Round up, never down: a hit that landed must never print as 0, and printing 8 for 8.6
  // made weapons feel weaker than they are.
  d.textContent = Math.max(1, Math.ceil(amount));
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
  return { root, fill, bar };
}

/**
 * Ally markers. Unlike the enemy nameplates these are deliberately NOT gated on line of
 * sight — the whole point is knowing where your team is when you cannot see them. Markers for
 * allies outside the view are clamped to the screen edge and pointed at, the way squad markers
 * work in any team shooter.
 */
const _allyProj = new THREE.Vector3();
const allyMarks = new Map();

function updateAllyMarkers() {
  if (!el.allies) return;
  if (player.team === TEAM.SOLO) {
    for (const [, m] of allyMarks) m.root.style.display = 'none';
    return;
  }

  for (const b of bots) {
    if (b.team !== player.team) continue;
    let m = allyMarks.get(b);
    if (!m) {
      const root = document.createElement('div');
      root.className = 'ally-mark';
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '▲';
      const name = document.createElement('span');
      name.textContent = b.name;
      const hp = document.createElement('span');
      hp.className = 'ahp';
      const fill = document.createElement('i');
      hp.appendChild(fill);
      root.append(chev, name, hp);
      el.allies.appendChild(root);
      m = { root, fill };
      allyMarks.set(b, m);
    }
    if (!b.alive) { m.root.style.display = 'none'; continue; }

    _allyProj.set(b.pos.x, b.pos.y + 1.0, b.pos.z).project(camera);
    const behind = _allyProj.z > 1;
    let sx = (_allyProj.x * 0.5 + 0.5) * innerWidth;
    let sy = (-_allyProj.y * 0.5 + 0.5) * innerHeight;
    if (behind) { sx = innerWidth - sx; sy = innerHeight - 40; }

    const off = behind || sx < 40 || sx > innerWidth - 40 || sy < 40 || sy > innerHeight - 40;
    m.root.classList.toggle('off', off);
    m.root.style.display = '';
    m.root.style.left = `${clamp(sx, 40, innerWidth - 40)}px`;
    m.root.style.top = `${clamp(sy, 40, innerHeight - 60)}px`;
    m.fill.style.transform = `scaleX(${clamp(b.health / 100, 0, 1)})`;
  }
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
    // b.pos is the chest, so this lands a little above the top of the head at BOT_TARGET_HEIGHT.
    _proj.set(b.pos.x, b.pos.y + 0.95, b.pos.z).project(camera);
    // z > 1 means it is behind the near plane — otherwise the plate mirrors behind you.
    if (_proj.z > 1 || Math.abs(_proj.x) > 1.3) { p.root.style.display = 'none'; continue; }
    const d = b.pos.distanceTo(camera.position);
    if (d > 55) { p.root.style.display = 'none'; continue; }
    if (recheck) {
      // Sample three points up the body, not just the chest, and take the plate as visible if
      // ANY of them is clear.
      //
      // This is why nameplates seemed never to appear: a single chest ray is blocked by any
      // crate, railing or low wall a bot is standing behind — which is most of the time — so
      // a bot whose head and shoulders you can plainly see, and can shoot, had no plate.
      //
      // The ray also starts at the camera rather than player.eye. The plate is a screen-space
      // overlay projected from the camera, so the camera is the geometrically correct origin;
      // view bob, shake and the crouch offset make eye and camera disagree by enough to matter
      // when you are peeking a corner.
      const ox = camera.position.x, oy = camera.position.y, oz = camera.position.z;
      b.plateLos =
        losClear(ox, oy, oz, b.pos.x, b.pos.y + b.hb.headY, b.pos.z) ||
        losClear(ox, oy, oz, b.pos.x, b.pos.y, b.pos.z) ||
        losClear(ox, oy, oz, b.pos.x, b.pos.y - 0.30, b.pos.z);
    }
    if (!b.plateLos) { p.root.style.display = 'none'; continue; }
    p.root.style.display = '';
    p.root.style.left = `${(_proj.x * 0.5 + 0.5) * innerWidth}px`;
    p.root.style.top = `${(-_proj.y * 0.5 + 0.5) * innerHeight}px`;
    // THE reason plates read as sitting ON the head rather than above it: `top` places the
    // element's TOP edge at the projected point, so the whole plate then hangs downward over
    // the model. Pulling it up by its own height puts it where a nameplate belongs. Set
    // inline rather than in CSS so a UI restyle cannot silently drop it.
    p.root.style.transform = 'translateY(-100%)';
    p.root.style.opacity = String(clamp(1.15 - d / 55, 0.25, 1));

    // Enemy health is hidden by default: knowing exactly how close a target is to death is a
    // big information advantage, and the floating damage numbers already say how hard you hit.
    // Teammates still show a bar, because coordinating with them needs it.
    const friendly = player.team !== TEAM.SOLO && b.team === player.team;
    const showBar = friendly || settings.showEnemyHealth;
    p.bar.style.display = showBar ? '' : 'none';
    if (showBar) p.fill.style.transform = `scaleX(${clamp(b.health / 100, 0, 1)})`;
    p.root.classList.toggle('hurt', showBar && b.health < 35);
  }
}

function updateVitals() {
  // Critical-health pulse is a class on the panel so the CSS animation owns the timing.
  el.vitals?.classList.toggle('low', player.alive && player.health < 35);
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
  if (on && match.running) { appState = APP_STATE.PAUSED; el.pBig.textContent = 'PAUSED'; el.pSm.textContent = ''; el.pCta.style.display = ''; }
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

const APP_STATE = Object.freeze({ MENU: 0, PLAYING: 1, PAUSED: 2, SETTINGS: 3 });
let appState = APP_STATE.MENU;

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

function startMatch(mode, diffKey, name, mapId = currentMapId) {
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
    if (currentMapId === 'dungeon') updateDungeonFx(dt);
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

/* ------------------------- settings panel ------------------------- */

/**
 * The panel is generated from this table rather than hand-written markup, so adding an option
 * is one line and the control, the label, the live read-out and the persistence all follow.
 */
const SETTINGS_SCHEMA = [
  { group: 'GRAPHICS' },
  {
    key: 'quality', type: 'choice', label: 'Quality preset',
    options: Object.keys(QUALITY).map((k) => ({ value: k, label: QUALITY[k].label })),
    hint: 'Shadows are ~95% of the frame cost. Drop to PERFORMANCE if you see stutter.',
  },
  { group: 'CONTROLS' },
  { key: 'sensitivity', type: 'range', label: 'Mouse sensitivity', min: 0.1, max: 3, step: 0.05 },
  { key: 'adsSensitivity', type: 'range', label: 'Aim-down-sights sensitivity', min: 0.1, max: 1.5, step: 0.05 },
  { key: 'invertY', type: 'toggle', label: 'Invert vertical look' },
  { key: 'viewBob', type: 'toggle', label: 'View bob' },
  { key: 'toggleAim', type: 'toggle', label: 'Aim: press to toggle' ,
    hint: 'Trackpad friendly — right-click toggles aim instead of having to hold it.' },
  { key: 'toggleCrouch', type: 'toggle', label: 'Crouch: press to toggle' },
  { key: 'toggleSprint', type: 'toggle', label: 'Sprint: press to toggle' },
  { key: 'arrowKeys', type: 'toggle', label: 'Arrow keys also move' },
  { group: 'INTERFACE' },
  { key: 'crosshairColor', type: 'color', label: 'Crosshair colour' },
  { key: 'crosshairGap', type: 'range', label: 'Crosshair gap', min: 0, max: 20, step: 1, unit: 'px' },
  { key: 'showDamageNumbers', type: 'toggle', label: 'Floating damage numbers' },
  { key: 'showEnemyHealth', type: 'toggle', label: 'Show enemy health bars',
    hint: 'Off by default — the damage numbers already tell you how hard you hit.' },
  { group: 'AUDIO' },
  { key: 'masterVolume', type: 'range', label: 'Master volume', min: 0, max: 1, step: 0.05 },
];

function buildSettingsPanel() {
  const host = $('settings-body');
  if (!host) return;
  host.innerHTML = '';

  for (const row of SETTINGS_SCHEMA) {
    if (row.group) {
      const h = document.createElement('div');
      h.className = 'set-group';
      h.textContent = row.group;
      host.appendChild(h);
      continue;
    }

    const wrap = document.createElement('label');
    wrap.className = 'set-row';
    const name = document.createElement('span');
    name.className = 'set-label';
    name.textContent = row.label;
    const ctl = document.createElement('span');
    ctl.className = 'set-ctl';

    if (row.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = row.min; input.max = row.max; input.step = row.step;
      input.value = settings[row.key];
      const out = document.createElement('b');
      const show = () => { out.textContent = (+input.value).toFixed(row.step < 1 ? 2 : 0) + (row.unit || ''); };
      show();
      input.addEventListener('input', () => {
        settings[row.key] = parseFloat(input.value);
        show();
        applySettings();
      });
      ctl.append(input, out);
    } else if (row.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!settings[row.key];
      input.addEventListener('change', () => { settings[row.key] = input.checked; applySettings(); });
      ctl.appendChild(input);
    } else if (row.type === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = settings[row.key];
      input.addEventListener('input', () => { settings[row.key] = input.value; applySettings(); });
      ctl.appendChild(input);
    } else if (row.type === 'choice') {
      const box = document.createElement('span');
      box.className = 'set-choice';
      for (const o of row.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = o.label;
        b.className = settings[row.key] === o.value ? 'active' : '';
        b.addEventListener('click', () => {
          settings[row.key] = o.value;
          box.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          applySettings();
        });
        box.appendChild(b);
      }
      ctl.appendChild(box);
    }

    wrap.append(name, ctl);
    host.appendChild(wrap);
    if (row.hint) {
      const h = document.createElement('div');
      h.className = 'set-hint';
      h.textContent = row.hint;
      host.appendChild(h);
    }
  }
}

function showSettings(on) {
  const panel = $('settings');
  if (!panel) return;
  if (on) {
    buildSettingsPanel();
    if (match.running) appState = APP_STATE.SETTINGS;
  }
  panel.classList.toggle('hidden', !on);
  if (on) document.exitPointerLock?.();
}

function bindSettings() {
  buildSettingsPanel();
  $('settings-open')?.addEventListener('click', () => showSettings(true));
  $('settings-open-pause')?.addEventListener('click', () => showSettings(true));
  $('settings-close')?.addEventListener('click', () => {
    showSettings(false);
    if (match.running) requestLock();
  });
  $('settings-reset')?.addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    applySettings();
    buildSettingsPanel();
  });
  // Leaving the match from the pause overlay.
  $('quit-match')?.addEventListener('click', () => {
    endMatch('MATCH ABANDONED', 'returned to menu');
  });
}

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
    currentMapId: () => currentMapId,
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






