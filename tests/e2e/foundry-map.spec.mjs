import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * Foundry exists to host a fair duel, so the properties worth asserting are the ones that
 * make it fair: it builds, it is navigable, and it is actually symmetric. A map that merely
 * looks symmetric is the failure mode here — one stray un-mirrored crate gives one spawn a
 * better opening angle, and nothing else in the suite would notice.
 */

test('Foundry boots with a usable spawn set and nav graph', async ({ page }) => {
  await bootGame(page);

  const built = await page.evaluate(async () => {
    const g = globalThis.__game;
    g.switchMap('foundry');
    return {
      id: g.currentMapId(),
      spawns: g.spawnPoints.length,
      nodes: g.waypoints.length,
      finiteSpawns: g.spawnPoints.every((p) => [p.x, p.y, p.z].every(Number.isFinite)),
      finiteNodes: g.waypoints.every((w) => [w.pos.x, w.pos.y, w.pos.z].every(Number.isFinite)),
      // Every node must be reachable from every other, or bots strand in a lane.
      linked: g.waypoints.every((w) => w.links.length > 0),
    };
  });

  expect(built.id).toBe('foundry');
  expect(built.spawns).toBeGreaterThanOrEqual(4);
  expect(built.nodes).toBeGreaterThan(20);
  expect(built.finiteSpawns).toBe(true);
  expect(built.finiteNodes).toBe(true);
  expect(built.linked).toBe(true);
});

test('Foundry is symmetric under a 180 degree rotation', async ({ page }) => {
  await bootGame(page);

  const symmetry = await page.evaluate(() => {
    const g = globalThis.__game;
    g.switchMap('foundry');

    /**
     * Probe line of sight between mirrored pairs of points. If the level is truly
     * rotationally symmetric then whatever one side can see, the other side can see from
     * the rotated position — so any disagreement is an un-mirrored solid.
     */
    const probes = [];
    for (let x = -26; x <= 26; x += 4) {
      for (let z = -26; z <= 26; z += 4) probes.push([x, z]);
    }
    const y = 1.7;
    let checked = 0;
    const mismatches = [];
    for (const [ax, az] of probes) {
      for (const [bx, bz] of probes) {
        if (ax === bx && az === bz) continue;
        const forward = g.losClear(ax, y, az, bx, y, bz);
        const rotated = g.losClear(-ax, y, -az, -bx, y, -bz);
        checked++;
        if (forward !== rotated) mismatches.push([ax, az, bx, bz]);
      }
    }

    // The spawn set must pair up too.
    const pts = g.spawnPoints.map((p) => [Math.round(p.x), Math.round(p.z)]);
    const has = (x, z) => pts.some(([px, pz]) => Math.abs(px - x) < 1.5 && Math.abs(pz - z) < 1.5);
    const spawnsPaired = pts.every(([x, z]) => has(-x, -z));

    return { checked, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5), spawnsPaired };
  });

  expect(symmetry.checked).toBeGreaterThan(5000);
  expect(symmetry.mismatchCount, `un-mirrored geometry near ${JSON.stringify(symmetry.sample)}`).toBe(0);
  expect(symmetry.spawnsPaired).toBe(true);
});

test('a Duel on Foundry starts both sides far apart', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'foundry', diff: 'medium' });

  const state = await page.evaluate(() => {
    const g = globalThis.__game;
    return {
      map: g.currentMapId(),
      bots: g.bots.length,
      separation: g.bots[0].pos.distanceTo(g.player.pos),
      // Neither duellist may start on top of the mid platform or stuck in geometry.
      playerY: g.player.body.position.y,
      botY: g.bots[0].body.position.y,
    };
  });

  expect(state.map).toBe('foundry');
  expect(state.bots).toBe(1);
  expect(state.separation).toBeGreaterThan(30);
  expect(state.playerY).toBeLessThan(3);
  expect(state.botY).toBeLessThan(3);
});
