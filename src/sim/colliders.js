import * as CANNON from 'cannon-es';
import { Euler, Quaternion, Vector3 } from 'three';

import { RAY_OPTS } from './world.js';

/**
 * A map's colliders from its Blender JSON (assets/maps/<file>.json), plus the blockers and the
 * spawn validation built on them. Pure cannon and THREE math, so the browser and the server
 * build the identical level. `deps` adds the bodies: { addStaticBox, addStaticCylinder,
 * addBlocker }.
 */

/**
 * The collider for a solid ramp from (x0,y0,z0) up to (x1,y1,z1); its mesh is modelled in
 * Blender. The walking surface is one tilted 0.4 m slab, sunk by half its thickness so its top
 * face runs exactly through both end points, and a row of boxes fills everything beneath it: a
 * slab in mid-air let a jump underneath put the camera through the ramp.
 */
export function addRampCollider(x0, y0, z0, x1, y1, z1, width, { addStaticBox, addBlocker }) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const run = Math.hypot(dx, dz);
  const len = Math.hypot(run, dy);
  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.atan2(dy, run);
  const quat = new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'));
  const T = 0.4;
  const n = new Vector3(0, 1, 0).applyQuaternion(quat);
  addStaticBox(width / 2, T / 2, len / 2, {
    x: (x0 + x1) / 2 - n.x * T / 2,
    y: (y0 + y1) / 2 - n.y * T / 2,
    z: (z0 + z1) / 2 - n.z * T / 2,
  }, new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w));

  // Fill. Each box's top sits at the slab's underside at the box's LOW end, so it is always
  // below the walking surface, and the sliver left between them is far too thin for anything.
  const ux = dx / run, uz = dz / run;
  const slope = dy / run;
  const under = T * len / run;                 // the slab's thickness measured vertically
  const yawQ = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  const SEG = 0.8;
  for (let a = 0; a < run; a += SEG) {
    const b = Math.min(run, a + SEG);
    const h = slope * a - under;
    if (h < 0.05) continue;
    const mid = (a + b) / 2;
    addStaticBox(width / 2, h / 2, (b - a) / 2, { x: x0 + ux * mid, y: y0 + h / 2, z: z0 + uz * mid }, yawQ);
  }

  // Footprint of the rotated ramp, for spawn validation and the minimap plan.
  addBlocker((x0 + x1) / 2, (z0 + z1) / 2,
    Math.abs(ux) * run / 2 + Math.abs(uz) * width / 2,
    Math.abs(uz) * run / 2 + Math.abs(ux) * width / 2);
}

/** Boxes, ramps and cylinders from the JSON, then the perimeter strips. */
export function buildMapColliders(data, half, deps) {
  const { addStaticBox, addStaticCylinder, addBlocker } = deps;
  const ramp = deps.addRampCollider ?? ((...r) => addRampCollider(...r, deps));
  const { boxes, ramps, cylinders = [] } = data;
  const Y = new CANNON.Vec3(0, 1, 0);
  for (const [x, y, z, hx, hy, hz, yaw, block] of boxes) {
    const quat = yaw ? new CANNON.Quaternion().setFromAxisAngle(Y, yaw) : null;
    addStaticBox(hx, hy, hz, { x, y, z }, quat);
    if (block && y + hy > 0.7 && y - hy < 2.4) {
      const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
      addBlocker(x, z, hx * c + hz * s, hx * s + hz * c);
    }
  }
  for (const r of ramps) ramp(...r);
  for (const [x, y, z, r, h, block] of cylinders) {
    addStaticCylinder(r, h, { x, y, z });
    if (block && y + h / 2 > 0.7 && y - h / 2 < 2.4) addBlocker(x, z, r, r);
  }

  const [HX, HZ] = half;
  addBlocker(0, -HZ, HX, 1.2); addBlocker(0, HZ, HX, 1.2);
  addBlocker(-HX, 0, 1.2, HZ); addBlocker(HX, 0, 1.2, HZ);
}

export function inBlockers(blockers, x, z, pad = 0) {
  for (const b of blockers) {
    if (Math.abs(x - b.x) < b.hx + pad && Math.abs(z - b.z) < b.hz + pad) return true;
  }
  return false;
}

const _from = new CANNON.Vec3();
const _to = new CANNON.Vec3();
const _res = new CANNON.RaycastResult();

/** Height of the floor under (x, z), cast down from castY to -1, or null. */
export function floorAt(world, x, z, castY) {
  _from.set(x, castY, z);
  _to.set(x, -1, z);
  _res.reset();
  world.raycastClosest(_from, _to, RAY_OPTS, _res);
  return _res.hasHit ? _res.hitPointWorld.y : null;
}

/**
 * Spawn points from a map's candidates, validated against the built level rather than trusted:
 * each must clear every blocker by 2 m and have a floor under it. Returns [{ x, y, z }].
 *
 * `castY` is the height the ground-finding rays start from, and it must sit BELOW the map's
 * lowest roof collider: a ray from above a roof lands on it, and the match then opens with
 * everyone standing on top of the building.
 */
export function validSpawnPoints(world, blockers, candidates, fallback, castY) {
  const out = [];
  let rejected = 0;
  for (const [x, z] of candidates) {
    if (inBlockers(blockers, x, z, 2.0)) { rejected++; continue; }   // pillar, ramp, crate, low wall
    const y = floorAt(world, x, z, castY);
    if (y === null) { rejected++; continue; }                         // no floor under it at all
    out.push({ x, y: y + 0.9, z });
  }
  // Never leave the game unable to spawn anyone.
  if (out.length < 4) {
    for (const [x, z] of fallback) out.push({ x, y: 0.9, z });
  }
  return { points: out, rejected };
}
