import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import {
  CONFIG,
  TEAM,
} from './config.js';
import {
  G_BODY,
  MAT_BODY,
  RAY_OPTS,
  world,
} from './physics.js';
import { HB_PLAYER, HB_PLAYER_CROUCH } from './projectiles.js';
import { settings } from './settings.js';
import { clamp, lerp, rand } from './utils.js';
import { WEAPON_BY_ID, WEAPONS, playerSpread, recoilStep } from './weapons.js';
import { DEFAULT_LOADOUT } from './loadout.js';

export function createPlayerState() {
  return {
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
  // Body position before the most recent physics step, for render interpolation.
  prevBodyPos: new THREE.Vector3(),
  yaw: 0, pitch: 0,
  recoilPitch: 0, recoilYaw: 0,
  grounded: false, crouching: false, sprinting: false,
  slideTime: 0,                      // seconds of slide left (sprint, then crouch)
  current: 'pistol',
  loadout: [...DEFAULT_LOADOUT],     // guns on keys 1-4, in order (see loadout.js)
  ammo: {},
  cooldown: 0, reloading: 0, reloadTotal: 0,
  // Overshoot left over when the fire cooldown expired mid-frame, spent on the next shot so
  // the rate of fire does not quantise to the render rate. See the weapon timers in frame().
  fireCarry: 0,
  // Spray state: accumulated bloom in radians, how far into the recoil pattern we are, and
  // how long since the last round left the barrel. See playerSpread / recoilStep.
  bloom: 0, sprayIndex: 0, sinceShot: 99,
  fragCount: 3, smokeCount: 1,
  // cooking is the grenade in hand ('frag' or 'smoke') while the throw charges, and chargeTime
  // how long it has been held: the longer, the farther (see throwAim). The fuse only starts on
  // release. cookSource is the input holding it ('key', 'mouse' or 'pad'): only that input's
  // release throws it, or an idle controller would throw every keyboard throw on the next frame.
  cooking: null, chargeTime: 0, cookSource: null,
  respawnTimer: 0,
  invulnTimer: 0,                    // spawn protection — see SPAWN_INVULN
  stepTimer: 0,
  sway: new THREE.Vector2(),
  // Seconds since the last hard landing and how hard it was, for the camera dip.
  landTime: 99, landKick: 0,
  airVy: 0,
};
}

/** Player simulation, damage, weapons, input, pointer lock, and gamepad runtime. */
export function createPlayerRuntime({
  player,
  renderer,
  camera,
  Audio,
  getMatch,
  getAppState,
  playingState,
  pausedState,
  resumePlay,
  respawnPlayer,
  killCombatant,
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
  addViewModelRecoil,
  losClear,
  smokeBlocks,
  getEnemies,
  throwGrenade,
  showThrowArc,
}) {
const match = getMatch();

const keys = Object.create(null);
let mouseDX = 0, mouseDY = 0;
let firing = false, aiming = false;
let pointerLocked = false;

// Shared gameplay scratch remains local to the player runtime; projectile simulation owns its
// own vectors so future player and bot work cannot mutate a bullet step in progress.
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/**
 * Chest (hitbox centre, what bots aim at) and eye, above the body centre, which is the centre of
 * the foot sphere. Standing puts the eye 1.8 m above the floor and crouching 1.15 m. The eye used
 * to sit 2.1 m up, a head above the 2 m bots, so up close every opponent looked a size smaller
 * than you. The eye heights match the camera's (CONFIG.EYE_HEIGHT / CROUCH_HEIGHT), so what you
 * see down the barrel and where your rounds and line of sight start are the same point.
 */
const PLAYER_CHEST = 0.65;
const PLAYER_CHEST_CROUCH = 0.37;  // lowers bots' aim point to match crouching camera height

/**
 * The player's collider: a wide sphere at the feet and two narrow ones up the body to the top
 * of the head.
 *
 * It used to be the foot sphere alone, with the camera 1.6 m above it and nothing in between,
 * so the whole upper body passed through anything overhead: jump under a ramp and the camera
 * went through it and out on top. The upper spheres are deliberately NARROWER than the foot
 * sphere, so walls and ledge edges only ever touch the feet — they cannot snag a crate lip or
 * hoist the body onto one — and they only come into play against something overhead.
 */
const BODY_R = 0.3;
const BODY_OFFSETS = { stand: [0.7, 1.2], crouch: [0.4, 0.72] };
const HEAD_TOP = { stand: 1.2 + BODY_R, crouch: 0.72 + BODY_R };

function createPlayerBody() {
  const b = new CANNON.Body({
    mass: CONFIG.PLAYER_MASS,
    material: MAT_BODY,
    linearDamping: 0,
    angularDamping: 1,
    fixedRotation: true,
    collisionFilterGroup: G_BODY,
  });
  b.addShape(new CANNON.Sphere(CONFIG.PLAYER_RADIUS));
  for (const y of BODY_OFFSETS.stand) b.addShape(new CANNON.Sphere(BODY_R), new CANNON.Vec3(0, y, 0));
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

  // A hit that a shield soaked cracks instead of thudding, and the hit that breaks it shatters.
  const shield = soaked > 0 ? (target.armor <= 0 ? 'break' : 'hit') : null;
  if (target === player) {
    if (shield === 'break') Audio.shieldBreak(true);
    else if (shield) Audio.shieldHit(true);
    else Audio.hurt();
    if (source && source !== player) showDamageDirection(source.pos);
    addShake(0.035);
  } else {
    if (source === player) {
      const lethal = target.health <= 0;
      if (!lethal) {
        showHitMarker(headshot ? 'head' : 'body');
        if (shield === 'break') Audio.shieldBreak();
        else if (shield) Audio.shieldHit();
        if (headshot) Audio.headshot();
        else if (!shield) Audio.hit(player.current);
      }
      // zone was being dropped here, so every number rendered with the plain body style and a
      // headshot looked exactly like a graze. soaked tells the player *why* a centre-mass hit
      // landed for single digits — armour ate the rest — instead of it reading as a weak gun.
      showDamageNumber(hitPos || target.pos, dmg, headshot, zone, soaked > 0.5, lethal);
    }
    target.lastHurtBy = source;
    target.lastHurtAt = match.time;
  }

  if (target.health <= 0) {
    target.health = 0;
    killCombatant(target, source, headshot);
    if (source === player) {
      showHitMarker('kill');
      showKillBanner(target, headshot);
      if (headshot) Audio.headshot?.();
      Audio.kill();
    }
  }
}

/* ----------------------------- movement ----------------------------- */

/** Ground friction: speed falls in proportion to itself, but never slower than STOP_SPEED. */
function applyFriction(b, dt) {
  const sp = Math.hypot(b.velocity.x, b.velocity.z);
  if (sp < 1e-4) { b.velocity.x = 0; b.velocity.z = 0; return; }
  const drop = Math.max(sp, CONFIG.STOP_SPEED) * CONFIG.FRICTION * dt;
  const k = Math.max(0, sp - drop) / sp;
  b.velocity.x *= k;
  b.velocity.z *= k;
}

/** Add speed along the wish direction, never past `wishSpeed` along it. */
function accelerate(b, dx, dz, wishSpeed, accel, dt) {
  const along = b.velocity.x * dx + b.velocity.z * dz;
  const add = wishSpeed - along;
  if (add <= 0) return;
  const gain = Math.min(accel * wishSpeed * dt, add);
  b.velocity.x += gain * dx;
  b.velocity.z += gain * dz;
}

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

const THROW_POWER_SOFT = 6;    // m/s at a tap
const THROW_POWER_HARD = 21;   // m/s at a full hold
const THROW_LIFT_SOFT = 0.4;   // extra upward aim at a tap, so a short lob clears a crate
const THROW_LIFT_HARD = 0.06;
const SLIDE_TIME = 0.75;       // seconds a slide lasts at most
const SLIDE_BOOST = 1.2;       // times sprint speed at the start of a slide
const SLIDE_DECEL = 7;         // m/s lost per second while sliding
const _crouchFrom = new CANNON.Vec3();
const _crouchTo = new CANNON.Vec3();
const _crouchRes = new CANNON.RaycastResult();

function setCrouch(on) {
  if (player.crouching === on) return;

  const p = player.body.position;
  if (!on) {
    // Overhead clearance for the whole standing body: from the body centre up to where the top
    // of the head will be once standing (the centre rises by the radius change as well).
    const top = CONFIG.PLAYER_RADIUS - CONFIG.CROUCH_RADIUS + HEAD_TOP.stand + 0.05;
    for (const [ox, oz] of [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]]) {
      _crouchFrom.set(p.x + ox, p.y, p.z + oz);
      _crouchTo.set(p.x + ox, p.y + top, p.z + oz);
      _crouchRes.reset();
      world.raycastClosest(_crouchFrom, _crouchTo, RAY_OPTS, _crouchRes);
      if (_crouchRes.hasHit) return;  // not enough clearance — stay crouched
    }
  }

  player.crouching = on;
  player.hb = on ? HB_PLAYER_CROUCH : HB_PLAYER;
  const shape = player.body.shapes[0];
  const from = shape.radius;
  const to = on ? CONFIG.CROUCH_RADIUS : CONFIG.PLAYER_RADIUS;
  shape.radius = to;
  shape.updateBoundingSphereRadius();
  const offsets = on ? BODY_OFFSETS.crouch : BODY_OFFSETS.stand;
  offsets.forEach((y, i) => { player.body.shapeOffsets[i + 1].y = y; });
  player.body.updateBoundingRadius();
  player.body.aabbNeedsUpdate = true;
  // The sphere grows about its centre, so standing up buries the lower half in the floor and
  // the solver answers by launching the body ~0.8 m into the air. Shift the centre by the
  // radius delta instead, which keeps the feet exactly where they were.
  p.y += to - from;
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
  const foot = b.position.y - b.shapes[0].radius;

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

  // Spray recovery. Runs on the fixed clock so it is frame-rate independent, and before the
  // alive check so a respawn never inherits the bloom the previous life ended on.
  player.sinceShot += dt;
  const sprayWeapon = WEAPON_BY_ID[player.current];
  if (player.bloom > 0 && sprayWeapon) {
    // Recovery only starts once the trigger has been off for a full cooldown, so holding
    // fire never quietly recovers between rounds.
    if (player.sinceShot > sprayWeapon.cooldown * 1.35) {
      player.bloom = Math.max(0, player.bloom - (sprayWeapon.bloomDecay ?? 0.1) * dt);
      if (player.bloom === 0) player.sprayIndex = 0;
    }
  } else if (player.sinceShot > 0.35) {
    player.sprayIndex = 0;
  }

  if (!player.alive) { b.velocity.x = 0; b.velocity.z = 0; return; }

  const wasGrounded = player.grounded;
  playerGroundCheck();
  // Landing: how fast we came down decides how hard the camera dips (see updateCamera).
  if (player.grounded && !wasGrounded && player.airVy < -3.5) {
    player.landKick = clamp((-player.airVy - 3.5) * 0.022, 0.02, 0.14);
    player.landTime = 0;
    Audio.step?.();
  }
  player.landTime += dt;
  // Crouch reads from a latch when the player has chosen toggle-style bindings (see
  // settings.toggleCrouch), otherwise straight from the held key.
  const wasSprinting = player.sprinting, wasCrouching = player.crouching;
  setCrouch(settings.toggleCrouch ? crouchLatch : !!(keys.KeyC || keys.GpCrouch));
  // Crouching out of a sprint slides: a burst of speed that bleeds off, under a crouched
  // hitbox, which is how you cross a gap a bot is watching. It is read from the previous
  // step's sprint, because crouching has already cancelled this step's.
  const planarNow = Math.hypot(b.velocity.x, b.velocity.z);
  if (player.crouching && !wasCrouching && wasSprinting && player.grounded
      && planarNow > CONFIG.WALK_SPEED) {
    const boost = Math.max(planarNow, CONFIG.WALK_SPEED * CONFIG.SPRINT_MULT) * SLIDE_BOOST / planarNow;
    b.velocity.x *= boost;
    b.velocity.z *= boost;
    player.slideTime = SLIDE_TIME;
    Audio.slide?.();
  }
  if (!player.crouching || planarNow < CONFIG.WALK_SPEED * CONFIG.CROUCH_MULT) player.slideTime = 0;
  player.slideTime = Math.max(0, player.slideTime - dt);
  const sliding = player.slideTime > 0;

  // Movement basis is camera yaw with the pitch stripped out.
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  let fx = -sy, fz = -cy;        // forward
  let rx = cy, rz = -sy;         // right
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.GpForward || (settings.arrowKeys && keys.ArrowUp)) iz += 1;
  if (keys.KeyS || keys.GpBack || (settings.arrowKeys && keys.ArrowDown)) iz -= 1;
  if (keys.KeyD || keys.GpRight || (settings.arrowKeys && keys.ArrowRight)) ix += 1;
  if (keys.KeyA || keys.GpLeft || (settings.arrowKeys && keys.ArrowLeft)) ix -= 1;

  /**
   * Sprint: held, latched, or — with autoSprint — implied by walking forward.
   *
   * Holding Shift with the same hand that is covering WASD is genuinely awkward on a laptop
   * keyboard, and toggle-sprint only half solves it because you still have to remember to turn
   * it off. autoSprint needs the FORWARD key specifically, not just any movement, and stands
   * down while aiming: strafing to peek an angle stays at walking pace, and walking pace stays
   * reachable at all, which matters because sprinting is the widest accuracy cone in the game.
   */
  const wantSprint = (settings.toggleSprint ? sprintLatch : !!(keys.ShiftLeft || keys.GpSprint))
    || (settings.autoSprint && iz > 0);
  player.sprinting = wantSprint && !player.crouching && !aiming;

  let speed = CONFIG.WALK_SPEED;
  if (player.sprinting) speed *= CONFIG.SPRINT_MULT;
  if (player.crouching) speed *= CONFIG.CROUCH_MULT;
  if (aiming) speed *= 0.55;

  _wish.set(fx * iz + rx * ix, 0, fz * iz + rz * ix);
  if (_wish.lengthSq() > 0) _wish.normalize();

  // Friction on the ground only, then accelerate toward the wish. See CONFIG.GROUND_ACCEL.
  // A slide swaps friction for a steady bleed and only steers, so it carries its speed.
  if (sliding && player.grounded) {
    const k = Math.max(0, planarNow - SLIDE_DECEL * dt) / Math.max(1e-4, planarNow);
    b.velocity.x *= k;
    b.velocity.z *= k;
  } else if (player.grounded) applyFriction(b, dt);
  if (sliding) {
    if (_wish.lengthSq() > 0) accelerate(b, _wish.x, _wish.z, speed, CONFIG.AIR_ACCEL, dt);
  } else if (_wish.lengthSq() > 0) {
    accelerate(b, _wish.x, _wish.z, speed, player.grounded ? CONFIG.GROUND_ACCEL : CONFIG.AIR_ACCEL, dt);
  }
  _wish.multiplyScalar(speed);

  // Ledge step-up. A sphere collider catches on the lip of a crate: the contact normal points
  // back at you and the velocity controller just grinds against it. Probe a short way along
  // the direction we WANT to go, and if there is walkable ground within STEP_MAX above the
  // current foot, lift the body onto it. Cheap (one ray, only while actually walking).
  if (player.grounded && _wish.lengthSq() > 0) stepOver(b);

  if ((keys.Space || keys.GpJump) && player.grounded) {
    b.velocity.y = CONFIG.JUMP_SPEED;
    player.grounded = false;
  }
  // The rest of the player's gravity: the world supplies 9.82, CONFIG.PLAYER_GRAVITY is the
  // total. Only the player falls faster — grenades and bodies keep world gravity.
  b.velocity.y -= (CONFIG.PLAYER_GRAVITY + CONFIG.GRAVITY) * dt;
  if (!player.grounded) player.airVy = b.velocity.y;

  // Footsteps.
  const planar = Math.hypot(b.velocity.x, b.velocity.z);
  if (player.grounded && planar > 1.2) {
    player.stepTimer -= dt * (player.sprinting ? 1.5 : 1);
    if (player.stepTimer <= 0) { Audio.step(); player.stepTimer = 0.4; }
  } else {
    player.stepTimer = 0;
  }

  player.vel.set(b.velocity.x, b.velocity.y, b.velocity.z);
  syncPlayerPoints();

  // Fall out of the world guard.
  if (b.position.y < -20) respawnPlayer();
}

/** Chest and eye from the body. Also run on respawn, before the first step moves anything. */
function syncPlayerPoints() {
  const p = player.body.position;
  player.pos.set(p.x, p.y + (player.crouching ? PLAYER_CHEST_CROUCH : PLAYER_CHEST), p.z);
  player.eye.set(p.x, p.y + (player.crouching ? CONFIG.CROUCH_HEIGHT : CONFIG.EYE_HEIGHT), p.z);
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
}

/** Stand up and drop any latched crouch or slide, for a fresh life. */
function resetStance() {
  crouchLatch = false;
  player.slideTime = 0;
  setCrouch(false);
}

function switchWeapon(id) {
  if (player.current === id || !WEAPON_BY_ID[id]) return;
  if (id === 'frag' && player.fragCount <= 0) return;
  if (id !== 'frag' && !player.loadout.includes(id)) return;   // not carried
  player.current = id;
  player.reloading = 0;
  player.cooldown = Math.max(player.cooldown, 0.25);
  Audio.equip();
  // The crouch latch survives a swap: with toggle-crouch on, every swap used to stand you up.
  aiming = false; sprintLatch = false;
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
  player.cooldown = Math.max(0, w.cooldown - player.fireCarry);
  player.fireCarry = 0;

  playerAimDirection(_aimDir);
  // Additive accuracy: a settled, standing tap is effectively pinpoint, while movement, air
  // time and sustained fire each widen the cone on their own terms. See playerSpread.
  const planarSpeed = Math.hypot(player.body.velocity.x, player.body.velocity.z);
  const cone = playerSpread(w, {
    speed: planarSpeed,
    grounded: player.grounded,
    aiming,
    crouching: player.crouching,
    bloom: player.bloom,
  });

  // Fire from the muzzle marker so tracers leave the barrel, not the eyeball. The viewmodel
  // lives in its own scene whose camera sits at the origin, so its world position is already
  // camera-local: rotate by the aim quaternion and offset by the eye to reach world space.
  const mz = vmModels[w.id].userData.muzzle;
  const mzLocal = mz.getWorldPosition(new THREE.Vector3());
  _v3.copy(mzLocal).applyQuaternion(_camQ).add(camera.position);
  // Guard against the muzzle ending up inside geometry (up against a wall).
  if (!losClear(player.eye.x, player.eye.y, player.eye.z, _v3.x, _v3.y, _v3.z)) _v3.copy(player.eye);

  fireWeapon(player, w, _v3, _aimDir, 1, cone);

  // Deterministic spray pattern plus a small random component, so the pattern can be learned
  // and pulled against but two sprays are never pixel-identical.
  const [patYaw, patPitch] = recoilStep(w, player.sprayIndex);
  player.recoilPitch += w.recoil * patPitch;
  player.recoilYaw += w.recoil * patYaw + rand(-w.recoil * 0.12, w.recoil * 0.12);
  player.sprayIndex++;
  player.bloom = Math.min(w.bloomMax ?? 0, (player.bloom ?? 0) + (w.bloomStep ?? 0));
  player.sinceShot = 0;
  addViewModelRecoil(w.kick);
  triggerMuzzleFlash(mzLocal, _v3);
  ejectBrass(mzLocal.clone().add(new THREE.Vector3(0.05, 0.02, 0.12)));
  if (a.mag === 0) startReload();
  updateAmmoHud();
}

/* --------------------------- thrown ordnance --------------------------- */

function startCook(kind, source = 'key') {
  if (!player.alive || player.cooking) return;
  if (kind === 'frag' && player.fragCount <= 0) return;
  if (kind === 'smoke' && player.smokeCount <= 0) return;
  player.cooking = kind;
  player.cookSource = source;
  player.chargeTime = 0;
  Audio.pinPull();
}

/** How far the throw in hand has charged, 0 at a tap to 1 once held for THROW_CHARGE_TIME. */
function throwCharge() {
  return clamp(player.chargeTime / CONFIG.THROW_CHARGE_TIME, 0, 1);
}

/**
 * The throw a release would make now: its direction into `out`, and its speed returned.
 *
 * One throw strength could not cover both "over that wall" and "just past my feet", so the
 * hold sets it: a tap lobs it short and high, a full hold throws it flat and far, and the arc
 * drawn while you hold (updateThrowPreview) is exactly this throw.
 */
function throwAim(out) {
  const c = throwCharge();
  playerAimDirection(out);
  out.y += lerp(THROW_LIFT_SOFT, THROW_LIFT_HARD, c);
  out.normalize();
  return lerp(THROW_POWER_SOFT, THROW_POWER_HARD, c);
}

function releaseCook() {
  const kind = player.cooking;
  if (!kind) return;
  player.cooking = null;
  player.cookSource = null;
  showThrowArc(null);

  if (kind === 'frag') player.fragCount--;
  else player.smokeCount--;

  player.invulnTimer = 0;  // throwing cancels spawn protection
  const dir = new THREE.Vector3();
  const power = throwAim(dir);
  const origin = player.eye.clone().addScaledVector(dir, 0.7);
  throwGrenade(player, origin, dir, power, kind, kind === 'frag' ? CONFIG.FRAG_FUSE : CONFIG.SMOKE_FUSE);
  if (player.current === 'frag' && player.fragCount <= 0) switchWeapon(player.loadout[0]);
  updateAmmoHud();
}

const _throwDir = new THREE.Vector3();
const _throwFrom = new THREE.Vector3();

/** Charge the throw in hand and draw its arc. Once per rendered frame while playing. */
function updateThrowPreview(dt) {
  if (!player.cooking || !player.alive) { showThrowArc(null); return; }
  player.chargeTime += dt;
  const power = throwAim(_throwDir);
  _throwFrom.copy(player.eye).addScaledVector(_throwDir, 0.7);
  showThrowArc(player, _throwFrom, _throwDir, power);
}

/* ------------------------------ input ------------------------------ */

function bindInput() {
  const canvas = renderer.domElement;

  canvas.addEventListener('mousedown', (e) => {
    if (!pointerLocked) { requestLock(); return; }
    // With the frag selected, LMB cooks and releases exactly like G does.
    if (e.button === 0) {
      if (currentWeapon().thrown) startCook('frag', 'mouse');
      else { firing = true; tryFire(); }
    }
    if (e.button === 2) aiming = settings.toggleAim ? !aiming : true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      firing = false;
      if (player.cookSource === 'mouse') releaseCook();
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
      case 'Digit1': switchWeapon(player.loadout[0]); break;
      case 'Digit2': switchWeapon(player.loadout[1]); break;
      case 'Digit3': switchWeapon(player.loadout[2]); break;
      case 'Digit4': switchWeapon(player.loadout[3]); break;
      case 'Digit5': switchWeapon('frag'); break;
      case 'KeyR': startReload(); break;
      case 'KeyG': startCook('frag'); break;
      case 'KeyF': startCook('smoke'); break;
      case 'Tab': showBoard(true); break;
    }
  });

  addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (player.cookSource === 'key') {
      if (e.code === 'KeyG' && player.cooking === 'frag') releaseCook();
      if (e.code === 'KeyF' && player.cooking === 'smoke') releaseCook();
    }
    if (e.code === 'Tab') showBoard(false);
  });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    firing = false; aiming = false;
    if (pointerLocked && match.running) {
      resumePlay();
      // The death screen shares this overlay and the match loop keeps it up while you are dead.
      if (player.alive) showPause(false);
    } else if (!pointerLocked && getAppState() === playingState) {
      showPause(true);
    }
  });

  document.getElementById('pause').addEventListener('click', () => {
    if (getAppState() === pausedState) requestLock();
  });
}

function requestLock() {
  if (!match.running) return;
  // Chrome returns a promise here and rejects it when a lock is asked for too soon after the
  // player left one — press Esc, click straight back in. Unhandled, that was a console error
  // and a click that silently did nothing. The pause overlay is still up when it happens, so
  // the next click simply asks again.
  renderer.domElement.requestPointerLock()?.catch?.(() => {});
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

  // Buttons get their own flags, like the stick does. Writing the keyboard's (keys.Space,
  // KeyC, ShiftLeft) meant any connected pad reset them every frame before the player stepped,
  // so with a controller plugged in the keyboard could not jump, crouch or sprint.
  keys.GpJump = down(0);                                    // A
  // B: gate on toggleCrouch so only one of crouchLatch or GpCrouch is driven at a time.
  if (settings.toggleCrouch) { if (pressed(1)) crouchLatch = !crouchLatch; }
  else { keys.GpCrouch = down(1); }
  keys.GpSprint = down(11);                                 // right stick click sprints
  if (pressed(4)) startCook('frag', 'pad');                 // LB
  if (!down(4) && player.cookSource === 'pad') releaseCook();
  if (pressed(2)) startReload();                            // X
  if (pressed(3)) switchWeapon('frag');                     // Y
  if (pressed(12)) switchWeapon(player.loadout[0]);
  if (pressed(13)) switchWeapon(player.loadout[1]);
  if (pressed(14)) switchWeapon(player.loadout[2]);
  if (pressed(15)) switchWeapon(player.loadout[3]);
  if (pressed(9)) {                                          // start: pause or resume
    if (getAppState() === playingState) showPause(true);
    else if (getAppState() === pausedState) requestLock();
  }
}

/**
 * Pointer-delta boost, for playing on a trackpad.
 *
 * A trackpad gives you a few centimetres of travel, so at a sensitivity that still allows fine
 * aim a 180 turn takes three or four swipes — the single biggest reason a shooter is unpleasant
 * on a laptop. A mouse solves this in hardware with a high CPI; this makes the same trade in
 * software. Movement slower than KNEE passes through untouched, so small corrections keep the
 * 1:1 feel the whole crosshair is tuned around, and faster movement is scaled up progressively
 * to at most MAX, which is low enough that a palm brush cannot spin the camera.
 *
 * Rate is measured per 60 Hz frame rather than per frame, so the curve does not change when the
 * player caps the frame rate and each frame's delta covers more time.
 */
const BOOST_KNEE = 5;            // px per 1/60 s
const BOOST_RANGE = 35;          // px per 1/60 s of ramp above the knee
const BOOST_MAX = 2.6;

function trackpadBoost(delta, dt) {
  const rate = Math.abs(delta) / 60 / Math.max(dt, 1 / 240);
  if (rate <= BOOST_KNEE) return delta;
  const ramp = Math.min((rate - BOOST_KNEE) / BOOST_RANGE, 1);
  return delta * (1 + (BOOST_MAX - 1) * ramp);
}

/**
 * Aim assist. Off at 0, friction-only up to half strength, a small pull above that.
 *
 * This exists for trackpad and keyboard play, where the hard part is not finding the target but
 * stopping on it. Friction — slowing the crosshair while it is over someone — fixes exactly
 * that and never moves your aim for you, which is why it is what the default strength buys.
 */
const ASSIST_CONE = 0.055;       // rad, ~3.2 degrees either side of the crosshair
const ASSIST_FRICTION = 0.55;    // fraction of look speed removed dead centre at strength 1
const ASSIST_PULL = 0.5;         // rad/s of pull dead centre at strength 1
const _assistFwd = new THREE.Vector3();
const _assistVec = new THREE.Vector3();

/**
 * The enemy nearest the crosshair, if assist is on and that enemy can actually be seen.
 *
 * Visibility is a real line-of-sight test plus the smoke check, deliberately NOT bot.spotted:
 * spotting marks anything within 30 m as seen whether or not a wall is in the way, so keying
 * assist off it would drag the crosshair over targets behind cover — an accidental wallhack.
 */
function assistTarget() {
  if (!(settings.aimAssist > 0) || !player.alive || !getMatch().running) return null;

  const cp = Math.cos(player.pitch);
  _assistFwd.set(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp);

  let best = null;
  let bestAngle = ASSIST_CONE;
  for (const e of getEnemies()) {
    if (!e.alive) continue;
    if (player.team !== TEAM.SOLO && e.team === player.team) continue;
    _assistVec.subVectors(e.pos, player.eye);
    const dist = _assistVec.length();
    if (dist < 0.001) continue;
    const angle = Math.acos(clamp(_assistVec.dot(_assistFwd) / dist, -1, 1));
    if (angle >= bestAngle) continue;
    bestAngle = angle;
    best = e;
  }
  if (!best) return null;
  // One ray, for the one candidate that matters.
  if (!losClear(player.eye.x, player.eye.y, player.eye.z, best.pos.x, best.pos.y, best.pos.z)) {
    return null;
  }
  if (smokeBlocks(player.eye, best.pos)) return null;
  return { target: best, closeness: 1 - bestAngle / ASSIST_CONE };
}

/**
 * A gentle pull toward the target, above half strength only.
 *
 * Bounded by rate rather than by distance, so it can help track someone crossing the screen but
 * can never snap onto them: at full strength it closes 0.5 rad/s, slower than a person turns,
 * and it fades to nothing as the crosshair arrives.
 */
function applyAssistPull(assist, dt) {
  if (settings.aimAssist <= 0.5) return;
  const rate = ASSIST_PULL * (settings.aimAssist - 0.5) * 2 * assist.closeness * dt;
  _assistVec.subVectors(assist.target.pos, player.eye);
  const len = _assistVec.length() || 1;
  let dYaw = Math.atan2(-_assistVec.x, -_assistVec.z) - player.yaw;
  while (dYaw > Math.PI) dYaw -= Math.PI * 2;
  while (dYaw < -Math.PI) dYaw += Math.PI * 2;
  player.yaw += clamp(dYaw, -rate, rate);
  player.pitch += clamp(Math.asin(clamp(_assistVec.y / len, -1, 1)) - player.pitch, -rate, rate);
}

function applyLook(dt) {
  // Scope multiplier scales with adsSensitivity so the slider is predictable at all settings.
  // At the default (0.75) this equals the previous hardcoded 0.4.
  const adsMult = aiming && currentWeapon().zoom
    ? settings.adsSensitivity * (0.4 / 0.75)
    : (aiming ? settings.adsSensitivity : 1);
  const sens = CONFIG.SENS * settings.sensitivity * adsMult;

  if (settings.trackpadLook) {
    mouseDX = trackpadBoost(mouseDX, dt);
    mouseDY = trackpadBoost(mouseDY, dt);
  }
  const assist = assistTarget();
  if (assist) {
    const grip = 1 - ASSIST_FRICTION * settings.aimAssist * assist.closeness;
    mouseDX *= grip;
    mouseDY *= grip;
  }

  player.yaw -= mouseDX * sens;
  player.pitch -= mouseDY * sens * (settings.invertY ? -1 : 1);
  player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  if (assist) applyAssistPull(assist, dt);

  // Weapon sway trails the mouse and settles back.
  player.sway.x = clamp(lerp(player.sway.x, -mouseDX * 0.0016, 0.35), -1, 1);
  player.sway.y = clamp(lerp(player.sway.y, -mouseDY * 0.0016, 0.35), -1, 1);
  player.sway.multiplyScalar(Math.pow(0.02, dt));

  mouseDX = 0; mouseDY = 0;

  const rec = Math.pow(0.0009, dt);      // exponential recovery toward the original aim
  player.recoilPitch *= rec;
  player.recoilYaw *= rec;
}

return {
  player,
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
  releaseCook,
  throwCharge,
  updateThrowPreview,
  bindInput,
  requestLock,
  pollGamepad,
  applyLook,
  cameraEuler: _camE,
  isAiming: () => aiming,
  setAiming: (on) => { aiming = !!on; },      // test and debug hook
  isFiring: () => firing,
  isPointerLocked: () => pointerLocked,
  isGamepadActive: () => gamepadActive,
  stopFiring: () => { firing = false; },
};
}
