import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, startMatch, watchRuntimeErrors } from './helpers/game.mjs';

/** Kill bot `i` the way a bullet would: through the damage path, so the HUD and sounds run too. */
function shoot(page, i, headshot = false) {
  return page.evaluate(({ index, hs }) => {
    const g = globalThis.__game;
    const bot = g.bots[index % g.bots.length];
    // A match only fields a few bots, so stand a fallen one back up to be killed again.
    if (!bot.alive) { bot.respawn(g.spawnPoints[0]); bot.fireCd = Number.POSITIVE_INFINITY; }
    g.applyDamage(bot, 9999, g.player, bot.pos, hs);
  }, { index: i, hs: headshot });
}

const snap = (page) => page.evaluate(() => {
  const { match, player } = globalThis.__game;
  return {
    streak: match.streak, lost: match.lostStreak, revenges: match.revenges, multis: { ...match.multis },
    tags: [...match.tags], health: player.health, armor: player.armor,
    reserve: player.ammo[player.current].reserve, frags: player.fragCount,
  };
});

test('a streak shows on the HUD and pays rewards at 3, 5 and 7', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'hard' });
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.ammo[g.player.current].reserve = 0;
    g.player.fragCount = 0;
    g.player.armor = 10;
    g.player.health = 40;
  });

  await shoot(page, 0);
  await expect(page.locator('#streak')).toHaveClass(/\bon\b/);
  await expect(page.locator('#streak-n')).toHaveText('1');
  // A class name shared with the menu popouts once stretched the counter over the whole screen.
  const box = await page.locator('#streak').boundingBox();
  expect(box.height).toBeLessThan(120);
  expect(box.width).toBeLessThan(400);

  await shoot(page, 1);
  expect((await snap(page)).reserve).toBe(0);                       // not yet
  await shoot(page, 2);                                             // 3: resupply
  let s = await snap(page);
  expect(s.streak).toBe(3);
  expect(s.reserve).toBeGreaterThan(0);
  expect(s.frags).toBe(3);
  expect(s.armor).toBe(10);
  await expect(page.locator('#toast')).toContainText('RESUPPLY');
  await expect(page.locator('#streak-l')).toHaveText('KILL STREAK');

  await pumpFrames(page, 60);
  await shoot(page, 3);
  await shoot(page, 4);                                             // 5: armour
  s = await snap(page);
  expect(s.armor).toBe(100);
  expect(s.health).toBe(40);
  await expect(page.locator('#streak-l')).toHaveText('RAMPAGE');

  await shoot(page, 5);
  await shoot(page, 6);                                             // 7: medkit
  s = await snap(page);
  expect(s.health).toBe(100);
  expect(errors).toEqual([]);
});

test('dying ends the streak, says what it cost, and killing your killer is a revenge', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'hard' });
  await shoot(page, 0); await shoot(page, 1); await shoot(page, 2);
  expect((await snap(page)).streak).toBe(3);

  // Bot 3 kills you.
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.invulnTimer = 0;
    g.player.health = 0;
    g.killCombatant(g.player, g.bots[3], false);
  });
  const s = await snap(page);
  expect(s.streak).toBe(0);
  expect(s.lost).toBe(3);
  await expect(page.locator('#streak')).toHaveClass(/\bended\b/);
  await expect(page.locator('#streak-l')).toHaveText('STREAK ENDED');
  await expect(page.locator('#p-lost')).toHaveText('STREAK LOST · 3 KILLS');
  await expect(page.locator('#kc-lost')).toHaveText('YOUR 3-KILL STREAK ENDED');

  // Respawn clears all of it.
  await page.evaluate(() => { globalThis.__game.respawnPlayer(); globalThis.__game.player.invulnTimer = Number.POSITIVE_INFINITY; });
  await expect(page.locator('#streak')).not.toHaveClass(/\bon\b/);
  await expect(page.locator('#p-lost')).toHaveText('');

  // Killing a bot that did not kill you is no revenge; killing the one that did is.
  await shoot(page, 4);
  expect((await snap(page)).revenges).toBe(0);
  await shoot(page, 3, true);
  const r = await snap(page);
  expect(r.revenges).toBe(1);
  expect(r.tags).toEqual(['REVENGE']);
  await expect(page.locator('#kb-tag')).toHaveText('HEADSHOT · REVENGE');
  await expect(page.locator('#killbanner')).toHaveClass(/\brevenge\b/);
  // And only once per death.
  await shoot(page, 3);
  expect((await snap(page)).revenges).toBe(1);
});

test('a headshot kill gets its own hitmarker and flash; a body kill does not', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'hard' });
  await shoot(page, 0, false);
  await expect(page.locator('#hitmarker')).not.toHaveClass(/hskill/);
  await expect(page.locator('#hsflash')).not.toHaveClass(/\bon\b/);
  await shoot(page, 1, true);
  await expect(page.locator('#hitmarker')).toHaveClass(/hskill/);
  await expect(page.locator('#hsflash')).toHaveClass(/\bon\b/);
  await expect(page.locator('#kb-tag')).toHaveText('HEADSHOT');
});

test('the kill sound rises with the streak and is capped', async ({ page }) => {
  await bootGame(page);
  const freqs = await page.evaluate(() => {
    const { Audio } = globalThis.__game;
    const seen = [];
    const real = Audio.tone;
    Audio.tone = (o) => { seen.push(o.f0); };
    const at = (n) => { seen.length = 0; Audio.kill(n); return seen[0]; };
    const out = [0, 1, 2, 3, 8, 30].map(at);
    Audio.tone = real;
    return out;
  });
  const [none, one, two, three, eight, thirty] = freqs;
  expect(none).toBe(one);                       // the first kill is the base note
  expect(two).toBeGreaterThan(one);
  expect(three).toBeGreaterThan(two);
  expect(thirty).toBe(eight);                   // capped
});

test('chains and revenge are paid out and itemised on the podium', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'port', diff: 'hard' });
  // Three kills inside the chain window: a double and a triple.
  await shoot(page, 0); await shoot(page, 1); await shoot(page, 2);
  expect((await snap(page)).multis).toEqual({ 2: 1, 3: 1 });
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.player.kills = g.CONFIG.DM_TARGET - 1;
    const bot = g.bots[3];
    g.killCombatant(bot, g.player, false);
  });
  await pumpFrames(page, 400);
  const lines = await page.locator('#pd-xplines .xp-line').allTextContents();
  const text = lines.join('|');
  expect(text).toContain('DOUBLE KILL');
  expect(text).toContain('TRIPLE KILL');
});
