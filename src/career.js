import { levelFromXp, rankTitle } from './profile.js';
import { OPERATORS, SKINS, TITLES, TRACK_END, isUnlocked, levelRewards, titleProgress } from './rewards.js';

/**
 * The career screen: your level and rank, the track of everything levels unlock, and the titles
 * you can earn. Built on first open. Everything shown comes from the saved career and the table
 * in rewards.js; nothing is hand-written here, so a new reward appears with no change to this file.
 */

const STAT_LABEL = { matches: 'matches played', wins: 'wins', headshots: 'headshots', bestStreak: 'kill streak', kills: 'kills' };
const KIND_LABEL = { operator: 'OPERATOR', skin: 'FINISH' };

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
          <button id="career-close" type="button">DONE</button>
        </div>
        <div class="cr-label">REWARD TRACK <span>every level that unlocks something</span></div>
        <div class="cr-track" id="cr-track"></div>
        <div class="cr-label">TITLES <span>earned by what you do, worn under your name</span></div>
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
    root.querySelector('#cr-xpt').textContent = `${into} / ${need} XP TO LEVEL ${level + 1}`;
    root.querySelector('#cr-xpfill').style.width = `${Math.round((into / need) * 100)}%`;

    const track = root.querySelector('#cr-track');
    track.textContent = '';
    let currentNode = null;
    for (let l = 1; l <= TRACK_END; l++) {
      const items = l === 1
        ? [...OPERATORS.filter((o) => o.level === 1).map((o) => ({ kind: 'operator', name: `${o.name} OPERATOR` })), { kind: 'skin', name: 'STOCK FINISH' }]
        : levelRewards(l);
      if (!items.length) continue;
      const node = el('div', `cr-node${level >= l ? ' done' : ' locked'}${level === l ? ' current' : ''}`);
      node.append(el('div', 'cr-lvl', `LEVEL ${l}`));
      for (const it of items) {
        const row = el('div', 'cr-item');
        row.append(el('small', '', KIND_LABEL[it.kind] ?? ''), el('b', '', it.name));
        node.append(row);
      }
      node.append(el('div', 'cr-state', level >= l ? 'UNLOCKED' : `${l - level} LEVEL${l - level === 1 ? '' : 'S'} AWAY`));
      track.append(node);
      if (level >= l) currentNode = node;
    }
    currentNode?.scrollIntoView?.({ inline: 'center', block: 'nearest' });

    const titles = root.querySelector('#cr-titles');
    titles.textContent = '';
    for (const t of TITLES) {
      const owned = isUnlocked(p, 'title', t.id);
      const row = el('div', `cr-title${owned ? ' owned' : ''}${(p.equipped?.title ?? '') === t.id ? ' worn' : ''}`);
      row.append(el('b', '', t.name));
      if (!owned) {
        row.append(el('span', '', titleProgress(p, t.id).map(([k, have, want]) => `${have} / ${want} ${STAT_LABEL[k] ?? k}`).join(' · ')));
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
