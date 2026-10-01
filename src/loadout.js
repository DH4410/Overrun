import { WEAPONS } from './sim/weaponData.js';

/**
 * The player's loadout: four guns in slot order (keys 1-4, D-pad), with frags always on 5.
 * Kept in localStorage so it survives a reload, and validated on the way in, so a stale or
 * hand-edited value can never hand the player a gun that no longer exists.
 */
export const LOADOUT_SIZE = 4;
export const DEFAULT_LOADOUT = ['pistol', 'ar', 'shotgun', 'sniper'];
export const GUN_IDS = WEAPONS.filter((w) => !w.thrown).map((w) => w.id);
const KEY = 'overrun.loadout';

export function validLoadout(list) {
  return Array.isArray(list)
    && list.length === LOADOUT_SIZE
    && new Set(list).size === LOADOUT_SIZE
    && list.every((id) => GUN_IDS.includes(id));
}

export function loadLoadout() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (validLoadout(v)) return v;
  } catch { /* private mode or bad JSON: fall through to the default */ }
  return [...DEFAULT_LOADOUT];
}

export function saveLoadout(list) {
  if (!validLoadout(list)) return false;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* not persisted, still applied */ }
  return true;
}

/** Put `id` in slot `i`. If it is already in another slot the two swap, as in any locker. */
export function assignSlot(list, i, id) {
  const next = [...list];
  const j = next.indexOf(id);
  if (j >= 0) next[j] = next[i];
  next[i] = id;
  return next;
}
