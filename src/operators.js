import { levelFromXp } from './profile.js';
import { OPERATORS, isUnlocked } from './rewards.js';

/**
 * The OPERATORS page: a battle-pass style roster. Every character in the game on one screen, in the
 * order the levels unlock them. Click one to see it on the pad; EQUIP wears it. Worn is gold with a
 * tick, locked is greyed with its level, and nothing needs scrolling: the grid is sized to the screen.
 *
 * Rewards live in src/rewards.js. This file only draws them and says which one you are looking at.
 */

const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

export function createOperators({ getElement: $, getProfile, preview, onEquip }) {
  let root = null, sel = null, open = false;

  const wornId = () => { const e = getProfile().equipped?.operator; return isUnlocked(getProfile(), 'operator', e) ? e : 'swat'; };

  function build() {
    root = document.createElement('section');
    root.id = 'ops';
    root.setAttribute('aria-label', 'Operators');
    root.innerHTML = `
      <div class="ops-info">
        <div class="ops-role" id="ops-role"></div>
        <h2 id="ops-name"></h2>
        <div class="ops-state" id="ops-state"></div>
        <button id="ops-equip" type="button">EQUIP</button>
      </div>
      <div class="ops-pass">
        <div class="ops-rail"><div class="ops-lvl"><small>LEVEL</small><b id="ops-lvl">1</b></div><div class="ops-bar"><i id="ops-fill"></i></div><span id="ops-xp"></span></div>
        <div class="ops-grid" id="ops-grid"></div>
      </div>`;
    $('menu').append(root);
    root.querySelector('#ops-equip').addEventListener('click', () => {
      if (sel && isUnlocked(getProfile(), 'operator', sel)) { onEquip(sel); render(); }
    });
    root.querySelector('#ops-grid').addEventListener('click', (e) => {
      const t = e.target.closest('.ops-tile');
      if (!t) return;
      sel = t.dataset.id;
      preview(sel);
      render();
    });
    // Arrow keys step through the pass, so the page works without a mouse.
    addEventListener('keydown', (e) => {
      if (!open || !/^Arrow(Left|Right|Up|Down)$/.test(e.code)) return;
      const i = OPERATORS.findIndex((o) => o.id === sel);
      const step = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : e.code === 'ArrowUp' ? -5 : 5;
      const next = OPERATORS[Math.min(OPERATORS.length - 1, Math.max(0, i + step))];
      if (next && next.id !== sel) { sel = next.id; preview(sel); render(); e.preventDefault(); }
    });
  }

  function render() {
    const p = getProfile();
    const { level, into, need } = levelFromXp(p.xp);
    const worn = wornId();
    root.querySelector('#ops-lvl').textContent = level;
    root.querySelector('#ops-fill').style.width = `${Math.round((into / need) * 100)}%`;
    root.querySelector('#ops-xp').textContent = `${into} / ${need} XP`;

    const info = OPERATORS.find((o) => o.id === sel) ?? OPERATORS[0];
    const has = isUnlocked(p, 'operator', info.id);
    root.querySelector('#ops-name').textContent = info.name;
    root.querySelector('#ops-role').textContent = info.role;
    const st = root.querySelector('#ops-state');
    st.className = `ops-state${info.id === worn ? ' worn' : has ? '' : ' locked'}`;
    st.innerHTML = info.id === worn ? `${TICK}EQUIPPED` : has ? 'UNLOCKED' : `${LOCK}LEVEL ${info.level}`;
    const btn = root.querySelector('#ops-equip');
    btn.hidden = !has || info.id === worn;

    const grid = root.querySelector('#ops-grid');
    grid.textContent = '';
    for (const o of OPERATORS) {
      const unlocked = isUnlocked(p, 'operator', o.id);
      const t = document.createElement('button');
      t.type = 'button';
      t.dataset.id = o.id;
      t.className = `ops-tile${o.id === sel ? ' sel' : ''}${o.id === worn ? ' worn' : ''}${unlocked ? '' : ' locked'}`;
      t.setAttribute('aria-label', `${o.name}${o.id === worn ? ', equipped' : unlocked ? '' : `, unlocks at level ${o.level}`}`);
      t.innerHTML = `<img alt="" decoding="async" src="./assets/skins/${o.id}.jpg"><b>${o.name}</b>`
        + `<span class="ops-lv">${unlocked ? (o.id === worn ? TICK : `LV ${o.level}`) : `${LOCK}${o.level}`}</span>`;
      grid.append(t);
    }
  }

  /** Called when the page is shown: start on what you wear. */
  function show() {
    if (!root) build();
    open = true;
    sel = wornId();
    preview(sel);
    render();
  }
  function hide() { open = false; }

  return { show, hide, render: () => { if (open) render(); } };
}
