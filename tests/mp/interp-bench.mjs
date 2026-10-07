import { TICK_HZ, SNAPSHOT_HZ } from '../../src/sim/protocol.js';
import { InterpController, REWIND_BUDGET } from '../../src/net/netQuality.js';

/**
 * Replays the client's snapshot clock and interpolation-delay logic (src/net/client.js) against
 * simulated links, with the old policy (delay 100-150 ms, a 60-sample p95, a slow glide) and the
 * new one (src/net/netQuality.js) side by side. No sockets, no browser: it is the arithmetic.
 *
 *   node tests/mp/interp-bench.mjs
 *
 * Per link it reports, after a 5 s warm-up:
 *   starved   frames where the render time was past the newest snapshot (the puppet has to be
 *             extrapolated; "frozen" is past EXTRAP_MAX, 100 ms, where it stops dead)
 *   delay     the mean interpolation delay, ms (it is added to the round trip when a shot is rewound)
 *   rewind    the mean ms the server would have to rewind a shot (rtt + delay + 30 ms queue),
 *             and how often that is past the server's MAX_REWIND (250 ms)
 *
 * Links: "drop" loses a snapshot outright (what ?loss= in the browser does); "tcp" holds the
 * snapshot back by a retransmit timeout and everything behind it, which is what a WebSocket does.
 */

const SNAP_EVERY = TICK_HZ / SNAPSHOT_HZ;
const FRAME = 1 / 60, DURATION = 120, WARMUP = 5;
const EXTRAP_MAX = 0.1;

function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Arrival times (ms) of snapshot k, or null if lost. */
function link({ oneway, jitter, loss, mode }, seed) {
  const r = rng(seed);
  const out = [];
  let lane = 0;
  const rto = Math.max(200, 3 * oneway);
  for (let k = 0; k * 50 < DURATION * 1000; k++) {
    const sent = k * 50;
    let at = sent + oneway + r() * jitter;
    if (loss && r() < loss) {
      if (mode === 'drop') { out.push(null); continue; }
      at += rto;
    }
    at = Math.max(lane, at);     // in order
    lane = at;
    out.push(at);
  }
  return out;
}

function run(profile, policy) {
  const arrivals = link(profile, 7);
  const ctl = new InterpController();
  let interp = 0.1, clockOffset = null, lastTick = null;
  const lateness = [];
  let rttEst = 2 * profile.oneway + profile.jitter / 2;
  let next = 0, newest = -1;
  let frames = 0, starved = 0, frozen = 0, delaySum = 0, over = 0, rewindSum = 0, slew = 0;
  for (let t = 0; t < DURATION; t += FRAME) {
    const ms = t * 1000;
    while (next < arrivals.length && (arrivals[next] === null || arrivals[next] <= ms)) {
      if (arrivals[next] !== null) {
        const tick = next * SNAP_EVERY;
        const nowT = arrivals[next] / 1000 * TICK_HZ;
        const cand = tick - nowT;
        if (clockOffset === null || cand > clockOffset || clockOffset - cand > TICK_HZ * 2) clockOffset = cand;
        const late = clockOffset - cand;
        lateness.push(late); if (lateness.length > 60) lateness.shift();
        const missed = lastTick === null ? 0 : Math.max(0, Math.round((tick - lastTick) / SNAP_EVERY) - 1);
        lastTick = tick;
        newest = tick;
        ctl.onRtt(rttEst);
        ctl.onSnapshot(late, missed, arrivals[next]);
      }
      next++;
    }
    if (clockOffset === null) continue;
    clockOffset -= FRAME * 0.5;
    const before = interp;
    if (policy === 'old') {
      if (lateness.length > 5) {
        const sorted = [...lateness].sort((x, y) => x - y);
        const p95 = sorted[Math.floor(sorted.length * 0.95)] / TICK_HZ;
        const want = Math.min(0.15, Math.max(0.1, 0.05 + p95 + 0.01));
        interp += (want - interp) * Math.min(1, FRAME * 2);
      }
    } else interp = ctl.step(FRAME);
    if (t < WARMUP) continue;
    frames++;
    slew += Math.abs(interp - before) / FRAME;
    const rt = ms / 1000 * TICK_HZ + clockOffset - interp * TICK_HZ;
    const ahead = (rt - newest) / TICK_HZ;
    if (ahead > 0) { starved++; if (ahead > EXTRAP_MAX) frozen++; }
    delaySum += interp;
    const rewind = rttEst / 1000 + interp + 0.03;
    rewindSum += rewind;
    if (rewind > REWIND_BUDGET) over++;
  }
  return {
    starved: (100 * starved) / frames, frozen: (100 * frozen) / frames, delay: (1000 * delaySum) / frames,
    rewind: (1000 * rewindSum) / frames, over: (100 * over) / frames, slew: (100 * slew) / frames,
  };
}

const PROFILES = [
  { name: 'LAN         rtt  20 jitter  5 loss 0%', oneway: 10, jitter: 5, loss: 0, mode: 'drop' },
  { name: 'cable       rtt  60 jitter 15 loss 0%', oneway: 30, jitter: 15, loss: 0, mode: 'drop' },
  { name: 'far         rtt 120 jitter 25 loss 1%', oneway: 60, jitter: 25, loss: 0.01, mode: 'tcp' },
  { name: '?lag=200&jitter=40&loss=3 (drop)     ', oneway: 100, jitter: 40, loss: 0.03, mode: 'drop' },
  { name: 'rtt 200 jitter 40 loss 3% (tcp)      ', oneway: 100, jitter: 40, loss: 0.03, mode: 'tcp' },
  { name: 'rtt 300 jitter 60 loss 2% (tcp)      ', oneway: 150, jitter: 60, loss: 0.02, mode: 'tcp' },
];

console.log('policy  link                                  starved%  frozen%  delay ms  rewind ms  >250ms%  delay slew %/s');
for (const p of PROFILES) {
  for (const policy of ['old', 'new']) {
    const r = run(p, policy);
    console.log(`${policy.padEnd(6)}  ${p.name}  ${r.starved.toFixed(1).padStart(7)}  ${r.frozen.toFixed(1).padStart(7)}  ${r.delay.toFixed(0).padStart(8)}  ${r.rewind.toFixed(0).padStart(9)}  ${r.over.toFixed(0).padStart(7)}  ${r.slew.toFixed(1).padStart(10)}`);
  }
}
