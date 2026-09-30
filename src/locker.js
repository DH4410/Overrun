import * as THREE from 'three';

import { buildGunModel } from './gunmodels.js';
import { assignSlot, DEFAULT_LOADOUT, GUN_IDS, LOADOUT_SIZE } from './loadout.js';
import { clamp } from './utils.js';
import { WEAPON_BY_ID } from './weapons.js';

/** How each gun is labelled in the locker: its class and a rarity colour. */
export const GUN_CARD = {
  pistol: { cls: 'SIDEARM', tier: 'common' },
  smg: { cls: 'SMG', tier: 'uncommon' },
  ar: { cls: 'ASSAULT', tier: 'rare' },
  shotgun: { cls: 'SHOTGUN', tier: 'epic' },
  sniper: { cls: 'MARKSMAN', tier: 'legendary' },
  frag: { cls: 'THROWABLE', tier: 'rare' },
};

/** Stat bars, 0..1, read off the tuning table so they cannot drift from how the guns play. */
function gunStats(w) {
  return [
    ['DAMAGE', clamp((w.damage * w.pellets) / 110, 0.04, 1)],
    ['FIRE RATE', clamp(1 / w.cooldown / 16, 0.04, 1)],
    ['ACCURACY', clamp(1 - w.rest / 0.085, 0.04, 1)],
    ['MOBILITY', clamp(1 - w.move / 0.034, 0.04, 1)],
    ['MAGAZINE', clamp(w.mag / 30, 0.04, 1)],
  ];
}

/**
 * Side-on portraits of the procedural guns, rendered once into images with a throwaway WebGL
 * context. The same models as the first-person view, so the locker shows the gun you get.
 */
let icons = null;
function gunIcons() {
  if (icons) return icons;
  icons = {};
  let r;
  try {
    r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return icons;
  }
  const W = 320, H = 140;
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f48, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(2, 3, 1.5);
  scene.add(key);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  const box = new THREE.Box3(), size = new THREE.Vector3(), centre = new THREE.Vector3();
  for (const id of [...GUN_IDS, 'frag']) {
    const m = buildGunModel(id);
    m.rotation.y = -0.32;                      // a touch of three-quarter, barrel to the right
    m.updateMatrixWorld(true);
    box.setFromObject(m).getSize(size);
    box.getCenter(centre);
    m.position.sub(centre);
    const half = Math.max(size.z, size.x) * 0.56;
    const halfW = Math.max(half, size.y * 0.62 * (W / H));
    cam.left = -halfW; cam.right = halfW;
    cam.top = halfW * (H / W); cam.bottom = -halfW * (H / W);
    cam.position.set(6, 0.4, 0);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    scene.add(m);
    r.render(scene, cam);
    icons[id] = r.domElement.toDataURL('image/png');
    scene.remove(m);
    m.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
  r.dispose();
  r.forceContextLoss?.();
  return icons;
}

/**
 * The locker: four gun slots and the frag slot along the top, the armory below. Pick a slot,
 * then a gun (or drag a gun onto a slot); a gun already carried swaps places. Every change is
 * applied and saved at once, so there is nothing to confirm.
 */
export function createLocker({ getLoadout, setLoadout, onOpen = () => {}, onClose = () => {} }) {
  let root = null, sel = 0;

  function build() {
    root = document.createElement('div');
    root.id = 'locker';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="lk-card">
        <div class="lk-head">
          <div><h2>LOCKER</h2><div class="lk-sub">Your loadout. Keys 1-4 follow the slots; 5 is always the frag.</div></div>
          <div class="set-actions"><button id="locker-reset" type="button">RESET</button><button id="locker-close" type="button">DONE</button></div>
        </div>
        <div class="lk-slots" id="lk-slots"></div>
        <div class="lk-label">ARMORY <span>pick a slot above, then a weapon, or drag one onto a slot</span></div>
        <div class="lk-armory" id="lk-armory"></div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#locker-close').addEventListener('click', close);
    root.querySelector('#locker-reset').addEventListener('click', () => { apply([...DEFAULT_LOADOUT]); sel = 0; render(); });
    root.addEventListener('keydown', (e) => { if (e.code === 'Escape') { e.stopPropagation(); close(); } });
  }

  function apply(list) { setLoadout(list); }

  function card(id, { slot = null, compact = false } = {}) {
    const w = WEAPON_BY_ID[id];
    const meta = GUN_CARD[id] ?? { cls: '', tier: 'common' };
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `lk-gun tier-${meta.tier}`;
    el.dataset.gun = id;
    const img = gunIcons()[id];
    el.innerHTML = `
      ${slot !== null ? `<span class="lk-key">${slot}</span>` : ''}
      <span class="lk-img">${img ? `<img alt="" src="${img}">` : ''}</span>
      <span class="lk-name">${w.name}</span>
      <span class="lk-cls">${meta.cls}</span>`;
    if (!compact && !w.thrown) {
      const bars = document.createElement('span');
      bars.className = 'lk-stats';
      for (const [label, v] of gunStats(w)) {
        bars.insertAdjacentHTML('beforeend', `<span class="lk-stat"><i>${label}</i><b><em style="width:${Math.round(v * 100)}%"></em></b></span>`);
      }
      el.appendChild(bars);
    }
    return el;
  }

  function render() {
    const loadout = getLoadout();
    const slots = root.querySelector('#lk-slots');
    slots.innerHTML = '';
    loadout.forEach((id, i) => {
      const c = card(id, { slot: i + 1, compact: true });
      c.classList.add('lk-slot');
      c.classList.toggle('sel', i === sel);
      c.addEventListener('click', () => { sel = i; render(); });
      c.addEventListener('dragover', (e) => e.preventDefault());
      c.addEventListener('drop', (e) => {
        e.preventDefault();
        const gun = e.dataTransfer.getData('text/plain');
        if (GUN_IDS.includes(gun)) { sel = i; apply(assignSlot(getLoadout(), i, gun)); render(); }
      });
      slots.appendChild(c);
    });
    const frag = card('frag', { slot: LOADOUT_SIZE + 1, compact: true });
    frag.classList.add('lk-slot', 'fixed');
    frag.disabled = true;
    slots.appendChild(frag);

    const armory = root.querySelector('#lk-armory');
    armory.innerHTML = '';
    for (const id of GUN_IDS) {
      const c = card(id);
      const at = loadout.indexOf(id);
      if (at >= 0) c.insertAdjacentHTML('afterbegin', `<span class="lk-equipped">SLOT ${at + 1}</span>`);
      c.classList.toggle('in-slot', at === sel);
      c.draggable = true;
      c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', id));
      c.addEventListener('click', () => { apply(assignSlot(getLoadout(), sel, id)); render(); });
      armory.appendChild(c);
    }
  }

  function open() {
    if (!root) build();
    render();
    root.classList.remove('hidden');
    root.querySelector('#locker-close').focus({ preventScroll: true });
    onOpen();
  }

  function close() {
    if (!root || root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    onClose();
  }

  return { open, close, isOpen: () => !!root && !root.classList.contains('hidden') };
}
