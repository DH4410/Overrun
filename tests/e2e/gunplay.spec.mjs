import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * The player accuracy model: a settled, standing tap is effectively pinpoint, and movement,
 * air time and sustained fire each widen the cone independently. These are the rules the
 * mode is built on, so they are asserted as ordering relationships rather than exact cone
 * widths, which any retune is free to change.
 */

async function cones(page) {
  return page.evaluate(() => {
    const g = globalThis.__game;
    const ar = g.CONFIG && globalThis.__weapons ? null : null;
    void ar;
    const w = globalThis.__spread.weaponById('ar');
    const s = globalThis.__spread.playerSpread;
    return {
      rest: s(w, { speed: 0, grounded: true, aiming: false, crouching: false, bloom: 0 }),
      walking: s(w, { speed: 5, grounded: true, aiming: false, crouching: false, bloom: 0 }),
      sprinting: s(w, { speed: 8, grounded: true, aiming: false, crouching: false, bloom: 0 }),
      airborne: s(w, { speed: 5, grounded: false, aiming: false, crouching: false, bloom: 0 }),
      crouched: s(w, { speed: 0, grounded: true, aiming: false, crouching: true, bloom: 0 }),
      aimed: s(w, { speed: 0, grounded: true, aiming: true, crouching: false, bloom: 0 }),
      sprayed: s(w, { speed: 0, grounded: true, aiming: false, crouching: false, bloom: w.bloomMax }),
      bloomMax: w.bloomMax,
    };
  });
}

test('standing taps are pinpoint; moving, jumping and spraying are not', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
  await page.evaluate(() => {
    globalThis.__spread = {
      playerSpread: globalThis.__game.playerSpread,
      weaponById: (id) => globalThis.__game.WEAPONS.find((w) => w.id === id),
    };
  });

  const c = await cones(page);

  // A settled standing shot must be tighter than a head at duelling range: 0.27 m at 20 m
  // is 0.0135 rad, so anything under a few milliradians is "you hit what you aimed at".
  expect(c.rest).toBeLessThan(0.003);

  expect(c.walking).toBeGreaterThan(c.rest * 5);
  expect(c.sprinting).toBeGreaterThan(c.walking);
  // Air is compared against the SAME speed on the ground. A motionless airborne player
  // legitimately beats a full sprint — 8 m/s of sprint costs more cone than the flat air
  // penalty — so comparing the two says nothing about whether jumping is punished.
  expect(c.airborne).toBeGreaterThan(c.walking);
  expect(c.sprayed).toBeGreaterThan(c.rest * 5);

  // Crouching and aiming both steady the gun, and neither makes it worse.
  expect(c.crouched).toBeLessThan(c.rest);
  expect(c.aimed).toBeLessThan(c.rest);
});

test('firing blooms the cone and letting go recovers it', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const result = await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.current = 'ar';
    g.player.bloom = 0; g.player.sprayIndex = 0; g.player.sinceShot = 99;
    g.player.cooldown = 0; g.player.reloading = 0;
    g.player.ammo.ar.mag = 30;
    g.player.invulnTimer = 0;

    const start = g.player.bloom;
    for (let i = 0; i < 10; i++) { g.player.cooldown = 0; g.tryFire(); }
    const afterSpray = g.player.bloom;
    const sprayIndex = g.player.sprayIndex;

    // Let go: bloom recovers on the fixed clock.
    for (let i = 0; i < 240; i++) g.fixedStep(1 / 120);
    const afterRest = g.player.bloom;

    return { start, afterSpray, sprayIndex, afterRest, bloomMax: g.WEAPON_BY_ID.ar.bloomMax };
  });

  expect(result.start).toBe(0);
  expect(result.afterSpray).toBeGreaterThan(0);
  expect(result.afterSpray).toBeLessThanOrEqual(result.bloomMax);
  expect(result.sprayIndex).toBe(10);
  expect(result.afterRest).toBeLessThan(result.afterSpray);
});

test('the recoil pattern is deterministic and walks the shot up first', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const pattern = await page.evaluate(() => {
    const g = globalThis.__game;
    const ar = g.WEAPON_BY_ID.ar;
    const steps = [];
    for (let i = 0; i < 6; i++) steps.push(g.recoilStep(ar, i));
    return {
      steps,
      repeatable: JSON.stringify(g.recoilStep(ar, 3)) === JSON.stringify(g.recoilStep(ar, 3)),
      pastEnd: g.recoilStep(ar, 999),
      last: ar.pattern[ar.pattern.length - 1],
    };
  });

  expect(pattern.repeatable).toBe(true);
  // Held at the final entry rather than running off the end.
  expect(pattern.pastEnd).toEqual(pattern.last);
  // The opening of the pattern climbs: every one of the first few is upward, no sideways
  // drift yet. That is what makes "pull down" the correct first response.
  for (const [yaw, pitch] of pattern.steps.slice(0, 3)) {
    expect(pitch).toBeGreaterThan(0);
    expect(Math.abs(yaw)).toBeLessThan(0.2);
  }
});

test('the crosshair opens as the cone widens', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const gaps = await page.evaluate(() => {
    const g = globalThis.__game;
    const read = () => parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--xhair-gap'),
    );
    g.player.current = 'ar';
    g.player.bloom = 0;
    g.player.body.velocity.set(0, 0, 0);
    g.forceHudTick(1 / 60);
    const still = read();

    g.player.bloom = g.WEAPON_BY_ID.ar.bloomMax;
    g.forceHudTick(1 / 60);
    const sprayed = read();

    return { still, sprayed };
  });

  expect(gaps.sprayed).toBeGreaterThan(gaps.still);
});
