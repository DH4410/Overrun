import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

test('hold B, point at an emote, let go: the player dances in third person until they move', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => { for (const b of globalThis.__game.bots) b.fireCd = Infinity; });
  await pumpFrames(page, 20);

  // The match music is running and the audio graph is up.
  expect(await page.evaluate(() => globalThis.__game.Audio._song?.kind)).toBe('match');

  await page.keyboard.down('KeyB');
  await expect(page.locator('#emote-wheel')).toHaveClass(/on/);
  await page.evaluate(() => globalThis.__game.emotes.load());
  await expect(page.locator('.ew-slot:not(.off)')).toHaveCount(8);
  // Straight up is the first slot. The wheel eats the movement, so the view does not turn.
  const yaw = await page.evaluate(() => {
    const y = globalThis.__game.player.yaw;
    globalThis.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: -90 }));
    return y;
  });
  await expect(page.locator('.ew-slot.on')).toHaveText('Wave');
  await page.keyboard.up('KeyB');
  await expect(page.locator('#emote-wheel')).not.toHaveClass(/on/);

  await pumpFrames(page, 30);
  const dancing = await page.evaluate(() => {
    const g = globalThis.__game;
    const p = g.player.body.position;
    return {
      active: g.emotes.active,
      emoting: document.body.classList.contains('emoting'),
      song: g.Audio._song?.kind,
      camAway: Math.hypot(g.camera.position.x - p.x, g.camera.position.z - p.z),
      yaw: g.player.yaw,
    };
  });
  expect(dancing.active).toBe('wave');
  expect(dancing.emoting).toBe(true);
  expect(dancing.song).toBe('emote');
  expect(dancing.camAway).toBeGreaterThan(0.7);
  expect(dancing.yaw).toBeCloseTo(yaw, 5);

  // Walking off ends it and puts the first-person camera back.
  await page.keyboard.down('KeyW');
  await pumpFrames(page, 20);
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => {
    const g = globalThis.__game;
    const p = g.player.body.position;
    return {
      active: g.emotes.active,
      emoting: document.body.classList.contains('emoting'),
      song: g.Audio._song?.kind,
      camAway: Math.hypot(g.camera.position.x - p.x, g.camera.position.z - p.z),
    };
  });
  expect(after.active).toBeNull();
  expect(after.emoting).toBe(false);
  expect(after.song).toBe('match');
  expect(after.camAway).toBeLessThan(0.2);
});

test('the match ending mid-dance stops it without bringing the match music back', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => { for (const b of globalThis.__game.bots) b.fireCd = Infinity; });
  await pumpFrames(page, 5);
  await page.keyboard.down('KeyB');
  await page.evaluate(() => globalThis.__game.emotes.load());
  await page.evaluate(() => globalThis.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: -90 })));
  await page.keyboard.up('KeyB');
  await pumpFrames(page, 5);
  expect(await page.evaluate(() => globalThis.__game.emotes.active)).toBe('wave');

  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.kills = g.CONFIG.DM_TARGET - 1;
    const bot = g.bots[0]; bot.health = 0;
    g.killCombatant(bot, g.player, false);
  });
  await pumpFrames(page, 5);
  const s = await page.evaluate(() => ({
    active: globalThis.__game.emotes.active,
    song: globalThis.__game.Audio._song?.kind ?? null,
  }));
  expect(s.active).toBeNull();
  expect(s.song).toBeNull();
});

test('the emote wheel cannot open from the lobby', async ({ page }) => {
  await bootGame(page);
  await page.keyboard.down('KeyB');
  await pumpFrames(page, 2);
  await expect(page.locator('#emote-wheel')).not.toHaveClass(/on/);
  await page.keyboard.up('KeyB');
});
