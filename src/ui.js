import { loadProfile } from './profile.js';
import { renderPlayerCard } from './playercard.js';
import { DEFAULT_SETTINGS, FRAME_CAPS, QUALITY, settings } from './settings.js';

/** Menu and settings event wiring. Gameplay transitions remain injected callbacks. */
export function createUiRuntime({
  elements: el,
  getElement: $,
  maps: MAPS,
  defaultMap = () => 'port',
  audio: Audio,
  startMatch,
  applySettings,
  match,
  setAppState,
  settingsState,
  requestLock,
  endMatch,
  // The lobby shows the map you pick behind the menu (see previewMap in main.js).
  onMapPick = () => {},
}) {
function bindMenu() {
  let mode = 'dm', diff = 'medium', map = defaultMap();

  // The lobby card shows the saved career; the callsign field is the card's name line.
  renderPlayerCard(loadProfile());

  // Mode and map are each a card in the sidebar that opens a popout of big tiles; picking a
  // tile closes it. Esc, the X, or a click on the backdrop closes it without a change.
  const pops = [$('mode-pop'), $('map-pop')];
  const closePops = () => pops.forEach((p) => p?.classList.remove('on'));
  const openPop = (p) => { closePops(); p?.classList.add('on'); p?.querySelector('.tile.active')?.focus({ preventScroll: true }); };
  $('mode-card')?.addEventListener('click', () => openPop($('mode-pop')));
  $('map-card')?.addEventListener('click', () => openPop($('map-pop')));
  for (const p of pops) {
    p?.addEventListener('click', (e) => { if (e.target === p || e.target.closest('.pop-x')) closePops(); });
  }
  addEventListener('keydown', (e) => { if (e.code === 'Escape') closePops(); });

  const showMap = () => {
    $('map-name').textContent = MAPS[map].name;
    $('map-blurb').textContent = MAPS[map].blurb;
  };
  for (const b of document.querySelectorAll('#maps [data-map]')) {
    b.querySelector('.md').textContent = MAPS[b.dataset.map]?.blurb ?? '';
    // A map whose files failed to load cannot be picked; switchMap would ignore it anyway.
    if (MAPS[b.dataset.map]?.available?.() === false) {
      b.disabled = true;
      b.title = 'This map failed to load';
    }
    b.classList.toggle('active', b.dataset.map === map);
    b.addEventListener('click', () => {
      map = b.dataset.map;
      document.querySelectorAll('#maps [data-map]').forEach((x) => x.classList.toggle('active', x === b));
      showMap();
      closePops();
      onMapPick(map);
    });
  }
  showMap();

  // The duel always runs the elite opponent, so the difficulty pills do not apply to it.
  // Grey them out rather than hiding them, so it is obvious why they stopped responding.
  const diffGrp = $('diffgrp');
  const syncDiffLock = () => diffGrp?.classList.toggle('locked', mode === 'duel');

  const showMode = (b) => {
    $('mode-name').textContent = b.querySelector('.mt').textContent;
    $('mode-desc').textContent = b.querySelector('.md').textContent;
  };
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
      showMode(b);
      syncDiffLock();
      closePops();
    });
  }
  showMode(document.querySelector('.mode-btn.active'));
  syncDiffLock();
  for (const b of document.querySelectorAll('#diffs .pill')) {
    b.addEventListener('click', () => {
      diff = b.dataset.diff;
      document.querySelectorAll('#diffs .pill').forEach((x) => x.classList.toggle('active', x === b));
    });
  }
  el.play.addEventListener('click', () => {
    Audio.init();
    startMatch(mode, diff, el.nameInput.value.trim(), map);
  });
}

/* ------------------------- settings panel ------------------------- */

/**
 * The panel is generated from this table rather than hand-written markup, so adding an option
 * is one line and the control, the label, the live read-out and the persistence all follow.
 */
const SETTINGS_SCHEMA = [
  { group: 'VIDEO', icon: 'M3 5h18v11H3zM8 20h8M12 16v4' },
  {
    key: 'quality', type: 'choice', label: 'Quality',
    options: Object.keys(QUALITY).map((k) => ({ value: k, label: QUALITY[k].label })),
    hint: 'Shadows are most of the frame cost. Drop to PERFORMANCE if you see stutter.',
  },
  {
    key: 'frameCap', type: 'choice', label: 'Frame cap',
    options: FRAME_CAPS.map((v) => ({ value: v, label: v === 0 ? 'UNCAPPED' : String(v) })),
    hint: 'Every frame drawn costs battery; 30 stretches the charge furthest. The simulation runs on its own clock, so the cap never slows the game down.',
  },
  { key: 'adaptiveRes', type: 'toggle', label: 'Adaptive resolution',
    hint: 'Renders fewer pixels when frames run late and puts them back when they do not.' },
  { key: 'powerSaver', type: 'toggle', label: 'Battery saver',
    hint: 'Halves the shadow refresh rate and asks for the integrated GPU. Reload to apply the GPU choice.' },
  { key: 'screenShake', type: 'range', label: 'Screen shake', min: 0, max: 1, step: 0.05,
    hint: 'How hard the view shakes when you fire, are hit or stand near a blast. 0 turns it off.' },
  { key: 'viewBob', type: 'toggle', label: 'View bob' },
  { group: 'AIM', icon: 'M12 4v5M12 15v5M4 12h5M15 12h5M12 12h.01' },
  { key: 'sensitivity', type: 'range', label: 'Mouse sensitivity', min: 0.1, max: 3, step: 0.05 },
  { key: 'adsSensitivity', type: 'range', label: 'Aim-down-sights sensitivity', min: 0.1, max: 1.5, step: 0.05 },
  { key: 'invertY', type: 'toggle', label: 'Invert vertical look' },
  { key: 'toggleAim', type: 'toggle', label: 'Aim: press to toggle',
    hint: 'Trackpad friendly: right-click toggles aim instead of holding it.' },
  { key: 'aimAssist', type: 'range', label: 'Aim assist', min: 0, max: 1, step: 0.05,
    hint: '0 is off. Up to 0.5 it only slows your crosshair over a visible enemy; past 0.5 it also pulls, gently.' },
  { key: 'trackpadLook', type: 'toggle', label: 'Trackpad look boost',
    hint: 'Fast swipes turn further, slow ones are untouched.' },
  { group: 'MOVE', icon: 'M5 18l5-5 3 3 6-8M15 8h4v4' },
  { key: 'toggleCrouch', type: 'toggle', label: 'Crouch: press to toggle' },
  { key: 'toggleSprint', type: 'toggle', label: 'Sprint: press to toggle' },
  { key: 'autoSprint', type: 'toggle', label: 'Sprint automatically',
    hint: 'Runs whenever you hold forward. Off while aiming, and never while strafing.' },
  { key: 'arrowKeys', type: 'toggle', label: 'Arrow keys also move' },
  { group: 'HUD', icon: 'M4 6h16v12H4zM4 10h16' },
  { key: 'crosshairColor', type: 'color', label: 'Crosshair colour' },
  { key: 'crosshairGap', type: 'range', label: 'Crosshair gap', min: 0, max: 20, step: 1, unit: 'px' },
  { key: 'showDamageNumbers', type: 'toggle', label: 'Floating damage numbers' },
  { key: 'showEnemyHealth', type: 'toggle', label: 'Enemy health bars' },
  { key: 'highContrast', type: 'toggle', label: 'High contrast',
    hint: 'Brighter secondary text, solid panels and heavier shadows, for bright rooms or small screens.' },
  { group: 'AUDIO', icon: 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6' },
  { key: 'masterVolume', type: 'range', label: 'Master volume', min: 0, max: 1, step: 0.05 },
  { key: 'musicVolume', type: 'range', label: 'Music volume', min: 0, max: 1, step: 0.05 },
];

/** The page being shown, remembered while the panel is open. */
let settingsPage = 'VIDEO';

function buildSettingsPanel() {
  const host = $('settings-body');
  if (!host) return;
  host.innerHTML = '';

  const nav = $('set-nav');
  if (nav) nav.textContent = '';
  let page = host;
  const show = (name) => {
    settingsPage = name;
    host.querySelectorAll('.set-page').forEach((x) => { x.hidden = x.dataset.page !== name; });
    nav?.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.page === name));
  };
  if (!SETTINGS_SCHEMA.some((r) => r.group === settingsPage)) settingsPage = SETTINGS_SCHEMA[0].group;
  for (const row of SETTINGS_SCHEMA) {
    if (row.group) {
      // One page at a time: a tab with an icon per page, and only that page's rows on screen.
      page = document.createElement('div');
      page.className = 'set-page';
      page.dataset.page = row.group;
      page.setAttribute('aria-label', row.group);
      host.appendChild(page);
      if (nav) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.dataset.page = row.group;
        tab.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${row.icon}"/></svg><span>${row.group}</span>`;
        tab.addEventListener('click', () => show(row.group));
        nav.appendChild(tab);
      }
      continue;
    }

    const wrap = document.createElement('label');
    wrap.className = 'set-row';
    const name = document.createElement('span');
    name.className = 'set-label';
    name.textContent = row.label;
    const ctl = document.createElement('span');
    ctl.className = 'set-ctl';

    if (row.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = row.min; input.max = row.max; input.step = row.step;
      input.value = settings[row.key];
      const out = document.createElement('b');
      const show = () => { out.textContent = (+input.value).toFixed(row.step < 1 ? 2 : 0) + (row.unit || ''); };
      show();
      input.addEventListener('input', () => {
        settings[row.key] = parseFloat(input.value);
        show();
        applySettings();
      });
      ctl.append(input, out);
    } else if (row.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!settings[row.key];
      input.addEventListener('change', () => { settings[row.key] = input.checked; applySettings(); });
      ctl.appendChild(input);
    } else if (row.type === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = settings[row.key];
      input.addEventListener('input', () => { settings[row.key] = input.value; applySettings(); });
      ctl.appendChild(input);
    } else if (row.type === 'choice') {
      const box = document.createElement('span');
      box.className = 'set-choice';
      for (const o of row.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = o.label;
        b.className = settings[row.key] === o.value ? 'active' : '';
        b.addEventListener('click', () => {
          settings[row.key] = o.value;
          box.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          applySettings();
        });
        box.appendChild(b);
      }
      ctl.appendChild(box);
    }

    wrap.append(name, ctl);
    // The explanation lives behind a small "i" instead of a paragraph under every row.
    if (row.hint) {
      const i = document.createElement('i');
      i.className = 'set-info';
      i.textContent = 'i';
      i.title = row.hint;
      wrap.title = row.hint;
      name.appendChild(i);
    }
    page.appendChild(wrap);
  }
  show(settingsPage);
}

function showSettings(on) {
  const panel = $('settings');
  if (!panel) return;
  if (on) {
    buildSettingsPanel();
    if (match.running) setAppState(settingsState);
  }
  panel.classList.toggle('hidden', !on);
  if (on) document.exitPointerLock?.();
}

function bindSettings() {
  buildSettingsPanel();
  $('settings-open')?.addEventListener('click', () => showSettings(true));
  $('settings-open-pause')?.addEventListener('click', () => showSettings(true));
  $('settings-close')?.addEventListener('click', () => {
    showSettings(false);
    if (match.running) requestLock();
  });
  $('settings-reset')?.addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    applySettings();
    buildSettingsPanel();
  });
  // Leaving the match from the pause overlay.
  $('quit-match')?.addEventListener('click', () => {
    endMatch('MATCH ABANDONED', 'returned to menu', { instant: true });
  });
}

return {
  bindMenu,
  buildSettingsPanel,
  showSettings,
  bindSettings,
};
}
