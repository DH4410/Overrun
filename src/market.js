import { gunSkinInfo, supplyCap } from './gunskins.js';

/**
 * The skin market: what a skin is worth, and what a listing may ask. Pure functions, shared by the
 * browser (to show the price) and the account server (to refuse a bad listing). The server keeps the
 * listings and the minted counts; see server/accounts.js.
 */

export const MARKET_MAX_PRICE = 100_000;
export const MARKET_SALES_KEPT = 20;

/**
 * The market value of skin `id` once `minted` copies exist and `sales` are the recent sale prices
 * (oldest first). It starts at the skin's price and climbs with scarcity: the fewer copies left
 * to mint, the higher the multiplier, up to six times. Recent sales pull it toward what people pay.
 * It never drops below the skin's price, which is also the lowest a listing may ask.
 */
export function marketValue(id, minted = 0, sales = []) {
  const skin = gunSkinInfo(id);
  if (!skin) return 0;
  const cap = supplyCap(id);
  const left = Math.max(1, cap - Math.min(cap, Math.max(0, minted)));
  const scarcity = Math.min(6, Math.max(1, Math.sqrt(cap / left)));
  const base = skin.price * scarcity;
  const recent = (Array.isArray(sales) ? sales : []).slice(-5);
  if (!recent.length) return Math.round(base);
  const avg = recent.reduce((s, p) => s + p, 0) / recent.length;
  return Math.round(Math.max(skin.price, (base + avg) / 2));
}

/** Can a listing ask `price` for skin `id`? Whole credits, at least the skin's price, not absurd. */
export function validListingPrice(id, price) {
  const skin = gunSkinInfo(id);
  return !!skin && Number.isInteger(price) && price >= skin.price && price <= MARKET_MAX_PRICE;
}
