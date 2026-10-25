import { SNAPSHOT_HZ, TICK_HZ } from '../sim/protocol.js';

/**
 * How long the client holds back other players' positions (the "interpolation delay"), chosen
 * from what the connection is actually doing, and the one-line quality readout. Pure maths, no
 * DOM, so tests/unit/net-quality.test.mjs and tests/mp/interp-bench.mjs can drive it with
 * recorded or simulated arrival times.
 *
 * Why the delay matters twice (see NETWORK_NOTES.md):
 *  - To draw a smooth path the client needs a snapshot on each side of the render time. With one
 *    every 50 ms the least that can work is 2 intervals (Source's default, "survives one lost
 *    packet"), plus however late snapshots are turning up.
 *  - The server rewinds a shot by about (rtt + delay + a little queueing) ticks, and stops at
 *    MAX_REWIND. A longer delay on a long ping therefore comes straight off hit registration.
 */

/** Seconds between snapshots. */
export const SNAP_INTERVAL = 1 / SNAPSHOT_HZ;
/**
 * What the server will rewind a shot by: MAX_REWIND in server/room.js (48 ticks, 400 ms). The
 * client cannot import the server, so this is a copy; if the server's changes, change it here.
 */
export const REWIND_BUDGET = 48 / TICK_HZ;
const QUEUE_ALLOWANCE = 0.03;     // s a command waits in the server's input queue, on average

export const INTERP_FLOOR = 0.07;     // s: below this a single late snapshot freezes everyone
export const INTERP_START = 0.1;      // s: before anything has been measured
export const INTERP_CEIL = 0.2;       // s
const LOSS_MEMORY = 8000;             // ms a missed snapshot keeps the extra margin on
const WINDOW = 64;                    // snapshots the lateness statistics look at (3.2 s)

export class InterpController {
  constructor() {
    this.delay = INTERP_START;          // s: what the renderer uses
    this.target = INTERP_START;
    this.cap = INTERP_CEIL;
    this.p95 = 0;                       // s: the 95th percentile of how late snapshots run
    this.rtt = 0;                       // ms, smoothed
    this._late = new Float64Array(WINDOW);
    this._sorted = new Float64Array(WINDOW);
    this._n = 0; this._head = 0;
    this._lastMiss = -Infinity;
  }

  /**
   * A snapshot arrived. `lateTicks` is how many ticks later than the earliest-seen it came (the
   * client's `clockOffset - cand`), `missed` how many snapshots before it never arrived.
   */
  onSnapshot(lateTicks, missed, now) {
    this._late[this._head] = Math.max(0, lateTicks) / TICK_HZ;
    this._head = (this._head + 1) % WINDOW;
    if (this._n < WINDOW) this._n++;
    if (missed > 0) this._lastMiss = now;
    if (this._n < 6) return;
    this._sorted.set(this._late);
    const s = this._sorted.subarray(0, this._n);
    s.sort();
    this.p95 = s[Math.min(this._n - 1, Math.floor(this._n * 0.95))];
    const lossPad = now - this._lastMiss < LOSS_MEMORY ? SNAP_INTERVAL : 0;
    this.target = Math.min(INTERP_CEIL, Math.max(INTERP_FLOOR, SNAP_INTERVAL + this.p95 + 0.012 + lossPad));
  }

  /** The last round trip, in ms. Smoothed so the readout and the cap do not flicker. */
  onRtt(ms) {
    this.rtt = this.rtt ? this.rtt + (ms - this.rtt) * 0.2 : ms;
  }

  /**
   * Move the delay towards its target. Up fast (a stall is already happening), down slowly (the
   * calm may be a lull); and never faster than a few percent of real time, because the delay
   * changing is puppets playing slow or fast. Returns the delay in seconds.
   */
  step(dt) {
    // Never so long that it alone pushes a shot past what the server can rewind, unless the ping
    // already has: then two intervals, the Source default, is the most smoothness is worth.
    this.cap = Math.min(INTERP_CEIL, Math.max(0.15, REWIND_BUDGET - this.rtt / 1000 - QUEUE_ALLOWANCE));
    const want = Math.min(this.cap, this.target);
    const d = want - this.delay;
    const rate = d > 0 ? 6 : 0.8, slew = d > 0 ? 0.3 : 0.03;
    const move = Math.max(-slew * dt, Math.min(slew * dt, d * Math.min(1, dt * rate)));
    this.delay += move;
    return this.delay;
  }

  /** 95th percentile snapshot lateness, in ms: the connection's jitter as the client lives it. */
  get jitterMs() { return this.p95 * 1000; }
}

/**
 * The corner readout: `{ text, level }`, level 'good' | 'warn' | 'bad'. `rewindMs` is what the
 * server must rewind a shot by right now (round trip + delay + queue); past the server's limit
 * moving targets are hit slightly behind where they were drawn, and the readout says so.
 */
export function qualityReadout({ rtt, jitterMs, lossPct, delayMs }) {
  const rewindMs = rtt + delayMs + QUEUE_ALLOWANCE * 1000;
  const limited = rewindMs > REWIND_BUDGET * 1000;
  const level = limited || rtt > 250 || lossPct >= 6 ? 'bad' : rtt > 120 || lossPct >= 2 || jitterMs > 45 ? 'warn' : 'good';
  const loss = lossPct.toFixed(lossPct < 10 ? 1 : 0);
  return {
    level,
    text: `PING ${Math.round(rtt)} ms · JITTER ${Math.round(jitterMs)} · LOSS ${loss}%${limited ? ' · LAG-COMP LIMIT' : ''}`,
  };
}

/** A player nobody can see and nothing is shooting at: the most input rate the server can save on. */
export const CALM_MIN_RATE = 8;
/** An enemy this close (metres) counts as a fight, whether or not anyone has fired yet. */
export const FIGHT_RANGE = 45;
/** Seconds a fight keeps the full rate after the last shot fired, aimed or taken. */
export const FIGHT_HOLD = 2.5;

/**
 * Input packets per second to send. The server bills every incoming message against a free daily
 * budget (server/governor.js) and tells clients a rate from it. A player running across the map
 * does not need that rate: nobody can tell their position was sent every 100 ms instead of every
 * 50 ms, and their own movement is predicted locally regardless. In a fight the full rate
 * applies, so aim and hit registration are unchanged. Roughly halves what a player costs outside
 * combat, which is what stretches the budget before the governor has to slow everyone down.
 */
export function effectiveInputRate(rate, inFight) {
  return inFight ? rate : Math.max(Math.min(rate, CALM_MIN_RATE), Math.round(rate / 2));
}
