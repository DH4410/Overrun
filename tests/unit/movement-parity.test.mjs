import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import { CONFIG, FIXED_DT } from '../../src/config.js';
import { clamp } from '../../src/utils.js';
import { createWorld, makeStaticBox, makeStaticCylinder, RAY_OPTS } from '../../src/sim/world.js';
import { buildMapColliders } from '../../src/sim/colliders.js';
import { HB_PLAYER, HB_PLAYER_CROUCH } from '../../src/sim/hitmath.js';
import { createPlayerBody, stepMovement } from '../../src/sim/movement.js';

/**
 * Single player's movement was moved out of src/player.js into src/sim/movement.js so the
 * multiplayer server and client prediction run the same code. This pins that the move changed
 * nothing: the pre-extraction stepPlayer, copied here verbatim (minus audio, settings and the
 * DOM), and the shared stepMovement drive two identical worlds through the same inputs, and the
 * body must match bit for bit on every tick.
 */

function portWorld() {
  const world = createWorld();
  const data = JSON.parse(readFileSync(new URL('../../assets/maps/port.json', import.meta.url)));
  buildMapColliders(data, [50, 38], {
    addStaticBox: (...a) => world.addBody(makeStaticBox(...a)),
    addStaticCylinder: (...a) => world.addBody(makeStaticCylinder(...a)),
    addBlocker: () => {},
  });
  return world;
}

function newPlayer(world, x, y, z, yaw) {
  const body = createPlayerBody();
  body.position.set(x, y, z);
  world.addBody(body);
  return {
    body, yaw, hb: HB_PLAYER, grounded: false, crouching: false, sprinting: false,
    slideTime: 0, airVy: 0, landTime: 99, landKick: 0,
  };
}

/* ---- the reference: src/player.js before the extraction, verbatim where it moves bodies ---- */
function referenceStepper(world, player) {
  const BODY_R = 0.3;
  const BODY_OFFSETS = { stand: [0.7, 1.2], crouch: [0.4, 0.72] };
  const HEAD_TOP = { stand: 1.2 + BODY_R, crouch: 0.72 + BODY_R };
  function applyFriction(b, dt) {
    const sp = Math.hypot(b.velocity.x, b.velocity.z);
    if (sp < 1e-4) { b.velocity.x = 0; b.velocity.z = 0; return; }
    const drop = Math.max(sp, CONFIG.STOP_SPEED) * CONFIG.FRICTION * dt;
    const k = Math.max(0, sp - drop) / sp;
    b.velocity.x *= k;
    b.velocity.z *= k;
  }
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
  const SLIDE_TIME = 0.75, SLIDE_BOOST = 1.2, SLIDE_DECEL = 7;
  const _crouchFrom = new CANNON.Vec3(), _crouchTo = new CANNON.Vec3(), _crouchRes = new CANNON.RaycastResult();
  function setCrouch(on) {
    if (player.crouching === on) return;
    const p = player.body.position;
    if (!on) {
      const top = CONFIG.PLAYER_RADIUS - CONFIG.CROUCH_RADIUS + HEAD_TOP.stand + 0.05;
      for (const [ox, oz] of [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]]) {
        _crouchFrom.set(p.x + ox, p.y, p.z + oz);
        _crouchTo.set(p.x + ox, p.y + top, p.z + oz);
        _crouchRes.reset();
        world.raycastClosest(_crouchFrom, _crouchTo, RAY_OPTS, _crouchRes);
        if (_crouchRes.hasHit) return;
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
    p.y += to - from;
  }
  const STEP_AHEAD = 0.55, STEP_MAX = 0.45;
  const _stepFrom = new CANNON.Vec3(), _stepTo = new CANNON.Vec3(), _stepRes = new CANNON.RaycastResult();
  function stepOver(b) {
    const len = Math.hypot(_wish.x, _wish.z);
    if (len < 0.001) return;
    const ax = b.position.x + (_wish.x / len) * STEP_AHEAD;
    const az = b.position.z + (_wish.z / len) * STEP_AHEAD;
    const foot = b.position.y - b.shapes[0].radius;
    _stepFrom.set(ax, foot + STEP_MAX + 0.05, az);
    _stepTo.set(ax, foot - 0.10, az);
    _stepRes.reset();
    world.raycastClosest(_stepFrom, _stepTo, RAY_OPTS, _stepRes);
    if (!_stepRes.hasHit) return;
    const rise = _stepRes.hitPointWorld.y - foot;
    if (rise <= 0.04 || rise > STEP_MAX) return;
    b.position.y += rise + 0.02;
    if (b.velocity.y < 0) b.velocity.y = 0;
  }
  return function stepPlayer(dt, keys, aiming) {
    const b = player.body;
    const wasGrounded = player.grounded;
    playerGroundCheck();
    if (player.grounded && !wasGrounded && player.airVy < -3.5) {
      player.landKick = clamp((-player.airVy - 3.5) * 0.022, 0.02, 0.14);
      player.landTime = 0;
    }
    player.landTime += dt;
    const wasSprinting = player.sprinting, wasCrouching = player.crouching;
    setCrouch(!!keys.KeyC);
    const planarNow = Math.hypot(b.velocity.x, b.velocity.z);
    if (player.crouching && !wasCrouching && wasSprinting && player.grounded
        && planarNow > CONFIG.WALK_SPEED) {
      const boost = Math.max(planarNow, CONFIG.WALK_SPEED * CONFIG.SPRINT_MULT) * SLIDE_BOOST / planarNow;
      b.velocity.x *= boost;
      b.velocity.z *= boost;
      player.slideTime = SLIDE_TIME;
    }
    if (!player.crouching || planarNow < CONFIG.WALK_SPEED * CONFIG.CROUCH_MULT) player.slideTime = 0;
    player.slideTime = Math.max(0, player.slideTime - dt);
    const sliding = player.slideTime > 0;
    const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
    let fx = -sy, fz = -cy;
    let rx = cy, rz = -sy;
    let ix = 0, iz = 0;
    if (keys.KeyW) iz += 1;
    if (keys.KeyS) iz -= 1;
    if (keys.KeyD) ix += 1;
    if (keys.KeyA) ix -= 1;
    const wantSprint = !!keys.ShiftLeft;
    player.sprinting = wantSprint && !player.crouching && !aiming;
    let speed = CONFIG.WALK_SPEED;
    if (player.sprinting) speed *= CONFIG.SPRINT_MULT;
    if (player.crouching) speed *= CONFIG.CROUCH_MULT;
    if (aiming) speed *= 0.55;
    _wish.set(fx * iz + rx * ix, 0, fz * iz + rz * ix);
    if (_wish.lengthSq() > 0) _wish.normalize();
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
    if (player.grounded && _wish.lengthSq() > 0) stepOver(b);
    if (keys.Space && player.grounded) {
      b.velocity.y = CONFIG.JUMP_SPEED;
      player.grounded = false;
    }
    b.velocity.y -= (CONFIG.PLAYER_GRAVITY + CONFIG.GRAVITY) * dt;
    if (!player.grounded) player.airVy = b.velocity.y;
  };
}

/** A scripted run: [seconds, keys, aiming, yawRate]. Walk, sprint, slide, jump, strafe, ramp. */
const SCRIPT = [
  [0.5, {}, false, 0],
  [1.0, { KeyW: 1 }, false, 0],
  [1.0, { KeyW: 1, ShiftLeft: 1 }, false, 0],
  [0.6, { KeyW: 1, ShiftLeft: 1, KeyC: 1 }, false, 0],         // slide
  [0.5, { KeyW: 1 }, false, 0.8],
  [0.3, { KeyW: 1, Space: 1 }, false, 0],
  [1.0, { KeyD: 1, KeyW: 1 }, true, -1.2],
  [0.8, { KeyA: 1, KeyC: 1 }, false, 0.4],
  [1.0, { KeyS: 1, ShiftLeft: 1 }, false, 0],
  [0.4, { Space: 1 }, false, 0],
  [2.0, { KeyW: 1, ShiftLeft: 1 }, false, 0.3],
  [1.5, {}, false, 0],
];

function runBoth(x, z, yaw) {
  const wa = portWorld(), wb = portWorld();
  const pa = newPlayer(wa, x, 3, z, yaw), pb = newPlayer(wb, x, 3, z, yaw);
  const ref = referenceStepper(wa, pa);
  let ticks = 0;
  for (const [secs, keys, aiming, yawRate] of SCRIPT) {
    const n = Math.round(secs / FIXED_DT);
    for (let i = 0; i < n; i++) {
      pa.yaw += yawRate * FIXED_DT; pb.yaw += yawRate * FIXED_DT;
      ref(FIXED_DT, keys, aiming);
      const ix = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      const iz = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      stepMovement(wb, pb, { ix, iz, crouch: !!keys.KeyC, sprint: !!keys.ShiftLeft, aiming, jump: !!keys.Space }, FIXED_DT);
      wa.step(FIXED_DT); wb.step(FIXED_DT);
      ticks++;
      for (const k of ['position', 'velocity']) {
        for (const c of ['x', 'y', 'z']) {
          assert.equal(pb.body[k][c], pa.body[k][c], `tick ${ticks} ${k}.${c}`);
        }
      }
      assert.equal(pb.grounded, pa.grounded, `tick ${ticks} grounded`);
      assert.equal(pb.crouching, pa.crouching, `tick ${ticks} crouching`);
      assert.equal(pb.slideTime, pa.slideTime, `tick ${ticks} slideTime`);
    }
  }
  return { ticks, travelled: Math.hypot(pb.body.position.x - x, pb.body.position.z - z), slid: true };
}

test('shared movement matches the pre-extraction stepPlayer bit for bit (open ground)', () => {
  const { ticks, travelled } = runBoth(0, 31, 0);
  assert.ok(ticks > 1000);
  assert.ok(travelled > 5, `moved ${travelled}`);
});

test('shared movement matches the pre-extraction stepPlayer bit for bit (up the dock ramp)', () => {
  // PORT's ramp runs from (4.5, 0, 11.5) up to (4.5, 1.4, 5): start below it facing up it.
  runBoth(4.5, 14, 0);
});
