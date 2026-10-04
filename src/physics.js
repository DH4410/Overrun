import {
  G_BODY, G_NADE, G_WORLD, MAT_BODY, MAT_NADE, MAT_WORLD, RAY_OPTS,
  createWorld, makeStaticBox, makeStaticCylinder,
} from './sim/world.js';

/** The browser's one physics world. The rules live in sim/world.js, shared with the server. */
export const world = createWorld();

export { G_BODY, G_NADE, G_WORLD, MAT_BODY, MAT_NADE, MAT_WORLD, RAY_OPTS };

/** Every static body the current map owns, so switching maps can take them all back out. */
export const mapBodies = [];

export function addStaticBox(halfX, halfY, halfZ, pos, quat = null) {
  const body = makeStaticBox(halfX, halfY, halfZ, pos, quat);
  world.addBody(body);
  mapBodies.push(body);
  return body;
}
export function addStaticCylinder(radius, height, pos) {
  const body = makeStaticCylinder(radius, height, pos);
  world.addBody(body);
  mapBodies.push(body);
  return body;
}
