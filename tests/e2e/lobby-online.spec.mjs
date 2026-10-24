import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../server/node.js';
import { WsBot } from '../mp/wsclient.mjs';

/**
 * The ONLINE pane against a real room: it reports who is in it, and refuses to pretend the room is
 * empty. Real time, its own server (like multiplayer.spec.mjs).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8796;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=', 'base64');
test.describe.configure({ timeout: 240_000 });

let server = null;
const bots = [];
test.beforeAll(async () => {
  server = await startServer({ port: PORT, accountsFile: null, accountIterations: 1000, budgetFile: path.join(repoRoot, 'test-results', 'lobby-online-budget.json'), log: () => {} });
});
test.afterAll(async () => { for (const b of bots) b.ws.close(); await server?.stop(); });

async function open(browser) {
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
  await page.addInitScript(() => localStorage.setItem('overrun.settings', JSON.stringify({ quality: 'low', masterVolume: 0 })));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await expect(page.locator('#play')).toBeEnabled({ timeout: 90_000 });
  return page;
}

test('an empty room is online with nobody in it; then the roster shows who joins', async ({ browser }) => {
  const page = await open(browser);
  await page.click('#ptab-online');
  await expect(page.locator('#ol-state')).toHaveText('ONLINE');
  await expect(page.locator('#ol-players')).toHaveText('0 / 10');
  await expect(page.locator('#ol-roster')).toContainText('Nobody yet');
  await expect(page.locator('#mp-play')).not.toHaveClass(/\bblocked\b/);

  for (const name of ['VIPER', 'HAVOC']) { const b = new WsBot(`ws://127.0.0.1:${PORT}/ws`, { name, character: 'swat' }); await b.ready; bots.push(b); }
  await page.evaluate(() => globalThis.__game.lobby && 0);   // keep the page busy-free; the pane polls on its own
  await page.click('#ptab-solo');
  await page.click('#ptab-online');                           // opening the pane refreshes at once
  await expect(page.locator('#ol-players')).toHaveText('2 / 10');
  await expect(page.locator('#ol-roster li b')).toHaveText(['VIPER', 'HAVOC']);
  await expect(page.locator('#ol-now')).toContainText('PORT');
  await expect(page.locator('#ol-phase')).toHaveText('ROUND IN PROGRESS');
  await page.context().close();
});
