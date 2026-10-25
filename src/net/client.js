import * as THREE from 'three';

import { CONFIG, TEAM, TEAM_COLOR } from '../config.js';
import { flashHit } from '../hitflash.js';
import { hipFov } from '../settings.js';
import { aimDirection } from '../sim/combat.js';
import { MAP_DATA, MAP_IDS } from '../sim/mapData.js';
import {
  BTN, BUDGET, CHARACTER_IDS, CLOSE, EMOTE_IDS, EV, HIT_BREAK, HIT_LETHAL, HIT_SHIELD, MAX_CMDS_PER_PACKET,
  NO_ID, PHASE, PROTOCOL_VERSION, SNAPSHOT_HZ, TICK_HZ, WEAPON_IDS, ZONE_IDS, encodeInput, mapHash, quantPitch, quantYaw,
  readSnapshot,
} from '../sim/protocol.js';
import { savedSkin } from '../skins.js';
import { applyMatch, loadProfile, saveProfile } from '../profile.js';
import { ITEMS, ITEM_SHIFT, TIERS, canUse, lootFor } from '../sim/items.js';
import { WEAPONS, WEAPON_BY_ID } from '../sim/weaponData.js';
import { killLine } from '../sim/killinfo.js';
import { MODE_INFO, teamScore } from '../sim/modes.js';
import { updateHealProp } from '../healProp.js';
import { createChat } from './chat.js';
import { createFlags } from './flags.js';
import { createZone } from './zone.js';
import { loadScreen } from '../loading.js';
import { createLobby, historyRow, loadHistory, pushHistory } from './lobby.js';
import { Predictor } from './predict.js';
import { InterpController, qualityReadout } from './netQuality.js';
import { createStage } from './stage.js';

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
const INTERP_MIN = 0.1, EXTRAP_MAX = 0.1;   // s: the delay before anything is measured, and how far a puppet is carried past its last snapshot
const SNAP_KEEP = 60;               // snapshots kept: interpolation needs 1.5 s, the killcam replays the last 2 s
const SNAP_EVERY = TICK_HZ / SNAPSHOT_HZ;
const KC_FRAMES = 42;               // snapshots a killcam replays (2.05 s)
const LOSS_WINDOW = 5000;           // ms the loss figure is measured over
const SHOT_SHOW = 0.3;              // s a puppet keeps its gun up after a shot
// A Durable Object's CPU allowance is topped up by incoming messages, and the room ticks whether
// or not anyone sends. A silent client (idle, or spectating) says something this often, so a
// room of idle players is never left running on an allowance nobody refills. ~18 requests/h.
const KEEPALIVE_MS = 10_000;
const TOKEN_KEY = 'overrun-mp-token';
const CHAR_KEY = 'overrun-mp-character';
// soldier.glb is the fallback rig: the shared Mixamo clips do not fit its skeleton (see bots.js),
// and drawn as a puppet it lies flat on the floor. Single player never gives it to a bot either.
const FALLBACK_CHAR = 'soldier', DRAWABLE_IDS = CHARACTER_IDS.filter((id) => id !== FALLBACK_CHAR);
const drawable = (id) => (DRAWABLE_IDS.includes(id) ? id : DRAWABLE_IDS[0]);

const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);
const wrapAngle = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
const modeLabel = (m) => MODE_INFO[m]?.label ?? String(m).toUpperCase();
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
  // The item you asked to use. It stays asked for until the server's channel ends (or never began),
  // so one tap is enough; a second tap, or anything that takes your hands, withdraws it.
  let useWant = 0, useWantAt = 0, useSeen = false, useWeapon = null;
  let rtt = 0;
  let clockOffset = null, interp = INTERP_MIN;
  let interpCtl = new InterpController();   // the adaptive interpolation delay (see netQuality.js)
  let urgentSend = false;                   // a command that should not wait for the next 20 Hz packet
  const snaps = [];                 // { tick, players: Map, grenades: Map }
  let latest = null;
  const puppets = new Map();        // id -> Bot
  const lastShot = new Map();       // id -> performance.now() of their last shot
  const grenadeMeshes = new Map();
  const seenSmokes = new Set();
  let killerId = null;
  let specTarget = null, freeCam = false;
  const shotLog = [];                // recent SHOT events with their tick: the killcam replays them
  let kc = null, lastDeath = null;   // the killcam being replayed; who killed you, with what
  const killedBy = new Map();        // victim id -> killer id, for the spectator's follow-killer
  let lastSnapTick = null;
  const gaps = [];                   // { at, n, missed }: snapshots seen and snapshots that never came
  let reconTimer = 0;
  let netMode = new URLSearchParams(location.search).has('netdebug') ? 2 : 0;   // F3: off, ping and loss, everything
  const freePos = new THREE.Vector3();
  let wasAlive = false, ammoSig = '', stepTimer = 0, lastReloadFrom = 0;
  let endInfo = null;
  let lobbyInfo = { host: null, settings: null, blocker: null, spectators: 0 };
  let rosterList = [];
  let paid = false, endReward = null, queued = false, history = loadHistory(), wasLobby = false, chatTick = 0;
  let stageReady = false, loading = false, prevPhase = 0, stageSig = '';
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
    const recon = make('mp-recon');
    recon.innerHTML = '<b></b><span></span><div class="bar"><i></i></div>';
    const kcBar = make('mp-kc');
    kcBar.innerHTML = '<span>KILLCAM</span><div class="bar"><i></i></div>';
    return { status: make('mp-status'), debug: make('mp-debug'), end: make('mp-end'), net: make('mp-net'), recon, kc: kcBar, spec: make('mp-spec'), count: make('mp-count') };
  })();

  function setStatus(text) {
    ui.status.textContent = text || '';
    ui.status.classList.toggle('on', !!text);
  }

  const chat = createChat({
    send: (m) => sendJson(m),
    keys,
    canOpen: () => active && welcomed && phase !== PHASE.LOBBY,
    isLobby: () => phase === PHASE.LOBBY,
  });
  /** Where a flag carrier's feet are: the predicted self, or the puppet drawn for them. */
  const footOf = (id) => {
    if (id === myId && pred) { const b = pred.p.body.position; return { x: b.x, y: b.y - CONFIG.PLAYER_RADIUS, z: b.z }; }
    const m = puppets.get(id)?.mesh;
    return m ? { x: m.position.x, y: m.position.y, z: m.position.z } : null;
  };
  const flagsView = createFlags({ scene: d.scene, positionOf: footOf });
  const zoneView = createZone({ scene: d.scene });
  const lobbyUI = createLobby({ send: (m) => sendJson(m), onLeave: () => leaveMatch() });
  const stage = createStage({ scene: d.scene, camera });
  const stageShow = (v) => { stage.show(v); d.setSharp?.(v); };

  function drawLobby() {
    if (!lobbyInfo.settings) return;
    lobbyUI.render({
      myId, host: lobbyInfo.host, roster: rosterList, settings: lobbyInfo.settings, blocker: lobbyInfo.blocker,
      spectators: lobbyInfo.spectators, spectating: spectator, history,
    });
  }

  function setLobbyInfo(m) {
    if (!m.settings) return;
    lobbyInfo = { host: m.host ?? null, settings: m.settings, blocker: m.blocker ?? null, spectators: m.spectators ?? 0 };
    if (phase === PHASE.LOBBY) drawLobby();
  }

  /* ------------------------------------------------------------ transport */

  function deliver(lane, fn) {
    if (!lag) { fn(); return; }
    if (lag.loss && Math.random() < lag.loss) return;
    const at = Math.max(lanes[lane], Date.now() + lag.lag / 2 + Math.random() * lag.jitter);
    lanes[lane] = at;
    setTimeout(fn, at - Date.now());
  }

  let lastOut = 0;
  function send(data) {
    const sock = ws;
    if (!sock) return;
    lastOut = performance.now();
    deliver('out', () => { if (sock.readyState === 1) sock.send(data); });
  }
  const sendJson = (m) => send(JSON.stringify(m));
  // Warzone has no clock: the host ends it from the pause screen.
  const endBtn = document.getElementById('end-match');
  endBtn.addEventListener('click', () => { sendJson({ t: 'end' }); el.pause.classList.remove('on', 'dead'); });
  // The host's other powers: send everyone back to the lobby, and remove a seat (a duplicate or a stuck player).
  const lobbyBtn = document.getElementById('to-lobby');
  lobbyBtn.addEventListener('click', () => { sendJson({ t: 'lobby' }); el.pause.classList.remove('on', 'dead'); });
  const kickBox = document.getElementById('p-kick');
  let kickKey = '';
  function drawKick(show) {
    const list = show ? rosterList.filter((r) => r.id !== myId && !r.bot) : [];
    const key = list.map((r) => `${r.id}:${r.name}`).join('|');
    kickBox.hidden = !list.length;
    if (key === kickKey) return;
    kickKey = key;
    kickBox.textContent = '';
    for (const r of list) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = `REMOVE ${r.name}`;
      b.addEventListener('click', () => sendJson({ t: 'kick', id: r.id }));
      kickBox.appendChild(b);
    }
  }

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
    let c = ss?.getItem(CHAR_KEY) ?? savedSkin();
    const loaded = d.loadedCharacters().filter((id) => DRAWABLE_IDS.includes(id));
    if (!c || !DRAWABLE_IDS.includes(c)) {
      c = loaded.length ? loaded[Math.floor(Math.random() * loaded.length)] : DRAWABLE_IDS[0];
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
    if (code === CLOSE.FULL || code === CLOSE.CLOSED || code === CLOSE.KICKED || code === CLOSE.REPLACED) { finish(why || 'Disconnected.'); return; }
    if (!welcomed) { finish(why || 'Could not reach the multiplayer server.'); return; }
    // Anything else is the network: try again a few times, holding the seat with the token.
    if (retries >= 5) { finish('Lost the connection to the server.'); return; }
    retries++;
    showRecon(retries, 600 * retries);
    retryTimer = setTimeout(() => { retryTimer = null; if (active) connect(); }, 600 * retries);
  }

  /** The connection card: what happened, which attempt, and a bar that fills until the next one. */
  function showRecon(attempt, waitMs) {
    clearTimeout(reconTimer);
    const r = ui.recon;
    r.classList.remove('ok');
    r.classList.add('on');
    r.querySelector('b').textContent = 'CONNECTION LOST';
    r.querySelector('span').textContent = `RECONNECTING… ATTEMPT ${attempt} OF 5`;
    const bar = r.querySelector('i');
    bar.style.transition = 'none'; bar.style.width = '0%';
    void bar.offsetWidth;
    bar.style.transition = `width ${waitMs}ms linear`; bar.style.width = '100%';
  }

  function reconRestored() {
    const r = ui.recon;
    if (!r.classList.contains('on')) return;
    r.classList.add('ok');
    r.querySelector('b').textContent = 'CONNECTION RESTORED';
    r.querySelector('span').textContent = '';
    const bar = r.querySelector('i');
    bar.style.transition = 'none'; bar.style.width = '100%';
    reconTimer = setTimeout(() => r.classList.remove('on', 'ok'), 1500);
  }

  function onMessage(data) {
    if (typeof data !== 'string') { onSnapshot(data); return; }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'welcome': onWelcome(m); break;
      case 'roster': setRoster(m.players); setLobbyInfo(m); break;
      case 'match': onMatch(m); break;
      case 'end': onEnd(m); break;
      case 'chat': chat.add(m); break;
      case 'toast': d.showToast(m.text); break;
      case 'flags': flagsView.set(m.flags, myId); break;
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
    // Cover everything until the lobby (or the match) is really there: the game world behind it
    // is not something to see for the three seconds a connection takes.
    stageReady = false; loading = false;
    loadScreen.show({ kicker: 'ONLINE', title: 'CONNECTING', sub: 'Reaching the server' });
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
    reconRestored();
    retries = 0; refusal = null; welcomed = true;
    try { d.emotes.preload?.(); } catch { /* a background fetch must never stop the join */ }
    myId = m.id; spectator = m.spectator; queued = !!m.queued;
    try { if (m.token) storage('sessionStorage')?.setItem(TOKEN_KEY, m.token); } catch { /* private mode */ }
    setRoster(m.roster);
    applyMatchInfo(m);
    seq = 0; lastSent = null; pending.length = 0; tickAcc = 0; started = false;
    snaps.length = 0; clockOffset = null; latest = null; reconSnap = null; reconSpawn = false; lastSnapTick = null;
    interpCtl = new InterpController(); interp = INTERP_MIN;
    if (spectator) {
      pred = null;
      player.alive = false;
      document.body.classList.add('mp-spec');
      freePos.copy(camera.position);
      if (m.full) d.showToast('SERVER FULL — SPECTATING');
      else if (queued) d.showToast('ROUND ENDING — YOU JOIN THE NEXT LOBBY');
    } else {
      document.body.classList.remove('mp-spec');
      const me = roster.get(myId);
      pred = new Predictor(me?.loadout ?? player.loadout);
      pred.setMap(mapId, colliders[mapId], MAP_DATA[mapId].half);
      selected = pred.p.loadout[0];
      setStatus(null);
    }
    if (m.phase === PHASE.INTERMISSION) onEnd({ ...m, title: 'RESULTS', detail: '', standings: [] });
    finishLoading();
  }

  /**
   * The connection is up. Draw the map once from a few angles so its textures and shaders are on
   * the GPU, then wait until what the player lands in exists (the lobby stage, or the first
   * snapshot of a running match) and only then take the loading screen down.
   */
  async function finishLoading() {
    if (loading || !loadScreen.active) return;
    loading = true;
    try {
      const lobby = phase === PHASE.LOBBY;
      loadScreen.set({ kicker: `ONLINE \u00b7 ${modeLabel(lobby ? lobbyInfo.settings?.mode : mode)}`, title: lobby ? 'LOBBY' : String(mapId).toUpperCase(), sub: 'Getting everything ready', map: lobby ? '' : String(mapId) });
      await loadScreen.step(0.4, 'Loading graphics');
      await d.warmScene((f) => (active ? loadScreen.step(0.4 + f * 0.45, 'Loading graphics') : null));
      if (!active) return;
      // Joined mid-match or not, the stage is ready once the scene is warm: the room can fall back
      // to the lobby at any point (everyone else left, the round ended).
      stageReady = true;
      if (phase === PHASE.LOBBY) {
        await loadScreen.step(0.92, 'Setting the stage');
      } else {
        for (let i = 0; i < 120 && active && !(spectator ? latest : started); i++) await loadScreen.step(0.92, 'Waiting for the match');
      }
      await loadScreen.step(1, 'Ready');
      await loadScreen.hide(900);
    } finally {
      loading = false;
      if (!active && loadScreen.active) loadScreen.hide(0);
    }
  }

  function applyMatchInfo(m) {
    mode = m.mode; phase = m.phase; timeLeft = m.timeLeft;
    if (m.roster) setRoster(m.roster);
    flagsView.set(m.mode === 'ctf' ? m.flags : [], myId);
    zoneView.set(m.mode === 'zombie' ? m.zone : null);
    setLobbyInfo(m);
    switchToMap(m.map);
  }

  function switchToMap(id) {
    if (!MAP_DATA[id]) return;
    if (id !== mapId) {
      // The host picking another map in the lobby: build and warm it behind a loading screen
      // rather than as a stutter in front of everyone.
      const veil = mapId !== null && stageReady && !loadScreen.active && phase === PHASE.LOBBY && d.getCurrentMapId() !== id;
      mapId = id;
      if (veil) mapVeil(id);
      else if (d.getCurrentMapId() !== id) {
        d.switchMap(id);
        d.clearSmoke();
        seenSmokes.clear();
      }
    }
    pred?.setMap(id, colliders[id], MAP_DATA[id].half);
  }

  async function mapVeil(id) {
    loadScreen.show({ kicker: 'MAP', title: id.toUpperCase(), sub: '', map: id });
    try {
      await loadScreen.step(0.2, 'Building the arena');
      if (!active) return;
      d.switchMap(id);
      d.clearSmoke();
      seenSmokes.clear();
      await loadScreen.step(0.5, 'Loading graphics');
      await d.warmScene((f) => (active ? loadScreen.step(0.5 + f * 0.5, 'Loading graphics') : null));
      await loadScreen.hide(350);
    } finally {
      if (loadScreen.active) loadScreen.hide(0);
    }
  }

  function onMatch(m) {
    applyMatchInfo(m);
    endInfo = null; paid = false; endReward = null;
    ui.end.classList.remove('on');
    el.feed.innerHTML = '';
    d.clearSmoke();
    seenSmokes.clear();
    // A one-gun rule changes what the round is played with; the roster has the effective loadout.
    const me = roster.get(myId);
    if (pred && me?.loadout) {
      pred.p.loadout = [...me.loadout];
      player.loadout = [...me.loadout];
    }
    if (m.phase === PHASE.LOBBY) { drawLobby(); return; }
    Audio.roundStart();
  }

  function onEnd(m) {
    phase = PHASE.INTERMISSION;
    timeLeft = m.timeLeft;
    endInfo = m;
    recordHistory(m);
    payOut(m);
    document.exitPointerLock?.();
    el.pause.classList.remove('on', 'dead');
    drawEnd();
    ui.end.classList.add('on');
  }

  /**
   * Online rounds pay XP and credits exactly as solo matches do, so progress is the same wherever
   * you play. Once per round (a reconnect re-sends the end message), and only if you were in it:
   * a seat left empty earns nothing. The career is the player's own copy, not anti-cheat.
   */
  function payOut(m) {
    if (spectator || myId === null || paid || !m.standings || m.standings.length < 2) return;
    const me = m.standings.find((r) => r.id === myId);
    if (!me || me.kills + me.deaths === 0) return;
    paid = true;
    const w = m.winner || {};
    let outcome = 'draw';
    if (w.team !== undefined) outcome = w.team === me.team ? 'win' : 'loss';
    else if (w.id !== undefined) outcome = w.id === myId ? 'win' : 'loss';
    const res = applyMatch(loadProfile(), {
      outcome, kills: me.kills, deaths: me.deaths, headshots: me.headshots ?? 0, bestStreak: me.bestStreak ?? 0,
    });
    saveProfile(res.profile);
    endReward = { xp: res.award.total, credits: res.credits, level: res.after.level, leveledUp: res.leveledUp };
  }

  /** One line of match history per round played: win, loss or draw, and the score. */
  function recordHistory(m) {
    if (spectator || myId === null || !m.standings?.length) return;
    const me = m.standings.find((r) => r.id === myId);
    if (!me) return;
    const w = m.winner || {};
    let result = 'DRAW';
    if (w.team !== undefined) result = w.team === me.team ? 'WIN' : 'LOSS';
    else if (w.id !== undefined) result = w.id === myId ? 'WIN' : 'LOSS';
    let score = `${me.kills}K ${me.deaths}D`;
    if (m.mode === 'survival') score = `WAVE ${m.scoreA}`;
    else if (teamScore(m.mode)) {
      const blue = me.team === TEAM.BLUE;
      score = `${blue ? m.scoreA : m.scoreB}-${blue ? m.scoreB : m.scoreA}`;
    }
    history = pushHistory({ mode: m.mode, map: m.map, result, score, at: Date.now() });
  }

  const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: String(text) });
  const kdRatio = (r) => (r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2));

  function drawEnd() {
    const m = endInfo;
    if (!m) return;
    ui.end.textContent = '';
    const card = document.createElement('div');
    card.className = 'mpe-card';
    const h = document.createElement('h2');
    h.textContent = m.title;
    card.append(h, span('mpe-sub', m.detail || ''));
    const standings = m.standings || [];
    const mine = standings.find((r) => r.id === myId);
    if (mine) {
      const stats = document.createElement('div');
      stats.className = 'mpe-stats';
      for (const [label, value] of [['KILLS', mine.kills], ['DEATHS', mine.deaths], ['HEADSHOTS', mine.headshots ?? 0], ['K/D', kdRatio(mine)], ['DAMAGE', (mine.damage ?? 0).toLocaleString('en-US')]]) {
        const cell = document.createElement('div');
        cell.append(span('v', value), span('l', label));
        stats.appendChild(cell);
      }
      card.appendChild(stats);
    }
    if (endReward) {
      const r = span('mpe-reward', `+${endReward.xp} XP · +${endReward.credits} CREDITS${endReward.leveledUp ? ` · LEVEL ${endReward.level}` : ''}`);
      card.appendChild(r);
    }
    const table = document.createElement('div');
    table.className = 'mpe-rows';
    standings.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = `mpe-row${r.id === myId ? ' self' : ''}`;
      const tag = span('tag', '');
      tag.style.background = `#${TEAM_COLOR[r.team].toString(16).padStart(6, '0')}`;
      row.append(span('n', `#${i + 1}`), tag, span('nm', r.name), span('k', `${r.kills} K · ${r.deaths} D · ${r.headshots ?? 0} HS`));
      table.appendChild(row);
    });
    card.appendChild(table);
    if (m.lastRound) card.appendChild(span('mpe-warn', 'The free daily budget is nearly used up: that was the last round today.'));
    if (history.length && !spectator) {
      const hist = document.createElement('div');
      hist.className = 'mpe-hist';
      hist.appendChild(span('lbl', 'MATCH HISTORY'));
      for (const e of history.slice(0, 5)) hist.appendChild(historyRow(e));
      card.appendChild(hist);
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
    if (t) t.textContent = `BACK TO THE LOBBY IN ${Math.max(0, Math.ceil(timeLeft))}s`;
  }

  /** Leave for the lobby; `message` explains why when it was not the player's choice. */
  function finish(message = '') {
    if (!active) return;
    leaving = true;
    active = false;
    d.emoteMusic?.stopAll();
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
    kc = null; lastDeath = null; killedBy.clear(); specTarget = null; freeCam = false; gaps.length = 0; lastSnapTick = null;
    clearTimeout(reconTimer);
    for (const n of [ui.end, ui.recon, ui.kc, ui.spec, ui.net, ui.count]) n.classList.remove('on');
    chat.clear(); chat.show(false); chat.dock(false); flagsView.clear(); zoneView.clear();
    lobbyUI.show(false); wasLobby = false; queued = false; rosterList = [];
    stageShow(false); stageReady = false; stageSig = ''; prevPhase = 0;
    if (loadScreen.active) loadScreen.hide(0);
    lobbyInfo = { host: null, settings: null, blocker: null, spectators: 0 };
    el.pause.classList.remove('kc');
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
      if (endInfo || phase === PHASE.LOBBY || (!spectator && pred && !player.alive)) return;
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
    rosterList = list;
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
    d.emoteMusic?.stop(id);
    b.dispose();
    const i = bots.indexOf(b);
    if (i >= 0) bots.splice(i, 1);
    const mark = d.allyMarks.get(b);
    if (mark) { mark.root.remove(); d.allyMarks.delete(b); }
  }

  /** A zombie is the soldier's skin gone green and sick. Materials are cloned first: skins are shared between puppets. */
  const sick = new THREE.Color(0.55, 1, 0.5);
  function tintZombie(b) {
    b.zTint = true;
    b.mesh.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const clone = (m) => {
        const c = m.clone();
        c.color?.multiply(sick);
        c.emissive?.setRGB(0.03, 0.1, 0.03);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(clone) : clone(o.material);
    });
  }

  function puppetFor(id, team) {
    const r = roster.get(id);
    if (!r) return null;
    let b = puppets.get(id);
    const character = drawable(r.character);   // an older client may still send the soldier
    // A skin nobody has worn yet on this device: fetch it, and draw the player when it lands.
    if (!d.isCharacterLoaded(character)) { d.loadCharacter(character); return null; }
    if (b && (b.team !== team || b.characterId !== character)) { removePuppet(id); b = null; }
    if (!b) {
      b = new d.Bot(r.name, team, d.match.diff, null, { character, puppet: true });
      b.characterId = character;
      b.netId = id;
      b.hostile = !!r.bot;   // a survival enemy the server drives: off the scoreboard, out of the player count
      b.zombie = !!r.zombie;
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
    const tnow = performance.now();
    let missedNow = 0;
    if (lastSnapTick !== null && s.tick > lastSnapTick) {
      missedNow = Math.max(0, Math.round((s.tick - lastSnapTick) / SNAP_EVERY) - 1);
      gaps.push({ at: tnow, n: 1, missed: missedNow });
    }
    lastSnapTick = s.tick;
    while (gaps.length && tnow - gaps[0].at > LOSS_WINDOW) gaps.shift();
    phase = s.phase; mode = s.mode; timeLeft = s.timeLeft; scoreA = s.scoreA; scoreB = s.scoreB;
    inputRate = s.inputRate || 20; budgetFlags = s.budgetFlags;
    if (MAP_IDS[s.map] && MAP_IDS[s.map] !== mapId) switchToMap(MAP_IDS[s.map]);
    if (s.you && s.echoClientTime) rtt = ((Date.now() & 0xffff) - s.echoClientTime - s.echoAge + 0x10000) & 0xffff;
    if (rtt > 0 && rtt < 5000) interpCtl.onRtt(rtt);

    // The clock: the least-delayed snapshot says how far ahead the server is; how late the rest
    // run (and whether any never came) sets the interpolation delay.
    const nowT = performance.now() / 1000 * TICK_HZ;
    const cand = s.tick - nowT;
    if (clockOffset === null || cand > clockOffset || clockOffset - cand > TICK_HZ * 2) clockOffset = cand;
    interpCtl.onSnapshot(clockOffset - cand, missedNow, tnow);

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
    knownDrops.clear();
    for (const k of s.drops) knownDrops.set(k.id, k);
    d.syncDrops?.(s.drops);

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

  const knownDrops = new Map();     // id -> the drop as last seen, so a pickup event can say what it was

  function pickupLabel(e) {
    if (e.what === 1) {
      const c = d.consumables[e.index];
      const loot = c && lootFor(c.kind, e.index);
      return loot ? `+${loot.qty} ${ITEMS[loot.item].name}` : 'PICKED UP';
    }
    if (e.what === 2) {
      const k = knownDrops.get(e.index);
      if (!k) return 'PICKED UP';
      if (k.type === 1) return `+${k.b} ${ITEMS[k.a].name}`;
      return `${TIERS[k.b].name} ${WEAPON_BY_ID[WEAPON_IDS[k.a]]?.name ?? ''}`.trim();
    }
    return 'AMMO RESUPPLIED';
  }

  function onEvent(e, s) {
    switch (e.kind) {
      case EV.SHOT: {
        if (!kc) {
          shotLog.push({ tick: s.tick, shooter: e.shooter, weapon: e.weapon, o: e.o, d: e.d });
          while (shotLog.length && shotLog[0].tick < s.tick - KC_FRAMES * 2) shotLog.shift();
        }
        if (e.shooter === myId || kc) break;     // already drawn when it was predicted; the killcam shows the past
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
          if (b) { b.lastHurtBy = player; b.lastHurtAt = d.match.time; if (!shield) flashHit(b.mesh); }
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
        if (victim) d.addKillFeed(killer, victim, e.head, { weapon: e.weapon, flags: e.flags, dist: e.dist });
        killedBy.set(e.victim, e.killer);
        if (spectator && e.victim === specTarget && !freeCam && puppets.get(e.killer)?.alive) specTarget = e.killer;
        if (e.killer === myId && e.victim !== myId && victim) {
          d.showHitMarker('kill');
          d.showKillBanner(victim, e.head, { weapon: e.weapon, flags: e.flags, dist: e.dist });
          if (e.head) Audio.headshot?.();
          Audio.kill();
        }
        if (e.victim === myId) {
          killerId = e.killer !== myId ? e.killer : null;
          lastDeath = { name: who(e.killer)?.name ?? null, weapon: e.weapon, head: e.head, flags: e.flags, dist: e.dist, self: e.killer === myId || e.killer === NO_ID };
          if (!spectator && !lastDeath.self) startKillcam(e.killer);
        }
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
          d.showToast(pickupLabel(e));
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

  /** Which item the next command asks for. `p` is the predicted player, whose useKind is the server's word. */
  function stepUseWant(p, buttons, emote, weapon) {
    const now = performance.now();
    const press = d.takeItemPress?.() ?? 0;
    if (press) {
      if (useWant === press) { d.showToast(`${ITEMS[press].name} CANCELLED`); useSeen = false; return 0; }
      if (!canUse(p, press)) {
        const it = ITEMS[press];
        d.showToast((p.items?.[press] ?? 0) <= 0 ? `NO ${it.name}` : it.stat === 'health' ? 'HEALTH ALREADY HIGH ENOUGH' : 'SHIELD ALREADY HIGH ENOUGH');
        return useWant;
      }
      useWant = press; useWantAt = now; useSeen = false; useWeapon = weapon;
    }
    if (!useWant) return 0;
    // Anything that takes your hands withdraws it, the same list the server breaks a channel on.
    if (buttons & (BTN.FIRE | BTN.FRAG | BTN.SMOKE) || emote || weapon !== useWeapon) return 0;
    if (p.useKind === useWant) useSeen = true;
    else if (useSeen || now - useWantAt > 1500) return 0;      // it finished or was cancelled, or never started
    return useWant;
  }

  function buildCmd() {
    const p = pred.p;
    const L = lastSent;
    const weapon = WEAPON_IDS.indexOf(selected ?? p.current);
    if (!p.alive || phase === PHASE.LOBBY || phase === PHASE.COUNTDOWN) {
      // Dead, or waiting for the match: nothing held, so nothing carries over. The server does
      // the same in the lobby and the countdown, so prediction agrees with it.
      useWant = 0;
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
    useWant = stepUseWant(p, buttons, emote, weapon);
    if (useWant) { buttons |= useWant << ITEM_SHIFT; buttons &= ~BTN.SPRINT; }
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
    // A shot or an emote should not wait for the next 20 Hz packet: up to 50 ms of that is pure input lag,
    // and the packet's view tick is stamped when it leaves, so a late one also aims at a later picture.
    if (!idle && ((cmd.buttons & BTN.FIRE && !(L?.buttons & BTN.FIRE)) || cmd.emote !== (L?.emote ?? 0))) urgentSend = true;
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
    // Urgent sends skip the 20 Hz wait but never go out closer than 20 ms apart, so the rate stays bounded.
    if (now - sentAt < (urgentSend ? Math.min(20, 1000 / inputRate) : 1000 / inputRate)) return;
    urgentSend = false;
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
    'landTime', 'landKick', 'cooking', 'invulnTimer', 'respawnTimer', 'items', 'tiers', 'useKind', 'useP',
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
      const by = lastDeath && !lastDeath.self && lastDeath.name
        ? `KILLED BY ${lastDeath.name} \u00b7 ${killLine(WEAPON_BY_ID[lastDeath.weapon]?.name ?? lastDeath.weapon, { head: lastDeath.head, flags: lastDeath.flags, dist: lastDeath.dist })}` : '';
      const wait = phase !== PHASE.PLAYING ? '' : mode === 'duel' ? 'NEXT ROUND SOON' : mode === 'survival' ? 'DOWN UNTIL THE NEXT WAVE' : `RESPAWNING IN ${Math.max(0, p.respawnTimer).toFixed(1)}s`;
      el.pSm.textContent = [by, wait].filter(Boolean).join('  ·  ');
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
  function sample(id, rt, out, list = snaps) {
    let a = null, b = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i].players.get(id);
      if (!q) continue;
      if (list[i].tick <= rt) { a = { t: list[i].tick, q }; break; }
      b = { t: list[i].tick, q };
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
    // A killcam replays the frozen past: everyone, you included, drawn from the copy taken at your death.
    const list = kc ? kc.frames : snaps;
    const rt = kc ? kc.rt : renderTick();
    const now = performance.now();
    for (const q of kc ? kc.frames[kc.frames.length - 1].players.values() : latest.players) {
      if (q.id === myId && !kc) continue;
      const b = puppetFor(q.id, q.team);
      if (!b) continue;
      b.kills = q.kills; b.deaths = q.deaths;
      if (!sample(q.id, rt, _s, list)) continue;
      _s.firing = now - (lastShot.get(q.id) ?? -1e9) < SHOT_SHOW * 1000;
      b.puppetStep(_s, dt);
      // Emotes: the server ends them on any action, so the snapshot's emote is the truth.
      const emote = b.alive && q.emote ? EMOTE_IDS[q.emote] : null;
      if (emote !== (b.emoteId ?? null)) {
        if (b.emoteAction) { d.emotes.stopOn(b.mesh, b.emoteAction); b.emoteAction = null; }
        b.emoteId = null;
        if (emote) { b.emoteAction = d.emotes.playOn(b.mesh, emote); if (b.emoteAction) b.emoteId = emote; }
      }
      const using = b.alive && !!q.using;
      if (b.zombie && !b.zTint) tintZombie(b);
      if (b.gunMesh && b.alive) b.gunMesh.visible = !b.zombie && !b.emoteAction && !using;   // the dead have nothing to hold
      // Someone healing is seen opening a medkit, so a covering teammate (or the man about to be
      // shot) can tell. The snapshot only says "using", not which item.
      updateHealProp(b, using, now);
    }
    // Seated players missing from the snapshot have dropped: their seat is held, their body is not.
    if (!kc) {
      for (const [id, b] of puppets) {
        if (!latest.players.some((q) => q.id === id) && b.alive) b.die(false);
      }
    }
    // Grenades in flight, interpolated the same way.
    const live = new Set();
    let a = null, bb = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].tick <= rt) { a = list[i]; bb = list[i + 1] ?? null; break; }
    }
    a ??= list[0];
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
    if (kc && stepKillcam(dt)) return true;
    const dead = !spectator && pred && !player.alive && phase === PHASE.PLAYING;
    if (!spectator && !dead) { ui.spec.classList.remove('on'); return false; }
    if (spectator && d.takeFireLatch()) stepTarget(1);
    let b = null;
    if (dead) {
      b = puppets.get(killerId);
      if (!b?.alive) return false;      // nobody to watch: stay where you fell
    } else if (!freeCam) {
      b = puppets.get(specTarget);
      if (!b?.alive) { stepTarget(1); b = puppets.get(specTarget); }
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
      if (spectator) drawSpec(`SPECTATING ${b.name}`, queued ? 'YOU JOIN THE NEXT LOBBY' : `${b.kills} K / ${b.deaths} D · ${Math.round(b.health)} HP`);
      else setStatus(`WATCHING ${b.name}`);
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
      if (spectator) drawSpec('FREE CAMERA', 'WASD · SPACE UP · C DOWN · SHIFT FAST');
      else setStatus(null);
    }
    camera.updateMatrixWorld();
    el.crosshair.classList.add('off');
    el.scope.classList.remove('on');
    return true;
  }

  /** The next (dir 1) or previous (dir -1) living player to follow. */
  function stepTarget(dir) {
    const alive = [...puppets.entries()].filter(([id, b]) => b.alive && id !== myId).map(([id]) => id).sort((x, y) => x - y);
    if (!alive.length) { specTarget = null; return; }
    const i = alive.indexOf(specTarget);
    specTarget = alive[(i < 0 ? (dir > 0 ? 0 : alive.length - 1) : i + dir + alive.length) % alive.length];
    freeCam = false;
  }

  function drawSpec(title, line) {
    const hint = freeCam ? 'V / F  FOLLOW A PLAYER' : 'Q \u25c0  \u25b6 E  OR CLICK \u00b7 K  FOLLOW KILLER \u00b7 V / F  FREE CAM';
    ui.spec.textContent = '';
    ui.spec.append(span('t', title), span('l', line), span('k', hint));
    ui.spec.classList.add('on');
    setStatus(null);
  }

  /* ------------------------------------------------------------- killcam */

  /**
   * On a kill, the last two seconds of snapshots are copied out of the live buffer and replayed
   * from the killer's eyes while the respawn timer runs. Nothing extra crosses the wire: every
   * player's position and look direction is already in each snapshot.
   */
  function startKillcam(killer) {
    const frames = snaps.slice(-KC_FRAMES);
    if (frames.length < 10 || !frames.some((f) => f.players.get(killer))) return;
    kc = { id: killer, frames, rt: frames[0].tick, shot: 0, dist: 2.4, shots: shotLog.filter((x) => x.tick >= frames[0].tick) };
    el.pause.classList.add('kc');
    const w = lastDeath && WEAPON_BY_ID[lastDeath.weapon];
    ui.kc.firstChild.textContent = lastDeath
      ? `KILLCAM \u00b7 ${lastDeath.name ?? ''} \u00b7 ${killLine(w?.name ?? lastDeath.weapon, lastDeath)}` : 'KILLCAM';
    ui.kc.classList.add('on');
  }

  function endKillcam() {
    if (!kc) return;
    const b = puppets.get(kc.id);
    if (b?.alive) b.mesh.visible = true;
    kc = null;
    removePuppet(myId);       // the stand-in that played you
    ui.kc.classList.remove('on');
    el.pause.classList.remove('kc');
  }

  const _k = {};
  /** Plays one frame of the killcam. True when it placed the camera. */
  function stepKillcam(dt) {
    kc.rt += dt * TICK_HZ;
    const last = kc.frames[kc.frames.length - 1].tick;
    if (kc.rt > last + 24 || player.alive || phase !== PHASE.PLAYING || spectator) { endKillcam(); return false; }
    if (!sample(kc.id, kc.rt, _k, kc.frames)) { endKillcam(); return false; }
    const b = puppets.get(kc.id);
    if (b) b.mesh.visible = true;
    // Replay the killer's shots as they happened, so the muzzle flashes and tracers say where it came from.
    while (kc.shot < kc.shots.length && kc.shots[kc.shot].tick <= kc.rt) {
      const sh = kc.shots[kc.shot++];
      const sb = puppets.get(sh.shooter), sw = WEAPON_BY_ID[sh.weapon];
      lastShot.set(sh.shooter, performance.now());
      if (sb && sw && !sw.thrown) d.fireWeapon(sb, sw, v3(sh.o), v3(sh.d), 1);
    }
    // Over the killer's right shoulder, looking where they aim: they and what they shot at are both in frame.
    const sy = Math.sin(_k.yaw), cy = Math.cos(_k.yaw), cp = Math.cos(_k.pitch);
    const eyeY = _k.y + (_k.crouching ? CONFIG.CROUCH_HEIGHT : CONFIG.EYE_HEIGHT);
    _org.set(_k.x, eyeY, _k.z);
    let reach = 1;
    for (let i = 0; i < 5; i++) {
      _mz.set(_k.x + sy * 2.4 * reach + cy * 0.65 * reach, eyeY + 0.45 * reach, _k.z + cy * 2.4 * reach - sy * 0.65 * reach);
      if (d.losClear(_org.x, _org.y, _org.z, _mz.x, _mz.y, _mz.z)) break;
      reach *= 0.65;
    }
    kc.dist += (reach - kc.dist) * (reach < kc.dist ? 1 : Math.min(1, dt * 6));      // pulled in at once, eased back out
    _mz.set(_k.x + sy * 2.4 * kc.dist + cy * 0.65 * kc.dist, eyeY + 0.45 * kc.dist, _k.z + cy * 2.4 * kc.dist - sy * 0.65 * kc.dist);
    camera.position.copy(_mz);
    camera.lookAt(_k.x - sy * cp * 30, eyeY + Math.sin(_k.pitch) * 30, _k.z - cy * cp * 30);
    if (camera.fov !== hipFov()) { camera.fov = hipFov(); camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
    ui.kc.querySelector('i').style.width = `${Math.min(100, ((kc.rt - kc.frames[0].tick) / (last - kc.frames[0].tick)) * 100).toFixed(1)}%`;
    ui.spec.classList.remove('on');
    el.crosshair.classList.add('off');
    el.scope.classList.remove('on');
    return true;
  }

  addEventListener('keydown', (e) => {
    if (!active || e.repeat) return;
    if (spectator) {
      if (e.code === 'KeyV' || e.code === 'KeyF') {
        freeCam = !freeCam;
        if (freeCam) freePos.copy(camera.position);
      } else if (e.code === 'KeyQ' || e.code === 'ArrowLeft') stepTarget(-1);
      else if (e.code === 'KeyE' || e.code === 'ArrowRight') stepTarget(1);
      else if (e.code === 'KeyK') {
        const k = killedBy.get(specTarget);
        if (puppets.get(k)?.alive) { specTarget = k; freeCam = false; }
      }
    }
    if (e.code === 'F3') { e.preventDefault(); netMode = (netMode + 1) % 3; }
  });

  // A backgrounded tab stops drawing frames, so stop the player too rather than leave the
  // server repeating whatever was held.
  // A timer rather than the frame loop, so it keeps going in a background tab.
  setInterval(() => {
    if (active && welcomed && ws?.readyState === 1 && performance.now() - lastOut >= KEEPALIVE_MS) sendJson({ t: 'ka' });
  }, 2000);

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
    if (phase === PHASE.PLAYING || phase === PHASE.INTERMISSION || phase === PHASE.COUNTDOWN) timeLeft = Math.max(0, timeLeft - dt);
    if (clockOffset !== null) clockOffset -= dt * 0.5;      // drift down; the next fast snapshot lifts it

    // The interpolation delay: one snapshot interval, how late they have been arriving, and a
    // spare interval after a loss; held down where it would cost hit registration (netQuality.js).
    interp = interpCtl.step(dt);

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
    const staged = stageStep(dt);
    if (!staged) updateRemotes(dt);
    flagsView.update(dt);
    zoneView.update(dt, mode === 'zombie' ? scoreA : 0, camera.position);
    hud();
    // The match opens: the world replaces the stage, and the mouse has to be taken back.
    if (prevPhase === PHASE.COUNTDOWN && phase === PHASE.PLAYING && !d.isPointerLocked()) showPause(true, 'GET READY');
    prevPhase = phase;
    return staged || spectateCamera(dt);
  }

  /* ---------------------------------------------------------------- stage */

  const _stageS = { alive: true, crouching: false, aiming: false, firing: false, health: 100, weapon: 'ar', team: 0, vx: 0, vy: 0, vz: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };

  /**
   * In the lobby, and through the countdown, everyone stands on the stage in their own
   * character instead of in the world. Returns true while it has the camera.
   */
  function stageStep(dt) {
    const want = active && welcomed && stageReady && (phase === PHASE.LOBBY || phase === PHASE.COUNTDOWN);
    if (!want) {
      if (stage.on) { stageShow(false); stageSig = ''; removePuppet(myId); }
      return false;
    }
    stageShow(true);
    const list = [...rosterList].sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : a.id - b.id));
    const entries = list.map((r) => ({ id: r.id, name: r.name, team: r.team, host: r.id === lobbyInfo.host, ready: phase === PHASE.COUNTDOWN || !!r.ready, self: r.id === myId }));
    const sig = entries.map((e) => `${e.id}${e.name}${e.team}${+e.host}${+e.ready}`).join();
    if (sig !== stageSig) { stageSig = sig; stage.setPlayers(entries); }
    list.forEach((r, i) => {
      const b = puppetFor(r.id, r.team);
      const sp = stage.spot(i);
      if (!b || !sp) return;
      _stageS.x = sp.x; _stageS.y = sp.y; _stageS.z = sp.z; _stageS.yaw = sp.yaw;
      _stageS.team = r.team; _stageS.weapon = r.loadout?.[0] ?? 'ar';
      b.puppetStep(_stageS, dt);
    });
    stage.frame(dt, innerWidth > 900 ? 0.3 : 0);
    el.crosshair.classList.add('off');
    el.scope.classList.remove('on');
    return true;
  }

  function hud() {
    el.tbMode.textContent = modeLabel(phase === PHASE.LOBBY && lobbyInfo.settings ? lobbyInfo.settings.mode : mode);
    if (mode === 'survival' || mode === 'zombie') {
      el.tbA.textContent = spectator ? '-' : player.kills; el.tbB.textContent = scoreB;   // your kills, hostiles left
    } else if (teamScore(mode)) {
      el.tbA.textContent = scoreA; el.tbB.textContent = scoreB;
    } else {
      let top = 0;
      for (const b of puppets.values()) top = Math.max(top, b.kills);
      el.tbA.textContent = spectator ? '-' : player.kills;
      el.tbB.textContent = top;
    }
    el.tbTime.textContent = { [PHASE.LOBBY]: 'LOBBY', [PHASE.COUNTDOWN]: 'GET READY', [PHASE.INTERMISSION]: 'RESULTS' }[phase] ?? (mode === 'survival' ? `WAVE ${scoreA}` : MODE_INFO[mode]?.untimed ? '∞' : formatTime(timeLeft));
    const inLobby = phase === PHASE.LOBBY && welcomed;
    lobbyUI.show(inLobby);
    chat.show(active && welcomed);
    chat.dock(inLobby);
    if (inLobby && !wasLobby) {
      document.exitPointerLock?.();
      el.pause.classList.remove('on', 'dead');
      drawLobby();
    }
    wasLobby = inLobby;
    const counting = phase === PHASE.COUNTDOWN;
    ui.count.classList.toggle('on', counting);
    if (counting) ui.count.textContent = Math.max(1, Math.ceil(timeLeft));
    if (performance.now() - chatTick > 500) { chatTick = performance.now(); chat.refresh(); }
    if (endInfo) tickEndTimer();
    ui.debug.classList.toggle('on', netMode === 2);
    const amHost = active && welcomed && myId !== null && myId === lobbyInfo.host;
    endBtn.hidden = !(amHost && phase === PHASE.PLAYING && MODE_INFO[mode]?.untimed);
    lobbyBtn.hidden = !(amHost && phase !== PHASE.LOBBY);
    drawKick(amHost);
    // Ping and loss: on request (F3), and by itself when the connection is bad enough to matter.
    let seen = 0, missed = 0;
    for (const g of gaps) { seen += g.n; missed += g.missed; }
    const loss = seen + missed ? (100 * missed) / (seen + missed) : 0;
    const q = qualityReadout({ rtt: interpCtl.rtt || rtt, jitterMs: interpCtl.jitterMs, lossPct: loss, delayMs: interp * 1000 });
    ui.net.classList.toggle('on', netMode === 1 || (netMode === 0 && q.level !== 'good' && !!ws));
    ui.net.classList.toggle('bad', q.level === 'bad');
    ui.net.classList.toggle('warn', q.level === 'warn');
    ui.net.textContent = q.text;
    if (netMode === 2) {
      const ps = pred?.stats;
      const flags = [budgetFlags & BUDGET.REDUCED && 'REDUCED', budgetFlags & BUDGET.LAST_ROUND && 'LAST ROUND', budgetFlags & BUDGET.CLOSED && 'CLOSED'].filter(Boolean).join(' ') || '-';
      ui.debug.textContent = [
        `rtt ${rtt} ms · loss ${loss.toFixed(1)}% (snapshot gaps) · interp ${(interp * 1000).toFixed(0)} ms (cap ${(interpCtl.cap * 1000).toFixed(0)}, jitter ${interpCtl.jitterMs.toFixed(0)}) · input ${inputRate}/s · budget ${flags}`,
        `snapshots ${stats.snaps} · avg ${stats.snaps ? Math.round(stats.bytes / stats.snaps) : 0} B · sent ${stats.packets} pkts / ${stats.cmds} cmds`,
        ps ? `prediction ${ps.compares ? (100 * ps.agreed / ps.compares).toFixed(1) : '-'}% agreed · corrections ${stats.corrections} (snapped ${stats.snapped}) · resyncs ${stats.resyncs} · last ${stats.lastErr.toFixed(3)} m` : 'spectating',
      ].join('\n');
    }
  }

  /** Tab: the server's scoreboard, not the local match's. */
  function decorateBoard() {
    if (!active) return;
    el.bSub.textContent = `${modeLabel(mode)} · ONLINE · ${[...roster.values()].filter((r) => !r.bot).length} PLAYERS`;
  }

  return {
    get active() { return active; },
    get inLobby() { return active && welcomed && phase === PHASE.LOBBY; },
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
    /** The locker changed skin or loadout: remember it for the next room, and tell this one. */
    gear(character, loadout) {
      try { storage('sessionStorage')?.setItem(CHAR_KEY, character); } catch { /* private mode */ }
      if (active && welcomed && !spectator) sendJson({ t: 'gear', character, loadout });
    },
    debug: () => ({
      myId, spectator, phase, mode, mapId, rtt, interp, inputRate, budgetFlags, started, seq,
      players: latest?.players.length ?? 0, puppets: puppets.size, stats: { ...stats }, pred: pred ? { ...pred.stats, errors: undefined } : null,
      you: pred ? { x: pred.p.body.position.x, y: pred.p.body.position.y, z: pred.p.body.position.z, alive: pred.p.alive } : null,
      remotes: latest ? latest.players.filter((q) => q.id !== myId).map((q) => ({ id: q.id, pos: q.pos, alive: q.alive })) : [],
      hash, lobby: lobbyUI.shown, queued, stageReady, staged: stage.on,
    }),
  };
}
