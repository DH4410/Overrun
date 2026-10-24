import { COUNTERS, clean, levelFromXp, mergeProfiles } from '../src/profile.js';
import { maxCredits, ownedValue } from '../src/shop.js';
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

export class Accounts {
  constructor({ store, iterations = 100_000, now = () => Date.now() }) {
    this.store = store;
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
      return { token, user: this.publicUser(fresh), profile: fresh.profile, rev: fresh.rev };
    });
  }

  /** The account a session cookie belongs to, or null. */
  async session(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = await sha256Hex(token);
    const s = await this.store.get(`s:${hash}`);
    if (!s) return null;
    if (s.exp <= this.now()) { await this.store.delete(`s:${hash}`); return null; }
    return this.store.get(`u:${s.u}`);
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
    return this.withLock(`u:${u.usernameLc}`, async () => {
      const cur = await this.store.get(`u:${u.usernameLc}`);
      if (!cur) throw new AccountError(404, 'gone', 'This account no longer exists.');
      if (Number(rev) !== cur.rev) throw new AccountError(409, 'conflict', 'Your career changed on another device.');
      const next = clean(profile);
      for (const k of COUNTERS) {
        if (next[k] > COUNTER_CAP) throw new AccountError(400, 'range', 'That career has impossible numbers.');
        if (next[k] < cur.profile[k]) throw new AccountError(400, 'regress', 'A career cannot go backwards.');
      }
      // Credits follow XP, spending cannot exceed what was earned, and what was bought must have
      // been paid for and cannot be given back.
      if (next.credits > maxCredits(next.xp, levelFromXp(next.xp).level)) throw new AccountError(400, 'range', 'That career has more credits than it could have earned.');
      if (next.spent > next.credits || ownedValue(next.owned) > next.spent) throw new AccountError(400, 'range', 'That career has spent more than it has.');
      if ((cur.profile.owned ?? []).some((k) => !next.owned.includes(k))) throw new AccountError(400, 'regress', 'A career cannot lose what it bought.');
      next.equipped = sanitizeEquipped(next, next.equipped);
      cur.profile = next;
      cur.rev += 1;
      await this.store.put(`u:${cur.usernameLc}`, cur);
      return { profile: cur.profile, rev: cur.rev };
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
