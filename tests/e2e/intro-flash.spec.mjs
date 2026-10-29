import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

// The HUD fades in at match start with one animation on every child. It used to end at opacity 1,
// which lit the full-screen white blast flash, the red hit vignette and the headshot flash for a
// second before the intro ended: a bright flash at the start of every match.
test('no full-screen flash overlay lights up while the HUD fades in', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, {});
  const seen = [];
  for (let i = 0; i < 8; i++) {
    seen.push(await page.evaluate(() => ['blastflash', 'hitflash', 'hsflash', 'ammo-prompt']
      .map((id) => Number(getComputedStyle(document.getElementById(id)).opacity))));
    await page.waitForTimeout(400);
  }
  expect(Math.max(...seen.flat())).toBe(0);
});
