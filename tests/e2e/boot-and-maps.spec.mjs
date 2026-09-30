import { expect, test } from '@playwright/test';

import { bootGame, watchRuntimeErrors } from './helpers/game.mjs';

// Registers page-error and console-error listeners BEFORE bootGame navigates, so any
// exception thrown during the real production path (game.js → src/main.js → boot() →
// buildMap() → buildWaypoints() → losClear()) is captured and the test fails
// immediately rather than timing out after 45 seconds.
test('boot reaches DEPLOY without runtime errors', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);

  const bootState = await page.evaluate(() => ({
    assets: globalThis.__game.assets,
    playLabel: document.querySelector('#play')?.textContent,
    spawnCount: globalThis.__game.spawnPoints.length,
    waypointCount: globalThis.__game.waypoints.length,
  }));

  expect(bootState.playLabel).toBe('DEPLOY');
  expect(bootState.spawnCount).toBeGreaterThan(0);
  // Waypoints prove buildWaypoints() completed — the crash site for the maps.js extraction bug.
  expect(bootState.waypointCount).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

// Every map the lobby offers, through the full production path (switchMap → buildMap() →
// buildWaypoints() → losClear()): a tile whose map is missing or fails to build would leave
// the player on the last map with no error. Each map also has a spec of its own.
test('every map in the lobby builds a usable level', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);

  const stats = await page.evaluate(() => {
    const result = {};
    for (const b of document.querySelectorAll('#maps [data-map]')) {
      const mapId = b.dataset.map;
      globalThis.__game.switchMap(mapId);
      const g = globalThis.__game;
      result[mapId] = {
        current: g.currentMapId(),
        spawns: g.spawnPoints.length,
        nodes: g.waypoints.length,
        finite: g.spawnPoints.every(({ x, y, z }) => [x, y, z].every(Number.isFinite))
          && g.waypoints.every(({ pos }) => [pos.x, pos.y, pos.z].every(Number.isFinite)),
      };
    }
    return result;
  });

  expect(Object.keys(stats).length).toBeGreaterThanOrEqual(2);
  for (const [mapId, m] of Object.entries(stats)) {
    expect(m.current, mapId).toBe(mapId);
    expect(m.spawns, mapId).toBeGreaterThanOrEqual(20);
    expect(m.nodes, mapId).toBeGreaterThan(250);
    expect(m.finite, mapId).toBe(true);
  }
  expect(errors).toEqual([]);
});
