import * as THREE from 'three';

import { CONFIG, TEAM, TEAM_COLOR } from '../config.js';
import { MODE_LABEL } from '../match.js';
import { aimDirection } from '../sim/combat.js';
import { MAP_DATA, MAP_IDS } from '../sim/mapData.js';
import {
  BTN, BUDGET, CHARACTER_IDS, CLOSE, EMOTE_IDS, EV, HIT_BREAK, HIT_LETHAL, HIT_SHIELD, MAX_CMDS_PER_PACKET,
  NO_ID, PHASE, PROTOCOL_VERSION, TICK_HZ, WEAPON_IDS, ZONE_IDS, encodeInput, mapHash, quantPitch, quantYaw,
  readSnapshot,
} from '../sim/protocol.js';
import { WEAPONS, WEAPON_BY_ID } from '../sim/weaponData.js';
import { Predictor } from './predict.js';

/**
 * The browser side of multiplayer. The server owns the match; this connects to it, turns the
 * player's input into 120 Hz commands (sent 20 times a second, and not at all while idle),
 * predicts the player's own movement and weapons with the server's own code, and draws everyone
 * else 100-150 ms in the past from the snapshots. Single player never touches it: main.js only
 * routes the frame here while `active`.
 *
 * Everything it drives in the rest of the game comes in through `d` (see main.js).
 */

const STEP = 1 / TICK_HZ;
const MAX_TICKS_PER_FRAME = 30;     // a longer stall drops ticks; the server repeats, we reconcile
const SNAP_DIST = 1;                // m: a correction this big is a teleport, not something to blend
const BLEND_RATE = 30;              // 1/s: a correction is ~95% gone in 100 ms
const INTERP_MIN = 0.1, INTERP_MAX = 0.15, EXTRAP_MAX = 0.1;   // s
const SNAP_KEEP = 30;               // snapshots kept for interpolation (1.5 s)
const SHOT_SHOW = 0.3;              // s a puppet keeps its gun up after a shot
const TOKEN_KEY = 'overrun-mp-token';
const CHAR_KEY = 'overrun-mp-character';

const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);
const wrapAngle = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function storage(kind) {
  try { return window[kind]; } catch { return null; }
}

/** `?lag=<ms round trip>&jitter=<ms>&loss=<percent>`, honoured on a local host only. */
function lagParams() {
  if (!['localhost', '127.0.0.1', ''].includes(location.hostname)) return null;
  const q = new URLSearchParams(location.search);
  const lag = Number(q.get('lag')) || 0, jitter = Number(q.get('jitter')) || 0, loss = Number(q.get('loss')) || 0;
  return lag || jitter || loss ? { lag, jitter, loss: loss / 100 } : null;
}

export function createNetClient(d) {
  const { player, bots, el, Audio, camera, keys } = d;
  const lag = lagParams();
  const lanes = { in: 0, out: 0 };

  let active = false;
  let ws = null;
  let colliders = null, hash = null;
  let wantSpectate = false, leaving = false, welcomed = false, retries = 0, retryTimer = null;
  let myId = null, spectator = false;
  let reconSnap = null, reconSpawn = false;   // the newest snapshot not yet reconciled
  const roster = new Map();         // id -> { name, character, team, loadout }
  let phase = 0, mode = 'dm', mapId = null, timeLeft = 0, scoreA = 0, scoreB = 0;
  let inputRate = 20, budgetFlags = 0;
  let pred = null, started = false;
  let seq = 0, lastSent = null, sentAt = 0, tickAcc = 0;
  const pending = [];
  let selected = null, reloadLatch = false;
  let rtt = 0;
  let clockOffset = null, interp = INTERP_MIN;
  const lateness = [];
  const snaps = [];                 // { tick, players: Map, grenades: Map }
  let latest = null;
  const puppets = new Map();        // id -> Bot
  const lastShot = new Map();       // id -> performance.now() of their last shot
  const grenadeMeshes = new Map();
  const seenSmokes = new Set();
  let killerId = null;
  let specTarget = null, freeCam = false;
  const freePos = new THREE.Vector3();
  let wasAlive = false, ammoSig = '', stepTimer = 0, lastReloadFrom = 0;
  let voteMode = null, voteMap = null, endInfo = null;
  let debugOn = new URLSearchParams(location.search).has('netdebug');
  const stats = { snaps: 0, bytes: 0, corrections: 0, resyncs: 0, snapped: 0, lastErr: 0, packets: 0, cmds: 0 };

  const offset = new THREE.Vector3();        // predicted-to-drawn smoothing, decays to zero
  const predPrev = new THREE.Vector3();      // predicted body before the latest tick
  const _render = new THREE.Vector3(), _before = new THREE.Vector3(), _dir = new THREE.Vector3();
  const _org = new THREE.Vector3(), _mz = new THREE.Vector3(), _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const moveIn = { ix: 0, iz: 0, crouch: false, sprint: false, aiming: false, jump: false };

  /* ------------------------------------------------------------- overlays */

  const ui = (() => {
    const make = (id, cls = '') => {
      const n = document.createElement('div');
      n.id = id; if (cls) n.className = cls;
      document.body.appendChild(n);
      return n;
    };
    return { status: make('mp-status'), debug: make('mp-debug'), end: make('mp-end') };
  })();

  function setStatus(text) {
    ui.status.textContent = text || '';
    ui.status.classList.toggle('on', !!text);
  }

  /* ------------------------------------------------------------ transport */

  function deliver(lane, fn) {
    if (!lag) { fn(); return; }
    if (lag.loss && Math.random() < lag.loss) return;
    const at = Math.max(lanes[lane], Date.now() + lag.lag / 2 + Math.random() * lag.jitter);
    lanes[lane] = at;
    setTimeout(fn, at - Date.now());
  }

  function send(data) {
    const sock = ws;
    if (!sock) return;
    deliver('out', () => { if (sock.readyState === 1) sock.send(data); });
  }
  const sendJson = (m) => send(JSON.stringify(m));

  async function loadColliders() {
    if (colliders) return;
    const list = await Promise.all(MAP_IDS.map(async (id) => {
      const r = await fetch(`./assets/maps/${id}.json`);
      if (!r.ok) throw new Error(`${id}.json ${r.status}`);
      return [id, await r.json()];
    }));
    colliders = Object.fromEntries(list);
    hash = mapHash(colliders, MAP_DATA, CONFIG, WEAPONS);
  }

  function character() {
    const ss = storage('sessionStorage');
    let c = ss?.getItem(CHAR_KEY);
    const loaded = d.loadedCharacters().filter((id) => CHARACTER_IDS.includes(id));
    if (!c || !CHARACTER_IDS.includes(c)) {
      c = loaded.length ? loaded[Math.floor(Math.random() * loaded.length)] : CHARACTER_IDS[0];
      try { ss?.setItem(CHAR_KEY, c); } catch { /* private mode */ }
    }
    return c;
  }

  function connect() {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      if (sock !== ws) return;
      sendJson({
        t: 'hello', v: PROTOCOL_VERSION, hash, name: player.name, character: character(),
        loadout: player.loadout, token: storage('sessionStorage')?.getItem(TOKEN_KEY) ?? undefined,
        spectate: wantSpectate,
      });
    };
    sock.onmessage = (e) => deliver('in', () => { if (sock === ws) onMessage(e.data); });
    sock.onclose = (e) => { if (sock === ws) deliver('in', () => onClose(e.code, e.reason)); };
  }

  let refusal = null;
  function onClose(code, reason) {
    ws = null;
    if (!active || leaving) return;
    const why = refusal ?? reason;
    if (code === CLOSE.REFRESH) { finish(why || 'A new version of the game is out. Refresh to update.'); return; }
    if (code === CLOSE.FULL || code === CLOSE.CLOSED || code === CLOSE.KICKED) { finish(why || 'Disconnected.'); return; }
    if (!welcomed) { finish(why || 'Could not reach the multiplayer server.'); return; }
    // Anything else is the network: try again a few times, holding the seat with the token.
    if (retries >= 5) { finish('Lost the connection to the server.'); return; }
    retries++;
    setStatus(`CONNECTION LOST — RECONNECTING (${retries}/5)…`);
    retryTimer = setTimeout(() => { retryTimer = null; if (active) connect(); }, 600 * retries);
  }

  function onMessage(data) {
    if (typeof data !== 'string') { onSnapshot(data); return; }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'welcome': onWelcome(m); break;
      case 'roster': setRoster(m.players); break;
      case 'match': onMatch(m); break;
      case 'end': onEnd(m); break;
      case 'votes': if (endInfo) { endInfo.votes = m.votes; drawEnd(); } break;
      case 'closed': refusal = m.reason; break;
      case 'error': refusal = m.reason; break;
      default: break;
    }
  }

  /* ---------------------------------------------------------- the session */

  async function join({ spectate = false } = {}) {
    if (active) return;
    active = true; leaving = false; welcomed = false; retries = 0; refusal = null;
    wantSpectate = spectate;
    player.name = (el.nameInput.value || 'PLAYER').toUpperCase().slice(0, 12);
    d.onEnter();
    setStatus('CONNECTING…');
    try {
      await loadColliders();
    } catch {
      finish('Could not load the maps. Check your connection.');
      return;
    }
    if (active) connect();
  }

  function onWelcome(m) {
    retries = 0; refusal = null; welcomed = true;
    myId = m.id; spectator = m.spectator;
    try { if (m.token) storage('sessionStorage')?.setItem(TOKEN_KEY, m.token); } catch { /* private mode */ }
    setRoster(m.roster);
    applyMatchInfo(m);
    seq = 0; lastSent = null; pending.length = 0; tickAcc = 0; started = false;
    snaps.length = 0; clockOffset = null; latest = null; reconSnap = null; reconSpawn = false;
    if (spectator) {
      pred = null;
      player.alive = false;
      document.body.classList.add('mp-spec');
      freePos.copy(camera.position);
      if (m.full) d.showToast('SERVER FULL — SPECTATING');
    } else {
      document.body.classList.remove('mp-spec');
      const me = roster.get(myId);
      pred = new Predictor(me?.loadout ?? player.loadout);
      pred.setMap(mapId, colliders[mapId], MAP_DATA[mapId].half);
      selected = pred.p.loadout[0];
      setStatus(null);
    }
    if (m.phase === PHASE.INTERMISSION) onEnd({ ...m, title: 'INTERMISSION', detail: '', standings: [] });
  }

  function applyMatchInfo(m) {
    mode = m.mode; phase = m.phase; timeLeft = m.timeLeft;
    if (m.roster) setRoster(m.roster);
    switchToMap(m.map);
  }

  function switchToMap(id) {
    if (!MAP_DATA[id]) return;
    if (id !== mapId) {
      mapId = id;
      if (d.getCurrentMapId() !== id) {
        d.switchMap(id);
        d.clearSmoke();
        seenSmokes.clear();
      }
    }
    pred?.setMap(id, colliders[id], MAP_DATA[id].half);
  }

  function onMatch(m) {
    applyMatchInfo(m);
    endInfo = null;
    ui.end.classList.remove('on');
    el.feed.innerHTML = '';
    d.clearSmoke();
    seenSmokes.clear();
    Audio.roundStart();
    if (!d.isPointerLocked()) showPause(true, 'NEXT ROUND');
  }

  function onEnd(m) {
    phase = PHASE.INTERMISSION;
    timeLeft = m.timeLeft;
    endInfo = m;
    voteMode = voteMode && m.modes?.includes(voteMode) ? voteMode : null;
    voteMap = voteMap && m.maps?.includes(voteMap) ? voteMap : null;
    document.exitPointerLock?.();
    el.pause.classList.remove('on', 'dead');
    drawEnd();
    ui.end.classList.add('on');
  }

  const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: String(text) });

  function drawEnd() {
    const m = endInfo;
    if (!m) return;
    ui.end.textContent = '';
    const card = document.createElement('div');
    card.className = 'mpe-card';
    const h = document.createElement('h2');
    h.textContent = m.title;
    card.append(h, span('mpe-sub', m.detail || ''));
    const table = document.createElement('div');
    table.className = 'mpe-rows';
    (m.standings || []).forEach((r, i) => {
      const row = document.createElement('div');
      row.className = `mpe-row${r.id === myId ? ' self' : ''}`;
      const tag = span('tag', '');
      tag.style.background = `#${TEAM_COLOR[r.team].toString(16).padStart(6, '0')}`;
      row.append(span('n', `#${i + 1}`), tag, span('nm', r.name), span('k', `${r.kills} K · ${r.deaths} D`));
      table.appendChild(row);
    });
    card.appendChild(table);
    if (m.lastRound) card.appendChild(span('mpe-warn', 'The free daily budget is nearly used up: that was the last round today.'));
    else if (myId !== null && !spectator) {
      const votes = m.votes || { modes: {}, maps: {} };
      const group = (label, ids, counts, pickedId, names, onPick) => {
        const g = document.createElement('div');
        g.className = 'mpe-vote';
        g.appendChild(span('lbl', label));
        for (const id of ids) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = id === pickedId ? 'on' : '';
          b.append(span('vn', names(id)), span('vc', counts[id] ?? 0));
          b.addEventListener('click', () => { onPick(id); castVote(); });
          g.appendChild(b);
        }
        return g;
      };
      card.append(
        group('MODE', m.modes || ['dm', 'tdm'], votes.modes, voteMode, (id) => MODE_LABEL[id] ?? id, (id) => { voteMode = id; }),
        group('MAP', m.maps || MAP_IDS, votes.maps, voteMap, (id) => id.toUpperCase(), (id) => { voteMap = id; }),
      );
    }
    const t = span('mpe-time', '');
    t.dataset.role = 'time';
    card.appendChild(t);
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'mpe-leave';
    leave.textContent = 'LEAVE';
    leave.addEventListener('click', () => leaveMatch());
    card.appendChild(leave);
    ui.end.appendChild(card);
    tickEndTimer();
  }

  function tickEndTimer() {
    const t = ui.end.querySelector('[data-role=time]');
    if (t) t.textContent = `NEXT ROUND IN ${Math.max(0, Math.ceil(timeLeft))}s · ties are settled at random`;
  }

  function castVote() {
    sendJson({ t: 'vote', mode: voteMode ?? mode, map: voteMap ?? mapId });
    drawEnd();
  }

  /** Leave for the lobby; `message` explains why when it was not the player's choice. */
  function finish(message = '') {
    if (!active) return;
    leaving = true;
    active = false;
    clearTimeout(retryTimer); retryTimer = null;
    const sock = ws;
    ws = null;
    try { sock?.close(1000, 'leave'); } catch { /* gone */ }
    for (const id of [...puppets.keys()]) removePuppet(id);
    for (const g of grenadeMeshes.values()) d.scene.remove(g);
    grenadeMeshes.clear();
    seenSmokes.clear();
    lastShot.clear();
    roster.clear();
    snaps.length = 0; latest = null; reconSnap = null; reconSpawn = false;
    pred = null; started = false; myId = null; spectator = false; endInfo = null;
    ui.end.classList.remove('on');
    setStatus(null);
    ui.debug.classList.remove('on');
    document.body.classList.remove('mp-spec');
    offset.set(0, 0, 0);
    d.onLeave(message);
  }

  function leaveMatch() { finish(''); }

  /**
   * The pause overlay. Multiplayer cannot pause the world, so this only offers the way back
   * in (and the pause menu); the vote screen and the death screen keep it to themselves.
   */
  function showPause(on, big = 'PAUSED') {
    if (!active) return;
    if (on) {
      d.setPaused();
      if (endInfo || (!spectator && pred && !player.alive)) return;
      el.pause.classList.add('on');
      el.pause.classList.remove('dead');
      el.pBig.textContent = big; el.pSm.textContent = ''; el.pCta.style.display = '';
    } else if (spectator || player.alive) {
      el.pause.classList.remove('on');
    }
  }

  /* ------------------------------------------------------------- roster */

  function setRoster(list) {
    if (!Array.isArray(list)) return;
    const ids = new Set();
    for (const r of list) {
      ids.add(r.id);
      roster.set(r.id, r);
    }
    for (const id of [...roster.keys()]) if (!ids.has(id)) roster.delete(id);
    for (const id of [...puppets.keys()]) if (!roster.has(id)) removePuppet(id);
  }

  function removePuppet(id) {
    const b = puppets.get(id);
    if (!b) return;
    puppets.delete(id);
    b.dispose();
    const i = bots.indexOf(b);
    if (i >= 0) bots.splice(i, 1);
    const mark = d.allyMarks.get(b);
    if (mark) { mark.root.remove(); d.allyMarks.delete(b); }
  }

  function puppetFor(id, team) {
    const r = roster.get(id);
    if (!r) return null;
    let b = puppets.get(id);
    if (b && (b.team !== team || b.characterId !== r.character)) { removePuppet(id); b = null; }
    if (!b) {
      b = new d.Bot(r.name, team, d.match.diff, null, { character: r.character, puppet: true });
      b.characterId = r.character;
      b.netId = id;
      puppets.set(id, b);
      bots.push(b);
    }
    return b;
  }

  /** Whoever an id is, as the HUD wants them: the player, a puppet, or a name and a team. */
  function who(id) {
    if (id === NO_ID || id === undefined) return null;
    if (id === myId) return player;
    return puppets.get(id) ?? { name: roster.get(id)?.name ?? '?', team: roster.get(id)?.team ?? TEAM.SOLO };
  }

  /* ------------------------------------------------------------ snapshots */

  function onSnapshot(buf) {
    let s;
    try { s = readSnapshot(buf); } catch { return; }
    if (!s) return;
    stats.snaps++; stats.bytes += buf.byteLength;
    phase = s.phase; mode = s.mode; timeLeft = s.timeLeft; scoreA = s.scoreA; scoreB = s.scoreB;
    inputRate = s.inputRate || 20; budgetFlags = s.budgetFlags;
    if (MAP_IDS[s.map] && MAP_IDS[s.map] !== mapId) switchToMap(MAP_IDS[s.map]);
    if (s.you && s.echoClientTime) rtt = ((Date.now() & 0xffff) - s.echoClientTime - s.echoAge + 0x10000) & 0xffff;

    // The clock: the least-delayed snapshot says how far ahead the server is; how late the rest
    // run sets the interpolation delay.
    const nowT = performance.now() / 1000 * TICK_HZ;
    const cand = s.tick - nowT;
    if (clockOffset === null || cand > clockOffset || clockOffset - cand > TICK_HZ * 2) clockOffset = cand;
    lateness.push(clockOffset - cand);
    if (lateness.length > 60) lateness.shift();

    const players = new Map();
    for (const q of s.players) players.set(q.id, q);
    const grenades = new Map();
    for (const g of s.grenades) grenades.set(g.id, g);
    snaps.push({ tick: s.tick, players, grenades });
    if (snaps.length > SNAP_KEEP) snaps.shift();
    latest = s;

    const mine = players.get(myId);
    if (mine) {
      player.kills = mine.kills; player.deaths = mine.deaths;
      if (player.team !== mine.team) setMyTeam(mine.team);
    }

    // Reconciling replays ticks, so it runs once a frame on the newest snapshot (see update);
    // a backlog of snapshots after a stall must not each pay for a replay.
    if (s.you) {
      if (s.events.some((e) => e.kind === EV.SPAWN && e.id === myId)) reconSpawn = true;
      reconSnap = s;
    }
    for (const e of s.events) onEvent(e, s);

    // Pickups the server says are there.
    d.ammoChests.forEach((c, i) => setAvailable(c, (s.chestMask >> i) & 1, 26));
    d.consumables.forEach((c, i) => setAvailable(c, (s.consumableMask >> i) & 1, 18));
    // Smokes are spawned once, when first seen; the effect runs its own lifetime.
    const live = new Set();
    for (const sm of s.smokes) {
      live.add(sm.id);
      if (!seenSmokes.has(sm.id)) { seenSmokes.add(sm.id); d.spawnSmoke(v3(sm.pos), null); }
    }
    for (const id of seenSmokes) if (!live.has(id)) seenSmokes.delete(id);
  }

  function setMyTeam(team) {
    player.team = team;
    d.playerBlip.traverse((o) => { if (o.material) o.material.color.setHex(TEAM_COLOR[team]); });
  }

  function setAvailable(c, on, intensity) {
    if (!on && c.cooldown <= 0) { c.cooldown = 1e9; c.mesh.visible = false; c.emitter.intensity = 0; }
    else if (on && c.cooldown > 0) { c.cooldown = 0; c.mesh.visible = true; c.emitter.intensity = intensity; }
  }

  function reconcile(s, spawned) {
    if (!pred || !s.you) return;
    pred.setMap(mapId, colliders[mapId], MAP_DATA[mapId].half);
    if (!started) {
      pred.apply(s.you);
      started = true;
      tickAcc = 0;
      offset.set(0, 0, 0);
      predPrev.copy(pred.p.body.position);
      if (s.you.alive) faceSpawn(s.you);
      return;
    }
    if (spawned) {
      pred.clear();
      selected = pred.p.loadout[0];
      faceSpawn(s.you);
    }
    const aliveBefore = pred.p.alive, replays = pred.stats.replays, resyncs = pred.stats.resyncs;
    _before.copy(pred.p.body.position);
    const err = pred.reconcile(s, s.phase === PHASE.PLAYING);
    if (pred.stats.replays === replays && pred.stats.resyncs === resyncs) return;      // agreed
    const after = pred.p.body.position;
    if (pred.stats.resyncs !== resyncs) stats.resyncs++;
    else { stats.corrections++; stats.lastErr = err; }
    if (spawned || aliveBefore !== pred.p.alive || err > SNAP_DIST) {
      offset.set(0, 0, 0);
      predPrev.copy(after);
      stats.snapped++;
    } else {
      // Keep what is drawn where it was and let the offset carry it over to the new path.
      offset.x += _before.x - after.x; offset.y += _before.y - after.y; offset.z += _before.z - after.z;
      predPrev.x += after.x - _before.x; predPrev.y += after.y - _before.y; predPrev.z += after.z - _before.z;
    }
  }

  /** Face the middle of the arena on a fresh life, as single player does. */
  function faceSpawn(y) {
    player.yaw = Math.atan2(y.px, y.pz);
    player.pitch = 0;
  }

  function onEvent(e, s) {
    switch (e.kind) {
      case EV.SHOT: {
        if (e.shooter === myId) break;     // already drawn when it was predicted
        lastShot.set(e.shooter, performance.now());
        const b = puppets.get(e.shooter);
        const w = WEAPON_BY_ID[e.weapon];
        if (b && w && !w.thrown) d.fireWeapon(b, w, v3(e.o), v3(e.d), 1);
        break;
      }
      case EV.HIT: {
        const p = v3(e.p);
        const zone = ZONE_IDS[e.zone] ?? 'body', head = zone === 'head';
        const lethal = (e.flags & HIT_LETHAL) !== 0;
        const shield = e.flags & HIT_BREAK ? 'break' : (e.flags & HIT_SHIELD ? 'hit' : null);
        if (e.attacker === myId && e.victim !== myId) {
          if (!lethal) {
            d.showHitMarker(head ? 'head' : 'body');
            if (shield === 'break') Audio.shieldBreak();
            else if (shield) Audio.shieldHit();
            if (head) Audio.headshot();
            else if (!shield) Audio.hit(player.current);
          }
          d.showDamageNumber(p, e.dmg, head, zone, !!shield, lethal);
          const b = puppets.get(e.victim);
          if (b) { b.lastHurtBy = player; b.lastHurtAt = d.match.time; }
        }
        if (e.victim === myId) {
          if (shield === 'break') Audio.shieldBreak(true);
          else if (shield) Audio.shieldHit(true);
          else Audio.hurt();
          const src = s.players.find((q) => q.id === e.attacker);
          if (src && e.attacker !== myId) d.showDamageDirection(src.pos);
          d.addShake(0.035);
        }
        if (!shield) d.spawnBlood(p);
        break;
      }
      case EV.KILL: {
        const killer = who(e.killer), victim = who(e.victim);
        if (victim) d.addKillFeed(killer, victim, e.head);
        if (e.killer === myId && e.victim !== myId && victim) {
          d.showHitMarker('kill');
          d.showKillBanner(victim, e.head);
          if (e.head) Audio.headshot?.();
          Audio.kill();
        }
        if (e.victim === myId) killerId = e.killer !== myId ? e.killer : null;
        break;
      }
      case EV.EXPLODE: {
        const p = v3(e.p);
        d.spawnExplosion(p);
        Audio.explosion(p);
        const camDist = camera.position.distanceTo(p);
        if (camDist < 10) d.addShake(0.10 * (1 - camDist / 10));
        break;
      }
      case EV.PICKUP:
        if (e.who === myId) {
          Audio.pickup();
          const c = e.what === 1 ? d.consumables[e.index] : null;
          d.showToast(c ? `+${c.spec.amount} ${c.spec.label}` : 'AMMO RESUPPLIED');
        }
        break;
      default: break;
    }
  }

  /* --------------------------------------------------------- your player */

  const fx = {
    fire(p, w, cone) {
      const cw = WEAPON_BY_ID[w.id];
      aimDirection(p, _dir);
      // From the muzzle on screen, as single player does, so the tracer leaves the barrel.
      const mz = d.vmModels[w.id]?.userData.muzzle;
      _org.copy(camera.position);
      if (mz) {
        mz.getWorldPosition(_mz);
        _org.copy(_mz).applyQuaternion(camera.quaternion).add(camera.position);
        if (!d.losClear(camera.position.x, camera.position.y, camera.position.z, _org.x, _org.y, _org.z)) _org.copy(camera.position);
        d.triggerMuzzleFlash(_mz, _org);
        d.ejectBrass(_mz.clone().add(new THREE.Vector3(0.05, 0.02, 0.12)));
      }
      d.fireWeapon(player, cw, _org, _dir, 1, cone);
      d.addViewModelRecoil(cw.kick ?? 0);
    },
  };

  function buildCmd() {
    const p = pred.p;
    const L = lastSent;
    const weapon = WEAPON_IDS.indexOf(selected ?? p.current);
    if (!p.alive) {
      // Dead: nothing held, so nothing carries over into the next life.
      return { ix: 0, iz: 0, yawQ: L?.yawQ ?? 0, pitchQ: L?.pitchQ ?? 0, buttons: 0, weapon: L?.weapon ?? weapon, emote: 0 };
    }
    d.readMoveInput(moveIn);
    let buttons = 0;
    if (d.isFiring() || d.takeFireLatch()) buttons |= BTN.FIRE;
    if (d.isAiming()) buttons |= BTN.AIM;
    if (moveIn.crouch) buttons |= BTN.CROUCH;
    if (moveIn.sprint) buttons |= BTN.SPRINT;
    if (moveIn.jump) buttons |= BTN.JUMP;
    if (reloadLatch) { buttons |= BTN.RELOAD; reloadLatch = false; }
    if (keys.KeyG) buttons |= BTN.FRAG;
    if (keys.KeyF) buttons |= BTN.SMOKE;
    const emote = Math.max(0, EMOTE_IDS.indexOf(d.emotes.active ?? null));
    // While dancing the mouse orbits the camera, so the body keeps the yaw it started with.
    const yawQ = emote && L ? L.yawQ : quantYaw(player.yaw);
    return { ix: moveIn.ix, iz: moveIn.iz, yawQ, pitchQ: quantPitch(player.pitch), buttons, weapon, emote };
  }

  function tickOnce() {
    const cmd = buildCmd();
    const L = lastSent;
    // Idle: nothing pressed, and the same as the last command sent, which the server is
    // already repeating. Nothing goes out until something changes.
    const idle = L && !cmd.ix && !cmd.iz && !cmd.buttons && !L.ix && !L.iz && !L.buttons
      && L.yawQ === cmd.yawQ && L.pitchQ === cmd.pitchQ && L.weapon === cmd.weapon && L.emote === cmd.emote;
    predPrev.copy(pred.p.body.position);
    if (!idle) { seq++; pending.push(cmd); lastSent = cmd; }
    pred.tick(cmd, idle ? null : seq, phase === PHASE.PLAYING, fx);
    d.stepBullets(STEP);
  }

  function renderTick() {
    if (clockOffset === null) return latest?.tick ?? 0;
    return performance.now() / 1000 * TICK_HZ + clockOffset - interp * TICK_HZ;
  }

  function flush() {
    if (!pending.length) return;
    const now = performance.now();
    if (now - sentAt < 1000 / inputRate) return;
    sentAt = now;
    const view = Math.max(0, Math.floor(renderTick()));
    while (pending.length) {
      const cmds = pending.splice(0, MAX_CMDS_PER_PACKET);
      send(encodeInput(cmds, seq - pending.length - cmds.length + 1, Date.now() & 0xffff, rtt, interp * 1000, view));
      stats.packets++; stats.cmds += cmds.length;
    }
  }

  const MIRROR = [
    'alive', 'health', 'armor', 'current', 'fragCount', 'smokeCount', 'reloading', 'reloadTotal', 'cooldown',
    'recoilPitch', 'recoilYaw', 'bloom', 'sprayIndex', 'sinceShot', 'crouching', 'grounded', 'sprinting',
    'landTime', 'landKick', 'cooking', 'invulnTimer', 'respawnTimer',
  ];

  /** Copy the predicted player into the one the camera, viewmodel and HUD read. */
  function mirror(dt) {
    const p = pred.p, b = p.body;
    const reloadBefore = player.reloading;
    for (const k of MIRROR) player[k] = p[k];
    player.ammo = p.ammo;
    player.loadout = p.loadout;
    player.chargeTime = p.chargeTicks / TICK_HZ;
    const alpha = Math.min(1, tickAcc / STEP);
    _render.lerpVectors(predPrev, b.position, alpha).add(offset);
    player.body.position.set(_render.x, _render.y, _render.z);
    player.body.velocity.set(b.velocity.x, b.velocity.y, b.velocity.z);
    player.prevBodyPos.copy(_render);
    player.pos.copy(p.pos).sub(b.position).add(_render);
    player.eye.copy(p.eye).sub(b.position).add(_render);
    player.vel.copy(p.vel);
    offset.multiplyScalar(Math.exp(-BLEND_RATE * dt));
    if (offset.lengthSq() < 1e-8) offset.set(0, 0, 0);

    // Sounds and HUD that single player drives from its own weapon code.
    if (player.reloading > 0 && reloadBefore <= 0) { Audio.reloadClick(); lastReloadFrom = 0; }
    if (player.reloading > 0) {
      const at = 1 - player.reloading / player.reloadTotal;
      Audio.reloadProgress(player.current, lastReloadFrom, at);
      lastReloadFrom = at;
    }
    const w = player.ammo[player.current];
    const sig = `${player.current}|${w?.mag}|${w?.reserve}|${player.fragCount}`;
    if (sig !== ammoSig) { ammoSig = sig; d.updateAmmoHud(); }
    const planar = Math.hypot(b.velocity.x, b.velocity.z);
    if (player.alive && player.grounded && planar > 1.2) {
      stepTimer -= dt * (player.sprinting ? 1.5 : 1);
      if (stepTimer <= 0) { Audio.step(); stepTimer = 0.4; }
    } else stepTimer = 0;

    // The death screen, and leaving it.
    if (!player.alive) {
      el.pause.classList.add('on', 'dead');
      el.pBig.textContent = 'ELIMINATED';
      el.pSm.textContent = phase === PHASE.PLAYING ? `RESPAWNING IN ${Math.max(0, p.respawnTimer).toFixed(1)}s` : '';
      el.pCta.style.display = d.isPointerLocked() ? 'none' : '';
    } else if (!wasAlive) {
      el.pause.classList.remove('dead');
      el.pCta.style.display = '';
      el.pBig.textContent = 'PAUSED'; el.pSm.textContent = '';
      if (d.isPointerLocked()) el.pause.classList.remove('on');
      killerId = null;
    }
    wasAlive = player.alive;
  }

  /* ------------------------------------------------------------- remotes */

  /** Another player's state at render tick `rt`, interpolated, or extrapolated a little. */
  function sample(id, rt, out) {
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      const q = snaps[i].players.get(id);
      if (!q) continue;
      if (snaps[i].tick <= rt) { a = { t: snaps[i].tick, q }; break; }
      b = { t: snaps[i].tick, q };
    }
    if (!a && !b) return null;
    let q, t = 0;
    if (a && b && a.q.alive === b.q.alive) {
      q = a.q; t = (rt - a.t) / Math.max(1, b.t - a.t);
      // A respawn between the two: no sliding across the map.
      if ((a.q.pos.x - b.q.pos.x) ** 2 + (a.q.pos.z - b.q.pos.z) ** 2 > 16) t = t < 0.5 ? 0 : 1;
    } else q = (a ?? b).q;
    const src = t >= 1 && b ? b.q : q;
    out.alive = src.alive; out.crouching = src.crouching; out.aiming = src.aiming;
    out.health = src.health; out.weapon = src.weapon; out.team = src.team;
    out.vx = src.vel.x; out.vy = src.vel.y; out.vz = src.vel.z;
    if (a && b && a.q.alive === b.q.alive) {
      out.x = a.q.pos.x + (b.q.pos.x - a.q.pos.x) * t;
      out.y = a.q.pos.y + (b.q.pos.y - a.q.pos.y) * t;
      out.z = a.q.pos.z + (b.q.pos.z - a.q.pos.z) * t;
      out.yaw = a.q.yaw + wrapAngle(b.q.yaw - a.q.yaw) * t;
      out.pitch = a.q.pitch + (b.q.pitch - a.q.pitch) * t;
    } else {
      // Past the newest snapshot: carry on along the velocity, but not for long.
      const ahead = a && !b ? Math.min(EXTRAP_MAX, Math.max(0, (rt - a.t) / TICK_HZ)) : 0;
      out.x = q.pos.x + q.vel.x * ahead;
      out.y = q.pos.y + (q.grounded ? 0 : q.vel.y * ahead);
      out.z = q.pos.z + q.vel.z * ahead;
      out.yaw = q.yaw; out.pitch = q.pitch;
    }
    return out;
  }

  const _s = {};
  function updateRemotes(dt) {
    if (!latest) return;
    const rt = renderTick();
    const now = performance.now();
    for (const q of latest.players) {
      if (q.id === myId) continue;
      const b = puppetFor(q.id, q.team);
      if (!b) continue;
      b.kills = q.kills; b.deaths = q.deaths;
      if (!sample(q.id, rt, _s)) continue;
      _s.firing = now - (lastShot.get(q.id) ?? -1e9) < SHOT_SHOW * 1000;
      b.puppetStep(_s, dt);
      // Emotes: the server ends them on any action, so the snapshot's emote is the truth.
      const emote = b.alive && q.emote ? EMOTE_IDS[q.emote] : null;
      if (emote !== (b.emoteId ?? null)) {
        if (b.emoteAction) { d.emotes.stopOn(b.mesh, b.emoteAction); b.emoteAction = null; }
        b.emoteId = null;
        if (emote) { b.emoteAction = d.emotes.playOn(b.mesh, emote); if (b.emoteAction) b.emoteId = emote; }
      }
      if (b.gunMesh && b.alive) b.gunMesh.visible = !b.emoteAction;
    }
    // Seated players missing from the snapshot have dropped: their seat is held, their body is not.
    for (const [id, b] of puppets) {
      if (!latest.players.some((q) => q.id === id) && b.alive) b.die(false);
    }
    // Grenades in flight, interpolated the same way.
    const live = new Set();
    let a = null, bb = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].tick <= rt) { a = snaps[i]; bb = snaps[i + 1] ?? null; break; }
    }
    a ??= snaps[0];
    if (a) {
      for (const [id, g] of a.grenades) {
        live.add(id);
        let mesh = grenadeMeshes.get(id);
        if (!mesh) { mesh = makeGrenadeMesh(g.kind); grenadeMeshes.set(id, mesh); d.scene.add(mesh); }
        const n = bb?.grenades.get(id);
        const t = n ? Math.min(1, Math.max(0, (rt - a.tick) / Math.max(1, bb.tick - a.tick))) : 0;
        mesh.position.set(g.pos.x, g.pos.y, g.pos.z);
        if (n) mesh.position.lerp(_org.set(n.pos.x, n.pos.y, n.pos.z), t);
        mesh.rotation.x += dt * 9;
      }
    }
    for (const [id, mesh] of grenadeMeshes) if (!live.has(id)) { d.scene.remove(mesh); grenadeMeshes.delete(id); }
  }

  const fragGeo = new THREE.SphereGeometry(0.075, 12, 9);
  const fragMat = new THREE.MeshStandardMaterial({ color: 0x39452f, roughness: 0.85, metalness: 0.2 });
  const smokeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.17, 10);
  const smokeMat = new THREE.MeshStandardMaterial({ color: 0xb8c4cf, roughness: 0.5, metalness: 0.6 });
  function makeGrenadeMesh(kind) {
    const m = kind === 'smoke' ? new THREE.Mesh(smokeGeo, smokeMat) : new THREE.Mesh(fragGeo, fragMat);
    m.castShadow = true;
    return m;
  }

  /* ------------------------------------------------------------ cameras */

  /**
   * Spectating, and watching your killer while dead: a camera behind the followed player, or
   * flying free. Returns true when it placed the camera this frame.
   */
  function spectateCamera(dt) {
    const dead = !spectator && pred && !player.alive && phase === PHASE.PLAYING;
    if (!spectator && !dead) return false;
    if (spectator && d.takeFireLatch()) nextTarget();
    let b = null;
    if (dead) {
      b = puppets.get(killerId);
      if (!b?.alive) return false;      // nobody to watch: stay where you fell
    } else if (!freeCam) {
      b = puppets.get(specTarget);
      if (!b?.alive) { nextTarget(); b = puppets.get(specTarget); }
    }
    if (b) {
      // Behind and above the shoulder, looking the way they look; pulled in against walls.
      const yaw = b.yaw - Math.PI;
      const head = _org.set(b.pos.x, b.pos.y + 0.9, b.pos.z);
      _dir.set(Math.sin(yaw), 0, Math.cos(yaw));
      let dist = 3.2;
      const cam = _mz.copy(head).addScaledVector(_dir, dist).setY(head.y + 0.6);
      while (dist > 0.6 && !d.losClear(head.x, head.y, head.z, cam.x, cam.y, cam.z)) {
        dist *= 0.7;
        cam.copy(head).addScaledVector(_dir, dist).setY(head.y + 0.6 * dist / 3.2);
      }
      camera.position.lerp(cam, 1 - Math.exp(-dt * 12));
      camera.lookAt(head.x - _dir.x * 6, head.y, head.z - _dir.z * 6);
      setStatus(spectator ? `SPECTATING ${b.name} · CLICK: NEXT · V: FREE CAMERA` : `WATCHING ${b.name}`);
    } else {
      // Free camera on the player's own look and movement keys.
      _e.set(player.pitch, player.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _dir.set(0, 0, -1).applyQuaternion(_q);
      const right = _render.set(1, 0, 0).applyQuaternion(_q);
      const speed = (keys.ShiftLeft ? 24 : 10) * dt;
      if (keys.KeyW) freePos.addScaledVector(_dir, speed);
      if (keys.KeyS) freePos.addScaledVector(_dir, -speed);
      if (keys.KeyD) freePos.addScaledVector(right, speed);
      if (keys.KeyA) freePos.addScaledVector(right, -speed);
      if (keys.Space) freePos.y += speed;
      if (keys.KeyC) freePos.y -= speed;
      camera.position.copy(freePos);
      camera.quaternion.copy(_q);
      setStatus(spectator ? 'FREE CAMERA · WASD, SPACE, C · V: FOLLOW A PLAYER' : null);
    }
    camera.updateMatrixWorld();
    el.crosshair.classList.add('off');
    el.scope.classList.remove('on');
    return true;
  }

  function nextTarget() {
    const alive = [...puppets.entries()].filter(([, b]) => b.alive).map(([id]) => id).sort((x, y) => x - y);
    if (!alive.length) { specTarget = null; return; }
    const i = alive.indexOf(specTarget);
    specTarget = alive[(i + 1) % alive.length];
  }

  addEventListener('keydown', (e) => {
    if (!active || e.repeat) return;
    if (e.code === 'KeyV' && spectator) {
      freeCam = !freeCam;
      if (freeCam) freePos.copy(camera.position);
    }
    if (e.code === 'F3') { e.preventDefault(); debugOn = !debugOn; }
  });

  // A backgrounded tab stops drawing frames, so stop the player too rather than leave the
  // server repeating whatever was held.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !active || !pred || !started || !lastSent) return;
    const L = lastSent;
    if (!L.ix && !L.iz && !L.buttons) return;
    const cmd = { ...L, ix: 0, iz: 0, buttons: 0, emote: 0 };
    seq++; pending.push(cmd); lastSent = cmd;
    pred.tick(cmd, seq, phase === PHASE.PLAYING, null);
    sentAt = 0;
    flush();
  });

  /* ------------------------------------------------------------ per frame */

  /**
   * One rendered frame. `realDt` is the unclamped time since the last frame: commands follow
   * the wall clock, as the server does. Returns true when it placed the camera itself.
   */
  function update(realDt, dt) {
    if (!active) return false;
    d.match.time += dt;
    if (phase === PHASE.PLAYING || phase === PHASE.INTERMISSION) timeLeft = Math.max(0, timeLeft - dt);
    if (clockOffset !== null) clockOffset -= dt * 0.5;      // drift down; the next fast snapshot lifts it

    // The interpolation delay: one snapshot interval, plus how late they have been arriving.
    if (lateness.length > 5) {
      const sorted = [...lateness].sort((x, y) => x - y);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] / TICK_HZ;
      const want = Math.min(INTERP_MAX, Math.max(INTERP_MIN, 0.05 + p95 + 0.01));
      interp += (want - interp) * Math.min(1, dt * 2);
    }

    if (reconSnap) { reconcile(reconSnap, reconSpawn); reconSnap = null; reconSpawn = false; }
    if (pred && started) {
      tickAcc += Math.min(realDt, 1);
      let n = 0;
      while (tickAcc >= STEP && n < MAX_TICKS_PER_FRAME) { tickOnce(); tickAcc -= STEP; n++; }
      if (tickAcc >= STEP) tickAcc = 0;
      flush();
      mirror(dt);
    } else {
      d.stepBullets(dt);
    }
    updateRemotes(dt);
    hud();
    return spectateCamera(dt);
  }

  function hud() {
    el.tbMode.textContent = MODE_LABEL[mode] ?? mode.toUpperCase();
    if (mode === 'tdm') {
      el.tbA.textContent = scoreA; el.tbB.textContent = scoreB;
    } else {
      let top = 0;
      for (const b of puppets.values()) top = Math.max(top, b.kills);
      el.tbA.textContent = spectator ? '-' : player.kills;
      el.tbB.textContent = top;
    }
    el.tbTime.textContent = phase === PHASE.INTERMISSION ? `VOTE ${Math.ceil(timeLeft)}` : formatTime(timeLeft);
    if (endInfo) tickEndTimer();
    ui.debug.classList.toggle('on', debugOn);
    if (debugOn) {
      const ps = pred?.stats;
      const flags = [budgetFlags & BUDGET.REDUCED && 'REDUCED', budgetFlags & BUDGET.LAST_ROUND && 'LAST ROUND', budgetFlags & BUDGET.CLOSED && 'CLOSED'].filter(Boolean).join(' ') || '-';
      ui.debug.textContent = [
        `rtt ${rtt} ms · interp ${(interp * 1000).toFixed(0)} ms · input ${inputRate}/s · budget ${flags}`,
        `snapshots ${stats.snaps} · avg ${stats.snaps ? Math.round(stats.bytes / stats.snaps) : 0} B · sent ${stats.packets} pkts / ${stats.cmds} cmds`,
        ps ? `prediction ${ps.compares ? (100 * ps.agreed / ps.compares).toFixed(1) : '-'}% agreed · corrections ${stats.corrections} (snapped ${stats.snapped}) · resyncs ${stats.resyncs} · last ${stats.lastErr.toFixed(3)} m` : 'spectating',
      ].join('\n');
    }
  }

  /** Tab: the server's scoreboard, not the local match's. */
  function decorateBoard() {
    if (!active) return;
    el.bSub.textContent = `${MODE_LABEL[mode] ?? mode} · ONLINE · ${puppets.size + (spectator ? 0 : 1)} PLAYERS`;
  }

  return {
    get active() { return active; },
    get spectating() { return active && spectator; },
    get playing() { return active && !spectator && phase === PHASE.PLAYING; },
    join,
    leave: leaveMatch,
    showPause,
    update,
    decorateBoard,
    /** A weapon from the loadout, sent with the next command. Not the frag: G throws that. */
    selectWeapon(id) {
      if (!pred || !pred.p.loadout.includes(id) || selected === id) return false;
      selected = id;
      return true;
    },
    reload() { reloadLatch = true; },
    debug: () => ({
      myId, spectator, phase, mode, mapId, rtt, interp, inputRate, budgetFlags, started, seq,
      players: latest?.players.length ?? 0, puppets: puppets.size, stats: { ...stats }, pred: pred ? { ...pred.stats, errors: undefined } : null,
      you: pred ? { x: pred.p.body.position.x, y: pred.p.body.position.y, z: pred.p.body.position.z, alive: pred.p.alive } : null,
      remotes: latest ? latest.players.filter((q) => q.id !== myId).map((q) => ({ id: q.id, pos: q.pos, alive: q.alive })) : [],
      hash,
    }),
  };
}
