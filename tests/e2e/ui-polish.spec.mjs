import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

test('the ammo count warns before the click: amber when low, red and pulsing when empty', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => { const g = globalThis.__game; g.player.ammo.pistol.mag = 7; g.player.cooldown = 0; });
  const fire = () => page.evaluate(() => { const g = globalThis.__game; g.player.cooldown = 0; g.tryFire(); });
  await fire();                                              // 6 of 15: not low yet
  await expect(page.locator('#ammo')).not.toHaveClass(/\blow\b/);
  await fire();                                              // 5 of 15: a third
  await expect(page.locator('#ammo')).toHaveClass(/\blow\b/);
  for (let i = 0; i < 5; i++) await fire();
  await expect(page.locator('#ammo')).toHaveClass(/\bempty\b/);
  await expect(page.locator('#ammo')).not.toHaveClass(/\blow\b/);   // empty replaces low
});

test('the reload shows a progress bar, not only a percentage', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => { const g = globalThis.__game; g.player.ammo.pistol.mag = 2; g.player.reloading = 0.6; g.player.reloadTotal = 1.2; });
  await pumpFrames(page, 2);
  await expect(page.locator('#a-reload')).toHaveClass(/\bbar\b/);
  expect(await page.locator('#a-reload').evaluate((e) => e.style.getPropertyValue('--p'))).toMatch(/^\d+%$/);
});

test('ONLINE is a pane of the play panel: it replaces the solo options, and says so when the server is not there', async ({ page }) => {
  await bootGame(page);
  await expect(page.locator('#pane-solo')).toBeVisible();
  await expect(page.locator('#pane-online')).toBeHidden();
  await page.click('#ptab-online');
  await expect(page.locator('#pane-online')).toBeVisible();
  await expect(page.locator('#pane-solo')).toBeHidden();
  await expect(page.locator('#play')).toBeHidden();
  // The plain test server has no multiplayer room behind /stats.
  await expect(page.locator('#ol-state')).toHaveText('SERVER OFFLINE');
  await expect(page.locator('#mp-play')).toHaveClass(/\bblocked\b/);
  await expect(page.locator('#ol-note')).toContainText('Solo play is unaffected');
  await page.click('#ptab-solo');
  await expect(page.locator('#play')).toBeVisible();
  await expect(page.locator('#pane-online')).toBeHidden();
});

test('settings are pages: one tab per page, and only the page you picked is shown', async ({ page }) => {
  await bootGame(page);
  await page.click('#settings-open');
  const pages = await page.locator('#settings-body .set-page').count();
  await expect(page.locator('#set-nav button')).toHaveCount(pages);
  expect(pages).toBeGreaterThanOrEqual(4);
  await expect(page.locator('#set-nav button.on')).toHaveText('VIDEO');
  await expect(page.locator('#settings-body .set-page:visible')).toHaveCount(1);
  await expect(page.locator('#settings-body [data-page="VIDEO"]')).toBeVisible();
  await page.locator('#set-nav button', { hasText: 'AUDIO' }).click();
  await expect(page.locator('#set-nav button.on')).toHaveText('AUDIO');
  await expect(page.locator('#settings-body [data-page="AUDIO"]')).toBeVisible();
  await expect(page.locator('#settings-body [data-page="VIDEO"]')).toBeHidden();
  // Everything on a page fits on screen without scrolling the panel.
  const box = await page.locator('#settings-body [data-page="AUDIO"]').boundingBox();
  expect(box.y + box.height).toBeLessThan(720);
});

test('the locker shows the gun you point at, turning, with its numbers', async ({ page }) => {
  await bootGame(page);
  await page.click('#locker-open');
  await expect(page.locator('#lk-canvas')).toBeVisible();
  await expect(page.locator('#lk-gname')).toHaveText('PISTOL');
  await expect(page.locator('#lk-tag')).toHaveText('EQUIPPED · SLOT 1');
  await page.locator('#lk-armory [data-gun="sniper"]').hover();
  await expect(page.locator('#lk-gname')).toHaveText('SNIPER RIFLE');
  await expect(page.locator('#lk-facts')).toContainText('150');
  await expect(page.locator('#lk-facts')).toContainText('RPM');
  await page.locator('#lk-slots .lk-slot:nth-child(5)').click();   // the frag
  await expect(page.locator('#lk-gname')).toHaveText('FRAG GRENADE');
  await expect(page.locator('#lk-tag')).toHaveText('SLOT 5');
  await page.keyboard.press('Digit3');
  await expect(page.locator('#lk-gname')).toHaveText('SHOTGUN');
  await page.keyboard.press('Escape');
  await expect(page.locator('#locker')).toBeHidden();
});

test('the pause screen lists the controls, and the lobby does not carry them', async ({ page }) => {
  await bootGame(page);
  await expect(page.locator('#p-keys')).toBeHidden();
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => document.getElementById('pause').classList.add('on'));
  await expect(page.locator('#p-keys')).toBeVisible();
  await expect(page.locator('#p-keys')).toContainText('Reload');
});

test('the death screen says who killed you, and with what, until you respawn', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.invulnTimer = 0; g.player.health = 0;
    g.killCombatant(g.player, g.bots[1], false);
    g.killcam.reset();
  });
  const name = await page.evaluate(() => globalThis.__game.bots[1].name);
  await pumpFrames(page, 3);
  await expect(page.locator('#p-killer')).toContainText(`KILLED BY ${name}`);
  await page.evaluate(() => globalThis.__game.respawnPlayer());
  await expect(page.locator('#p-killer')).toHaveText('');
});

test('high contrast is a setting: it brightens the secondary ink and makes the panels solid', async ({ page }) => {
  await bootGame(page);
  const ink = () => page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--ink-3').trim());
  const before = await ink();
  await page.click('#settings-open');
  await page.locator('#set-nav button', { hasText: 'HUD' }).click();
  await page.locator('#settings-body .set-row', { hasText: 'High contrast' }).locator('input').check();
  expect(await ink()).not.toBe(before);
  expect(await page.evaluate(() => document.body.classList.contains('hc'))).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('overrun.settings')).highContrast)).toBe(true);
});
