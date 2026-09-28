import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * How bots MOVE. Each of these was a playtest report ("the AI lags and teleports when I aim",
 * "bots get stuck running into a wall") that the rest of the suite could not see, because a bot
 * vibrating on the spot or grinding into a crate still fights and scores correctly.
 */

/** Pump `seconds` of real frames at jittered 5-20 ms intervals, sampling every bot each frame. */
async function runCombat(page, seconds) {
  return page.evaluate((secs) => {
    const g = globalThis.__game;
    const { player, bots } = g;
    player.invulnTimer = 0;          // visible, so the bots engage
    player.health = 1e9;             // bots cannot fire anyway (startMatch sets fireCd = inf)
    player.body.position.set(0, 4.0, 0);
    bots.forEach((b, i) => {
      const a = (i / bots.length) * Math.PI * 2;
      b.body.position.set(Math.sin(a) * 6, 4.0, Math.cos(a) * 6);
      b.body.velocity.set(0, 0, 0);
      b.prevBodyPos.copy(b.body.position);
    });
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let t = 0, flips = 0, shootFrames = 0, slow = 0;
    const last = bots.map(() => 0);
    while (t < secs) {
      const dt = 5 + rnd() * 15;
      globalThis.__testClock.pump(1, dt);
      t += dt / 1000;
      bots.forEach((b, i) => {
        if (!b.alive) return;
        // Lateral wish in the bot's own frame: its sign is the strafe direction.
        const lat = b.wishVx * -Math.cos(b.yaw) + b.wishVz * Math.sin(b.yaw);
        if (Math.abs(lat) > 1 && Math.abs(last[i]) > 1 && Math.sign(lat) !== Math.sign(last[i])) flips++;
        last[i] = lat;
        if (b.state === 'SHOOT') {
          shootFrames++;
          if (Math.hypot(b.body.velocity.x, b.body.velocity.z) < 0.8) slow++;
        }
      });
    }
    return { flipsPerBotSec: flips / (secs * bots.length), slowShare: slow / Math.max(1, shootFrames), shootFrames };
  }, seconds);
}

test('a bot in a firefight strafes, instead of vibrating on the spot', async ({ page }) => {
  // Every deliberate strafe reversal passes through 0.6 m/s, which was also the "blocked"
  // test, so each flip triggered the next and a fighting bot locked into reversing every
  // physics step: 17-26 reversals a second, standing nearly still 74% of the time. Through an
  // ADS zoom that is exactly what lag and rubber-banding look like.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'medium' });
  const r = await runCombat(page, 15);
  expect(r.shootFrames).toBeGreaterThan(1000);
  expect(r.flipsPerBotSec).toBeLessThan(2.5);
  // A bot boxed in by the hub's cover walls and its edge holds still on purpose, so this varies
  // run to run (0.02-0.29 measured); the vibrating bug sat at 0.74.
  expect(r.slowShare).toBeLessThan(0.45);
});

test('two bots that bunch up ease apart instead of being flung', async ({ page }) => {
  // The separation push was added to the body velocity after the acceleration limit and read
  // back as the next step's starting velocity, so it compounded: ~+1 m/s per step at 1.5 m.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'medium' });
  const peak = await page.evaluate(() => {
    const [a, b] = globalThis.__game.bots;
    a.body.position.set(20, 0.8, 20);
    b.body.position.set(21.5, 0.8, 20);
    let top = 0;
    for (let i = 0; i < 40; i++) {
      for (const bot of [a, b]) {
        bot.body.velocity.set(i === 0 ? 0 : bot.body.velocity.x, bot.body.velocity.y, i === 0 ? 0 : bot.body.velocity.z);
        bot.setPlanarVelocity(0, 0);
        bot.applyLocomotion(1 / 120);
      }
      for (const bot of [a, b]) {
        bot.body.position.x += bot.body.velocity.x / 120;
        bot.body.position.z += bot.body.velocity.z / 120;
        top = Math.max(top, Math.hypot(bot.body.velocity.x, bot.body.velocity.z));
      }
    }
    return top;
  });
  // The push asks for at most SEP_STRENGTH * w = 1.3 m/s at 1.5 m apart.
  expect(peak).toBeLessThan(2.0);
});

/**
 * Send one bot along a route, following its own path exactly as the AI does, and report whether
 * it got there. Everyone else is parked out of the way so nothing but the level can stop it.
 */
async function runRoutes(page, routes) {
  return page.evaluate((list) => {
    const g = globalThis.__game;
    const { player, bots, THREE } = g;
    player.body.type = 4;                      // KINEMATIC: parked, out of every path
    player.body.position.set(0, 60, 0);
    bots.forEach((b, i) => {
      b.state = 'SPAWN';
      b.stateTime = -1e9;                      // SPAWN never hands over: the test drives it
      if (i > 0) { b.body.type = 4; b.body.position.set(200 + i * 5, 60, 200); }
    });
    const bot = bots[0];
    const results = [];
    for (const r of list) {
      const from = r.from ?? g.waypoints[r.fromNode].pos;
      const to = r.to ?? g.waypoints[r.toNode].pos;
      bot.body.position.set(from[0] ?? from.x, (from[1] ?? from.y) + 0.2, from[2] ?? from.z);
      bot.body.velocity.set(0, 0, 0);
      bot.prevBodyPos.copy(bot.body.position);
      const goal = new THREE.Vector3(to[0] ?? to.x, to[1] ?? to.y, to[2] ?? to.z);
      bot.repath(goal);
      const dist = Math.hypot(goal.x - bot.body.position.x, goal.z - bot.body.position.z);
      const budget = dist / 4 + 8;
      let t = 0, arrived = false, replans = 0;
      while (t < budget) {
        if (bot.followPath(6.6, 1 / 60)) {
          if (replans++ < 3) bot.repath(goal);
        }
        globalThis.__testClock.pump(1, 1000 / 60);
        t += 1 / 60;
        const p = bot.body.position;
        if (Math.hypot(goal.x - p.x, goal.z - p.z) < 2.0 && Math.abs(goal.y - p.y) < 1.2) { arrived = true; break; }
      }
      const p = bot.body.position;
      results.push({ name: r.name, arrived, t: +t.toFixed(1), at: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] });
    }
    return results;
  }, routes);
}

test('bots get round low walls, crates and ramps instead of running into them (warehouse)', async ({ page }) => {
  // Paths were straightened with rays ~1.7 m up, over every low wall and crate, so straightened
  // routes ran straight into them; and a path's first node was the nearest by distance even on
  // the far side of a wall. A bot on the wrong side of a low wall pressed into it forever.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'medium' });
  const results = await runRoutes(page, [
    { name: 'across the low wall', from: [-16, 0.8, -3], to: [-16, 0.9, -10] },
    { name: 'through the crate stack', from: [-7, 0.8, -16.5], to: [-7, 0.9, -25] },
    { name: 'round the tank', from: [-16.5, 0.8, 6], to: [-24.5, 0.9, 6] },
    { name: 'up a ramp onto the hub', from: [0, 0.8, -19], to: [0, 4.1, -3] },
    { name: 'plaza to corridor', from: [18, 0.8, -12], to: [-40, 0.9, 30] },
  ]);
  for (const r of results) expect(r.arrived, `${r.name}: ended at ${r.at} after ${r.t}s`).toBe(true);
});

test('bots get round Foundry mid instead of pressing into it', async ({ page }) => {
  // The mid platform is not a blocker, so the old grid put nodes INSIDE it.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'foundry', diff: 'medium' });
  const results = await runRoutes(page, [
    { name: 'south of mid to north of mid', from: [-3, 0.8, -9.5], to: [-3, 0.9, 9.5] },
    { name: 'onto mid', from: [2.6, 0.8, -16], to: [0, 2.4, 0] },
    { name: 'spawn to spawn', from: [0, 0.8, -27], to: [0, 0.9, 27] },
    { name: 'lane to lane', from: [-22, 0.8, 18], to: [22, 0.9, -18] },
  ]);
  for (const r of results) expect(r.arrived, `${r.name}: ended at ${r.at} after ${r.t}s`).toBe(true);
});

test('bots cross the dungeon corridor maze end to end', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'dungeon', diff: 'medium' });
  const routes = await page.evaluate(() => {
    const w = globalThis.__game.waypoints;
    // The pairs furthest apart along each axis: the longest walks the maze offers.
    const by = (f) => [...w.keys()].sort((a, b) => f(w[a].pos) - f(w[b].pos));
    const x = by((p) => p.x), z = by((p) => p.z), d = by((p) => p.x + p.z);
    return [
      { name: 'west to east', fromNode: x[0], toNode: x[x.length - 1] },
      { name: 'north to south', fromNode: z[0], toNode: z[z.length - 1] },
      { name: 'corner to corner', fromNode: d[0], toNode: d[d.length - 1] },
    ];
  });
  const results = await runRoutes(page, routes);
  for (const r of results) expect(r.arrived, `${r.name}: ended at ${r.at} after ${r.t}s`).toBe(true);
});

test('no navigation node sits inside a solid, and raised floors get nodes of their own', async ({ page }) => {
  // Foundry's mid platform is not a blocker, so the old flat grid put nodes INSIDE it and bots
  // pressed themselves against its side trying to reach them.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'foundry', diff: 'medium' });
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    // A standing body's column must be open: nothing between the node's floor and head height.
    const inside = g.waypoints.filter((w) => (
      !g.losClear(w.pos.x, w.floor + 0.2, w.pos.z, w.pos.x, w.floor + 1.8, w.pos.z)
      || !g.losClear(w.pos.x, w.floor + 1.8, w.pos.z, w.pos.x, w.floor + 0.2, w.pos.z)
    )).length;
    const onMid = g.waypoints.filter((w) => Math.abs(w.pos.x) < 6 && Math.abs(w.pos.z) < 6 && w.floor > 1.2).length;
    const underMid = g.waypoints.filter((w) => Math.abs(w.pos.x) < 6 && Math.abs(w.pos.z) < 5.5 && w.floor < 0.5).length;
    return { inside, onMid, underMid, total: g.waypoints.length };
  });
  expect(r.total).toBeGreaterThan(100);
  expect(r.inside).toBe(0);
  expect(r.underMid).toBe(0);
  expect(r.onMid).toBeGreaterThan(4);
});
