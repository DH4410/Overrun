/**
 * The free-tier budget. Cloudflare bills incoming WebSocket messages to a Durable Object at 20
 * messages per request, and the free plan has 100,000 requests a day: 2,000,000 messages. Every
 * message the room receives is counted here; the count is persisted about once a minute and
 * resets at 00:00 UTC, when Cloudflare's own counter does.
 *
 *   < 60%  input at 20 packets/s
 *   >= 60% 15/s, >= 85% 10/s
 *   >= 95% warn, and close the room when the current round ends
 *   100%   close now, with a message
 */
export const DAILY_MESSAGES = 2_000_000;
export const TIERS = [
  { at: 0.60, rate: 15 },
  { at: 0.85, rate: 10 },
];
export const LAST_ROUND_AT = 0.95;
const PERSIST_MS = 60_000;

const utcDay = (ms) => Math.floor(ms / 86_400_000);

export class Governor {
  /**
   * `now()` in ms. `saved` is what save() last stored ({ day, count }) or null. `save(state)`
   * persists; it may be async and is not awaited.
   */
  constructor({ now = () => Date.now(), limit = DAILY_MESSAGES, saved = null, save = null } = {}) {
    this.now = now;
    this.limit = limit;
    this.save = save;
    const today = utcDay(now());
    this.day = today;
    this.count = saved && saved.day === today ? saved.count : 0;
    this.lastSave = now();
    this.dirty = false;
  }

  /** Count `n` incoming messages. */
  add(n = 1) { this.count += n; this.dirty = true; }

  /** Roll the day over and persist when due. Call it often; it is cheap. */
  poll() {
    const t = this.now();
    const today = utcDay(t);
    if (today !== this.day) { this.day = today; this.count = 0; this.dirty = true; this.flush(); return; }
    if (this.dirty && t - this.lastSave >= PERSIST_MS) this.flush();
  }

  flush() {
    this.lastSave = this.now();
    this.dirty = false;
    try { this.save?.({ day: this.day, count: this.count }); } catch { /* best effort */ }
  }

  get used() { return this.count / this.limit; }

  /** Input packets per second clients should send. */
  get inputRate() {
    let rate = 20;
    for (const t of TIERS) if (this.used >= t.at) rate = t.rate;
    return rate;
  }

  /** True from 95%: finish the round, then close. */
  get lastRound() { return this.used >= LAST_ROUND_AT; }

  /** True at 100%: close now. */
  get exhausted() { return this.count >= this.limit; }

  /** Seconds until the counter resets. */
  get resetIn() { return Math.ceil(((this.day + 1) * 86_400_000 - this.now()) / 1000); }

  stats() {
    return {
      day: new Date(this.day * 86_400_000).toISOString().slice(0, 10),
      messages: this.count, limit: this.limit, used: +this.used.toFixed(4),
      billedRequests: Math.ceil(this.count / 20), inputRate: this.inputRate,
      lastRound: this.lastRound, exhausted: this.exhausted, resetInSec: this.resetIn,
    };
  }
}
