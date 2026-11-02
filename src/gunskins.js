/**
 * Gun skins: the collectible paint jobs. Pure data and functions, no DOM, shared by the browser and
 * the account server (through src/shop.js) so a save cannot hold a skin it has not paid for.
 *
 * Two pools that never overlap:
 *   crate  only from the crate: a random draw, one price for every skin in it
 *   shop   only from the daily shop: a few of them on sale at a time, each with its own price
 *
 * `slots` repaints a gun's materials by role: [colour, roughness, metalness, glow?]. The optional
 * fourth value is an emissive colour, so a rare skin can light up. `fx` is the finish: `coat`
 * (clearcoat, 0..1), `iri` (thin-film iridescence, 0..1), `glowTex` (a pattern that lights the
 * emissive colour, so only its lines glow) and `anim` ('pulse' or 'flow', a viewer's choice: see
 * src/gunmodels.js). Skins are not tied to a gun: wear one on any gun.
 *
 * OLD IDS NEVER GO AWAY. A skin that is no longer sold has `retired: true`; it stays in GUN_SKINS,
 * so every save that owns it still syncs and it still draws, with the look it has here.
 */

export const RARITY = Object.freeze({
  common: { name: 'COMMON', color: '#9aa6b2', weight: 62 },
  rare: { name: 'RARE', color: '#4b9bff', weight: 27 },
  epic: { name: 'EPIC', color: '#b266ff', weight: 9 },
  legendary: { name: 'LEGENDARY', color: '#ffb02e', weight: 2 },
});
export const RARITY_ORDER = Object.freeze(['common', 'rare', 'epic', 'legendary']);

/** How many copies of a skin may ever be minted, by rarity. A skin can name its own cap instead. */
export const SUPPLY = Object.freeze({ common: 5000, rare: 1500, epic: 400, legendary: 120 });

/** What one crate costs. It is also the price of every skin in the crate pool, which is how the server knows what a save has paid. */
export const CRATE_PRICE = 300;
/** How many skins the daily shop shows at once. */
export const SHOP_SLOTS = 6;

/**
 * Surface patterns a skin can lay over a role's colour (generated in src/gunTextures.js). `c` is the
 * pattern's average grey, which the colour of the slot multiplies, and `scale` is how many times it
 * repeats per metre of gun. This lives here, not next to the drawing code, so the swatches in the
 * locker can be tinted without loading three.js.
 */
export const PATTERNS = Object.freeze({
  carbon: { c: 0x8c8c8c, scale: 5 },
  brushed: { c: 0xb0b0b0, scale: 5 },
  speckle: { c: 0xb0b0b0, scale: 16 },
  camo_wood: { c: 0x9a9a9a, scale: 2.2 },
  rust: { c: 0x9a9a9a, scale: 3 },
  scales: { c: 0x9a9a9a, scale: 9 },
  leather: { c: 0x9a9a9a, scale: 10 },
  lava: { c: 0x404040, scale: 2 },
  marble: { c: 0xd8d8d8, scale: 2.5 },
  hex: { c: 0x9a9a9a, scale: 6 },
  circuit: { c: 0x606060, scale: 5 },
  hazard: { c: 0x808080, scale: 6 },
  facets: { c: 0xb0b0b0, scale: 4 },
  damascus: { c: 0xa8a8a8, scale: 3 },
  swirl: { c: 0x9a9a9a, scale: 1.6 },
});

/** [colour, roughness, metalness, glow?] per role, the pattern each role wears, and the finish. */
const s = (polymer, alloy, steel, tex = null, fx = {}) => ({ slots: { polymer, alloy, steel }, tex, fx });

const CRATE = [
  // common
  { id: 'slate', name: 'GRAPHITE', rarity: 'common', ...s([0x2a2e35, 0.55, 0.1], [0x7d858f, 0.28, 0.95], [0xaab3be, 0.2, 1], { polymer: 'carbon', alloy: 'brushed', steel: 'brushed' }, { coat: 0.35 }) },
  { id: 'fielddrab', name: 'WOODLAND', rarity: 'common', ...s([0x8a8f5c, 0.8, 0.02], [0x6b7546, 0.5, 0.4], [0x3a4128, 0.5, 0.6], { polymer: 'camo_wood', alloy: 'brushed' }) },
  { id: 'rustbelt', name: 'RUST BELT', rarity: 'common', retired: true, ...s([0x8a4a2a, 0.75, 0.05], [0xb8723a, 0.6, 0.5], [0x5a3420, 0.5, 0.6], { polymer: 'rust', alloy: 'rust' }) },
  { id: 'pine', name: 'PINE NEEDLE', rarity: 'common', retired: true, ...s([0x1f5a3a, 0.5, 0.05], [0x2e6b46, 0.4, 0.6], [0x9bd0b0, 0.25, 1], { polymer: 'scales', steel: 'brushed' }, { coat: 0.4 }) },
  { id: 'concrete', name: 'CONCRETE', rarity: 'common', retired: true, ...s([0xdfe2e6, 0.9, 0.02], [0xc2c8ce, 0.8, 0.2], [0x7a8087, 0.5, 0.5], { polymer: 'speckle', alloy: 'speckle' }) },
  { id: 'mustang', name: 'MUSTANG', rarity: 'common', retired: true, ...s([0xd2813a, 0.6, 0.04], [0xc2762a, 0.4, 0.6], [0xe3b679, 0.3, 0.85], { polymer: 'leather', alloy: 'brushed' }, { coat: 0.5 }) },
  { id: 'citrus', name: 'CITRUS', rarity: 'common', retired: true, ...s([0xc6f021, 0.4, 0.1], [0xe6ff7a, 0.3, 0.5], [0xfff2a0, 0.2, 0.9], { polymer: 'scales', alloy: 'brushed' }, { coat: 0.6 }) },
  // rare
  { id: 'cobalt', name: 'COBALT', rarity: 'rare', ...s([0x1d4fd0, 0.22, 0.25], [0x2f7bff, 0.2, 0.9], [0xcfe2ff, 0.14, 1], { polymer: 'carbon' }, { coat: 1 }) },
  { id: 'jade', name: 'JADE', rarity: 'rare', ...s([0x58e0b0, 0.2, 0.05], [0x2fd0a0, 0.25, 0.7], [0xd6fff0, 0.12, 1], { polymer: 'marble' }, { coat: 0.9, iri: 0.2 }) },
  { id: 'violethaze', name: 'VIOLET HAZE', rarity: 'rare', retired: true, ...s([0x9a5cff, 0.25, 0.15], [0x8f4bff, 0.2, 0.7], [0xe0ccff, 0.15, 0.9], { polymer: 'swirl', alloy: 'damascus' }, { coat: 0.9, iri: 0.5 }) },
  { id: 'bubblegum', name: 'BUBBLEGUM', rarity: 'rare', retired: true, ...s([0xff8fc0, 0.4, 0.05], [0xffd0e6, 0.3, 0.3], [0xff5fa2, 0.25, 0.7], { polymer: 'hex', alloy: 'brushed' }, { coat: 0.7 }) },
  { id: 'sakura', name: 'SAKURA', rarity: 'rare', retired: true, ...s([0xffc4d8, 0.4, 0.04], [0xffa6c9, 0.3, 0.3], [0xffd9e8, 0.2, 0.9], { polymer: 'marble', alloy: 'damascus' }, { coat: 0.8 }) },
  { id: 'hazard', name: 'HAZARD', rarity: 'rare', retired: true, ...s([0xffcf00, 0.5, 0.05], [0xffcf00, 0.4, 0.4, 0x3a3000], [0x4a4a4a, 0.4, 0.8], { polymer: 'hazard', alloy: 'hazard' }, { coat: 0.4 }) },
  // epic
  { id: 'neoncircuit', name: 'NEON CIRCUIT', rarity: 'epic', ...s([0x0b1a22, 0.4, 0.2, 0x00c8ff], [0x1a8aa8, 0.3, 0.8, 0x00b0e0], [0x00e5ff, 0.2, 0.9, 0x00a3b8], { polymer: 'circuit', alloy: 'brushed' }, { coat: 0.6, glowTex: 'circuit', anim: 'pulse' }) },
  { id: 'toxic', name: 'TOXIC DRIP', rarity: 'epic', ...s([0x1e3a10, 0.5, 0.1], [0x6dff2a, 0.35, 0.4, 0x1f6a08], [0x2d5a18, 0.4, 0.7], { polymer: 'hex', alloy: 'lava' }, { coat: 0.5, glowTex: 'lava', anim: 'flow' }) },
  { id: 'icefang', name: 'ICE FANG', rarity: 'epic', ...s([0xbfeaff, 0.12, 0.1], [0x9ee7ff, 0.1, 0.9], [0xffffff, 0.08, 1], { polymer: 'facets', alloy: 'facets' }, { coat: 1, iri: 0.9 }) },
  { id: 'magma', name: 'MAGMA', rarity: 'epic', retired: true, ...s([0x2a130a, 0.8, 0.1], [0xff7a3a, 0.35, 0.5, 0x5a1500], [0x4a2a1c, 0.4, 0.8], { polymer: 'lava', alloy: 'lava' }, { coat: 0.3, glowTex: 'lava' }) },
  // legendary
  { id: 'aurora', name: 'AURORA', rarity: 'legendary', ...s([0x0a2a24, 0.25, 0.3], [0x22ffb0, 0.2, 0.9, 0x0a6a4a], [0xb26bff, 0.15, 1, 0x3a1670], { polymer: 'swirl', alloy: 'damascus' }, { coat: 1, iri: 1, anim: 'flow' }) },
  { id: 'obsidianflame', name: 'OBSIDIAN FLAME', rarity: 'legendary', ...s([0x141414, 0.35, 0.2, 0xd04800], [0x2a1208, 0.3, 0.6, 0xff5a10], [0xff6a00, 0.2, 1, 0xff7a20], { polymer: 'lava', alloy: 'lava', steel: 'lava' }, { coat: 0.7, glowTex: 'lava', anim: 'pulse' }) },
].map((k) => ({ ...k, source: 'crate', price: CRATE_PRICE }));

const SHOP = [
  { id: 'chrome', name: 'CHROME', rarity: 'rare', price: 700, retired: true, ...s([0xdfe6ee, 0.08, 0.95], [0xe9eff6, 0.06, 1], [0xffffff, 0.04, 1], { polymer: 'brushed' }, { coat: 1, iri: 0.3 }) },
  { id: 'carbonember', name: 'CARBON EMBER', rarity: 'rare', price: 900, ...s([0x1c1c20, 0.35, 0.3], [0x2a2a30, 0.3, 0.7, 0x7a2800], [0xff7a1a, 0.2, 1, 0xff6a10], { polymer: 'carbon', alloy: 'carbon' }, { coat: 0.9, glowTex: 'lava', anim: 'pulse' }) },
  { id: 'royal', name: 'ROYAL', rarity: 'epic', price: 1300, ...s([0x6a3ac8, 0.3, 0.2], [0x8a5ae0, 0.25, 0.8], [0xf3d577, 0.15, 1], { polymer: 'damascus', alloy: 'damascus' }, { coat: 1, iri: 0.25 }) },
  { id: 'frostbite', name: 'FROSTBITE', rarity: 'epic', price: 1500, ...s([0xcfe9ff, 0.3, 0.1], [0x7fc4ff, 0.15, 0.9, 0x103a66], [0xffffff, 0.1, 1, 0x4a8ab0], { polymer: 'facets', alloy: 'facets' }, { coat: 1, iri: 0.6, glowTex: 'facets', anim: 'pulse' }) },
  { id: 'bloodmoon', name: 'BLOOD MOON', rarity: 'epic', price: 1800, retired: true, ...s([0xc01028, 0.4, 0.3, 0x2a0006], [0xff3048, 0.2, 0.9, 0x400008], [0xff2a44, 0.15, 1, 0x7a0a1a], { polymer: 'damascus', alloy: 'scales' }, { coat: 0.8 }) },
  { id: 'solarflare', name: 'SOLAR FLARE', rarity: 'legendary', price: 2800, ...s([0xffb030, 0.4, 0.3, 0x3a1a00], [0xffa11a, 0.18, 1, 0x6a3000], [0xfff1a8, 0.12, 1, 0x806000], { polymer: 'hex', alloy: 'hex' }, { coat: 1, glowTex: 'hex', anim: 'pulse' }) },
  { id: 'holopearl', name: 'HOLO PEARL', rarity: 'legendary', price: 3000, ...s([0xeef2ff, 0.2, 0.2], [0xcfd8ff, 0.1, 0.6, 0x303868], [0xffffff, 0.06, 1, 0x5a6ab0], { polymer: 'marble', alloy: 'swirl' }, { coat: 1, iri: 1, anim: 'flow' }) },
  { id: 'tidewater', name: 'TIDEWATER', rarity: 'rare', price: 800, ...s([0x0f4c5c, 0.3, 0.2], [0x1b8a9e, 0.25, 0.8], [0xc8f0f6, 0.14, 1], { polymer: 'hex', alloy: 'brushed' }, { coat: 0.9 }) },
  { id: 'bronzeage', name: 'BRONZE AGE', rarity: 'epic', price: 1600, ...s([0x7a5230, 0.45, 0.35], [0xc08a3e, 0.3, 0.9], [0x3a2a1a, 0.4, 0.7], { polymer: 'damascus', alloy: 'scales' }, { coat: 0.6 }) },
  { id: 'nightwing', name: 'NIGHTWING', rarity: 'epic', price: 1900, ...s([0x0d0f1f, 0.3, 0.3, 0x3a50ff], [0x2a2f6a, 0.25, 0.9, 0x3a50ff], [0x7a8cff, 0.15, 1, 0x3040c0], { polymer: 'circuit', alloy: 'leather' }, { coat: 0.8, glowTex: 'circuit', anim: 'pulse' }) },
  { id: 'void', name: 'VOID', rarity: 'legendary', price: 3200, ...s([0x8a3cff, 0.4, 0.2, 0x1a0036], [0x7a30e0, 0.15, 0.9, 0x2a0058], [0x9a3cff, 0.12, 1, 0x5a1ab0], { polymer: 'swirl', alloy: 'swirl' }, { coat: 1, iri: 0.4, glowTex: 'swirl', anim: 'pulse' }) },
  { id: 'royalgold', name: 'ROYAL GOLD', rarity: 'legendary', price: 3500, retired: true, ...s([0xf3d577, 0.2, 1], [0xffe08a, 0.15, 1], [0xffffff, 0.1, 1, 0x806000], { polymer: 'damascus' }, { coat: 1 }) },
].map((k) => ({ ...k, source: 'shop' }));

/** Every skin there has ever been, retired ones included: a save that owns one always resolves. */
export const GUN_SKINS = Object.freeze([...CRATE, ...SHOP]);
/** The skins on sale now. A retired skin is still in GUN_SKINS, but nothing sells it. */
export const CRATE_SKINS = Object.freeze(CRATE.filter((k) => !k.retired));
export const SHOP_SKINS = Object.freeze(SHOP.filter((k) => !k.retired));

const BY_ID = Object.fromEntries(GUN_SKINS.map((k) => [k.id, k]));
export const gunSkinInfo = (id) => BY_ID[id] ?? null;
export const skinKey = (id) => `skin:${id}`;
export const skinIdOf = (key) => (typeof key === 'string' && key.startsWith('skin:') ? key.slice(5) : null);
/** Copies of skin `id` that may ever exist. Only the server counts them; see server/accounts.js. */
export const supplyCap = (id) => {
  const k = gunSkinInfo(id);
  return k ? (k.cap ?? SUPPLY[k.rarity]) : 0;
};

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

/** The skins on sale on the day `ms` falls in: SHOP_SLOTS of them, the same for every player. */
export function dailyShop(ms) {
  const rng = seeded(shopDay(ms) * 2654435761);
  const pool = [...SHOP_SKINS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Best first: the rarer the skin, the nearer the top of the shop, dearest first within a tier.
  return pool.slice(0, SHOP_SLOTS)
    .sort((a, b) => (RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)) || (b.price - a.price));
}

/**
 * One crate draw. Rarity is rolled by weight, then a skin you do not own yet is picked in it; a
 * tier you have finished is skipped for the nearest one that has something left. Returns the skin
 * id, or null once the whole crate pool is yours. `owned` is the profile's item keys. `stock(id)`
 * says how many copies of a skin can still be minted (the server's count); a sold-out skin is skipped.
 */
export function rollCrate(owned, rng = Math.random, stock = () => Infinity) {
  const have = new Set(owned ?? []);
  const left = (tier) => CRATE_SKINS.filter((k) => k.rarity === tier && !have.has(skinKey(k.id)) && stock(k.id) > 0);
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
