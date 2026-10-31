import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

// The recorded sound pack and the menu music are opt-in: with their settings off the game must not
// so much as ask for a file under assets/audio. Turned on, the manifest and every clip it names must
// load, and the game's own sound methods must play them.

const audioRequests = (page) => {
  const urls = [];
  page.on('request', (r) => { if (r.url().includes('/assets/audio/')) urls.push(new URL(r.url()).pathname); });
  return urls;
};

test('nothing under assets/audio is fetched while the settings are off', async ({ page }) => {
  const urls = audioRequests(page);
  await bootGame(page);
  await startMatch(page, {});
  await page.evaluate(() => {
    const { Audio, settings } = globalThis.__game;
    if (settings.soundPack || settings.menuMusic) throw new Error('the pack settings must default to off');
    Audio.init();
    Audio.gunshot('ar');
    Audio.step();
    Audio.menuMusic?.('lobby');
    if (Audio.cue('ui_click')) throw new Error('cue() played with the pack off');
  });
  await page.waitForTimeout(1500);
  expect(urls).toEqual([]);
});

test('switching the pack on loads 100+ sounds and the game plays them', async ({ page }) => {
  const urls = audioRequests(page);
  await bootGame(page);
  await page.evaluate(() => {
    const { Audio, settings, applySettings } = globalThis.__game;
    Audio.init();
    settings.soundPack = true;
    applySettings();
  });
  const manifest = await page.evaluate(async () => (await fetch('/assets/audio/manifest.json')).json());
  const names = Object.keys(manifest.clips);
  const files = Object.values(manifest.clips).flat();
  expect(names.length).toBeGreaterThanOrEqual(100);
  expect(files.length).toBeGreaterThanOrEqual(names.length);

  // Every file the manifest names exists, and is a real Ogg Vorbis stream. (Fetched outside the page, so
  // the music files are not counted as the game asking for them below.)
  const bad = [];
  for (const f of [...files, ...Object.values(manifest.music).flat()]) {
    const r = await page.request.get(`/assets/audio/${f}`);
    const head = (await r.body()).subarray(0, 4).toString();
    if (!r.ok() || head !== 'OggS') bad.push(`${f}: ${r.status()} ${head}`);
  }
  expect(bad).toEqual([]);

  // The game decodes all of them, and none of the music (menuMusic is still off).
  await page.waitForFunction((n) => globalThis.__game.Audio.packStats().clips >= n, files.length, { timeout: 60_000 });
  expect(await page.evaluate(() => globalThis.__game.Audio.packStats().names)).toBe(names.length);
  expect(urls.some((u) => u.includes('/music/'))).toBe(false);

  const played = await page.evaluate(() => {
    const { Audio } = globalThis.__game;
    let sources = 0, oscillators = 0;
    const ctx = Audio.ctx;
    const mk = ctx.createBufferSource.bind(ctx), mo = ctx.createOscillator.bind(ctx);
    ctx.createBufferSource = () => { sources++; return mk(); };
    ctx.createOscillator = () => { oscillators++; return mo(); };
    Audio.gunshot('ar');
    Audio.gunshot('sniper', { x: 30, y: 1, z: 0 });
    Audio.step();
    Audio.hit('ar');
    Audio.explosion({ x: 5, y: 1, z: 5 });
    const cues = ['jump', 'land', 'empty', 'ui_click', 'ui_buy', 'die', 'level_up'].map((c) => Audio.cue(c));
    Audio.cue('reveal', 'legendary');
    Audio.cue('item_start', 'bandage');
    return { sources, oscillators, cues };
  });
  expect(played.cues.every(Boolean)).toBe(true);
  expect(played.oscillators).toBe(0);                 // the recordings replaced the synthesized sounds
  expect(played.sources).toBeGreaterThanOrEqual(8);
});

test('menu music loads only when switched on, and follows the page', async ({ page }) => {
  const urls = audioRequests(page);
  await bootGame(page);
  await page.evaluate(() => globalThis.__game.Audio.init());
  await page.waitForTimeout(500);
  expect(urls).toEqual([]);
  await page.evaluate(() => {
    const { Audio, settings, applySettings } = globalThis.__game;
    settings.menuMusic = true;
    applySettings();
    Audio.menuMusic('shop');
  });
  await expect.poll(() => urls.filter((u) => u.includes('/music/shop_')).length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(urls.some((u) => u.includes('/sfx/'))).toBe(false);         // the effects stay off
  await page.evaluate(() => globalThis.__game.settings.menuMusic = false);
  await page.evaluate(() => globalThis.__game.applySettings());
});

test('a missing pack falls back to the synthesized sounds', async ({ page }) => {
  await page.route('**/assets/audio/**', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await bootGame(page);
  const out = await page.evaluate(async () => {
    const { Audio, settings, applySettings } = globalThis.__game;
    Audio.init();
    settings.soundPack = true;
    applySettings();
    await new Promise((r) => setTimeout(r, 800));
    let oscillators = 0;
    const mo = Audio.ctx.createOscillator.bind(Audio.ctx);
    Audio.ctx.createOscillator = () => { oscillators++; return mo(); };
    Audio.gunshot('pistol');
    return { cue: Audio.cue('ui_click'), oscillators };
  });
  expect(out.cue).toBe(false);
  expect(out.oscillators).toBeGreaterThan(0);
});
