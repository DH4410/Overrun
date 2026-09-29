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

// Clean-boot coverage for Warehouse and Dungeon: verifies the full production path
// (game.js → src/main.js → boot() → buildMap() → buildWaypoints()) succeeds for both
// maps and that losClear() returns valid nav-graph data. PORT, the default boot map, has
// its own coverage in port-map.spec.mjs.
test('Warehouse clean boot: reaches DEPLOY and has valid nav graph', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);

  const stats = await page.evaluate(() => {
    globalThis.__game.switchMap('warehouse');
    return {
      mapId: globalThis.__game.currentMapId(),
      spawns: globalThis.__game.spawnPoints.length,
      waypoints: globalThis.__game.waypoints.length,
      allFinite: globalThis.__game.spawnPoints.every(({ x, y, z }) => [x, y, z].every(Number.isFinite)),
    };
  });

  expect(stats.mapId).toBe('warehouse');
  expect(stats.spawns).toBeGreaterThanOrEqual(4);
  expect(stats.waypoints).toBeGreaterThanOrEqual(4);
  expect(stats.allFinite).toBe(true);
  expect(errors).toEqual([]);
});

test('Dungeon clean boot: switchMap reaches ready state with valid nav graph', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);

  const stats = await page.evaluate(() => {
    globalThis.__game.switchMap('dungeon');
    return {
      mapId: globalThis.__game.currentMapId(),
      spawns: globalThis.__game.spawnPoints.length,
      waypoints: globalThis.__game.waypoints.length,
      allFinite: globalThis.__game.spawnPoints.every(({ x, y, z }) => [x, y, z].every(Number.isFinite)),
    };
  });

  expect(stats.mapId).toBe('dungeon');
  expect(stats.spawns).toBeGreaterThanOrEqual(4);
  expect(stats.waypoints).toBeGreaterThanOrEqual(4);
  expect(stats.allFinite).toBe(true);
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
