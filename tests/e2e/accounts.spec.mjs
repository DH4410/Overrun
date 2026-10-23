import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../server/node.js';

/**
 * Accounts and rewards against the real local server (server/node.js, accounts held in memory):
 * make an account, stay signed in across a reload, have the career follow you to a second
 * device, and see unlocks gate the operator picker, the locker's finishes and the career screen.
 * Real time, like multiplayer.spec.mjs, since the lobby runs on the real frame loop here.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=', 'base64');

test.describe.configure({ mode: 'serial' });

let server = null;
test.beforeAll(async () => { server = await startServer({ port: PORT, accountsFile: null, accountIterations: 1000, budgetFile: path.join(repoRoot, 'test-results', 'acct-budget.json'), log: () => {} }); });
test.afterAll(async () => { await server?.stop(); });

async function open(browser, { profile = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('https://unpkg.com/three@0.169.0/**', (r) => r.fulfill({
    path: path.join(repoRoot, 'node_modules', 'three', new URL(r.request().url()).pathname.split('/three@0.169.0/')[1]),
    contentType: 'text/javascript; charset=utf-8', headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  await page.route('https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/+esm', (r) => r.fulfill({
    path: path.join(repoRoot, 'node_modules', 'cannon-es', 'dist', 'cannon-es.js'),
    contentType: 'text/javascript; charset=utf-8', headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  await page.route('https://dl.polyhaven.org/**', (r) => r.fulfill({ body: tinyPng, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.addInitScript((p) => {
    localStorage.setItem('overrun.settings', JSON.stringify({ quality: 'low', masterVolume: 0 }));
    // Only seed once: a reload must keep what the game itself saved since.
    if (p && !globalThis.sessionStorage.getItem('seeded')) { localStorage.setItem('overrun.profile', JSON.stringify(p)); globalThis.sessionStorage.setItem('seeded', '1'); }
  }, profile);
  await page.goto(`${BASE}/`);
  await expect(page.locator('#play')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#ac-name')).not.toHaveText('GUEST');   // the account check has answered
  return page;
}

const chip = (page) => page.locator('#ac-name');
const profileXp = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('overrun.profile') ?? '{}').xp ?? 0);
const worn = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('overrun.profile') ?? '{}').equipped ?? null);

test('make an account, keep the recovery code gate, stay signed in across a reload', async ({ browser }) => {
  const page = await open(browser, { profile: { xp: 600, kills: 20, wins: 1, matches: 2 } });
  await expect(chip(page)).toHaveText('SIGN IN');
  await page.locator('#account').click();
  await expect(page.locator('#acct')).toHaveClass(/\bon\b/);
  await page.locator('[data-view="login"] [data-go="register"]').click();
  const form = page.locator('form[data-view="register"]');
  await form.locator('[name="username"]').fill('Viper');
  await form.locator('[name="email"]').fill('viper@example.com');
  await form.locator('[name="password"]').fill('correct horse battery');
  await form.locator('button[type="submit"]').click();

  // The recovery code is shown once and cannot be dismissed by accident.
  await expect(page.locator('[data-view="recovery"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('#acct-code')).toHaveText(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#acct')).toHaveClass(/\bon\b/);
  await page.locator('#acct-saved').click();
  await expect(page.locator('#acct')).not.toHaveClass(/\bon\b/);

  await expect(chip(page)).toHaveText('VIPER');
  await expect(page.locator('#nameinput')).toHaveValue('VIPER');
  expect(await profileXp(page)).toBe(600);                // the guest career came with the account

  await page.reload();
  await expect(page.locator('#play')).toBeEnabled({ timeout: 60_000 });
  await expect(chip(page)).toHaveText('VIPER');
  await page.context().close();
});

test('the career follows the account to a second device, and sign-out stops syncing', async ({ browser }) => {
  const a = await open(browser, { profile: { xp: 600, kills: 20, wins: 1, matches: 2 } });
  await a.locator('#account').click();
  const login = a.locator('form[data-view="login"]');
  await login.locator('[name="login"]').fill('viper@example.com');     // by email this time
  await login.locator('[name="password"]').fill('correct horse battery');
  await login.locator('button[type="submit"]').click();
  await expect(chip(a)).toHaveText('VIPER');

  // The game saves a better career: it reaches the server a moment later.
  await a.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('overrun.profile'));
    localStorage.setItem('overrun.profile', JSON.stringify({ ...p, xp: 1500, kills: 45, matches: 5 }));
    window.dispatchEvent(new CustomEvent('overrun:profile'));
  });
  await expect.poll(async () => (await a.evaluate(() => fetch('/api/me').then((r) => r.json()))).profile.xp, { timeout: 15_000 }).toBe(1500);

  // A second device that has never played: signing in brings the career down.
  const b = await open(browser);
  expect(await profileXp(b)).toBe(0);
  await b.locator('#account').click();
  const l2 = b.locator('form[data-view="login"]');
  await l2.locator('[name="login"]').fill('viper');
  await l2.locator('[name="password"]').fill('correct horse battery');
  await l2.locator('button[type="submit"]').click();
  await expect(chip(b)).toHaveText('VIPER');
  expect(await profileXp(b)).toBe(1500);
  await expect(b.locator('#pc-level')).not.toHaveText('1');

  // Sign out on the first: signed out means no more saving.
  await a.locator('#account').click();
  await a.locator('#acct-out').click();
  await expect(chip(a)).toHaveText('SIGN IN');
  expect(await a.evaluate(() => fetch('/api/me').then((r) => r.status))).toBe(401);
  await a.context().close();
  await b.context().close();
});

test('wrong passwords say so, and a closed card goes away with Escape', async ({ browser }) => {
  const page = await open(browser);
  await page.locator('#account').click();
  const login = page.locator('form[data-view="login"]');
  await login.locator('[name="login"]').fill('viper');
  await login.locator('[name="password"]').fill('not the password');
  await login.locator('button[type="submit"]').click();
  await expect(page.locator('#acct-msg')).toContainText('Wrong username or password');
  await expect(chip(page)).toHaveText('SIGN IN');
  await page.keyboard.press('Escape');
  await expect(page.locator('#acct')).not.toHaveClass(/\bon\b/);
  await page.context().close();
});

test('operators are gated by level: a locked one cannot be worn, an earned one can', async ({ browser }) => {
  const page = await open(browser);                          // a fresh career: level 1
  await expect(page.locator('#op-name')).toHaveText('SWAT');
  await page.locator('#op-next').click();                    // trooper: a starter
  await expect(page.locator('#op-name')).toHaveText('TROOPER');
  expect((await worn(page)).operator).toBe('trooper');
  await page.locator('#op-next').click();                    // gas mask: level 3
  await expect(page.locator('#op-name')).toHaveText('GAS MASK');
  await expect(page.locator('#op-lock')).toHaveText('LOCKED · REACH LEVEL 3');
  expect((await worn(page)).operator).toBe('trooper');       // not worn
  await page.context().close();

  const rich = await open(browser, { profile: { xp: 5000 } });   // well past level 6
  await rich.locator('#op-next').click();
  await rich.locator('#op-next').click();
  await expect(rich.locator('#op-name')).toHaveText('GAS MASK');
  await expect(rich.locator('#op-lock')).toHaveText('');
  expect((await worn(rich)).operator).toBe('gasmask');
  await rich.context().close();
});

test('the career screen lists the track, and titles are earned by stats', async ({ browser }) => {
  const page = await open(browser, { profile: { xp: 700, headshots: 60 } });
  await page.locator('#tab-career').click();
  await expect(page.locator('#career')).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator('#cr-track .cr-node')).not.toHaveCount(0);
  await expect(page.locator('#cr-track .cr-node.current')).toHaveCount(1);
  await expect(page.locator('#cr-track .cr-node.locked').first()).toContainText('AWAY');
  // 60 headshots earns HEADHUNTER; 25 wins (CHAMPION) is not close.
  const head = page.locator('.cr-title', { hasText: 'HEADHUNTER' });
  await head.locator('button').click();
  await expect(head).toHaveClass(/\bworn\b/);
  expect((await worn(page)).title).toBe('headhunter');
  await expect(page.locator('.cr-title', { hasText: 'CHAMPION' }).locator('button')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#career')).toHaveClass(/\bhidden\b/);
  await expect(page.locator('#pc-rank')).toHaveText('HEADHUNTER');
  await page.context().close();
});

test('gun finishes: locked ones are greyed, an earned one repaints the first-person guns', async ({ browser }) => {
  const page = await open(browser, { profile: { xp: 500 } });   // level 2: desert tan
  await page.locator('#locker-open').click();
  await expect(page.locator('#lk-skins .lk-skin')).not.toHaveCount(0);
  await expect(page.locator('.lk-skin[data-skin="gold"]')).toBeDisabled();
  await expect(page.locator('.lk-skin[data-skin="desert"]')).toBeEnabled();
  const alloy = () => page.evaluate(() => {
    const g = window.__game;
    let hex = null;
    g.vmModels.ar.traverse((o) => { if (hex === null && o.isMesh && o.material?.userData?.skinRole === 'alloy') hex = o.material.color.getHex(); });
    return hex;
  });
  const stock = await alloy();
  await page.locator('.lk-skin[data-skin="desert"]').click();
  expect(await alloy()).not.toBe(stock);
  expect((await worn(page)).skin).toBe('desert');
  await page.locator('.lk-skin[data-skin="stock"]').click();
  expect(await alloy()).toBe(stock);
  await page.context().close();
});
