import { COUNTERS, clean, levelFromXp, mergeProfiles } from '../src/profile.js';
import { balance, maxCredits, ownedValue } from '../src/shop.js';
import { CRATE_PRICE, GUN_SKINS, dailyShop, gunSkinInfo, rollCrate, skinIdOf, skinKey, supplyCap } from '../src/gunskins.js';
import { MARKET_MAX_PRICE, MARKET_SALES_KEPT, marketValue, validListingPrice } from '../src/market.js';
import { sanitizeEquipped } from '../src/rewards.js';

/**
 * Accounts: sign up, sign in, and a career saved on the server.
 *
 * The service is storage-agnostic. `store` is anything with async get(key), put(key, value) and
 * delete(key): a Durable Object's storage on Cloudflare (server/accounts-do.js), a JSON file in
 * the local server (server/accounts-file.js), a Map in the tests. Nothing here touches the network.
 *
 *  - Passwords are never stored. Each gets its own random salt and is run through PBKDF2-SHA256
 *    (`iterations`, 100,000 by default - the most a Cloudflare Worker allows).
 *  - Session tokens are 256 random bits. Only their SHA-256 is stored, so a leaked database
 *    cannot be replayed as logins.
 *  - Because there is no email service, a lost password is recovered with a one-time recovery
 *    code shown once at sign-up. Using it issues a new one.
 *  - The profile is the player's single-player career, which the client computes. The server
 *    cannot check a match was played, so it only keeps the career from going backwards, caps
 *    absurd values and refuses rewards the numbers have not earned. It is a save file, not an
 *    anti-cheat.
 */

export class AccountError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,12}$/;       // 12 is the callsign length the game already uses
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const PASSWORD_MIN = 8, PASSWORD_MAX = 128;
const SESSION_DAYS = 30, MAX_SESSIONS = 8, COUNTER_CAP = 1_000_000_000;

const enc = new TextEncoder();
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const sha256Hex = async (text) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));

async function pbkdf2(secret, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

/** Compare without stopping at the first difference. */
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function makeSecret(secret, iterations) {
  const salt = randomHex(16);
  return { salt, iter: iterations, hash: await pbkdf2(secret, salt, iterations) };
}
const checkSecret = async (secret, rec) => sameHex(await pbkdf2(secret, rec.salt, rec.iter), rec.hash);

/** A recovery code a person can read out and type: four groups of five, no look-alike characters. */
function newRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{5}/g).join('-');
}
const normaliseRecovery = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/*
 * Skins are the server's. A crate, the shop and the market hand them out, and a sale takes one away;
 * a save can only add a skin the career never held, while copies are left under the cap. `held` is
 * every skin key the career has ever had, so a stale device cannot bring a sold one back.
 */
const isSkin = (k) => typeof k === 'string' && k.startsWith('skin:');
const heldBy = (u) => new Set([...(u.held ?? []), ...(u.profile.owned ?? []).filter(isSkin)]);
const stockOf = (supply) => (id) => Math.max(0, supplyCap(id) - (supply[id] ?? 0));
const MAX_LISTINGS = 500;

export class Accounts {
  /** `grants`: { usernameLc: credits }, gifts the owner has configured for specific accounts (tests, prizes). */
  constructor({ store, iterations = 100_000, now = () => Date.now(), grants = {} }) {
    this.store = store;
    this.grants = grants;
    this.iterations = iterations;
    this.now = now;
    this.locks = new Map();
    // Never matches a real login: spent on unknown names so they take as long as real ones.
    this.decoy = null;
  }

  /** Run `fn` after anything already holding `key`, so two sign-ups for one name cannot both win. */
  async withLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    this.locks.set(key, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally { release(); if (this.locks.get(key) === mine) this.locks.delete(key); }
  }

  async userByLogin(login) {
    const key = String(login ?? '').trim().toLowerCase();
    if (!key) return null;
    if (key.includes('@')) {
      const name = await this.store.get(`e:${key}`);
      return name ? this.store.get(`u:${name}`) : null;
    }
    return this.store.get(`u:${key}`);
  }

  publicUser(u) {
    return { username: u.username, email: u.email ?? null, created: u.created };
  }

  async startSession(u) {
    const token = randomHex(32);
    const hash = await sha256Hex(token);
    const exp = this.now() + SESSION_DAYS * 86_400_000;
    await this.store.put(`s:${hash}`, { u: u.usernameLc, exp });
    u.sessions = [...(u.sessions ?? []).filter((s) => s.exp > this.now()), { h: hash, exp }].slice(-MAX_SESSIONS);
    return token;
  }

  async endSessions(u) {
    for (const s of u.sessions ?? []) await this.store.delete(`s:${s.h}`);
    u.sessions = [];
  }

  async register({ username, email, password }) {
    username = String(username ?? '').trim();
    email = String(email ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw new AccountError(400, 'username', 'Usernames are 3 to 12 letters, numbers, - or _.');
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) throw new AccountError(400, 'email', 'That email address does not look right.');
    this.checkPassword(password);
    const lc = username.toLowerCase();
    return this.withLock(`u:${lc}`, async () => {
      if (await this.store.get(`u:${lc}`)) throw new AccountError(409, 'taken', 'That username is taken.');
      if (email && await this.store.get(`e:${email}`)) throw new AccountError(409, 'email_taken', 'That email already has an account.');
      const recoveryCode = newRecoveryCode();
      const u = {
        username, usernameLc: lc, email: email || null, created: this.now(),
        pw: await makeSecret(password, this.iterations),
        recovery: await makeSecret(normaliseRecovery(recoveryCode), this.iterations),
        profile: clean(null), rev: 0, sessions: [],
      };
      const token = await this.startSession(u);
      await this.store.put(`u:${lc}`, u);
      if (email) await this.store.put(`e:${email}`, lc);
      return { token, user: this.publicUser(u), profile: u.profile, rev: u.rev, recoveryCode };
    });
  }

  checkPassword(password) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) throw new AccountError(400, 'password', `Passwords need at least ${PASSWORD_MIN} characters.`);
    if (password.length > PASSWORD_MAX) throw new AccountError(400, 'password', `Passwords can be at most ${PASSWORD_MAX} characters.`);
  }

  async login({ login, password }) {
    const u = await this.userByLogin(login);
    if (!u) {
      this.decoy ??= await makeSecret('decoy', this.iterations);
      await checkSecret(String(password ?? ''), this.decoy);
      throw new AccountError(401, 'credentials', 'Wrong username or password.');
    }
    if (typeof password !== 'string' || !(await checkSecret(password, u.pw))) throw new AccountError(401, 'credentials', 'Wrong username or password.');
    return this.withLock(`u:${u.usernameLc}`, async () => {
      const fresh = await this.store.get(`u:${u.usernameLc}`);
      const token = await this.startSession(fresh);
      await this.store.put(`u:${fresh.usernameLc}`, fresh);
      return { token, fresh };
    }).then(async ({ token, fresh }) => {
      const paid = await this.granted(fresh);
      return { token, user: this.publicUser(paid), profile: paid.profile, rev: paid.rev };
    });
  }

  /** The account a session cookie belongs to, or null. */
  async session(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = await sha256Hex(token);
    const s = await this.store.get(`s:${hash}`);
    if (!s) return null;
    if (s.exp <= this.now()) { await this.store.delete(`s:${hash}`); return null; }
    return this.granted(await this.store.get(`u:${s.u}`));
  }

  /**
   * Pay out a configured gift once. `u.granted` is how much of it the account already has, so a
   * restart or a second login never pays twice and raising the number in the config pays the difference.
   */
  async granted(u) {
    const want = Math.floor(Number(u && this.grants[u.usernameLc]) || 0);
    if (!u || want <= (u.granted ?? 0)) return u;
    return this.withLock(`u:${u.usernameLc}`, async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur || want <= (cur.granted ?? 0)) return cur;
      cur.profile = { ...cur.profile, credits: cur.profile.credits + (want - (cur.granted ?? 0)) };
      cur.granted = want;
      cur.rev += 1;
      await this.store.put(`u:${cur.usernameLc}`, cur);
      return cur;
    });
  }

  async logout(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return;
    const hash = await sha256Hex(token);
    const s = await this.store.get(`s:${hash}`);
    await this.store.delete(`s:${hash}`);
    if (!s) return;
    await this.withLock(`u:${s.u}`, async () => {
      const u = await this.store.get(`u:${s.u}`);
      if (!u) return;
      u.sessions = (u.sessions ?? []).filter((x) => x.h !== hash);
      await this.store.put(`u:${s.u}`, u);
    });
  }

  /**
   * Save the career. `rev` is the revision the client last saw: if someone else saved since
   * (another device), nothing is written and the stored career comes back to be merged.
   */
  async saveProfile(u, { profile, rev }) {
    return this.withLocks(['supply', `u:${u.usernameLc}`], async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur) throw new AccountError(404, 'gone', 'This account no longer exists.');
      if (Number(rev) !== cur.rev) throw new AccountError(409, 'conflict', 'Your career changed on another device.');
      const next = clean(profile);
      for (const k of COUNTERS) {
        if (next[k] > COUNTER_CAP) throw new AccountError(400, 'range', 'That career has impossible numbers.');
        if (next[k] < cur.profile[k]) throw new AccountError(400, 'regress', 'A career cannot go backwards.');
      }
      // Credits follow XP, plus what the market paid out; spending cannot exceed what was earned, and
      // what was bought must have been paid for and cannot be given back.
      if (next.credits > maxCredits(next.xp, levelFromXp(next.xp).level) + (cur.granted ?? 0) + (cur.marketIn ?? 0)) throw new AccountError(400, 'range', 'That career has more credits than it could have earned.');
      // Skins: keep the ones the server handed out; a skin never held before is a claim, counted against the cap.
      const held = heldBy(cur);
      const supply = (await this.store.get('supply')) ?? {};
      const skins = (cur.profile.owned ?? []).filter(isSkin);
      let claims = 0;
      for (const k of next.owned.filter(isSkin)) {
        const id = skinIdOf(k);
        if (held.has(k) || stockOf(supply)(id) <= 0) continue;
        skins.push(k); held.add(k); supply[id] = (supply[id] ?? 0) + 1; claims += 1;
      }
      next.owned = [...next.owned.filter((k) => !isSkin(k)), ...skins];
      if (next.spent > next.credits || ownedValue(next.owned) > next.spent) throw new AccountError(400, 'range', 'That career has spent more than it has.');
      if ((cur.profile.owned ?? []).some((k) => !isSkin(k) && !next.owned.includes(k))) throw new AccountError(400, 'regress', 'A career cannot lose what it bought.');
      next.equipped = sanitizeEquipped(next, next.equipped);
      if (claims) await this.store.put('supply', supply);
      cur.held = [...held];
      cur.profile = next;
      cur.rev += 1;
      await this.store.put(`u:${cur.usernameLc}`, cur);
      return { profile: cur.profile, rev: cur.rev };
    });
  }

  /** Lock several keys in one fixed order, so two requests that take the same pair cannot deadlock. */
  async withLocks(keys, fn) {
    const sorted = [...new Set(keys)].sort();
    const run = (i) => (i === sorted.length ? fn() : this.withLock(sorted[i], () => run(i + 1)));
    return run(0);
  }

  /** Roll a crate on the server and pay for it. The new copy counts against the skin's supply. */
  async openCrateFor(u, { rng = Math.random } = {}) {
    return this.withLocks(['supply', `u:${u.usernameLc}`], async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur) throw new AccountError(404, 'gone', 'This account no longer exists.');
      if (balance(cur.profile) < CRATE_PRICE) throw new AccountError(402, 'poor', `A crate costs ${CRATE_PRICE} credits.`);
      const supply = (await this.store.get('supply')) ?? {};
      const held = heldBy(cur);
      const id = rollCrate([...held], rng, stockOf(supply));
      if (!id) throw new AccountError(409, 'sold_out', 'Every skin in the crate has been minted.');
      supply[id] = (supply[id] ?? 0) + 1;
      cur.held = [...held, skinKey(id)];
      cur.profile = clean({ ...cur.profile, spent: cur.profile.spent + CRATE_PRICE, owned: [...cur.profile.owned, skinKey(id)] });
      cur.rev += 1;
      await this.store.put('supply', supply);
      await this.store.put(`u:${cur.usernameLc}`, cur);
      return { profile: cur.profile, rev: cur.rev, skin: id };
    });
  }

  /** Buy a skin from today's shop, once per career, while copies are left. */
  async buyShopFor(u, id, { now = this.now() } = {}) {
    return this.withLocks(['supply', `u:${u.usernameLc}`], async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur) throw new AccountError(404, 'gone', 'This account no longer exists.');
      const skin = gunSkinInfo(id);
      if (!skin || skin.source !== 'shop' || !dailyShop(now).some((k) => k.id === id)) throw new AccountError(409, 'not_on_sale', 'That skin is not in today\'s shop.');
      const key = skinKey(id);
      const held = heldBy(cur);
      if (held.has(key)) throw new AccountError(409, 'owned', 'You already have that skin.');
      if (balance(cur.profile) < skin.price) throw new AccountError(402, 'poor', 'Not enough credits.');
      const supply = (await this.store.get('supply')) ?? {};
      if (stockOf(supply)(id) <= 0) throw new AccountError(409, 'sold_out', 'That skin has been minted out.');
      supply[id] = (supply[id] ?? 0) + 1;
      cur.held = [...held, key];
      cur.profile = clean({ ...cur.profile, spent: cur.profile.spent + skin.price, owned: [...cur.profile.owned, key] });
      cur.rev += 1;
      await this.store.put('supply', supply);
      await this.store.put(`u:${cur.usernameLc}`, cur);
      return { profile: cur.profile, rev: cur.rev };
    });
  }

  async marketState() {
    return (await this.store.get('market')) ?? { seq: 1, items: [], sales: {} };
  }

  /** The market as anyone signed in sees it: the listings, the minted counts and each skin's value right now. */
  async market(u) {
    const m = await this.marketState();
    const supply = (await this.store.get('supply')) ?? {};
    const values = Object.fromEntries(GUN_SKINS.map((k) => [k.id, marketValue(k.id, supply[k.id] ?? 0, m.sales[k.id] ?? [])]));
    const listings = m.items.map((i) => ({ id: i.id, skin: i.skin, seller: i.sellerName, price: i.price, mine: i.seller === u.usernameLc }));
    return { listings, supply, values, sales: m.sales };
  }

  /** Offer a skin you own for credits. It stays yours, and in your collection, until someone buys it. */
  async listSkin(u, { skin, price }) {
    const id = String(skin ?? '');
    if (!validListingPrice(id, price)) throw new AccountError(400, 'price', `A skin sells for a whole number of credits from its price up to ${MARKET_MAX_PRICE}.`);
    return this.withLocks(['market', `u:${u.usernameLc}`], async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur) throw new AccountError(404, 'gone', 'This account no longer exists.');
      if (!(cur.profile.owned ?? []).includes(skinKey(id))) throw new AccountError(409, 'not_owned', 'You do not own that skin.');
      const m = await this.marketState();
      if (m.items.some((i) => i.seller === u.usernameLc && i.skin === id)) throw new AccountError(409, 'listed', 'You already have that skin for sale.');
      if (m.items.length >= MAX_LISTINGS) throw new AccountError(409, 'full', 'The market is full. Try again later.');
      const item = { id: m.seq, skin: id, seller: u.usernameLc, sellerName: cur.username, price, at: this.now() };
      m.seq += 1;
      m.items.push(item);
      await this.store.put('market', m);
      return { listing: item };
    });
  }

  async cancelListing(u, id) {
    return this.withLock('market', async () => {
      const m = await this.marketState();
      const at = m.items.findIndex((i) => i.id === id && i.seller === u.usernameLc);
      if (at < 0) throw new AccountError(404, 'not_listed', 'That listing is gone.');
      m.items.splice(at, 1);
      await this.store.put('market', m);
      return { ok: true };
    });
  }

  /**
   * Buy a listed skin: one transfer. The buyer is charged the price and gets the skin; the seller
   * loses it and is paid the same. Both careers' revisions move, so a stale device must merge first.
   */
  async buyListing(u, id) {
    return this.withLock('market', async () => {
      const m = await this.marketState();
      const item = m.items.find((i) => i.id === id);
      if (!item) throw new AccountError(404, 'not_listed', 'That listing is gone.');
      if (item.seller === u.usernameLc) throw new AccountError(409, 'own_listing', 'You cannot buy your own listing.');
      return this.withLocks([`u:${u.usernameLc}`, `u:${item.seller}`], async () => {
        const buyer = await this.store.get(`u:${u.usernameLc}`);
        const seller = await this.store.get(`u:${item.seller}`);
        const key = skinKey(item.skin);
        if (!buyer) throw new AccountError(404, 'gone', 'This account no longer exists.');
        if (!seller || !(seller.profile.owned ?? []).includes(key)) {
          m.items = m.items.filter((i) => i.id !== id);
          await this.store.put('market', m);
          throw new AccountError(409, 'gone', 'That skin is no longer for sale.');
        }
        if ((buyer.profile.owned ?? []).includes(key)) throw new AccountError(409, 'owned', 'You already have that skin.');
        if (balance(buyer.profile) < item.price) throw new AccountError(402, 'poor', `That costs ${item.price} credits.`);
        // Price is at least the skin's own price, so the buyer's owned value stays covered by what they spent.
        buyer.held = [...heldBy(buyer), key];
        buyer.profile = clean({ ...buyer.profile, spent: buyer.profile.spent + item.price, owned: [...buyer.profile.owned, key] });
        seller.held = [...heldBy(seller)];
        const sold = { ...seller.profile, credits: seller.profile.credits + item.price, owned: seller.profile.owned.filter((k) => k !== key) };
        seller.profile = clean(sold);
        seller.profile.equipped = sanitizeEquipped(seller.profile, seller.profile.equipped);
        seller.marketIn = (seller.marketIn ?? 0) + item.price;
        buyer.rev += 1;
        seller.rev += 1;
        m.items = m.items.filter((i) => i.id !== id);
        m.sales[item.skin] = [...(m.sales[item.skin] ?? []), item.price].slice(-MARKET_SALES_KEPT);
        await this.store.put(`u:${buyer.usernameLc}`, buyer);
        await this.store.put(`u:${seller.usernameLc}`, seller);
        await this.store.put('market', m);
        return { profile: buyer.profile, rev: buyer.rev };
      });
    });
  }

  /** What the server holds, for a client to merge with. */
  snapshot(u) { return { profile: u.profile, rev: u.rev }; }

  async changePassword(u, { current, password }) {
    this.checkPassword(password);
    return this.withLock(`u:${u.usernameLc}`, async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur || typeof current !== 'string' || !(await checkSecret(current, cur.pw))) throw new AccountError(401, 'credentials', 'Your current password is wrong.');
      cur.pw = await makeSecret(password, this.iterations);
      await this.endSessions(cur);
      const token = await this.startSession(cur);
      await this.store.put(`u:${cur.usernameLc}`, cur);
      return { token };
    });
  }

  /** Forgot the password: the recovery code sets a new one, and a fresh recovery code replaces it. */
  async recover({ login, recoveryCode, password }) {
    this.checkPassword(password);
    const u = await this.userByLogin(login);
    const code = normaliseRecovery(recoveryCode);
    if (!u) {
      this.decoy ??= await makeSecret('decoy', this.iterations);
      await checkSecret(code, this.decoy);
      throw new AccountError(401, 'recovery', 'That recovery code does not match.');
    }
    return this.withLock(`u:${u.usernameLc}`, async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!code || !(await checkSecret(code, cur.recovery))) throw new AccountError(401, 'recovery', 'That recovery code does not match.');
      const next = newRecoveryCode();
      cur.pw = await makeSecret(password, this.iterations);
      cur.recovery = await makeSecret(normaliseRecovery(next), this.iterations);
      await this.endSessions(cur);
      const token = await this.startSession(cur);
      await this.store.put(`u:${cur.usernameLc}`, cur);
      return { token, user: this.publicUser(cur), ...this.snapshot(cur), recoveryCode: next };
    });
  }

  async deleteAccount(u, { password }) {
    return this.withLock(`u:${u.usernameLc}`, async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur || typeof password !== 'string' || !(await checkSecret(password, cur.pw))) throw new AccountError(401, 'credentials', 'Wrong password.');
      await this.endSessions(cur);
      await this.store.delete(`u:${cur.usernameLc}`);
      await this.store.delete(`f:${cur.usernameLc}`);
      if (cur.email) await this.store.delete(`e:${cur.email}`);
    });
  }
}

export { mergeProfiles };

/**
 * Counts failed attempts per key (an address, or an account name) and says when to stop answering.
 * In memory only: it resets when the process does, which is acceptable for slowing a guesser down.
 */
export class Throttle {
  constructor({ limit = 8, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.limit = limit; this.windowMs = windowMs; this.now = now; this.hits = new Map();
  }

  /** Seconds to wait, or 0 if `key` may try. */
  wait(key) {
    const h = this.hits.get(key);
    if (!h) return 0;
    const left = h.since + this.windowMs - this.now();
    if (left <= 0) { this.hits.delete(key); return 0; }
    return h.n >= this.limit ? Math.ceil(left / 1000) : 0;
  }

  fail(key) {
    const h = this.hits.get(key);
    if (!h || h.since + this.windowMs <= this.now()) this.hits.set(key, { n: 1, since: this.now() });
    else h.n++;
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.since + this.windowMs <= this.now()) this.hits.delete(k);
  }

  clear(key) { this.hits.delete(key); }
}
