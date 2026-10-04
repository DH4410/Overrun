import { expect, test } from '@playwright/test';

import { bootGame, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * The Blender maps built after WARZONE (DEPOT, and the ones that follow it in this list). Each is
 * a script in scripts/blender/ that writes assets/maps/<id>.glb and <id>.json, and the failure
 * this file exists for is the two drifting apart, or the layout losing its symmetry.
 *
 *  - touch:     the mesh keys a player can touch; everything else (lamps, rails, decals) has no collider
 *  - castY:     where the ghost probes start, under every roof, truss and canopy of the map
 *  - modes:     the matches that must start cleanly on it
 *  - ghostStep: spacing of the collider-vs-mesh probe grid (aim for about 5-8k probes)
 *  - symStep:   spacing of the line-of-sight probe grid (aim for about 80-120 probes; every pair is compared)
 *  - flags:     true for a map with flag stands, which must sit on floor and mirror each other
 *
 * Every map here has half-turn symmetry, which the third test checks.
 */
const MAPS = [
  {
    id: 'depot',
    touch: ['cmu', 'concrete', 'floor', 'steel', 'wood', 'container', 'stucco', 'plaster'],
    castY: 6.3,
    half: [17.4, 25.4],
    ghostStep: 0.513,
    symStep: [2.973, 2.737],
    minBoxes: 60,
    minSpawns: 16,
    modes: ['duel', 'dm', 'tdm'],
  },
];

for (const M of MAPS) {
  test(`${M.id} loads, with a usable spawn set and nav graph`, async ({ page }) => {
    await bootGame(page);
    await startMatch(page, { mode: M.modes[0], map: M.id, diff: 'easy' });
    const built = await page.evaluate((id) => {
      const g = globalThis.__game;
      return {
        loaded: g.assets.maps[id],
        spawns: g.spawnPoints.length,
        nodes: g.waypoints.length,
        finite: g.spawnPoints.every((p) => [p.x, p.y, p.z].every(Number.isFinite))
          && g.waypoints.every((w) => [w.pos.x, w.pos.y, w.pos.z].every(Number.isFinite)),
        linked: g.waypoints.every((w) => w.links.length > 0),
        spawnFloors: [...new Set(g.spawnPoints.map((p) => +(p.y - 0.9).toFixed(1)))],
      };
    }, M.id);
    expect(built.loaded).toBe(true);
    expect(built.spawns).toBeGreaterThanOrEqual(M.minSpawns);
    expect(built.nodes).toBeGreaterThan(40);
    expect(built.finite).toBe(true);
    expect(built.linked).toBe(true);
    expect(built.spawnFloors).toEqual([0]);
  });

  test(`${M.id} colliders sit exactly where their meshes are`, async ({ page }) => {
    await bootGame(page);
    await page.evaluate((id) => globalThis.__game.switchMap(id), M.id);
    expect(await page.evaluate(() => globalThis.__game.currentMapId())).toBe(M.id);
    const r = await page.evaluate(async (M) => {
      const g = globalThis.__game;
      const T = g.THREE;
      const { boxes, cylinders } = await (await fetch(`assets/maps/${M.id}.json`)).json();
      const TOUCH = new Set(M.touch.map((k) => `${M.id}_${k}`));
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
      // Props are shaped nothing like their boxes and cylinders, so their footprints are left out.
      const fuzzy = (x, z) => boxes.some((b) => b[8] && inside(b, x, b[1], z, 0.15))
        || cylinders.some(([cx, , cz, rr, , , prop]) => (prop || rr > 1.2) && Math.hypot(x - cx, z - cz) < rr + 0.15);

      // 1. Every collider's top face shows a mesh at that height, looked at from just above it.
      const tops = [];
      for (const b of boxes) {
        const [x, y, z, , hy] = b;
        const top = y + hy;
        if (b[8] || top < 0.3 || top > M.castY - 0.3) continue;
        if (boxes.some((o) => o !== b && inside(o, x, top + 0.05, z))) continue;
        const vis = visualAt(x, top + 0.05, z);
        if (Math.abs(vis - top) > 0.03) tops.push({ at: [x, z], top, vis: +vis.toFixed(3) });
      }

      // 2. Nowhere on the map does one exist without the other: no invisible walls, no ghost crates.
      const ghosts = [];
      let probes = 0;
      const nameAt = (x, z) => { ray.set(new T.Vector3(x, M.castY, z), down); return ray.intersectObjects(meshes, false)[0]?.object.name; };
      const [hx, hz] = M.half;
      for (let x = -hx + 0.083; x <= hx; x += M.ghostStep) {
        for (let z = -hz + 0.117; z <= hz; z += M.ghostStep) {
          if (fuzzy(x, z)) continue;
          probes++;
          const vis = visualAt(x, M.castY, z), phys = physicsAt(x, M.castY, z);
          if (Math.abs(vis - phys) > 0.3) ghosts.push({ mesh: nameAt(x, z), at: [+x.toFixed(1), +z.toFixed(1)], vis: +vis.toFixed(2), phys: +phys.toFixed(2) });
        }
      }
      return { boxes: boxes.length, tops, ghosts, probes };
    }, M);
    expect(r.boxes).toBeGreaterThan(M.minBoxes);
    expect(r.probes).toBeGreaterThan(2000);
    expect(r.probes).toBeLessThan(16000);
    expect(r.tops, JSON.stringify(r.tops.slice(0, 5))).toEqual([]);
    expect(r.ghosts, JSON.stringify(r.ghosts.slice(0, 40))).toEqual([]);
  });

  test(`${M.id} is symmetric under a 180 degree rotation`, async ({ page }) => {
    await bootGame(page);
    await page.evaluate((id) => globalThis.__game.switchMap(id), M.id);
    expect(await page.evaluate(() => globalThis.__game.currentMapId())).toBe(M.id);
    const symmetry = await page.evaluate((M) => {
      const g = globalThis.__game;
      const probes = [];
      const [hx, hz] = M.half;
      for (let x = -hx + 0.637; x <= hx; x += M.symStep[0]) for (let z = -hz + 0.813; z <= hz; z += M.symStep[1]) probes.push([x, z]);
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
    }, M);
    expect(symmetry.checked).toBeGreaterThan(3000);
    expect(symmetry.mismatchCount, `un-mirrored geometry near ${JSON.stringify(symmetry.sample)}`).toBe(0);
    expect(symmetry.spawnsPaired).toBe(true);
  });

  for (const mode of M.modes) {
    test(`a ${mode} match on ${M.id} starts cleanly`, async ({ page }) => {
      const errors = watchRuntimeErrors(page);
      await bootGame(page);
      await startMatch(page, { mode, map: M.id, diff: 'medium' });
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
}
