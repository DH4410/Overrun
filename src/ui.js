import { DEFAULT_SETTINGS, QUALITY, settings } from './settings.js';

/** Menu and settings event wiring. Gameplay transitions remain injected callbacks. */
export function createUiRuntime({
  elements: el,
  getElement: $,
  maps: MAPS,
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
  let mode = 'dm', diff = 'medium', map = 'warehouse';

  const blurb = $('map-blurb');
  for (const b of document.querySelectorAll('#maps .pill')) {
    b.addEventListener('click', () => {
      map = b.dataset.map;
      document.querySelectorAll('#maps .pill').forEach((x) => x.classList.toggle('active', x === b));
      if (blurb) blurb.textContent = MAPS[map].blurb;
    });
  }
  if (blurb) blurb.textContent = MAPS[map].blurb;

  for (const b of document.querySelectorAll('.mode-btn')) {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
  }
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
  { group: 'INTERFACE' },
  { key: 'crosshairColor', type: 'color', label: 'Crosshair colour' },
  { key: 'crosshairGap', type: 'range', label: 'Crosshair gap', min: 0, max: 20, step: 1, unit: 'px' },
  { key: 'showDamageNumbers', type: 'toggle', label: 'Floating damage numbers' },
  { key: 'showEnemyHealth', type: 'toggle', label: 'Show enemy health bars',
    hint: 'Off by default — the damage numbers already tell you how hard you hit.' },
  { group: 'AUDIO' },
  { key: 'masterVolume', type: 'range', label: 'Master volume', min: 0, max: 1, step: 0.05 },
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
    endMatch('MATCH ABANDONED', 'returned to menu');
  });
}

return {
  bindMenu,
  buildSettingsPanel,
  showSettings,
  bindSettings,
};
}
