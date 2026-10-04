import { expect, test } from '@playwright/test';

import { bootGame, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * WARZONE is modelled in Blender (scripts/blender/build_warzone.py): the meshes come from
 * assets/maps/warzone.glb and the colliders from assets/maps/warzone.json. The failure this file
 * exists for is the two drifting apart, and the layout losing its half-turn symmetry.
 */

test('WARZONE loads, with a usable spawn set and nav graph', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warzone', diff: 'easy' });
  const built = await page.evaluate(() => {
    const g = globalThis.__game;
    return {
      loaded: g.assets.maps.warzone,
      spawns: g.spawnPoints.length,
      nodes: g.waypoints.length,
      finite: g.spawnPoints.every((p) => [p.x, p.y, p.z].every(Number.isFinite))
        && g.waypoints.every((w) => [w.pos.x, w.pos.y, w.pos.z].every(Number.isFinite)),
      linked: g.waypoints.every((w) => w.links.length > 0),
      // Spawn floors: the ground or a floor slab. Never a roof, a berm or a crate.
      spawnFloors: [...new Set(g.spawnPoints.map((p) => +(p.y - 0.9).toFixed(1)))],
    };
  });
  expect(built.loaded).toBe(true);
  expect(built.spawns).toBeGreaterThanOrEqual(40);
  expect(built.nodes).toBeGreaterThan(600);
  expect(built.finite).toBe(true);
  expect(built.linked).toBe(true);
  expect(built.spawnFloors).toEqual([0]);
});

test('WARZONE colliders sit exactly where their meshes are', async ({ page }) => {
  await bootGame(page);
  await page.evaluate(() => globalThis.__game.switchMap('warzone'));
  expect(await page.evaluate(() => globalThis.__game.currentMapId())).toBe('warzone');
  const r = await page.evaluate(async () => {
    const g = globalThis.__game;
    const T = g.THREE;
    const { boxes, cylinders } = await (await fetch('assets/maps/warzone.json')).json();
    // Only the meshes a player can touch. Fascia rails, wall units, lamp arms, the mast lattice,
    // fir needles, decals and everything past the fence have no collider; the Poly Haven props
    // are shaped nothing like their boxes and cylinders, so their footprints are left out below.
    const TOUCH = new Set(['ground', 'brick', 'stucco', 'cmu', 'plaster', 'concrete', 'roof', 'rubble', 'steel', 'wood', 'container', 'sand']
      .map((k) => `warzone_${k}`));
    const meshes = [];
    g.mapGroup.traverse((o) => { if (o.isMesh && TOUCH.has(o.name)) meshes.push(o); });
    const ray = new T.Raycaster();
    const down = new T.Vector3(0, -1, 0);
    const visualAt = (x, y, z) => {
      ray.set(new T.Vector3(x, y, z), down);
      const hit = ray.intersectObjects(meshes, false)[0];
      return hit ? hit.point.y : -1;
    };
    const V = g.world.gravity.constructor;
    const physicsAt = (x, y, z) => {
      let top = -1;
      g.world.raycastAll(new V(x, y, z), new V(x, -1, z), { skipBackfaces: true }, (res) => {
        if (res.body.mass === 0) top = Math.max(top, res.hitPointWorld.y);
      });
      return top;
    };
    const inside = (b, x, y, z, pad = 0) => {
      const [cx, cy, cz, hx, hy, hz, yaw] = b;
      const dx = x - cx, dz = z - cz, c = Math.cos(yaw), s = Math.sin(yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      return Math.abs(lx) <= hx + pad && Math.abs(y - cy) <= hy && Math.abs(lz) <= hz + pad;
    };
    // Props (firs and mast legs included), and the fuel tanks, whose snow cones rise above the
    // top of their cylinders.
    const fuzzy = (x, z) => boxes.some((b) => b[8] && inside(b, x, b[1], z, 0.15))
      || cylinders.some(([cx, , cz, rr, , , prop]) => (prop || rr > 1.2) && Math.hypot(x - cx, z - cz) < rr + 0.15);

    // 1. Every collider's top face shows a mesh at that height, looked at from just above it.
    const tops = [];
    for (const b of boxes) {
      const [x, y, z, , hy] = b;
      const top = y + hy;
      if (b[8] || top < 0.3 || top > 9) continue;                  // props, the ground
      if (boxes.some((o) => o !== b && inside(o, x, top + 0.05, z))) continue;   // something on it
      const vis = visualAt(x, top + 0.05, z);
      if (Math.abs(vis - top) > 0.03) tops.push({ at: [x, z], top, vis: +vis.toFixed(3) });
    }

    // 2. Nowhere on the map does one exist without the other: no invisible walls, no ghost
    //    crates. 3-decimal positions, because every edge in the layout is at 2 or fewer.
    const ghosts = [];
    let probes = 0;
    const nameAt = (x, z) => { ray.set(new T.Vector3(x, 9, z), down); return ray.intersectObjects(meshes, false)[0]?.object.name; };
    for (let x = -68.917; x <= 69; x += 1.513) {
      for (let z = -48.883; z <= 49; z += 1.513) {
        if (fuzzy(x, z)) continue;
        probes++;
        const vis = visualAt(x, 9, z), phys = physicsAt(x, 9, z);
        if (Math.abs(vis - phys) > 0.3) ghosts.push({ mesh: nameAt(x, z), at: [+x.toFixed(1), +z.toFixed(1)], vis: +vis.toFixed(2), phys: +phys.toFixed(2) });
      }
    }
    return { boxes: boxes.length, cylinders: cylinders.length, tops, ghosts, probes };
  });
  expect(r.boxes).toBeGreaterThan(500);
  expect(r.cylinders).toBeGreaterThan(20);
  expect(r.probes).toBeGreaterThan(5000);
  expect(r.tops, JSON.stringify(r.tops.slice(0, 5))).toEqual([]);
  expect(r.ghosts, JSON.stringify(r.ghosts.slice(0, 40))).toEqual([]);
});

test('WARZONE is symmetric under a 180 degree rotation', async ({ page }) => {
  await bootGame(page);
  await page.evaluate(() => globalThis.__game.switchMap('warzone'));
  expect(await page.evaluate(() => globalThis.__game.currentMapId())).toBe('warzone');
  const symmetry = await page.evaluate(() => {
    const g = globalThis.__game;
    const probes = [];
    // Off the round numbers the layout is built on, so no sight line runs exactly along a face
    // or through a corner, where a grazing ray can go either way on each side.
    for (let x = -66.637; x <= 67; x += 7.973) for (let z = -46.813; z <= 47; z += 7.037) probes.push([x, z]);
    const y = 1.7;
    let checked = 0;
    const mismatches = [];
    for (const [ax, az] of probes) {
      for (const [bx, bz] of probes) {
        if (ax === bx && az === bz) continue;
        checked++;
        if (g.losClear(ax, y, az, bx, y, bz) !== g.losClear(-ax, y, -az, -bx, y, -bz)) mismatches.push([ax, az, bx, bz]);
      }
    }
    const pts = g.spawnPoints.map((p) => [Math.round(p.x), Math.round(p.z)]);
    const has = (x, z) => pts.some(([px, pz]) => Math.abs(px - x) < 1.5 && Math.abs(pz - z) < 1.5);
    return { checked, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5), spawnsPaired: pts.every(([x, z]) => has(-x, -z)) };
  });
  expect(symmetry.checked).toBeGreaterThan(5000);
  expect(symmetry.mismatchCount, `un-mirrored geometry near ${JSON.stringify(symmetry.sample)}`).toBe(0);
  expect(symmetry.spawnsPaired).toBe(true);
});

for (const mode of ['dm', 'tdm']) {
  test(`a ${mode} match on WARZONE starts cleanly`, async ({ page }) => {
    const errors = watchRuntimeErrors(page);
    await bootGame(page);
    await startMatch(page, { mode, map: 'warzone', diff: 'medium' });
    const r = await page.evaluate(() => {
      const g = globalThis.__game;
      globalThis.__testClock.pump(30, 1000 / 60);
      const bodies = [g.player, ...g.bots].map((c) => c.body.position.y);
      return { running: g.match.running, highest: Math.max(...bodies), bots: g.bots.length };
    });
    expect(r.running).toBe(true);
    expect(r.bots).toBeGreaterThan(0);
    expect(r.highest).toBeLessThan(3);
    expect(errors).toEqual([]);
  });
}
