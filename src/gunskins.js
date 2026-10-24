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

/**
 * Surface patterns a skin can lay over a role's colour (drawn in src/gunTextures.js). `c` is the
 * pattern's average colour, which the colour of the slot multiplies, and `scale` is how many times
 * it repeats per metre of gun. This lives here, not next to the drawing code, so the swatches in the
 * locker can be tinted without loading three.js.
 */
export const PATTERNS = Object.freeze({
  carbon: { c: 0x6e6e6e, scale: 12 },
  brushed: { c: 0xa8a8a8, scale: 10 },
  speckle: { c: 0xb0b0b0, scale: 14 },
  camo_wood: { c: 0x575734, scale: 3.4 },
  camo_desert: { c: 0xbca477, scale: 3.4 },
  camo_urban: { c: 0x797d81, scale: 3.4 },
  rust: { c: 0x8f5733, scale: 5 },
  scales: { c: 0x808080, scale: 12 },
  leather: { c: 0x9a9a9a, scale: 16 },
  magma: { c: 0x2a130a, scale: 4 },
  marble: { c: 0xdcdcdc, scale: 3.2 },
  hex: { c: 0x9a9a9a, scale: 9 },
  circuit: { c: 0x6a6a6a, scale: 9 },
  hazard: { c: 0x929292, scale: 8 },
  facets: { c: 0xb0b0b0, scale: 5 },
  damascus: { c: 0xacacac, scale: 3 },
  swirl: { c: 0x828282, scale: 2.4 },
});

/** [colour, roughness, metalness, glow?] per role, plus the pattern each role wears, if any. */
const s = (polymer, alloy, steel, tex = null) => ({ slots: { polymer, alloy, steel }, tex });

const CRATE = [
  // common
  { id: 'slate', name: 'SLATE', rarity: 'common', ...s([0x6a7380, 0.8, 0.05], [0x8a97a8, 0.5, 0.6], [0xb4c0cf, 0.35, 0.8], { polymer: 'speckle', alloy: 'brushed', steel: 'brushed' }) },
  { id: 'fielddrab', name: 'FIELD DRAB', rarity: 'common', ...s([0xffffff, 0.85, 0.04], [0x8b9a63, 0.6, 0.35], [0x4a5636, 0.45, 0.6], { polymer: 'camo_wood', alloy: 'brushed' }) },
  { id: 'rustbelt', name: 'RUST BELT', rarity: 'common', ...s([0xffffff, 0.85, 0.05], [0xd88a52, 0.7, 0.4], [0x8a5a3a, 0.5, 0.6], { polymer: 'rust', alloy: 'rust' }) },
  { id: 'pine', name: 'PINE NEEDLE', rarity: 'common', ...s([0x3f9a66, 0.6, 0.05], [0x2e6b46, 0.5, 0.5], [0x9bd0b0, 0.32, 0.8], { polymer: 'scales', steel: 'brushed' }) },
  { id: 'concrete', name: 'CONCRETE', rarity: 'common', ...s([0xdfe2e6, 0.9, 0.02], [0xc2c8ce, 0.8, 0.2], [0x7a8087, 0.5, 0.5], { polymer: 'speckle', alloy: 'speckle' }) },
  { id: 'mustang', name: 'MUSTANG', rarity: 'common', ...s([0xd2813a, 0.75, 0.04], [0xc2762a, 0.4, 0.6], [0xe3b679, 0.3, 0.85], { polymer: 'leather', alloy: 'brushed' }) },
  // rare
  { id: 'cobalt', name: 'COBALT', rarity: 'rare', ...s([0x2f6fe0, 0.4, 0.2], [0x2f7bff, 0.3, 0.8], [0xbcd7ff, 0.2, 0.95], { polymer: 'carbon', alloy: 'brushed' }) },
  { id: 'magma', name: 'MAGMA', rarity: 'rare', ...s([0xffffff, 0.55, 0.1, 0x2a0a00], [0xff7a3a, 0.35, 0.5, 0x5a1500], [0x4a2a1c, 0.4, 0.8], { polymer: 'magma', alloy: 'magma' }) },
  { id: 'jade', name: 'JADE', rarity: 'rare', ...s([0x6fe0b8, 0.35, 0.1], [0x2fd0a0, 0.3, 0.6], [0xc8fff0, 0.2, 0.9], { polymer: 'marble', alloy: 'brushed' }) },
  { id: 'violethaze', name: 'VIOLET HAZE', rarity: 'rare', ...s([0x9a5cff, 0.4, 0.15], [0x8f4bff, 0.3, 0.7], [0xe0ccff, 0.2, 0.9], { polymer: 'swirl', alloy: 'damascus' }) },
  { id: 'bubblegum', name: 'BUBBLEGUM', rarity: 'rare', ...s([0xff8fc0, 0.5, 0.05], [0xffd0e6, 0.3, 0.3], [0xff5fa2, 0.25, 0.7], { polymer: 'hex', alloy: 'brushed' }) },
  { id: 'citrus', name: 'CITRUS', rarity: 'rare', ...s([0xc6f021, 0.5, 0.1], [0xe6ff7a, 0.35, 0.5], [0xfff2a0, 0.25, 0.8], { polymer: 'scales', alloy: 'brushed' }) },
  // epic
  { id: 'neoncircuit', name: 'NEON CIRCUIT', rarity: 'epic', ...s([0x20c8e8, 0.45, 0.2, 0x002a34], [0x1a8aa8, 0.3, 0.8, 0x003a48], [0x00e5ff, 0.2, 0.9, 0x00a3b8], { polymer: 'circuit', alloy: 'circuit' }) },
  { id: 'toxic', name: 'TOXIC', rarity: 'epic', ...s([0x6dff2a, 0.45, 0.1, 0x0c3a04], [0x6dff2a, 0.35, 0.4, 0x1f6a08], [0x2d5a18, 0.4, 0.7], { polymer: 'hex', alloy: 'hex' }) },
  { id: 'sakura', name: 'SAKURA', rarity: 'epic', ...s([0xffc4d8, 0.5, 0.04], [0xffa6c9, 0.35, 0.3], [0xffd9e8, 0.2, 0.9], { polymer: 'marble', alloy: 'damascus' }) },
  { id: 'icefang', name: 'ICE FANG', rarity: 'epic', ...s([0x9ee7ff, 0.3, 0.2, 0x0a2a3a], [0x9ee7ff, 0.15, 0.9], [0xffffff, 0.1, 1, 0x2a6a88], { polymer: 'facets', alloy: 'facets' }) },
  { id: 'hazard', name: 'HAZARD', rarity: 'epic', ...s([0xffcf00, 0.6, 0.05, 0x1a1500], [0xffcf00, 0.4, 0.4, 0x3a3000], [0x4a4a4a, 0.4, 0.8], { polymer: 'hazard', alloy: 'hazard' }) },
  // legendary
  { id: 'aurora', name: 'AURORA', rarity: 'legendary', ...s([0x22ffb0, 0.35, 0.3, 0x0a4a34], [0x22ffb0, 0.2, 0.9, 0x0a6a4a], [0xb26bff, 0.15, 1, 0x3a1670], { polymer: 'swirl', alloy: 'damascus' }) },
  { id: 'obsidianflame', name: 'OBSIDIAN FLAME', rarity: 'legendary', ...s([0xffffff, 0.4, 0.3, 0x3a1000], [0xffffff, 0.3, 0.6, 0x8a3200], [0xff6a00, 0.2, 1, 0xc44800], { polymer: 'magma', alloy: 'magma' }) },
].map((k) => ({ ...k, source: 'crate', price: CRATE_PRICE }));

const SHOP = [
  { id: 'chrome', name: 'CHROME', rarity: 'rare', price: 700, ...s([0xdfe6ee, 0.1, 0.95], [0xe9eff6, 0.08, 1], [0xffffff, 0.06, 1], { polymer: 'brushed' }) },
  { id: 'carbonember', name: 'CARBON EMBER', rarity: 'epic', price: 1300, ...s([0xc8c8d0, 0.3, 0.5], [0xb0b0b8, 0.2, 0.9], [0xff7a1a, 0.2, 1, 0x7a3000], { polymer: 'carbon', alloy: 'carbon' }) },
  { id: 'royal', name: 'ROYAL', rarity: 'epic', price: 1500, ...s([0x6a3ac8, 0.4, 0.2], [0x8a5ae0, 0.25, 0.8], [0xf3d577, 0.15, 1], { polymer: 'damascus', alloy: 'damascus' }) },
  { id: 'frostbite', name: 'FROSTBITE', rarity: 'epic', price: 1500, ...s([0xcfe9ff, 0.35, 0.1], [0x7fc4ff, 0.15, 0.9, 0x103a66], [0xffffff, 0.1, 1, 0x4a8ab0], { polymer: 'facets', alloy: 'facets' }) },
  { id: 'bloodmoon', name: 'BLOOD MOON', rarity: 'legendary', price: 2600, ...s([0xc01028, 0.4, 0.3, 0x2a0006], [0xff3048, 0.2, 0.9, 0x400008], [0xff2a44, 0.15, 1, 0x7a0a1a], { polymer: 'damascus', alloy: 'scales' }) },
  { id: 'solarflare', name: 'SOLAR FLARE', rarity: 'legendary', price: 2800, ...s([0xffb030, 0.4, 0.3, 0x3a1a00], [0xffa11a, 0.18, 1, 0x6a3000], [0xfff1a8, 0.12, 1, 0x806000], { polymer: 'hex', alloy: 'hex' }) },
  { id: 'holopearl', name: 'HOLO PEARL', rarity: 'legendary', price: 3000, ...s([0xeef2ff, 0.25, 0.2], [0xcfd8ff, 0.1, 0.6, 0x303868], [0xffffff, 0.06, 1, 0x5a6ab0], { polymer: 'marble', alloy: 'swirl' }) },
  { id: 'void', name: 'VOID', rarity: 'legendary', price: 3200, ...s([0x8a3cff, 0.45, 0.2, 0x1a0036], [0x7a30e0, 0.15, 0.9, 0x2a0058], [0x9a3cff, 0.12, 1, 0x5a1ab0], { polymer: 'swirl', alloy: 'swirl' }) },
].map((k) => ({ ...k, source: 'shop' }));

export const CRATE_SKINS = Object.freeze(CRATE);
export const SHOP_SKINS = Object.freeze(SHOP);
export const GUN_SKINS = Object.freeze([...CRATE, ...SHOP]);

const BY_ID = Object.fromEntries(GUN_SKINS.map((k) => [k.id, k]));
export const gunSkinInfo = (id) => BY_ID[id] ?? null;
export const skinKey = (id) => `skin:${id}`;
export const skinIdOf = (key) => (typeof key === 'string' && key.startsWith('skin:') ? key.slice(5) : null);

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
/** The colour a role actually shows: its slot colour, multiplied by its pattern's average colour. */
function shown(skin, role) {
  const base = skin.slots[role][0];
  const pat = PATTERNS[skin.tex?.[role]];
  if (!pat) return base;
  const m = (sh) => Math.round((((base >> sh) & 255) * ((pat.c >> sh) & 255)) / 255);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}
/** A CSS gradient in the skin's own colours: the swatch and the card art. */
export function skinGradient(skin) {
  return `linear-gradient(135deg, ${hex(shown(skin, 'polymer'))} 0%, ${hex(shown(skin, 'alloy'))} 52%, ${hex(shown(skin, 'steel'))} 100%)`;
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
