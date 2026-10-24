import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../server/node.js';

/**
 * The friends drawer against the real local server: two browsers, two accounts, a request, an
 * acceptance, presence, and an invite that lands as a banner and takes the invitee online.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=', 'base64');

test.describe.configure({ mode: 'serial', timeout: 240_000 });   // software GL boots slowly, and a test opens up to two pages

let server = null;
test.beforeAll(async () => { server = await startServer({ port: PORT, accountsFile: null, accountIterations: 1000, budgetFile: path.join(repoRoot, 'test-results', 'friends-budget.json'), log: () => {} }); });
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
  await expect(page.locator('#ac-name')).not.toHaveText('GUEST');
  return page;
}


const signUp = (page, username) => page.evaluate(async (name) => {
  const r = await fetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'correct horse battery' }) });
  return r.status;
}, username);

test('add, accept, see who is on, invite, and join from the banner', async ({ browser }) => {
  const a = await open(browser), b = await open(browser);
  expect(await signUp(a, 'Annie')).toBe(201);
  expect(await signUp(b, 'Bobby')).toBe(201);
  // The session cookie is set; the account module reads it again on the next load.
  await a.reload(); await b.reload();
  await expect(a.locator('#play')).toBeEnabled({ timeout: 60_000 });
  await expect(b.locator('#play')).toBeEnabled({ timeout: 60_000 });
  await expect(a.locator('#friends-btn')).toBeVisible();

  // Annie asks Bobby.
  await a.locator('#friends-btn').click();
  await expect(a.locator('#friends')).toHaveClass(/\bon\b/);
  await a.locator('#fr-name').fill('nobody');
  await a.locator('#fr-add button').click();
  await expect(a.locator('#fr-msg')).toContainText('No player');
  await a.locator('#fr-name').fill('bobby');
  await a.locator('#fr-add button').click();
  await expect(a.locator('#fr-list .fr-row.out b')).toHaveText('Bobby');

  // Bobby sees the badge and accepts.
  await b.evaluate(() => globalThis.__game.friends.refresh());
  await expect(b.locator('#fr-badge')).toHaveText('1');
  await b.locator('#friends-btn').click();
  await b.locator('#fr-list .fr-row.req .fr-b.go').click();
  await expect(b.locator('#fr-list .fr-row b')).toHaveText('Annie');
  await expect(b.locator('#fr-badge')).toBeHidden();

  // Both check in; Annie now sees Bobby as online and invites him.
  await a.evaluate(() => globalThis.__game.friends.refresh());
  await expect(a.locator('#fr-list .fr-row.on b')).toHaveText('Bobby');
  await a.locator('#fr-list .fr-row.on .fr-b.inv').click();
  await expect(a.locator('#fr-msg')).toContainText('Invited Bobby');

  // The first poll after sign-in is not news; the invite is.
  await b.evaluate(() => globalThis.__game.friends.refresh());
  await expect(b.locator('#fr-invite')).toHaveClass(/\bon\b/);
  await expect(b.locator('#fr-invite b')).toHaveText('Annie');
  await b.locator('#fr-invite .fr-b.go').dispatchEvent('click');   // software-GL frames are slow enough to outlast a click's own visibility checks
  await expect(b.locator('#pane-online')).toHaveClass(/\bon\b/);
  await expect(b.locator('#fr-invite')).not.toHaveClass(/\bon\b/);

  // Unfriending takes two clicks and removes both sides.
  await a.locator('#fr-list .fr-row .fr-b.no').dispatchEvent('click');
  await a.locator('#fr-list .fr-row .fr-b.no.armed').dispatchEvent('click');
  await expect(a.locator('#fr-list .fr-empty')).toBeVisible();

  await a.context().close(); await b.context().close();
});

test('signed out, there is no friends button', async ({ browser }) => {
  const page = await open(browser);
  await expect(page.locator('#friends-btn')).toBeHidden();
  await page.context().close();
});
