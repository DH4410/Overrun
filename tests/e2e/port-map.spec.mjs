import { expect, test } from '@playwright/test';

import { bootGame, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * PORT is modelled in Blender (scripts/blender/build_port.py): the meshes come from
 * assets/maps/port.glb and the colliders from assets/maps/port.json. The failure this file
 * exists for is the two drifting apart, so that a player bumps into air or walks through a
 * crate. The movement tests pin the heights the layout was designed around.
 */

test('PORT is the default map, with a usable spawn set and nav graph', async ({ page }) => {
  await bootGame(page);
  const built = await page.evaluate(() => {
    const g = globalThis.__game;
    return {
      loaded: g.assets.port,
      id: g.currentMapId(),
      spawns: g.spawnPoints.length,
      nodes: g.waypoints.length,
      finite: g.spawnPoints.every((p) => [p.x, p.y, p.z].every(Number.isFinite))
        && g.waypoints.every((w) => [w.pos.x, w.pos.y, w.pos.z].every(Number.isFinite)),
      linked: g.waypoints.every((w) => w.links.length > 0),
      // Spawn floors: the ground, or the dock. Never a roof or the top of a container.
      spawnFloors: [...new Set(g.spawnPoints.map((p) => +(p.y - 0.9).toFixed(1)))],
    };
  });
  expect(built.loaded).toBe(true);
  expect(built.id).toBe('port');
  expect(built.spawns).toBeGreaterThanOrEqual(16);
  expect(built.nodes).toBeGreaterThan(300);
  expect(built.finite).toBe(true);
  expect(built.linked).toBe(true);
  expect(built.spawnFloors).toEqual([0]);
});

test('PORT colliders sit exactly where their meshes are', async ({ page }) => {
  await bootGame(page);
  const r = await page.evaluate(async () => {
    const g = globalThis.__game;
    const T = g.THREE;
    const { boxes } = await (await fetch('assets/maps/port.json')).json();
    // Only the meshes a player can touch; floor paint, lamps and the backdrop have no collider.
    const SKIP = new Set(['port_far', 'port_water', 'port_lines', 'port_linesW', 'port_lamp', 'port_slab']);
    const meshes = [];
    g.mapGroup.traverse((o) => { if (o.isMesh && o.name.startsWith('port_') && !SKIP.has(o.name)) meshes.push(o); });
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
    const inside = (b, x, y, z) => {
      const [cx, cy, cz, hx, hy, hz, yaw] = b;
      const dx = x - cx, dz = z - cz, c = Math.cos(yaw), s = Math.sin(yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      return Math.abs(lx) <= hx && Math.abs(y - cy) <= hy && Math.abs(lz) <= hz;
    };

    // 1. Every collider's top face shows a mesh at that height, looked at from just above it.
    const tops = [];
    for (const b of boxes) {
      const [x, y, z, , hy] = b;
      const top = y + hy;
      if (top < 0.3 || top > 6.5) continue;                       // the ground, masts, crane legs
      if (boxes.some((o) => o !== b && inside(o, x, top + 0.05, z))) continue;   // something on it
      const vis = visualAt(x, top + 0.05, z);
      if (Math.abs(vis - top) > 0.03) tops.push({ at: [x, z], top, vis: +vis.toFixed(3) });
    }

    // 2. Nowhere on the map does one exist without the other: no invisible walls, no ghost
    //    crates. The tolerance allows for the jersey barriers' sloped sides over their boxes.
    //    The grid sits at 3-decimal positions because every edge in the layout is at 2, and a
    //    probe exactly on an edge can hit on one side and miss on the other.
    const ghosts = [];
    let probes = 0;
    for (let x = -48.917; x <= 49; x += 1.713) {
      for (let z = -36.883; z <= 37; z += 1.713) {
        probes++;
        const vis = visualAt(x, 6.5, z), phys = physicsAt(x, 6.5, z);
        if (Math.abs(vis - phys) > 0.3) ghosts.push({ at: [+x.toFixed(1), +z.toFixed(1)], vis: +vis.toFixed(2), phys: +phys.toFixed(2) });
      }
    }
    return { boxes: boxes.length, tops, ghosts, probes };
  });
  expect(r.boxes).toBeGreaterThan(150);
  expect(r.probes).toBeGreaterThan(2000);
  expect(r.tops, JSON.stringify(r.tops.slice(0, 5))).toEqual([]);
  expect(r.ghosts, JSON.stringify(r.ghosts.slice(0, 40))).toEqual([]);
});

test('PORT is symmetric under a 180 degree rotation', async ({ page }) => {
  await bootGame(page);
  const symmetry = await page.evaluate(() => {
    const g = globalThis.__game;
    const probes = [];
    // Off the round numbers the layout is built on, so no sight line runs exactly along a face
    // or through a corner, where a grazing ray can go either way on each side.
    for (let x = -44.63; x <= 45; x += 5.97) for (let z = -32.81; z <= 33; z += 6.03) probes.push([x, z]);
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
  expect(symmetry.checked).toBeGreaterThan(20000);
  expect(symmetry.mismatchCount, `un-mirrored geometry near ${JSON.stringify(symmetry.sample)}`).toBe(0);
  expect(symmetry.spawnsPaired).toBe(true);
});

/**
 * PORT is the default map, so every mode lands on it; the route and height tests above only
 * run deathmatch. Each mode must start cleanly with nobody spawned on a roof, and a duel must
 * open with the two sides apart.
 */
for (const mode of ['tdm', 'sv', 'duel']) {
  test(`a ${mode} match on PORT starts cleanly`, async ({ page }) => {
    const errors = watchRuntimeErrors(page);
    await bootGame(page);
    await startMatch(page, { mode, map: 'port', diff: 'medium' });
    const r = await page.evaluate(() => {
      const g = globalThis.__game;
      globalThis.__testClock.pump(30, 1000 / 60);
      const bodies = [g.player, ...g.bots].map((c) => c.body.position.y);
      return {
        running: g.match.running,
        map: g.currentMapId(),
        highest: Math.max(...bodies),
        bots: g.bots.length,
        separation: g.bots.length ? g.bots[0].pos.distanceTo(g.player.pos) : null,
      };
    });
    expect(r.running).toBe(true);
    expect(r.map).toBe('port');
    expect(r.bots).toBeGreaterThan(0);
    expect(r.highest).toBeLessThan(3);
    if (mode === 'duel') {
      expect(r.separation).toBeGreaterThan(30);
      console.log(`duel opening separation on PORT: ${r.separation.toFixed(1)} m`);
    }
    expect(errors).toEqual([]);
  });
}

/**
 * The heights are the point of the layout: a 1.0 m crate is a hop, the 1.4 m dock is not
 * (except from the crate beside it), and a 2.59 m container is a wall. Each case stands the
 * player against the obstacle, holds forward and jumps, the way a player hops up onto a box.
 */
test('PORT heights: crates are a hop, the dock needs a crate, containers are walls', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { player, keys } = g;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    const step = (n) => { for (let i = 0; i < n; i++) g.fixedStep(1 / 120); };

    // Stand at (x, z), face yaw, hold W and jump; let go of W on landing above `releaseAt`.
    function hop(x, y, z, yaw, releaseAt, runUp = 0) {
      player.body.position.set(x, y, z);
      player.body.velocity.set(0, 0, 0);
      player.yaw = yaw; player.pitch = 0;
      step(60);
      keys.KeyW = true;
      step(runUp);
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
      // Crate at (2.4, 22.4), 1.4 m square, 1.0 m tall; stand against its south face, face north.
      crate: hop(2.4, 0.6, 23.5, 0, 0.9),
      // The dock's west face is x = -8; from the ground it is out of reach.
      dockFromGround: hop(-8.5, 0.6, -1.5, -Math.PI / 2, 1.3),
      // The crate beside the dock (x -10 .. -8.6, top 1.0): run off its east edge onto the dock.
      dockFromCrate: hop(-9.7, 1.6, 2.0, -Math.PI / 2, 1.3, 30),
      // Container at (-5, 19.5), lying along X: its south face is z = 20.72.
      container: hop(-5, 0.6, 21.2, 0, 2.5),
    };
  });
  expect(r.crate.foot, JSON.stringify(r.crate)).toBeGreaterThan(0.95);
  expect(r.dockFromGround.foot, JSON.stringify(r.dockFromGround)).toBeLessThan(0.3);
  expect(r.dockFromCrate.foot, JSON.stringify(r.dockFromCrate)).toBeGreaterThan(1.35);
  expect(r.dockFromCrate.x).toBeGreaterThan(-8);
  expect(r.container.foot, JSON.stringify(r.container)).toBeLessThan(0.3);
});
