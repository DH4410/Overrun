import * as THREE from 'three';

import { applyGunSkin, buildGunModel } from './gunmodels.js';
import { gunIcons } from './gunicons.js';
import { assignSlot, DEFAULT_LOADOUT, GUN_IDS, LOADOUT_SIZE } from './loadout.js';
import { clamp } from './utils.js';
import { SKINS, skinInfo } from './rewards.js';
import { WEAPON_BY_ID } from './weapons.js';

/** How each gun is labelled in the locker: its class and a rarity colour. */
export const GUN_CARD = {
  pistol: { cls: 'SIDEARM', tier: 'common' },
  smg: { cls: 'SMG', tier: 'uncommon' },
  ar: { cls: 'ASSAULT', tier: 'rare' },
  shotgun: { cls: 'SHOTGUN', tier: 'epic' },
  sniper: { cls: 'MARKSMAN', tier: 'legendary' },
  revolver: { cls: 'HAND CANNON', tier: 'rare' },
  mp: { cls: 'AUTO PISTOL', tier: 'uncommon' },
  lmg: { cls: 'SUPPORT', tier: 'epic' },
  ashotgun: { cls: 'AUTO SHOTGUN', tier: 'epic' },
  dmr: { cls: 'DMR', tier: 'legendary' },
  frag: { cls: 'THROWABLE', tier: 'rare' },
};

/**
 * A slowly turning 3D view of one gun, drawn on its own canvas while the locker is open. It is the
 * same procedural model the first-person view and the bots use, in the finish you are wearing.
 */
function createPreview(canvas) {
  let r;
  try { r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { return null; }
  r.setPixelRatio(1);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f48, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(2.5, 3, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb4ff, 1.4);
  rim.position.set(-3, 1.2, -2.5);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 30);
  const pivot = new THREE.Group();
  scene.add(pivot);
  let model = null, raf = 0, last = 0, frame = 0;

  function fit() {
    const w = canvas.clientWidth || 600, h = canvas.clientHeight || 300;
    if (canvas.width !== w || canvas.height !== h) { r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
  }

  function show(id, skin) {
    if (model) { pivot.remove(model); model.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); }
    model = buildGunModel(id);
    applyGunSkin(model, skin);
    model.rotation.y = 0;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    model.position.sub(mid);
    pivot.add(model);
    fit();
    // Far enough that the whole gun, barrel to stock, fits across the view with a margin.
    const half = Math.max(size.z, size.y * 2.2, 0.15) / 2;
    const dist = (half / (Math.tan((cam.fov * Math.PI) / 360) * cam.aspect)) * 1.5;
    cam.position.set(dist, size.y * 0.08, 0);
    cam.lookAt(0, 0, 0);
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if ((frame++ & 1) === 1) return;                   // 30 fps is plenty for a turntable
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    fit();
    // Sweeps through a side-on view rather than spinning all the way round, which hides the profile.
    pivot.rotation.y = -0.5 + Math.sin(t / 2600) * 0.55 + dt * 0;
    r.render(scene, cam);
  }
  function start() { cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(loop); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  function dispose() { stop(); r.dispose(); r.forceContextLoss?.(); }
  return { show, start, stop, dispose };
}

/** The numbers under the preview: a bar for how it feels and the figure behind it. */
function gunFacts(w) {
  const rpm = Math.round(60 / w.cooldown);
  const perShot = w.pellets > 1 ? `${w.damage} × ${w.pellets}` : `${w.damage}`;
  return [
    ['DAMAGE', clamp((w.damage * w.pellets) / 110, 0.04, 1), perShot],
    ['FIRE RATE', clamp(1 / w.cooldown / 16, 0.04, 1), `${rpm} RPM`],
    ['ACCURACY', clamp(1 - w.rest / 0.085, 0.04, 1), ''],
    ['MOBILITY', clamp(1 - w.move / 0.034, 0.04, 1), ''],
    ['MAGAZINE', clamp(w.mag / 30, 0.04, 1), `${w.mag} / ${w.reserve}`],
    ['RELOAD', clamp(1 - w.reload / 3.2, 0.04, 1), `${w.reload.toFixed(1)} S`],
  ];
}

/**
 * The locker. Left: your four guns and the frag, as slots. Centre: the gun you are looking at,
 * turning, with its numbers and the finishes. Right: the armory. Pick a slot, then a gun (or drag
 * a gun onto a slot); a gun already carried swaps places. Hovering a gun previews it. Every change
 * is applied and saved at once, so there is nothing to confirm.
 */
export function createLocker({
  getLoadout, setLoadout, onOpen = () => {}, onClose = () => {},
  // Finishes: which is worn, how to wear another, and whether a given one is earned (and at what level).
  getSkin = () => 'stock', setSkin = () => {}, skinLevel = () => 1, skinOwned = () => true,
}) {
  let root = null, sel = 0, shown = 'pistol', preview = null;

  function build() {
    root = document.createElement('div');
    root.id = 'locker';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="lk-card">
        <div class="lk-head">
          <div><h2>LOCKER</h2><div class="lk-sub">Pick a slot, then a weapon. Keys 1-4 follow the slots; 5 is always the frag.</div></div>
          <div class="set-actions"><button id="locker-reset" type="button">RESET</button><button id="locker-close" type="button">DONE</button></div>
        </div>
        <div class="lk-body">
          <section class="lk-col lk-left"><div class="lk-label">LOADOUT</div><div class="lk-slots" id="lk-slots"></div></section>
          <section class="lk-col lk-stage">
            <div class="lk-view"><canvas id="lk-canvas"></canvas><div class="lk-tag" id="lk-tag"></div></div>
            <div class="lk-name-row"><h3 id="lk-gname"></h3><span id="lk-gcls"></span></div>
            <div class="lk-facts" id="lk-facts"></div>
            <div class="lk-label">FINISH <span>repaints every gun you carry</span></div>
            <div class="lk-skins" id="lk-skins"></div>
          </section>
          <section class="lk-col lk-right"><div class="lk-label">ARMORY <span>click to put it in the selected slot, or drag it onto one</span></div><div class="lk-armory" id="lk-armory"></div></section>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#locker-close').addEventListener('click', close);
    root.querySelector('#locker-reset').addEventListener('click', () => { apply([...DEFAULT_LOADOUT]); sel = 0; shown = getLoadout()[0]; render(); });
    addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.code === 'Escape') { e.stopPropagation(); close(); return; }
      const n = /^Digit([1-4])$/.exec(e.code);
      if (n) { sel = Number(n[1]) - 1; showGun(getLoadout()[sel]); render(); }
    });
  }

  const isOpen = () => !!root && !root.classList.contains('hidden');
  function apply(list) { setLoadout(list); }

  /** A small card: used for the slots and the armory. */
  function card(id, { slot = null } = {}) {
    const w = WEAPON_BY_ID[id];
    const meta = GUN_CARD[id] ?? { cls: '', tier: 'common' };
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `lk-gun tier-${meta.tier}`;
    el.dataset.gun = id;
    const img = gunIcons(getSkin())[id];
    el.innerHTML = `
      ${slot !== null ? `<span class="lk-key">${slot}</span>` : ''}
      <span class="lk-img">${img ? `<img alt="" src="${img}">` : ''}</span>
      <span class="lk-meta"><span class="lk-name">${w.name}</span><span class="lk-cls">${meta.cls}</span></span>`;
    return el;
  }

  function showGun(id) {
    shown = id;
    const w = WEAPON_BY_ID[id];
    const meta = GUN_CARD[id] ?? { cls: '', tier: 'common' };
    root.querySelector('#lk-gname').textContent = w.name;
    const cls = root.querySelector('#lk-gcls');
    cls.textContent = meta.cls;
    cls.className = `tier-${meta.tier}`;
    const at = getLoadout().indexOf(id);
    root.querySelector('#lk-tag').textContent = id === 'frag' ? 'ALWAYS ON KEY 5' : at >= 0 ? `EQUIPPED · SLOT ${at + 1}` : 'IN THE LOCKER';
    const facts = root.querySelector('#lk-facts');
    facts.textContent = '';
    if (!w.thrown) {
      for (const [label, v, text] of gunFacts(w)) {
        facts.insertAdjacentHTML('beforeend', `<div class="lk-stat"><i>${label}</i><b><em style="width:${Math.round(v * 100)}%"></em></b><u>${text}</u></div>`);
      }
    } else {
      facts.insertAdjacentHTML('beforeend', '<div class="lk-note">Cook it with G to set the fuse; a longer hold throws it further.</div>');
    }
    preview?.show(id, skinInfo(getSkin()));
  }

  function render() {
    const loadout = getLoadout();
    const slots = root.querySelector('#lk-slots');
    slots.innerHTML = '';
    loadout.forEach((id, i) => {
      const c = card(id, { slot: i + 1 });
      c.classList.add('lk-slot');
      c.classList.toggle('sel', i === sel);
      c.addEventListener('click', () => { sel = i; showGun(id); render(); });
      c.addEventListener('dragover', (e) => e.preventDefault());
      c.addEventListener('drop', (e) => {
        e.preventDefault();
        const gun = e.dataTransfer.getData('text/plain');
        if (GUN_IDS.includes(gun)) { sel = i; apply(assignSlot(getLoadout(), i, gun)); showGun(gun); render(); }
      });
      slots.appendChild(c);
    });
    const frag = card('frag', { slot: LOADOUT_SIZE + 1 });
    frag.classList.add('lk-slot', 'fixed');
    frag.addEventListener('click', () => showGun('frag'));
    slots.appendChild(frag);

    const skins = root.querySelector('#lk-skins');
    skins.innerHTML = '';
    for (const sk of SKINS) {
      const owned = skinOwned(sk.id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lk-skin';
      b.classList.toggle('on', getSkin() === sk.id);
      b.classList.toggle('locked', !owned);
      b.dataset.skin = sk.id;
      b.title = owned ? sk.name : `${sk.name} - reach level ${skinLevel(sk.id)}`;
      b.innerHTML = `<i style="background:${sk.swatch}"></i><span>${sk.name}</span>${owned ? '' : `<small>LVL ${skinLevel(sk.id)}</small>`}`;
      b.disabled = !owned;
      b.addEventListener('click', () => { setSkin(sk.id); showGun(shown); render(); });
      skins.appendChild(b);
    }

    const armory = root.querySelector('#lk-armory');
    armory.innerHTML = '';
    for (const id of GUN_IDS) {
      const c = card(id);
      const at = loadout.indexOf(id);
      if (at >= 0) c.insertAdjacentHTML('afterbegin', `<span class="lk-equipped">SLOT ${at + 1}</span>`);
      c.classList.toggle('in-slot', at === sel);
      c.classList.toggle('looking', id === shown);
      c.draggable = true;
      c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', id));
      c.addEventListener('mouseenter', () => { if (shown !== id) { showGun(id); armory.querySelectorAll('.lk-gun').forEach((x) => x.classList.toggle('looking', x === c)); } });
      c.addEventListener('click', () => { apply(assignSlot(getLoadout(), sel, id)); showGun(id); render(); });
      armory.appendChild(c);
    }
    // After a hover has moved the preview off your slot, the facts still describe what is shown.
    root.querySelector('#lk-tag').textContent = shown === 'frag' ? 'ALWAYS ON KEY 5' : loadout.includes(shown) ? `EQUIPPED · SLOT ${loadout.indexOf(shown) + 1}` : 'IN THE LOCKER';
  }

  function open() {
    if (!root) build();
    sel = Math.min(sel, LOADOUT_SIZE - 1);
    shown = getLoadout()[sel];
    root.classList.remove('hidden');
    preview?.dispose();
    preview = createPreview(root.querySelector('#lk-canvas'));
    render();
    showGun(shown);
    preview?.start();
    root.querySelector('#locker-close').focus({ preventScroll: true });
    onOpen();
  }

  function close() {
    if (!root || !isOpen()) return;
    root.classList.add('hidden');
    preview?.dispose();
    preview = null;
    onClose();
  }

  return { open, close, isOpen };
}
