import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/** Put the arena in a state where bot 0 is close, recording, and about to kill you. */
async function setUpKill(page, sniper = false, gun = null) {
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(({ sniper, gun }) => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    // Stand the killer 9 m in front of you, then let it run so there is something to replay.
    const p = g.player.body.position;
    bot.body.position.set(p.x + 9, p.y, p.z);
    bot.yaw = -Math.PI / 2;                 // squared up to you, so the replay looks your way from the first frame
    bot.updateTransforms();
    bot.target = g.player;
    g.player.invulnTimer = 0;
    if (sniper) {
      bot.weaponId = 'sniper';
      Object.defineProperty(bot, 'aimW', { get: () => 1, set() {} });   // shouldered the whole time, recording included
    } else if (gun) {
      bot.weaponId = gun;
      Object.defineProperty(bot, 'aimW', { get: () => 1, set() {} });
    }
    bot.slots.length = 1;                   // one gun: the killer does not switch away from the one under test
  }, { sniper, gun });
  await pumpFrames(page, 150);   // 2.5 s of recorded history
}

async function killPlayer(page, headshot = true) {
  await page.evaluate((hs) => {
    const g = globalThis.__game;
    g.player.health = 0;
    g.killCombatant(g.player, g.bots[0], hs);
  }, headshot);
}

/** Restore real drawing for a moment so a screenshot has pixels, then stub it again. */
async function shot(page, name) {
  await page.evaluate(() => {
    const { renderer } = globalThis.__game;
    Object.assign(renderer, renderer.__real);
    globalThis.__testClock.pump(1, 1000 / 60);
  });
  await page.screenshot({ path: `test-results/killcam-${name}.png` });
  await page.evaluate(() => {
    const { renderer } = globalThis.__game;
    renderer.compile = renderer.render = renderer.clear = renderer.clearDepth = () => {};
  });
}

const phase = (page) => page.evaluate(() => globalThis.__game.killcam.phase);

test('a bot kill runs zoom, rewind and replay, then the death screen, then respawn', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await setUpKill(page);
  await killPlayer(page);

  expect(await phase(page)).toBe('zoom');
  await expect(page.locator('body')).toHaveClass(/\bkillcam\b/);
  await pumpFrames(page, 3);
  await expect(page.locator('#pause')).toBeHidden();       // the cam owns the screen; the death screen waits
  await expect(page.locator('#kc-name')).not.toHaveText('');
  await expect(page.locator('#kc-weapon')).toContainText('HEADSHOT');
  const total = await page.evaluate(() => globalThis.__game.player.respawnTimer);
  expect(total).toBeGreaterThan(5);

  // Zoom: the world runs slow, the lens closes in on the killer.
  await pumpFrames(page, 60);
  expect(await phase(page)).toBe('zoom');
  expect(await page.evaluate(() => globalThis.__game.camera.fov)).toBeLessThan(60);
  await shot(page, '1-zoom');

  // Past the zoom (1.7 s) into the rewind and the replay.
  await pumpFrames(page, 50);
  expect(['cut', 'replay']).toContain(await phase(page));
  await pumpFrames(page, 40);
  expect(await phase(page)).toBe('replay');
  await expect(page.locator('#killcam')).toHaveClass(/\breplay\b/);
  await expect(page.locator('#kc-who')).toHaveText('KILL CAM');
  const ghosts = await page.evaluate(() => {
    const g = globalThis.__game;
    return g.bots.filter((b) => b.mesh).every((b) => !b.mesh.visible);
  });
  expect(ghosts).toBe(true);
  await shot(page, '2-replay');
  await pumpFrames(page, 60);
  await shot(page, '3-replay-late');

  // The replay holds the world still: the respawn clock counts, the match clock does not.
  const before = await page.evaluate(() => ({ t: globalThis.__game.match.time, r: globalThis.__game.player.respawnTimer }));
  await pumpFrames(page, 30);
  const during = await page.evaluate(() => ({ t: globalThis.__game.match.time, r: globalThis.__game.player.respawnTimer }));
  expect(during.t).toBe(before.t);
  expect(before.r - during.r).toBeCloseTo(0.5, 1);

  // Run it out: the cam ends, the death screen shows, then you respawn.
  await pumpFrames(page, 240);
  expect(await phase(page)).toBe('off');
  await expect(page.locator('body')).not.toHaveClass(/\bkillcam\b/);
  const left = await page.evaluate(() => globalThis.__game.player.respawnTimer);
  if (left > 0) {
    await expect(page.locator('#pause')).toHaveClass(/\bdead\b/);
    await shot(page, '4-death-screen');
  }
  await pumpFrames(page, 160);
  expect(await page.evaluate(() => globalThis.__game.player.alive)).toBe(true);
  expect(await page.evaluate(() => globalThis.__game.bots.every((b) => !b.mesh || b.mesh.visible || !b.alive))).toBe(true);
  expect(errors).toEqual([]);
});

test('the cam can be skipped with Space after a moment, and lands on a short death screen', async ({ page }) => {
  await bootGame(page);
  await setUpKill(page);
  await killPlayer(page, false);
  await pumpFrames(page, 10);
  await page.keyboard.press('Space');      // too early: ignored
  expect(await phase(page)).toBe('zoom');
  await pumpFrames(page, 60);
  await page.keyboard.press('Space');
  expect(await phase(page)).toBe('off');
  expect(await page.evaluate(() => globalThis.__game.player.respawnTimer)).toBeLessThanOrEqual(1.3);
  await pumpFrames(page, 120);
  expect(await page.evaluate(() => globalThis.__game.player.alive)).toBe(true);
});

test('no cam in a duel, and none when you kill yourself', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'duel', map: 'port' });
  await pumpFrames(page, 60);
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.invulnTimer = 0; g.player.health = 0;
    g.killCombatant(g.player, g.bots[0], false);
  });
  expect(await phase(page)).toBe('off');
});

test('the replay is the killer\'s own screen: scope, gun in hand, hit markers and damage numbers', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await setUpKill(page, true);
  // A sniper kills you in three hits; the hit before the last lands a moment earlier.
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.armor = 0;
    const at = g.player.body.position.clone();
    g.applyDamage(g.player, 30, g.bots[0], at, false, 'body', 'sniper');
    g.applyDamage(g.player, 40, g.bots[0], at, true, 'head', 'sniper');
  });
  await pumpFrames(page, 40);
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.applyDamage(g.player, 500, g.bots[0], g.player.body.position.clone(), false, 'body', 'sniper');
  });
  expect(await phase(page)).toBe('zoom');

  // Into the replay, at the end of which the shots have landed: first-person sniper view.
  await page.evaluate(() => {
    globalThis.__nums = 0;
    new MutationObserver((ms) => { for (const m of ms) globalThis.__nums += m.addedNodes.length; })
      .observe(document.getElementById('dmgnums'), { childList: true });
  });
  await pumpFrames(page, 135);
  expect(await phase(page)).toBe('replay');
  // The killer had been raising the rifle as the recording began; give it a moment to be shouldered.
  for (let i = 0; i < 80 && !(await page.evaluate(() => document.getElementById('scope').classList.contains('on'))); i++) {
    await pumpFrames(page, 3);
  }
  const first = await page.evaluate(() => {
    const g = globalThis.__game;
    return {
      scope: getComputedStyle(document.getElementById('scope')).display !== 'none',
      vm: g.vmRig.visible,
      fov: g.camera.fov,
    };
  });
  expect(first.scope).toBe(true);          // the scope the killer looked through
  expect(first.vm).toBe(false);            // which replaces the gun model
  expect(first.fov).toBeLessThan(30);      // the sniper's own zoom
  // No letterbox: the frame is theirs. The bars retract over a CSS transition, so wait it out.
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.kc-bar.top')).height))) < 2) break;
    await page.waitForTimeout(50);
  }
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.kc-bar.top')).height))).toBeLessThan(2);

  // The hits the killer landed on you appear as numbers, whatever this player's setting says.
  for (let i = 0; i < 100 && (await page.evaluate(() => globalThis.__nums)) < 2; i++) await pumpFrames(page, 3);
  expect(await page.evaluate(() => globalThis.__nums)).toBeGreaterThanOrEqual(2);
  await shot(page, '5-scope');
  expect(errors).toEqual([]);
});

test('the replay shows the killer\'s gun in their hands when they are not scoped', async ({ page }) => {
  await bootGame(page);
  await setUpKill(page, false, 'ar');
  await killPlayer(page, false);
  await pumpFrames(page, 150);
  expect(await phase(page)).toBe('replay');
  const s = await page.evaluate(() => {
    const g = globalThis.__game;
    return {
      scope: document.getElementById('scope').classList.contains('on'),
      vm: g.vmRig.visible,
      model: g.vmModels.ar.visible,
      other: Object.entries(g.vmModels).some(([id, m]) => id !== 'ar' && m.visible),
      ghost: g.bots.every((b) => !b.mesh || !b.mesh.visible),
    };
  });
  expect(s).toEqual({ scope: false, vm: true, model: true, other: false, ghost: true });
  await shot(page, '6-gun-in-hand');
  await pumpFrames(page, 400);
  expect(await phase(page)).toBe('off');
  expect(await page.evaluate(() => document.getElementById('scope').classList.contains('on'))).toBe(false);
});

test('the replay view holds on you while the killer turns and shifts about', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    const p = g.player.body.position;
    bot.body.position.set(p.x + 9, p.y, p.z);
    bot.target = g.player;
    g.player.invulnTimer = 0;
    // Not aiming for the first second, then aiming; and a body that never stops turning.
    let frame = 0;
    Object.defineProperty(bot, 'aimW', { get: () => (frame > 60 ? 1 : 0), set() {} });
    globalThis.__wobble = () => { frame++; bot.yaw = Math.sin(frame * 0.35) * 2.2 - Math.PI / 2; bot.updateTransforms(); };
  });
  for (let i = 0; i < 150; i++) {
    await page.evaluate(() => globalThis.__wobble());
    await pumpFrames(page, 1);
  }
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.health = 0;
    g.killCombatant(g.player, g.bots[0], false);
  });
  await pumpFrames(page, 140);
  for (let i = 0; i < 30 && (await phase(page)) !== 'replay'; i++) await pumpFrames(page, 4);
  expect(await phase(page)).toBe('replay');
  // The replay opens on the moment the killer starts aiming, not on the wandering before it.
  // Skip the first quarter second (the view settling onto them) and sample the rest.
  await pumpFrames(page, 15);
  const cross = await page.evaluate(() => {
    const el = document.querySelector('#crosshair');
    const dot = el.querySelector('.ch-dot');
    const r = dot.getBoundingClientRect();
    const seen = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      seen.push(cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.9);
    }
    return { phase: globalThis.__game.killcam.phase, bg: getComputedStyle(dot).backgroundColor, shown: seen.every(Boolean), onCentre: Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.top + r.height / 2 - innerHeight / 2) < 2 };
  });
  const off = [];
  for (let i = 0; i < 12; i++) {
    off.push(await page.evaluate(() => {
      const g = globalThis.__game;
      const d = g.camera.getWorldDirection(new g.camera.position.constructor());
      const to = g.player.pos.clone().sub(g.camera.position).normalize();
      return (Math.acos(Math.min(1, Math.max(-1, d.dot(to)))) * 180) / Math.PI;
    }));
    if ((await phase(page)) !== 'replay') break;
    await pumpFrames(page, 3);
  }
  expect(off.length).toBeGreaterThan(4);
  expect(Math.max(...off)).toBeLessThan(8);
  // And their aim is on screen: the cross is shown, and bright.
  expect(cross).toMatchObject({ phase: 'replay', bg: 'rgb(255, 255, 255)', shown: true, onCentre: true });
  await shot(page, 'locked-on');
  expect(errors).toEqual([]);
});
