import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * How bots fight like people: each carries a sidearm and draws it when the rifle runs dry or the
 * range stops suiting the gun, crouches to brace a shot, turns on whoever shoots it, and has a
 * personality of its own. Staged with bot 0 squared up to the player at 9 m on Port.
 */
async function stage(page, setup = {}) {
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate((setup) => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    const p = g.player.body.position;
    for (const other of g.bots.slice(1)) other.body.position.set(p.x - 60, p.y, p.z);   // out of the way
    bot.body.position.set(p.x + 9, p.y, p.z);
    bot.yaw = -Math.PI / 2;
    bot.updateTransforms();
    bot.target = g.player;
    bot.fireCd = 0;                                  // startMatch parks it at Infinity
    g.player.invulnTimer = 0;
    g.player.health = 1e6;                           // this is about the bot, not about dying
    if (setup.style) bot.style = { ...bot.style, ...setup.style };
    if (setup.slots) {
      bot.slots = setup.slots.map((id) => ({ id, mag: globalThis.__game.WEAPON_BY_ID?.[id]?.mag ?? 30, mesh: null }));
      bot.slots[0].mesh = bot.gunMesh;
      bot.slot = 0;
      bot.weaponId = setup.slots[0];
      bot.mag = bot.slots[0].mag;
    }
  }, setup);
}

const botState = (page) => page.evaluate(() => {
  const b = globalThis.__game.bots[0];
  return {
    slot: b.slot, weapon: b.weaponId, mag: b.mag, reloading: b.reloading, crouching: b.crouching,
    crouchW: b.crouchW, state: b.state, eyeY: b.eye.y, footY: b.body.position.y, speed: Math.hypot(b.body.velocity.x, b.body.velocity.z),
    guns: b.slots.map((s) => s.id), styleName: b.styleName,
  };
});

test('every bot has a personality and a sidearm', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'medium' });
  const all = await page.evaluate(() => globalThis.__game.bots.map((b) => ({ style: b.styleName, guns: b.slots.map((s) => s.id), cur: b.weaponId })));
  expect(all.length).toBeGreaterThan(2);
  for (const b of all) {
    expect(['rusher', 'anchor', 'skirmisher', 'flanker']).toContain(b.style);
    expect(b.guns).toHaveLength(2);
    expect(b.guns[0]).not.toBe(b.guns[1]);
    expect(b.cur).toBe(b.guns[0]);
  }
  expect(errors).toEqual([]);
});

test('a duel pins the loadout: one gun, no switching', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'port' });
  const duel = await page.evaluate(() => globalThis.__game.bots.map((b) => b.slots.length));
  expect(duel.length).toBeGreaterThan(0);
  expect(duel.every((n) => n === 1)).toBe(true);
});

test('out of rounds in a fight, a bot draws its sidearm instead of reloading in the open', async ({ page }) => {
  await bootGame(page);
  await stage(page, { slots: ['ar', 'pistol'], style: { switchy: 1 } });
  await page.evaluate(() => { const b = globalThis.__game.bots[0]; b.mag = 1; b.slots[0].mag = 1; b.reactTimer = 0; });
  let seen = null;
  for (let i = 0; i < 40 && !seen; i++) {
    await pumpFrames(page, 15);
    const s = await botState(page);
    if (s.slot === 1) seen = s;
  }
  expect(seen).not.toBeNull();
  expect(seen.weapon).toBe('pistol');
  expect(seen.reloading).toBe(0);
});

test('a bot draws the gun that suits the range: the pistol up close, not a sniper rifle', async ({ page }) => {
  await bootGame(page);
  await stage(page, { slots: ['sniper', 'smg'], style: { switchy: 1, range: 1 } });
  await page.evaluate(() => {
    const g = globalThis.__game; const b = g.bots[0]; const p = g.player.body.position;
    b.body.position.set(p.x + 4, p.y, p.z);     // well inside a sniper's band
    b.updateTransforms(); b.reactTimer = 0;
  });
  let drew = null;
  for (let i = 0; i < 60 && !drew; i++) {
    await pumpFrames(page, 15);
    const s = await botState(page);
    if (s.slot === 1) drew = s;
  }
  expect(drew).not.toBeNull();
  expect(drew.weapon).toBe('smg');
});

test('a bot goes down on a knee to brace a shot, lowers its eye and head, and stands when hit', async ({ page }) => {
  await bootGame(page);
  // Always crouches at this range, so the test does not wait on a dice roll.
  await stage(page, { slots: ['ar', 'pistol'], style: { crouchy: 5, range: 0.4 } });
  await page.evaluate(() => { const b = globalThis.__game.bots[0]; b.reactTimer = 0; b.crouchCd = 0; });
  const standing = await botState(page);
  const standHead = await page.evaluate(() => globalThis.__game.bots[0].headPoint(new globalThis.__game.camera.position.constructor()).y - globalThis.__game.bots[0].body.position.y);
  let down = null;
  for (let i = 0; i < 60 && !down; i++) {
    await pumpFrames(page, 10);
    const s = await botState(page);
    if (s.crouching && s.crouchW > 0.9) down = s;
  }
  expect(down).not.toBeNull();
  expect(down.speed).toBeLessThan(1);                                    // planted, not sliding
  expect(standing.eyeY - standing.footY - (down.eyeY - down.footY)).toBeGreaterThan(0.25);
  await pumpFrames(page, 20);
  const crouchHead = await page.evaluate(() => globalThis.__game.bots[0].headPoint(new globalThis.__game.camera.position.constructor()).y - globalThis.__game.bots[0].body.position.y);
  expect(standHead - crouchHead).toBeGreaterThan(0.2);                   // the hitbox follows the pose

  // Hit while down: up and moving.
  await page.evaluate(() => {
    const g = globalThis.__game; const b = g.bots[0];
    b.lastHurtBy = g.player; b.health -= 8;
  });
  await pumpFrames(page, 3);
  expect((await botState(page)).crouching).toBe(false);
});

test('shot from behind while patrolling, a bot turns round on whoever did it', async ({ page }) => {
  await bootGame(page);
  await stage(page);
  await page.evaluate(() => {
    const g = globalThis.__game; const b = g.bots[0];
    b.state = 'PATROL'; b.stateTime = 0; b.target = null; b.hasLOS = false;
    b.yaw = Math.PI / 2;                              // facing away from the player (who is at -x)
    b.invulnTimer = 0;
    b.lastHurtBy = g.player; b.health -= 10;
    b.losTimer = 99;                                  // it must work out where from by being hit, not by seeing
  });
  await pumpFrames(page, 2);
  expect(await page.evaluate(() => globalThis.__game.bots[0].state)).toBe('ALERT');
  await pumpFrames(page, 45);
  const yawErr = await page.evaluate(() => {
    const g = globalThis.__game; const b = g.bots[0];
    const want = Math.atan2(g.player.pos.x - b.body.position.x, g.player.pos.z - b.body.position.z);
    let d = want - b.yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  });
  expect(yawErr).toBeLessThan(0.5);
});
