import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/** Put the arena in a state where bot 0 is close, recording, and about to kill you. */
async function setUpKill(page) {
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'easy' });
  await page.evaluate(() => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    // Stand the killer 9 m in front of you, then let it run so there is something to replay.
    const p = g.player.body.position;
    bot.body.position.set(p.x + 9, p.y, p.z);
    bot.updateTransforms();
    bot.target = g.player;
    g.player.invulnTimer = 0;
  });
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
