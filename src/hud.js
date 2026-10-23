import * as THREE from 'three';

import { CONFIG, HIP_FOV, TEAM, TEAM_COLOR } from './config.js';
import { settings } from './settings.js';
import { clamp, rand } from './utils.js';
import { playerSpread } from './weapons.js';
import { hudIcons } from './gunicons.js';

/** HUD presentation and runtime UI state, isolated from gameplay ownership. */
export function createHud({
  player,
  bots,
  camera,
  match,
  weapons: WEAPONS,
  currentWeapon,
  losClear,
  isAiming,
  modeLabels: MODE_LABEL,
  setAppState,
  pausedState,
}) {
const $ = (id) => document.getElementById(id);
const el = {
  hud: $('hud'), menu: $('menu'), pause: $('pause'), board: $('board'),
  crosshair: $('crosshair'), scope: $('scope'), hitmarker: $('hitmarker'),
  hp: $('hpfill'), hptxt: $('hptxt'), ap: $('apfill'), aptxt: $('aptxt'), vname: $('v-name'),
  hpchip: $('hpchip'), apchip: $('apchip'),
  aname: $('a-name'), amag: $('a-mag'), ares: $('a-res'), areload: $('a-reload'), slots: $('slots'),
  tbMode: $('tb-mode'), tbA: $('tb-a'), tbB: $('tb-b'), tbTime: $('tb-time'),
  feed: $('feed'), plates: $('plates'), dmgwrap: $('dmgwrap'), lowhp: $('lowhp'),
  toast: $('toast'), bBody: $('b-body'), bTitle: $('b-title'), bSub: $('b-sub'),
  pBig: $('p-big'), pSm: $('p-sm'), pCta: $('p-cta'), loading: $('loading'), play: $('play'),
  nameInput: $('nameinput'), menuResult: $('menuresult'),
  dmgNums: $('dmgnums'), ammoPrompt: $('ammo-prompt'), allies: $('allies'),
  hitflash: $('hitflash'), vitals: $('vitals'), ammoPromptLabel: $('ammo-prompt-label'),
  killbanner: $('killbanner'), kbName: $('kb-name'),
};

let hitmarkerTimer = 0, toastTimer = 0;

/**
 * Weapon pictures for the kill feed and the slot strip. They are rendered from the real gun models
 * (gunicons.js), once, a moment after boot so the cost never lands in a match. Until then (or with
 * no WebGL to render them) a slot falls back to its number and a feed row to the gun's name.
 */
let iconsReady = false;
function icons() {
  if (!iconsReady) return {};
  return hudIcons();
}
setTimeout(() => {
  try { hudIcons(); iconsReady = true; updateAmmoHud(); } catch { /* no icons; the HUD falls back to text */ }
}, 2500);

const SVG_NS = 'http://www.w3.org/2000/svg';
function glyph(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `kf-${kind}`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', kind === 'hs'
    ? 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 4a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM8 0v3M8 13v3M0 8h3M13 8h3'
    : 'M8 1C4.7 1 2.5 3.3 2.5 6.2c0 1.7.8 3 2 3.9V13h1.6v-1.4h1v1.4h1.8v-1.4h1v1.4h1.6v-2.9c1.2-.9 2-2.2 2-3.9C13.5 3.3 11.3 1 8 1zM5.8 5.2a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zm4.4 0a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6z');
  svg.appendChild(path);
  return svg;
}


/**
 * The hitmarker, in three weights: a hit, a headshot, a kill. `kind` is 'body', 'head' or
 * 'kill' (true is accepted for 'kill'). Each has its own colour and size, so a headshot that
 * did not kill reads differently from one that did — which was the whole of the "I headshot
 * him and he didn't die, why?" confusion.
 */
function showHitMarker(kind, headshot = false) {
  const k = kind === true ? 'kill' : (kind || 'body');
  el.hitmarker.classList.toggle('kill', k === 'kill');
  el.hitmarker.classList.toggle('head', k === 'head');
  // A kill by headshot: the red ticks gain a gold ring and a pulse, so it reads at a glance.
  el.hitmarker.classList.toggle('hskill', k === 'kill' && !!headshot);
  el.hitmarker.style.opacity = '1';
  hitmarkerTimer = k === 'kill' ? 0.35 : 0.18;
}

/** Kill confirmation under the crosshair: who went down, and whether it was a headshot. */
function showKillBanner(target, headshot, medal = '', tags = []) {
  if (!el.killbanner) return;
  el.kbName.textContent = target.name;
  const label = document.getElementById('kb-label');
  if (label) label.textContent = medal || 'ELIMINATED';
  const tag = document.getElementById('kb-tag');
  const all = [...(headshot ? ['HEADSHOT'] : []), ...tags];
  if (tag) tag.textContent = all.join(' · ');
  el.killbanner.classList.toggle('medal', !!medal);
  el.killbanner.classList.toggle('headshot', all.length > 0);
  el.killbanner.classList.toggle('revenge', tags.includes('REVENGE'));
  if (headshot) flashHeadshot();
  el.killbanner.classList.remove('show');
  void el.killbanner.offsetWidth;            // restart the animation for back-to-back kills
  el.killbanner.classList.add('show');
}

const hsFlash = $('hsflash');
/** A short gold bloom at the screen's edge for a headshot kill. */
function flashHeadshot() {
  if (!hsFlash) return;
  hsFlash.classList.remove('on');
  void hsFlash.offsetWidth;
  hsFlash.classList.add('on');
}

/**
 * The streak counter under the score. `n` is the run in progress (0 hides it); `lost` is a run that
 * has just ended, which turns the counter red and leaves it up until you respawn instead of vanishing.
 */
function showStreak(n, lost = 0) {
  const box = $('streak');
  if (!box) return;
  const num = $('streak-n'), lbl = $('streak-l');
  box.classList.remove('bump', 'ended');
  if (n > 0) {
    num.textContent = n;
    lbl.textContent = n >= 10 ? 'GODLIKE' : n >= 7 ? 'UNSTOPPABLE' : n >= 5 ? 'RAMPAGE' : 'KILL STREAK';
    box.classList.add('on');
    void box.offsetWidth;
    box.classList.add('bump');
  } else if (lost > 0) {
    num.textContent = lost;
    lbl.textContent = 'STREAK ENDED';
    box.classList.add('on', 'ended');
  } else {
    box.classList.remove('on');
  }
}

function showToast(text) {
  el.toast.textContent = text;
  el.toast.style.opacity = '1';
  toastTimer = 1.6;
}

function showDamageDirection(sourcePos) {
  const worldAng = Math.atan2(sourcePos.x - camera.position.x, sourcePos.z - camera.position.z);
  // Bearing relative to where the camera is looking — world space would spin as you turn.
  const rel = (player.yaw + Math.PI) - worldAng;
  const d = document.createElement('div');
  d.className = 'dmg';
  d.style.transform = `rotate(${rel}rad)`;
  el.dmgwrap.appendChild(d);
  requestAnimationFrame(() => { d.style.opacity = '0'; });
  setTimeout(() => d.remove(), 900);

  // Screen-edge pulse as well: the arc tells you where, this tells you THAT you were hit even
  // if your eyes are on the far side of the screen.
  if (el.hitflash) {
    el.hitflash.style.transition = 'none';
    el.hitflash.style.opacity = '1';
    requestAnimationFrame(() => {
      el.hitflash.style.transition = 'opacity .35s ease-out';
      el.hitflash.style.opacity = '0';
    });
  }
}

/** Crosshair colour and gap are driven from settings via CSS custom properties. */
function applyCrosshairStyle() {
  const root = document.documentElement.style;
  root.setProperty('--xhair', settings.crosshairColor);
  root.setProperty('--xhair-gap', `${settings.crosshairGap}px`);
}

const _dmgProj = new THREE.Vector3();

/** Float the damage dealt above the point of impact, projected to screen space. */
function showDamageNumber(worldPos, amount, headshot, zone = 'body', armored = false, lethal = false) {
  if (!el.dmgNums || amount <= 0 || !settings.showDamageNumbers) return;
  _dmgProj.copy(worldPos).project(camera);
  if (_dmgProj.z > 1) return;                       // behind the camera
  const d = document.createElement('div');
  d.className = `dmg-num ${headshot ? 'head' : zone}${armored ? ' armored' : ''}${lethal ? ' kill' : ''}`;
  // Round up, never down: a hit that landed must never print as 0, and printing 8 for 8.6
  // made weapons feel weaker than they are.
  d.textContent = Math.max(1, Math.ceil(amount));
  // A little horizontal jitter so a shotgun's pellets do not stack into one unreadable blob.
  d.style.left = `${(_dmgProj.x * 0.5 + 0.5) * innerWidth + rand(-14, 14)}px`;
  d.style.top = `${(-_dmgProj.y * 0.5 + 0.5) * innerHeight}px`;
  el.dmgNums.appendChild(d);
  setTimeout(() => d.remove(), 800);
}

function makePlate(name, color) {
  const root = document.createElement('div');
  root.className = 'plate';
  const n = document.createElement('div');
  n.className = 'pn';
  n.textContent = name;
  n.style.color = `#${color.toString(16).padStart(6, '0')}`;
  const bar = document.createElement('div');
  bar.className = 'ph';
  const fill = document.createElement('i');
  fill.style.background = n.style.color;
  bar.appendChild(fill);
  root.append(n, bar);
  el.plates.appendChild(root);
  return { root, fill, bar };
}

/**
 * Ally markers. Unlike the enemy nameplates these are deliberately NOT gated on line of
 * sight — the whole point is knowing where your team is when you cannot see them. Markers for
 * allies outside the view are clamped to the screen edge and pointed at, the way squad markers
 * work in any team shooter.
 */
const _allyProj = new THREE.Vector3();
const allyMarks = new Map();

function updateAllyMarkers() {
  if (!el.allies) return;
  if (player.team === TEAM.SOLO) {
    for (const [, m] of allyMarks) m.root.style.display = 'none';
    return;
  }

  for (const b of bots) {
    if (b.team !== player.team) continue;
    let m = allyMarks.get(b);
    if (!m) {
      const root = document.createElement('div');
      root.className = 'ally-mark';
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '▲';
      const name = document.createElement('span');
      name.textContent = b.name;
      const hp = document.createElement('span');
      hp.className = 'ahp';
      const fill = document.createElement('i');
      hp.appendChild(fill);
      root.append(chev, name, hp);
      el.allies.appendChild(root);
      m = { root, fill };
      allyMarks.set(b, m);
    }
    if (!b.alive) { m.root.style.display = 'none'; continue; }

    _allyProj.set(b.pos.x, b.pos.y + 1.0, b.pos.z).project(camera);
    const behind = _allyProj.z > 1;
    let sx = (_allyProj.x * 0.5 + 0.5) * innerWidth;
    let sy = (-_allyProj.y * 0.5 + 0.5) * innerHeight;
    if (behind) { sx = innerWidth - sx; sy = innerHeight - 40; }

    const off = behind || sx < 40 || sx > innerWidth - 40 || sy < 40 || sy > innerHeight - 40;
    m.root.classList.toggle('off', off);
    m.root.style.display = '';
    m.root.style.left = `${clamp(sx, 40, innerWidth - 40)}px`;
    m.root.style.top = `${clamp(sy, 40, innerHeight - 60)}px`;
    m.fill.style.transform = `scaleX(${clamp(b.health / 100, 0, 1)})`;
  }
}

const _proj = new THREE.Vector3();
let plateLosTimer = 0;

function updatePlates(dt) {
  // A plate drawn for a bot behind a wall is an aimbot. Gate it on the same G_WORLD-masked
  // raycast the AI uses, refreshed a few times a second rather than every frame — one ray
  // per bot per frame is real cost, and a 0.15 s stale plate is imperceptible.
  plateLosTimer -= dt;
  const recheck = plateLosTimer <= 0;
  if (recheck) plateLosTimer = 0.15;

  for (const b of bots) {
    const p = b.plate;
    if (!b.alive) { p.root.style.display = 'none'; continue; }
    // A teammate already carries an ally marker with its name and health (updateAllyMarkers),
    // so a plate on top of it just printed the name twice.
    if (player.team !== TEAM.SOLO && b.team === player.team) { p.root.style.display = 'none'; continue; }
    // b.pos is the chest, so this lands a little above the top of the head at BOT_TARGET_HEIGHT.
    _proj.set(b.pos.x, b.pos.y + 0.95, b.pos.z).project(camera);
    // z > 1 means it is behind the near plane — otherwise the plate mirrors behind you.
    if (_proj.z > 1 || Math.abs(_proj.x) > 1.3) { p.root.style.display = 'none'; continue; }
    const d = b.pos.distanceTo(camera.position);
    if (d > 55) { p.root.style.display = 'none'; continue; }
    if (recheck) {
      // Sample three points up the body, not just the chest, and take the plate as visible if
      // ANY of them is clear.
      //
      // This is why nameplates seemed never to appear: a single chest ray is blocked by any
      // crate, railing or low wall a bot is standing behind — which is most of the time — so
      // a bot whose head and shoulders you can plainly see, and can shoot, had no plate.
      //
      // The ray also starts at the camera rather than player.eye. The plate is a screen-space
      // overlay projected from the camera, so the camera is the geometrically correct origin;
      // view bob, shake and the crouch offset make eye and camera disagree by enough to matter
      // when you are peeking a corner.
      const ox = camera.position.x, oy = camera.position.y, oz = camera.position.z;
      b.plateLos =
        losClear(ox, oy, oz, b.pos.x, b.pos.y + b.hb.headY, b.pos.z) ||
        losClear(ox, oy, oz, b.pos.x, b.pos.y, b.pos.z) ||
        losClear(ox, oy, oz, b.pos.x, b.pos.y - 0.30, b.pos.z);
    }
    if (!b.plateLos) { p.root.style.display = 'none'; continue; }
    p.root.style.display = '';
    p.root.style.left = `${(_proj.x * 0.5 + 0.5) * innerWidth}px`;
    p.root.style.top = `${(-_proj.y * 0.5 + 0.5) * innerHeight}px`;
    // THE reason plates read as sitting ON the head rather than above it: `top` places the
    // element's TOP edge at the projected point, so the whole plate then hangs downward over
    // the model. Pulling it up by its own height puts it where a nameplate belongs. Set
    // inline rather than in CSS so a UI restyle cannot silently drop it.
    p.root.style.transform = 'translateY(-100%)';
    p.root.style.opacity = String(clamp(1.15 - d / 55, 0.25, 1));

    // Enemy health is hidden by default: knowing exactly how close a target is to death is a
    // big information advantage, and the floating damage numbers already say how hard you hit.
    // Teammates still show a bar, because coordinating with them needs it.
    const friendly = player.team !== TEAM.SOLO && b.team === player.team;
    // An enemy you have just hit shows its health for a moment, so a hit that did not kill
    // says how close it came. It reveals nothing about anyone you have not shot.
    const justHit = b.lastHurtBy === player && match.time - (b.lastHurtAt ?? -99) < 2.5;
    const showBar = friendly || settings.showEnemyHealth || justHit;
    p.bar.style.display = showBar ? '' : 'none';
    if (showBar) p.fill.style.transform = `scaleX(${clamp(b.health / 100, 0, 1)})`;
    p.root.classList.toggle('hurt', showBar && b.health < 35);
  }
}

function updateVitals() {
  // Critical-health pulse is a class on the panel so the CSS animation owns the timing.
  el.vitals?.classList.toggle('low', player.alive && player.health < 35);
  el.vitals?.classList.toggle('mid', player.alive && player.health >= 35 && player.health < 65);
  // The chip behind each fill follows it down late (a CSS transition delay), so the chunk a
  // hit took stays visible for a moment; on the way up it hides behind the fill.
  const hp = `scaleX(${clamp(player.health / CONFIG.MAX_HEALTH, 0, 1)})`;
  const ap = `scaleX(${clamp(player.armor / CONFIG.MAX_ARMOR, 0, 1)})`;
  el.hp.style.transform = hp; el.hpchip.style.transform = hp;
  el.ap.style.transform = ap; el.apchip.style.transform = ap;
  el.vitals?.classList.toggle('noshield', player.armor <= 0);
  el.hptxt.textContent = Math.ceil(player.health);
  el.aptxt.textContent = Math.ceil(player.armor);
  el.lowhp.style.opacity = player.alive && player.health < 40
    ? String(clamp((40 - player.health) / 40, 0, 1)) : '0';
}

function updateAmmoHud() {
  const w = currentWeapon();
  el.aname.textContent = w.name;
  const ic = icons();
  const big = $('a-icon');
  if (big) {
    big.hidden = !ic[w.id];
    if (ic[w.id] && big.dataset.w !== w.id) { big.src = ic[w.id]; big.dataset.w = w.id; }
  }
  if (w.thrown) {
    el.amag.textContent = player.fragCount;
    el.ares.textContent = '∞';
  } else {
    const a = player.ammo[w.id];
    el.amag.textContent = a.mag;
    el.ares.textContent = a.reserve;
    // The count warns you before the click: amber at under a third of the magazine, red and pulsing at none.
    const box = $('ammo');
    if (box) {
      box.classList.toggle('low', a.mag > 0 && a.mag <= Math.max(1, Math.ceil(w.mag * 0.3)));
      box.classList.toggle('empty', a.mag === 0);
    }
  }
  if (w.thrown) $('ammo')?.classList.remove('low', 'empty');
  // Slot strip.
  el.slots.innerHTML = '';
  [...player.loadout, 'frag'].forEach((id, i) => {
    const wp = WEAPONS.find((w) => w.id === id);
    const d = document.createElement('div');
    d.title = wp.name;
    const n = Object.assign(document.createElement('b'), { textContent: i + 1 });
    d.appendChild(n);
    if (ic[wp.id]) {
      const g = document.createElement('img');
      g.alt = ''; g.src = ic[wp.id];
      d.appendChild(g);
    }
    if (wp.id === player.current) d.className = 'on';
    else if (wp.thrown ? player.fragCount <= 0 : player.ammo[wp.id].mag + player.ammo[wp.id].reserve <= 0) {
      d.className = 'empty';
    }
    el.slots.appendChild(d);
  });
}

/* ------------------------------ kill feed ------------------------------ */

function feedClass(c) {
  if (c === player) return 'me';
  if (player.team !== TEAM.SOLO && c && c.team === player.team) return 'al';
  return 'en';
}

function kfSpan(c, label) {
  const sp = document.createElement('span');
  sp.className = feedClass(c);
  sp.textContent = label;
  return sp;
}

/**
 * One row: KILLER [gun] [headshot] VICTIM. Names are coloured by what they are to you (you, your
 * team, the enemy) and the row's stripe says whose point it was, so in a team match you can tell
 * "we got one" from "they got one" without reading a name.
 */
function addKillFeed(source, target, headshot, weaponId = null) {
  const row = document.createElement('div');
  const killer = source && source !== target ? feedClass(source) : null;     // me | al | en | null (the world)
  const side = killer === 'me' || killer === 'al' ? 'good' : 'bad';
  const teamKill = killer && player.team !== TEAM.SOLO && source.team === target.team;
  row.className = `kf ${teamKill ? 'tk' : side}${source === player || target === player ? ' mine' : ''}${target === player ? ' died' : ''}`;
  const parts = [];
  if (killer) parts.push(kfSpan(source, source === player ? 'YOU' : source.name));
  const wId = weaponId ?? (source === player ? player.current : source?.weaponId);
  const img = killer && icons()[wId];
  if (img) {
    const gun = document.createElement('img');
    gun.className = 'kf-gun'; gun.alt = ''; gun.src = img;
    parts.push(gun);
  } else if (killer) {
    parts.push(Object.assign(document.createElement('span'), { className: 'arrow', textContent: '›' }));
  } else {
    parts.push(glyph('skull'));
  }
  if (headshot) parts.push(glyph('hs'));
  parts.push(kfSpan(target, target === player ? 'YOU' : target.name));
  row.append(...parts);
  el.feed.appendChild(row);
  while (el.feed.children.length > 5) el.feed.firstChild.remove();
  setTimeout(() => { row.style.opacity = '0'; }, 4200);
  setTimeout(() => row.remove(), 5000);
}

/* ----------------------------- scoreboard ----------------------------- */

function showBoard(on) { el.board.classList.toggle('on', !!on); if (on) refreshBoard(); }

function refreshBoard() {
  const order = (list) => list.slice().sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
  const everyone = [player, ...bots];
  const hex = (team) => `#${TEAM_COLOR[team].toString(16).padStart(6, '0')}`;
  const top = Math.max(1, ...everyone.map((c) => c.kills));
  el.bBody.innerHTML = '';

  const addRow = (c, rank) => {
    const tr = document.createElement('tr');
    tr.className = `${c === player ? 'self' : ''}${c.alive ? '' : ' down'}`.trim();
    tr.style.setProperty('--w', `${Math.round((c.kills / top) * 100)}%`);
    const kd = c.deaths === 0 ? c.kills.toFixed(2) : (c.kills / c.deaths).toFixed(2);
    // Use DOM construction so player names never execute as HTML.
    const tdRank = Object.assign(document.createElement('td'), { className: 'rk', textContent: rank });
    const tag = Object.assign(document.createElement('span'), { className: 'tag' });
    tag.style.background = hex(c.team);
    const tdName = document.createElement('td');
    tdName.className = 'nm';
    tdName.append(tag, c === player ? player.name : c.name);
    if (c === player) tdName.appendChild(Object.assign(document.createElement('em'), { textContent: 'YOU' }));
    const cell = (text, extra = '') => Object.assign(document.createElement('td'), { className: `num ${extra}`.trim(), textContent: text });
    tr.append(tdRank, tdName, cell(c.kills, 'k'), cell(c.deaths, 'd'), cell(kd, 'kd'));
    el.bBody.appendChild(tr);
  };

  if (match.mode === 'tdm' || match.mode === 'hp') {
    // Two blocks, yours first, each headed by its colour and its score.
    for (const team of [TEAM.BLUE, TEAM.RED]) {
      const members = order(everyone.filter((c) => c.team === team));
      const hdr = document.createElement('tr');
      hdr.className = `team ${team === TEAM.BLUE ? 'blue' : 'red'}`;
      const th = Object.assign(document.createElement('td'), { colSpan: 5 });
      th.append(Object.assign(document.createElement('b'), { textContent: team === TEAM.BLUE ? 'YOUR TEAM' : 'ENEMY TEAM' }),
        Object.assign(document.createElement('span'), { textContent: team === TEAM.BLUE ? match.scoreA : match.scoreB }));
      hdr.appendChild(th);
      el.bBody.appendChild(hdr);
      members.forEach((c, i) => addRow(c, i + 1));
    }
  } else {
    order(everyone).forEach((c, i) => addRow(c, i + 1));
  }
  el.bSub.textContent = match.mode === 'sv'
    ? `WAVE ${match.wave} · ${match.kills} KILLS`
    : `${MODE_LABEL[match.mode]} · ${match.diff.label}`;
}

function showPause(on) {
  el.pause.classList.toggle('on', !!on && match.running);
  if (on && match.running) { setAppState(pausedState); el.pBig.textContent = 'PAUSED'; el.pSm.textContent = ''; el.pCta.style.display = ''; }
}

function updateHudTimers(dt) {
  if (hitmarkerTimer > 0) {
    hitmarkerTimer -= dt;
    if (hitmarkerTimer <= 0) el.hitmarker.style.opacity = '0';
  }
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) el.toast.style.opacity = '0';
  }
  if (player.reloading > 0) {
    const p = Math.round((1 - player.reloading / player.reloadTotal) * 100);
    el.areload.textContent = `RELOADING ${p}%`;
    el.areload.classList.add('bar');
    el.areload.style.setProperty('--p', `${p}%`);
  } else if (player.cooking) {
    const pct = Math.round(clamp(player.chargeTime / CONFIG.THROW_CHARGE_TIME, 0, 1) * 100);
    el.areload.textContent = `${player.cooking.toUpperCase()} POWER ${pct}%`;
    el.areload.classList.add('bar');
    el.areload.style.setProperty('--p', `${pct}%`);
  } else {
    const w = currentWeapon();
    const a = !w.thrown && player.ammo[w.id];
    el.areload.textContent = (a && a.mag === 0) ? 'PRESS R' : '';
    el.areload.classList.remove('bar');
  }
  updateCrosshairSpread();
  updateVitals();
}

/**
 * Open the crosshair to match the live firing cone.
 *
 * Without this the accuracy model is invisible: the player is punished for moving, jumping
 * and spraying with no indication it is happening, which reads as the gun being random
 * rather than as a rule they can play around. The gap is the settings gap plus the cone
 * converted to pixels, so the crosshair is a live read-out of where a round can land.
 */
function updateCrosshairSpread() {
  const w = currentWeapon();
  if (w && el.crosshair.dataset.w !== w.id) el.crosshair.dataset.w = w.id;
  if (!w || w.thrown || w.rest === undefined) return;
  const planar = Math.hypot(player.body.velocity.x, player.body.velocity.z);
  const cone = playerSpread(w, {
    speed: planar,
    grounded: player.grounded,
    aiming: isAiming(),
    crouching: player.crouching,
    bloom: player.bloom ?? 0,
  });
  // Half the vertical FOV maps to half the viewport height, so radians convert to pixels
  // through the same projection the world is drawn with.
  const pxPerRad = (window.innerHeight * 0.5) / Math.tan((HIP_FOV * Math.PI) / 360);
  const gap = settings.crosshairGap + Math.min(90, cone * pxPerRad);
  document.documentElement.style.setProperty('--xhair-gap', `${gap.toFixed(1)}px`);
}

return {
  getElement: $,
  el,
  showHitMarker,
  showKillBanner,
  showStreak,
  showToast,
  showDamageDirection,
  applyCrosshairStyle,
  showDamageNumber,
  makePlate,
  updateAllyMarkers,
  allyMarks,
  updatePlates,
  updateVitals,
  updateAmmoHud,
  addKillFeed,
  showBoard,
  refreshBoard,
  showPause,
  updateHudTimers,
};
}
