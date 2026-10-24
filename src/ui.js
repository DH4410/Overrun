import { ACTIONS, bindKey, codeOf, keyName, resetKeybinds } from './keybinds.js';
import { loadScreen } from './loading.js';
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
  beginMatch,
  warmScene,
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

  /** How big a map is, as a label and a 1-4 bar reading: the numbers a player picks by. */
  const sizeClass = ([w, d]) => { const a = w * d; return a < 3000 ? ['SMALL', 1] : a < 6000 ? ['MEDIUM', 2] : a < 10000 ? ['LARGE', 3] : ['HUGE', 4]; };
  const mapChips = (id) => {
    const size = MAPS[id]?.size;
    if (!size) return '';
    const [label, bars] = sizeClass(size);
    return `<i class="sz" data-bars="${bars}"><u></u><u></u><u></u><u></u>${label}</i><i>${size[0]} &times; ${size[1]} M</i>`;
  };
  const showMap = () => {
    $('map-name').textContent = MAPS[map].name;
    $('map-blurb').innerHTML = mapChips(map);
    $('map-art')?.setAttribute('class', `sc-art art-${map}`);
  };
  for (const b of document.querySelectorAll('#maps [data-map]')) {
    b.querySelector('.md').innerHTML = mapChips(b.dataset.map);
    // A map whose files failed to load cannot be picked; switchMap would ignore it anyway.
    if (MAPS[b.dataset.map]?.available?.() === false) {
      b.disabled = true;
      b.title = 'This map failed to load';
    }
    b.classList.toggle('active', b.dataset.map === map);
    b.addEventListener('click', () => {
      if (b.disabled) return;
      map = b.dataset.map;
      document.querySelectorAll('#maps [data-map]').forEach((x) => x.classList.toggle('active', x === b));
      showMap();
      closePops();
      onMapPick(map);
    });
  }
  showMap();

  // A map that cannot host the chosen mode (the big one is deathmatch only) greys out, and the
  // choice moves to the first map that can.
  const hosts = (id) => !MAPS[id]?.modes || MAPS[id].modes.includes(mode);
  const syncMaps = () => {
    for (const b of document.querySelectorAll('#maps [data-map]')) {
      const off = !hosts(b.dataset.map) || MAPS[b.dataset.map]?.available?.() === false;
      b.disabled = off;
      b.title = off ? 'Not available in this mode' : '';
    }
    if (!hosts(map)) {
      map = Object.keys(MAPS).find(hosts) ?? map;
      document.querySelectorAll('#maps [data-map]').forEach((x) => x.classList.toggle('active', x.dataset.map === map));
      showMap();
    }
  };

  // The duel always runs the elite opponent, so the difficulty pills do not apply to it.
  // Grey them out rather than hiding them, so it is obvious why they stopped responding.
  const diffGrp = $('diffgrp');
  const syncDiffLock = () => diffGrp?.classList.toggle('locked', mode === 'duel');

  const showMode = (b) => {
    $('mode-name').textContent = b.querySelector('.mt').textContent;
    $('mode-desc').innerHTML = b.querySelector('.md').innerHTML;
    const art = $('mode-art');
    if (art) art.innerHTML = b.querySelector('.ti-art').innerHTML;
  };
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
      showMode(b);
      syncDiffLock();
      syncMaps();
      closePops();
    });
  }
  showMode(document.querySelector('.mode-btn.active'));
  syncDiffLock();
  syncMaps();
  for (const b of document.querySelectorAll('#diffs .pill')) {
    b.addEventListener('click', () => {
      diff = b.dataset.diff;
      document.querySelectorAll('#diffs .pill').forEach((x) => x.classList.toggle('active', x === b));
    });
  }
  let deploying = false;
  el.play.addEventListener('click', async () => {
    if (deploying) return;
    deploying = true;
    Audio.init();
    // Cover the menu, build the match frozen, warm the graphics, then let it start: nothing
    // moves, and nothing hitches, in front of the player.
    loadScreen.show({ kicker: $('mode-name')?.textContent ?? '', title: MAPS[map].name, sub: MAPS[map].blurb, map });
    try {
      await loadScreen.step(0.1, 'Building the arena');
      startMatch(mode, diff, el.nameInput.value.trim(), map, { hold: true });
      await loadScreen.step(0.35, 'Loading graphics');
      await warmScene((f) => loadScreen.step(0.35 + f * 0.6, 'Loading graphics'));
      await loadScreen.step(1, 'Ready');
      await loadScreen.hide();
      beginMatch();
    } finally {
      deploying = false;
      if (loadScreen.active) loadScreen.hide(0);
    }
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
    key: 'quality', type: 'choice', label: 'Quality preset',
    options: Object.keys(QUALITY).map((k) => ({ value: k, label: QUALITY[k].label })),
    hint: 'Shadows are ~95% of the frame cost. Drop to PERFORMANCE if you see stutter.',
  },
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
    hint: 'Always on: lower resolution and pixel ratio, half the particles and lights, no '
        + 'scenery detail, a 60 frame cap, and shadows refreshed every other frame. It also '
        + 'asks for the integrated GPU, which (with anti-aliasing) is fixed when the page '
        + 'loads, so reload to apply those two.',
  },
  {
    key: 'powerAuto', type: 'toggle', label: 'Battery saver when unplugged',
    hint: 'Turns the saver on by itself whenever the laptop is not charging, and off again '
        + 'when you plug in. Below 15% charge the cap drops to 30. Needs a browser that '
        + 'reports battery state (Chrome and Edge do).',
  },
  {
    key: 'sceneryDetail', type: 'toggle', label: 'Scenery detail',
    hint: 'The small dressing on the maps: signs and lettering, fittings, paint and stains, '
        + 'grass tufts. Purely visual; turning it off saves fill rate and memory bandwidth.',
  },
  { group: 'FX', icon: 'M12 3l2.2 5.6L20 10l-4.4 3.6L17 19l-5-3-5 3 1.4-5.4L4 10l5.8-1.4z' },
  { key: 'screenShake', type: 'range', label: 'Screen shake', min: 0, max: 1, step: 0.05,
    hint: 'How hard the view shakes when you fire, are hit or stand near a blast. 0 turns it off.' },
  { key: 'viewBob', type: 'toggle', label: 'View bob' },
  { key: 'fxLowHealth', type: 'toggle', label: 'Low-health desaturation',
    hint: 'The picture drains of colour as your health runs low, along with the red vignette.' },
  { key: 'fxSpeed', type: 'toggle', label: 'Sprint speed effect',
    hint: 'A small field-of-view push while sprinting, so speed is something you feel.' },
  { key: 'fxBlast', type: 'toggle', label: 'Explosion screen effects',
    hint: 'A brief white flash when a grenade goes off close to you. Switch off if bright flashes bother you.' },
  { key: 'diegeticAmmo', type: 'toggle', label: 'Ammo counter on the gun',
    hint: 'A small readout on the weapon showing rounds left in the magazine, red when nearly empty.' },
  { key: 'fxHitFlash', type: 'toggle', label: 'Enemy hit flash',
    hint: 'An enemy blinks white for an instant when you hit them.' },
  { key: 'lowAmmoCue', type: 'toggle', label: 'Low-ammo click',
    hint: 'A metallic tick on the last few shots so you know to reload without looking.' },
  { group: 'AIM', icon: 'M12 4v5M12 15v5M4 12h5M15 12h5M12 12h.01' },
  { key: 'touchpad', type: 'toggle', label: 'I am using a touchpad',
    hint: 'One switch for laptop play: fast swipes turn further, right-click toggles aim, and aim assist slows the crosshair over enemies so you stop on '
        + 'target. The individual options below are left as you set them.' },
  { key: 'sensitivity', type: 'range', label: 'Mouse sensitivity', min: 0.1, max: 3, step: 0.01 },
  { key: 'adsSensitivity', type: 'range', label: 'Aim-down-sights sensitivity', min: 0.1, max: 1.5, step: 0.01 },
  { key: 'rawInput', type: 'toggle', label: 'Raw mouse input',
    hint: 'Bypasses the operating system\'s pointer acceleration so the same hand movement always '
        + 'turns the same distance. Applies the next time you click into the game.' },
  { key: 'fov', type: 'range', label: 'Field of view', min: 60, max: 100, step: 1, unit: '°',
    hint: 'Vertical field of view while hip-firing. Wider sees more of the sides but makes enemies smaller.' },
  { key: 'invertY', type: 'toggle', label: 'Invert vertical look' },
  { key: 'toggleAim', type: 'toggle', label: 'Aim: press to toggle',
    hint: 'Trackpad friendly: right-click toggles aim instead of holding it.' },
  { key: 'aimAssist', type: 'range', label: 'Aim assist', min: 0, max: 1, step: 0.05,
    hint: '0 is off. Up to 0.5 it only slows your crosshair while it is over a visible enemy, '
        + 'so you stop on target instead of overshooting — it never moves your aim. Past 0.5 it '
        + 'also pulls, gently.' },
  { key: 'trackpadLook', type: 'toggle', label: 'Trackpad look boost',
    hint: 'Fast swipes turn further, slow ones are untouched — so a trackpad can manage a 180 '
        + 'without giving up fine aim.' },
  { group: 'MOVE', icon: 'M5 18l5-5 3 3 6-8M15 8h4v4' },
  { key: 'toggleCrouch', type: 'toggle', label: 'Crouch: press to toggle' },
  { key: 'arrowKeys', type: 'toggle', label: 'Arrow keys also move' },
  { group: 'KEYS', icon: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8' },
  { type: 'keybinds' },
  { group: 'HUD', icon: 'M4 6h16v12H4zM4 10h16' },
  { key: 'crosshairColor', type: 'color', label: 'Crosshair colour' },
  { key: 'crosshairGap', type: 'range', label: 'Crosshair gap', min: 0, max: 20, step: 1, unit: 'px' },
  { key: 'showDamageNumbers', type: 'toggle', label: 'Floating damage numbers' },
  { key: 'showEnemyHealth', type: 'toggle', label: 'Enemy health bars',
    hint: 'Off by default — the damage numbers already tell you how hard you hit.' },
  { key: 'highContrast', type: 'toggle', label: 'High contrast',
    hint: 'Brighter secondary text, solid panels and heavier shadows, for bright rooms or small screens.' },
  { group: 'AUDIO', icon: 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6' },
  { key: 'masterVolume', type: 'range', label: 'Master volume', min: 0, max: 1, step: 0.05 },
  { key: 'musicVolume', type: 'range', label: 'Music volume', min: 0, max: 1, step: 0.05 },
];

/** The control strip at the bottom of the menu, drawn from the keys as they are now bound. */
function refreshKeyHelp() {
  const boxes = [$('keyhelp'), $('p-keys')].filter(Boolean);
  if (!boxes.length) return;
  const k = (id) => `<kbd>${keyName(codeOf(id))}</kbd>`;
  const move = ['forward', 'left', 'back', 'right'].map((id) => keyName(codeOf(id))).join('');
  const item = (key, text) => `<span>${key} ${text}</span>`;
  const html = [
    item(`<kbd>${move}</kbd>`, 'Move'), item(k('jump'), 'Jump'), item(k('sprint'), 'Sprint'), item(k('crouch'), 'Crouch'),
    item('<kbd>RMB</kbd>', 'Aim'), item(k('reload'), 'Reload'),
    item(`${k('slot1')}\u2013${k('slot5')}`, 'Weapons'), item(k('frag'), 'Frag'), item(k('smoke'), 'Smoke'),
    item(k('board'), 'Scores'), item(k('emote'), 'Emote'),
  ].join('');
  for (const box of boxes) box.innerHTML = html;
}

/** One button per action; click it, press the key you want. Escape backs out. */
function buildKeybinds() {
  const box = document.createElement('div');
  box.className = 'kb';
  let capturing = null;
  const stop = () => { capturing?.(); capturing = null; };

  const draw = () => {
    box.innerHTML = '';
    let group = '';
    for (const a of ACTIONS) {
      if (a.group !== group) {
        group = a.group;
        const h = document.createElement('div');
        h.className = 'kb-group';
        h.textContent = group;
        box.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'kb-row';
      const name = document.createElement('span');
      name.textContent = a.label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = a.id;
      btn.textContent = keyName(codeOf(a.id));
      btn.classList.toggle('moved', codeOf(a.id) !== a.def);
      btn.addEventListener('click', () => {
        stop();
        btn.textContent = 'PRESS A KEY';
        btn.classList.add('listening');
        const onKey = (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (e.code !== 'Escape') bindKey(a.id, e.code);
          stop();
          draw();
          refreshKeyHelp();
        };
        addEventListener('keydown', onKey, true);
        capturing = () => removeEventListener('keydown', onKey, true);
      });
      row.append(name, btn);
      box.appendChild(row);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'kb-reset';
    reset.textContent = 'RESET KEYS TO DEFAULT';
    reset.addEventListener('click', () => { stop(); resetKeybinds(); draw(); refreshKeyHelp(); });
    box.appendChild(reset);
  };
  draw();
  return box;
}
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

    if (row.type === 'keybinds') { page.appendChild(buildKeybinds()); continue; }

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
  refreshKeyHelp();
  $('settings-open')?.addEventListener('click', () => showSettings(true));
  $('settings-open-pause')?.addEventListener('click', () => showSettings(true));
  $('settings-close')?.addEventListener('click', () => {
    showSettings(false);
    if (match.running) requestLock();
  });
  $('settings-reset')?.addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    resetKeybinds();
    refreshKeyHelp();
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
