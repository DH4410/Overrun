import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/** Park the bots and run the simulation directly, so only the player and the level move. */
async function setup(page) {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  await page.evaluate(() => {
    const g = globalThis.__game;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    g.step = (n) => { for (let i = 0; i < n; i++) g.fixedStep(1 / 120); };
  });
}

test('the head collides: jumping under an overhang cannot put the camera through it', async ({ page }) => {
  // Only a sphere at the feet collided, with the camera 1.6 m above it. Jumping under a ramp
  // put the camera through the slab and onto the top.
  await setup(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { player, keys } = g;
    player.body.position.set(-30, 0.6, -30);
    player.body.velocity.set(0, 0, 0);
    g.step(30);
    const floor = player.body.position.y - 0.5;
    // Reuse an indexed catwalk slab (see CORE-04 on why a new body would be invisible to SAP).
    const slab = g.mapBodies.find((b) => {
      const h = b.shapes[0]?.halfExtents;
      return h && h.y <= 0.21 && h.x >= 1.4 && h.z >= 1.4 && b.position.y > 3;
    });
    slab.position.set(-30, floor + 2.7 + slab.shapes[0].halfExtents.y, -30);
    slab.aabbNeedsUpdate = true;
    g.world.broadphase.dirty = true;
    keys.Space = true; g.step(2); keys.Space = false;
    let maxEye = 0;
    for (let i = 0; i < 150; i++) { g.step(1); maxEye = Math.max(maxEye, player.body.position.y + g.CONFIG.EYE_HEIGHT - floor); }
    return { maxEye, endHeight: player.body.position.y - floor };
  });
  expect(r.maxEye).toBeLessThan(2.7 - 0.02);
  expect(r.endHeight).toBeLessThan(0.6);          // back on the floor, not on top of the slab
});

test('jumps are a quick committed hop, and movement has weight', async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { player, keys } = g;
    player.body.position.set(-20, 0.6, -30);
    player.body.velocity.set(0, 0, 0);
    g.step(60);
    const y0 = player.body.position.y;
    keys.Space = true; g.step(2); keys.Space = false;
    let apex = y0, air = 0;
    for (let i = 0; i < 240; i++) {
      g.step(1);
      apex = Math.max(apex, player.body.position.y);
      if (!player.grounded) air++;
      if (player.grounded && i > 10) break;
    }
    g.step(30);
    player.yaw = Math.PI / 2;
    keys.KeyW = true;
    let tFull = null;
    for (let i = 0; i < 120; i++) {
      g.step(1);
      if (tFull === null && Math.hypot(player.body.velocity.x, player.body.velocity.z) > 4.75) tFull = (i + 1) / 120;
    }
    keys.KeyW = false;
    let tStop = null;
    for (let i = 0; i < 120; i++) {
      g.step(1);
      if (tStop === null && Math.hypot(player.body.velocity.x, player.body.velocity.z) < 0.1) tStop = (i + 1) / 120;
    }
    return { apex: apex - y0, airTime: air / 120, tFull, tStop };
  });
  // High enough for the 1.15 m warehouse perch steps, and not the old 0.96 s float.
  expect(r.apex).toBeGreaterThan(1.18);
  expect(r.apex).toBeLessThan(1.4);
  expect(r.airTime).toBeLessThan(0.85);
  // Old movement reached full speed and stopped dead in ~50 ms. Quick, but not instant.
  expect(r.tFull).toBeGreaterThan(0.1);
  expect(r.tFull).toBeLessThan(0.3);
  expect(r.tStop).toBeGreaterThan(0.1);
  expect(r.tStop).toBeLessThan(0.35);
});

test('you stand as tall as the bots you fight, and a respawn moves your eye with you', async ({ page }) => {
  // The eye was 2.1 m up and the hitbox 2.3 m tall, a head above the 2 m bots, so up close
  // every opponent looked a size smaller than you.
  await setup(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const { player, keys } = g;
    player.body.position.set(-30, 0.6, -30);
    player.body.velocity.set(0, 0, 0);
    g.step(60);
    const floor = player.body.position.y - 0.5;
    const top = (p) => p.pos.y + p.hb.headY + p.hb.headR;
    const stand = { eye: player.eye.y - floor, top: top(player) - floor };
    g.settings.toggleCrouch = false;
    keys.KeyC = true; g.step(30);
    const crouch = { eye: player.eye.y - floor, top: top(player) - floor };
    keys.KeyC = false; g.step(30);
    g.respawnPlayer(true, { x: 12, y: 0, z: -24 });
    return { stand, crouch, respawnEye: [player.eye.x, player.eye.z] };
  });
  expect(r.stand.eye).toBeCloseTo(1.8, 1);
  expect(r.stand.top).toBeGreaterThan(1.9);
  expect(r.stand.top).toBeLessThan(2.1);
  expect(r.crouch.eye).toBeCloseTo(1.15, 1);
  expect(r.crouch.top).toBeLessThan(r.stand.top - 0.5);
  expect(r.respawnEye[0]).toBeCloseTo(12, 5);
  expect(r.respawnEye[1]).toBeCloseTo(-24, 5);
});
