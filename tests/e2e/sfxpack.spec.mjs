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
  test.setTimeout(150_000);
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

test('every gun has its own clicks and reload sounds, and the world answers shots', async ({ page }) => {
  test.setTimeout(150_000);
  await bootGame(page);
  const manifest = await page.evaluate(async () => (await fetch('/assets/audio/manifest.json')).json());
  const GUNS = ['pistol', 'mp', 'smg', 'revolver', 'ar', 'dmr', 'ashotgun', 'shotgun', 'lmg', 'sniper'];
  const missing = [];
  for (const g of GUNS) for (const k of ['empty', 'equip', 'reloadclick', 'lowammo']) if (!manifest.clips[`${k}_${g}`]?.length) missing.push(`${k}_${g}`);
  for (const n of ['casing_brass', 'casing_shell', 'impact_concrete', 'impact_metal', 'impact_dirt', 'impact_wood', 'whiz', 'nade_far', 'ads_in', 'ads_out', 'crouch', 'stand', 'spawn']) {
    if (!manifest.clips[n]?.length) missing.push(n);
  }
  expect(missing).toEqual([]);
  expect(Object.keys(manifest.clips).filter((n) => n.startsWith('foley_') && n.split('_').length === 3).length).toBeGreaterThanOrEqual(30);
  expect(Object.keys(manifest.clips).filter((n) => n.startsWith('ambience_')).length).toBeGreaterThanOrEqual(6);
  expect(manifest.music.lobby.length + manifest.music.shop.length).toBeGreaterThanOrEqual(10);

  await page.evaluate(() => {
    const { Audio, settings, applySettings } = globalThis.__game;
    Audio.init();
    settings.soundPack = true;
    applySettings();
  });
  await expect.poll(() => page.evaluate(() => globalThis.__game.Audio.packStats().names), { timeout: 90_000 }).toBe(Object.keys(manifest.clips).length);

  const out = await page.evaluate(() => {
    const { Audio } = globalThis.__game;
    const ctx = Audio.ctx;
    let oscillators = 0, loops = 0;
    const mo = ctx.createOscillator.bind(ctx), mk = ctx.createBufferSource.bind(ctx);
    ctx.createOscillator = () => { oscillators++; return mo(); };
    ctx.createBufferSource = () => { const s = mk(); Object.defineProperty(s, 'loop', { set(v) { if (v) loops++; }, get() { return false; } }); return s; };
    const played = [];
    for (const g of ['pistol', 'lmg', 'sniper']) played.push(Audio.cue('empty', g), Audio.cue('empty', g));
    Audio.equip('shotgun'); Audio.reloadClick('revolver'); Audio.lowAmmo('ar');
    Audio.reloadProgress('lmg', 0, 1); Audio.reloadProgress('shotgun', 0, 1);
    const impact = Audio.impact({ x: 3, y: 1, z: 3 });
    const whiz = Audio.whiz({ x: 1, y: 1.5, z: 1 });
    Audio.ambient = () => 'wind';
    Audio.startAmbient();
    return { played, impact, whiz, oscillators, loops };
  });
  expect(out.played.every(Boolean)).toBe(true);
  expect(out.impact).toBe(true);
  expect(out.whiz).toBe(true);
  expect(out.loops).toBe(2);          // the game's own noise rumble, plus the map's recorded ambience loop
  // The only synthesized sound left is the ambient rumble the game always runs underneath.
  expect(out.oscillators).toBe(0);
});
