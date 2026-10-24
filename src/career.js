import { levelFromXp, rankTitle } from './profile.js';
import { SKINS, TITLES, TRACK_END, isUnlocked, levelRewards, titleProgress } from './rewards.js';

/**
 * The career screen: your level and rank, the track of everything levels unlock, and the titles
 * you can earn. Built on first open. Everything shown comes from the saved career and the table
 * in rewards.js; nothing is hand-written here, so a new reward appears with no change to this file.
 */

const STAT_LABEL = { matches: 'MATCHES', wins: 'WINS', headshots: 'HEADSHOTS', bestStreak: 'STREAK', kills: 'KILLS' };
const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const bare = (n) => n.replace(/ (OPERATOR|FINISH)$/, '');

export function createCareer({ getProfile, onTitle = () => {}, onOpen = () => {}, onClose = () => {} }) {
  let root = null;

  function build() {
    root = document.createElement('div');
    root.id = 'career';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="cr-card">
        <div class="cr-head">
          <div class="cr-badge"><span id="cr-level">1</span><small>LVL</small></div>
          <div class="cr-who"><h2 id="cr-rank">ROOKIE</h2><div class="cr-xp"><i id="cr-xpfill"></i></div><div class="cr-xpt" id="cr-xpt"></div></div>
          <button id="career-close" type="button" aria-label="Close">&#x2715;</button>
        </div>
        <div class="cr-label">REWARDS</div>
        <div class="cr-track" id="cr-track"></div>
        <div class="cr-label cr-label-titles">TITLES</div>
        <div class="cr-titles" id="cr-titles"></div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#career-close').addEventListener('click', close);
    // On the window, not the card: wearing a title redraws the card and focus falls back to the page.
    addEventListener('keydown', (e) => { if (e.code === 'Escape' && !root.classList.contains('hidden')) close(); });
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
  }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function render() {
    const p = getProfile();
    const { level, into, need } = levelFromXp(p.xp);
    root.querySelector('#cr-level').textContent = level;
    root.querySelector('#cr-rank').textContent = rankTitle(level);
    root.querySelector('#cr-xpt').textContent = `${into} / ${need} XP`;
    root.querySelector('#cr-xpfill').style.width = `${Math.round((into / need) * 100)}%`;

    const track = root.querySelector('#cr-track');
    track.textContent = '';
    // Level 1 is the starting kit, so the track begins at the first thing you have to earn.
    for (let l = 2; l <= TRACK_END; l++) {
      const items = levelRewards(l).map((it) => ({ ...it, name: bare(it.name) }));
      if (!items.length) continue;
      const node = el('div', `cr-node${level >= l ? ' done' : ' locked'}${level === l ? ' current' : ''}`);
      const head = el('div', 'cr-lvl');
      head.append(el('span', '', `LV ${l}`));
      head.insertAdjacentHTML('beforeend', level >= l ? TICK : LOCK);
      node.append(head);
      for (const it of items) {
        const row = el('div', `cr-item ${it.kind}`);
        if (it.kind === 'operator') {
          const img = el('img');
          img.alt = ''; img.src = `./assets/skins/${it.id}.jpg`; img.decoding = 'async';
          row.append(img);
        } else {
          const sw = el('i');
          sw.style.background = SKINS.find((k) => k.id === it.id)?.swatch ?? '#444';
          row.append(sw);
        }
        row.append(el('b', '', it.name));
        node.append(row);
      }
      track.append(node);
    }

    const titles = root.querySelector('#cr-titles');
    titles.textContent = '';
    for (const t of TITLES) {
      const owned = isUnlocked(p, 'title', t.id);
      const row = el('div', `cr-title${owned ? ' owned' : ''}${(p.equipped?.title ?? '') === t.id ? ' worn' : ''}`);
      row.append(el('b', '', t.name));
      if (!owned) {
        const need = titleProgress(p, t.id);
        row.append(el('span', '', need.map(([k, have, want]) => `${have}/${want} ${STAT_LABEL[k] ?? k}`).join(' · ')));
      } else {
        const btn = el('button', '', (p.equipped?.title ?? '') === t.id ? 'WORN' : 'WEAR');
        btn.type = 'button';
        btn.disabled = (p.equipped?.title ?? '') === t.id;
        btn.addEventListener('click', () => { onTitle(t.id); render(); });
        row.append(btn);
      }
      titles.append(row);
    }
  }

  function open() {
    if (!root) build();
    render();
    root.classList.remove('hidden');
    root.querySelector('#career-close').focus({ preventScroll: true });
    onOpen();
  }

  function close() {
    if (!root || root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    onClose();
  }

  return { open, close, isOpen: () => !!root && !root.classList.contains('hidden') };
}
