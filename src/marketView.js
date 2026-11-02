import { RARITY, RARITY_ORDER, gunSkinInfo, skinGradient, skinIdOf, supplyCap } from './gunskins.js';
import { MARKET_MAX_PRICE, validListingPrice } from './market.js';
import { balance } from './shop.js';

/**
 * The MARKET page: skins other players have listed for credits, and your own skins for sale. The
 * server does all the counting and the paying (server/accounts.js); this page only asks for it through
 * `skinCall` (src/account.js) and draws what comes back. Signed out, the page says so and does nothing.
 *
 * Listing prices are checked here too (src/market.js validListingPrice) so a typo never reaches the server.
 */

const ERRORS = {
  poor: 'Not enough credits for that.',
  sold_out: 'Every copy of that skin is already minted.',
  own_listing: 'That is your own listing.',
  price: `A price must be a whole number of credits, at least the skin's price and at most ${MARKET_MAX_PRICE}.`,
  listed: 'You already have that skin for sale.',
  not_owned: 'You do not own that skin.',
  not_listed: 'That listing is gone.',
  offline: 'The server could not be reached.',
  signed_out: 'Sign in to trade skins.',
};
const explain = (r) => ERRORS[r.error] ?? r.message ?? 'Something went wrong on the server.';

export function createMarket({ getProfile, skinCall, signedIn, openStore = () => {}, onOpen = () => {}, onClose = () => {} }) {
  let root = null, data = null, note = '';
  const isOpen = () => !!root && !root.classList.contains('hidden');

  function build() {
    root = document.createElement('div');
    root.id = 'market';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="mk-card" role="dialog" aria-labelledby="mk-title">
        <div class="mk-head">
          <h2 id="mk-title">MARKET</h2>
          <span class="mk-bal" id="mk-bal"></span>
          <button type="button" id="mk-store">STORE</button>
          <button type="button" id="mk-close" aria-label="Close">&#x2715;</button>
        </div>
        <p class="mk-note" id="mk-note" aria-live="polite"></p>
        <div class="mk-body">
          <section class="mk-for-sale">
            <div class="mk-label">FOR SALE <span id="mk-count"></span></div>
            <div class="mk-grid" id="mk-grid"></div>
          </section>
          <section class="mk-sell">
            <div class="mk-label">SELL A SKIN</div>
            <label class="mk-field">Skin
              <select id="mk-pick"></select>
            </label>
            <label class="mk-field">Price (credits)
              <input id="mk-price" type="number" inputmode="numeric" step="1" min="0">
            </label>
            <p class="mk-hint" id="mk-hint"></p>
            <button type="button" id="mk-list" class="mk-primary">LIST FOR SALE</button>
          </section>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#mk-close').addEventListener('click', close);
    root.querySelector('#mk-store').addEventListener('click', () => { close(); openStore(); });
    root.querySelector('#mk-pick').addEventListener('change', syncPrice);
    root.querySelector('#mk-list').addEventListener('click', list);
    root.querySelector('#mk-grid').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || b.disabled) return;
      const id = Number(b.dataset.id);
      run(b.dataset.act === 'buy' ? skinCall('POST', '/api/market/buy', { id }) : skinCall('POST', '/api/market/cancel', { id }));
    });
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    addEventListener('keydown', (e) => { if (e.code === 'Escape' && isOpen()) close(); });
  }

  /** The skins you own that are not already for sale, in rarity order. */
  function sellable() {
    const listed = new Set((data?.listings ?? []).filter((l) => l.mine).map((l) => l.skin));
    return (getProfile().owned ?? [])
      .map(skinIdOf)
      .filter((id) => id && gunSkinInfo(id) && !listed.has(id))
      .sort((a, b) => RARITY_ORDER.indexOf(gunSkinInfo(b).rarity) - RARITY_ORDER.indexOf(gunSkinInfo(a).rarity));
  }

  function syncPrice() {
    const id = root.querySelector('#mk-pick').value;
    const k = gunSkinInfo(id);
    if (!k) return;
    const value = data?.values?.[id] ?? k.price;
    root.querySelector('#mk-price').value = String(value);
    root.querySelector('#mk-price').min = String(k.price);
    root.querySelector('#mk-hint').textContent = `Floor ${k.price} credits. Market value now ${value}.`;
  }

  function render() {
    const p = getProfile();
    const on = signedIn();
    root.querySelector('#mk-bal').textContent = on ? `${balance(p)} CREDITS` : '';
    root.querySelector('#mk-note').textContent = note || (on ? '' : 'Sign in to buy and sell skins.');
    const grid = root.querySelector('#mk-grid');
    grid.textContent = '';
    const listings = data?.listings ?? [];
    root.querySelector('#mk-count').textContent = on && data ? `(${listings.length})` : '';
    if (!listings.length) {
      grid.innerHTML = `<p class="mk-empty">${!on ? 'Sign in to see what other players are selling, and to list your own skins.' : data ? 'Nothing is for sale right now.' : 'Loading the market…'}</p>`;
    }
    for (const l of listings) {
      const k = gunSkinInfo(l.skin);
      if (!k) continue;
      const poor = !l.mine && balance(p) < l.price;
      const item = document.createElement('article');
      item.className = `mk-item${l.mine ? ' mine' : ''}`;
      item.style.setProperty('--rc', RARITY[k.rarity].color);
      item.innerHTML = `
        <span class="mk-pic"><i style="background:${skinGradient(k)}"></i></span>
        <div class="mk-info">
          <b>${k.name}</b>
          <em>${RARITY[k.rarity].name}</em>
          <small>${l.mine ? 'Your listing' : `From ${escapeHtml(l.seller)}`} · ${data.supply[k.id] ?? 0} of ${supplyCap(k.id)} minted</small>
        </div>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mk-act';
      btn.dataset.id = String(l.id);
      btn.dataset.act = l.mine ? 'cancel' : 'buy';
      btn.disabled = !on || (!l.mine && poor);
      btn.textContent = l.mine ? 'CANCEL' : `BUY ${l.price}`;
      btn.title = l.mine ? 'Take it off the market' : poor ? 'Not enough credits' : `Buy for ${l.price} credits`;
      item.append(btn);
      grid.append(item);
    }
    const pick = root.querySelector('#mk-pick');
    const before = pick.value;
    pick.textContent = '';
    for (const id of on && data ? sellable() : []) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = gunSkinInfo(id).name;
      pick.append(o);
    }
    if (before && [...pick.options].some((o) => o.value === before)) pick.value = before;
    const canSell = on && !!data && pick.options.length > 0;
    pick.disabled = !canSell;
    root.querySelector('#mk-price').disabled = !canSell;
    root.querySelector('#mk-list').disabled = !canSell;
    if (canSell && pick.value !== before) syncPrice();
    if (!canSell) root.querySelector('#mk-hint').textContent = on && data ? 'Every skin you own is already for sale, or you own none.' : '';
  }

  async function load() {
    if (!signedIn()) { data = null; render(); return; }
    const r = await skinCall('GET', '/api/market');
    if (r.ok) data = r; else { data = null; note = explain(r); }
    render();
  }

  /** Runs a market call, says what happened, and redraws from the server's answer. */
  async function run(call) {
    const r = await call;
    note = r.ok ? 'Done.' : explain(r);
    await load();
  }

  function list() {
    const id = root.querySelector('#mk-pick').value;
    const price = Number(root.querySelector('#mk-price').value);
    if (!gunSkinInfo(id) || !validListingPrice(id, price)) { note = ERRORS.price; render(); return; }
    run(skinCall('POST', '/api/market/list', { skin: id, price }));
  }

  function open() {
    if (!root) build();
    root.classList.remove('hidden');
    onOpen();
    note = '';
    render();
    load();
    root.querySelector('#mk-close').focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    root.classList.add('hidden');
    onClose();
  }

  return { open, close, isOpen, refresh: () => { if (isOpen()) load(); } };
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
