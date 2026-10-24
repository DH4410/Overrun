/**
 * The online half of the lobby: what the shared room is doing right now, before you join it.
 * The room reports itself on /stats (server/room.js `report()`); this turns that into a few
 * readable lines and keeps them fresh while the ONLINE tab is open.
 *
 * It polls gently (every POLL_MS, only while visible): each poll is a request to the room's
 * server, and on a free Cloudflare plan requests are what runs out.
 */

const POLL_MS = 8000;
const MODE_NAME = { dm: 'DEATHMATCH', tdm: 'TEAM DEATHMATCH' };
const PHASE_NAME = { LOBBY: 'WAITING ROOM · READY UP', COUNTDOWN: 'STARTING', PLAYING: 'ROUND IN PROGRESS', INTERMISSION: 'BETWEEN ROUNDS · VOTING', CLOSED: 'CLOSED' };
export const ROOM_CAPACITY = 10;

/**
 * A /stats report as display text. `report` is the parsed JSON, or null when the server could not
 * be reached. Pure, so the wording is tested without a browser.
 */
export function describeRoom(report, pingMs = null) {
  if (!report || typeof report !== 'object') {
    return { state: 'offline', headline: 'SERVER OFFLINE', ping: '', players: '–', now: '–', phase: '–', roster: [], canJoin: false,
      note: 'The multiplayer server could not be reached. Solo play is unaffected.' };
  }
  const players = Number(report.players) || 0;
  const watching = Number(report.spectators) || 0;
  const exhausted = !!report.budget?.exhausted || report.phase === 'CLOSED';
  const full = players >= ROOM_CAPACITY;
  const roster = Object.entries(report.rtt ?? {}).slice(0, ROOM_CAPACITY).map(([name, rtt]) => ({ name: String(name).slice(0, 12), ping: Math.round(Number(rtt)) || 0 }));
  let headline = 'ONLINE', state = 'online', note = '';
  if (exhausted) {
    headline = 'CLOSED FOR TODAY'; state = 'closed';
    note = `The free daily budget is used up. It reopens in about ${Math.max(1, Math.ceil((Number(report.budget?.resetInSec) || 0) / 3600))} h. You can still play solo.`;
  } else if (full) {
    headline = 'ROOM FULL'; state = 'full';
    note = `All ${ROOM_CAPACITY} seats are taken. You can still spectate.`;
  }
  return {
    state, headline, note, roster,
    ping: pingMs != null ? `${Math.round(pingMs)} MS` : '',
    players: `${players} / ${ROOM_CAPACITY}${watching ? ` · ${watching} WATCHING` : ''}`,
    now: `${MODE_NAME[report.mode] ?? String(report.mode ?? '–').toUpperCase()} · ${String(report.map ?? '–').toUpperCase()}`,
    phase: PHASE_NAME[report.phase] ?? '–',
    canJoin: !exhausted && !full,
    canWatch: !exhausted,
  };
}

export function createOnlineLobby({ getElement: $, fetchFn = (...a) => fetch(...a) }) {
  let timer = null, shown = false, busy = false;
  const pane = $('pane-online');

  async function refresh() {
    if (busy) return;
    busy = true;
    let report = null, ping = null;
    try {
      const t0 = performance.now();
      const res = await fetchFn('/stats', { cache: 'no-store' });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) { report = await res.json(); ping = performance.now() - t0; }
    } catch { /* offline: shown below */ }
    busy = false;
    if (shown) paint(describeRoom(report, ping));
  }

  function paint(v) {
    const set = (id, text) => { const e = $(id); if (e) e.textContent = text; };
    pane.dataset.state = v.state;
    set('ol-state', v.headline); set('ol-ping', v.ping); set('ol-players', v.players); set('ol-now', v.now); set('ol-phase', v.phase); set('ol-note', v.note);
    const list = $('ol-roster');
    list.textContent = '';
    if (!v.roster.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = v.state === 'offline' ? '' : 'Nobody yet. Be the first in.';
      list.append(li);
    }
    for (const p of v.roster) {
      const li = document.createElement('li');
      const name = document.createElement('b'); name.textContent = p.name;
      const ping = document.createElement('span'); ping.textContent = `${p.ping} ms`;
      li.append(name, ping);
      list.append(li);
    }
    $('mp-play')?.classList.toggle('blocked', !v.canJoin);
    $('mp-watch')?.classList.toggle('blocked', v.canWatch === false);
  }

  function show() {
    shown = true;
    paint(describeRoom(undefined));          // never leave stale numbers up while the first answer is on its way
    $('ol-state').textContent = 'CHECKING…';
    pane.dataset.state = 'checking';
    $('ol-note').textContent = '';
    for (const id of ['mp-play', 'mp-watch']) $(id)?.classList.remove('blocked');   // do not refuse a click before we know
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
  }

  function hide() { shown = false; clearInterval(timer); timer = null; }

  return { show, hide, refresh };
}
