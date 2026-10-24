import { expect, test } from '@playwright/test';

import { CRATE_PRICE, GUN_SKINS } from '../../src/gunskins.js';
import { bootGame, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * The STORE: a crate that pays out a random skin and a daily shop that sells rarer ones. Credits
 * are taken before the supply drop starts, the skin lands in the collection, and the locker can wear it.
 */
const seed = (page, profile) => page.addInitScript((p) => {
  if (!globalThis.sessionStorage.getItem('seeded')) { localStorage.setItem('overrun.profile', JSON.stringify(p)); globalThis.sessionStorage.setItem('seeded', '1'); }
}, profile);
// The e2e page runs on a stepped clock (helpers/game.mjs), so the show only moves when told to.
const forward = (page, ms = 6000) => page.evaluate((m) => globalThis.__testClock.pump(1, m), ms);
const settled = (page) => page.evaluate(() => Promise.all(document.querySelector('#drop-win').getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('overrun.profile')));

test('opening a crate costs credits, plays the supply drop, and adds a skin you can wear in the locker', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await seed(page, { xp: 6000, credits: 2000, spent: 0 });
  await bootGame(page);
  await page.click('#tab-store');
  await expect(page.locator('#store')).toBeVisible();
  await expect(page.locator('#wallet-n')).toHaveText('2000');
  await expect(page.locator('#st-cards .st-card-item')).toHaveCount(4);
  await expect(page.locator('#st-count')).toContainText(`0 / ${GUN_SKINS.length}`);

  await page.click('#st-open');
  await expect(page.locator('#drop')).toBeVisible();                // its own full-screen window
  await expect(page.locator('#drop-hint')).toHaveText('SUPPLY DROP INBOUND');
  await expect(page.locator('#drop-win')).toBeHidden();             // the name waits for the burst
  await forward(page);
  await expect(page.locator('#drop-win')).toBeVisible();
  await expect(page.locator('#drop-name')).not.toBeEmpty();
  await expect(page.locator('#drop-skip')).toBeHidden();
  const box = await page.locator('#drop-canvas').boundingBox();
  const vp = page.viewportSize();
  expect(box.width).toBeGreaterThanOrEqual(vp.width - 2);           // it fills the window
  expect(box.height).toBeGreaterThanOrEqual(vp.height - 2);
  await expect(page.locator('#wallet-n')).toHaveText(String(2000 - CRATE_PRICE));
  const p = await saved(page);
  expect(p.spent).toBe(CRATE_PRICE);
  expect(p.owned).toHaveLength(1);
  expect(p.owned[0]).toMatch(/^skin:/);
  await expect(page.locator('#st-count')).toContainText(`1 / ${GUN_SKINS.length}`);

  // Try it on: the locker lists it in the collection, and wearing it is saved for that gun.
  await settled(page);
  await page.click('#drop-try', { force: true });
  await expect(page.locator('#drop')).toBeHidden();
  await expect(page.locator('#locker')).toBeVisible();
  const skin = page.locator('#lk-skins .lk-coll');
  await expect(skin).toHaveCount(1);
  await skin.click();
  await expect(skin).toHaveClass(/\bon\b/);
  const eq = (await saved(page)).equipped;
  expect(Object.values(eq.guns)).toEqual([p.owned[0].slice(5)]);
  // Picking a level finish takes it off that gun again.
  await page.locator('.lk-skin[data-skin="stock"]').click();
  expect((await saved(page)).equipped.guns).toEqual({});
  expect(errors).toEqual([]);
});

test('skip jumps to the result, and OPEN ANOTHER spends another crate in the same window', async ({ page }) => {
  await seed(page, { xp: 6000, credits: 1000, spent: 0 });
  await bootGame(page);
  await page.click('#tab-store');
  await page.click('#st-open');
  await forward(page);
  await expect(page.locator('#drop-win')).toBeVisible();
  const first = await page.locator('#drop-name').innerText();
  await expect(page.locator('#drop-again')).toBeEnabled();
  await expect(page.locator('#drop-again')).toContainText(String(CRATE_PRICE));
  await settled(page);
  await page.click('#drop-again', { force: true });
  await expect(page.locator('#drop')).toBeVisible();
  await expect(page.locator('#drop-win')).toBeHidden();             // a fresh drop begins
  await forward(page);
  await expect(page.locator('#drop-win')).toBeVisible();
  expect(await page.locator('#drop-name').innerText()).not.toBe(first);   // never the same skin twice
  expect((await saved(page)).spent).toBe(CRATE_PRICE * 2);
  await settled(page);
  await page.click('#drop-done', { force: true });
  await expect(page.locator('#drop')).toBeHidden();
  await expect(page.locator('#store')).toBeVisible();
  await expect(page.locator('#st-count')).toContainText(`2 / ${GUN_SKINS.length}`);
  await expect(page.locator('#wallet-n')).toHaveText(String(1000 - CRATE_PRICE * 2));
});

test('with only one crate affordable, OPEN ANOTHER says what is missing, and Escape closes the window', async ({ page }) => {
  await seed(page, { xp: 6000, credits: CRATE_PRICE + 40, spent: 0 });
  await bootGame(page);
  await page.click('#tab-store');
  await page.click('#st-open');
  await page.keyboard.press('Escape');                              // first Escape skips the show
  await forward(page);
  await expect(page.locator('#drop-win')).toBeVisible();
  await expect(page.locator('#drop-again')).toBeDisabled();
  await expect(page.locator('#drop-again')).toContainText('NEED');
  await page.keyboard.press('Escape');                              // the next one leaves
  await expect(page.locator('#drop')).toBeHidden();
  await expect(page.locator('#store')).toBeVisible();               // and the store is still there
});

test('a daily shop skin is bought once, and not at all without the credits', async ({ page }) => {
  await seed(page, { xp: 6000, credits: 5000, spent: 0 });
  await bootGame(page);
  await page.click('#tab-store');
  const first = page.locator('#st-cards .st-card-item').first();
  const id = await first.getAttribute('data-skin');
  const price = await first.locator('.st-buy').innerText();
  await first.locator('.st-buy').click();
  await expect(first.locator('.st-buy')).toHaveText(/OWNED/);
  await expect(first.locator('.st-buy')).toBeDisabled();
  const p = await saved(page);
  expect(p.owned).toEqual([`skin:${id}`]);
  expect(p.spent).toBe(Number(price.replace(/\D/g, '')));
  await expect(page.locator('#wallet-n')).toHaveText(String(5000 - p.spent));
});

test('with no credits, nothing in the store can be bought', async ({ page }) => {
  await seed(page, { xp: 0, credits: 0, spent: 0 });
  await bootGame(page);
  await page.click('#tab-store');
  await expect(page.locator('#st-open')).toBeDisabled();
  for (const b of await page.locator('#st-cards .st-buy').all()) await expect(b).toBeDisabled();
});

for (const [w, h] of [[1366, 768], [1280, 650], [1024, 600]]) {
  test(`the store fits ${w}x${h} without scrolling, and nothing in it leaves its panel`, async ({ page }) => {
    await seed(page, { xp: 6000, credits: 2000, spent: 0 });
    await page.setViewportSize({ width: w, height: h });
    await bootGame(page);
    await page.click('#tab-store');
    await expect(page.locator('#st-cards .st-card-item')).toHaveCount(4);
    const out = await page.evaluate(() => {
      const bad = [];
      const vw = innerWidth, vh = innerHeight;
      for (const sel of ['.st-card', '.st-crate', '.st-shop', '#st-open', '.st-card-item', '.st-buy']) {
        for (const e of document.querySelectorAll(`#store ${sel}`)) {
          const r = e.getBoundingClientRect();
          if (r.left < 0 || r.top < 0 || r.right > vw + 0.5 || r.bottom > vh + 0.5) bad.push(`${sel} ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
        }
      }
      // A button's label must sit inside the button with room around it.
      for (const e of document.querySelectorAll('#store .st-buy, #st-open')) {
        const r = e.getBoundingClientRect(), k = document.createRange();
        k.selectNodeContents(e);
        const t = k.getBoundingClientRect();
        if (t.left < r.left + 4 || t.right > r.right - 4 || t.top < r.top + 2 || t.bottom > r.bottom - 2) bad.push(`label crowds ${e.className || e.id}`);
      }
      return { bad, sh: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, vw, vh };
    });
    expect(out.bad).toEqual([]);
    expect(out.sh).toBeLessThanOrEqual(out.vh + 1);
    expect(out.sw).toBeLessThanOrEqual(out.vw + 1);
  });
}

for (const [w, h] of [[1366, 768], [1024, 600], [800, 450]]) {
  test(`the drop window's name card and buttons fit ${w}x${h} with room around the text`, async ({ page }) => {
    await seed(page, { xp: 6000, credits: 2000, spent: 0 });
    await page.setViewportSize({ width: w, height: h });
    await bootGame(page);
    await page.click('#tab-store');
    await page.click('#st-open');
    await forward(page);
    await expect(page.locator('#drop-win')).toBeVisible();
    await settled(page);
    const out = await page.evaluate(() => {
      const bad = [];
      const vw = innerWidth, vh = innerHeight;
      const card = document.querySelector('#drop-win').getBoundingClientRect();
      if (card.left < 8 || card.right > vw - 8 || card.top < 8 || card.bottom > vh - 8) bad.push(`card ${Math.round(card.left)},${Math.round(card.top)},${Math.round(card.right)},${Math.round(card.bottom)}`);
      for (const e of document.querySelectorAll('#drop-win button, #drop-skip')) {
        if (e.hidden) continue;
        const r = e.getBoundingClientRect(), k = document.createRange();
        k.selectNodeContents(e);
        const t = k.getBoundingClientRect();
        if (t.left < r.left + 8 || t.right > r.right - 8 || t.top < r.top + 3 || t.bottom > r.bottom - 3) bad.push(`label crowds ${e.id}`);
      }
      for (const sel of ['#drop-rar', '#drop-name']) {
        const t = document.querySelector(sel).getBoundingClientRect();
        if (t.left < card.left + 12 || t.right > card.right - 12) bad.push(`${sel} touches the card edge`);
      }
      return { bad, sw: document.documentElement.scrollWidth, vw };
    });
    expect(out.bad).toEqual([]);
    expect(out.sw).toBeLessThanOrEqual(out.vw + 1);
  });
}
