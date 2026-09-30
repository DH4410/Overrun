import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch } from './helpers/game.mjs';

/**
 * Where a round lands on a bot, and what it does there.
 *
 * Bots used to be hit on an abstract head sphere and two cylinders around the PHYSICS body,
 * one of which — the "limb" volume, 1.6x the torso's radius — enclosed the torso, so most chest
 * hits scored as limb hits for 0.6x. The drawn model could also be metres from that body (the
 * animation clips carried root motion). Now the hit volumes are capsules on the posed skeleton.
 */

/** Park one bot in the open, pose it, and fire exact player rounds at named body parts. */
async function shootParts(page, { vx = 0, vz = 0, aiming = false } = {}) {
  return page.evaluate(({ vx, vz, aiming }) => {
    const g = globalThis.__game;
    const { THREE, bots, player } = g;
    const bot = bots[0];
    bots.forEach((b, i) => {
      b.state = 'SPAWN'; b.stateTime = -1e9;
      if (i) { b.body.type = 4; b.body.position.set(300 + i * 4, 60, 300); }
    });
    const home = new THREE.Vector3(-41, 0.8, 0);
    player.invulnTimer = 0;
    const shoot = (aimAt) => {
      // Re-pose the bot exactly as it would be drawn, then fire one round from 9 m.
      bot.health = 100; bot.armor = 0; bot.alive = true;
      for (let f = 0; f < 30; f++) {
        bot.body.position.set(home.x, bot.body.position.y, home.z);
        bot.body.velocity.x = vx; bot.body.velocity.z = vz;
        bot.setPlanarVelocity(vx, vz);
        bot.yaw = Math.PI;                      // facing the shooter at -z
        if (aiming) { bot.target = player; bot.hasLOS = true; bot.state = 'SHOOT'; }
        globalThis.__testClock.pump(1, 1000 / 60);
        bot.state = 'SPAWN';
      }
      bot.body.velocity.set(0, 0, 0);
      bot.setPlanarVelocity(0, 0);
      const target = aimAt();
      const origin = new THREE.Vector3(home.x, target.y, home.z - 9);
      player.body.position.set(origin.x, 0.6, origin.z);
      const dir = target.clone().sub(origin).normalize();
      const before = bot.health;
      g.fireWeapon(player, g.WEAPON_BY_ID.ar, origin, dir, 0, 0);
      for (let s = 0; s < 12; s++) g.fixedStep(1 / 120);
      g.bullets.length = 0;
      return { dealt: before - bot.health, killed: !bot.alive || bot.health <= 0 };
    };
    const bones = {};
    bot.mesh.traverse((o) => { if (o.isBone) bones[o.name.replace(/^mixamorig\d*[:_]?/i, '')] = o; });
    const P = (name) => new THREE.Vector3().setFromMatrixPosition(bones[name].matrixWorld);
    const mid = (a, b) => P(a).lerp(P(b), 0.5);
    const results = {
      head: shoot(() => P('Head').lerp(P('HeadTop_End'), 0.5)),
      chest: shoot(() => mid('Spine1', 'Spine2')),
      stomach: shoot(() => mid('Hips', 'Spine1')),
      thigh: shoot(() => mid('LeftUpLeg', 'LeftLeg')),
      shin: shoot(() => mid('RightLeg', 'RightFoot')),
      forearm: shoot(() => mid('RightForeArm', 'RightHand')),
      wide: shoot(() => {
        const c = mid('Spine1', 'Spine2');
        return c.add(new THREE.Vector3(0.55, 0, 0));          // half a metre off the chest
      }),
    };
    return results;
  }, { vx, vz, aiming });
}

test('rounds score the part of the model they hit, and a rifle headshot kills', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'medium' });
  await pumpFrames(page, 5);
  const r = await shootParts(page);
  const AR = 26;
  expect(r.head.killed, 'AR headshot on a full-health bot').toBe(true);
  expect(r.chest.dealt).toBeCloseTo(AR, 0);
  expect(r.stomach.dealt).toBeCloseTo(AR, 0);
  expect(r.thigh.dealt).toBeCloseTo(AR * 0.75, 0);
  expect(r.shin.dealt).toBeCloseTo(AR * 0.75, 0);
  expect(r.forearm.dealt).toBeGreaterThan(0);
  expect(r.wide.dealt, 'half a metre wide of the chest is a miss').toBe(0);
});

test('hit zones follow the animation: a running, aiming bot is hit where it is drawn', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'medium' });
  await pumpFrames(page, 5);
  const r = await shootParts(page, { vx: 4.5, vz: 0, aiming: true });
  expect(r.head.killed).toBe(true);
  expect(r.chest.dealt).toBeCloseTo(26, 0);
  expect(r.thigh.dealt).toBeCloseTo(26 * 0.75, 0);
  expect(r.wide.dealt).toBe(0);
});
