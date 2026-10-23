/**
 * The player's career: XP, level and lifetime numbers, kept in localStorage. Everything shown on
 * the lobby card comes from here and every number in it was earned in a match, never invented.
 * Pure functions plus a thin load/save pair, so the maths is unit-tested without a browser.
 */
const KEY = 'overrun.profile';

export const XP = Object.freeze({
  WIN: 150, DRAW: 75, LOSS: 50, KILL: 10, HEADSHOT: 8, STREAK_KILL: 4, REVENGE: 15,
  // Paid each time a chain reaches that length inside the multi-kill window: a triple pays the
  // double on the way to it, so a longer chain is worth more than the sum of shorter ones.
  MULTI: Object.freeze({ 2: 10, 3: 15, 4: 25, 5: 40 }),
});
export const MULTI_NAME = Object.freeze({ 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUAD KILL', 5: 'MEGA KILL' });

/** XP needed to go from `level` to `level + 1`: 250, 325, 400, ... */
export function xpToNext(level) { return 250 + 75 * (level - 1); }

/** Level, XP into it and XP it needs, from lifetime XP. */
export function levelFromXp(totalXp) {
  let level = 1;
  let left = Math.max(0, Math.floor(totalXp) || 0);
  while (left >= xpToNext(level)) { left -= xpToNext(level); level++; }
  return { level, into: left, need: xpToNext(level) };
}

const RANKS = ['ROOKIE', 'RECRUIT', 'OPERATIVE', 'SPECIALIST', 'VETERAN', 'ELITE', 'LEGEND'];
export function rankTitle(level) { return RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 4))]; }

const COUNTERS = ['xp', 'kills', 'deaths', 'headshots', 'wins', 'losses', 'draws', 'matches', 'bestStreak'];
/** What is worn: operator, gun finish and title. Names only; src/rewards.js says whether they are earned. */
export const EMPTY_EQUIPPED = Object.freeze({ operator: 'swat', skin: 'stock', title: '' });
export const EMPTY_PROFILE = Object.freeze({
  xp: 0, kills: 0, deaths: 0, headshots: 0, wins: 0, losses: 0, draws: 0, matches: 0, bestStreak: 0,
  equipped: EMPTY_EQUIPPED,
});

export function clean(v) {
  const out = { ...EMPTY_PROFILE, equipped: { ...EMPTY_EQUIPPED } };
  if (v && typeof v === 'object') {
    for (const k of COUNTERS) {
      const n = Number(v[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
    }
    const e = v.equipped;
    if (e && typeof e === 'object') {
      for (const k of Object.keys(EMPTY_EQUIPPED)) {
        if (typeof e[k] === 'string' && e[k].length <= 24 && /^[a-z0-9_-]*$/.test(e[k])) out.equipped[k] = e[k];
      }
    }
  }
  return out;
}

/** The profile with part of what is worn changed. */
export function withEquipped(profile, patch) {
  return clean({ ...profile, equipped: { ...profile.equipped, ...patch } });
}

export function loadProfile() {
  try { return clean(JSON.parse(localStorage.getItem(KEY))); } catch { return clean(null); }
}

export function saveProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(clean(p))); } catch { /* private mode: still applied this session */ }
}

/**
 * What a finished match pays. `outcome` is 'win' | 'loss' | 'draw'. Returns the itemised lines
 * (so the podium can show where the XP came from) and the total.
 */
export function matchAward({ outcome, kills = 0, headshots = 0, bestStreak = 0, multis = {}, revenges = 0 }) {
  const lines = [];
  const add = (label, xp) => { if (xp > 0) lines.push({ label, xp }); };
  add(outcome === 'win' ? 'VICTORY' : outcome === 'draw' ? 'DRAW' : 'PARTICIPATION',
    outcome === 'win' ? XP.WIN : outcome === 'draw' ? XP.DRAW : XP.LOSS);
  add(`${kills} ELIMINATION${kills === 1 ? '' : 'S'}`, kills * XP.KILL);
  add(`${headshots} HEADSHOT${headshots === 1 ? '' : 'S'}`, headshots * XP.HEADSHOT);
  add(`${bestStreak}-KILL STREAK`, bestStreak >= 3 ? (bestStreak - 2) * XP.STREAK_KILL : 0);
  for (const size of Object.keys(XP.MULTI)) {
    const n = Math.max(0, Math.floor(Number(multis[size])) || 0);
    add(`${n} ${MULTI_NAME[size]}${n === 1 ? '' : 'S'}`, n * XP.MULTI[size]);
  }
  const r = Math.max(0, Math.floor(revenges) || 0);
  add(`${r} REVENGE${r === 1 ? '' : 'S'}`, r * XP.REVENGE);
  return { lines, total: lines.reduce((s, l) => s + l.xp, 0) };
}

/** Book a finished match into the profile. Returns the new profile plus the level change. */
export function applyMatch(profile, result) {
  const award = matchAward(result);
  const before = levelFromXp(profile.xp);
  const next = clean({
    ...profile,
    xp: profile.xp + award.total,
    kills: profile.kills + (result.kills || 0),
    deaths: profile.deaths + (result.deaths || 0),
    headshots: profile.headshots + (result.headshots || 0),
    wins: profile.wins + (result.outcome === 'win' ? 1 : 0),
    losses: profile.losses + (result.outcome === 'loss' ? 1 : 0),
    draws: profile.draws + (result.outcome === 'draw' ? 1 : 0),
    matches: profile.matches + 1,
    bestStreak: Math.max(profile.bestStreak, result.bestStreak || 0),
  });
  const after = levelFromXp(next.xp);
  return { profile: next, award, before, after, leveledUp: after.level > before.level };
}
