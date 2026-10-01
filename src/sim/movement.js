import * as CANNON from 'cannon-es';
import { Vector3 } from 'three';

import { CONFIG } from '../config.js';
import { clamp } from '../utils.js';
import { HB_PLAYER, HB_PLAYER_CROUCH } from './hitmath.js';
import { G_BODY, MAT_BODY, RAY_OPTS } from './world.js';

/**
 * Player movement, shared by the browser (src/player.js), client-side prediction and the
 * multiplayer server. Every function takes the world, the player state (which owns `body`) and
 * a command; nothing here reads the DOM, the keyboard or the audio. Single player calls it with
 * exactly the arguments its old inline code used, so it moves bit-for-bit the same
 * (tests/unit/movement-parity.test.mjs).
 *
 * A command is { ix, iz, crouch, sprint, aiming, jump }: ix/iz the strafe and forward keys in
 * -1..1, sprint already resolved from the player's bindings (held, latched or auto).
 */

/**
 * Chest (hitbox centre, what bots aim at) and eye, above the body centre, which is the centre of
 * the foot sphere. Standing puts the eye 1.8 m above the floor and crouching 1.15 m. The eye used
 * to sit 2.1 m up, a head above the 2 m bots, so up close every opponent looked a size smaller
 * than you. The eye heights match the camera's (CONFIG.EYE_HEIGHT / CROUCH_HEIGHT), so what you
 * see down the barrel and where your rounds and line of sight start are the same point.
 */
export const PLAYER_CHEST = 0.65;
export const PLAYER_CHEST_CROUCH = 0.37;  // lowers bots' aim point to match crouching camera height

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
export const BODY_R = 0.3;
export const BODY_OFFSETS = { stand: [0.7, 1.2], crouch: [0.4, 0.72] };
export const HEAD_TOP = { stand: 1.2 + BODY_R, crouch: 0.72 + BODY_R };

export const SLIDE_TIME = 0.75;       // seconds a slide lasts at most
export const SLIDE_BOOST = 1.2;       // times sprint speed at the start of a slide
export const SLIDE_DECEL = 7;         // m/s lost per second while sliding
/* Ledge step-up (see stepMovement). */
const STEP_AHEAD = 0.55;      // how far along the move direction to probe
const STEP_MAX = 0.45;        // tallest lip we will climb

/** A player body, not yet added to any world. `mask` -1 collides with everything. */
export function createPlayerBody(mask = -1) {
  const b = new CANNON.Body({
    mass: CONFIG.PLAYER_MASS,
    material: MAT_BODY,
    linearDamping: 0,
    angularDamping: 1,
    fixedRotation: true,
    collisionFilterGroup: G_BODY,
    collisionFilterMask: mask,
  });
  b.addShape(new CANNON.Sphere(CONFIG.PLAYER_RADIUS));
  for (const y of BODY_OFFSETS.stand) b.addShape(new CANNON.Sphere(BODY_R), new CANNON.Vec3(0, y, 0));
  b.updateMassProperties();
  return b;
}

/** Ground friction: speed falls in proportion to itself, but never slower than STOP_SPEED. */
export function applyFriction(b, dt) {
  const sp = Math.hypot(b.velocity.x, b.velocity.z);
  if (sp < 1e-4) { b.velocity.x = 0; b.velocity.z = 0; return; }
  const drop = Math.max(sp, CONFIG.STOP_SPEED) * CONFIG.FRICTION * dt;
  const k = Math.max(0, sp - drop) / sp;
  b.velocity.x *= k;
  b.velocity.z *= k;
}

/** Add speed along the wish direction, never past `wishSpeed` along it. */
export function accelerate(b, dx, dz, wishSpeed, accel, dt) {
  const along = b.velocity.x * dx + b.velocity.z * dz;
  const add = wishSpeed - along;
  if (add <= 0) return;
  const gain = Math.min(accel * wishSpeed * dt, add);
  b.velocity.x += gain * dx;
  b.velocity.z += gain * dz;
}

const _up = new CANNON.Vec3(0, 1, 0);
const _cn = new CANNON.Vec3();
const _wish = new Vector3();

export function groundCheck(world, player) {
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

export function setCrouch(world, player, on) {
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

const _stepFrom = new CANNON.Vec3();
const _stepTo = new CANNON.Vec3();
const _stepRes = new CANNON.RaycastResult();

function stepOver(world, b) {
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

/**
 * One fixed step of a living player's movement: ground check, crouch and slide, Quake-style
 * friction and acceleration toward the wish, ledge step-up, jump and the extra gravity. Runs
 * before world.step. `hooks.land()` and `hooks.slide()` are for sound, and are optional.
 */
export function stepMovement(world, player, cmd, dt, hooks = null) {
  const b = player.body;
  const wasGrounded = player.grounded;
  groundCheck(world, player);
  // Landing: how fast we came down decides how hard the camera dips (see updateCamera).
  if (player.grounded && !wasGrounded && player.airVy < -3.5) {
    player.landKick = clamp((-player.airVy - 3.5) * 0.022, 0.02, 0.14);
    player.landTime = 0;
    hooks?.land?.();
  }
  player.landTime += dt;
  const wasSprinting = player.sprinting, wasCrouching = player.crouching;
  setCrouch(world, player, cmd.crouch);
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
    hooks?.slide?.();
  }
  if (!player.crouching || planarNow < CONFIG.WALK_SPEED * CONFIG.CROUCH_MULT) player.slideTime = 0;
  player.slideTime = Math.max(0, player.slideTime - dt);
  const sliding = player.slideTime > 0;

  // Movement basis is camera yaw with the pitch stripped out.
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  const fx = -sy, fz = -cy;        // forward
  const rx = cy, rz = -sy;         // right
  const ix = cmd.ix, iz = cmd.iz;

  const aiming = cmd.aiming;
  player.sprinting = cmd.sprint && !player.crouching && !aiming;

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
  if (player.grounded && _wish.lengthSq() > 0) stepOver(world, b);

  if (cmd.jump && player.grounded) {
    b.velocity.y = CONFIG.JUMP_SPEED;
    player.grounded = false;
  }
  // The rest of the player's gravity: the world supplies 9.82, CONFIG.PLAYER_GRAVITY is the
  // total. Only the player falls faster — grenades and bodies keep world gravity.
  b.velocity.y -= (CONFIG.PLAYER_GRAVITY + CONFIG.GRAVITY) * dt;
  if (!player.grounded) player.airVy = b.velocity.y;
}

/** Chest and eye from the body. Also run on respawn, before the first step moves anything. */
export function syncPlayerPoints(player) {
  const p = player.body.position;
  player.pos.set(p.x, p.y + (player.crouching ? PLAYER_CHEST_CROUCH : PLAYER_CHEST), p.z);
  player.eye.set(p.x, p.y + (player.crouching ? CONFIG.CROUCH_HEIGHT : CONFIG.EYE_HEIGHT), p.z);
}
