import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

/**
 * Thrown ordnance physics. These assert behaviour a player can feel — a running throw goes
 * further, a tap lands short, a spent grenade stops rolling — rather than exact
 * distances, which any retune is free to change.
 */

/**
 * Find an origin with a clear run of open floor ahead of it, and throw from there.
 *
 * The arena centre is not open — it has props — so throwing from (0, 2, 0) and measuring
 * how far the grenade travelled measured how far away the nearest crate was. The scan
 * checks the throw corridor at two heights so neither a low crate nor an overhead catwalk
 * can quietly truncate the flight.
 */
async function openOrigin(page, reach = 20) {
  return page.evaluate((r) => {
    const g = globalThis.__game;
    for (let x = -30; x <= 30; x += 2) {
      for (let z0 = -32; z0 + r <= 32; z0 += 2) {
        const ok = g.losClear(x, 2.0, z0, x, 2.0, z0 + r)
          && g.losClear(x, 0.5, z0, x, 0.5, z0 + r)
          && g.losClear(x, 2.0, z0, x, 0.5, z0 + r);
        if (ok) return { x, y: 2.0, z: z0 };
      }
    }
    return null;
  }, reach);
}

/** Throw one grenade down a verified-open corridor and report where it comes to rest. */
async function throwFrom(page, { dir, power, throwerVel = [0, 0, 0], steps = 420, at }) {
  return page.evaluate(({ d, p, tv, n, o }) => {
    const g = globalThis.__game;
    const owner = { body: { velocity: { x: tv[0], y: tv[1], z: tv[2] } }, team: 0 };
    const origin = new g.THREE.Vector3(o.x, o.y, o.z);
    const direction = new g.THREE.Vector3(d[0], d[1], d[2]).normalize();
    // A long fuse: this measures flight and roll, not the explosion.
    const nade = g.throwGrenade(owner, origin, direction, p, 'smoke', 999);
    const launch = {
      x: nade.body.velocity.x, y: nade.body.velocity.y, z: nade.body.velocity.z,
    };
    for (let i = 0; i < n; i++) g.fixedStep(1 / 120);
    const rest = { x: nade.body.position.x, y: nade.body.position.y, z: nade.body.position.z };
    const speed = Math.hypot(nade.body.velocity.x, nade.body.velocity.z);
    g.clearGrenades();
    return {
      launch,
      rest,
      speed,
      travel: Math.hypot(rest.x - origin.x, rest.z - origin.z),
    };
  }, { d: dir, p: power, tv: throwerVel, n: steps, o: at });
}

test('a grenade inherits the thrower velocity', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const at = await openOrigin(page, 22);
  expect(at, 'needs an open 22 m throwing corridor').not.toBeNull();

  const still = await throwFrom(page, { dir: [0, 0.18, 1], power: 14, at });
  const running = await throwFrom(page, { dir: [0, 0.18, 1], power: 14, throwerVel: [0, 0, 6], at });
  const backing = await throwFrom(page, { dir: [0, 0.18, 1], power: 14, throwerVel: [0, 0, -6], at });

  // The launch velocity is the direct evidence; travel is the consequence.
  expect(running.launch.z).toBeGreaterThan(still.launch.z + 5);
  expect(backing.launch.z).toBeLessThan(still.launch.z - 5);
  expect(running.travel).toBeGreaterThan(still.travel);
  expect(backing.travel).toBeLessThan(still.travel);
});

/** Stand the player at `at` facing +z, press G for `frames` frames, and report where it lands. */
async function throwWithG(page, at, frames) {
  await page.evaluate((o) => {
    const g = globalThis.__game;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    g.player.body.position.set(o.x, 0.6, o.z);
    g.player.body.velocity.set(0, 0, 0);
    g.player.yaw = Math.PI;                   // forward is (-sin yaw, -cos yaw) = +z
    g.player.pitch = 0.15;
    g.player.fragCount = 3;
    for (let i = 0; i < 30; i++) g.fixedStep(1 / 120);
  }, at);
  await page.keyboard.down('g');
  await pumpFrames(page, frames);
  const predicted = await page.evaluate(() => globalThis.__game.player.cooking && true);
  await page.keyboard.up('g');
  return page.evaluate(({ o, held }) => {
    const g = globalThis.__game;
    const nade = g.grenades.at(-1);
    const from = nade.body.position.clone();
    for (let i = 0; i < 300; i++) g.fixedStep(1 / 120);   // 2.5 s: inside the 3 s fuse
    const p = nade.body.position;
    return { held, from: [from.x, from.z], travel: Math.hypot(p.x - o.x, p.z - o.z) };
  }, { o: at, held: predicted });
}

test('a tap of G lobs a grenade short, and holding it throws it far', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  const at = await openOrigin(page, 22);
  expect(at, 'needs an open 22 m throwing corridor').not.toBeNull();

  const tap = await throwWithG(page, at, 1);
  const hold = await throwWithG(page, at, 70);   // past the 0.9 s full charge
  expect(tap.held && hold.held).toBe(true);
  expect(hold.travel).toBeGreaterThan(16);
  expect(tap.travel).toBeLessThan(hold.travel * 0.45);
  // Short, but it still has to clear your own feet.
  expect(tap.travel).toBeGreaterThan(1.5);
});

test('the arc drawn while charging is where the grenade first lands', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  const at = await openOrigin(page, 22);
  expect(at, 'needs an open 22 m throwing corridor').not.toBeNull();

  const r = await page.evaluate((o) => {
    const g = globalThis.__game;
    const { THREE } = g;
    const out = [];
    const throws = [
      { d: [0, 0.4, 1], p: 6, v: [0, 0, 0] },
      { d: [0, 0.2, 1], p: 13, v: [0, 0, 0] },
      { d: [0, 0.1, 1], p: 21, v: [0, 0, 0] },
      { d: [0.3, 0.2, 1], p: 13, v: [0, 0, 5] },  // on the run
    ];
    for (const t of throws) {
      const owner = { body: { velocity: { x: t.v[0], y: t.v[1], z: t.v[2] } }, team: 0 };
      const origin = new THREE.Vector3(o.x, 1.8, o.z);
      const dir = new THREE.Vector3(...t.d).normalize();
      const predicted = g.predictThrow(owner, origin, dir, t.p);
      const nade = g.throwGrenade(owner, origin, dir, t.p, 'smoke', 999);
      let first = null;
      nade.body.addEventListener('collide', () => { first ??= nade.body.position.clone(); });
      for (let i = 0; i < 480 && !first; i++) g.fixedStep(1 / 120);
      g.clearGrenades();
      out.push({ miss: predicted && first ? predicted.distanceTo(first) : 99, far: first ? Math.hypot(first.x - o.x, first.z - o.z) : 0 });
    }
    return out;
  }, at);
  for (const t of r) {
    expect(t.far).toBeGreaterThan(1.5);
    expect(t.miss).toBeLessThan(0.5);
  }
});

test('a spent grenade comes to rest instead of rolling forever', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  // A flat, weak throw: it lands almost immediately and then does nothing but roll.
  const at = await openOrigin(page, 22);
  expect(at, 'needs an open 22 m throwing corridor').not.toBeNull();
  const rolled = await throwFrom(page, { dir: [0, -0.1, 1], power: 6, steps: 600, at });

  expect(rolled.speed).toBeLessThan(0.25);
  // On the floor, not wedged in the air somewhere.
  expect(rolled.rest.y).toBeLessThan(1.0);
});

test('grenades still explode and still damage through the fuse', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const at = await openOrigin(page, 22);
  expect(at, 'needs an open 22 m throwing corridor').not.toBeNull();

  const outcome = await page.evaluate((o) => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    // Park the bot in verified-open floor. Dropping it at the arena centre let cannon shove
    // it out of a prop and into cover, and the blast then had no line of sight to it.
    bot.body.position.set(o.x, 1.0, o.z + 4);
    bot.body.velocity.set(0, 0, 0);
    bot.updateTransforms();
    bot.health = 100;
    bot.invulnTimer = 0;
    g.fixedStep(1 / 120);

    const before = bot.health;
    const owner = { body: { velocity: { x: 0, y: 0, z: 0 } }, team: 1 };
    const origin = new g.THREE.Vector3(bot.pos.x + 1.0, bot.pos.y, bot.pos.z);
    g.throwGrenade(owner, origin, new g.THREE.Vector3(0, -1, 0), 0.1, 'frag', 0.1);
    for (let i = 0; i < 60; i++) g.fixedStep(1 / 120);
    return { before, after: bot.health, botY: bot.body.position.y };
  }, at);

  // If the bot was shoved onto a roof the damage result means nothing.
  expect(outcome.botY).toBeLessThan(2.0);

  expect(outcome.after).toBeLessThan(outcome.before);
});

test('three frags thrown in a row each go off where they landed', async ({ page }) => {
  // The first blast gave the other two the impulse sized for an 80 kg player. On a 0.4 kg
  // grenade that is 200 m/s: they left through the floor or the map edge and "only one worked".
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const at = await openOrigin(page, 22);
  expect(at, 'needs an open 22 m throwing corridor').not.toBeNull();

  const r = await page.evaluate((o) => {
    const g = globalThis.__game;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); }
    const owner = { body: { velocity: { x: 0, y: 0, z: 0 } }, team: 1 };
    const nades = [0, 1, 2].map((i) => g.throwGrenade(owner,
      new g.THREE.Vector3(o.x, 0.4, o.z + 4 + i * 3), new g.THREE.Vector3(0, -1, 0), 0.1, 'frag', 0.8 + i * 0.4));
    for (let i = 0; i < 60; i++) g.fixedStep(1 / 120);
    const settled = nades.map((n) => n.body.position.clone());
    const last = settled.map((p) => p.clone());
    const exploded = [false, false, false];
    for (let i = 0; i < 360; i++) {
      nades.forEach((n, k) => { if (n.fuse > 0) last[k].copy(n.body.position); });
      g.fixedStep(1 / 120);
      nades.forEach((n, k) => { if (n.fuse <= 0) exploded[k] = true; });
    }
    return { exploded, drift: nades.map((_, k) => last[k].distanceTo(settled[k])) };
  }, at);

  expect(r.exploded).toEqual([true, true, true]);
  for (const d of r.drift) expect(d).toBeLessThan(1.0);
});

test('three quick taps of G throw three frags, and all three go off', async ({ page }) => {
  // The player's own report, through the real keys rather than throwGrenade().
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  const at = await openOrigin(page, 22);
  expect(at, 'needs an open 22 m throwing corridor').not.toBeNull();
  await page.evaluate((o) => {
    const g = globalThis.__game;
    for (const b of g.bots) { b.body.type = 4; b.body.position.set(200, 60, 200); b.state = 'SPAWN'; b.stateTime = -1e9; }
    g.player.body.position.set(o.x, 0.6, o.z);
    g.player.yaw = Math.PI;
    g.player.pitch = 0.1;
    g.player.fragCount = 3;
    g.__thrown = [];
  }, at);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('g');
    await pumpFrames(page, 3);
    await page.keyboard.up('g');
    await page.evaluate(() => { const g = globalThis.__game; g.__thrown.push(g.grenades.at(-1)); });
    await pumpFrames(page, 12);
  }
  await pumpFrames(page, 240);
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    return { distinct: new Set(g.__thrown).size, gone: g.__thrown.map((n) => n.fuse <= 0), frags: g.player.fragCount };
  });
  expect(r.distinct).toBe(3);
  expect(r.gone).toEqual([true, true, true]);
  expect(r.frags).toBe(0);
});

test('an idle controller does not throw a grenade the keyboard is cooking', async ({ page }) => {
  // The test pad is always connected with nothing held, exactly like a controller left
  // plugged in. It used to release the cook on the next frame, before G was let go.
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  const frags = () => page.evaluate(() => globalThis.__game.player.fragCount);
  const before = await frags();

  await page.keyboard.down('g');
  await pumpFrames(page, 12);
  expect(await page.evaluate(() => globalThis.__game.player.cooking)).toBe('frag');
  expect(await frags()).toBe(before);

  await page.keyboard.up('g');
  expect(await frags()).toBe(before - 1);
});
