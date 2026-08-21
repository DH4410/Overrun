import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

test('a dead bot respawns in Deathmatch', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const result = await page.evaluate(() => {
    const bot = globalThis.__game.bots[0];
    bot.die();
    bot.respawnTimer = 0;
    globalThis.__game.forceRenderTick(1 / 60);
    return { alive: bot.alive, health: bot.health };
  });

  expect(result.alive).toBe(true);
  expect(result.health).toBe(100);
});
test('Survival advances from wave one to wave two after the break', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'sv', map: 'dungeon', diff: 'easy' });

  const result = await page.evaluate(() => {
    for (const bot of globalThis.__game.bots) bot.die();
    globalThis.__game.match.waveBreak = 0.01;
    globalThis.__game.forceRenderTick(0.02);
    return {
      living: globalThis.__game.bots.filter((bot) => bot.alive).length,
      total: globalThis.__game.bots.length,
      wave: globalThis.__game.match.wave,
    };
  });

  expect(result).toEqual({ living: 6, total: 6, wave: 2 });
});
