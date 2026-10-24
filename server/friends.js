import { AccountError } from './accounts.js';

/**
 * Friends, presence and invites. Each account has one record under `f:<name>`, kept apart from the
 * account itself so a presence ping never races a career save.
 *
 *   friends   names that accepted
 *   in / out  requests waiting on me / waiting on them
 *   invites   "come and play" nudges from friends, newest last; they expire
 *   seen      last time this account's page checked in; status is what it was doing then
 *
 * Presence is a heartbeat, not a socket: a friend counts as online if they checked in within
 * ONLINE_MS. That is deliberately cheap (one small request every ~20 s while the page is open).
 */
export const ONLINE_MS = 60_000;
export const INVITE_MS = 10 * 60_000;
export const MAX_FRIENDS = 50;
export const MAX_PENDING = 30;
export const STATUSES = ['lobby', 'solo', 'online'];

const blank = () => ({ friends: [], in: [], out: [], invites: [], seen: 0, status: 'lobby' });
const lcOf = (name) => String(name ?? '').trim().toLowerCase();
const without = (list, x) => list.filter((y) => y !== x);

export class Friends {
  constructor({ store, accounts, now = () => Date.now() }) {
    this.store = store;
    this.accounts = accounts;
    this.now = now;
  }

  async rec(lc) { return (await this.store.get(`f:${lc}`)) ?? blank(); }
  save(lc, r) { return this.store.put(`f:${lc}`, r); }

  /** Run `fn` holding both records, always in the same order so two people adding each other cannot deadlock. */
  both(a, b, fn) {
    const [first, second] = a < b ? [a, b] : [b, a];
    return this.accounts.withLock(`f:${first}`, () => this.accounts.withLock(`f:${second}`, fn));
  }

  /** Same checks as target(), returning the lower-case name. */
  async known(u, name) { return (await this.target(u, name)).usernameLc; }

  async target(u, name) {
    const lc = lcOf(name);
    if (!lc) throw new AccountError(400, 'name', 'Type a username.');
    if (lc === u.usernameLc) throw new AccountError(400, 'self', 'That is you.');
    const t = await this.store.get(`u:${lc}`);
    if (!t) throw new AccountError(404, 'nouser', 'No player has that username.');
    return t;
  }

  /** What the friends panel shows. Names that no longer have an account are dropped as they are met. */
  async list(u) {
    const me = await this.rec(u.usernameLc);
    const name = async (lc) => (await this.store.get(`u:${lc}`))?.username ?? null;
    const t = this.now();
    const friends = [];
    for (const lc of me.friends) {
      const username = await name(lc);
      if (!username) continue;
      const r = await this.rec(lc);
      const online = t - r.seen < ONLINE_MS;
      friends.push({ username, online, status: online ? r.status : 'offline' });
    }
    friends.sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
    const names = async (list) => (await Promise.all(list.map(name))).filter(Boolean);
    const invites = [];
    for (const i of me.invites) {
      if (t - i.at > INVITE_MS) continue;
      const username = await name(i.from);
      if (username) invites.push({ from: username, age: Math.round((t - i.at) / 1000) });
    }
    return { friends, incoming: await names(me.in), outgoing: await names(me.out), invites };
  }

  /** The page checks in: record what it is doing, answer with the current panel. */
  async heartbeat(u, status) {
    const s = STATUSES.includes(status) ? status : 'lobby';
    await this.accounts.withLock(`f:${u.usernameLc}`, async () => {
      const r = await this.rec(u.usernameLc);
      r.seen = this.now(); r.status = s;
      r.invites = r.invites.filter((i) => this.now() - i.at <= INVITE_MS);
      await this.save(u.usernameLc, r);
    });
    return this.list(u);
  }

  async request(u, name) {
    const t = await this.target(u, name);
    await this.both(u.usernameLc, t.usernameLc, async () => {
      const me = await this.rec(u.usernameLc), them = await this.rec(t.usernameLc);
      if (me.friends.includes(t.usernameLc)) throw new AccountError(409, 'already', `You and ${t.username} are already friends.`);
      if (me.out.includes(t.usernameLc)) throw new AccountError(409, 'sent', `You already asked ${t.username}.`);
      if (me.in.includes(t.usernameLc)) {
        // They asked first: asking back is the same as saying yes.
        me.in = without(me.in, t.usernameLc); them.out = without(them.out, u.usernameLc);
        me.friends.push(t.usernameLc); them.friends.push(u.usernameLc);
      } else {
        if (me.out.length >= MAX_PENDING || them.in.length >= MAX_PENDING) throw new AccountError(409, 'full', 'Too many pending requests.');
        if (me.friends.length >= MAX_FRIENDS) throw new AccountError(409, 'full', 'Your friends list is full.');
        me.out.push(t.usernameLc); them.in.push(u.usernameLc);
      }
      await this.save(u.usernameLc, me); await this.save(t.usernameLc, them);
    });
    return this.list(u);
  }

  async accept(u, name) {
    const lc = await this.known(u, name);
    await this.both(u.usernameLc, lc, async () => {
      const me = await this.rec(u.usernameLc), them = await this.rec(lc);
      if (!me.in.includes(lc)) throw new AccountError(404, 'norequest', 'There is no request from that player.');
      if (me.friends.length >= MAX_FRIENDS || them.friends.length >= MAX_FRIENDS) throw new AccountError(409, 'full', 'A friends list is full.');
      me.in = without(me.in, lc); them.out = without(them.out, u.usernameLc);
      if (!me.friends.includes(lc)) me.friends.push(lc);
      if (!them.friends.includes(u.usernameLc)) them.friends.push(u.usernameLc);
      await this.save(u.usernameLc, me); await this.save(lc, them);
    });
    return this.list(u);
  }

  /** Turns down a request to me, or takes back one I sent. */
  async decline(u, name) {
    const lc = await this.known(u, name);
    await this.both(u.usernameLc, lc, async () => {
      const me = await this.rec(u.usernameLc), them = await this.rec(lc);
      me.in = without(me.in, lc); me.out = without(me.out, lc);
      them.in = without(them.in, u.usernameLc); them.out = without(them.out, u.usernameLc);
      await this.save(u.usernameLc, me); await this.save(lc, them);
    });
    return this.list(u);
  }

  async remove(u, name) {
    const lc = await this.known(u, name);
    await this.both(u.usernameLc, lc, async () => {
      const me = await this.rec(u.usernameLc), them = await this.rec(lc);
      me.friends = without(me.friends, lc); them.friends = without(them.friends, u.usernameLc);
      me.invites = me.invites.filter((i) => i.from !== lc); them.invites = them.invites.filter((i) => i.from !== u.usernameLc);
      await this.save(u.usernameLc, me); await this.save(lc, them);
    });
    return this.list(u);
  }

  /** "Come and play": lands on a friend, and only a friend, and replaces any older one from me. */
  async invite(u, name) {
    const lc = await this.known(u, name);
    await this.both(u.usernameLc, lc, async () => {
      const me = await this.rec(u.usernameLc), them = await this.rec(lc);
      if (!me.friends.includes(lc)) throw new AccountError(403, 'notfriend', 'You can only invite friends.');
      const t = this.now();
      them.invites = [...them.invites.filter((i) => i.from !== u.usernameLc && t - i.at <= INVITE_MS), { from: u.usernameLc, at: t }].slice(-10);
      await this.save(lc, them);
    });
    return this.list(u);
  }

  async dismiss(u, name) {
    const lc = lcOf(name);
    await this.accounts.withLock(`f:${u.usernameLc}`, async () => {
      const me = await this.rec(u.usernameLc);
      me.invites = me.invites.filter((i) => i.from !== lc);
      await this.save(u.usernameLc, me);
    });
    return this.list(u);
  }
}
