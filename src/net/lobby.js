import { MAP_DATA, MAP_IDS } from '../sim/mapData.js';
import { MODE_INFO, PLAYABLE, TIME_OPTIONS, WEAPON_RULES, mapHosts } from '../sim/modes.js';
import { WEAPON_BY_ID } from '../sim/weaponData.js';

/**
 * The lobby screen, and the match history it shows. The server decides everything: this only
 * draws what it was told (the roster with ready marks, the host, the settings) and sends the
 * player's choices back. A guest sees the settings but cannot change them.
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

export function createLobby({ send, onLeave }) {
  const root = document.createElement('div');
  root.id = 'mp-lobby';
  document.body.appendChild(root);
  let shown = false;

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
    const isHost = myId !== null && myId === host && !spectating;
    const me = roster.find((r) => r.id === myId);
    root.textContent = '';
    const card = el('div', 'card');

    const head = el('div', 'head');
    head.append(el('h2', '', 'ONLINE LOBBY'), el('span', 'sub', `${roster.length} PLAYER${roster.length === 1 ? '' : 'S'}${spectators ? ` · ${spectators} WATCHING` : ''}`));
    card.appendChild(head);

    const cols = el('div', 'cols');

    // Players
    const players = el('div', 'players');
    players.appendChild(el('span', 'lbl', 'PLAYERS'));
    for (const r of roster) {
      const row = el('div', `p${r.id === myId ? ' self' : ''}${r.ready || r.id === host ? ' ready' : ''}`);
      row.append(el('span', 'crown', r.id === host ? '♕' : ''), el('span', 'nm', r.name), el('span', 'st', r.id === host ? 'HOST' : (r.ready ? 'READY' : 'NOT READY')));
      players.appendChild(row);
    }
    cols.appendChild(players);

    // Settings: pickable by the host, a read-out for everyone else.
    const set = el('div', 'settings');
    const info = MODE_INFO[settings.mode];
    const pick = (patch) => send({ t: 'settings', ...patch });
    set.append(
      group('MODE', PLAYABLE.map((id) => option(MODE_INFO[id].label, id === settings.mode, isHost, () => pick({ mode: id }), MODE_INFO[id].blurb))),
      group('MAP', MAP_IDS.map((id) => option(id.toUpperCase(), id === settings.map, isHost && mapHosts(MAP_DATA, id, settings.mode), () => pick({ map: id })))),
      group('LIMIT', info.limits.map((n) => option(`${n} ${info.unit}`, n === settings.limit, isHost, () => pick({ limit: n })))),
      group('TIME', TIME_OPTIONS.map((t) => option(minutes(t), t === settings.time, isHost, () => pick({ time: t })))),
      group('WEAPONS', WEAPON_RULES.map((w) => option(weaponLabel(w), w === settings.weapons, isHost, () => pick({ weapons: w })))),
    );
    set.appendChild(el('p', 'blurb', info.blurb));
    cols.appendChild(set);
    card.appendChild(cols);

    // Actions
    const act = el('div', 'actions');
    if (spectating) act.appendChild(el('span', 'note', 'YOU ARE WATCHING · YOU JOIN THE NEXT LOBBY IF YOU WANT TO PLAY'));
    else if (isHost) {
      const go = el('button', 'go', 'START MATCH');
      go.type = 'button';
      go.disabled = !!blocker;
      go.addEventListener('click', () => send({ t: 'start' }));
      act.append(go, el('span', 'note', blocker || 'EVERYONE IS READY'));
    } else {
      const ready = !!me?.ready;
      const b = el('button', ready ? 'go on' : 'go', ready ? 'NOT READY' : 'READY');
      b.type = 'button';
      b.addEventListener('click', () => send({ t: 'ready', ready: !ready }));
      act.append(b, el('span', 'note', 'THE HOST CHOOSES THE SETTINGS AND STARTS THE MATCH'));
    }
    const leave = el('button', 'leave', 'LEAVE');
    leave.type = 'button';
    leave.addEventListener('click', onLeave);
    act.appendChild(leave);
    card.appendChild(act);

    if (history.length) {
      const h = el('div', 'history');
      h.appendChild(el('span', 'lbl', 'MATCH HISTORY'));
      for (const e of history.slice(0, 5)) h.appendChild(historyRow(e));
      card.appendChild(h);
    }
    root.appendChild(card);
  }

  return {
    render,
    show(on) {
      if (on === shown) return;
      shown = on;
      root.classList.toggle('on', on);
      document.body.classList.toggle('mp-lobby', on);
    },
    get shown() { return shown; },
  };
}
