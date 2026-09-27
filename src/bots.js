import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

import { TEAM, TEAM_COLOR } from './config.js';
import { G_BODY, MAT_BODY, world } from './physics.js';
import { HB_BOT } from './projectiles.js';
import { matte } from './rendering.js';
import { clamp, lerp, pick, rand, randInt } from './utils.js';
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
  easy:   { label: 'EASY',   accuracy: 0.40, reaction: 0.80, bots: 3, aggression: 0.55, fireMult: 1.35, speed: 0.85 },
  medium: { label: 'MEDIUM', accuracy: 0.65, reaction: 0.50, bots: 4, aggression: 0.75, fireMult: 1.10, speed: 1.0 },
  hard:   { label: 'HARD',   accuracy: 0.85, reaction: 0.20, bots: 5, aggression: 0.95, fireMult: 1.0, speed: 1.18 },

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

function cylPart(r1, r2, h, x, y, z, material, axis = 'z') {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, 12), material);
  mesh.position.set(x, y, z);
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
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
    soldierGltf = await modelLoader.loadAsync('./assets/bots/soldier.glb');
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
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = rand(0.5, 1.5);
    this.yaw = rand(-Math.PI, Math.PI);
    this.stepTimer = 0;
    // Locomotion wish, applied under an acceleration limit in applyLocomotion().
    this.wishVx = 0; this.wishVz = 0;
    this.peekTimer = 0;      // COVER: >0 while leaning out, <=0 while tucked back in

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
    const vx = this.body.velocity.x, vz = this.body.velocity.z;
    let dvx = this.wishVx - vx, dvz = this.wishVz - vz;
    const dv = Math.hypot(dvx, dvz);
    if (dv > 1e-6) {
      // Slowing down is quicker than speeding up, the way legs actually work.
      const slowing = Math.hypot(this.wishVx, this.wishVz) < Math.hypot(vx, vz);
      const maxStep = (slowing ? BOT_DECEL : BOT_ACCEL) * (this.diff.speed ?? 1) * dt;
      if (dv > maxStep) { dvx *= maxStep / dv; dvz *= maxStep / dv; }
    }

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
    this.body.velocity.x = vx + dvx + sx * SEP_STRENGTH;
    this.body.velocity.z = vz + dvz + sz * SEP_STRENGTH;
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
   * genuinely moves the aim point down: HB_PLAYER.headY is 0.78 standing and
   * HB_PLAYER_CROUCH.headY is 0.45, and `player.hb` is swapped as you crouch.
   */
  aimPoint(target, out) {
    out.copy(target.pos);
    if (this.aim.headBias > 0 && Math.random() < this.aim.headBias) {
      // Aim at the lower half of the head sphere: dead-centre on a 0.27 m ball means half
      // of the residual error misses high over the shoulder, where there is no hitbox at
      // all, while the same error low still catches the chest.
      const hb = target.hb ?? HB_BOT;
      out.y += hb.headY - hb.headR * 0.35;
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
    _v2.copy(aimAt).addScaledVector(target.vel, flight * leadErr);
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
    if (this.hasLOS && this.target === this._lastAimTarget) this.aimSettle += dt * this.aim.settle;
    else { this.aimSettle = 0; this.aimOff.set(0, 0, 0); }
    this._lastAimTarget = this.hasLOS ? this.target : null;
    this.stepTimer = Math.max(0, this.stepTimer - dt);
    this.stateTime += dt;
    this.repathTimer -= dt;
    this.nadeCd -= dt;
    this.peekTimer -= dt;
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
    // setPlanarVelocity only records a wish, and simStep() returns before applyLocomotion()
    // once alive is false — so a corpse needs its velocity cleared here or it keeps sliding.
    this.setPlanarVelocity(0, 0);
    this.body.velocity.x = 0; this.body.velocity.z = 0;
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
    this.wishVx = 0; this.wishVz = 0;
    this.peekTimer = 0;
    this.weaponId = this.fixedWeaponId ?? pick(BOT_GUN_IDS);
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

return {
  bots,
  Bot,
  loadSoldier,
  buildBotGun,
  alertBots,
};
}
