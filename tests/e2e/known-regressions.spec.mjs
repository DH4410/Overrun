import { expect, test } from '@playwright/test';

import { relativeDifference, runFixedStepSchedule } from '../support/render-rate.mjs';
import {
  APP_STATE,
  bootGame,
  observedAppState,
  pumpFrames,
  startMatch,
} from './helpers/game.mjs';

test('CORE-01: releasing pointer lock freezes the match clock', async ({ page }) => {
  await bootGame(page);
  await startMatch(page);
  expect(await observedAppState(page)).toBe(APP_STATE.PLAYING);
  expect(await page.evaluate(() => Boolean(document.pointerLockElement))).toBe(true);
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#pause')).toHaveClass(/\bon\b/);
  expect(await observedAppState(page)).toBe(APP_STATE.PAUSED);

  const before = await page.evaluate(() => globalThis.__game.match.timeLeft);
  await pumpFrames(page, 20);
  const after = await page.evaluate(() => globalThis.__game.match.timeLeft);

  expect(after).toBeCloseTo(before, 2);
});

test('CORE-01: settings opened during a match freeze gameplay', async ({ page }) => {
  await bootGame(page);
  await startMatch(page);
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#pause')).toHaveClass(/\bon\b/);
  expect(await observedAppState(page)).toBe(APP_STATE.PAUSED);
  await page.locator('#settings-open-pause').click();
  await expect(page.locator('#settings')).not.toHaveClass(/\bhidden\b/);
  // Let the asynchronous pointer-lock change settle. A settings click must not bubble through
  // the pause overlay and reacquire the pointer behind the visible panel.
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  expect(await observedAppState(page)).toBe(APP_STATE.SETTINGS);

  const before = await page.evaluate(() => globalThis.__game.match.timeLeft);
  await pumpFrames(page, 20);
  const after = await page.evaluate(() => globalThis.__game.match.timeLeft);

  expect(after).toBeCloseTo(before, 2);
});

test('CORE-02: player travel remains consistent at 60 and 30 render Hz', async ({ page }) => {
  await bootGame(page);
  await startMatch(page);

  const schedules = [60, 30].map((renderHz) => (
    runFixedStepSchedule({ renderHz, seconds: 10 }).stepsPerFrame
  ));
  const [at60, at30] = await page.evaluate(([schedule60, schedule30]) => {
    const game = globalThis.__game;
    game.match.running = false;
    game.world.gravity.set(0, 0, 0);
    game.player.body.collisionResponse = false;
    for (const bot of game.bots) bot.alive = false;

    const measure = (stepsPerFrame) => {
      game.player.body.position.set(0, 3, 0);
      game.player.body.velocity.set(0, 0, 0);
      game.player.yaw = 0;
      game.keys.KeyW = true;
      for (const steps of stepsPerFrame) {
        for (let i = 0; i < steps; i += 1) game.fixedStep(1 / 120);
      }
      game.keys.KeyW = false;
      return Math.hypot(game.player.body.position.x, game.player.body.position.z);
    };

    return [measure(schedule60), measure(schedule30)];
  }, schedules);

  expect(at60).toBeGreaterThan(40);
  expect(at30).toBeGreaterThan(25);
  expect(relativeDifference(at60, at30)).toBeLessThanOrEqual(0.05);
});

test('CORE-03: a cooked frag cannot damage or score from an allied bot in TDM', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'tdm' });
  expect(await observedAppState(page)).toBe(APP_STATE.PLAYING);

  const setup = await page.evaluate(() => {
    const game = globalThis.__game;
    const ally = game.bots.find((bot) => bot.team === game.player.team);
    const enemy = game.bots.find((bot) => bot.team !== game.player.team);
    for (const bot of game.bots) {
      bot.simStep = () => {};
      bot.renderStep = () => {};
      bot.body.position.set(30, 1, 30);
      bot.updateTransforms();
    }
    game.player.body.position.set(0, 0.5, 0);
    game.player.body.velocity.set(0, 0, 0);
    game.fixedStep(1 / 120);
    ally.body.position.set(2, 0.5, 0);
    ally.body.velocity.set(0, 0, 0);
    ally.updateTransforms();
    ally.pos.copy(game.player.eye);
    ally.pos.x += 0.1;
    ally.health = 10;
    ally.armor = 0;
    ally.invulnTimer = 0;
    enemy.body.position.set(3, 0.5, 0);
    enemy.body.velocity.set(0, 0, 0);
    enemy.updateTransforms();
    enemy.pos.copy(game.player.eye);
    enemy.pos.x += 0.2;
    enemy.health = 10;
    enemy.armor = 0;
    enemy.invulnTimer = 0;
    if (!game.losClear(
      game.player.eye.x, game.player.eye.y, game.player.eye.z,
      ally.pos.x, ally.pos.y, ally.pos.z,
    )) throw new Error('CORE-03 setup requires an unobstructed blast ray');
    if (!game.losClear(
      game.player.eye.x, game.player.eye.y, game.player.eye.z,
      enemy.pos.x, enemy.pos.y, enemy.pos.z,
    )) throw new Error('CORE-03 setup requires an unobstructed enemy blast ray');
    return {
      distance: enemy.pos.distanceTo(game.player.eye),
      enemyInCombatGraph: ally.enemyList().includes(enemy),
      particles: game.particlesAdd.active,
    };
  });
  expect(setup.distance).toBeLessThan(1);
  expect(setup.enemyInCombatGraph).toBe(true);
  const cooking = await page.evaluate(() => {
    globalThis.__game.keys.KeyG = false;
    // The deterministic gamepad is connected for input coverage. Keep its grenade button
    // held while the keyboard cook is active so pollGamepad() does not release the frag.
    globalThis.__testGamepad.setButton(4, true);
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG' }));
    return globalThis.__game.player.cooking;
  });
  expect(cooking).toBe('frag');
  await page.evaluate(() => { globalThis.__game.player.cookTime = 0; });
  await pumpFrames(page);
  expect(await page.evaluate(() => ({
    cooking: globalThis.__game.player.cooking,
    fragCount: globalThis.__game.player.fragCount,
  }))).toEqual({ cooking: null, fragCount: 2 });
  expect(await page.evaluate(() => globalThis.__game.particlesAdd.active)).toBeGreaterThan(setup.particles);
  await page.evaluate(() => {
    globalThis.__testGamepad.setButton(4, false);
    globalThis.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG' }));
  });

  const result = await page.evaluate(() => {
    const game = globalThis.__game;
    const ally = game.bots.find((bot) => bot.team === game.player.team && bot.body.position.x < 5);
    const enemy = game.bots.find((bot) => bot.team !== game.player.team && bot.body.position.x < 5);
    return {
      allyAlive: ally.alive,
      allyHealth: ally.health,
      blueScore: game.match.scoreA,
      enemyAlive: enemy.alive,
      enemyHealth: enemy.health,
    };
  });

  expect(result).toEqual({
    allyAlive: true,
    allyHealth: 10,
    blueScore: 1,
    enemyAlive: false,
    enemyHealth: 0,
  });
});

test('CORE-04: standing remains blocked underneath a low ceiling', async ({ page }) => {
  await bootGame(page);
  await startMatch(page);

  await page.keyboard.press('c');
  await pumpFrames(page);
  expect(await page.evaluate(() => globalThis.__game.player.crouching)).toBe(true);
  const clearanceRay = await page.evaluate(async () => {
    const game = globalThis.__game;
    const CANNON = await import('https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/+esm');
    const playerBody = game.player.body;
    // Reuse an indexed world body: SAPBroadphase does not mark its axis list dirty when a
    // body is added after the map has settled, which would make a synthetic body invisible
    // to the same world ray used by setCrouch().
    const ceiling = game.mapBodies.find((body) => {
      const half = body.shapes[0]?.halfExtents;
      return half && half.x >= 0.75 && half.y <= 0.2 && half.z >= 0.75 && body.position.y > 0.3;
    });
    if (!ceiling) throw new Error('CORE-04 setup requires a thin indexed map body');
    const ceilingHalfHeight = ceiling.shapes[0].halfExtents.y;
    ceiling.position.set(
      playerBody.position.x,
      playerBody.position.y + game.CONFIG.CROUCH_RADIUS + 0.06 + ceilingHalfHeight,
      playerBody.position.z,
    );
    ceiling.aabbNeedsUpdate = true;
    game.world.broadphase.dirty = true;
    const from = new CANNON.Vec3(
      playerBody.position.x,
      playerBody.position.y + game.CONFIG.CROUCH_RADIUS,
      playerBody.position.z,
    );
    const to = new CANNON.Vec3(from.x, from.y + 0.17, from.z);
    const result = new CANNON.RaycastResult();
    game.world.raycastClosest(from, to, {
      skipBackfaces: true,
      collisionFilterGroup: -1,
      collisionFilterMask: 1,
    }, result);
    return result.hasHit;
  });
  expect(clearanceRay).toBe(true);

  await page.keyboard.press('c');
  await pumpFrames(page, 2);
  const crouching = await page.evaluate(() => globalThis.__game.player.crouching);

  expect(crouching).toBe(true);
});
