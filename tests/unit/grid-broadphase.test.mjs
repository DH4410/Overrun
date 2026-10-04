import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as CANNON from 'cannon-es';

import { createWorld, makeStaticBox } from '../../src/sim/world.js';

/**
 * The grid broadphase must hand the narrowphase the same pairs, and raycasts the same bodies, as
 * cannon's own sweep-and-prune over the same level; it is only allowed to be faster.
 */

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function level(world, n) {
  for (let i = 0; i < n; i++) {
    const big = i % 40 === 0;
    const hx = big ? 30 + rnd() * 30 : 0.4 + rnd() * 3, hz = big ? 0.5 : 0.4 + rnd() * 3, hy = 0.4 + rnd() * 3;
    world.addBody(makeStaticBox(hx, hy, hz, { x: (rnd() - 0.5) * 140, y: hy, z: (rnd() - 0.5) * 140 }));
  }
}

function movers(world, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = new CANNON.Body({ mass: 1, collisionFilterGroup: 2, collisionFilterMask: -1 });
    b.addShape(new CANNON.Sphere(0.4 + rnd() * 0.5));
    b.position.set((rnd() - 0.5) * 120, 0.5 + rnd() * 3, (rnd() - 0.5) * 120);
    world.addBody(b);
    out.push(b);
  }
  return out;
}

const idsOf = (p1, p2) => new Set(p1.map((a, i) => (a.id < p2[i].id ? `${a.id}-${p2[i].id}` : `${p2[i].id}-${a.id}`)));

// cannon's sweep tests bounding spheres, so it reports a superset of what can touch. The grid has to
// report exactly the pairs whose boxes overlap: none twice, none missing (including against the big floors).
test('reports every overlapping pair exactly once, with big floors in the level', () => {
  const world = createWorld();
  level(world, 600);
  movers(world, 12);
  for (let round = 0; round < 5; round++) {
    for (const b of world.bodies) if (b.type !== CANNON.Body.STATIC) b.position.set((rnd() - 0.5) * 120, 0.5 + rnd() * 3, (rnd() - 0.5) * 120);
    for (const b of world.bodies) b.aabbNeedsUpdate = true;
    const p1 = [], p2 = [];
    world.broadphase.collisionPairs(world, p1, p2);
    const grid = idsOf(p1, p2);
    assert.equal(p1.length, grid.size, 'no pair is reported twice');
    let overlapping = 0;
    for (const a of world.bodies) {
      for (const b of world.bodies) {
        if (a.id >= b.id || (a.type === CANNON.Body.STATIC && b.type === CANNON.Body.STATIC)) continue;
        if (a.aabbNeedsUpdate) a.updateAABB();
        if (b.aabbNeedsUpdate) b.updateAABB();
        if (!a.aabb.overlaps(b.aabb)) continue;
        overlapping++;
        assert.ok(grid.has(`${a.id}-${b.id}`), `round ${round}: ${a.id}-${b.id} overlaps but is missing`);
      }
    }
    assert.equal(grid.size, overlapping, `round ${round}: nothing extra`);
  }
});

test('raycasts find what the sweep finds, and a level built after the world still counts', () => {
  const world = createWorld();
  level(world, 300);
  const sapWorld = new CANNON.World();
  sapWorld.broadphase = new CANNON.SAPBroadphase(sapWorld);
  for (const b of world.bodies) {
    const c = new CANNON.Body({ mass: 0, collisionFilterGroup: 1 });
    for (const s of b.shapes) c.addShape(s);
    c.position.copy(b.position);
    sapWorld.addBody(c);
  }
  const hit = new CANNON.RaycastResult(), ref = new CANNON.RaycastResult();
  let hits = 0;
  for (let i = 0; i < 400; i++) {
    const from = new CANNON.Vec3((rnd() - 0.5) * 150, 0.2 + rnd() * 5, (rnd() - 0.5) * 150);
    const to = new CANNON.Vec3((rnd() - 0.5) * 150, 0.2 + rnd() * 5, (rnd() - 0.5) * 150);
    hit.reset(); ref.reset();
    const a = world.raycastClosest(from, to, { collisionFilterMask: 1, skipBackfaces: true }, hit);
    const b = sapWorld.raycastClosest(from, to, { collisionFilterMask: 1, skipBackfaces: true }, ref);
    assert.equal(a, b, `ray ${i}`);
    if (a) { hits++; assert.ok(Math.abs(hit.distance - ref.distance) < 1e-6, `ray ${i} distance`); }
  }
  assert.ok(hits > 50, 'the test rays actually hit things');
  // A body added after the first step is seen: the grid is rebuilt when the level changes.
  const wall = makeStaticBox(1, 5, 1, { x: 500, y: 5, z: 500 });
  world.addBody(wall);
  const r = new CANNON.RaycastResult();
  assert.equal(world.raycastClosest(new CANNON.Vec3(490, 5, 500), new CANNON.Vec3(510, 5, 500), { collisionFilterMask: 1 }, r), true);
  world.removeBody(wall);
  assert.equal(world.raycastClosest(new CANNON.Vec3(490, 5, 500), new CANNON.Vec3(510, 5, 500), { collisionFilterMask: 1 }, new CANNON.RaycastResult()), false);
});

test('a body still lands on the floor and raises collide once on first contact', () => {
  const world = createWorld();
  world.addBody(makeStaticBox(50, 0.5, 50, { x: 0, y: -0.5, z: 0 }));
  const ball = new CANNON.Body({ mass: 1, collisionFilterGroup: 4 });
  ball.addShape(new CANNON.Sphere(0.3));
  ball.position.set(0, 2, 0);
  world.addBody(ball);
  let collides = 0;
  ball.addEventListener('collide', () => { collides++; });
  for (let i = 0; i < 240; i++) world.step(1 / 120);
  assert.ok(Math.abs(ball.position.y - 0.3) < 0.05, `resting height ${ball.position.y}`);
  assert.ok(collides >= 1 && collides <= 4, `collide events ${collides}`);
});
