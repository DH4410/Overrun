import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../server/node.js';

/**
 * Online play against the real room (server/node.js) on its own port: two players and a
 * spectator in one room, nothing of single player running underneath, leaving back to a
 * working single player, and the "refresh to update" refusal for a stale map file.
 *
 * Unlike the other specs this runs on real time (the client's clock must keep pace with the
 * server's), so nothing here depends on how many frames a headless browser manages.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=', 'base64');

test.describe.configure({ mode: 'serial' });
// A GPU where Chromium can use one: software GL manages a few frames a second, which starves
// the client's 120 Hz prediction. The assertions hold either way.
if (process.platform === 'win32' && !process.env.MP_SOFT_GL) {
  test.use({ launchOptions: { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } });
}

let server = null;
test.beforeAll(async () => {
  const budgetFile = path.join(mkdtempSync(path.join(tmpdir(), 'overrun-mp-')), 'budget.json');
  server = await startServer({ port: PORT, budgetFile, log: () => {} });
});
test.afterAll(async () => { await server?.stop(); });

async function open(browser, name, { routeMap = null } = {}) {
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
  if (routeMap) await page.route('**/assets/maps/port.json', (r) => r.fulfill({ body: routeMap, contentType: 'application/json' }));
  await page.addInitScript(() => localStorage.setItem('overrun.settings', JSON.stringify({ quality: 'low', masterVolume: 0 })));
  await page.goto(`${BASE}/`);
  await expect(page.locator('#mp-play')).toBeEnabled({ timeout: 45_000 });
  await page.fill('#nameinput', name);
  return page;
}

const debug = (page) => page.evaluate(() => window.__game.net.debug());
const roomStats = async () => (await fetch(`${BASE}/stats`)).json();

test('two players and a spectator share one room, and see each other move', async ({ browser }) => {
  test.setTimeout(240_000);   // about 2 min with software GL (MP_SOFT_GL=1, as on Linux CI)
  const a = await open(browser, 'ALPHA');
  const b = await open(browser, 'BRAVO');
  const spec = await open(browser, 'WATCHER');
  await a.click('#mp-play');
  await b.click('#mp-play');
  await spec.click('#mp-watch');
  for (const p of [a, b]) await expect.poll(async () => (await debug(p)).myId, { timeout: 30_000 }).not.toBeNull();
  await expect.poll(async () => (await debug(spec)).spectator, { timeout: 30_000 }).toBe(true);

  // One build: the room and every client agree on the map hash.
  const stats = await roomStats();
  expect(stats.players).toBe(2);
  expect(stats.spectators).toBe(1);
  for (const p of [a, b, spec]) expect((await debug(p)).hash).toBe(stats.hash);

  // Nothing of single player runs online: no local match, no bot AI, only puppets.
  for (const [p, others] of [[a, 1], [b, 1], [spec, 2]]) {
    await expect.poll(() => p.evaluate(() => window.__game.bots.length), { timeout: 15_000 }).toBe(others);
    const local = await p.evaluate(async () => {
      const g = window.__game;
      const proto = Object.getPrototypeOf(g.bots[0]);
      const real = proto.simStep;
      let calls = 0;
      proto.simStep = function (...args) { calls++; return real.apply(this, args); };
      await new Promise((r) => setTimeout(r, 1000));
      proto.simStep = real;
      return { calls, running: g.match.running, notPuppets: g.bots.filter((x) => !x.puppet).length };
    });
    expect(local).toEqual({ calls: 0, running: false, notPuppets: 0 });
  }

  // ALPHA walks; BRAVO and the spectator both see it go.
  const idA = (await debug(a)).myId;
  const seenBy = async (p) => (await debug(p)).remotes.find((r) => r.id === idA)?.pos;
  const fromB = await seenBy(b), fromSpec = await seenBy(spec);
  expect(fromB).toBeTruthy();
  await a.keyboard.down('KeyW');
  await a.waitForTimeout(1500);
  await a.keyboard.up('KeyW');
  const moved = (p0, p1) => Math.hypot(p1.x - p0.x, p1.z - p0.z);
  await expect.poll(async () => moved(fromB, await seenBy(b)), { timeout: 10_000 }).toBeGreaterThan(1.5);
  await expect.poll(async () => moved(fromSpec, await seenBy(spec)), { timeout: 10_000 }).toBeGreaterThan(1.5);
  // Where BRAVO draws ALPHA is where ALPHA's own prediction put it, once it has stopped.
  await expect.poll(async () => {
    const own = (await debug(a)).you;
    return moved(own, await seenBy(b));
  }, { timeout: 10_000 }).toBeLessThan(0.25);

  // Leaving: back to the lobby, and single player still deploys with its own bots.
  await a.evaluate(() => window.__game.net.leave());
  await expect(a.locator('#menu')).toBeVisible();
  await expect(a.locator('#menuresult')).toHaveText('Left the online match');
  expect(await a.evaluate(() => window.__game.bots.length)).toBe(0);
  await a.click('#play');
  await expect.poll(() => a.evaluate(() => window.__game.match.running), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => a.evaluate(() => window.__game.bots.filter((x) => !x.puppet).length), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await roomStats()).players, { timeout: 10_000 }).toBe(1);

  for (const p of [a, b, spec]) await p.context().close();
});

test('a client whose map file differs from the server is told to refresh', async ({ browser }) => {
  const map = JSON.parse(readFileSync(path.join(repoRoot, 'assets', 'maps', 'port.json'), 'utf8'));
  map.ceilY += 0.5;
  const page = await open(browser, 'STALE', { routeMap: JSON.stringify(map) });
  await page.click('#mp-play');
  await expect(page.locator('#menuresult')).toContainText('Refresh to update', { timeout: 30_000 });
  await expect(page.locator('#menu')).toBeVisible();
  await page.context().close();
});
