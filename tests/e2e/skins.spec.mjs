import { expect, test } from '@playwright/test';

import { SKINS } from '../../src/skins.js';
import { bootGame, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * The locker's SKINS tab: every character, all unlocked, picked with one click and remembered.
 * Skins that are not `boot` load the first time somebody wears one.
 */

test('the locker lists every skin with a portrait, and wearing one is remembered', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await page.click('#locker-open');
  await page.click('#locker .lk-tabs [data-tab="skins"]');
  await expect(page.locator('#locker .lk-skin')).toHaveCount(SKINS.length);
  await expect(page.locator('#lk-gear')).toBeHidden();
  await expect(page.locator('#locker-reset')).toBeHidden();

  // Every card has its portrait, drawn from assets/skins/.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#locker .lk-skin img')].filter((i) => !i.naturalWidth).length)).toBe(0);

  const pick = SKINS[SKINS.length - 1];
  await page.click(`#locker .lk-skin[data-skin="${pick.id}"]`);
  await expect(page.locator(`#locker .lk-skin.worn[data-skin="${pick.id}"]`)).toHaveCount(1);
  await expect(page.locator('#lk-wear b')).toHaveText(pick.name);
  expect(await page.evaluate(() => localStorage.getItem('overrun-skin'))).toBe(pick.id);
  // Worn means loaded: the lobby, the emote and the other players' screens all draw it at once.
  await expect.poll(() => page.evaluate((id) => globalThis.__game.assets.characters.includes(id) || Boolean(globalThis.__game.buildCharacterMesh(id)), pick.id)).toBe(true);

  // Back to the weapons: the loadout panel is untouched.
  await page.click('#locker .lk-tabs [data-tab="gear"]');
  await expect(page.locator('#lk-gear')).toBeVisible();
  await expect(page.locator('#locker .lk-slot')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('a skin that is not loaded at boot loads on demand, and a made-up one does not', async ({ page }) => {
  await bootGame(page);
  const r = await page.evaluate(async (lazy) => {
    const g = globalThis.__game;
    const out = { bogus: await g.loadCharacter('nobody'), before: [], after: [] };
    for (const id of lazy) {
      out.before.push(Boolean(g.buildCharacterMesh(id)));
      out.after.push((await g.loadCharacter(id)) && Boolean(g.buildCharacterMesh(id)));
    }
    return out;
  }, SKINS.filter((s) => !s.boot).map((s) => s.id));
  expect(r.bogus).toBe(false);
  expect(r.before.every((v) => v === false)).toBe(true);
  expect(r.after.every((v) => v === true)).toBe(true);
});
