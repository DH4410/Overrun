import { expect, test } from '@playwright/test';

import { bootGame, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * DESERT is modelled in Blender (scripts/blender/build_desert.py): the meshes come from
 * assets/maps/desert.glb and the colliders from assets/maps/desert.json. As with PORT, the
 * failure this file exists for is the two drifting apart. The movement tests pin the heights
 * the layout was designed around: 1.0 m or under is a hop, a house is a wall.
 */

test('DESERT loads, with a usable spawn set and nav graph', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'desert', diff: 'easy' });
  const built = await page.evaluate(() => {
    const g = globalThis.__game;
    return {
      loaded: g.assets.maps.desert,
      spawns: g.spawnPoints.length,
      nodes: g.waypoints.length,
      finite: g.spawnPoints.every((p) => [p.x, p.y, p.z].every(Number.isFinite))
        && g.waypoints.every((w) => [w.pos.x, w.pos.y, w.pos.z].every(Number.isFinite)),
      linked: g.waypoints.every((w) => w.links.length > 0),
      // Spawn floors: the ground. Never a roof, a well or a stall counter.
      spawnFloors: [...new Set(g.spawnPoints.map((p) => +(p.y - 0.9).toFixed(1)))],
    };
  });
  expect(built.loaded).toBe(true);
  expect(built.spawns).toBeGreaterThanOrEqual(20);
  expect(built.nodes).toBeGreaterThan(250);
  expect(built.finite).toBe(true);
  expect(built.linked).toBe(true);
  expect(built.spawnFloors).toEqual([0]);
});

test('DESERT colliders sit exactly where their meshes are', async ({ page }) => {
  await bootGame(page);
  await page.evaluate(() => globalThis.__game.switchMap('desert'));
  const r = await page.evaluate(async () => {
    const g = globalThis.__game;
    const T = g.THREE;
    const { boxes, cylinders } = await (await fetch('assets/maps/desert.json')).json();
    // Only the meshes a player can touch. Beams, cloth, fronds, lanterns, the dome, window
    // shadows, floor paving and everything past the wall have no collider; the Poly Haven props
    // are shaped nothing like their boxes and cylinders, so their footprints are left out below.
    const TOUCH = new Set(['sand', 'stone', 'plaster', 'mud', 'lime', 'wood', 'water'].map((k) => `desert_${k}`));
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
    // Props, and the palm trunks, whose ringed bark stands a few cm proud of their collider.
    const fuzzy = (x, z) => boxes.some((b) => b[8] && inside(b, x, b[1], z, 0.15))
      || cylinders.some(([cx, , cz, rr, , , prop]) => (prop || rr < 0.3) && Math.hypot(x - cx, z - cz) < rr + 0.15);

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
    //    crates. The tolerance allows for the well, whose water sits 0.2 m under its solid top.
    //    3-decimal positions, because every edge in the layout is at 2 or fewer.
    const ghosts = [];
    let probes = 0;
    for (let x = -40.917; x <= 41; x += 1.513) {
      for (let z = -30.883; z <= 31; z += 1.513) {
        if (fuzzy(x, z)) continue;
        probes++;
        const vis = visualAt(x, 9, z), phys = physicsAt(x, 9, z);
        if (Math.abs(vis - phys) > 0.3) ghosts.push({ at: [+x.toFixed(1), +z.toFixed(1)], vis: +vis.toFixed(2), phys: +phys.toFixed(2) });
      }
    }
    return { boxes: boxes.length, cylinders: cylinders.length, tops, ghosts, probes };
  });
  expect(r.boxes).toBeGreaterThan(150);
  expect(r.cylinders).toBeGreaterThan(20);
  expect(r.probes).toBeGreaterThan(2000);
  expect(r.tops, JSON.stringify(r.tops.slice(0, 5))).toEqual([]);
  expect(r.ghosts, JSON.stringify(r.ghosts.slice(0, 40))).toEqual([]);
});

test('DESERT is symmetric under a 180 degree rotation', async ({ page }) => {
  await bootGame(page);
  await page.evaluate(() => globalThis.__game.switchMap('desert'));
  const symmetry = await page.evaluate(() => {
    const g = globalThis.__game;
    const probes = [];
    // Off the round numbers the layout is built on, so no sight line runs exactly along a face
    // or through a corner, where a grazing ray can go either way on each side.
    for (let x = -38.63; x <= 39; x += 5.97) for (let z = -28.81; z <= 29; z += 6.03) probes.push([x, z]);
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
  expect(symmetry.checked).toBeGreaterThan(10000);
  expect(symmetry.mismatchCount, `un-mirrored geometry near ${JSON.stringify(symmetry.sample)}`).toBe(0);
  expect(symmetry.spawnsPaired).toBe(true);
});

for (const mode of ['tdm', 'sv', 'duel']) {
  test(`a ${mode} match on DESERT starts cleanly`, async ({ page }) => {
    const errors = watchRuntimeErrors(page);
    await bootGame(page);
    await startMatch(page, { mode, map: 'desert', diff: 'medium' });
    const r = await page.evaluate(() => {
      const g = globalThis.__game;
      globalThis.__testClock.pump(30, 1000 / 60);
      const bodies = [g.player, ...g.bots].map((c) => c.body.position.y);
      return {
        running: g.match.running,
        highest: Math.max(...bodies),
        bots: g.bots.length,
        separation: g.bots.length ? g.bots[0].pos.distanceTo(g.player.pos) : null,
      };
    });
    expect(r.running).toBe(true);
    expect(r.bots).toBeGreaterThan(0);
    expect(r.highest).toBeLessThan(3);
    if (mode === 'duel') {
      expect(r.separation).toBeGreaterThan(30);
      console.log(`duel opening separation on DESERT: ${r.separation.toFixed(1)} m`);
    }
    expect(errors).toEqual([]);
  });
}

/**
 * Each case stands the player against the obstacle, holds forward and jumps, the way a player
 * hops up onto a box.
 */
test('DESERT heights: crates and the well are a hop, houses are walls', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'desert', diff: 'easy' });
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { player, keys } = g;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    const step = (n) => { for (let i = 0; i < n; i++) g.fixedStep(1 / 120); };

    // Stand at (x, z), face yaw, hold W and jump; let go of W on landing above `releaseAt`.
    function hop(x, y, z, yaw, releaseAt) {
      player.body.position.set(x, y, z);
      player.body.velocity.set(0, 0, 0);
      player.yaw = yaw; player.pitch = 0;
      step(60);
      keys.KeyW = true;
      keys.Space = true; step(2); keys.Space = false;
      let peakFoot = 0;
      for (let i = 0; i < 240; i++) {
        step(1);
        const foot = player.body.position.y - 0.5;
        peakFoot = Math.max(peakFoot, foot);
        if (i > 10 && player.grounded && foot > releaseAt) keys.KeyW = false;   // landed on top
      }
      keys.KeyW = false;
      step(60);
      const p = player.body.position;
      return { foot: +(p.y - 0.5).toFixed(2), x: +p.x.toFixed(2), z: +p.z.toFixed(2), peakFoot: +peakFoot.toFixed(2) };
    }
    return {
      // Crate at (3.6, 17.2), 1.4 m square, 1.0 m tall; stand against its south face, face north.
      crate: hop(3.6, 0.6, 18.3, 0, 0.9),
      // The well at (-8.5, 5), 1.15 m across the rim and 0.9 m tall.
      well: hop(-8.5, 0.6, 6.6, 0, 0.8),
      // The approach house (-13..-5, 13..18.5), 6.6 m: its south face is z = 18.5.
      house: hop(-9, 0.6, 19.0, 0, 2.5),
    };
  });
  expect(r.crate.foot, JSON.stringify(r.crate)).toBeGreaterThan(0.95);
  expect(r.well.foot, JSON.stringify(r.well)).toBeGreaterThan(0.85);
  expect(r.house.foot, JSON.stringify(r.house)).toBeLessThan(0.3);
});
