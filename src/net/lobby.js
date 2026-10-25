import { MAP_DATA, MAP_IDS } from '../sim/mapData.js';
import { MODE_INFO, PLAYABLE, TIME_OPTIONS, WEAPON_RULES, mapHosts } from '../sim/modes.js';
import { WEAPON_BY_ID } from '../sim/weaponData.js';

/**
 * The lobby's panels, and the match history they show. The players themselves are the 3D line-up
 * on the stage (stage.js); this is the rest: the match settings on the right, the ready / start
 * bar along the bottom. The server decides everything: this only draws what it was told and
 * sends the player's choices back. A guest sees the settings but cannot change them.
 */

const HISTORY_KEY = 'overrun-mp-history';
const HISTORY_MAX = 20;

export function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(v) ? v.filter((h) => h && typeof h.mode === 'string').slice(0, HISTORY_MAX) : [];
  } catch { return []; }
}

export function pushHistory(entry) {
  const list = [entry, ...loadHistory()].slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* private mode: not kept */ }
  return list;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
};

const minutes = (s) => `${Math.round(s / 60)} MIN`;
const weaponLabel = (w) => (w === 'loadout' ? 'OWN LOADOUT' : `${(WEAPON_BY_ID[w]?.name ?? w).toUpperCase()} ONLY`);

/** One row of match history: "TDM  WIN  18-11". */
export function historyRow(h) {
  const row = el('div', `hist ${String(h.result).toLowerCase()}`);
  row.append(el('span', 'm', MODE_INFO[h.mode]?.short ?? h.mode.toUpperCase()), el('span', 'r', h.result), el('span', 's', h.score ?? ''), el('span', 'map', (h.map ?? '').toUpperCase()));
  return row;
}

const mapSize = (id) => {
  const h = MAP_DATA[id]?.half;
  return h ? `${h[0] * 2} × ${h[1] * 2} M` : '';
};

const ICON = {
  dm: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  tdm: '<circle cx="8" cy="7" r="3"/><circle cx="16" cy="7" r="3"/><path d="M2 20c0-4 3-6 6-6s6 2 6 6M10 20c0-4 3-6 6-6s6 2 6 6"/>',
  duel: '<path d="M4 4l10 10M20 4L10 14M3 17l4 4M21 17l-4 4M6 15l3 3M18 15l-3 3"/>',
  gg: '<path d="M4 20h4v-5h4v-5h4V5h4"/>',
  hp: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="3"/>',
  ctf: '<path d="M6 21V3M6 4h12l-3 4 3 4H6"/>',
  survival: '<path d="M2 15c3-3 5 3 8 0s5 3 8 0 3-1 4-1M2 20c3-3 5 3 8 0s5 3 8 0 3-1 4-1M12 3l2 5h-4z"/>',
  zombie: '<circle cx="12" cy="9" r="5"/><path d="M9 8h.01M15 8h.01M9 12h6M5 21c0-4 3-6 7-6s7 2 7 6"/>',
  war: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3"/>',
};

export function createLobby({ send, onLeave }) {
  const root = document.createElement('div');
  root.id = 'mp-lobby';
  document.body.appendChild(root);
  let shown = false;
  let pop = null;              // 'mode' | 'map' | 'rules' while a popout is open
  let last = null;             // the state of the last render, so a popout can redraw itself

  function openPop(kind) { pop = kind; if (last) render(last); }
  function closePop() { pop = null; if (last) render(last); }
  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || !pop || !shown) return;
    e.preventDefault(); e.stopPropagation();
    closePop();
  }, true);

  /** A tile in a popout: the same look as the single player menu's mode and map pickers. */
  function tile(active, enabled, art, title, desc, onPick) {
    const b = el('button', `tile${active ? ' active' : ''}`);
    b.type = 'button';
    b.disabled = !enabled;
    b.append(art, el('span', 'mt', title), el('span', 'md', desc));
    if (enabled) b.addEventListener('click', onPick);
    return b;
  }

  function popout(kind, settings, info, pick) {
    const wrap = el('div', 'pop on');
    const cardEl = el('div', 'pop-card');
    const head = el('div', 'pop-head');
    const x = el('button', 'pop-x', '✕');
    x.type = 'button'; x.setAttribute('aria-label', 'Close');
    head.append(el('h2', '', kind === 'mode' ? 'GAME MODE' : kind === 'map' ? 'MAP' : 'RULES'), x);
    cardEl.appendChild(head);
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('.pop-x')) closePop(); });

    if (kind === 'mode') {
      const grid = el('div', 'pop-grid');
      for (const id of PLAYABLE) {
        const art = el('span', 'ti-art');
        art.innerHTML = `<svg viewBox="0 0 24 24">${ICON[id] ?? ICON.dm}</svg>`;
        grid.appendChild(tile(id === settings.mode, true, art, MODE_INFO[id].label, MODE_INFO[id].blurb, () => { pick({ mode: id }); closePop(); }));
      }
      grid.classList.add('modes');
      cardEl.appendChild(grid);
    } else if (kind === 'map') {
      const grid = el('div', 'pop-grid');
      for (const id of MAP_IDS) {
        const ok = mapHosts(MAP_DATA, id, settings.mode);
        grid.appendChild(tile(id === settings.map, ok, el('span', `ti-art art-${id}`), id.toUpperCase(), ok ? mapSize(id) : `NOT FOR ${MODE_INFO[settings.mode].short}`, () => { pick({ map: id }); closePop(); }));
      }
      cardEl.appendChild(grid);
    } else {
      const box = el('div', 'rulebox');
      if (info.limits?.length) box.appendChild(group(info.unit, info.limits.map((n) => option(`${n}`, n === settings.limit, true, () => pick({ limit: n })))));
      if (!info.untimed) box.appendChild(group('TIME LIMIT', TIME_OPTIONS.map((t) => option(minutes(t), t === settings.time, true, () => pick({ time: t })))));
      box.appendChild(group('WEAPONS', WEAPON_RULES.map((w) => option(weaponLabel(w), w === settings.weapons, true, () => pick({ weapons: w })))));
      const done = el('button', 'done', 'DONE');
      done.type = 'button';
      done.addEventListener('click', closePop);
      box.appendChild(done);
      cardEl.appendChild(box);
    }
    wrap.appendChild(cardEl);
    return wrap;
  }

  function option(label, active, enabled, onPick, title) {
    const b = el('button', active ? 'on' : '', label);
    b.type = 'button';
    if (title) b.title = title;
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onPick);
    return b;
  }

  function group(label, buttons) {
    const g = el('div', 'grp');
    g.append(el('span', 'lbl', label));
    const row = el('div', 'opts');
    row.append(...buttons);
    g.appendChild(row);
    return g;
  }

  /**
   * state: { myId, host, roster: [{ id, name, team, ready }], settings, blocker, spectators,
   *          spectating, history }
   */
  function render(state) {
    const { myId, host, roster, settings, blocker, spectators, spectating, history } = state;
    last = state;
    document.body.classList.toggle('mp-pop', !!pop);
    const isHost = myId !== null && myId === host && !spectating;
    const me = roster.find((r) => r.id === myId);
    const guests = roster.filter((r) => r.id !== host);
    const readyCount = guests.filter((r) => r.ready).length;
    root.textContent = '';

    // Top left: where you are, and how full it is.
    const top = el('div', 'top');
    top.append(
      el('span', 'kick', 'ONLINE'),
      el('h2', '', 'LOBBY'),
      el('span', 'sub', `${roster.length} PLAYER${roster.length === 1 ? '' : 'S'}${spectators ? ` · ${spectators} WATCHING` : ''}`),
    );
    root.appendChild(top);

    // Right: the match, as three cards. Each opens a popout with its choices, so the panel stays short.
    const info = MODE_INFO[settings.mode];
    const pick = (patch) => send({ t: 'settings', ...patch });
    const side = el('div', 'side');
    const sh = el('div', 'sh');
    sh.append(el('span', 'lbl', 'MATCH'), el('span', `tag${isHost ? ' host' : ''}`, isHost ? 'YOU ARE HOST' : 'HOST CHOOSES'));
    side.appendChild(sh);

    // Who is here. The host gets a ✕ on every other seat (a duplicate or a stuck player goes this way).
    const rost = el('div', 'roster');
    for (const r of roster) {
      const row = el('div', `rrow${r.id === myId ? ' me' : ''}`);
      row.append(
        el('span', 'rmark', r.id === host ? '♛' : r.ready ? '✓' : ''),
        el('span', 'rname', r.name),
      );
      if (isHost && r.id !== myId) {
        const kick = el('button', 'rkick', '✕');
        kick.type = 'button'; kick.title = `Remove ${r.name}`; kick.setAttribute('aria-label', `Remove ${r.name}`);
        kick.addEventListener('click', () => send({ t: 'kick', id: r.id }));
        row.appendChild(kick);
      }
      rost.appendChild(row);
    }
    side.appendChild(rost);

    const card = (kind, label, value, sub, art) => {
      const c = el(isHost ? 'button' : 'div', `mcard k-${kind}${isHost ? '' : ' ro'}`);
      if (isHost) { c.type = 'button'; c.addEventListener('click', () => openPop(kind)); }
      if (art) c.appendChild(el('span', `ti-art ${art}`));
      const t = el('span', 'ct');
      t.append(el('span', 'lbl', label), el('b', '', value), el('span', 'cs', sub));
      c.appendChild(t);
      if (isHost) c.appendChild(el('span', 'chg', 'CHANGE'));
      return c;
    };
    const rules = [];
    if (info.limits?.length) rules.push(`${settings.limit} ${info.unit}`);
    if (!info.untimed) rules.push(minutes(settings.time));
    rules.push(weaponLabel(settings.weapons));
    side.append(
      card('mode', 'MODE', info.label, info.blurb),
      card('map', 'MAP', settings.map.toUpperCase(), mapSize(settings.map), `art-${settings.map}`),
      card('rules', 'RULES', rules.slice(0, 2).join(' · ') || 'NO LIMITS', rules.slice(2).join(' · ') || (settings.mode === 'survival' ? 'ENDS WHEN EVERYONE HAS FALLEN' : info.untimed ? 'GOES ON UNTIL THE HOST ENDS IT' : '')),
    );
    if (history.length) {
      const h = el('div', 'history');
      h.appendChild(el('span', 'lbl', 'RECENT MATCHES'));
      for (const e of history.slice(0, 3)) h.appendChild(historyRow(e));
      side.appendChild(h);
    }
    root.appendChild(side);
    if (isHost && pop) root.appendChild(popout(pop, settings, info, pick));
    else pop = null;

    // Bottom: ready up, or start.
    const act = el('div', 'actions');
    const status = el('div', 'status');
    if (spectating) status.append(el('b', '', 'WATCHING'), el('span', '', 'YOU JOIN THE NEXT LOBBY IF YOU WANT TO PLAY'));
    else if (isHost) {
      status.append(el('b', '', guests.length ? `${readyCount} / ${guests.length} READY` : 'WAITING FOR PLAYERS'), el('span', '', blocker || 'EVERYONE IS READY'));
      const go = el('button', 'go', 'START MATCH');
      go.type = 'button';
      go.disabled = !!blocker;
      go.addEventListener('click', () => send({ t: 'start' }));
      act.append(status, go);
    } else {
      const ready = !!me?.ready;
      status.append(el('b', '', ready ? 'YOU ARE READY' : 'NOT READY'), el('span', '', 'THE HOST STARTS THE MATCH'));
      const b = el('button', ready ? 'go on' : 'go', ready ? 'NOT READY' : 'READY');
      b.type = 'button';
      b.addEventListener('click', () => send({ t: 'ready', ready: !ready }));
      act.append(status, b);
    }
    if (!act.children.length) act.appendChild(status);
    const leave = el('button', 'leave', 'LEAVE');
    leave.type = 'button';
    leave.addEventListener('click', onLeave);
    act.appendChild(leave);
    root.appendChild(act);
  }

  return {
    render,
    show(on) {
      if (on === shown) return;
      shown = on;
      root.classList.toggle('on', on);
      document.body.classList.toggle('mp-lobby', on);
      if (!on) { pop = null; document.body.classList.remove('mp-pop'); }
    },
    get shown() { return shown; },
  };
}
