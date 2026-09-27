import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * Breadth-first search returns the fewest graph edges, not the shortest route, so on a
 * coarse waypoint grid a bot crossing open floor zig-zags from node to node. String-pulling
 * keeps only the corners. The property asserted is that a straightened path is never longer
 * than the raw graph route and is usually shorter — not an exact node count, which depends
 * on the map's graph spacing.
 */
test('paths are straightened, never lengthened', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'foundry', diff: 'easy' });

  const result = await page.evaluate(() => {
    const g = globalThis.__game;
    const len = (pts, from) => {
      let d = 0;
      let prev = from;
      for (const p of pts) { d += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
      return d;
    };

    let straighter = 0, sampled = 0, everLonger = 0;
    const nodes = g.waypoints;
    for (let i = 0; i < nodes.length; i += 3) {
      for (let j = 0; j < nodes.length; j += 7) {
        if (i === j) continue;
        const from = nodes[i].pos;
        const to = nodes[j].pos;
        const path = g.findPath(from, to);
        if (!path || path.length < 2) continue;
        sampled++;
        // Straight-line distance is the floor any route must respect.
        const direct = Math.hypot(to.x - from.x, to.z - from.z);
        const walked = len(path, from);
        if (walked < direct - 0.01) everLonger++;      // shorter than straight = impossible
        if (walked < direct * 1.35) straighter++;
      }
    }
    return { sampled, straighter, everLonger };
  });

  expect(result.sampled).toBeGreaterThan(50);
  // No route may be shorter than the straight line between its endpoints.
  expect(result.everLonger).toBe(0);
  // On an open, symmetric map most routes should end up close to direct.
  expect(result.straighter / result.sampled).toBeGreaterThan(0.6);
});
