import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * Crouching as a dodge. Crouch always lowered the hitbox, but a bot's aim followed it down on
 * the very next shot, so dropping bought nothing; and with toggle-crouch on, every weapon swap
 * stood you back up.
 */
async function setup(page, diff = 'easy') {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff });
  await page.evaluate(() => {
    const g = globalThis.__game;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    g.step = (n) => { for (let i = 0; i < n; i++) g.fixedStep(1 / 120); };
  });
}

test('sprinting into a crouch slides you past sprint speed, then settles to a crouch walk', async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { player, keys, CONFIG } = g;
    g.settings.toggleCrouch = false;
    player.body.position.set(-30, 0.6, -30);
    player.body.velocity.set(0, 0, 0);
    player.yaw = Math.PI / 2;                      // forward is -x, along the open floor
    g.step(30);
    keys.KeyW = true; keys.ShiftLeft = true;
    g.step(120);
    const planar = () => Math.hypot(player.body.velocity.x, player.body.velocity.z);
    const sprint = planar();
    keys.KeyC = true;
    g.step(12);
    const slide = planar();
    const sliding = player.slideTime > 0;
    g.step(180);
    const settled = planar();
    keys.KeyW = false; keys.ShiftLeft = false; keys.KeyC = false;
    return { sprint, slide, sliding, settled, crouchWalk: CONFIG.WALK_SPEED * CONFIG.CROUCH_MULT };
  });
  expect(r.sprint).toBeGreaterThan(7);
  expect(r.sliding).toBe(true);
  expect(r.slide).toBeGreaterThan(r.sprint + 0.5);
  expect(r.settled).toBeLessThan(r.crouchWalk + 0.3);
});

test('a weapon swap keeps you crouched, and a respawn stands you up', async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { player } = g;
    g.settings.toggleCrouch = true;
    player.body.position.set(-30, 0.6, -30);
    g.step(30);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC' }));
    g.step(10);
    const crouched = player.crouching;
    g.switchWeapon(player.current === 'ar' ? 'pistol' : 'ar');
    g.step(10);
    const afterSwap = player.crouching;
    g.respawnPlayer(true, { x: -30, y: 0, z: -30 });
    g.step(10);
    return { crouched, afterSwap, afterRespawn: player.crouching };
  });
  expect(r.crouched).toBe(true);
  expect(r.afterSwap).toBe(true);
  expect(r.afterRespawn).toBe(false);
});

test('a bot aims where you were for a beat after you crouch, then finds you', async ({ page }) => {
  await setup(page, 'hard');
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { THREE, player, bots } = g;
    g.settings.toggleCrouch = false;
    const bot = bots[0];
    bot.aim.headBias = 0;                          // aim at the chest, so the offset is exact
    player.body.position.set(-30, 0.6, -30);
    player.body.velocity.set(0, 0, 0);
    player.invulnTimer = 0;
    g.step(30);
    const aimLift = () => bot.aimPoint(player, new THREE.Vector3()).y - player.pos.y;
    const hold = (n) => { for (let i = 0; i < n; i++) { bot.target = player; bot.simStep(1 / 120); } };
    hold(120);
    const settledStanding = aimLift();
    g.keys.KeyC = true; g.step(1);
    const justCrouched = aimLift();
    hold(12);                                      // 0.1 s
    const after100ms = aimLift();
    hold(120);                                     // 1.1 s
    const after1s = aimLift();
    g.keys.KeyC = false;
    return { settledStanding, justCrouched, after100ms, after1s };
  });
  expect(Math.abs(r.settledStanding)).toBeLessThan(0.01);
  // The chest drops 0.28 m; the bot is still aiming at where it was.
  expect(r.justCrouched).toBeGreaterThan(0.25);
  expect(r.after100ms).toBeGreaterThan(0.1);
  expect(r.after1s).toBeLessThan(0.02);
});
