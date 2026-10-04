/**
 * Every character a player can wear, all unlocked. One list for the three places that need it:
 * the server (which ids it accepts), the roster in src/bots.js (which file each one is) and the
 * locker (names, and a portrait in assets/skins/). Mixamo characters, converted by
 * scripts/fbx-to-glb.mjs. New ids go on the END, so the older picks keep their place.
 *
 * `boot` skins load with the game, because the bots draw from them. The rest load the first time
 * somebody wears one (the locker, the lobby, a match), so a bigger wardrobe costs no start-up.
 */
export const SKINS = [
  { id: 'swat', name: 'Swat Guy', tag: 'POLICE', boot: true },
  { id: 'trooper', name: 'Trooper', tag: 'POLICE', boot: true },
  { id: 'gasmask', name: 'Gas Mask', tag: 'POLICE', boot: true },
  { id: 'crypto', name: 'Crypto', tag: 'MERCENARY', boot: true },
  { id: 'ely', name: 'Ely', tag: 'MILITARY', boot: true },
  { id: 'steve', name: 'Steve', tag: 'MERCENARY', boot: true },
];

const SKIN_KEY = 'overrun-skin';
/** The skin this browser wore last, or null. Survives the tab, unlike the per-tab pick online. */
export function savedSkin() {
  try {
    const id = globalThis.localStorage?.getItem(SKIN_KEY);
    return SKINS.some((s) => s.id === id) ? id : null;
  } catch { return null; }
}
export function saveSkin(id) {
  try { globalThis.localStorage?.setItem(SKIN_KEY, id); } catch { /* private mode */ }
}

/** 'soldier' is the stock three.js model: never offered, never drawn online, kept as a last resort. */
export const CHARACTER_IDS = ['soldier', ...SKINS.map((s) => s.id)];
