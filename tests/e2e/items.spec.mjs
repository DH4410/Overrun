import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * Healing items in single player: the same channel rules as the server (tests/unit/mp-items).
 * One tap asks for the item, it heals when the bar fills, and anything that takes your hands
 * (a shot) loses the progress but not the item.
 */
async function setup(page) {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => {
    const g = globalThis.__game;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    g.step = (n) => { for (let i = 0; i < n; i++) g.fixedStep(1 / 120); };
    g.press = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code })); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
    g.player.invulnTimer = 0;
  });
}

test('a medkit heals to full after its channel and is used up', async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game, p = g.player;
    p.health = 30; p.items[2] = 1;
    g.press('Digit7');
    g.step(120 * 3);
    const mid = { health: p.health, use: p.useKind };
    g.step(120 * 4);
    return { mid, health: p.health, use: p.useKind, left: p.items[2] };
  });
  expect(r.mid.use).toBe(2);
  expect(r.mid.health).toBe(30);
  expect(r.health).toBe(100);
  expect(r.use).toBe(0);
  expect(r.left).toBe(0);
});

test('swapping guns cancels a channel and keeps the item', async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game, p = g.player;
    p.health = 50; p.items[1] = 2;
    g.press('Digit6');
    g.step(120);
    const started = p.useKind;
    g.press('Digit2');
    g.step(10);
    g.step(120 * 4);
    return { started, use: p.useKind, health: p.health, left: p.items[1] };
  });
  expect(r.started).toBe(1);
  expect(r.use).toBe(0);
  expect(r.health).toBe(50);
  expect(r.left).toBe(2);
});

test('the item bar shows the bag and the channel bar fills while healing', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const g = globalThis.__game, p = g.player;
    p.armor = 10; p.items[3] = 4;
    g.press('Digit8');
    g.step(120);
    g.forceHudTick(1 / 60);
  });
  await expect(page.locator('#items .it').nth(2).locator('span')).toHaveText('4');
  await expect(page.locator('#usebar')).toHaveClass(/on/);
});
