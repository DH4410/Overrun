import { expect, test } from '@playwright/test';

import { APP_STATE, bootGame, observedAppState, startMatch } from './helpers/game.mjs';

test('a dead bot respawns in Deathmatch', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const result = await page.evaluate(() => {
    const bot = globalThis.__game.bots[0];
    const api = {
      legacyUpdate: typeof bot.update,
      renderStep: typeof bot.renderStep,
      simStep: typeof bot.simStep,
    };
    bot.die();
    bot.respawnTimer = 0;
    bot.simStep(1 / 120);
    bot.renderStep(1 / 60);
    globalThis.__game.forceRenderTick(1 / 60);
    return { alive: bot.alive, health: bot.health, api };
  });

  expect(result.alive).toBe(true);
  expect(result.health).toBe(100);
  expect(result.api).toEqual({ legacyUpdate: 'undefined', renderStep: 'function', simStep: 'function' });
});

test('Deathmatch HUD and time-limit result use the canonical leader', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const result = await page.evaluate(() => {
    const game = globalThis.__game;
    game.player.kills = 7;
    game.bots.forEach((bot, index) => { bot.kills = [2, 7, 4][index] ?? 0; });
    game.forceRenderTick(0);
    const hudLeader = document.querySelector('#tb-b').textContent;
    game.match.timeLeft = 0.01;
    game.forceRenderTick(0.02);
    for (let i = 0; i < 24; i++) game.forceRenderTick(0.25);   // the 5 s outro
    return {
      hudLeader,
      result: document.querySelector('#menuresult').textContent,
      running: game.match.running,
    };
  });

  expect(result.hudLeader).toBe('7');
  expect(result.running).toBe(false);
  expect(result.result).toContain('TIME — DRAW');
  expect(result.result).toContain('Tied at 7 kills');
  expect(await observedAppState(page)).toBe(APP_STATE.MENU);
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
