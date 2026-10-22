import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_PROFILE, XP, applyMatch, levelFromXp, matchAward, rankTitle, xpToNext } from '../../src/profile.js';

test('levels roll over exactly at the XP each one needs', () => {
  assert.deepEqual(levelFromXp(0), { level: 1, into: 0, need: xpToNext(1) });
  assert.equal(levelFromXp(xpToNext(1) - 1).level, 1);
  assert.deepEqual(levelFromXp(xpToNext(1)), { level: 2, into: 0, need: xpToNext(2) });
  assert.equal(levelFromXp(xpToNext(1) + xpToNext(2)).level, 3);
});

test('garbage XP is treated as zero', () => {
  assert.equal(levelFromXp(-5).level, 1);
  assert.equal(levelFromXp(NaN).level, 1);
});

test('a win with kills, headshots and a streak itemises and totals correctly', () => {
  const a = matchAward({ outcome: 'win', kills: 10, headshots: 4, bestStreak: 5 });
  assert.equal(a.total, XP.WIN + 10 * XP.KILL + 4 * XP.HEADSHOT + 3 * XP.STREAK_KILL);
  assert.equal(a.total, a.lines.reduce((s, l) => s + l.xp, 0));
});

test('a loss still pays participation, and zero-value lines are left out', () => {
  const a = matchAward({ outcome: 'loss', kills: 0, headshots: 0, bestStreak: 0 });
  assert.deepEqual(a.lines.map((l) => l.xp), [XP.LOSS]);
});

test('applyMatch accumulates the career and reports a level-up', () => {
  const near = { ...EMPTY_PROFILE, xp: xpToNext(1) - 10 };
  const r = applyMatch(near, { outcome: 'win', kills: 3, deaths: 2, headshots: 1, bestStreak: 3 });
  assert.equal(r.leveledUp, true);
  assert.equal(r.profile.wins, 1);
  assert.equal(r.profile.matches, 1);
  assert.equal(r.profile.kills, 3);
  assert.equal(r.profile.bestStreak, 3);
  assert.equal(r.after.level, 2);
});

test('rank titles step every four levels and stop at the top', () => {
  assert.equal(rankTitle(1), 'ROOKIE');
  assert.equal(rankTitle(5), 'RECRUIT');
  assert.equal(rankTitle(999), 'LEGEND');
});
