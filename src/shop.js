import { CRATE_PRICE, GUN_SKINS, dailyShop, gunSkinInfo, rollCrate, skinKey } from './gunskins.js';

/**
 * Credits: the currency matches pay out and the armory spends. Pure data and functions, no DOM,
 * shared by the browser and the account server so a save cannot hold a gun it has not paid for.
 *
 * A career keeps three numbers for this, none of which ever goes down on its own:
 *   credits  everything ever earned
 *   spent    everything ever spent
 *   owned    what was bought, as item keys ("gun:lmg", "skin:cobalt")
 * The balance is credits - spent. Keeping earned and spent apart is what lets two devices merge
 * without a spent credit coming back.
 */

/** Credits paid per XP earned in a match, and a flat bonus for every level gained. */
export const CREDITS = Object.freeze({ PER_XP: 0.8, LEVEL_UP: 50 });

/** The guns that cost credits. Every gun not listed here is free from the start. */
export const GUN_PRICES = Object.freeze({ mp: 400, revolver: 500, ashotgun: 800, lmg: 1000, dmr: 1200 });

export const gunKey = (id) => `gun:${id}`;
// Gun skins are items too: "skin:<id>", priced by their pool (see src/gunskins.js).
const PRICE_BY_KEY = {
  ...Object.fromEntries(Object.entries(GUN_PRICES).map(([id, p]) => [gunKey(id), p])),
  ...Object.fromEntries(GUN_SKINS.map((k) => [skinKey(k.id), k.price])),
};

/** Is `key` something that can be bought? Anything else in a save is junk and gets dropped. */
export const isShopKey = (key) => Object.hasOwn(PRICE_BY_KEY, key);
export const priceOf = (key) => PRICE_BY_KEY[key] ?? 0;
export const gunPrice = (id) => GUN_PRICES[id] ?? 0;

export const creditsForXp = (xp) => Math.round(Math.max(0, xp) * CREDITS.PER_XP);

/** What a set of bought items cost in total. */
export function ownedValue(owned) {
  return [...new Set(owned ?? [])].reduce((s, k) => s + priceOf(k), 0);
}

export const balance = (profile) => Math.max(0, (profile?.credits ?? 0) - (profile?.spent ?? 0));

/** Free guns are always yours; the others once bought. */
export const ownsGun = (profile, id) => gunPrice(id) === 0 || (profile?.owned ?? []).includes(gunKey(id));

/** The most credits a career with `xp` and `level` can honestly have earned: what the server checks. */
export const maxCredits = (xp, level) => Math.ceil(xp * CREDITS.PER_XP) + CREDITS.LEVEL_UP * Math.max(0, level - 1) + matchRoundingSlack(xp);
// Each match rounds its payout once, so a long career can sit a little above the sum of its parts.
function matchRoundingSlack(xp) { return Math.ceil(xp / 100) + 5; }

/** Buy a gun: the new profile fields, or null if it is free, owned already, or too dear. */
export function buyGun(profile, id) {
  const price = gunPrice(id);
  if (!price || ownsGun(profile, id) || balance(profile) < price) return null;
  return { ...profile, spent: profile.spent + price, owned: [...profile.owned, gunKey(id)] };
}

export const ownsSkin = (profile, id) => (profile?.owned ?? []).includes(skinKey(id));

/** Buy a skin from today's shop: the new profile, or null if it is not on sale now, owned already, or too dear. */
export function buyShopSkin(profile, id, now = Date.now()) {
  const skin = gunSkinInfo(id);
  if (!skin || skin.source !== 'shop' || ownsSkin(profile, id)) return null;
  if (!dailyShop(now).some((k) => k.id === id) || balance(profile) < skin.price) return null;
  return { ...profile, spent: profile.spent + skin.price, owned: [...profile.owned, skinKey(id)] };
}

/** Open a crate: `{ profile, skin }`, or null if it is too dear or there is nothing left in it to win. `rng` is for tests. */
export function openCrate(profile, rng = Math.random) {
  if (balance(profile) < CRATE_PRICE) return null;
  const skin = rollCrate(profile.owned, rng);
  if (!skin) return null;
  return { profile: { ...profile, spent: profile.spent + CRATE_PRICE, owned: [...profile.owned, skinKey(skin)] }, skin };
}
