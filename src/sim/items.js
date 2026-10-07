/**
 * Healing items and weapon tiers, shared by the server, the browser and single player.
 *
 * Health and shield are separate pools, as in Fortnite: health tops out at 100 and shield at
 * 100, and a shield absorbs every point of damage before health sees any. Nothing heals for
 * free. Each item is a CHANNEL: you hold still-ish for `time` seconds with the gun lowered, and
 * the gain lands at the end. Firing, throwing, switching weapon, dancing or dying cancels it and
 * loses the progress but not the item, so being shot at costs time, never stock. Each item also
 * has a ceiling it cannot lift you past, which is what keeps the small ones small:
 *
 *   BANDAGE   +15 health, only up to 75      3 s
 *   MEDKIT    +100 health (to full)           6 s
 *   MINI      +25 shield, only up to 50       2 s
 *   BIG       +50 shield, up to 100           4 s
 *
 * Pure data and arithmetic: no DOM, no three.js, so the server runs the same file.
 */

export const ITEM = { NONE: 0, BANDAGE: 1, MEDKIT: 2, MINI: 3, BIG: 4 };

export const ITEMS = [
  null,
  { id: 'bandage', name: 'BANDAGE', stat: 'health', gain: 15, cap: 75, time: 3, max: 5, color: 0xf2eee6, key: 'Digit6' },
  { id: 'medkit', name: 'MEDKIT', stat: 'health', gain: 100, cap: 100, time: 6, max: 2, color: 0xe5484d, key: 'Digit7' },
  { id: 'mini', name: 'MINI SHIELD', stat: 'armor', gain: 25, cap: 50, time: 2, max: 5, color: 0x62d0ff, key: 'Digit8' },
  { id: 'big', name: 'SHIELD POTION', stat: 'armor', gain: 50, cap: 100, time: 4, max: 2, color: 0x3d6bff, key: 'Digit9' },
];

/** Bits 8-10 of a command's buttons hold the item being used (0 = none). */
export const ITEM_SHIFT = 8;
export const ITEM_MASK = 0x700;

export const emptyItems = () => [0, 0, 0, 0, 0];

/** Whether `kind` is in the bag and would actually help. */
export function canUse(p, kind) {
  const it = ITEMS[kind];
  return !!it && (p.items?.[kind] ?? 0) > 0 && p[it.stat] < it.cap && p.alive !== false;
}

/** Whether a pickup of `qty` would add anything. */
export function canCarry(p, kind) {
  const it = ITEMS[kind];
  return !!it && (p.items?.[kind] ?? 0) < it.max;
}

export function addItem(p, kind, qty) {
  const it = ITEMS[kind];
  const had = p.items[kind];
  p.items[kind] = Math.min(it.max, had + qty);
  return p.items[kind] - had;
}

export const USE = { NONE: 0, START: 1, DONE: 2, CANCEL: 3 };

export function cancelUse(p) {
  const was = p.useKind !== 0;
  p.useKind = 0; p.useT = 0;
  return was;
}

/**
 * One tick of item use. `sel` is the item the command asks for (0 = none); `interrupted` is
 * anything that should break a channel (fire, grenade, weapon swap, emote). Returns a USE code.
 */
export function stepUse(p, sel, interrupted, dt) {
  // A channel that ended, one way or another, does not start again until the item bits have
  // been let go: a held key (or a late packet still carrying it) must not chain into a second use.
  if (!sel) p.useLatch = 0;
  if (!p.alive) return cancelUse(p) ? USE.CANCEL : USE.NONE;
  if (p.useKind) {
    const it = ITEMS[p.useKind];
    if (interrupted || sel !== p.useKind || p[it.stat] >= it.cap) {
      // Switching straight to another item is allowed; the key that was held is not.
      p.useLatch = sel === p.useKind ? sel : 0;
      return cancelUse(p) ? USE.CANCEL : USE.NONE;
    }
    p.useT += dt;
    if (p.useT >= it.time - 1e-9) {
      p[it.stat] = Math.min(it.cap, p[it.stat] + it.gain);
      p.items[p.useKind]--;
      p.useKind = 0; p.useT = 0; p.useLatch = sel;
      return USE.DONE;
    }
    return USE.NONE;
  }
  if (sel && sel !== p.useLatch && !interrupted && canUse(p, sel)) {
    p.useKind = sel; p.useT = 0;
    return USE.START;
  }
  return USE.NONE;
}

/** How far through the channel, 0..1. */
export const useProgress = (p) => (p.useKind ? Math.min(1, p.useT / ITEMS[p.useKind].time) : 0);

/** Four bits an item, kinds 1-4. */
export function packItems(items) {
  return (items[1] & 15) | ((items[2] & 15) << 4) | ((items[3] & 15) << 8) | ((items[4] & 15) << 12);
}
export function unpackItems(v, out = emptyItems()) {
  out[1] = v & 15; out[2] = (v >> 4) & 15; out[3] = (v >> 8) & 15; out[4] = (v >> 12) & 15;
  return out;
}

/* ---------------------------------------------------------------- loot */

/**
 * What a map's health / shield spot holds. Deterministic from its index so the server and every
 * client agree without the contents being on the wire: every third spot is the big item.
 */
export function lootFor(kind, index) {
  const big = index % 3 === 0;
  if (kind === 'health') return big ? { item: ITEM.MEDKIT, qty: 1 } : { item: ITEM.BANDAGE, qty: 3 };
  return big ? { item: ITEM.BIG, qty: 1 } : { item: ITEM.MINI, qty: 2 };
}

/** Weapon tiers: a dropped gun is better than the one you carry only if it is a higher tier. */
export const TIERS = [
  { name: 'COMMON', mult: 1, color: 0xc9d1d9 },
  { name: 'RARE', mult: 1.08, color: 0x4aa3ff },
  { name: 'EPIC', mult: 1.16, color: 0xb25cff },
  { name: 'LEGENDARY', mult: 1.25, color: 0xffb02e },
];
export const tierMult = (t) => TIERS[t]?.mult ?? 1;

/** A tier from one uniform roll; `luck` (0..~0.3) pushes the odds up, e.g. later survival waves. */
export function rollTier(r, luck = 0) {
  const x = r - luck;
  return x < 0.03 ? 3 : x < 0.15 ? 2 : x < 0.45 ? 1 : 0;
}

/** The five guns' tiers, two bits each. */
export function packTiers(t) {
  return (t[0] & 3) | ((t[1] & 3) << 2) | ((t[2] & 3) << 4) | ((t[3] & 3) << 6) | ((t[4] & 3) << 8);
}
export function unpackTiers(v, out = [0, 0, 0, 0, 0]) {
  for (let i = 0; i < 5; i++) out[i] = (v >> (i * 2)) & 3;
  return out;
}

/** What a kill leaves on the floor, from two uniform rolls. type 0 = a gun (a=weapon index, b=tier), 1 = items (a=kind, b=qty). */
export function rollDrop(weaponIdx, r1, r2, luck = 0) {
  if (r1 < 0.5) return { type: 0, a: weaponIdx, b: rollTier(r2, luck) };
  const x = r2;
  if (x < 0.40) return { type: 1, a: ITEM.BANDAGE, b: 2 };
  if (x < 0.72) return { type: 1, a: ITEM.MINI, b: 1 };
  if (x < 0.88) return { type: 1, a: ITEM.BIG, b: 1 };
  return { type: 1, a: ITEM.MEDKIT, b: 1 };
}
