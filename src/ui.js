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
}) {
function bindMenu() {
  let mode = 'dm', diff = 'medium', map = defaultMap();

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
  { group: 'GRAPHICS' },
  {
    key: 'quality', type: 'choice', label: 'Quality preset',
    options: Object.keys(QUALITY).map((k) => ({ value: k, label: QUALITY[k].label })),
    hint: 'Shadows are ~95% of the frame cost. Drop to PERFORMANCE if you see stutter.',
  },
  { group: 'LAPTOP & BATTERY' },
  {
    key: 'frameCap', type: 'choice', label: 'Frame rate cap',
    options: FRAME_CAPS.map((v) => ({ value: v, label: v === 0 ? 'UNCAPPED' : String(v) })),
    hint: 'Every frame drawn costs battery; 30 stretches the charge furthest. Frames are kept '
        + 'evenly spaced so turning stays smooth, which means some screens land a little above '
        + 'the number (72 on a 144 Hz screen). The simulation runs on its own clock, so the cap '
        + 'never slows the game down.',
  },
  {
    key: 'adaptiveRes', type: 'toggle', label: 'Adaptive resolution',
    hint: 'Quietly renders fewer pixels when frames run late, and puts them back when they '
        + 'do not. The cheapest way out of a stutter.',
  },
  {
    key: 'powerSaver', type: 'toggle', label: 'Battery saver',
    hint: 'Halves the shadow refresh rate, and asks for the integrated GPU instead of the '
        + 'discrete one. The GPU choice and anti-aliasing are fixed when the page loads, so '
        + 'reload to apply those two.',
  },
  { group: 'CONTROLS' },
  { key: 'sensitivity', type: 'range', label: 'Mouse sensitivity', min: 0.1, max: 3, step: 0.05 },
  { key: 'adsSensitivity', type: 'range', label: 'Aim-down-sights sensitivity', min: 0.1, max: 1.5, step: 0.05 },
  { key: 'invertY', type: 'toggle', label: 'Invert vertical look' },
  { key: 'viewBob', type: 'toggle', label: 'View bob' },
  { key: 'toggleAim', type: 'toggle', label: 'Aim: press to toggle' ,
    hint: 'Trackpad friendly — right-click toggles aim instead of having to hold it.' },
  { key: 'toggleCrouch', type: 'toggle', label: 'Crouch: press to toggle' },
  { key: 'toggleSprint', type: 'toggle', label: 'Sprint: press to toggle' },
  { key: 'arrowKeys', type: 'toggle', label: 'Arrow keys also move' },
  { key: 'trackpadLook', type: 'toggle', label: 'Trackpad look boost',
    hint: 'Fast swipes turn further, slow ones are untouched — so a trackpad can manage a 180 '
        + 'without giving up fine aim.' },
  { key: 'autoSprint', type: 'toggle', label: 'Sprint automatically',
    hint: 'Runs whenever you hold forward, so Shift never has to be held down. Off while '
        + 'aiming, and never while strafing, because sprinting is the widest accuracy cone in '
        + 'the game.' },
  { key: 'aimAssist', type: 'range', label: 'Aim assist', min: 0, max: 1, step: 0.05,
    hint: '0 is off. Up to 0.5 it only slows your crosshair while it is over a visible enemy, '
        + 'so you stop on target instead of overshooting — it never moves your aim. Past 0.5 it '
        + 'also pulls, gently.' },
  { group: 'INTERFACE' },
  { key: 'crosshairColor', type: 'color', label: 'Crosshair colour' },
  { key: 'crosshairGap', type: 'range', label: 'Crosshair gap', min: 0, max: 20, step: 1, unit: 'px' },
  { key: 'showDamageNumbers', type: 'toggle', label: 'Floating damage numbers' },
  { key: 'showEnemyHealth', type: 'toggle', label: 'Show enemy health bars',
    hint: 'Off by default — the damage numbers already tell you how hard you hit.' },
  { group: 'AUDIO' },
  { key: 'masterVolume', type: 'range', label: 'Master volume', min: 0, max: 1, step: 0.05 },
  { key: 'musicVolume', type: 'range', label: 'Music volume', min: 0, max: 1, step: 0.05 },
];

function buildSettingsPanel() {
  const host = $('settings-body');
  if (!host) return;
  host.innerHTML = '';

  for (const row of SETTINGS_SCHEMA) {
    if (row.group) {
      const h = document.createElement('div');
      h.className = 'set-group';
      h.textContent = row.group;
      host.appendChild(h);
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
    host.appendChild(wrap);
    if (row.hint) {
      const h = document.createElement('div');
      h.className = 'set-hint';
      h.textContent = row.hint;
      host.appendChild(h);
    }
  }
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
