import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

/**
 * The locker: pick a slot, pick a gun, and the keys follow. A gun already carried swaps places
 * rather than appearing twice, the choice survives a reload, and a gun left in the locker
 * cannot be pulled out with a key mid-match.
 */
test('the locker changes the loadout, saves it, and keys 1-4 follow it', async ({ page }) => {
  await bootGame(page);

  await page.click('#locker-open');
  await expect(page.locator('#locker')).toBeVisible();
  await expect(page.locator('#lk-slots .lk-slot')).toHaveCount(5);   // four guns and the frag

  // Slot 2 gets the SMG in place of the rifle.
  await page.click('#lk-slots .lk-slot:nth-child(2)');
  await page.click('#lk-armory [data-gun="smg"]');
  // Slot 1 gets the shotgun, which was in slot 3, so the pistol moves to 3.
  await page.click('#lk-slots .lk-slot:nth-child(1)');
  await page.click('#lk-armory [data-gun="shotgun"]');
  const want = ['shotgun', 'smg', 'pistol', 'sniper'];
  expect(await page.evaluate(() => globalThis.__game.player.loadout)).toEqual(want);
  await page.click('#locker-close');
  await expect(page.locator('#locker')).toBeHidden();

  // It survives a reload, and the locker shows it.
  await bootGame(page);
  expect(await page.evaluate(() => globalThis.__game.player.loadout)).toEqual(want);
  await page.click('#locker-open');
  expect(await page.locator('#lk-slots .lk-slot').evaluateAll((els) => els.map((e) => e.dataset.gun)))
    .toEqual([...want, 'frag']);
  await page.click('#locker-close');

  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  const current = () => page.evaluate(() => globalThis.__game.player.current);
  expect(await current()).toBe('shotgun');            // you spawn on slot 1
  await page.keyboard.press('Digit2');
  await pumpFrames(page, 2);
  expect(await current()).toBe('smg');
  await page.keyboard.press('Digit3');
  await pumpFrames(page, 2);
  expect(await current()).toBe('pistol');
  // The rifle stayed in the locker, so nothing can switch to it.
  await page.evaluate(() => globalThis.__game.switchWeapon('ar'));
  expect(await current()).toBe('pistol');
  await expect(page.locator('#slots > div')).toHaveCount(5);
});

test('taking the gun in your hands out of the loadout mid-match hands you slot 1', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  await page.keyboard.press('Digit2');                 // the rifle, in the default loadout
  await pumpFrames(page, 2);
  expect(await page.evaluate(() => globalThis.__game.player.current)).toBe('ar');

  // The pause screen's LOCKER button; the headless page never loses pointer lock to show it.
  await page.evaluate(() => document.getElementById('locker-open-pause').click());
  await page.click('#lk-slots .lk-slot:nth-child(2)');
  await page.click('#lk-armory [data-gun="smg"]');
  const r = await page.evaluate(() => ({ current: globalThis.__game.player.current, loadout: globalThis.__game.player.loadout }));
  expect(r.loadout).toEqual(['pistol', 'smg', 'shotgun', 'sniper']);
  expect(r.current).toBe('pistol');
});
