/**
 * Gun skins: the collectible paint jobs. Pure data and functions, no DOM, shared by the browser and
 * the account server (through src/shop.js) so a save cannot hold a skin it has not paid for.
 *
 * Two pools that never overlap:
 *   crate  only from the crate: a random draw, one price for every skin in it
 *   shop   only from the daily shop: four of them on sale at a time, each with its own price
 *
 * `slots` repaints a gun's materials by role exactly like the level finishes in src/rewards.js:
 * [colour, roughness, metalness, glow?]. The optional fourth value is an emissive colour, so a
 * rare skin can light up. Skins are not tied to a gun: wear one on any gun.
 */

export const RARITY = Object.freeze({
  common: { name: 'COMMON', color: '#9aa6b2', weight: 62 },
  rare: { name: 'RARE', color: '#4b9bff', weight: 27 },
  epic: { name: 'EPIC', color: '#b266ff', weight: 9 },
  legendary: { name: 'LEGENDARY', color: '#ffb02e', weight: 2 },
});
export const RARITY_ORDER = Object.freeze(['common', 'rare', 'epic', 'legendary']);

/** What one crate costs. It is also the price of every skin in the crate pool, which is how the server knows what a save has paid. */
export const CRATE_PRICE = 300;
/** How many skins the daily shop shows at once. */
export const SHOP_SLOTS = 4;

const s = (polymer, alloy, steel) => ({ polymer, alloy, steel });

const CRATE = [
  // common
  { id: 'slate', name: 'SLATE', rarity: 'common', slots: s([0x2f3946, 0.7, 0.05], [0x56677a, 0.5, 0.55], [0x8796a8, 0.35, 0.8]) },
  { id: 'fielddrab', name: 'FIELD DRAB', rarity: 'common', slots: s([0x3f4a2c, 0.85, 0.04], [0x6b7a47, 0.6, 0.35], [0x2d3520, 0.45, 0.6]) },
  { id: 'rustbelt', name: 'RUST BELT', rarity: 'common', slots: s([0x4a2a1c, 0.82, 0.05], [0x9a4a22, 0.7, 0.4], [0x5b3a26, 0.5, 0.6]) },
  { id: 'pine', name: 'PINE NEEDLE', rarity: 'common', slots: s([0x14301f, 0.75, 0.05], [0x2e6b46, 0.5, 0.5], [0x9bd0b0, 0.32, 0.8]) },
  { id: 'concrete', name: 'CONCRETE', rarity: 'common', slots: s([0x6c7075, 0.9, 0.02], [0x9aa0a6, 0.8, 0.2], [0x474b50, 0.5, 0.5]) },
  { id: 'mustang', name: 'MUSTANG', rarity: 'common', slots: s([0x2a1d12, 0.7, 0.05], [0xc2762a, 0.4, 0.6], [0xe3b679, 0.3, 0.85]) },
  // rare
  { id: 'cobalt', name: 'COBALT', rarity: 'rare', slots: s([0x0e2a5c, 0.5, 0.15], [0x2f7bff, 0.3, 0.8], [0xbcd7ff, 0.2, 0.95]) },
  { id: 'magma', name: 'MAGMA', rarity: 'rare', slots: s([0x1a0d0a, 0.6, 0.1], [0xff5a1f, 0.35, 0.5, 0x5a1500], [0x3a1a10, 0.4, 0.8]) },
  { id: 'jade', name: 'JADE', rarity: 'rare', slots: s([0x0d3a30, 0.5, 0.15], [0x2fd0a0, 0.3, 0.6], [0xc8fff0, 0.2, 0.9]) },
  { id: 'violethaze', name: 'VIOLET HAZE', rarity: 'rare', slots: s([0x241044, 0.5, 0.15], [0x8f4bff, 0.3, 0.7], [0xe0ccff, 0.2, 0.9]) },
  { id: 'bubblegum', name: 'BUBBLEGUM', rarity: 'rare', slots: s([0xff8fc0, 0.5, 0.05], [0xffd0e6, 0.3, 0.3], [0xff5fa2, 0.25, 0.7]) },
  { id: 'citrus', name: 'CITRUS', rarity: 'rare', slots: s([0x2a3300, 0.6, 0.1], [0xc6f021, 0.35, 0.5], [0xfff2a0, 0.25, 0.8]) },
  // epic
  { id: 'neoncircuit', name: 'NEON CIRCUIT', rarity: 'epic', slots: s([0x05101a, 0.5, 0.2], [0x0b2a3a, 0.3, 0.8, 0x003a48], [0x00e5ff, 0.2, 0.9, 0x00a3b8]) },
  { id: 'toxic', name: 'TOXIC', rarity: 'epic', slots: s([0x0a1a05, 0.6, 0.1], [0x6dff2a, 0.35, 0.4, 0x1f6a08], [0x1d3a10, 0.4, 0.7]) },
  { id: 'sakura', name: 'SAKURA', rarity: 'epic', slots: s([0xfff0f5, 0.55, 0.04], [0xffa6c9, 0.35, 0.3], [0xffd9e8, 0.2, 0.9]) },
  { id: 'icefang', name: 'ICE FANG', rarity: 'epic', slots: s([0x0e2538, 0.45, 0.2], [0x9ee7ff, 0.15, 0.9], [0xffffff, 0.1, 1, 0x2a6a88]) },
  { id: 'hazard', name: 'HAZARD', rarity: 'epic', slots: s([0x15130a, 0.7, 0.05], [0xffcf00, 0.4, 0.4, 0x3a3000], [0x111111, 0.4, 0.8]) },
  // legendary
  { id: 'aurora', name: 'AURORA', rarity: 'legendary', slots: s([0x061a2a, 0.4, 0.3], [0x22ffb0, 0.2, 0.9, 0x0a6a4a], [0xb26bff, 0.15, 1, 0x3a1670]) },
  { id: 'obsidianflame', name: 'OBSIDIAN FLAME', rarity: 'legendary', slots: s([0x050505, 0.4, 0.3], [0x120a08, 0.15, 0.9], [0xff6a00, 0.2, 1, 0xc44800]) },
].map((k) => ({ ...k, source: 'crate', price: CRATE_PRICE }));

const SHOP = [
  { id: 'chrome', name: 'CHROME', rarity: 'rare', price: 700, slots: s([0xdfe6ee, 0.1, 0.95], [0xe9eff6, 0.08, 1], [0xffffff, 0.06, 1]) },
  { id: 'carbonember', name: 'CARBON EMBER', rarity: 'epic', price: 1300, slots: s([0x0a0a0c, 0.35, 0.5], [0x15151a, 0.2, 0.9], [0xff7a1a, 0.2, 1, 0x7a3000]) },
  { id: 'royal', name: 'ROYAL', rarity: 'epic', price: 1500, slots: s([0x1a0b3a, 0.45, 0.2], [0x5a2aa0, 0.25, 0.8], [0xf3d577, 0.15, 1]) },
  { id: 'frostbite', name: 'FROSTBITE', rarity: 'epic', price: 1500, slots: s([0xcfe9ff, 0.4, 0.1], [0x7fc4ff, 0.15, 0.9, 0x103a66], [0xffffff, 0.1, 1, 0x4a8ab0]) },
  { id: 'bloodmoon', name: 'BLOOD MOON', rarity: 'legendary', price: 2600, slots: s([0x1a0003, 0.4, 0.3], [0x8a0016, 0.2, 0.9, 0x400008], [0xff2a44, 0.15, 1, 0x7a0a1a]) },
  { id: 'solarflare', name: 'SOLAR FLARE', rarity: 'legendary', price: 2800, slots: s([0x2a1000, 0.4, 0.3], [0xffa11a, 0.18, 1, 0x6a3000], [0xfff1a8, 0.12, 1, 0x806000]) },
  { id: 'holopearl', name: 'HOLO PEARL', rarity: 'legendary', price: 3000, slots: s([0xeef2ff, 0.3, 0.2], [0xcfd8ff, 0.1, 0.6, 0x303868], [0xffffff, 0.06, 1, 0x5a6ab0]) },
  { id: 'void', name: 'VOID', rarity: 'legendary', price: 3200, slots: s([0x000000, 0.5, 0.2], [0x14002a, 0.15, 0.9, 0x2a0058], [0x9a3cff, 0.12, 1, 0x5a1ab0]) },
].map((k) => ({ ...k, source: 'shop' }));

export const CRATE_SKINS = Object.freeze(CRATE);
export const SHOP_SKINS = Object.freeze(SHOP);
export const GUN_SKINS = Object.freeze([...CRATE, ...SHOP]);

const BY_ID = Object.fromEntries(GUN_SKINS.map((k) => [k.id, k]));
export const gunSkinInfo = (id) => BY_ID[id] ?? null;
export const skinKey = (id) => `skin:${id}`;
export const skinIdOf = (key) => (typeof key === 'string' && key.startsWith('skin:') ? key.slice(5) : null);

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
/** A CSS gradient in the skin's own colours: the swatch and the card art. */
export function skinGradient(skin) {
  const { polymer, alloy, steel } = skin.slots;
  return `linear-gradient(135deg, ${hex(polymer[0])} 0%, ${hex(alloy[0])} 52%, ${hex(steel[0])} 100%)`;
}

/** A small seeded random number generator (mulberry32): the same seed always gives the same run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which UTC day `ms` falls in. The shop turns over at 00:00 UTC for everyone at once. */
export const shopDay = (ms) => Math.floor(ms / 86_400_000);
/** When the current shop ends, in ms since the epoch. */
export const shopEndsAt = (ms) => (shopDay(ms) + 1) * 86_400_000;

/** The skins on sale on the day `ms` falls in: always SHOP_SLOTS of them, the same for every player. */
export function dailyShop(ms) {
  const rng = seeded(shopDay(ms) * 2654435761);
  const pool = [...SHOP];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, SHOP_SLOTS);
}

/**
 * One crate draw. Rarity is rolled by weight, then a skin you do not own yet is picked in it; a
 * tier you have finished is skipped for the nearest one that has something left. Returns the skin
 * id, or null once the whole crate pool is yours. `owned` is the profile's item keys.
 */
export function rollCrate(owned, rng = Math.random) {
  const have = new Set(owned ?? []);
  const left = (tier) => CRATE.filter((k) => k.rarity === tier && !have.has(skinKey(k.id)));
  const open = RARITY_ORDER.filter((t) => left(t).length);
  if (!open.length) return null;
  let pick = rng() * open.reduce((n, t) => n + RARITY[t].weight, 0);
  let tier = open[open.length - 1];
  for (const t of open) {
    pick -= RARITY[t].weight;
    if (pick < 0) { tier = t; break; }
  }
  const pool = left(tier);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))].id;
}
