import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

async function winDeathmatch(page) {
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.kills = g.CONFIG.DM_TARGET - 1;
    const bot = g.bots[0];
    bot.health = 0;
    g.killCombatant(bot, g.player, true);
  });
  await pumpFrames(page, 400);
}

test('a finished match pays XP into the saved career and the lobby card shows it', async ({ page }) => {
  await bootGame(page);
  await expect(page.locator('#pc-level')).toHaveText('1');
  await expect(page.locator('#pc-xpt')).toHaveText('0 / 250 XP');

  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await winDeathmatch(page);

  const profile = await page.evaluate(() => JSON.parse(localStorage.getItem('overrun.profile')));
  expect(profile.matches).toBe(1);
  expect(profile.wins).toBe(1);
  expect(profile.headshots).toBe(1);
  expect(profile.xp).toBeGreaterThan(150);
  await expect(page.locator('#pd-xp')).toHaveClass(/\bon\b/);
  await expect(page.locator('#pd-xplines .xp-line.total')).toContainText('+');
});

test('leaving a match from the pause screen pays nothing', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => document.getElementById('quit-match').click());
  await expect(page.locator('#menu')).toBeVisible();
  const raw = await page.evaluate(() => localStorage.getItem('overrun.profile'));
  expect(raw).toBeNull();
});

test('kills inside four seconds chain into medals, and dying resets the streak', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  const medals = await page.evaluate(() => {
    const g = globalThis.__game;
    const out = [];
    for (let i = 0; i < 3; i++) { g.killCombatant(g.bots[i], g.player, false); out.push(g.match.medal); }
    const streak = g.match.streak;
    g.killCombatant(g.player, g.bots[3], false);
    return { out, streak, after: g.match.streak };
  });
  expect(medals.out).toEqual(['', 'DOUBLE KILL', 'TRIPLE KILL']);
  expect(medals.streak).toBe(3);
  expect(medals.after).toBe(0);
});
