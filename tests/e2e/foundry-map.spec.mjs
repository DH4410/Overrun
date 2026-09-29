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

/**
 * Mid has to be walkable, and nothing else here would notice if it were not.
 *
 * The first cut of this map ran a single 13 m cover lip along the platform edge, which put
 * a one-metre wall exactly across the top of both ramps. The layout stayed perfectly
 * symmetric, so the symmetry test passed; every nav node still had a link, so the boot test
 * passed; and mid was simply unreachable — fatal on a map whose whole shape is built around
 * contesting it, and worse for bots, which cannot jump.
 */
test('the mid platform can be walked up from the ramp', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'foundry', diff: 'easy' });

  const climb = await page.evaluate(async () => {
    const g = globalThis.__game;
    // Foot of the +Z ramp, facing the platform. The ramp runs x = 2.6, z = 12.5 -> 6.0.
    g.player.body.position.set(2.6, 1.0, 12.0);
    g.player.body.velocity.set(0, 0, 0);
    g.player.yaw = 0;              // forward is (-sin, -cos), so yaw 0 faces -Z, toward mid
    g.player.pitch = 0;
    g.player.invulnTimer = Number.POSITIVE_INFINITY;
    g.fixedStep(1 / 120);

    const startY = g.player.body.position.y;
    g.keys.KeyW = true;
    let peakY = startY;
    for (let i = 0; i < 300; i++) {          // 2.5 s at the fixed step
      g.fixedStep(1 / 120);
      peakY = Math.max(peakY, g.player.body.position.y);
    }
    g.keys.KeyW = false;
    return {
      startY,
      peakY,
      endY: g.player.body.position.y,
      endZ: g.player.body.position.z,
    };
  });

  /**
   * Assert arrival ON the platform, not merely progress up the ramp.
   *
   * Height alone is not enough: the ramp already reaches y ~= 1.37 by the time it meets the
   * lip at z = 6.55, so a "peak height > 1.3" check passes with the ramp mouth completely
   * walled off. Verified by restoring the blocking lip — that version still passed. The
   * test has to require crossing z = 6 onto the deck.
   */
  expect(climb.endZ).toBeLessThan(5.0);      // past the lip, standing on the platform
  expect(climb.endY).toBeGreaterThan(1.4);   // and at platform height, not back on the floor
});
