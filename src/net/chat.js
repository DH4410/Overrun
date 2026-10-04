import { TEAM_COLOR } from '../config.js';

/**
 * Online chat: a log in the corner and a one-line box that opens on Enter (Shift+Enter for team
 * chat). The box swallows its own key events so typing never drives the player, and the keys the
 * game thinks are held are released when it opens. A line is one small message to the server,
 * which is nothing against the daily budget (see MULTIPLAYER.md).
 */

const KEEP = 60, SHOW_MS = 9000, SHOWN_IN_GAME = 7;

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

export function createChat({ send, keys, canOpen, isLobby }) {
  const root = document.createElement('div');
  root.id = 'mp-chat';
  const log = document.createElement('div');
  log.className = 'log';
  const form = document.createElement('div');
  form.className = 'box';
  const tag = document.createElement('span');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 120;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Say something. Enter to send, Esc to cancel';
  form.append(tag, input);
  root.append(log, form);
  document.body.appendChild(root);

  const lines = [];   // { at, el }
  let open = false, team = false;

  function releaseKeys() { for (const k of Object.keys(keys)) keys[k] = false; }

  function setOpen(on, asTeam = false) {
    open = on; team = asTeam;
    root.classList.toggle('typing', on);
    tag.textContent = team ? 'TEAM' : 'ALL';
    tag.className = team ? 'team' : '';
    if (on) { releaseKeys(); input.value = ''; input.focus(); } else input.blur();
    refresh();
  }

  function submit() {
    const text = input.value.trim();
    if (text) send({ t: 'chat', text, team });
    setOpen(false);
  }

  // The box handles its own keys and keeps them from the game's window-level listeners.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Enter') { e.preventDefault(); submit(); } else if (e.code === 'Escape') setOpen(false);
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('focus', releaseKeys);
  input.addEventListener('blur', () => { if (open) setOpen(false); });

  addEventListener('keydown', (e) => {
    if (e.code !== 'Enter' || e.repeat || open || e.target?.tagName === 'INPUT' || !canOpen()) return;
    e.preventDefault();
    setOpen(true, e.shiftKey);
  });

  function add(m) {
    const row = document.createElement('div');
    row.className = m.sys ? 'sys' : 'msg';
    if (m.sys) row.textContent = m.text;
    else {
      const who = document.createElement('b');
      who.textContent = `${m.tm ? '[TEAM] ' : ''}${m.name}`;
      if (m.team) who.style.color = hex(TEAM_COLOR[m.team] ?? 0xffffff);
      const body = document.createElement('span');
      body.textContent = m.text;
      row.append(who, body);
    }
    log.appendChild(row);
    lines.push({ at: performance.now(), el: row });
    while (lines.length > KEEP) lines.shift().el.remove();
    refresh();
  }

  /** Which lines show: in game only the recent few, with the box open or in the lobby, more. */
  function refresh() {
    const now = performance.now();
    const all = open || isLobby();
    lines.forEach((l, i) => {
      const recent = now - l.at < SHOW_MS && i >= lines.length - SHOWN_IN_GAME;
      l.el.style.display = all || recent ? '' : 'none';
    });
    log.scrollTop = log.scrollHeight;
  }

  return {
    add,
    refresh,
    get open() { return open; },
    close() { if (open) setOpen(false); },
    clear() { for (const l of lines) l.el.remove(); lines.length = 0; setOpen(false); },
    show(on) { root.classList.toggle('on', on); },
    /** In the lobby the log sits beside the settings and the box is always there. */
    dock(on) { root.classList.toggle('dock', on); },
  };
}
