/**
 * The owner's gauge: today's Cloudflare free-tier budget and how long it lasts at the load the
 * room is carrying right now. It appears for the callsign DIMA, in the lobby and in a match, and
 * reads the same `/stats` the server already serves (server/governor.js keeps the numbers).
 *
 * This is a convenience, not a lock: the counters are public on /stats anyway, so nothing here is
 * hidden from anyone who types the name. The maths is in `summarize`, free of the DOM, so
 * tests/unit/dima.test.mjs can drive it.
 */

/** Cloudflare bills 20 incoming WebSocket messages as one request. */
export const MESSAGES_PER_REQUEST = 20;
const POLL_MS = 15_000;
const RATE_KEEP_MS = 60_000;

/** "3h 05m", "42m", "<1m". */
export function fmtSpan(sec) {
  if (!Number.isFinite(sec)) return '--';
  const m = Math.round(sec / 60);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/**
 * Turn a /stats reply into what the panel shows. `history` is [{ at (ms), messages }] from earlier
 * polls, oldest first; the load is the slope across it, so one burst does not read as the day's rate.
 */
export function summarize(stats, history = []) {
  const b = stats?.budget;
  if (!b) return null;
  const limit = b.limit, used = b.messages;
  const first = history[0], last = history[history.length - 1];
  let rate = 0;   // messages a second
  if (first && last && last.at > first.at && last.messages >= first.messages) rate = (last.messages - first.messages) / ((last.at - first.at) / 1000);
  const remaining = Math.max(0, limit - used);
  const etaSec = rate > 0 ? remaining / rate : Infinity;
  // The next point where the server slows everyone's input down (60 % then 85 %), or closes (100 %).
  const marks = [[0.6, '15/s'], [0.85, '10/s'], [1, 'CLOSED']];
  const next = marks.find(([at]) => b.used < at);
  const nextSec = next && rate > 0 ? Math.max(0, next[0] * limit - used) / rate : Infinity;
  return {
    requests: b.billedRequests, requestLimit: Math.round(limit / MESSAGES_PER_REQUEST), messages: used, messageLimit: limit,
    pct: b.used * 100, inputRate: b.inputRate, rate, etaSec, resetSec: b.resetInSec,
    lastsPastReset: etaSec > b.resetInSec,
    next: next ? { label: next[1], sec: nextSec } : null,
    exhausted: b.exhausted, lastRound: b.lastRound, players: stats.players ?? 0, spectators: stats.spectators ?? 0,
  };
}

const n = (v) => Math.round(v).toLocaleString('en-US');

/** The short line on the chip: percent of the day gone, and when it runs out at this load. */
export function chipText(s) {
  if (!s) return 'CLOUDFLARE · NO SERVER STATS HERE';
  if (s.exhausted) return `CLOUDFLARE ${s.pct.toFixed(0)}% · CLOSED, RESETS IN ${fmtSpan(s.resetSec)}`;
  const left = !(s.rate > 0) ? 'IDLE' : s.lastsPastReset ? 'LASTS TO RESET' : `${fmtSpan(s.etaSec)} LEFT`;
  return `CLOUDFLARE ${s.pct.toFixed(s.pct < 10 ? 1 : 0)}% · ${left}`;
}

export function initDima({ doc = document, fetchFn = (u) => fetch(u, { cache: 'no-store' }), pollMs = POLL_MS } = {}) {
  const fields = () => ['nameinput', 'nameinput2'].map((id) => doc.getElementById(id)).filter(Boolean);
  const isDima = () => fields().some((f) => /^dima$/i.test(f.value.trim()));

  let root = null, chip = null, body = null, timer = null, history = [], last = null, wanted = false;

  function build() {
    root = doc.createElement('div');
    root.id = 'dima-panel';
    root.innerHTML = '<button type="button" class="dp-chip" aria-expanded="false"></button><div class="dp-body" hidden></div>';
    chip = root.querySelector('.dp-chip');
    body = root.querySelector('.dp-body');
    chip.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      chip.setAttribute('aria-expanded', String(open));
    });
    doc.body.appendChild(root);
  }

  function paint() {
    if (!root) return;
    chip.textContent = chipText(last);
    if (!last) { body.innerHTML = '<p>This server does not publish /stats (single-player static host). Open the online room on the Cloudflare site.</p>'; return; }
    const row = (k, v) => `<div class="dp-row"><span>${k}</span><b>${v}</b></div>`;
    body.innerHTML = [
      row('REQUESTS TODAY', `${n(last.requests)} / ${n(last.requestLimit)}`),
      `<div class="dp-bar"><i style="width:${Math.min(100, last.pct).toFixed(1)}%"></i></div>`,
      row('WS MESSAGES', `${n(last.messages)} / ${n(last.messageLimit)}`),
      row('INPUT RATE', `${last.inputRate}/s`),
      row('LOAD NOW', `${last.rate.toFixed(1)} msg/s · ${last.players} PLAYING${last.spectators ? ` · ${last.spectators} WATCHING` : ''}`),
      row('TIME LEFT', last.rate > 0 ? (last.lastsPastReset ? 'LASTS PAST THE RESET' : `~${fmtSpan(last.etaSec)} AT THIS LOAD`) : 'NO LOAD'),
      last.next && last.rate > 0 ? row(`SLOWS TO ${last.next.label}`, `IN ~${fmtSpan(last.next.sec)}`) : '',
      row('RESETS (00:00 UTC)', `IN ${fmtSpan(last.resetSec)}`),
      '<p class="dp-note">Free plan: 100,000 requests a day, 20 messages per request. An estimate: it counts this room only.</p>',
    ].join('');
  }

  async function poll() {
    if (!wanted || doc.hidden) return;
    try {
      const r = await fetchFn('/stats');
      if (!r.ok) throw new Error(String(r.status));
      const stats = await r.json();
      const now = Date.now();
      history.push({ at: now, messages: stats.budget?.messages ?? 0 });
      history = history.filter((h) => now - h.at <= RATE_KEEP_MS);
      last = summarize(stats, history);
    } catch { last = null; history = []; }
    paint();
  }

  function sync() {
    const want = isDima();
    if (want === wanted) return;
    wanted = want;
    if (want) {
      if (!root) build();
      root.hidden = false;
      paint();
      poll();
      timer = setInterval(poll, pollMs);
    } else {
      if (root) root.hidden = true;
      clearInterval(timer); timer = null; history = []; last = null;
    }
  }

  for (const f of fields()) f.addEventListener('input', sync);
  addEventListener('overrun:auth', () => setTimeout(sync, 0));
  addEventListener('overrun:profile', () => setTimeout(sync, 0));
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) poll(); });
  sync();
  return { sync, poll, get shown() { return wanted; } };
}
