/**
 * The loading screen shown between pressing a deploy button and the first frame of a match.
 * It covers the game while the map is built, shaders compile and textures are uploaded (see
 * main.js warmScene), so that none of that happens in front of the player, and nothing in the
 * world moves until it is gone.
 *
 * It fills the page: the map's own art behind everything, the map name large at the lower left,
 * a field note and the current key bindings on the right, and one full-width progress bar along
 * the bottom. The only things that animate are a slow push-in on the art and the bar, both
 * transform-only (compositor work, no layout), and both off under reduced motion.
 */

import { codeOf, keyName } from './keybinds.js';

const TIPS = [
  'Headshots do double damage.',
  'A slide keeps your speed through a corner.',
  'Smoke blocks sight, not bullets.',
  'Crouching shrinks your head as a target.',
  'Reload behind cover, not in the open.',
  'Grenades can be cooked: hold G, then release.',
  'The sniper takes a moment between shots. Watch the bar by the reticle.',
  'Pick up health and shield on the flanks, not in the lane.',
  'Hold the aim button to steady the gun and tighten the spread.',
  'Sound carries: sprinting and landing give your position away.',
  'Count the other team’s reloads. That is your window.',
  'Shields come back to full only from a pickup; health does not regenerate.',
];

/** The art for a map is its lobby thumbnail; these are the ones shipped (assets/maps/thumbs). */
const ARTS = ['port', 'desert', 'snow', 'warzone', 'depot', 'bastion', 'arena', 'metro'];

/** What the strip along the right shows, in order: [label, action ids joined into one chip row]. */
const KEYS = [
  ['MOVE', ['forward', 'left', 'back', 'right']],
  ['JUMP', ['jump']],
  ['SPRINT', ['sprint']],
  ['CROUCH', ['crouch']],
  ['RELOAD', ['reload']],
  ['FRAG', ['frag']],
  ['SMOKE', ['smoke']],
  ['EMOTE', ['emote']],
];

const frame = () => new Promise((resolve) => {
  // A background tab or a pane without animation frames must not stall the load.
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(go);
  setTimeout(go, 90);
});

const root = document.createElement('div');
root.id = 'loadscreen';
root.innerHTML = '<div class="ls-art"></div><div class="ls-shade"></div>'
  + '<header class="ls-top"><span class="ls-brand">OVERRUN</span><span class="ls-kicker"></span></header>'
  + '<main class="ls-main"><div class="ls-head"><span class="ls-eyebrow">DEPLOYING TO</span>'
  + '<h2 class="ls-title"></h2><p class="ls-sub"></p></div>'
  + '<aside class="ls-side"><section class="ls-note"><span class="ls-note-h">FIELD NOTE</span><p class="ls-tip"></p></section>'
  + '<section class="ls-keys"><span class="ls-note-h">CONTROLS</span><ul></ul></section></aside></main>'
  + '<footer class="ls-foot"><div class="ls-row"><span class="ls-label"></span><span class="ls-pct">0%</span></div>'
  + '<div class="ls-bar"><i></i></div></footer>';
document.body.appendChild(root);
const q = (s) => root.querySelector(s);
const ui = {
  art: q('.ls-art'), kicker: q('.ls-kicker'), eyebrow: q('.ls-eyebrow'), title: q('.ls-title'), sub: q('.ls-sub'),
  bar: q('.ls-bar i'), label: q('.ls-label'), pct: q('.ls-pct'), tip: q('.ls-tip'), keys: q('.ls-keys ul'),
};

let shownAt = 0, current = 0, art = '', tipAt = -1, tipTimer = 0;

/** "Deploying to" belongs over a map name, not over the words for a wait. */
const eyebrowFor = (title) => (/^(CONNECTING|LOADING|LOBBY)$/.test(title) ? '' : 'DEPLOYING TO');

const pick = (list, not) => {
  const pool = list.length > 1 ? list.filter((x) => x !== not) : list;
  return pool[Math.floor(Math.random() * pool.length)];
};

function setArt(id) {
  if (!id || id === art) return;
  art = id;
  ui.art.classList.remove('ready');
  const img = new Image();
  const apply = () => {
    if (art !== id) return;
    ui.art.style.backgroundImage = `url(assets/maps/thumbs/${id}.jpg)`;
    // Restart the push-in with the new picture.
    ui.art.classList.remove('ready');
    void ui.art.offsetWidth;
    ui.art.classList.add('ready');
  };
  img.onload = apply;
  img.onerror = () => { if (art === id) ui.art.classList.add('ready'); };
  img.src = `assets/maps/thumbs/${id}.jpg`;
}

function nextTip() {
  tipAt = (tipAt + 1) % TIPS.length;
  ui.tip.textContent = TIPS[tipAt];
}

function fillKeys() {
  ui.keys.textContent = '';
  for (const [label, ids] of KEYS) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = label;
    const keys = document.createElement('span');
    keys.className = 'ls-k';
    for (const id of ids) {
      const k = document.createElement('kbd');
      k.textContent = keyName(codeOf(id));
      keys.appendChild(k);
    }
    li.append(name, keys);
    ui.keys.appendChild(li);
  }
}

function setBar(f) {
  current = Math.max(current, Math.min(1, f));
  ui.bar.style.transform = `scaleX(${current})`;
  ui.pct.textContent = `${Math.round(current * 100)}%`;
}

export const loadScreen = {
  get active() { return root.classList.contains('on'); },

  /** Cover the game. `kicker` is the small line over the title (the mode), `title` the map, `map` its art. */
  show({ kicker = '', title = 'LOADING', sub = '', map = '' } = {}) {
    ui.kicker.textContent = kicker;
    ui.title.textContent = title;
    ui.eyebrow.textContent = eyebrowFor(title);
    ui.sub.textContent = sub;
    setArt(map || pick(ARTS, art));
    tipAt = Math.floor(Math.random() * TIPS.length) - 1;
    nextTip();
    fillKeys();
    current = 0;
    setBar(0);
    ui.label.textContent = '';
    shownAt = performance.now();
    root.classList.add('on');
    document.body.classList.add('loading-game');
    clearInterval(tipTimer);
    tipTimer = setInterval(nextTip, 5000);
  },

  /** Change the words while it is up (the connection became a lobby, a map is being built). */
  set({ kicker, title, sub, map } = {}) {
    if (kicker !== undefined) ui.kicker.textContent = kicker;
    if (title !== undefined) { ui.title.textContent = title; ui.eyebrow.textContent = eyebrowFor(title); }
    if (sub !== undefined) ui.sub.textContent = sub;
    if (map) setArt(map);
  },

  /** Set the bar and the line under it, then let the browser paint before the next heavy step. */
  async step(fraction, label) {
    setBar(fraction);
    if (label) ui.label.textContent = label;
    await frame();
    await frame();
  },

  /** Sets the line only (a wait on the network has no fraction). */
  say(label) { ui.label.textContent = label; },

  /** Take it down, but not before it has been up for `minMs`: a flash of it is worse than none. */
  async hide(minMs = 1100) {
    await step_(minMs - (performance.now() - shownAt));
    clearInterval(tipTimer);
    root.classList.remove('on');
    document.body.classList.remove('loading-game');
  },
};

const step_ = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
