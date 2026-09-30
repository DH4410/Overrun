import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * 1v1 Duel: round-based, one life each, mirrored loadout, always the ELITE tier.
 *
 * `startMatch` in the helper parks every bot's fireCd at Infinity so the bot cannot shoot
 * back, which is what makes these deterministic — each test drives the death it wants.
 */

test('Duel starts one elite bot on a mirrored loadout', async ({ page }) => {
  await bootGame(page);
  // Pick HARD deliberately: the duel must override the menu difficulty, not inherit it.
  await startMatch(page, { mode: 'duel', map: 'warehouse', diff: 'hard' });

  const state = await page.evaluate(() => {
    const g = globalThis.__game;
    return {
      botCount: g.bots.length,
      tier: g.match.diff.label,
      botWeapon: g.bots[0].weaponId,
      playerWeapon: g.player.current,
      duelWeapon: g.CONFIG.DUEL_WEAPON,
      rounds: [g.match.roundsA, g.match.roundsB],
      // A duel must not put the two of them on top of each other.
      separation: g.bots[0].pos.distanceTo(g.player.pos),
    };
  });

  expect(state.botCount).toBe(1);
  expect(state.tier).toBe('ELITE');
  expect(state.botWeapon).toBe(state.duelWeapon);
  expect(state.playerWeapon).toBe(state.duelWeapon);
  expect(state.rounds).toEqual([0, 0]);
  expect(state.separation).toBeGreaterThan(20);
});

test('Duel: a bot death scores a round and the bot does not respawn mid-reset', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'warehouse', diff: 'medium' });

  const afterKill = await page.evaluate(() => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    bot.health = 0;
    g.killCombatant(bot, g.player, false);
    // A quarter second into the reset window the bot must still be down: one life a round.
    g.forceRenderTick(0.25);
    return {
      roundsA: g.match.roundsA,
      roundsB: g.match.roundsB,
      botAlive: bot.alive,
      resetPending: g.match.roundReset > 0,
    };
  });

  expect(afterKill).toEqual({ roundsA: 1, roundsB: 0, botAlive: false, resetPending: true });

  // Once the reset elapses both duellists come back for the next round.
  const afterReset = await page.evaluate(() => {
    const g = globalThis.__game;
    g.forceRenderTick(g.CONFIG.DUEL_RESET_DELAY + 0.1);
    return {
      botAlive: g.bots[0].alive,
      playerAlive: g.player.alive,
      roundsA: g.match.roundsA,
      roundTimeReset: g.match.roundTime > g.CONFIG.DUEL_ROUND_SECONDS - 1,
      separation: g.bots[0].pos.distanceTo(g.player.pos),
    };
  });

  expect(afterReset.botAlive).toBe(true);
  expect(afterReset.playerAlive).toBe(true);
  expect(afterReset.roundsA).toBe(1);
  expect(afterReset.roundTimeReset).toBe(true);
  expect(afterReset.separation).toBeGreaterThan(20);
});

test('Duel: a player death scores the bot, and a timed-out round scores neither', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'warehouse', diff: 'medium' });

  const scored = await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.health = 0;
    g.killCombatant(g.player, g.bots[0], false);
    return { a: g.match.roundsA, b: g.match.roundsB };
  });
  expect(scored).toEqual({ a: 0, b: 1 });

  const drawn = await page.evaluate(() => {
    const g = globalThis.__game;
    g.forceRenderTick(g.CONFIG.DUEL_RESET_DELAY + 0.1);   // start the next round
    g.match.roundTime = 0.05;
    g.forceRenderTick(0.1);                                // run it out
    return { a: g.match.roundsA, b: g.match.roundsB, resetting: g.match.roundReset > 0 };
  });
  expect(drawn).toEqual({ a: 0, b: 1, resetting: true });
});

test('Duel ends at DUEL_ROUNDS and returns to the menu', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'warehouse', diff: 'medium' });

  const ended = await page.evaluate(() => {
    const g = globalThis.__game;
    const target = g.CONFIG.DUEL_ROUNDS;
    // One short of the target: the match must still be live.
    g.match.roundsA = target - 1;
    const bot = g.bots[0];
    bot.health = 0;
    g.killCombatant(bot, g.player, false);
    return {
      running: g.match.running,
      roundsA: g.match.roundsA,
      target,
      result: document.querySelector('#menuresult').textContent,
      menuVisible: !document.querySelector('#menu').classList.contains('hidden'),
    };
  });

  expect(ended.roundsA).toBe(ended.target);
  expect(ended.running).toBe(false);
  expect(ended.menuVisible).toBe(true);
  expect(ended.result).toContain('DUEL WON');
});

/**
 * A duel round must open as a mirror.
 *
 * This calls startDuelRound() directly rather than going through the helper, because the
 * helper parks player.invulnTimer at Infinity to keep other tests deterministic — which is
 * exactly the field that was wrong here. respawnPlayer grants SPAWN_INVULN, and Bot.canSee
 * refuses to acquire an invulnerable target, so the elite bot opened every round blind for
 * three seconds while the player crossed the map. The armour was lopsided too.
 */
test('a duel round opens with both sides on equal terms', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'foundry', diff: 'medium' });

  const opening = await page.evaluate(() => {
    const g = globalThis.__game;
    g.startDuelRound();
    const bot = g.bots[0];
    return {
      playerInvuln: g.player.invulnTimer,
      botInvuln: bot.invulnTimer ?? 0,
      playerHealth: g.player.health,
      botHealth: bot.health,
      playerArmor: g.player.armor,
      botArmor: bot.armor,
      // canSee is the thing spawn protection actually gates.
      botCanSeePlayer: bot.canSee(g.player),
      separation: bot.pos.distanceTo(g.player.pos),
    };
  });

  expect(opening.playerInvuln).toBe(0);
  expect(opening.botInvuln).toBe(0);
  expect(opening.playerHealth).toBe(opening.botHealth);
  expect(opening.playerArmor).toBe(opening.botArmor);
  // Not asserting it CAN see across the map — only that protection is not what stops it.
  expect(typeof opening.botCanSeePlayer).toBe('boolean');
  expect(opening.separation).toBeGreaterThan(20);
});

/**
 * The AIM comment claims specific hit rates, so measure them rather than trusting the
 * numbers. Fires the bot's own shootAt() at a stationary dummy down a verified-clear lane
 * and counts what actually connects.
 *
 * Measured at range, not 15 m: at 15 m both tiers saturate on a settled, stationary target,
 * so a close-range test discriminates nothing. 35 m is where the cone widths separate — hard
 * carries ~0.056 rad there, about 1.9 m of error, while elite carries ~0.0043 rad, about
 * 15 cm, which is still inside the head.
 */
async function measureAim(page, { tier, range, botSpeed = 0, rounds = 60 }) {
  const result = await page.evaluate(({ tierKey, laneHalf, speed, shots }) => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    bot.diff = g.DIFFICULTY[tierKey];
    bot.aim = g.aimProfile(bot.diff);
    bot.weaponId = 'ar';
    bot.fixedWeaponId = 'ar';

    const dummy = g.player;

    /**
     * Park both combatants on a lane and let ONE fixed step run before aiming.
     *
     * The fixed step is load-bearing. `player.pos` is the chest point that both the bot's
     * aim solution and the bullet hit test read, and it is refreshed only inside
     * stepPlayer() — writing player.body.position does not update it. Aiming before that
     * step made the bot fire at a stale origin, which a lane laid through the origin still
     * swept, so a broken harness read as a 98% hit rate for every tier.
     *
     * Facing the bot at the target is load-bearing too: the gun hangs off the mesh, so at a
     * random yaw the muzzle sits over a metre off the lane and the round leaves on a
     * diagonal that clips props the lane check cleared.
     */
    function park(lane) {
      bot.fireCd = Number.POSITIVE_INFINITY;      // no stray AI shots during the settle step
      bot.body.position.set(lane.a.x, 1.0, lane.a.z);
      bot.body.velocity.set(0, 0, 0);
      dummy.body.position.set(lane.b.x, 1.0, lane.b.z);
      dummy.body.velocity.set(0, 0, 0);
      dummy.invulnTimer = 0;
      dummy.alive = true;
      dummy.health = 1000; dummy.armor = 0;
      g.fixedStep(1 / 120);
      // Re-pin: that step let gravity and the bot's own AI move them both.
      bot.body.position.set(lane.a.x, 1.0, lane.a.z);
      // Move across the firing line, never along it, so `speed` is pure lateral drift.
      const alongX = lane.b.x !== lane.a.x;
      bot.body.velocity.set(alongX ? 0 : speed, 0, alongX ? speed : 0);
      bot.wishVx = alongX ? 0 : speed;
      bot.wishVz = alongX ? speed : 0;
      bot.updateTransforms();
      bot.faceDir(lane.b.x - lane.a.x, lane.b.z - lane.a.z, 1, 1000);
      bot.updateTransforms();
      // Parking teleports the dummy back up to y = 1 after it has settled on the floor. No
      // real target jumps like that, so forget the bot's lagged height (trackLag) as it would
      // for a fresh target, rather than measuring a half-metre-low aim point.
      bot.trackTarget = null;
    }

    /**
     * Pick a lane the bot can actually shoot down, checked from the real muzzle to both the
     * chest and the head. Probing an idealised eye-height line instead let the measurement
     * silently score world hits as "the bot missed" — the muzzle sits ~0.35 m below the eye,
     * low enough to clip a crate the eye line cleared.
     */
    function findLane() {
      for (const offset of [0, 6, -6, 12, -12, 18, -18, 24, -24, 30, -30]) {
        for (const alongX of [true, false]) {
          const lane = alongX
            ? { a: { x: -laneHalf, z: offset }, b: { x: laneHalf, z: offset } }
            : { a: { x: offset, z: -laneHalf }, b: { x: offset, z: laneHalf } };
          park(lane);

          // Reject a lane whose endpoints are inside geometry. Parking runs one physics
          // step, and cannon resolves a body spawned inside a crate by shoving it out —
          // at 35 m along z = 18 that put the dummy on a roof at y = 8.75, still with a
          // clear line to it, so the lane passed the LOS check and then measured nothing.
          if (Math.abs(bot.body.position.y - 1.0) > 0.6) continue;
          if (Math.abs(dummy.body.position.y - 1.0) > 0.6) continue;

          const m = bot.gunMesh.userData.muzzle.getWorldPosition(new g.THREE.Vector3());
          const hb = dummy.hb;
          const chestOk = g.losClear(m.x, m.y, m.z, dummy.pos.x, dummy.pos.y, dummy.pos.z);
          const headOk = g.losClear(m.x, m.y, m.z,
            dummy.pos.x, dummy.pos.y + hb.headY, dummy.pos.z);
          if (chestOk && headOk) return lane;
        }
      }
      return null;
    }

    const lane = findLane();
    if (!lane) return { fired: 0, hits: 0, heads: 0, lane: { clear: false, separation: 0 } };
    park(lane);
    const laneInfo = { clear: true, separation: bot.pos.distanceTo(dummy.pos) };

    let hits = 0, heads = 0, fired = 0;
    for (let i = 0; i < shots; i++) {
      park(lane);
      bot.target = dummy;
      bot.hasLOS = true;
      bot.aimSettle = 99;        // measure the settled cone, not the snap penalty
      bot.reactTimer = 0;
      bot.mag = 30;
      bot.reloading = 0;
      bot.aimOff.set(0, 0, 0);
      bot.fireCd = 0;

      const hpBefore = dummy.health;
      bot.shootAt(dummy, 1 / 120);
      // fixedStep() runs every bot's simStep, so the bot would keep firing on its own while
      // this round is in flight and inflate the count. Lock its trigger for the flight.
      bot.fireCd = Number.POSITIVE_INFINITY;
      // AR muzzle velocity is 380 m/s; 40 steps of 1/120 s covers 126 m of travel.
      for (let step = 0; step < 40; step++) g.fixedStep(1 / 120);

      fired++;
      const dealt = hpBefore - dummy.health;
      if (dealt > 0) {
        hits++;
        if (dealt > 40) heads++;   // AR body damage is 26; the head zone multiplier is 2.4
      }
    }
    return { fired, hits, heads, lane: laneInfo };
  }, { tierKey: tier, laneHalf: range / 2, speed: botSpeed, shots: rounds });

  // A blocked lane would read as "the bot missed", which is exactly the false negative this
  // measurement exists to avoid. Fail loudly instead.
  expect(result.lane.clear, `needs an unobstructed ${range} m firing lane`).toBe(true);
  expect(result.lane.separation).toBeGreaterThan(range * 0.9);
  return result;
}

test('elite out-shoots hard, and does it with headshots', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'warehouse', diff: 'medium' });

  // 20 m. Longer lanes exist on paper but the warehouse has no unobstructed 35 m corridor
  // whose endpoints are both on the floor — the search there lands on a roof, and a
  // measurement taken against a target standing on a crate is not a measurement.
  const hard = await measureAim(page, { tier: 'hard', range: 20 });
  const elite = await measureAim(page, { tier: 'elite', range: 20 });

  const hardRate = hard.hits / hard.fired;
  const eliteRate = elite.hits / elite.fired;
  const hardHeadShare = hard.heads / Math.max(1, hard.hits);
  const eliteHeadShare = elite.heads / Math.max(1, elite.hits);

  // Recorded for whoever retunes AIM next; the assertions below are the contract.
  console.log('[duel] 20 m stationary target, AR:', JSON.stringify({
    hardRate: hardRate.toFixed(2),
    eliteRate: eliteRate.toFixed(2),
    hardHeadShare: hardHeadShare.toFixed(2),
    eliteHeadShare: eliteHeadShare.toFixed(2),
  }));

  expect(eliteRate).toBeGreaterThan(0.85);
  expect(eliteRate).toBeGreaterThan(hardRate);
  // The real discriminator: headBias is 0.8 for elite and 0 for every other tier, so elite
  // converts hits into kills roughly twice as fast even where raw hit rates are close.
  expect(eliteHeadShare).toBeGreaterThan(0.5);
  expect(hardHeadShare).toBeLessThan(0.2);
});

/**
 * The counter-play contract. Elite is only lethal while planted: `moveSpread` charges it
 * 0.055 rad per m/s of its own speed, which is why `counterStrafe` makes it stop before
 * firing. If this stops holding, the elite bot has quietly become an aimbot that can also
 * run, and the mode is no longer winnable the way its comment claims.
 */
test('elite accuracy collapses while it is moving', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'warehouse', diff: 'medium' });

  const planted = await measureAim(page, { tier: 'elite', range: 20, botSpeed: 0 });
  const running = await measureAim(page, { tier: 'elite', range: 20, botSpeed: 4.6 });

  const plantedRate = planted.hits / planted.fired;
  const runningRate = running.hits / running.fired;
  console.log('[duel] 20 m, elite planted vs running:', JSON.stringify({
    plantedRate: plantedRate.toFixed(2),
    runningRate: runningRate.toFixed(2),
  }));

  expect(plantedRate).toBeGreaterThan(0.85);
  expect(runningRate).toBeLessThan(plantedRate - 0.3);
});

test('elite plants itself to shoot rather than firing on the move', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'warehouse', diff: 'medium' });

  const behaviour = await page.evaluate(() => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    bot.diff = g.DIFFICULTY.elite;
    bot.aim = g.aimProfile(bot.diff);
    bot.hasLOS = true;
    bot.reactTimer = 0;
    bot.target = g.player;

    // About to fire: counter-strafing must zero the movement wish.
    bot.fireCd = 0.05;
    bot.combatMove(12, 1 / 120);
    const whileShooting = Math.hypot(bot.wishVx, bot.wishVz);

    // Mid-cooldown: free to reposition again.
    bot.fireCd = 0.5;
    bot.combatMove(12, 1 / 120);
    const betweenShots = Math.hypot(bot.wishVx, bot.wishVz);

    return { whileShooting, betweenShots, counterStrafe: bot.aim.counterStrafe };
  });

  expect(behaviour.counterStrafe).toBeGreaterThan(0);
  expect(behaviour.whileShooting).toBe(0);
  expect(behaviour.betweenShots).toBeGreaterThan(1);
});
