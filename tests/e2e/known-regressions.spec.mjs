import { expect, test } from '@playwright/test';

import { relativeDifference, runFixedStepSchedule } from '../support/render-rate.mjs';
import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

test('CORE-01: releasing pointer lock freezes the match clock', async ({ page }) => {
  await bootGame(page);
  await startMatch(page);
  expect(await page.evaluate(() => Boolean(document.pointerLockElement))).toBe(true);
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#pause')).toHaveClass(/\bon\b/);

  const before = await page.evaluate(() => globalThis.__game.match.timeLeft);
  await pumpFrames(page, 20);
  const after = await page.evaluate(() => globalThis.__game.match.timeLeft);

  test.fail(true, 'Expected failure until Claude CORE-01 app-state changes are integrated.');
  expect(after).toBeCloseTo(before, 2);
});

test('CORE-01: settings opened during a match freeze gameplay', async ({ page }) => {
  await bootGame(page);
  await startMatch(page);
  await page.evaluate(() => document.querySelector('#settings-open-pause').click());
  await expect(page.locator('#settings')).not.toHaveClass(/\bhidden\b/);

  const before = await page.evaluate(() => globalThis.__game.match.timeLeft);
  await pumpFrames(page, 20);
  const after = await page.evaluate(() => globalThis.__game.match.timeLeft);

  test.fail(true, 'Expected failure until Claude CORE-01 settings-state changes are integrated.');
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
  test.fail(true, 'Expected failure until Claude CORE-02 simulation-clock changes are integrated.');
  expect(relativeDifference(at60, at30)).toBeLessThanOrEqual(0.05);
});

test('CORE-03: a cooked frag cannot damage or score from an allied bot in TDM', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'tdm' });

  await page.evaluate(() => {
    const game = globalThis.__game;
    const ally = game.bots.find((bot) => bot.team === game.player.team);
    const enemy = game.bots.find((bot) => bot.team !== game.player.team);
    for (const bot of game.bots) {
      bot.update = () => {};
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
  });
  const cooking = await page.evaluate(() => {
    globalThis.__game.keys.KeyG = false;
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
  await page.evaluate(() => globalThis.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG' })));

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

  test.fail(true, 'Expected failure until Claude CORE-03 friendly-fire rules are integrated.');
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
  await page.evaluate(() => {
    const game = globalThis.__game;
    const playerBody = game.player.body;
    const boxShape = game.mapBodies.find((body) => body.shapes[0]?.halfExtents)?.shapes[0];
    const Body = playerBody.constructor;
    const Box = boxShape.constructor;
    const Vec3 = boxShape.halfExtents.constructor;
    const ceiling = new Body({ mass: 0, shape: new Box(new Vec3(0.75, 0.1, 0.75)) });
    ceiling.position.set(playerBody.position.x, 0.92, playerBody.position.z);
    game.world.addBody(ceiling);
  });

  await page.keyboard.press('c');
  await pumpFrames(page, 2);
  const crouching = await page.evaluate(() => globalThis.__game.player.crouching);

  test.fail(true, 'Expected failure until Claude CORE-04 stand-clearance changes are integrated.');
  expect(crouching).toBe(true);
});
