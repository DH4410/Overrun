import { expect, test } from '@playwright/test';

import { bootGame, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * Rebindable keys, end to end: pick a key in the settings panel, the menu help follows, and in a
 * match the new key moves you while the old one does nothing. Bindings survive a reload.
 */
test('a rebound key drives the game, the old key goes quiet, and the choice is remembered', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await page.click('#settings-open');
  const forward = page.locator('.kb-row button[data-action="forward"]');
  await expect(forward).toHaveText('W');
  await forward.click();
  await expect(forward).toHaveText('PRESS A KEY');
  await page.keyboard.press('KeyE');
  await expect(forward).toHaveText('E');
  await expect(page.locator('.kb-row button[data-action="forward"].moved')).toHaveCount(1);
  await expect(page.locator('#keyhelp')).toContainText('EASD');

  // Taking a key another action holds swaps them: C was crouch.
  await page.locator('.kb-row button[data-action="jump"]').click();
  await page.keyboard.press('KeyC');
  await expect(page.locator('.kb-row button[data-action="jump"]')).toHaveText('C');
  await expect(page.locator('.kb-row button[data-action="crouch"]')).toHaveText('SPACE');

  // Escape backs out of a pending rebind without changing anything.
  await page.locator('.kb-row button[data-action="reload"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.kb-row button[data-action="reload"]')).toHaveText('R');
  await page.click('#settings-close');

  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  const moved = await page.evaluate(() => {
    const g = globalThis.__game;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    const { player } = g;
    const press = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
    const run = (code) => {
      player.body.position.set(-18, 0.6, 3);
      player.body.velocity.set(0, 0, 0);
      player.yaw = Math.PI / 2;
      for (let i = 0; i < 30; i++) g.fixedStep(1 / 120);
      const from = player.body.position.x;
      press(code, true);
      for (let i = 0; i < 90; i++) g.fixedStep(1 / 120);
      press(code, false);
      return Math.abs(player.body.position.x - from);
    };
    return { oldKey: run('KeyW'), newKey: run('KeyE') };
  });
  expect(moved.oldKey).toBeLessThan(0.05);
  expect(moved.newKey).toBeGreaterThan(1);

  expect(await page.evaluate(() => localStorage.getItem('overrun.keybinds'))).toContain('"forward":"KeyE"');
  await bootGame(page);
  await page.click('#settings-open');
  await expect(page.locator('.kb-row button[data-action="forward"]')).toHaveText('E');
  await page.click('#settings-reset');
  await expect(page.locator('.kb-row button[data-action="forward"]')).toHaveText('W');
  expect(errors).toEqual([]);
});
