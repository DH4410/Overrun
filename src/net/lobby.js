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

    // Right: the match. The host's to change; everyone else reads it.
    const info = MODE_INFO[settings.mode];
    const pick = (patch) => send({ t: 'settings', ...patch });
    const side = el('div', 'side');
    const sh = el('div', 'sh');
    sh.append(el('span', 'lbl', 'MATCH'), el('span', `tag${isHost ? ' host' : ''}`, isHost ? 'YOU ARE HOST' : 'HOST CHOOSES'));
    side.appendChild(sh);
    const modes = el('div', 'modes');
    for (const id of PLAYABLE) modes.appendChild(option(MODE_INFO[id].label, id === settings.mode, isHost, () => pick({ mode: id }), MODE_INFO[id].blurb));
    side.append(
      modes,
      el('p', 'blurb', info.blurb),
      group('MAP', MAP_IDS.map((id) => option(id.toUpperCase(), id === settings.map, isHost && mapHosts(MAP_DATA, id, settings.mode), () => pick({ map: id })))),
      group('LIMIT', info.limits.map((n) => option(`${n} ${info.unit}`, n === settings.limit, isHost, () => pick({ limit: n })))),
      group('TIME', TIME_OPTIONS.map((t) => option(minutes(t), t === settings.time, isHost, () => pick({ time: t })))),
      group('WEAPONS', WEAPON_RULES.map((w) => option(weaponLabel(w), w === settings.weapons, isHost, () => pick({ weapons: w })))),
    );
    if (history.length) {
      const h = el('div', 'history');
      h.appendChild(el('span', 'lbl', 'RECENT MATCHES'));
      for (const e of history.slice(0, 3)) h.appendChild(historyRow(e));
      side.appendChild(h);
    }
    root.appendChild(side);

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
    },
    get shown() { return shown; },
  };
}
