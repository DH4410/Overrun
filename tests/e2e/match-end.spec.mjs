import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

/**
 * Nothing on any screen may show a scrollbar. Headless Chromium hides scrollbars itself, so
 * measuring their width proves nothing; instead every box that actually overflows and can
 * scroll must have its bar turned off, and the page itself must not scroll.
 */
async function scrollbarOffenders(page) {
  return page.evaluate(() => {
    const out = [];
    for (const e of [document.documentElement, document.body, ...document.querySelectorAll('body *')]) {
      const cs = getComputedStyle(e);
      const scrollsY = /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1;
      const scrollsX = /(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1;
      if ((scrollsY || scrollsX) && cs.scrollbarWidth !== 'none') out.push(e.id || e.className || e.tagName);
    }
    if (document.documentElement.scrollHeight > innerHeight + 1) out.push('page');
    return out;
  });
}

test('winning plays a slowed outro under VICTORY, then the podium with you on top', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const start = await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.kills = g.CONFIG.DM_TARGET - 1;
    const bot = g.bots[0];
    bot.health = 0;
    g.killCombatant(bot, g.player, false);
    const other = g.bots[1];
    const hp = other.health;
    return { running: g.match.running, outro: !!g.match.outro, bot: other.name, hp };
  });
  expect(start).toMatchObject({ running: false, outro: true });
  await expect(page.locator('#outro')).toHaveClass(/\bon\b/);
  await expect(page.locator('#o-title')).toHaveText('VICTORY');
  await expect(page.locator('#menu')).toHaveClass(/\bhidden\b/);   // still in the world

  // Two seconds in: still the outro, nobody takes damage.
  await pumpFrames(page, 120);
  const mid = await page.evaluate(() => {
    const g = globalThis.__game;
    return { outro: !!g.match.outro, hp: g.bots[1].health };
  });
  expect(mid.outro).toBe(true);
  expect(mid.hp).toBe(start.hp);

  // Past five seconds of real time: the podium over the lobby.
  await pumpFrames(page, 200);
  await expect(page.locator('#podium')).toHaveClass(/\bon\b/);
  await expect(page.locator('#menu')).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator('#outro')).not.toHaveClass(/\bon\b/);
  await expect(page.locator('.pd-place.p1')).toHaveClass(/\bself\b/);
  const sizes = await page.evaluate(() => ({
    p1: parseFloat(getComputedStyle(document.querySelector('.pd-place.p1 .pd-name')).fontSize),
    p2: parseFloat(getComputedStyle(document.querySelector('.pd-place.p2 .pd-name')).fontSize),
  }));
  expect(sizes.p1).toBeGreaterThan(sizes.p2);
  expect(await page.locator('#menuresult').textContent()).toContain('VICTORY');

  await page.click('#podium-close');
  await expect(page.locator('#podium')).not.toHaveClass(/\bon\b/);
});

test('leaving from the pause screen skips the outro', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  await page.evaluate(() => document.getElementById('quit-match').click());
  await expect(page.locator('#menu')).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator('#outro')).not.toHaveClass(/\bon\b/);
  await expect(page.locator('#podium')).not.toHaveClass(/\bon\b/);
});

test('while you wait to respawn, the standings show your place', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.bots[0].kills = 3; g.bots[1].kills = 1;
    g.player.kills = 2;
    g.player.health = 0;
    g.killCombatant(g.player, g.bots[0], false);
  });
  await pumpFrames(page, 3);
  await expect(page.locator('#pause')).toHaveClass(/\bdead\b/);
  await expect(page.locator('#p-board')).toBeVisible();
  await expect(page.locator('.pb-place')).toHaveText('YOU ARE #2 OF ' + await page.evaluate(() => globalThis.__game.bots.length + 1));
  await expect(page.locator('.pb-row.self')).toHaveCount(1);

  // Respawned: the board goes away.
  await pumpFrames(page, 60 * 5);
  await expect(page.locator('#pause')).not.toHaveClass(/\bdead\b/);
});

for (const [w, h] of [[1280, 720], [800, 450]]) {
  test(`no scrollbars at ${w}x${h}: lobby, settings, locker, after a match`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await bootGame(page);
    expect(await scrollbarOffenders(page)).toEqual([]);
    await page.click('#settings-open');
    expect(await scrollbarOffenders(page)).toEqual([]);
    await page.click('#settings-close');
    await page.click('#locker-open');
    expect(await scrollbarOffenders(page)).toEqual([]);
    await page.click('#locker-close');

    await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'hard' });
    await page.evaluate(() => {
      const g = globalThis.__game;
      g.bots.forEach((b, i) => { b.kills = 10 - i; b.deaths = i; });
      g.bots[0].kills = g.CONFIG.DM_TARGET - 1;
      g.player.health = 0;
      g.killCombatant(g.player, g.bots[0], false);
    });
    await pumpFrames(page, 330);
    await expect(page.locator('#podium')).toHaveClass(/\bon\b/);
    expect(await scrollbarOffenders(page)).toEqual([]);
    // The podium has to fit: its button must be on screen.
    const btn = await page.locator('#podium-close').boundingBox();
    expect(btn.y + btn.height).toBeLessThanOrEqual(h);
    await page.click('#podium-close');
    expect(await scrollbarOffenders(page)).toEqual([]);
  });
}
