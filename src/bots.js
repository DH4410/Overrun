import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

import { TEAM, TEAM_COLOR } from './config.js';
import { G_BODY, MAT_BODY, RAY_OPTS, world } from './physics.js';
import { HB_BOT } from './projectiles.js';
import { matte } from './rendering.js';
import { clamp, lerp, pick, rand, randInt } from './utils.js';
import { buildGunModel, gunMaterials } from './gunmodels.js';
import { BOT_GUN_IDS, WEAPON_BY_ID } from './weapons.js';

/**
 * Bot aim error, in radians. These were tuned against a measured duel rather than guessed:
 * a single bot with a fixed AR, a verified clear lane, and a fixed range, counting hits per
 * round fired. Before tuning, a medium bot hit a stationary target 89% of the time at 15 m and
 * a hard bot 99.6% — which is exactly the "they never miss" complaint.
 *
 * Targets, per bullet at 15 m against a stationary player: easy ~15%, medium ~30%, hard ~50%.
 * Those look low written down, but a burst is many rounds and bots fight in groups.
 *
 * These are DEFAULTS. Any tier in DIFFICULTY may override any field via its `aim` block,
 * because one global floor caps how good the best possible bot can be: floor 0.030 rad is
 * 45 cm of error at 15 m, wider than a torso, so no `accuracy` value could ever produce a
 * bot that wins a duel on aim. The elite tier lowers the floor by an order of magnitude
 * rather than pushing `accuracy` against a wall it cannot get past.
 */
export const AIM = {
  // A fixed angular error already gets harder to land as range grows, so the range term is
  // deliberately small — the first tuning pass double-counted it and bots became useless past
  // 30 m (2.8% per round at 35 m). The floor is what stops a hard bot being a hitscan laser.
  floor: 0.030,      // even a perfect bot is not a laser
  base: 0.15,        // scaled by (1 - skill)
  range: 0.06,       // per unit of (distance / 100), scaled by (1 - skill)
  tracking: 0.020,   // per m/s of target lateral speed
  snap: 0.12,        // penalty immediately after acquiring, decays as aim settles

  // --- fields the tiers below tune; the defaults reproduce the pre-existing behaviour ---

  /** How fast the snap penalty decays, in units of `aimSettle` per second. 1.0 means the
   *  penalty is gone one second after acquiring. */
  settle: 1.0,
  /** Share of the gun's mechanical spread folded into the aim jitter. This is on top of the
   *  cone fireWeapon() applies, so at 1.0 a bot eats its weapon's spread roughly twice. */
  weaponFrac: 0.5,
  /** Multiplier handed to fireWeapon() as spreadMult — the bot's trigger discipline. */
  weaponSpreadMult: 1.0,
  /** Extra cone per m/s of the BOT's own planar speed. Zero here keeps existing tiers as
   *  they were; it is what makes counter-strafing worth doing for the tiers that do it. */
  moveSpread: 0.0,
  /** Fraction of shots aimed at the head rather than the chest. */
  headBias: 0.0,
  /** Stop moving this many seconds before the shot lands, to clear `moveSpread`. 0 = never. */
  counterStrafe: 0.0,
  /** Time constant, in seconds, of how fast aim height and lead catch up with a target that
   *  drops or changes direction. It is what makes crouching and strafe-jiggling a dodge. */
  trackLag: 0.32,
};

/** Resolve a tier's aim profile against the defaults. */
export function aimProfile(diff) {
  return { ...AIM, ...(diff?.aim ?? {}) };
}

/** The range each bot weapon wants to fight at. Inside min it backs off, beyond max it closes. */
export const BOT_RANGE_BAND = {
  pistol:  { min: 5,  max: 16 },
  ar:      { min: 8,  max: 26 },
  shotgun: { min: 3,  max: 9  },
  sniper:  { min: 18, max: 50 },
};

export const DIFFICULTY = {
  easy:   { label: 'EASY',   accuracy: 0.40, reaction: 0.80, bots: 3, aggression: 0.55, fireMult: 1.35, speed: 0.85, aim: { trackLag: 0.45 } },
  medium: { label: 'MEDIUM', accuracy: 0.65, reaction: 0.50, bots: 4, aggression: 0.75, fireMult: 1.10, speed: 1.0 },
  hard:   { label: 'HARD',   accuracy: 0.85, reaction: 0.20, bots: 5, aggression: 0.95, fireMult: 1.0, speed: 1.18, aim: { trackLag: 0.22 } },

  /**
   * The 1v1 duel opponent. Not "hard with bigger numbers" — a different shooter.
   *
   * Sized against what the head actually subtends, which is the only number that matters for
   * a bot meant to headshot you. The player's head sphere is HB_PLAYER.headR = 0.27 m, so at
   * 15 m it covers atan(0.27 / 15) = 0.018 rad. A settled elite shot lands inside roughly
   * 0.0045 rad there (floor 0.0032, plus 0.02 x base, plus the range term), about a quarter
   * of the head — so a standing target loses, and that is the point.
   *
   * What keeps it a duel rather than an aimbot is that none of that survives movement:
   *   - `tracking` still charges it for your lateral speed, so strafing degrades its aim;
   *   - `moveSpread` charges it for its OWN speed, so it has to stop to shoot straight, and
   *     `counterStrafe` is it doing exactly that — the stop is a real, punishable window;
   *   - `reaction` 0.18 s is a fast human, not zero. You can still win the peek.
   * Beat it by never being the one standing still.
   *
   * Measured by tests/e2e/duel.spec.mjs — 60 AR rounds down a verified-clear 20 m lane at a
   * stationary target, settled aim:
   *
   *            hit rate   headshot share
   *   hard        0.38         0.04
   *   elite       1.00         0.82
   *   elite, while strafing at 4.6 m/s:  0.03
   *
   * (Hard read 0.72 before the player's hitbox was fixed: its "limb" cylinder was 1.6x the
   * torso's radius and caught rounds that passed well clear of the body. Every torso hit a bot
   * lands now counts in full instead of as a 0.6x limb hit, so it fights about as hard as it did.)
   *
   * The headshot share is the real gap: elite converts a hit into a kill roughly twice as
   * fast as any other tier even where the raw hit rates are close. The strafing row is the
   * counter-play, and the test asserts it stays that way.
   */
  elite: {
    label: 'ELITE', accuracy: 0.98, reaction: 0.18, bots: 1, aggression: 1.0,
    fireMult: 0.92, speed: 1.22,
    aim: {
      floor: 0.0032,
      base: 0.05,
      range: 0.02,
      tracking: 0.034,       // HIGHER than the other tiers: strafing is the counter-play
      snap: 0.05,
      settle: 5.5,           // settles in ~0.18 s, matching its reaction time
      weaponFrac: 0.0,       // does not double-count its own gun's cone
      weaponSpreadMult: 0.12,
      moveSpread: 0.055,     // 4.6 m/s of strafe costs it 0.25 rad — it cannot run and shoot
      headBias: 0.8,
      counterStrafe: 0.11,
      trackLag: 0.14,
    },
  },
};

export const BOT_NAMES = [
  'VIPER', 'HAVOC', 'RAZOR', 'GHOST', 'TALON', 'ONYX', 'BRAVO', 'CIPHER',
  'DELTA', 'KILO', 'NOMAD', 'REAPER', 'SABLE', 'VECTOR', 'WRAITH', 'ZERO',
];

/** Bot models, animation, navigation, perception, and combat state machine. */
export function createBotRuntime({
  scene,
  camera,
  modelLoader,
  blipLayer: L_BLIP,
  combatants,
  waypoints,
  findPath,
  losClear,
  smokeBlocks,
  fireWeapon,
  throwGrenade,
  pickSpawn,
  spawnPickup,
  makePlate,
  Audio,
}) {
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function boxPart(w, h, d, x, y, z, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}


/* ================================================================== *
 * === BOTS ===
 * ================================================================== */

const bots = [];
// Mutual repulsion between bots — see setPlanarVelocity.
const SEP_RADIUS = 2.5;       // metres at which neighbours start pushing apart
const SEP_STRENGTH = 3.2;     // m/s of push at zero distance
// Locomotion rate limits, m/s^2. The player's MOVE_ACCEL is 60, deliberately arcade-snappy;
// bots spin up slower so their direction changes are readable and punishable. At BOT_ACCEL a
// bot needs ~0.18 s to reach its 4.6 m/s combat speed from a standstill.
const BOT_ACCEL = 26;
const BOT_DECEL = 34;
// Seconds without getting any closer to the next path node before a bot counts as stuck.
const STUCK_AFTER = 0.8;
// How far ahead combat footwork looks for walls and edges, in metres.
const PROBE_AHEAD = 1.1;
// Cover peek rhythm, in seconds: lean out for PEEK_SHOW, tuck back for PEEK_HIDE.
const PEEK_SHOW = 0.9;
const PEEK_HIDE = 1.1;
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

/**
 * Fallback planar speeds (m/s) for locomotion clips that carry no root motion to measure.
 *
 * The shipped clips DO carry root motion (see stripRootMotion), and their real speeds are
 * measured from it per character — these nominal Mixamo rates were off by up to 40%, which
 * is why a chasing bot's legs used to paddle faster than the ground under it.
 */
const CLIP_SPEED = {
  Walk: 1.6,
  Run: 4.4,
  WalkBack: 1.4,
  StrafeLeft: 1.5,
  StrafeRight: 1.5,
};


/**
 * Which way to turn a Mixamo spine bone about its X axis so the chest follows the aim
 * (positive aimPitch = target above).
 *
 * Measured on the live rig, not assumed: +0.5 rad on Spine1 and Spine2 moved the head 0.16 to
 * 0.23 m FORWARD, i.e. a positive rotation hunches the chest down. So aiming up needs the
 * negative. This only became visible once facingCorrection() turned the models round — while
 * they were drawn backwards, bowing toward the model's front was bowing away from the target.
 */
const AIM_PITCH_SIGN = -1;

/** Lower-body turn limits, in radians: toward a sideways move, and while backpedalling. */
const LEG_TURN_MAX = 1.25;
const LEG_BACK_MAX = 0.6;
/** Beyond this angle off facing, a move counts as backpedalling. */
const LEG_FWD_MAX = 1.95;
/** How far the muzzle dips below level in the ready carry. */
const READY_DIP = 0.55;

const UP = new THREE.Vector3(0, 1, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _tq = new THREE.Quaternion();
const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3(), _b3 = new THREE.Vector3();
const _bm = new THREE.Matrix4();
const _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3(), _a3 = new THREE.Vector3();
const _aq1 = new THREE.Quaternion(), _aq2 = new THREE.Quaternion(), _aq3 = new THREE.Quaternion();
const _k1 = new THREE.Vector3(), _k2 = new THREE.Vector3(), _k3 = new THREE.Vector3(), _k4 = new THREE.Vector3();
const _k5 = new THREE.Vector3(), _k6 = new THREE.Vector3(), _k7 = new THREE.Vector3();
const _o1 = new THREE.Vector3(), _o2 = new THREE.Vector3(), _o3 = new THREE.Vector3();
const _o4 = new THREE.Vector3(), _o5 = new THREE.Vector3(), _o6 = new THREE.Vector3();
const _om1 = new THREE.Matrix4(), _om2 = new THREE.Matrix4();
const _oq1 = new THREE.Quaternion(), _oq2 = new THREE.Quaternion();
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _g3 = new THREE.Vector3(), _g4 = new THREE.Vector3();
const _g5 = new THREE.Vector3(), _g6 = new THREE.Vector3(), _g7 = new THREE.Vector3(), _g8 = new THREE.Vector3();
const _g9 = new THREE.Vector3(), _g10 = new THREE.Vector3(), _gPos = new THREE.Vector3(), _gScale = new THREE.Vector3();
const _qAim = new THREE.Quaternion(), _qLow = new THREE.Quaternion(), _qGun = new THREE.Quaternion();
const _mGun = new THREE.Matrix4(), _mInv = new THREE.Matrix4();
const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3(), _h4 = new THREE.Vector3();
const _h5 = new THREE.Vector3(), _h6 = new THREE.Vector3(), _h7 = new THREE.Vector3(), _h8 = new THREE.Vector3();
const _h9 = new THREE.Vector3();
const _hb1 = new THREE.Vector3(), _hb2 = new THREE.Vector3();

/** Bones the rig code needs, by their name with the Mixamo prefix stripped. */
const RIG_BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandMiddle1', 'LeftHandThumb1',
  'RightArm', 'RightForeArm', 'RightHand', 'RightHandMiddle1', 'RightHandThumb1',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
  'HeadTop_End',
];

/**
 * Hit capsules on the skeleton: [from bone, to bone, radius in metres, zone]. A null `to` is a
 * sphere at the bone. Zone indices match ZONES in projectiles.js: 0 head, 1 body, 2 arm, 3 leg.
 * Radii are for the 2 m characters, sized to the models' silhouettes rather than to anatomy,
 * and slightly generous — a round that visibly touches a sleeve should count.
 */
const HIT_CAPSULES = [
  ['Hips', 'Spine1', 0.17, 1],
  ['Spine1', 'Spine2', 0.18, 1],
  ['Spine2', 'Neck', 0.16, 1],
  ['LeftArm', 'RightArm', 0.12, 1],            // across the shoulders: the chest's width
  ['LeftUpLeg', 'RightUpLeg', 0.13, 1],        // pelvis
  ['Neck', 'Head', 0.075, 1],
  ['LeftArm', 'LeftForeArm', 0.065, 2], ['LeftForeArm', 'LeftHand', 0.055, 2], ['LeftHand', null, 0.06, 2],
  ['RightArm', 'RightForeArm', 0.065, 2], ['RightForeArm', 'RightHand', 0.055, 2], ['RightHand', null, 0.06, 2],
  ['LeftUpLeg', 'LeftLeg', 0.095, 3], ['LeftLeg', 'LeftFoot', 0.07, 3], ['LeftFoot', 'LeftToeBase', 0.06, 3],
  ['RightUpLeg', 'RightLeg', 0.095, 3], ['RightLeg', 'RightFoot', 0.07, 3], ['RightFoot', 'RightToeBase', 0.06, 3],
];
/** The head is a sphere at the middle of the skull, which the Head bone is not (it is the base). */
const HEAD_R = 0.14;

const BOT_MESH_SCALE = 1.2;
const BOT_MESH_Y = 0.04;
const BOT_CHEST = 0.50;
const BOT_EYE = 1.05;

/**
 * Locomotion and action clips the bot mesh will bind if they are present.
 *
 * Idle / Walk / Run ship inside soldier.glb. The rest are the names used by additional
 * clips registered through registerBotClips() — retargeting is by track name, and the rig
 * is stock Mixamo, so a clip exported against any Mixamo skeleton binds without remapping.
 * Missing names are simply skipped, so the game degrades to whatever is actually there.
 */
const BOT_CLIP_NAMES = ['Idle', 'Walk', 'Run', 'StrafeLeft', 'StrafeRight', 'WalkBack', 'Crouch', 'Death'];

/** Extra clips registered at boot, keyed by the names above. */
const extraClips = {};

/** Locomotion clips that must play in place, because the physics body moves the bot. */
const IN_PLACE_CLIPS = new Set(['Idle', 'Walk', 'Run', 'StrafeLeft', 'StrafeRight', 'WalkBack', 'Crouch']);

/** Root-motion distance removed from each registered clip, in the clip's own units, by name. */
const clipDrift = {};

/**
 * Make a locomotion clip play in place, and return how far it used to travel per cycle.
 *
 * The Mixamo exports in assets/bots/anim were NOT exported "In Place", whatever the manifest
 * says: the Hips position track walks forward 1.7 m per Walk cycle, 2.5 m per Run cycle and
 * 1.2-1.6 m sideways per strafe, then snaps back when the clip loops. The physics body already
 * moves the bot, so every drawn body ran ahead of where the bot really was and jumped back
 * every 0.7-1.4 s — the "AI lags and teleports" report — and since bullets hit the physics
 * body, the model being aimed at could be two metres from the thing that took the damage.
 *
 * Only the linear drift over the cycle is removed, on the two horizontal axes; the bob and
 * sway within the stride are kept, and the clip still loops seamlessly. "Up" is whichever
 * component carries the hip height, so this does not depend on the exporter's axis convention.
 */
function stripRootMotion(clip) {
  const track = clip.tracks.find((t) => /Hips\.position$/.test(t.name));
  if (!track || track.times.length < 2) return 0;
  const v = track.values, times = track.times, n = times.length;
  // Up is the axis that never comes near zero: the hips are always a leg's length off the
  // floor, while a travelling axis starts at the origin. (The largest average is NOT safe: a
  // Run cycle's forward drift averages more than the hip height.)
  const floor = [Infinity, Infinity, Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) floor[k] = Math.min(floor[k], Math.abs(v[i * 3 + k]));
  const up = floor.indexOf(Math.max(...floor));
  const hipHeight = floor[up];
  const span = times[n - 1] - times[0] || 1;
  let drift2 = 0;
  for (let k = 0; k < 3; k++) {
    if (k === up) continue;
    const d = v[(n - 1) * 3 + k] - v[k];
    drift2 += d * d;
  }
  const drift = Math.sqrt(drift2);
  if (drift < hipHeight * 0.1) return 0;         // already in place
  for (let k = 0; k < 3; k++) {
    if (k === up) continue;
    const d = v[(n - 1) * 3 + k] - v[k];
    for (let i = 0; i < n; i++) v[i * 3 + k] -= d * (times[i] - times[0]) / span;
  }
  return drift;
}

/**
 * Strip the rig prefix and separator so a bone can be matched however it was spelled.
 *
 * Every link in this pipeline spells Mixamo bones differently. Mixamo writes
 * `mixamorig:Hips`; three's FBXLoader drops the colon to `mixamorigHips`; three's
 * GLTFLoader runs names through PropertyBinding.sanitizeNodeName, which also drops it. So
 * the GLB on disk says `mixamorig:Hips` while the same file loaded in the browser says
 * `mixamorigHips`. Comparing against the file rather than against the loaded scene is
 * exactly the mistake that made an earlier version of this "fix" insert a colon the runtime
 * then had no match for.
 *
 * The digit in the pattern is not decorative: characters re-rigged through Mixamo more than
 * once come back prefixed `mixamorig1`, `mixamorig2` and so on (Crypto is one), and those
 * are the same bones under a different label.
 */
const MIXAMO_PREFIX = /^mixamorig\d*[:_]?/i;

function boneKey(name) {
  return name.replace(MIXAMO_PREFIX, '').toLowerCase();
}

/**
 * Rewrite a clip's track names onto the bone names a given skeleton actually uses.
 *
 * Done against the live skeleton rather than against any assumed convention, because the
 * failure is silent: AnimationMixer binds the tracks it can resolve and ignores the rest,
 * so a clip that matches nothing plays perfectly happily and moves nothing at all. Clips
 * are cached per character, since the rewrite only depends on the skeleton.
 */
function retargetClips(clips, root) {
  const byKey = new Map();
  root.traverse((o) => { if (o.isBone) byKey.set(boneKey(o.name), o.name); });

  const out = {};
  for (const [name, clip] of Object.entries(clips)) {
    if (!clip) continue;
    let needsRewrite = false;
    for (const track of clip.tracks) {
      const node = track.name.slice(0, track.name.lastIndexOf('.'));
      if (!byKey.has(boneKey(node))) continue;      // unknown bone: leave it, it just no-ops
      if (byKey.get(boneKey(node)) !== node) { needsRewrite = true; break; }
    }
    if (!needsRewrite) { out[name] = clip; continue; }

    const copy = clip.clone();
    for (const track of copy.tracks) {
      const dot = track.name.lastIndexOf('.');
      const node = track.name.slice(0, dot);
      const target = byKey.get(boneKey(node));
      if (target) track.name = target + track.name.slice(dot);
    }
    out[name] = copy;
  }
  return out;
}

/**
 * Register additional AnimationClips for the bot rig, by clip name.
 *
 * Bots built before this is called keep the clips they bound, so this is meant for boot.
 * Returns the names that were accepted, so a caller can report what actually loaded.
 */
function registerBotClips(clips) {
  const accepted = [];
  for (const [name, clip] of Object.entries(clips)) {
    if (!clip || !BOT_CLIP_NAMES.includes(name)) continue;
    if (IN_PLACE_CLIPS.has(name)) {
      const drift = stripRootMotion(clip);
      if (drift > 0) clipDrift[name] = { drift, duration: clip.duration };
    }
    extraClips[name] = clip;
    accepted.push(name);
  }
  return accepted;
}

/* --------------------- rigged soldier bot mesh --------------------- */

/**
 * The three.js Soldier, used for the bot body when it loads. Measured, not guessed: the model
 * is 1.832 m tall with its feet on the model origin, and it faces -Z (its toes reach z=-0.219
 * against +0.123 at the heel, and the back of the skull protrudes further than the nose) —
 * which is the same convention the procedural mesh uses, so Bot.faceDir needs no change.
 */
let soldierGltf = null;

/**
 * The character roster.
 *
 * Every bot used to be the same stock soldier, which made a firefight read as one model
 * cloned six times and gave teams no silhouette of their own. These are Mixamo characters
 * converted by scripts/fbx-to-glb.mjs, which normalises each one to SOLDIER_HEIGHT and
 * restores the `mixamorig:` bone names — so all of them drive the same clip set and the
 * fitting maths below needs no per-character constants.
 *
 * `teams` says which side a character may appear on. Blue and red get disjoint casts so the
 * team you are looking at is legible from the shape alone, before the kit colour registers;
 * free-for-all draws from everyone, since there are no sides to confuse.
 */
/**
 * The roster. `teams: []` means "only as a last resort", via rosterFor's fallback.
 *
 * The original three.js soldier is fallback-only because the shared Mixamo clip set does not
 * fit its skeleton: measured in a live match, every soldier bot stood with its HEAD 0.3 m BELOW
 * ITS FEET — a crumpled heap on the floor while its Idle weight read 0.99. Its own three clips
 * pose it correctly, but it has no strafe, back-pedal, crouch or death of its own, so any bot
 * using it spent most of a fight mangled. Ely is the same Vanguard character, converted through
 * Mixamo properly. The two sides' casts stay disjoint (tests/e2e/characters.spec.mjs asserts no
 * model appears on both sides): blue is police tactical, red is military and mercenary.
 */
const CHARACTERS = [
  { id: 'soldier', file: './assets/bots/soldier.glb', teams: [] },
  { id: 'swat', file: './assets/bots/swat.glb', teams: [TEAM.SOLO, TEAM.BLUE] },
  { id: 'trooper', file: './assets/bots/trooper.glb', teams: [TEAM.SOLO, TEAM.BLUE] },
  { id: 'gasmask', file: './assets/bots/gasmask.glb', teams: [TEAM.SOLO, TEAM.BLUE] },
  { id: 'crypto', file: './assets/bots/crypto.glb', teams: [TEAM.SOLO, TEAM.RED] },
  { id: 'ely', file: './assets/bots/ely.glb', teams: [TEAM.SOLO, TEAM.RED] },
  { id: 'steve', file: './assets/bots/steve.glb', teams: [TEAM.SOLO, TEAM.RED] },
];

/** Loaded character GLBs, keyed by id. Missing entries simply drop out of the roster. */
const characterGltf = {};

/** Characters available to a team, or the stock soldier if nothing else loaded. */
function rosterFor(team) {
  const usable = CHARACTERS.filter((c) => characterGltf[c.id] && c.teams.includes(team));
  if (usable.length) return usable;
  return CHARACTERS.filter((c) => characterGltf[c.id]);
}

const SOLDIER_HEIGHT = 1.832;   // measured from the GLB's bounding box
const BOT_TARGET_HEIGHT = 2.0;
const BOT_FOOT_Y = -0.65;       // where feet sit in mesh-local space (x BOT_MESH_SCALE = -0.78)
/** Body centre above the soles: the lower collision sphere sits at -0.38 with radius 0.36. */
const BOT_STAND_Y = 0.74;
/**
 * Correction for character scale.
 *
 * The rates above belong to the rig as Mixamo authored it, at SOLDIER_HEIGHT. Bots stand
 * BOT_TARGET_HEIGHT, and scaling a skeleton scales its stride with it, so the same clip on a
 * taller character covers proportionally more ground per cycle. Without this the legs cycle
 * ~9% faster than the ground the bot is actually covering — a slide small enough to look like
 * clumsy animation rather than a bug, which is exactly why it is worth writing down.
 */
const CLIP_SCALE = BOT_TARGET_HEIGHT / SOLDIER_HEIGHT;


/**
 * Load every character in the roster. Each one is optional in exactly the way the props
 * already are: a missing or broken file costs that character, and the game falls back
 * through the remaining roster to the stock soldier and finally to the blocky humanoid.
 */
async function loadSoldier() {
  await Promise.all(CHARACTERS.map(async (c) => {
    try {
      characterGltf[c.id] = await modelLoader.loadAsync(c.file);
    } catch {
      characterGltf[c.id] = null;
    }
  }));
  soldierGltf = characterGltf.soldier ?? null;
  return Object.values(characterGltf).some(Boolean);
}

/**
 * The yaw that turns a character to face its group's -Z.
 *
 * Bots are drawn at `yaw + PI` because the procedural mesh and the original three.js soldier
 * both face -Z. Every Mixamo export faces +Z, so every converted character was drawn facing
 * BACKWARDS: the body moved and aimed one way while the model faced the other. A bot running at
 * you moonwalked, and a bot shooting at you had its back turned — which is most of what a
 * playtest described as "the animation doesn't match the movement". Measured on all three
 * converted characters: toes pointed against the bot's heading with a dot product of -0.97.
 *
 * Measured from each character's own skeleton rather than assumed per file, so a character
 * added through scripts/fbx-to-glb.mjs cannot bring this back. Must run after a clip has posed
 * the skeleton and before the model is rotated or parented, while its matrix is just its own
 * scale.
 */
function facingCorrection(model) {
  model.updateMatrixWorld(true);
  const forward = new THREE.Vector3();
  const foot = new THREE.Vector3();
  const toe = new THREE.Vector3();
  const found = {};
  model.traverse((o) => {
    if (o.isBone) found[o.name.replace(MIXAMO_PREFIX, '')] = o;
  });
  for (const side of ['Left', 'Right']) {
    if (!found[`${side}Foot`] || !found[`${side}ToeBase`]) continue;
    foot.setFromMatrixPosition(found[`${side}Foot`].matrixWorld);
    toe.setFromMatrixPosition(found[`${side}ToeBase`].matrixWorld);
    forward.add(toe.sub(foot));
  }
  if (Math.hypot(forward.x, forward.z) < 1e-6) return 0;   // no feet: leave it as authored
  // Heading in the same sense as Bot.yaw (atan2(x, z)); the group wants it at PI, i.e. -Z.
  // Snapped to a quarter turn so a splayed stance cannot skew the model off true.
  const turn = Math.PI - Math.atan2(forward.x, forward.z);
  return Math.round(turn / (Math.PI / 2)) * (Math.PI / 2);
}

/**
 * One soldier instance. Materials are cloned per bot because the death fade writes
 * material.opacity and the team tint writes material.emissive — sharing them would fade and
 * recolour every bot at once.
 */
function buildSoldierMesh(_teamColor, gltf) {
  const g = new THREE.Group();
  const model = skeletonClone(gltf.scene);

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
  // No team kit. The armbands this replaced were open cylinders fitted to the arm's bind pose,
  // and in motion they read as ribbons floating off the sleeves. Sides are told apart by the
  // cast (each team draws from its own characters) and by the ally markers over teammates.

  const mixer = new THREE.AnimationMixer(model);
  const clips = {};

  // Resolve the clip set for this character once and cache it on the glTF: the retarget
  // depends only on the skeleton, and buildSoldierMesh runs for every bot that spawns.
  if (!gltf.userData.__clips) {
    const source = {};
    for (const name of BOT_CLIP_NAMES) {
      // The shared set in assets/bots/anim comes first, for every character. soldier.glb
      // carries its own Idle/Walk/Run, but those are posed facing the opposite way to the
      // Mixamo clips — so a soldier blending its own run into a Mixamo strafe swung its hips
      // through a half turn mid-blend and visibly twisted. One clip source means one facing.
      // The soldier's own clips remain the fallback if the manifest is missing.
      const clip = extraClips[name]
        ?? THREE.AnimationClip.findByName(gltf.animations ?? [], name);
      if (clip) source[name] = clip;
    }
    gltf.userData.__clips = retargetClips(source, model);
  }

  for (const [name, clip] of Object.entries(gltf.userData.__clips)) {
    clips[name] = mixer.clipAction(clip);
    clips[name].play();
    clips[name].weight = 0;
  }
  if (clips.Idle) clips.Idle.weight = 1;
  g.userData.mixer = mixer;
  g.userData.clips = clips;

  // Face the model the right way, measured on the pose it will actually be DRAWN in. The bind
  // pose is not good enough: the SWAT character's rest pose faces -Z while every clip poses it
  // facing +Z, because the clips' Hips rotation differs from its rest orientation by a half
  // turn. Measured at rest it needed no correction and was still drawn backwards.
  mixer.update(0);
  model.rotation.y = facingCorrection(model);

  /**
   * Spine chain, for aiming the whole upper body rather than just the gun.
   *
   * The rig is Mixamo (`mixamorig:Hips` down to `mixamorig:Head`, colon intact), so the
   * bones can be found by name. Pitching the gun mesh alone left the soldier staring
   * levelly ahead while its weapon pointed at the floor or the ceiling, which is the single
   * most obviously wrong thing about the bots up close. Splitting the angle down the chain
   * — most of it at the chest, less at the neck — is how a person actually looks down a
   * barrel, and it costs three quaternion writes a frame.
   */
  const bones = {};
  model.traverse((o) => {
    if (!o.isBone) return;
    const short = o.name.replace(MIXAMO_PREFIX, '');
    if (RIG_BONES.includes(short)) bones[short] = o;
  });
  g.userData.bones = bones;
  g.userData.restPitch = new Map(
    ['Spine1', 'Spine2', 'Neck', 'Head'].filter((k) => bones[k]).map((k) => [k, bones[k].rotation.x]),
  );

  // Each clip's real ground speed on THIS character, in world metres per second: the drift
  // stripRootMotion removed, carried through the rig's scale. The group is still unscaled
  // here, so the bot's BOT_MESH_SCALE is applied by hand.
  g.userData.clipSpeed = {};
  if (bones.Hips?.parent) {
    model.updateMatrixWorld(true);
    const scale = bones.Hips.parent.getWorldScale(new THREE.Vector3()).x * BOT_MESH_SCALE;
    for (const [name, d] of Object.entries(clipDrift)) {
      if (clips[name]) g.userData.clipSpeed[name] = (d.drift * scale) / d.duration;
    }
  }
  return g;
}

/** Blocky humanoid, tinted by team so allies and enemies read instantly. */
function buildBotMesh(teamColor, team = TEAM.SOLO) {
  const roster = rosterFor(team);
  if (roster.length) return buildSoldierMesh(teamColor, characterGltf[pick(roster).id]);
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

/**
 * The gun a bot carries: the same model the player holds, without the first-person hands.
 * Fresh materials per gun, because the death fade writes their opacity.
 */
function buildBotGun(id) {
  const g = buildGunModel(id, { materials: gunMaterials() });
  g.userData.pistol = id === 'pistol';
  return g;
}

class Bot {
  constructor(name, team, diff, weaponId = null) {
    this.isPlayer = false;
    this.name = name;
    this.team = team;
    this.diff = diff;
    /** Resolved once per bot rather than per shot — shootAt() runs on every fire tick. */
    this.aim = aimProfile(diff);
    /** Non-null pins the loadout across respawns, so a duel stays a mirror match. */
    this.fixedWeaponId = weaponId;
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

    this.weaponId = weaponId ?? pick(BOT_GUN_IDS);
    this.mag = WEAPON_BY_ID[this.weaponId].mag;
    this.reloading = 0;
    this.fireCd = 0;
    this.burst = 0;
    this.nadeCd = rand(6, 16);
    this.deathTimer = 0;
    this.respawnTimer = 0;
    this.aimOff = new THREE.Vector3();     // persistent aim error, random-walks while firing
    this.aimSettle = 0;                    // seconds spent tracking the current target
    // Where this bot's aim thinks the target is: its height and velocity, each catching up
    // with the real thing over aim.trackLag. See simStep.
    this.trackTarget = null;
    this.trackY = 0;
    this.trackVel = new THREE.Vector3();
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = rand(0.5, 1.5);
    this.yaw = rand(-Math.PI, Math.PI);
    this.stepTimer = 0;
    // Locomotion wish, applied under an acceleration limit in applyLocomotion().
    this.wishVx = 0; this.wishVz = 0;
    this.peekTimer = 0;      // COVER: >0 while leaning out, <=0 while tucked back in
    // Path-following watchdog (see followPath / unstick).
    this.nodeBest = Infinity;
    this.stuckTime = 0;
    this.stuckCount = 0;
    this.sidestepTimer = 0;
    this.sidestepDir = 1;
    // Combat footwork (see combatMove).
    this.sinceFlip = 0;
    this.blockedTime = 0;
    this.probeTimer = 0;
    this.strafeBlocked = false;
    this.rangeBlocked = false;

    const color = TEAM_COLOR[team];
    this.mesh = buildBotMesh(color, team);
    this.mesh.scale.setScalar(BOT_MESH_SCALE);
    this.hb = HB_BOT;
    this.gunMesh = buildBotGun(this.weaponId);
    this.attachGun();
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
    // Body position before the most recent physics step, for render interpolation.
    this.prevBodyPos = new THREE.Vector3().copy(this.body.position);

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

  /**
   * Put the carried weapon in the bot's right hand, not on its chest.
   *
   * The gun used to hang off a fixed offset from the mesh root. That was survivable when
   * bots only had idle/walk/run, whose arms barely move; it is not survivable now they
   * strafe, backpedal and crouch, because the body keeps moving while the gun stays pinned
   * and the two visibly come apart. Parenting to mixamorig:RightHand makes the animation
   * carry the weapon, which is what the clips were authored assuming.
   *
   * The hand bone inherits the model's scale, so the gun is divided back out by it —
   * otherwise a character fitted to BOT_TARGET_HEIGHT hands its bot a gun scaled by the
   * same factor. Characters with no hand bone (the blocky fallback) keep the old anchor.
   */
  attachGun() {
    if (!this.mesh.userData.bones?.RightHand) {
      this.gunMesh.position.copy(this.gunAnchor());
      this.mesh.add(this.gunMesh);
      return;
    }
    // Rigged characters: the gun is posed every frame by poseGun() and the hands are solved
    // onto it, so it is parented to the bot's group, not to a hand. The group is scaled by
    // BOT_MESH_SCALE, which the gun divides back out so it keeps its real size.
    this.gunMesh.matrixAutoUpdate = false;
    this.mesh.add(this.gunMesh);
  }

  updateTransforms() {
    const p = this.body.position;
    this.pos.set(p.x, p.y + BOT_CHEST, p.z);
    this.eye.set(p.x, p.y + BOT_EYE, p.z);
    this.vel.set(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z);
    this.mesh.position.set(p.x, p.y + BOT_MESH_Y, p.z);
    // The mesh always faces the bot's heading. faceDir() used to be the only thing that wrote
    // this, so a bot fresh from a spawn faced wherever its mesh last pointed until it first
    // turned, then snapped round. The death branch of renderStep adds its twist after this.
    this.mesh.rotation.y = this.yaw + Math.PI;
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
    this.nodeBest = Infinity;
    this.stuckTime = 0;
  }

  /**
   * Drive toward the next path node. Returns true once the path is exhausted.
   *
   * A watchdog tracks the closest this bot has come to the node it is heading for. If that
   * stops improving for STUCK_AFTER seconds, something is in the way — a crate the graph did
   * not know about, another bot, a corner — and unstick() takes over. Before this there was no
   * such check at all, and a bot that met an obstacle ran into it until its two-second repath
   * sent it straight back into the same obstacle, forever.
   */
  followPath(speed, dt) {
    if (!this.path || this.pathIdx >= this.path.length) { this.setPlanarVelocity(0, 0); return true; }
    const node = this.path[this.pathIdx];
    const dx = node.x - this.body.position.x;
    const dz = node.z - this.body.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.0) {
      this.pathIdx++;
      this.nodeBest = Infinity;
      this.stuckTime = 0;
      this.stuckCount = 0;
      return this.pathIdx >= this.path.length;
    }
    if (dist < this.nodeBest - 0.15) { this.nodeBest = dist; this.stuckTime = 0; }
    else if ((this.stuckTime += dt) > STUCK_AFTER) { this.unstick(); return false; }

    let vx = (dx / dist) * speed, vz = (dz / dist) * speed;
    if (this.sidestepTimer > 0) {
      // Coming off a corner: mostly sideways, a little forward.
      this.sidestepTimer -= dt;
      const sx = (-dz / dist) * this.sidestepDir, sz = (dx / dist) * this.sidestepDir;
      vx = vx * 0.35 + sx * speed * 0.8;
      vz = vz * 0.35 + sz * speed * 0.8;
    }
    this.setPlanarVelocity(vx, vz);
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

  /**
   * The bot has stopped closing on its node. Plan again from where it actually stands — the
   * path's start is chosen by what this spot can walk to, which is usually all it takes — and
   * step sideways for a moment to come off whatever it is hung on. A bot that gets stuck three
   * times on the same leg abandons the destination for another one.
   */
  unstick() {
    this.stuckTime = 0;
    this.nodeBest = Infinity;
    this.stuckCount++;
    this.sidestepTimer = 0.4;
    this.sidestepDir = Math.random() < 0.5 ? -1 : 1;
    const dest = this.path?.[this.path.length - 1];
    if (dest && this.stuckCount < 3) {
      this.repath(dest);
    } else {
      this.stuckCount = 0;
      this.patrolWp = randInt(0, waypoints.length - 1);
      this.repath(waypoints[this.patrolWp].pos);
    }
  }

  /**
   * Would a step this way run into something or off an edge? One ray ahead at hip height, one
   * down past the end of it to make sure there is still floor there.
   */
  moveBlocked(ux, uz) {
    const p = this.body.position;
    const x = p.x + ux * PROBE_AHEAD, z = p.z + uz * PROBE_AHEAD;
    if (!losClear(p.x, p.y, p.z, x, p.y, z)) return true;
    return losClear(x, p.y, z, x, p.y - 1.4, z);
  }

  /** Bots are moved by writing velocity, never by forces — no sliding, no slope drift.
   *  This records the wish only; applyLocomotion() puts it on the body once per sim step. */
  setPlanarVelocity(vx, vz) {
    this.wishVx = vx;
    this.wishVz = vz;
  }

  /**
   * Apply the movement wish under an acceleration limit, then the separation push.
   *
   * The wish used to be written straight onto the body, which made every start, stop and
   * strafe flip instantaneous. That is the biggest single reason bot movement read as
   * robotic — nothing alive changes direction in one tick. It also made the strafe flip
   * free, when for a player it is the most expensive thing they can do: the moment of
   * near-zero speed in the middle of a flip is exactly when they are easy to hit. Limiting
   * the rate puts that cost back, and it is what gives `moveSpread` and `counterStrafe` in
   * the aim profile something real to trade against.
   *
   * Separation stays here rather than in the path follower so it applies while standing
   * still too: without it every bot chasing one target converges on a point and they end up
   * inside one another. It is added AFTER the accel limit, because being shoved out of a
   * neighbour is a collision response rather than a decision the bot made.
   */
  applyLocomotion(dt) {
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
    // The push is part of what the bot WANTS, so it goes through the same acceleration limit
    // as everything else. It used to be added to the body velocity after the limit, and the
    // next step read that velocity back as its starting point — so the push compounded, about
    // +1 m/s every step at 1.5 m apart, and two bots that bunched up flung each other away at
    // several metres a second. That read as bots teleporting.
    const wx = this.wishVx + sx * SEP_STRENGTH, wz = this.wishVz + sz * SEP_STRENGTH;
    const vx = this.body.velocity.x, vz = this.body.velocity.z;
    let dvx = wx - vx, dvz = wz - vz;
    const dv = Math.hypot(dvx, dvz);
    if (dv > 1e-6) {
      // Slowing down is quicker than speeding up, the way legs actually work.
      const slowing = Math.hypot(wx, wz) < Math.hypot(vx, vz);
      const maxStep = (slowing ? BOT_DECEL : BOT_ACCEL) * (this.diff.speed ?? 1) * dt;
      if (dv > maxStep) { dvx *= maxStep / dv; dvz *= maxStep / dv; }
    }
    this.body.velocity.x = vx + dvx;
    this.body.velocity.z = vz + dvz;
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
   * Where on the target this bot is trying to put the round, in world space.
   *
   * Every tier before the elite one aimed at `target.pos`, which is the chest — so a bot
   * could only ever headshot you by accident. `headBias` is the share of shots aimed at the
   * head instead. It reads the target's live hitbox rather than a constant, so crouching
   * genuinely moves the aim point down: HB_PLAYER.headY is 0.63 standing and
   * HB_PLAYER_CROUCH.headY is 0.42, and `player.hb` is swapped as you crouch. The move reaches
   * the aim over aim.trackLag, through trackY.
   */
  aimPoint(target, out) {
    this.aimPointTrue(target, out);
    if (target === this.trackTarget) out.y += this.trackY - target.pos.y;
    return out;
  }

  aimPointTrue(target, out) {
    out.copy(target.pos);
    if (this.aim.headBias > 0 && Math.random() < this.aim.headBias) {
      // Dead centre of the head sphere, NOT its lower edge.
      //
      // Aiming low looks like the safer choice — residual error then falls back onto the
      // chest rather than over the shoulder. It is not, because of how the zones resolve:
      // the limb volume is a cylinder of radius bodyR * 1.6 whose top reaches headY - 0.10,
      // and nearestCombatantHit() takes the NEAREST volume along the ray. A wide cylinder
      // is entered before the narrow head sphere, so any shot aimed at the head's lower
      // edge scores as a 0.6x limb hit instead of a 2.4x headshot. Measured: aiming low put
      // essentially every connection in the limb zone. Centre clears the cylinder.
      if (target.headPoint) return target.headPoint(out);
      const hb = target.hb ?? HB_BOT;
      out.y += hb.headY;
    }
    return out;
  }

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
    const aimAt = this.aimPoint(target, _v3);
    const dist = muzzle.distanceTo(aimAt);
    const flight = dist / w.speed;

    // Imperfect lead. The old code led the target perfectly and compensated bullet drop
    // exactly, then applied a tight cone around that flawless solution — which is why bots
    // never missed. Both the lead and the drop compensation are now sloppy, and how sloppy
    // depends on the difficulty, so a bot mis-times a moving target the way a person does.
    const skill = this.diff.accuracy;
    const leadErr = lerp(0.45, 0.95, skill) * rand(0.75, 1.2);
    const seenVel = target === this.trackTarget ? this.trackVel : target.vel;
    _v2.copy(aimAt).addScaledVector(seenVel, flight * leadErr);
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
    const A = this.aim;
    const lateral = Math.hypot(target.vel.x, target.vel.z);
    const ownSpeed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    const freshness = clamp(1 - this.aimSettle, 0, 1);           // 1 right after acquiring
    const spread = A.floor
                 + (1 - skill) * A.base
                 + (dist / 100) * (1 - skill) * A.range          // range penalty
                 + lateral * A.tracking * (1 - skill * 0.5)      // tracking penalty
                 + ownSpeed * A.moveSpread                       // shooting on the move
                 + freshness * A.snap * (1 - skill * 0.6);       // snap-shot penalty

    // Random-walk the persistent offset, then clamp it so it cannot drift absurdly wide.
    const drift = spread * 0.55;
    this.aimOff.x = clamp(this.aimOff.x + rand(-drift, drift), -spread, spread);
    this.aimOff.y = clamp(this.aimOff.y + rand(-drift, drift), -spread, spread);
    this.aimOff.z = clamp(this.aimOff.z + rand(-drift, drift), -spread, spread);

    // Per-shot jitter on top, plus a share of the weapon's own mechanical spread. Only a
    // share, because fireWeapon() applies the full cone again — counting it fully here as
    // well charged the bot for its gun twice, which no accuracy value could dig out of.
    const jitter = spread * 0.5 + w.spread * A.weaponFrac;
    _v2.x += this.aimOff.x + rand(-jitter, jitter);
    _v2.y += this.aimOff.y + rand(-jitter, jitter);
    _v2.z += this.aimOff.z + rand(-jitter, jitter);
    _v2.normalize();

    this.mag--;
    this.fireCd = w.cooldown * this.diff.fireMult * (w.auto ? 1 : rand(1.0, 1.5));
    fireWeapon(this, w, muzzle.clone(), _v2, A.weaponSpreadMult);
    if (this.mag <= 0) this.reloading = w.reload;
  }

  /** True while the bot is deliberately planted to take an accurate shot. */
  isCounterStrafing() {
    return this.aim.counterStrafe > 0
        && this.hasLOS
        && this.reactTimer <= 0
        && this.fireCd <= this.aim.counterStrafe;
  }

  /* --------------------------- state machine --------------------------- */

  // Game-logic step — called at fixed physics dt from fixedStep() so all timers are
  // coherent with the physics simulation.
  simStep(dt) {
    // Fall-out guard: teleport any LIVING bot that escapes the floor back to a spawn. A corpse
    // is never moved — see die().
    if (this.alive && this.body.position.y < -20) {
      const sp = pickSpawn(this.team);
      this.body.position.set(sp.x, sp.y + 0.6, sp.z);
      this.body.velocity.set(0, 0, 0);
      this.body.wakeUp();
      this.path = null;
    }

    this.fireCd = Math.max(0, this.fireCd - dt);
    // Aim settles the longer a bot holds the same target in view, and resets the moment it
    // loses them — so peeking a fresh angle is punished less than standing in the open.
    if (this.hasLOS && this.target === this._lastAimTarget) this.aimSettle += dt * this.aim.settle;
    else { this.aimSettle = 0; this.aimOff.set(0, 0, 0); }
    this._lastAimTarget = this.hasLOS ? this.target : null;
    // Aim follows a target that drops or turns a beat late, the way a hand does. Only height
    // and velocity lag: a lagged position would make every steady strafe miss behind.
    const tt = this.target;
    if (!tt) this.trackTarget = null;
    else if (tt !== this.trackTarget) {
      this.trackTarget = tt; this.trackY = tt.pos.y; this.trackVel.copy(tt.vel);
    } else {
      const k = 1 - Math.exp(-dt / this.aim.trackLag);
      this.trackY += (tt.pos.y - this.trackY) * k;
      this.trackVel.lerp(tt.vel, k);
    }
    this.stepTimer = Math.max(0, this.stepTimer - dt);
    this.stateTime += dt;
    this.repathTimer -= dt;
    this.nadeCd -= dt;
    this.peekTimer -= dt;
    this.sinceFlip += dt;
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
        // A new destination only once the old one is reached. This used to pick a fresh random
        // waypoint every two seconds, so a patrolling bot turned round and headed somewhere new
        // before it had got anywhere — which looked exactly like confusion.
        if (!this.path || this.pathIdx >= this.path.length) {
          this.patrolWp = randInt(0, waypoints.length - 1);
          this.repath(waypoints[this.patrolWp].pos);
        }
        this.followPath(this.moveSpeed('patrol'), dt);
        break;
      }

      case ST.ALERT: {
        this.setPlanarVelocity(0, 0);
        // Sweep the area the noise came from. The sweep amplitude scales with (1 - accuracy):
        // a weak bot flails around the remembered angle, while an elite one pre-aims it and
        // barely drifts, so peeking a bot that heard you is a real risk rather than a freebie.
        const sweep = 6 * (1 - this.diff.accuracy * 0.9);
        this.faceDir(
          this.lastKnown.x - this.body.position.x + Math.sin(this.stateTime * 4) * sweep,
          this.lastKnown.z - this.body.position.z + Math.cos(this.stateTime * 4) * sweep, dt, 4);
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
        // Reaching cover used to hand the bot 12 free health and send it straight back out,
        // which is both unearnable by the player and not what taking cover is for. Now the
        // bot actually uses the cover: it holds there, then leans out on a timer to shoot
        // and tucks back in. Damage it takes mid-peek is real damage, so out-trading a
        // peeking bot is how you finish it rather than chasing a self-healing target.
        if (this.stateTime === 0 || !this.path) this.findCover();
        const inCover = this.followPath(this.moveSpeed('cover'), dt);
        if (!inCover) break;

        this.setPlanarVelocity(0, 0);
        if (this.peekTimer <= -PEEK_HIDE) this.peekTimer = PEEK_SHOW;   // lean out
        if (this.peekTimer > 0) {
          // Leaning out: sidestep off the cover line and take the shot if one is there.
          this.faceTarget(dt);
          if (this.target) {
            const dx = this.target.pos.x - this.body.position.x;
            const dz = this.target.pos.z - this.body.position.z;
            const len = Math.hypot(dx, dz) || 1;
            this.setPlanarVelocity((-dz / len) * this.strafeDir * 2.2,
                                   (dx / len) * this.strafeDir * 2.2);
          }
          if (this.hasLOS && this.reactTimer <= 0) this.shootAt(this.target, dt);
        }
        // Healthy again (from a pickup) or out of patience — back into the fight.
        if (this.health / 100 > 0.6 || this.stateTime > 7.0) this.setState(ST.CHASE);
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
    this.applyLocomotion(dt);
  }

  /**
   * Draw the body between its last two physics states instead of at the latest one.
   *
   * Physics runs on a fixed 120 Hz clock and frames do not line up with it, so a frame can
   * land after one step, two or three. Drawn at the raw body position, a bot advanced by an
   * uneven amount every frame and visibly stuttered at any frame rate. `alpha` is how far the
   * accumulator is into the next step; blending by it moves the mesh the same distance every
   * frame. Gameplay (pos, eye, aim, hitboxes) still uses the real physics position.
   */
  placeMesh(alpha) {
    const p = this.body.position, q = this.prevBodyPos;
    if (q.distanceToSquared(p) > 4) return;          // a teleport or respawn: do not smear it
    const x = q.x + (p.x - q.x) * alpha;
    const y = q.y + (p.y - q.y) * alpha;
    const z = q.z + (p.z - q.z) * alpha;
    this.mesh.position.set(x, y + BOT_MESH_Y, z);
    this.blip.position.set(x, 0.6, z);
  }

  // Visual step — called once per rendered frame with the actual frame delta, and how far the
  // physics accumulator is into the next step (see placeMesh).
  renderStep(frameDt, alpha = 1) {
    this.updateTransforms();
    if (this.alive) this.placeMesh(alpha);
    if (!this.alive) {
      /**
       * Death. The old version rotated the whole mesh a rigid -90 degrees over 0.3 s, which
       * read as a plank tipping over — the legs stayed straight and the body pivoted about
       * a point in mid-air. This eases the fall instead (fast at first, settling at the
       * end, the way a body drops), adds a yaw twist so two deaths never look identical,
       * and folds the spine forward through the same bone offsets the aim uses, so the
       * upper body crumples rather than staying rigid.
       */
      const deathAction = this.mesh.userData.clips?.Death;
      if (deathAction) {
        // An authored death clip is playing (started in die()). It already puts the body on
        // the floor, so the mesh keeps its upright transform and only the mixer runs — the
        // procedural tip-over below would fight it and lay the corpse on its side.
        this.mesh.rotation.x = 0;
        this.mesh.rotation.y = this.yaw + Math.PI + (this.legYaw ?? 0);
        this.mesh.position.y = this.body.position.y + BOT_MESH_Y;
        this.mesh.userData.mixer.update(frameDt);
      } else {
        const t = Math.min(1, this.deathTimer / 0.55);
        const fall = 1 - (1 - t) * (1 - t);            // ease-out: quick, then settles
        this.mesh.rotation.x = -Math.PI / 2 * fall;
        this.mesh.rotation.y = this.yaw + Math.PI + (this.deathTwist ?? 0) * fall;
        this.mesh.position.y = this.body.position.y + BOT_MESH_Y - 0.45 * fall;
        const bones = this.mesh.userData.bones;
        if (bones) {
          const slump = fall * 0.5;
          applyBonePitch(this.mesh, bones, 'Spine1', slump);
          applyBonePitch(this.mesh, bones, 'Spine2', slump * 0.8);
          applyBonePitch(this.mesh, bones, 'Neck', slump * 0.9);
          applyBonePitch(this.mesh, bones, 'Head', slump * 0.7);
        }
      }
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

    // Counter-strafe: plant just before the shot so `moveSpread` is not charged for it.
    // This is the whole reason a tier pays for moveSpread — it buys a visible, punishable
    // window where the bot is standing still, which is the opening the player is meant to
    // take. Without the accel limit in applyLocomotion() this would be free and invisible.
    if (this.isCounterStrafing()) { this.setPlanarVelocity(0, 0); return; }

    const speed = this.moveSpeed(dist < band.min ? 'retreat' : 'combat');

    // Forward axis toward the target, and the perpendicular used for strafing.
    const dx = this.target.pos.x - this.body.position.x;
    const dz = this.target.pos.z - this.body.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    const rx = -fz, rz = fx;

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      if (dir !== this.strafeDir) this.sinceFlip = 0;
      this.strafeDir = dir;
      this.strafeTimer = rand(0.7, 1.8);
    }

    // Look before stepping, so a bot turns back at a wall or a drop instead of finding it.
    const rangeSign = dist < band.min ? -1 : dist > band.max ? 1 : 0;
    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = 0.12;
      this.strafeBlocked = this.moveBlocked(rx * this.strafeDir, rz * this.strafeDir);
      this.rangeBlocked = rangeSign !== 0 && this.moveBlocked(fx * rangeSign, fz * rangeSign);
    }

    /**
     * Blocked, measured properly: asked for real speed and got little of it, for longer than
     * a deliberate reversal takes. The old test was "slower than 0.6 m/s", and every reversal
     * passes through 0.6 m/s on its way through zero — so each flip triggered another flip, and
     * a bot in a firefight locked into reversing every physics step, vibrating on the spot at
     * 0.2-0.4 m/s until the fight moved on. Measured: 22 reversals a second.
     */
    const asked = Math.hypot(this.wishVx, this.wishVz);
    const actual = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    if (asked > 1.5 && actual < asked * 0.35 && this.sinceFlip > 0.45) this.blockedTime += dt;
    else this.blockedTime = 0;

    if ((this.strafeBlocked || this.blockedTime > 0.15) && this.sinceFlip > 0.45) {
      this.strafeDir *= -1;
      this.strafeTimer = rand(0.6, 1.3);
      this.sinceFlip = 0;
      this.blockedTime = 0;
      this.probeTimer = 0;                 // look the new way on the next step
    }

    let vx = 0, vz = 0;
    if (rangeSign < 0 && !this.rangeBlocked) {        // too close — give ground while still firing
      vx -= fx * speed; vz -= fz * speed;
    } else if (rangeSign > 0 && !this.rangeBlocked) {  // too far — close in
      vx += fx * speed * 0.9; vz += fz * speed * 0.9;
    }
    // Always some lateral movement so a bot is never a stationary target — unless both ways
    // are walled off, in which case it holds rather than grinding into the geometry.
    if (!this.strafeBlocked) {
      vx += rx * this.strafeDir * speed * 0.75;
      vz += rz * this.strafeDir * speed * 0.75;
    }
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
    const vx = this.body.velocity.x, vz = this.body.velocity.z;
    const speed = Math.hypot(vx, vz);
    const mixer = this.mesh.userData.mixer;
    if (!mixer) { this.animateBlocky(speed, dt); return; }

    const clips = this.mesh.userData.clips;
    const bones = this.mesh.userData.bones;
    const clipSpeed = this.mesh.userData.clipSpeed;

    /**
     * Lower-body heading. A fast sideways move is drawn as the legs turning toward the way the
     * bot is going while the torso twists back to face its target — how people actually move
     * fast sideways with a rifle up — rather than a walking side-step clip played at 3-4x.
     * Backpedalling turns the legs a little too, then uses the walk-back clip.
     */
    const travel = Math.atan2(vx, vz);
    const rel = wrapAngle(travel - this.yaw);
    const moving01 = clamp((speed - 1.2) / 1.3, 0, 1);
    let legWant = 0;
    if (speed > 0.6) {
      legWant = Math.abs(rel) <= LEG_FWD_MAX
        ? clamp(rel, -LEG_TURN_MAX, LEG_TURN_MAX)
        : clamp(wrapAngle(rel - Math.PI), -LEG_BACK_MAX, LEG_BACK_MAX);
      legWant *= moving01;
    }
    this.legYaw = (this.legYaw ?? 0) + wrapAngle(legWant - (this.legYaw ?? 0)) * Math.min(1, 9 * dt);
    this.mesh.rotation.y = this.yaw + Math.PI + this.legYaw;

    /**
     * Directional blend over the movement direction in the LEGS' frame. Forward is
     * (sin h, cos h) for heading h, and the character's right is (-cos h, sin h) — the same
     * perpendicular combatMove() uses, so a positive lateral component is the same direction
     * it asked to move in.
     */
    const legHeading = this.yaw + this.legYaw;
    const fx = Math.sin(legHeading), fz = Math.cos(legHeading);
    const moving = clamp((speed - 0.25) / 1.2, 0, 1);
    const fwd = speed > 0.05 ? (vx * fx + vz * fz) / speed : 1;
    const rgt = speed > 0.05 ? (vx * -fz + vz * fx) / speed : 0;
    const parts = {
      fwd: Math.max(0, fwd), back: Math.max(0, -fwd),
      right: Math.max(0, rgt), left: Math.max(0, -rgt),
    };
    const total = parts.fwd + parts.back + parts.right + parts.left || 1;
    const speedOf = (name) => clipSpeed[name] ?? CLIP_SPEED[name] * CLIP_SCALE;
    // Walk-to-run crossfade, placed between the two clips' measured speeds.
    const walkV = speedOf('Walk'), runV = speedOf('Run');
    const runBlend = clamp((speed - walkV * 1.15) / Math.max(0.1, runV * 0.9 - walkV * 1.15), 0, 1);

    const want = { Idle: 0, Walk: 0, Run: 0, WalkBack: 0, StrafeLeft: 0, StrafeRight: 0, Crouch: 0 };
    const put = (name, weight) => {
      if (weight <= 0) return;
      if (clips[name]) want[name] += weight;
      else { want.Run += weight * runBlend; want.Walk += weight * (1 - runBlend); }
    };
    const share = (x) => (x / total) * moving;
    want.Run += share(parts.fwd) * runBlend;
    want.Walk += share(parts.fwd) * (1 - runBlend);
    put('WalkBack', share(parts.back));
    put('StrafeRight', share(parts.right));
    put('StrafeLeft', share(parts.left));

    const hiding = this.state === ST.COVER && this.peekTimer <= 0 && speed < 0.8;
    if (hiding && clips.Crouch) {
      for (const key of Object.keys(want)) want[key] = 0;
      want.Crouch = 1;
    } else {
      let used = 0;
      for (const key of Object.keys(want)) used += want[key];
      want.Idle = Math.max(0, 1 - used);
    }
    const k = Math.min(1, 8 * dt);
    for (const [name, target] of Object.entries(want)) {
      const action = clips[name];
      if (action) action.weight = lerp(action.weight, target, k);
    }

    // Playback rate: each clip paced by the part of the travel it accounts for, against its
    // own measured ground speed on this character, so the planted foot stays planted.
    const hasStrafeClips = Boolean(clips.StrafeLeft || clips.StrafeRight);
    const fwdPace = hasStrafeClips ? speed * Math.abs(fwd) : speed;
    const latPace = speed * Math.abs(rgt);
    const paceOf = (name, component) => clamp(component / speedOf(name), 0.5, 2.2);
    for (const [name, comp] of [['Walk', fwdPace], ['Run', fwdPace], ['WalkBack', fwdPace],
      ['StrafeLeft', latPace], ['StrafeRight', latPace]]) {
      if (clips[name]) clips[name].timeScale = paceOf(name, comp);
    }
    mixer.update(dt);

    // Aim: raised whenever there is someone to point at, lowered to a ready carry otherwise.
    const engaging = this.target && this.hasLOS && (this.state === ST.SHOOT || this.state === ST.NADE
      || this.state === ST.CHASE || (this.state === ST.COVER && this.peekTimer > 0));
    let pitch = 0;
    if (engaging) {
      const dy = this.target.pos.y - this.eye.y;
      const dh = Math.hypot(this.target.pos.x - this.body.position.x, this.target.pos.z - this.body.position.z);
      pitch = clamp(Math.atan2(dy, dh), -1.1, 1.1);
    }
    this.aimPitch = lerp(this.aimPitch ?? 0, pitch, Math.min(1, 9 * dt));
    this.aimW = lerp(this.aimW ?? 0, engaging ? 1 : 0, Math.min(1, 7 * dt));

    // Torso: undo the legs' turn up the spine, then pitch the chest with the aim. Both are
    // applied after mixer.update, which rewrites every bound bone each frame.
    const twist = -this.legYaw;
    twistBone(bones.Spine, twist * 0.3);
    twistBone(bones.Spine1, twist * 0.35);
    twistBone(bones.Spine2, twist * 0.35);
    addBonePitch(bones, 'Spine1', this.aimPitch * AIM_PITCH_SIGN * 0.30);
    addBonePitch(bones, 'Spine2', this.aimPitch * AIM_PITCH_SIGN * 0.30);
    addBonePitch(bones, 'Neck', this.aimPitch * AIM_PITCH_SIGN * 0.22);
    addBonePitch(bones, 'Head', this.aimPitch * AIM_PITCH_SIGN * 0.18);

    this.poseGun();
    this.gripGun();
    this.updateHitboxes();
  }

  /**
   * Take the hit capsules off the posed skeleton, relative to where the mesh is drawn, so
   * hitShapes() can put them wherever the physics body is when a round arrives.
   */
  updateHitboxes() {
    const bones = this.mesh.userData.bones;
    if (!bones?.Head) return;
    this.mesh.updateMatrixWorld(true);
    const n = HIT_CAPSULES.length + 1;
    if (!this.hitRel) {
      this.hitRel = new Float32Array(n * 8);
      this.hitWorld = new Float32Array(n * 8);
      this.hitCentre = new THREE.Vector3();
      this.hitStep = -1;
    }
    const base = this.mesh.position;
    const rel = this.hitRel;
    const at = (name, out) => out.setFromMatrixPosition(bones[name].matrixWorld).sub(base);
    let k = 0;
    // Head: the midpoint of the Head bone and the top of the skull.
    at('Head', _hb1);
    if (bones.HeadTop_End) _hb1.lerp(at('HeadTop_End', _hb2), 0.5);
    else _hb1.y += HEAD_R * 0.8;
    rel.set([_hb1.x, _hb1.y, _hb1.z, _hb1.x, _hb1.y, _hb1.z, HEAD_R, 0], k); k += 8;
    for (const [from, to, r, zone] of HIT_CAPSULES) {
      if (!bones[from] || (to && !bones[to])) { rel.fill(0, k, k + 8); k += 8; continue; }
      at(from, _hb1);
      if (to) at(to, _hb2); else _hb2.copy(_hb1);
      rel.set([_hb1.x, _hb1.y, _hb1.z, _hb2.x, _hb2.y, _hb2.z, r, zone], k);
      k += 8;
    }
    this.hitStep = -1;              // world copy is stale now
  }

  /**
   * The hit capsules in world space at the body's CURRENT physics position, or null for the
   * blocky fallback (which uses the analytic HB_BOT). Called by the bullet sweep every step, so
   * the world copy is rebuilt at most once per physics step.
   */
  hitShapes() {
    if (!this.hitRel) return null;
    if (this.hitStep !== world.stepnumber) {
      const p = this.body.position;
      const ox = p.x, oy = p.y + BOT_MESH_Y, oz = p.z;
      const src = this.hitRel, dst = this.hitWorld;
      for (let k = 0; k < src.length; k += 8) {
        dst[k] = src[k] + ox; dst[k + 1] = src[k + 1] + oy; dst[k + 2] = src[k + 2] + oz;
        dst[k + 3] = src[k + 3] + ox; dst[k + 4] = src[k + 4] + oy; dst[k + 5] = src[k + 5] + oz;
        dst[k + 6] = src[k + 6]; dst[k + 7] = src[k + 7];
      }
      this.hitCentre.set(ox, oy + 0.3, oz);
      this.hitStep = world.stepnumber;
    }
    return { data: this.hitWorld, count: this.hitWorld.length / 8, centre: this.hitCentre, radius: 1.6 };
  }

  /** Centre of the head in world space, for anyone aiming at it. */
  headPoint(out) {
    if (!this.hitRel) return out.set(this.pos.x, this.pos.y + HB_BOT.headY, this.pos.z);
    const p = this.body.position;
    return out.set(this.hitRel[0] + p.x, this.hitRel[1] + p.y + BOT_MESH_Y, this.hitRel[2] + p.z);
  }

  /** The procedural walk for the blocky fallback mesh, which has no skeleton. */
  animateBlocky(speed) {
    const t = performance.now() * 0.001;
    const swing = Math.sin(t * (4 + speed * 1.3)) * Math.min(0.6, speed * 0.13);
    this.mesh.userData.legs[0].rotation.x = swing;
    this.mesh.userData.legs[1].rotation.x = -swing;
    this.mesh.userData.arms[0].rotation.x = -swing * 0.5;
    this.gunMesh.rotation.x = this.aimPitch ?? 0;
  }

  /**
   * Where the gun is this frame, in world space, written into the gun's local matrix.
   *
   * Two poses, blended by aimW. Shouldered: the sight a hand's breadth in front of the eye and
   * the barrel on the target, so the gun a bot shoots you with is pointing at you. Ready: held
   * across the chest, muzzle forward and down. Both hang off the posed skeleton — the head and
   * the chest — so the walk and run carry the gun with the body.
   */
  poseGun() {
    const bones = this.mesh.userData.bones;
    const gun = this.gunMesh;
    const ud = gun.userData;
    this.mesh.updateMatrixWorld(true);
    const head = _g1.setFromMatrixPosition(bones.Head.matrixWorld);
    const chest = _g2.setFromMatrixPosition(bones.Spine2.matrixWorld);
    const facing = this.yaw;
    const fwd = _g3.set(Math.sin(facing), 0, Math.cos(facing));
    const right = _g4.set(-Math.cos(facing), 0, Math.sin(facing));

    // Shouldered: aim direction from the eye to the target (or level ahead, pitched).
    const aimDir = _g5;
    if (this.target && this.aimW > 0.01) {
      aimDir.copy(this.target.pos).sub(head);
      if (aimDir.lengthSq() < 1e-6) aimDir.copy(fwd);
      aimDir.normalize();
    } else {
      aimDir.copy(fwd).multiplyScalar(Math.cos(this.aimPitch ?? 0)).setY(Math.sin(this.aimPitch ?? 0));
    }
    const sightAt = _g6.copy(head).addScaledVector(fwd, ud.pistol ? 0.40 : 0.14)
      .addScaledVector(right, ud.pistol ? 0.02 : 0.07).addScaledVector(UP, -0.09);
    gunBasis(aimDir, _qAim);
    const aimPos = _g7.copy(ud.sight).applyQuaternion(_qAim).negate().add(sightAt);

    // Ready: muzzle forward and down across the body, grip by the right hip-chest.
    const lowDir = _g8.copy(fwd).multiplyScalar(Math.cos(READY_DIP)).setY(-Math.sin(READY_DIP))
      .addScaledVector(right, ud.pistol ? 0 : -0.18).normalize();
    gunBasis(lowDir, _qLow);
    const gripAt = _g9.copy(chest).addScaledVector(fwd, ud.pistol ? 0.30 : 0.22)
      .addScaledVector(right, ud.pistol ? 0.02 : 0.08).addScaledVector(UP, ud.pistol ? -0.12 : -0.18);
    const lowPos = _g10.copy(ud.grip).applyQuaternion(_qLow).negate().add(gripAt);

    const w = this.aimW ?? 0;
    _qGun.slerpQuaternions(_qLow, _qAim, w);
    _gPos.lerpVectors(lowPos, aimPos, w);
    // World transform -> the group's local frame (the group carries BOT_MESH_SCALE).
    _mGun.compose(_gPos, _qGun, _gScale.setScalar(1));
    _mInv.copy(this.mesh.matrixWorld).invert();
    gun.matrix.multiplyMatrices(_mInv, _mGun);
    gun.matrixWorldNeedsUpdate = true;
    gun.updateMatrixWorld(true);
  }

  /** Solve both arms onto the gun: right hand on the grip, left hand on the support point. */
  gripGun() {
    const bones = this.mesh.userData.bones;
    const gun = this.gunMesh;
    const gm = gun.matrixWorld;
    const grip = _h1.copy(gun.userData.grip).applyMatrix4(gm);
    const support = _h2.copy(gun.userData.support).applyMatrix4(gm);
    const gunFwd = _h3.set(0, 0, -1).transformDirection(gm);
    const gunUp = _h4.set(0, 1, 0).transformDirection(gm);
    const gunRight = _h5.crossVectors(gunFwd, gunUp).normalize();
    // Elbows: the right one out and down, the left one down and in under the gun.
    const rPole = _h6.setFromMatrixPosition(bones.RightArm.matrixWorld)
      .addScaledVector(UP, -1).addScaledVector(gunRight, 0.7).addScaledVector(gunFwd, -0.3);
    solveTwoBone(bones.RightArm, bones.RightForeArm, bones.RightHand, grip, rPole);
    const lPole = _h7.setFromMatrixPosition(bones.LeftArm.matrixWorld)
      .addScaledVector(UP, -1).addScaledVector(gunRight, -0.25);
    solveTwoBone(bones.LeftArm, bones.LeftForeArm, bones.LeftHand, support, lPole);
    // Hands: the right wraps the grip, fingers round its left side; the left cups the
    // handguard from below, fingers up its right side.
    orientHand(bones.RightHand, bones.RightHandMiddle1, bones.RightHandThumb1,
      _h8.copy(gunRight).negate().addScaledVector(gunUp, -0.35).normalize(),
      _h9.copy(gunFwd).addScaledVector(gunUp, 0.4).normalize());
    orientHand(bones.LeftHand, bones.LeftHandMiddle1, bones.LeftHandThumb1,
      _h8.copy(gunRight).addScaledVector(gunUp, 0.6).normalize(),
      _h9.copy(gunFwd));
  }

  /* ------------------------------ death ------------------------------ */

  die() {
    this.alive = false;
    this.state = ST.DEAD;
    this.deathTimer = 0;
    // Which way the body twists as it goes down, so two deaths never look identical.
    this.deathTwist = rand(-0.9, 0.9);

    // Authored death clip, if one was loaded. Played once and clamped on the final frame so
    // the corpse holds its landed pose for the fade rather than snapping back to idle.
    const clips = this.mesh.userData.clips;
    if (clips?.Death) {
      for (const [name, action] of Object.entries(clips)) {
        if (name !== 'Death') action.weight = 0;
      }
      clips.Death.reset();
      clips.Death.setLoop(THREE.LoopOnce, 1);
      clips.Death.clampWhenFinished = true;
      clips.Death.timeScale = 1;
      clips.Death.weight = 1;
      clips.Death.play();
    }
    /**
     * A corpse does not move.
     *
     * It used to keep a live DYNAMIC body with collisionResponse switched off — so gravity still
     * pulled on it and nothing held it up. Every corpse fell through the floor, under it inside
     * half a second, and at y = -20 the fall-out guard teleported it to a spawn point, where it
     * hung in the air falling again while it faded. A frag landing nearby launched it through
     * the walls on top of that. That is the "they still move and float after they die" report.
     *
     * Kinematic bodies ignore gravity and move only by their own velocity, which is zeroed;
     * collisionResponse stays off so nobody trips over the dead. It is put on the floor first,
     * so a bot killed while dropping off a ledge lies on the ground rather than in mid-air.
     */
    this.setPlanarVelocity(0, 0);
    this.body.velocity.set(0, 0, 0);
    this.body.collisionResponse = false;
    this.body.type = CANNON.Body.KINEMATIC;
    this.settleOnFloor();
    this.plate.root.style.display = 'none';
    this.blip.visible = false;
    // The dropped pickup is the gun now; the hands no longer hold one.
    if (this.mesh.userData.bones?.RightHand) this.gunMesh.visible = false;
    this.dropWeapon();
  }

  /** Drop the (kinematic) body straight down onto whatever is below it. */
  settleOnFloor() {
    const p = this.body.position;
    const from = new CANNON.Vec3(p.x, p.y, p.z);
    const to = new CANNON.Vec3(p.x, p.y - 12, p.z);
    const hit = new CANNON.RaycastResult();
    world.raycastClosest(from, to, RAY_OPTS, hit);
    if (hit.hasHit) p.y = hit.hitPointWorld.y + BOT_STAND_Y;
  }

  dropWeapon() { spawnPickup(this.body.position, this.weaponId); }

  respawn(at) {
    this.alive = true;
    this.health = 100;
    this.state = ST.SPAWN;
    this.stateTime = 0;
    this.target = null; this.hasLOS = false; this.path = null;
    this.wishVx = 0; this.wishVz = 0;
    this.peekTimer = 0;
    this.nodeBest = Infinity; this.stuckTime = 0; this.stuckCount = 0; this.sidestepTimer = 0;
    this.blockedTime = 0; this.sinceFlip = 0;
    this.weaponId = this.fixedWeaponId ?? pick(BOT_GUN_IDS);
    this.mag = WEAPON_BY_ID[this.weaponId].mag;
    this.reloading = 0;
    this.nadeCd = rand(6, 16);
    this.body.type = CANNON.Body.DYNAMIC;   // undo die(): back under gravity and the solver
    this.body.collisionResponse = true;
    this.body.velocity.set(0, 0, 0);
    this.body.position.set(at.x, at.y + 0.5, at.z);
    this.body.wakeUp();

    this.gunMesh.removeFromParent();
    this.gunMesh = buildBotGun(this.weaponId);
    this.attachGun();
    this.mesh.rotation.x = 0;
    this.aimPitch = 0;
    this.aimW = 0;
    this.legYaw = 0;
    const respawnClips = this.mesh.userData.clips;
    if (respawnClips?.Death) {
      respawnClips.Death.stop();
      respawnClips.Death.weight = 0;
      if (respawnClips.Idle) { respawnClips.Idle.weight = 1; respawnClips.Idle.play(); }
    }
    const bones = this.mesh.userData.bones;
    if (bones) for (const name of this.mesh.userData.restPitch.keys()) applyBonePitch(this.mesh, bones, name, 0);
    this.mesh.visible = true;
    this.mesh.traverse((o) => { if (o.isMesh) { o.material.opacity = 1; o.material.transparent = false; } });
    this.blip.visible = true;
    this.plate.root.style.display = '';
    this.updateTransforms();
  }
}

/**
 * Add `extra` radians of pitch to a bone, on top of whatever the animation clip posed it to.
 *
 * The mixer writes absolute bone rotations every frame, so simply assigning rotation.x would
 * be overwritten by the next clip update and the aim would flicker at the clip's frame rate.
 * The rest pose captured at build time is the reference the offset is measured from.
 */
/**
 * Pitch a bone on top of the pose the animation gave it this frame.
 *
 * Only valid straight after mixer.update(), which rewrites every bound bone from scratch each
 * frame — that is what stops the offset accumulating. applyBonePitch below instead ASSIGNS
 * `rest + extra`, which is right when no clip is driving the bone, but used for aiming it threw
 * the clip's own rotation about this axis away every frame: the forward lean of the run and the
 * hunch of the crouch never reached the chest, neck or head.
 */
/** Wrap an angle into [-PI, PI]. */
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Twist a spine bone about its own long axis (+Y for a Mixamo bone), after the clip posed it. */
function twistBone(bone, angle) {
  if (!bone || !angle) return;
  bone.quaternion.multiply(_tq.setFromAxisAngle(Y_AXIS, angle));
}

/** Rotation taking the gun frame (-Z forward, +Y up) onto `dir` with its top kept upright. */
function gunBasis(dir, out) {
  const z = _b1.copy(dir).negate().normalize();
  const x = _b2.crossVectors(UP, z);
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize();
  const y = _b3.crossVectors(z, x);
  _bm.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_bm);
}

/** Turn `bone` (in world space) so that the direction to `child` points at `target`. */
function aimBone(bone, childPos, target) {
  const origin = _a1.setFromMatrixPosition(bone.matrixWorld);
  const from = _a2.subVectors(childPos, origin).normalize();
  const to = _a3.subVectors(target, origin).normalize();
  const delta = _aq1.setFromUnitVectors(from, to);
  bone.getWorldQuaternion(_aq2);
  _aq2.premultiply(delta);
  bone.parent.getWorldQuaternion(_aq3).invert();
  bone.quaternion.copy(_aq3.multiply(_aq2));
  bone.updateMatrixWorld(true);
}

/**
 * Analytic two-bone IK: bend upper -> fore -> hand so the hand reaches `target`, with the elbow
 * swung toward `pole`. Out-of-reach targets are met with a straight arm pointing at them.
 */
function solveTwoBone(upper, fore, hand, target, pole) {
  if (!upper || !fore || !hand) return;
  const a = _k1.setFromMatrixPosition(upper.matrixWorld);
  const b = _k2.setFromMatrixPosition(fore.matrixWorld);
  const c = _k3.setFromMatrixPosition(hand.matrixWorld);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const toT = _k4.subVectors(target, a);
  const d = clamp(toT.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  const u = toT.normalize();
  const side = _k5.subVectors(pole, a);
  side.addScaledVector(u, -side.dot(u));
  if (side.lengthSq() < 1e-8) side.set(0, -1, 0);
  side.normalize();
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const elbow = _k6.copy(a).addScaledVector(u, l1 * cosA).addScaledVector(side, l1 * Math.sqrt(1 - cosA * cosA));
  aimBone(upper, b, elbow);
  const reach = _k7.copy(a).addScaledVector(u, d);
  aimBone(fore, _k3.setFromMatrixPosition(hand.matrixWorld), reach);
}

/**
 * Point a hand's fingers along `fingers` with its thumb toward `thumb`, both in world space,
 * using the hand's own finger and thumb bones to know which local axes those are.
 */
function orientHand(hand, middle, thumbBone, fingers, thumb) {
  if (!hand || !middle || !thumbBone) return;
  const lf = _o1.copy(middle.position).normalize();
  const lt = _o2.copy(thumbBone.position);
  lt.addScaledVector(lf, -lt.dot(lf)).normalize();
  const ln = _o3.crossVectors(lf, lt);
  _om1.makeBasis(lf, lt, ln);                  // local frame
  const wf = _o4.copy(fingers).normalize();
  const wt = _o5.copy(thumb).addScaledVector(wf, -thumb.dot(wf)).normalize();
  const wn = _o6.crossVectors(wf, wt);
  _om2.makeBasis(wf, wt, wn);                  // wanted world frame
  _om2.multiply(_om1.transpose());             // world rotation = wanted * local^-1
  _oq1.setFromRotationMatrix(_om2);
  hand.parent.getWorldQuaternion(_oq2).invert();
  hand.quaternion.copy(_oq2.multiply(_oq1));
  hand.updateMatrixWorld(true);
}

function addBonePitch(bones, name, extra) {
  const bone = bones[name];
  if (bone) bone.rotation.x += extra;
}

function applyBonePitch(meshGroup, bones, name, extra) {
  const bone = bones[name];
  if (!bone) return;
  const rest = meshGroup.userData.restPitch?.get(name) ?? 0;
  bone.rotation.x = rest + extra;
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

return {
  bots,
  Bot,
  loadSoldier,
  characters: CHARACTERS,
  loadedCharacters: () => Object.entries(characterGltf)
    .filter(([, v]) => Boolean(v)).map(([k]) => k),
  /** A rigged mesh of one roster character, for tests that must cover every character. */
  buildCharacterMesh: (id) => (characterGltf[id] ? buildSoldierMesh(0xffffff, characterGltf[id]) : null),
  registerBotClips,
  botClipNames: BOT_CLIP_NAMES,
  buildBotGun,
  alertBots,
};
}
