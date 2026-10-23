import { levelFromXp } from './profile.js';
import { ownsGun } from './shop.js';

/**
 * What the career unlocks. Pure data and functions, no DOM: the lobby, the locker, the career
 * screen and the account server all read the same table, so a client cannot equip something the
 * server's copy of this file says it has not earned.
 *
 * Three kinds of reward:
 *   operators  - which character you play, unlocked by level
 *   skins      - a finish for every gun you carry, unlocked by level
 *   titles     - a line under your name, unlocked by what you have done (not by level)
 */

export const OPERATORS = [
  { id: 'swat', name: 'SWAT', role: 'POLICE TACTICAL', level: 1 },
  { id: 'trooper', name: 'TROOPER', role: 'POLICE TACTICAL', level: 1 },
  { id: 'gasmask', name: 'GAS MASK', role: 'POLICE TACTICAL', level: 3 },
  { id: 'crypto', name: 'CRYPTO', role: 'MERCENARY', level: 6 },
  { id: 'ely', name: 'ELY', role: 'MILITARY', level: 10 },
  { id: 'steve', name: 'STEVE', role: 'MILITARY', level: 14 },
];

/**
 * Gun finishes. `slots` re-colours the gun's materials by role (see gunmodels.js): polymer is the
 * furniture, alloy the receiver, steel the barrel and small parts. Anything a skin does not name
 * keeps its stock colour.
 */
export const SKINS = [
  { id: 'stock', name: 'STOCK', level: 1, swatch: '#2a2d31', slots: null },
  { id: 'desert', name: 'DESERT TAN', level: 2, swatch: '#b59a6a',
    slots: { polymer: [0x8a7550, 0.8, 0.05], alloy: [0xa68c5c, 0.55, 0.5], steel: [0x6e6146, 0.4, 0.7] } },
  { id: 'arctic', name: 'ARCTIC', level: 5, swatch: '#dfe6ec',
    slots: { polymer: [0xcfd6dc, 0.7, 0.04], alloy: [0xe6ebef, 0.4, 0.55], steel: [0x9aa5ae, 0.3, 0.85] } },
  { id: 'crimson', name: 'CRIMSON', level: 8, swatch: '#b3262c',
    slots: { polymer: [0x7a1519, 0.6, 0.1], alloy: [0xb3262c, 0.35, 0.6], steel: [0x4a1012, 0.3, 0.85] } },
  { id: 'midnight', name: 'MIDNIGHT', level: 12, swatch: '#243a7a',
    slots: { polymer: [0x111a3c, 0.55, 0.15], alloy: [0x243a7a, 0.28, 0.8], steel: [0x5c78c8, 0.2, 0.95] } },
  { id: 'gold', name: 'GOLD', level: 20, swatch: '#e2b23c',
    slots: { polymer: [0x3a2c0c, 0.5, 0.2], alloy: [0xe2b23c, 0.22, 1.0], steel: [0xf3d577, 0.16, 1.0] } },
];

/** Titles come from lifetime numbers. `need` is every stat that must reach its value. */
export const TITLES = [
  { id: '', name: 'NONE', need: {} },
  { id: 'veteran', name: 'VETERAN', need: { matches: 10 } },
  { id: 'victor', name: 'VICTOR', need: { wins: 5 } },
  { id: 'headhunter', name: 'HEADHUNTER', need: { headshots: 50 } },
  { id: 'unstoppable', name: 'UNSTOPPABLE', need: { bestStreak: 7 } },
  { id: 'exterminator', name: 'EXTERMINATOR', need: { kills: 250 } },
  { id: 'champion', name: 'CHAMPION', need: { wins: 25 } },
];

export const DEFAULT_EQUIPPED = Object.freeze({ operator: 'swat', skin: 'stock', title: '' });

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const OPERATOR_BY_ID = byId(OPERATORS), SKIN_BY_ID = byId(SKINS), TITLE_BY_ID = byId(TITLES);
export const operatorInfo = (id) => OPERATOR_BY_ID[id] ?? null;
export const skinInfo = (id) => SKIN_BY_ID[id] ?? null;
export const titleInfo = (id) => TITLE_BY_ID[id] ?? null;

const levelOf = (profile) => levelFromXp(profile?.xp ?? 0).level;

export function isUnlocked(profile, kind, id) {
  const level = levelOf(profile);
  if (kind === 'operator') { const o = OPERATOR_BY_ID[id]; return !!o && level >= o.level; }
  if (kind === 'skin') { const s = SKIN_BY_ID[id]; return !!s && level >= s.level; }
  if (kind === 'gun') return ownsGun(profile, id);
  if (kind === 'title') {
    const t = TITLE_BY_ID[id];
    return !!t && Object.entries(t.need).every(([k, v]) => (profile?.[k] ?? 0) >= v);
  }
  return false;
}

/** What `profile` has not got yet for a title: the stats still short, as [label, have, need]. */
export function titleProgress(profile, id) {
  const t = TITLE_BY_ID[id];
  if (!t) return [];
  return Object.entries(t.need).map(([k, v]) => [k, Math.min(profile?.[k] ?? 0, v), v]);
}

/** Everything granted exactly when you reach `level`, in a stable order. */
export function levelRewards(level) {
  return [
    ...OPERATORS.filter((o) => o.level === level && level > 1).map((o) => ({ kind: 'operator', id: o.id, name: `${o.name} OPERATOR` })),
    ...SKINS.filter((s) => s.level === level && level > 1).map((s) => ({ kind: 'skin', id: s.id, name: `${s.name} FINISH` })),
  ];
}

/** The first level above `level` that grants something, with what it grants. */
export function nextReward(level) {
  for (let l = level + 1; l <= 99; l++) {
    const items = levelRewards(l);
    if (items.length) return { level: l, items };
  }
  return null;
}

/** The highest level that grants anything: where the visible track ends. */
export const TRACK_END = Math.max(...OPERATORS.map((o) => o.level), ...SKINS.map((s) => s.level));

/**
 * A usable equipped set from whatever was saved or sent: anything unknown or not yet earned falls
 * back to the default, so a hand-edited save cannot wear a reward it has not unlocked.
 */
export function sanitizeEquipped(profile, equipped) {
  const e = equipped && typeof equipped === 'object' ? equipped : {};
  return {
    operator: isUnlocked(profile, 'operator', e.operator) ? e.operator : DEFAULT_EQUIPPED.operator,
    skin: isUnlocked(profile, 'skin', e.skin) ? e.skin : DEFAULT_EQUIPPED.skin,
    title: e.title && isUnlocked(profile, 'title', e.title) ? e.title : DEFAULT_EQUIPPED.title,
  };
}
