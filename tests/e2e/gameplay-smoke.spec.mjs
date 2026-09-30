import { expect, test } from '@playwright/test';

import {
  bootGame,
  pulseGamepadButton,
  startMatch,
  tapGamepadButton,
} from './helpers/game.mjs';

test('PORT DM supports movement, weapon switching, automatic fire, and reload', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });

  const started = await page.evaluate(() => ({
    botCount: globalThis.__game.bots.length,
    mode: globalThis.__game.match.mode,
    running: globalThis.__game.match.running,
  }));
  expect(started).toMatchObject({ mode: 'dm', running: true });
  expect(started.botCount).toBeGreaterThan(0);

  const { beforeMove, afterMove } = await page.evaluate(() => {
    const game = globalThis.__game;
    const { body } = game.player;
    const before = { x: body.position.x, z: body.position.z };
    game.keys.KeyW = true;
    for (let i = 0; i < 60; i += 1) game.fixedStep(1 / 120);
    game.keys.KeyW = false;
    return {
      beforeMove: before,
      afterMove: { x: body.position.x, z: body.position.z },
    };
  });
  expect(Math.hypot(afterMove.x - beforeMove.x, afterMove.z - beforeMove.z)).toBeGreaterThan(0.25);

  const beforeFire = await page.evaluate(() => {
    globalThis.__game.player.cooldown = 0;
    return { ...globalThis.__game.player.ammo.pistol };
  });
  await tapGamepadButton(page, 7);
  const afterFire = await page.evaluate(() => ({ ...globalThis.__game.player.ammo.pistol }));
  const roundsFired = beforeFire.mag - afterFire.mag;

  // A semi-automatic trigger poll must spend exactly one round.
  expect(roundsFired).toBe(1);

  await pulseGamepadButton(page, 2);
  expect(await page.evaluate(() => globalThis.__game.player.reloading)).toBeGreaterThan(0);
  await page.evaluate(() => { globalThis.__game.player.reloading = 0.001; });
  await page.evaluate(() => globalThis.__testClock.pump(1));

  const afterReload = await page.evaluate(() => ({ ...globalThis.__game.player.ammo.pistol }));
  expect(afterReload.mag).toBe(15);
  expect(afterReload.reserve).toBe(beforeFire.reserve - roundsFired);

  await pulseGamepadButton(page, 13);
  expect(await page.evaluate(() => globalThis.__game.player.current)).toBe('ar');
});
