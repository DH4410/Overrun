import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../server/node.js';

/**
 * A player whose connection drops mid-round gets their seat back by token. Their input numbering
 * starts over on the new connection, so nothing from the old numbering may reach the server first:
 * the server throws away commands it has "already seen", and the player stood frozen (no moving,
 * shooting or grenades) while everyone else carried on.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=', 'base64');

if (process.platform === 'win32' && !process.env.MP_SOFT_GL) {
  test.use({ launchOptions: { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } });
}

let server = null;
test.beforeAll(async () => {
  server = await startServer({ port: PORT, budgetFile: path.join(mkdtempSync(path.join(tmpdir(), 'overrun-mp-')), 'budget.json'), log: () => {} });
});
test.afterAll(async () => { await server?.stop(); });

test('after a dropped connection the player can still move once the seat is back', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, serviceWorkers: 'block' });
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
  await page.addInitScript(() => {
    localStorage.setItem('overrun.settings', JSON.stringify({ quality: 'low', masterVolume: 0 }));
    // Keep every socket the game opens so the test can cut the live one.
    const Real = window.WebSocket;
    window.__socks = [];
    window.WebSocket = class extends Real { constructor(...a) { super(...a); window.__socks.push(this); } };
  });
  // A slow link, so the window between "hello" and "welcome" is wide enough for input to slip into.
  await page.goto(`${BASE}/?lag=300`);
  await expect(page.locator('#mp-play')).toBeEnabled({ timeout: 45_000 });
  await page.locator('#nameinput:visible, #nameinput2:visible').first().fill('DROPPER');
  await page.click('#ptab-online');
  await page.click('#mp-play');
  await expect(page.locator('#mp-lobby')).toBeVisible({ timeout: 30_000 });
  await page.click('#mp-lobby .mcard.k-mode');
  await page.locator('#mp-lobby .pop .tile', { hasText: 'SURVIVAL' }).click();
  await expect(page.locator('#mp-lobby .go')).toBeEnabled();
  await page.click('#mp-lobby .go', { force: true });
  await expect.poll(() => page.evaluate(() => window.__game.net.debug().phase), { timeout: 60_000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__game.net.debug().started), { timeout: 30_000 }).toBe(true);

  const dbg = () => page.evaluate(() => { const d = window.__game.net.debug(); return { ...d.you, seq: d.seq, welcomes: window.__socks.length }; });
  await page.keyboard.down('KeyW');           // input never goes idle, so numbers keep climbing through the outage
  await page.waitForTimeout(6000);            // a real round has thousands of commands behind it by now
  await page.evaluate(() => window.__socks.at(-1).close());
  await expect.poll(async () => (await dbg()).welcomes, { timeout: 30_000 }).toBeGreaterThan(1);

  // Hold W for a while: the server must keep consuming this player's commands. A frozen one has its
  // new numbering thrown away as "stale", so the acknowledged number sits still.
  const seat = () => server.room.players.find((q) => !q.bot && q.name === 'DROPPER');
  await expect.poll(() => seat().connected, { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(500);            // welcome processed, numbering started over
  const before = seat().ackSeq;
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  expect(seat().ackSeq - before).toBeGreaterThan(60);   // ~120 commands a second when moving
  await context.close();
});
