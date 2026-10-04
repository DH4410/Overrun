/**
 * The loading screen shown between pressing a deploy button and the first frame of a match.
 * It covers the game while the map is built, shaders compile and textures are uploaded (see
 * main.js warmScene), so that none of that happens in front of the player, and nothing in the
 * world moves until it is gone.
 */

const TIPS = [
  'Headshots do double damage.',
  'A slide keeps your speed through a corner.',
  'Smoke blocks sight, not bullets.',
  'Crouching shrinks your head as a target.',
  'Reload behind cover, not in the open.',
  'Grenades can be cooked: hold G, then release.',
  'The sniper takes a moment between shots. Watch the bar by the reticle.',
  'Pick up health and shield on the flanks, not in the lane.',
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
root.innerHTML = '<div class="ls-inner"><span class="ls-kicker"></span><h2 class="ls-title"></h2><span class="ls-sub"></span>'
  + '<div class="ls-bar"><i></i></div><span class="ls-label"></span><p class="ls-tip"></p></div>';
document.body.appendChild(root);
const q = (s) => root.querySelector(s);
const ui = { kicker: q('.ls-kicker'), title: q('.ls-title'), sub: q('.ls-sub'), bar: q('.ls-bar i'), label: q('.ls-label'), tip: q('.ls-tip') };

let shownAt = 0, current = 0;

export const loadScreen = {
  get active() { return root.classList.contains('on'); },

  /** Cover the game. `kicker` is the small line over the title (the mode), `title` the map. */
  show({ kicker = '', title = 'LOADING', sub = '' } = {}) {
    ui.kicker.textContent = kicker;
    ui.title.textContent = title;
    ui.sub.textContent = sub;
    ui.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    current = 0;
    ui.bar.style.width = '0%';
    ui.label.textContent = '';
    shownAt = performance.now();
    root.classList.add('on');
    document.body.classList.add('loading-game');
  },

  /** Change the words while it is up (the connection became a lobby, a map is being built). */
  set({ kicker, title, sub } = {}) {
    if (kicker !== undefined) ui.kicker.textContent = kicker;
    if (title !== undefined) ui.title.textContent = title;
    if (sub !== undefined) ui.sub.textContent = sub;
  },

  /** Set the bar and the line under it, then let the browser paint before the next heavy step. */
  async step(fraction, label) {
    current = Math.max(current, Math.min(1, fraction));
    ui.bar.style.width = `${Math.round(current * 100)}%`;
    if (label) ui.label.textContent = label;
    await frame();
    await frame();
  },

  /** Sets the line only (a wait on the network has no fraction). */
  say(label) { ui.label.textContent = label; },

  /** Take it down, but not before it has been up for `minMs`: a flash of it is worse than none. */
  async hide(minMs = 1100) {
    await step_(minMs - (performance.now() - shownAt));
    root.classList.remove('on');
    document.body.classList.remove('loading-game');
  },
};

const step_ = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
