import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

/**
 * How bots LOOK, as opposed to what they do. Every bug here passed the rest of the suite for
 * weeks, because a bot that is drawn backwards, crumpled on the floor or drifting after death
 * still fights, scores and dies correctly. Each test asserts the visible property directly.
 */

/** Freeze every bot in its idle pose, let the mixer pose it, and measure the rig. */
async function measureRigs(page) {
  await page.evaluate(() => {
    for (const b of globalThis.__game.bots) {
      b.state = 'SPAWN';
      b.stateTime = -1e9;               // SPAWN hands over to PATROL after 0.4 s otherwise
      b.setPlanarVelocity(0, 0);
      b.body.velocity.set(0, 0, 0);
    }
  });
  await pumpFrames(page, 20);
  return page.evaluate(() => {
    const g = globalThis.__game;
    const V = g.THREE.Vector3;
    return g.bots.filter((b) => b.alive && b.mesh.userData.mixer).map((b) => {
      const bones = {};
      b.mesh.traverse((o) => { if (o.isBone) bones[o.name.replace(/^mixamorig\d*[:_]?/i, '')] = o; });
      b.mesh.updateMatrixWorld(true);
      const at = (name) => new V().setFromMatrixPosition(bones[name].matrixWorld);
      const toes = new V();
      for (const side of ['Left', 'Right']) toes.add(at(`${side}ToeBase`).sub(at(`${side}Foot`)));
      toes.y = 0;
      toes.normalize();
      return {
        name: b.name,
        // Bot.yaw is measured so that (sin yaw, cos yaw) is the way the bot faces and moves.
        toesAlongHeading: toes.x * Math.sin(b.yaw) + toes.z * Math.cos(b.yaw),
        headAboveFeet: at('Head').y - at('LeftFoot').y,
      };
    });
  });
}

// DM draws from the solo cast and TDM from both team casts, so the pair covers every character.
for (const mode of ['dm', 'tdm']) {
  test(`every rigged bot is drawn facing the way it is heading (${mode})`, async ({ page }) => {
    // Mixamo characters face +Z and bots were rotated for a -Z model, so every converted
    // character was drawn backwards: toes against the heading at a dot product of -0.97. A bot
    // running at you moonwalked; one shooting at you had its back turned.
    await bootGame(page);
    await startMatch(page, { mode, map: 'port', diff: 'medium' });
    const rigs = await measureRigs(page);
    expect(rigs.length).toBeGreaterThan(2);
    for (const r of rigs) expect(r.toesAlongHeading, r.name).toBeGreaterThan(0.7);
  });

  test(`every rigged bot stands upright in its idle pose (${mode})`, async ({ page }) => {
    // The original three.js soldier, driven by the shared Mixamo clips, stood with its head
    // 0.3 m BELOW its feet — a heap on the floor while its Idle weight read 0.99. Every track
    // bound, so characters.spec.mjs could not see it.
    await bootGame(page);
    await startMatch(page, { mode, map: 'port', diff: 'medium' });
    for (const r of await measureRigs(page)) expect(r.headAboveFeet, r.name).toBeGreaterThan(1.3);
  });
}

test('a corpse stays where it fell, even with a grenade going off beside it', async ({ page }) => {
  // Corpses kept a dynamic body with collisions switched off, so gravity pulled them through
  // the floor, the fall-out guard teleported them to a spawn point in mid-air, and any frag
  // nearby launched them through the walls.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });

  const before = await page.evaluate(() => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    g.killCombatant(bot, g.player);
    const p = bot.body.position;
    return { x: p.x, y: p.y, z: p.z };
  });

  await pumpFrames(page, 150);             // 2.5 s: the old corpse was under the map by then

  await page.evaluate(({ x, y, z }) => {
    const g = globalThis.__game;
    g.throwGrenade(g.player, new g.THREE.Vector3(x + 0.6, y, z), new g.THREE.Vector3(0, -1, 0),
      0.1, 'frag', 0.05);
  }, before);
  await pumpFrames(page, 60);

  const after = await page.evaluate(() => {
    const p = globalThis.__game.bots[0].body.position;
    return { x: p.x, y: p.y, z: p.z, alive: globalThis.__game.bots[0].alive };
  });
  expect(after.alive).toBe(false);
  expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeLessThan(0.01);
});

test('bots are drawn between physics steps, not at the latest one', async ({ page }) => {
  // Physics runs at 120 Hz and frames do not line up with it, so drawing the raw body position
  // moved a bot an uneven distance every frame. Halfway into a step, the mesh sits halfway.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });

  const drawn = await page.evaluate(() => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    bot.prevBodyPos.set(0, 1, 0);
    bot.body.position.set(0.2, 1, 0);
    bot.renderStep(1 / 60, 0.5);
    return bot.mesh.position.x;
  });
  expect(drawn).toBeCloseTo(0.1, 5);
});
