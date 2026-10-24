import { createDrop } from './crateDrop.js';
import { crateStill } from './crateModel.js';
import { forgetSkinShots, skinShots } from './gunicons.js';
import { texturesPending, texturesReady } from './gunTextures.js';
import {
  CRATE_PRICE, CRATE_SKINS, GUN_SKINS, RARITY, RARITY_ORDER, dailyShop, gunSkinInfo, shopEndsAt, skinGradient,
} from './gunskins.js';
import { balance, ownsSkin } from './shop.js';

/**
 * The STORE page: a skin crate you open for a random skin, and a daily shop of rarer ones you buy
 * outright. Layout and spending rules live elsewhere (src/gunskins.js, src/shop.js); this file draws
 * the page and the crate-opening reveal and asks `openCrate` / `buySkin` to do the paying.
 *
 * The pay-then-reveal order matters: `openCrate` commits the draw and the cost first, so closing the
 * page in the middle of the drop cannot lose the skin. The supply drop (src/crateDrop.js, a full-screen
 * window of its own) is only the show.
 */

const SHOWCASE_GUN = 'ar';                 // the gun every card shows its skin on
const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CRATE_ART = '<svg viewBox="0 0 96 80" aria-hidden="true"><path d="M8 26 48 8l40 18v38L48 76 8 64z" fill="#1d2a40" stroke="#9fb4d6" stroke-width="2.5" stroke-linejoin="round"/><path d="M8 26l40 18 40-18M48 44v32" fill="none" stroke="#9fb4d6" stroke-width="2.5" stroke-linejoin="round"/><path d="M30 17l40 18v13l-40-18z" fill="#f3b53f" opacity=".92"/><rect x="40" y="42" width="16" height="14" rx="3" fill="#0e1522" stroke="#f3b53f" stroke-width="2.5"/></svg>';

const pct = (tier, open) => Math.round((RARITY[tier].weight / open.reduce((n, t) => n + RARITY[t].weight, 0)) * 100);

export function createStore({ getProfile, openCrate, buySkin, openLocker = () => {}, onOpen = () => {}, onClose = () => {}, sfx = () => {}, now = () => Date.now() }) {
  let root = null, timer = 0, busy = false, shots = {};
  const drop = createDrop({ sfx, gunId: SHOWCASE_GUN });

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const isOpen = () => !!root && !root.classList.contains('hidden');

  function build() {
    root = el('div');
    root.id = 'store';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="st-card">
        <div class="st-head">
          <h2>STORE</h2>
          <span class="st-sub" id="st-count"></span>
          <button id="store-close" type="button" aria-label="Close">&#x2715;</button>
        </div>
        <div class="st-body">
          <section class="st-crate" id="st-crate">
            <div class="st-label">SKIN CRATE</div>
            <div class="st-stage" id="st-stage">
              <div class="st-art" id="st-art"></div>
            </div>
            <div class="st-odds" id="st-odds"></div>
            <button id="st-open" type="button"><i class="coin"></i><b>${CRATE_PRICE}</b><span>OPEN CRATE</span></button>
          </section>
          <section class="st-shop">
            <div class="st-label">DAILY SHOP <span class="st-timer" id="st-timer"></span></div>
            <div class="st-cards" id="st-cards"></div>
          </section>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#store-close').addEventListener('click', close);
    root.querySelector('#st-open').addEventListener('click', openOne);
    addEventListener('keydown', (e) => { if (e.code === 'Escape' && isOpen()) close(); });
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
  }

  /** A card picture: the skin on the showcase gun, in the skin's own rarity colour. */
  function art(skin) {
    const img = shots[skin.id];
    return `<span class="st-pic" style="--rc:${RARITY[skin.rarity].color}">${img ? `<img alt="" src="${img}">` : `<i style="background:${skinGradient(skin)}"></i>`}</span>`;
  }

  /** The crate's picture: a rendered one when WebGL allows, the drawn outline otherwise. */
  function paintCrate() {
    const slot = root.querySelector('#st-art');
    const put = (url) => { slot.innerHTML = url ? `<img alt="" src="${url}">` : CRATE_ART; };
    put(crateStill(put));
  }

  function renderShop() {
    const p = getProfile();
    const cards = root.querySelector('#st-cards');
    cards.textContent = '';
    for (const sk of dailyShop(now())) {
      const owned = ownsSkin(p, sk.id);
      const poor = !owned && balance(p) < sk.price;
      const c = el('div', `st-card-item${owned ? ' owned' : ''}`);
      c.style.setProperty('--rc', RARITY[sk.rarity].color);
      c.dataset.skin = sk.id;
      c.innerHTML = `${art(sk)}<div class="st-info"><b>${sk.name}</b><em>${RARITY[sk.rarity].name}</em></div>`;
      const btn = el('button', `st-buy${owned ? ' is-owned' : ''}`, owned ? `${TICK}OWNED` : `<i class="coin"></i>${sk.price}`);
      btn.type = 'button';
      btn.disabled = owned || poor;
      btn.title = owned ? 'In your collection' : poor ? `${sk.price - balance(p)} more credits needed` : 'Buy';
      btn.setAttribute('aria-label', owned ? `${sk.name}, owned` : `Buy ${sk.name} for ${sk.price} credits`);
      btn.addEventListener('click', () => { if (buySkin(sk.id)) { render(); } });
      c.append(btn);
      cards.append(c);
    }
  }

  function renderCrate() {
    const p = getProfile();
    const have = new Set(p.owned);
    const left = CRATE_SKINS.filter((k) => !have.has(`skin:${k.id}`));
    const open = RARITY_ORDER.filter((t) => left.some((k) => k.rarity === t));
    const odds = root.querySelector('#st-odds');
    odds.textContent = '';
    for (const tier of RARITY_ORDER) {
      const live = open.includes(tier);
      const total = CRATE_SKINS.filter((k) => k.rarity === tier).length;
      const got = total - left.filter((k) => k.rarity === tier).length;
      const chip = el('span', `st-odd${live ? '' : ' done'}`, `<i style="background:${RARITY[tier].color}"></i>${live ? `${pct(tier, open)}%` : TICK}<small>${got}/${total}</small>`);
      chip.title = `${RARITY[tier].name}: ${got} of ${total} collected`;
      odds.append(chip);
    }
    const btn = root.querySelector('#st-open');
    const poor = balance(p) < CRATE_PRICE;
    btn.disabled = busy || poor || !left.length;
    btn.querySelector('span').textContent = !left.length ? 'ALL COLLECTED' : poor ? `NEED ${CRATE_PRICE - balance(p)} MORE` : 'OPEN CRATE';
    root.querySelector('#st-count').textContent = `${GUN_SKINS.filter((k) => have.has(`skin:${k.id}`)).length} / ${GUN_SKINS.length} COLLECTED`;
  }

  function render() { renderShop(); renderCrate(); }

  function tickTimer() {
    const ms = Math.max(0, shopEndsAt(now()) - now());
    const s = Math.floor(ms / 1000);
    const f = (n) => String(n).padStart(2, '0');
    root.querySelector('#st-timer').textContent = `NEW IN ${f(Math.floor(s / 3600))}:${f(Math.floor((s % 3600) / 60))}:${f(s % 60)}`;
    if (ms < 1500 && !busy) renderShop();       // the day turned over while the page was up
  }

  /** Another crate right now? The drop window's third button asks. */
  function againState() {
    const p = getProfile();
    const have = new Set(p.owned);
    if (!CRATE_SKINS.some((k) => !have.has(`skin:${k.id}`))) return { ok: false, label: 'ALL COLLECTED' };
    if (balance(p) < CRATE_PRICE) return { ok: false, label: `NEED ${CRATE_PRICE - balance(p)} MORE` };
    return { ok: true, price: CRATE_PRICE };
  }

  async function openOne() {
    if (busy) return;
    const res = openCrate();
    if (!res) { render(); return; }
    busy = true;
    const win = gunSkinInfo(res.skin);
    render();
    const choice = await drop.play(win, againState());
    busy = false;
    if (!isOpen()) return;
    render();
    if (choice === 'try') { close(); openLocker(); } else if (choice === 'again') openOne();
  }

  function open() {
    if (!root) build();
    busy = false;
    root.classList.remove('hidden');
    // The pictures of the day's skins and the crate's: drawn once, kept.
    const draw = () => skinShots(SHOWCASE_GUN, [...dailyShop(now()).map((k) => k.id), ...CRATE_SKINS.map((k) => k.id)]);
    shots = draw();
    // The pattern files load on first use; once they are in, draw the pictures again with them.
    if (texturesPending()) texturesReady().then(() => { forgetSkinShots(); if (isOpen()) { shots = draw(); render(); } });
    paintCrate();
    render();
    tickTimer();
    clearInterval(timer);
    timer = setInterval(tickTimer, 1000);
    root.querySelector('#store-close').focus({ preventScroll: true });
    onOpen();
  }

  function close() {
    if (!root || !isOpen()) return;
    drop.close();
    root.classList.add('hidden');
    clearInterval(timer);
    busy = false;
    onClose();
  }

  /** The balance changed somewhere else: keep the buttons honest. */
  function refresh() { if (isOpen() && !busy) render(); }

  return { open, close, isOpen, refresh };
}
