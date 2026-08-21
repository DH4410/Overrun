import * as CANNON from 'cannon-es';

import { CONFIG } from './config.js';

export const world = new CANNON.World({ gravity: new CANNON.Vec3(0, CONFIG.GRAVITY, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
// Sleeping is fatal here: a sleeping body is dropped from the narrowphase, so the player's
// floor contact vanishes from world.contacts and playerGroundCheck() can never see ground
// again. grounded stays false, movement falls back to the 0.22x air-control accel, and the
// player crawls. Dynamic bodies in this game are few, so sleeping buys us nothing anyway.
world.allowSleep = false;
world.defaultContactMaterial.friction = 0.25;
world.defaultContactMaterial.restitution = 0;

export const MAT_WORLD = new CANNON.Material('world');
export const MAT_BODY = new CANNON.Material('body');
export const MAT_NADE = new CANNON.Material('nade');

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
export const G_WORLD = 1, G_BODY = 2, G_NADE = 4;
export const RAY_OPTS = { skipBackfaces: true, collisionFilterGroup: -1, collisionFilterMask: G_WORLD };

/** Every static body the current map owns, so switching maps can take them all back out. */
export const mapBodies = [];

export function addStaticBox(halfX, halfY, halfZ, pos, quat = null) {
  const body = new CANNON.Body({ mass: 0, material: MAT_WORLD, collisionFilterGroup: G_WORLD });
  body.addShape(new CANNON.Box(new CANNON.Vec3(halfX, halfY, halfZ)));
  body.position.set(pos.x, pos.y, pos.z);
  if (quat) body.quaternion.copy(quat);
  world.addBody(body);
  mapBodies.push(body);
  return body;
}
export function addStaticCylinder(radius, height, pos) {
  const body = new CANNON.Body({ mass: 0, material: MAT_WORLD, collisionFilterGroup: G_WORLD });
  body.addShape(new CANNON.Cylinder(radius, radius, height, 12));
  body.position.set(pos.x, pos.y, pos.z);
  world.addBody(body);
  mapBodies.push(body);
  return body;
}
