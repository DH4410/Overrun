import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../server/node.js';

/**
 * The online kill cam: when another player kills you, the view swings onto them, the picture
 * rewinds, and the replay runs through their screen (their gun in their hands, the shots, the
 * numbers as each one landed on you) before you respawn. Real server, two real clients.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=', 'base64');

test.describe.configure({ mode: 'serial' });
if (process.platform === 'win32' && !process.env.MP_SOFT_GL) {
  test.use({ launchOptions: { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } });
}

let server = null;
test.beforeAll(async () => {
  const budgetFile = path.join(mkdtempSync(path.join(tmpdir(), 'overrun-mpkc-')), 'budget.json');
  server = await startServer({ port: PORT, budgetFile, log: () => {} });
});
test.afterAll(async () => { await server?.stop(); });

async function open(browser, name) {
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
  await page.addInitScript(() => localStorage.setItem('overrun.settings', JSON.stringify({ quality: 'low', masterVolume: 0 })));
  await page.goto(`${BASE}/`);
  await expect(page.locator('#mp-play')).toBeEnabled({ timeout: 45_000 });
  await page.locator('#nameinput:visible, #nameinput2:visible').first().fill(name);
  await page.click('#ptab-online');
  return page;
}

const debug = (page) => page.evaluate(() => window.__game.net.debug());

test('being killed online plays the swing, the rewind and a replay through the killer\'s screen, and ends at respawn', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await open(browser, 'VICTIM');
  const b = await open(browser, 'KILLER');
  await a.click('#mp-play');
  await b.click('#mp-play');
  for (const p of [a, b]) await expect(p.locator('#mp-lobby')).toBeVisible({ timeout: 30_000 });
  await expect(b.locator('#mp-lobby .go')).toHaveText('READY', { timeout: 30_000 });
  await expect(async () => {
    if (await b.locator('#mp-lobby .go.on').count() === 0) await b.click('#mp-lobby .go', { force: true, timeout: 5_000 });
    await expect(a.locator('#mp-lobby .go')).toBeEnabled({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await a.click('#mp-lobby .go', { force: true });
  for (const p of [a, b]) await expect.poll(async () => (await debug(p)).phase, { timeout: 45_000 }).toBe(1);
  await expect.poll(async () => (await debug(a)).remotes.length, { timeout: 15_000 }).toBe(1);
  // Some fight to replay: two seconds of snapshots, then shots from the killer landing on you.
  await a.waitForTimeout(2500);

  const ids = { a: (await debug(a)).myId, b: (await debug(b)).myId };
  await a.evaluate(() => {
    const g = window.__game;
    globalThis.__kcSeen = [];
    globalThis.__kcNumbers = 0;
    new MutationObserver((m) => { for (const r of m) globalThis.__kcNumbers += r.addedNodes.length; }).observe(document.getElementById('dmgnums'), { childList: true });
    const tick = () => {
      const d = g.net.debug().killcam;
      const box = document.getElementById('killcam');
      if (d) globalThis.__kcSeen.push({ phase: d.phase, cut: box.classList.contains('cut') });
      requestAnimationFrame(tick);
    };
    tick();
  });

  // The killer shoots you twice, the second kills.
  const room = server.room;
  const victim = room.players.find((q) => q.id === ids.a), killer = room.players.find((q) => q.id === ids.b);
  const at = { x: victim.pos.x, y: victim.pos.y + 1.5, z: victim.pos.z };
  // The killer faces you, as a killer would: the numbers are only drawn for a point in front of the lens.
  await b.evaluate(({ dx, dz }) => { window.__game.player.yaw = Math.atan2(-dx, -dz); window.__game.player.pitch = 0; },
    { dx: victim.pos.x - killer.pos.x, dz: victim.pos.z - killer.pos.z });
  await a.waitForTimeout(600);
  room.applyDamage(victim, 30, killer, at, false, 'body', killer.weapon ?? 'ar');
  await a.waitForTimeout(250);
  room.applyDamage(victim, 999, killer, at, true, 'head', killer.weapon ?? 'ar');

  await expect.poll(async () => (await debug(a)).killcam?.phase ?? 'none', { timeout: 10_000 }).not.toBe('none');
  await expect.poll(async () => (await debug(a)).killcam?.phase ?? 'gone', { timeout: 10_000 }).toBe('replay');
  expect((await debug(a)).killcam.hits).toBeGreaterThan(0);        // the shots that landed on you are replayed with the cam
  const mid = await a.evaluate(() => ({
    killer: document.getElementById('kc-name').textContent, weapon: document.getElementById('kc-weapon').textContent,
    who: document.getElementById('kc-who').textContent, body: document.body.className,
    box: [...document.getElementById('killcam').classList].join(' '),
    gun: window.__game.net.killcamGun, rig: window.__game.vmRig.visible,
  }));
  expect(mid.killer).toBe('KILLER');
  expect(mid.weapon).toContain('HEADSHOT');
  expect(mid.who).toBe('KILL CAM');
  expect(mid.body).toContain('killcam-replay');
  expect(mid.box).toContain('replay');
  expect(mid.gun).toBe(true);                // the killer's own gun, in their hands
  expect(mid.rig).toBe(true);

  // It ends by itself, before or as you respawn, and gives the screen back.
  await expect.poll(async () => (await debug(a)).killcam, { timeout: 10_000 }).toBeNull();
  const after = await a.evaluate(() => ({ body: document.body.className, box: [...document.getElementById('killcam').classList].join(' ') }));
  expect(after.body).not.toContain('killcam');
  expect(after.box).not.toContain('on');
  const seen = await a.evaluate(() => globalThis.__kcSeen);
  expect([...new Set(seen.map((s) => s.phase))]).toEqual(['zoom', 'cut', 'replay']);
  expect(seen.some((s) => s.phase === 'cut' && s.cut)).toBe(true);        // the rewind static ran
  expect(await a.evaluate(() => globalThis.__kcNumbers)).toBeGreaterThan(0);   // the number of the killing shot: the cam must not end before the replay reaches it
  // Back in the match within the usual wait: the cam never held you dead longer than the server did.
  await expect.poll(async () => (await debug(a)).you?.alive, { timeout: 8_000 }).toBe(true);
  for (const p of [a, b]) await p.context().close();
});
