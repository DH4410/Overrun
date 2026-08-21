import { expect, test } from '@playwright/test';

import { bootGame, watchRuntimeErrors } from './helpers/game.mjs';

test('boot reaches DEPLOY without runtime errors', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);

  const bootState = await page.evaluate(() => ({
    assets: globalThis.__game.assets,
    playLabel: document.querySelector('#play')?.textContent,
    spawnCount: globalThis.__game.spawnPoints.length,
  }));

  expect(bootState.playLabel).toBe('DEPLOY');
  expect(bootState.spawnCount).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
test('Warehouse and Dungeon both expose finite spawns and navigation nodes', async ({ page }) => {
  await bootGame(page);

  const stats = await page.evaluate(() => {
    const result = {};
    for (const mapId of ['warehouse', 'dungeon']) {
      globalThis.__game.switchMap(mapId);
      const spawns = globalThis.__game.spawnPoints.map(({ x, y, z, team }) => ({ x, y, z, team }));
      const nodes = globalThis.__game.waypoints.map(({ pos }) => ({ x: pos.x, y: pos.y, z: pos.z }));
      result[mapId] = {
        current: globalThis.__game.currentMapId(),
        spawns,
        nodes,
      };
    }
    return result;
  });

  for (const mapId of ['warehouse', 'dungeon']) {
    expect(stats[mapId].current).toBe(mapId);
    expect(stats[mapId].spawns.length).toBeGreaterThanOrEqual(4);
    expect(stats[mapId].nodes.length).toBeGreaterThanOrEqual(4);
    expect(stats[mapId].spawns.every(({ x, y, z }) => [x, y, z].every(Number.isFinite))).toBe(true);
    expect(stats[mapId].nodes.every(({ x, y, z }) => [x, y, z].every(Number.isFinite))).toBe(true);
  }
});
