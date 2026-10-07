import * as CANNON from 'cannon-es';
import { Vector3 } from 'three';

import { CONFIG, FIXED_DT, SPAWN_INVULN, TEAM } from '../src/config.js';
import { DEFAULT_LOADOUT, validLoadout } from '../src/loadout.js';
import { buildMapWorld, floorAt, inBlockers, validSpawnPoints } from '../src/sim/colliders.js';
import { aimDirection, launchVelocity, resetAmmo, throwAim } from '../src/sim/combat.js';
import { HB_PLAYER, PLAYER_ZONE_MULT, HB_PLAYER_CROUCH, analyticHit } from '../src/sim/hitmath.js';
import {
  ITEM_MASK, ITEM_SHIFT, USE, addItem, canCarry, cancelUse, emptyItems, lootFor, rollDrop, stepUse, tierMult,
} from '../src/sim/items.js';
import { MAP_DATA, MAP_IDS } from '../src/sim/mapData.js';
import { DEFAULT_SETTINGS, MODE_INFO, PLAYABLE, ZOMBIE_HOLD, cleanSettings, teamMode, teamScore } from '../src/sim/modes.js';
import { createPlayerBody, setCrouch, syncPlayerPoints } from '../src/sim/movement.js';
import {
  BTN, BUDGET, CHARACTER_IDS, CLOSE, EV, HIT_BREAK, HIT_LETHAL, HIT_SHIELD, MAX_PLAYERS, MAX_SPECTATORS,
  MODE_IDS, MSG_SNAPSHOT, NO_ID, ONE_SHOT_BITS, PHASE, PROTOCOL_VERSION, SNAPSHOT_HZ, TICK_HZ, WEAPON_IDS,
  Writer, ZONE_IDS, decodeInput, mapHash, quantYaw, writeEvent, writePlayer, writeYou,
} from '../src/sim/protocol.js';
import { applyCommand } from '../src/sim/tick.js';
import { killFlags } from '../src/sim/killinfo.js';
import { WEAPONS, WEAPON_BY_ID, damageAt } from '../src/sim/weaponData.js';
import { G_NADE, G_WORLD, MAT_NADE, RAY_OPTS } from '../src/sim/world.js';
import { botCommand, botSpec, findPath, navFor, newAi, zombieSpec } from './bots.js';
import { ctfDrop, ctfInit, ctfStep, flagsWire } from './ctf.js';
import { Governor } from './governor.js';

/**
 * The one multiplayer room: authoritative simulation, match flow and the wire, with no idea
 * what carries its bytes. An adapter (server/node.js, server/worker.js) hands it connections
 * ({ send(data), close(code, reason) }) and messages, and calls update() on a timer.
 *
 * The clock, the RNG and the map colliders are injected, so tests drive it directly.
 */

export const INTERMISSION = 15;          // s the results are shown for
export const COUNTDOWN = 5;              // s between everyone being ready and the first shot
export const LATE_JOIN_CUTOFF = 10;      // s: with less than this left in a round, a newcomer waits for the next lobby
const CHAT_MAX = 120;
const STEP_MS = 1000 / TICK_HZ;
const SNAP_EVERY = TICK_HZ / SNAPSHOT_HZ;
const MAX_CATCHUP = 30;                  // ticks one update may run (250 ms) before time is dropped
const HIST = 64;                         // hitbox history, ticks (533 ms)
export const MAX_REWIND = 30;            // ticks lag compensation may rewind (250 ms)
export const QUEUE_MAX = 30;             // commands buffered per player (250 ms)
const MAX_GUESS = 12;                    // ticks a held command is repeated while starved (100 ms)
const RECONNECT_GRACE = 60;              // s a dropped player's seat is held for its token
const LIVENESS = 75;                     // s of silence (clients ping every 10; a hidden tab's timers can slip to one a minute) before a connection is declared dead
const ALONE_GRACE = 15;                  // s a round may run with fewer people than its mode needs before everyone goes back to the lobby
const KICK_BAN = 120;                    // s a removed player's token is refused for
const NAME_MAX = 16;
const CHEST_RANGE = 1.5, CHEST_RESPAWN = 25;
const CONSUMABLE_RESPAWN = { health: 30, shield: 35 };    // s; what a spot holds is src/sim/items.js lootFor
const DROP_RANGE = 1.6, DROP_LIFE = 40, MAX_DROPS = 14;
const NADE_ROLL_SPEED = 2.6;
/** Zombie Escape: the zone opens OPEN_AT s in, holding it for HOLD s escapes; a fallen survivor is reinforced after REINFORCE s while a friend still stands. */
const ZB = { OPEN_AT: 60, HOLD: ZOMBIE_HOLD, ZONE_R: 5, CLAW_RANGE: 1.9, REINFORCE: 25, SPAWN_EVERY: 1.1, FIRST_SPAWN: 6 };
const BOT_ID0 = 100, BOT_IDS = 150;      // hostile ids count up from here, so a seat id and a hostile id never meet
const BOT_SKINS = ['gasmask', 'trooper', 'crypto', 'swat'].filter((id) => CHARACTER_IDS.includes(id));

const _v = new Vector3();
const _dir = new Vector3();
const _hp = new Vector3();
const _from = new CANNON.Vec3();
const _to = new CANNON.Vec3();
const _ray = new CANNON.RaycastResult();
const _hist = { x: 0, y: 0, z: 0 };

const IDLE_CMD = Object.freeze({ seq: 0, ix: 0, iz: 0, yawQ: 0, pitchQ: 0, buttons: 0, weapon: 0, emote: 0, viewTick: 0 });

function cleanName(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, NAME_MAX);
  return s || 'PLAYER';
}

export class Room {
  /**
   * colliders: { port, desert, snow, warzone } parsed assets/maps/<id>.json
   * now(): ms; rng(): [0, 1); governor: a Governor; mapId/mode: the lobby's first settings.
   * autostart skips the lobby and starts that round at once (tests and the swarm run).
   */
  constructor({ colliders, now = () => Date.now(), rng = Math.random, governor = null, mapId = 'port', mode = 'dm', autostart = false, log = () => {} }) {
    this.colliders = colliders;
    this.now = now;
    this.rng = rng;
    this.log = log;
    this.governor = governor ?? new Governor({ now });
    this.hash = mapHash(colliders, MAP_DATA, CONFIG, WEAPONS);
    this.clients = new Map();            // conn -> { conn, player, spectator, ... }
    this.players = [];                   // seats, connected or held for reconnect
    this.tick = 0;
    this.acc = 0;
    this.last = now();
    this.snapDue = false;
    this.events = [];
    this.bullets = [];
    this.grenades = [];
    this.smokes = [];
    this.nextEntity = 0;
    this.stats = {
      msgsIn: 0, bytesIn: 0, bytesOut: 0, snapshots: 0, snapBytes: 0, snapBytesMax: 0,
      inputDropped: 0, inputBad: 0, cmdsRepeated: 0, cmdsTrimmed: 0,
      ticks: 0, ticksDropped: 0, costMs: [], gaps: [], window: { at: now(), msgs: 0, bytesOut: 0, ticks: 0 }, rate: {},
    };
    this.settings = cleanSettings({ mode, map: mapId }, DEFAULT_SETTINGS, MAP_DATA);
    this.mode = this.settings.mode;
    this.phase = PHASE.LOBBY;
    this.timeLeft = 0;
    this.scoreA = 0; this.scoreB = 0;
    this.roundReset = 0;
    this.flags = [];
    this.zb = null;                      // zombie escape: { zone, age, hold, open, spawnIn, counter, nextId }
    this.sv = null;                      // survival: { wave, state, breakT, queue, cap, spawnIn, counter, nextId }
    this.rosterDirty = false;
    this.kicked = new Map();             // token -> time it may rejoin
    this.aloneFor = 0;                   // s the round has had too few people
    this.loadMap(this.settings.map);
    if (autostart) this.startMatch(this.settings.mode, this.settings.map);
  }

  /* ------------------------------------------------------------ the level */

  loadMap(id) {
    const def = MAP_DATA[id];
    this.mapDef = def;
    const { world, blockers } = buildMapWorld(this.colliders[id], def.half);
    const castY = def.ceilY - 0.5;
    this.spawns = validSpawnPoints(world, blockers, def.spawns, def.spawns.slice(0, 4), castY).points;
    // Each side's own spawns: the ones nearer its flag than the other's (capture the flag spawns by team).
    const [fa, fb] = def.flags;
    const nearer = (sp, f, g) => (sp.x - f[0]) ** 2 + (sp.z - f[1]) ** 2 <= (sp.x - g[0]) ** 2 + (sp.z - g[1]) ** 2;
    this.sideSpawns = { [TEAM.BLUE]: this.spawns.filter((s) => nearer(s, fa, fb)), [TEAM.RED]: this.spawns.filter((s) => nearer(s, fb, fa)) };
    // Survival: the people start together, at the map's own list (svHumans) or on the blue side; hostiles come from anywhere else.
    const own = def.svHumans ? this.spawns.filter((sp) => def.svHumans.some(([x, z]) => Math.abs(x - sp.x) < 0.01 && Math.abs(z - sp.z) < 0.01)) : [];
    this.humanSpawns = own.length ? own : this.sideSpawns[TEAM.BLUE].length ? this.sideSpawns[TEAM.BLUE] : this.spawns;
    this.blockers = blockers;
    this.nav = !def.modes || def.modes.includes('sv') ? navFor(id, world, blockers, def) : null;   // the route grid hostiles walk, built before any body is in the world
    // Same placement rules as src/pickups.js.
    this.chests = [];
    for (const [x, z] of def.ammo) {
      if (this.chests.length >= 8) break;
      if (inBlockers(blockers, x, z, 1.2)) continue;
      const y = floorAt(world, x, z, castY);
      if (y !== null) this.chests.push({ x, y: y + 0.45, z, cooldown: 0 });
    }
    this.drops = [];
    this.nextDrop = 0;
    this.consumables = [];
    for (const [kind, x, z] of def.consumables) {
      if (this.consumables.length >= 8) break;
      if (inBlockers(blockers, x, z, 1.2)) continue;
      const y = floorAt(world, x, z, castY);
      if (y !== null) this.consumables.push({ kind, x, y: y + 0.5, z, cooldown: 0 });
    }
    for (const p of this.players) if (p.body) world.addBody(p.body);
    for (const g of this.grenades) this.world?.removeBody(g.body);
    this.grenades = [];
    this.world = world;
    this.mapId = id;
  }

  /* ---------------------------------------------------------- connections */

  /** A connection opened; nothing happens until its hello. */
  open(conn) {
    this.clients.set(conn, {
      conn, player: null, spectator: false, queued: false, helloMsg: null, hello: false, tokens: 10, tokenAt: this.now(), seen: this.now(),
      json: 0, jsonAt: this.now(), chat: 0, chatAt: this.now(), bad: 0,
    });
  }

  close(conn) {
    const c = this.clients.get(conn);
    if (!c) return;
    this.clients.delete(conn);
    const p = c.player;
    if (p) {
      p.conn = null;
      p.connected = false;
      p.droppedAt = this.now();
      p.alive = false;
      p.cooking = null;
      p.emote = 0;
      p.queue.length = 0;
      p.ready = false;
      this.log(`leave ${p.name} (#${p.id})`);
      this.say(`${p.name} left`);
      this.broadcastRoster();
    }
  }

  get empty() { return this.clients.size === 0; }

  /** Shut a connection from this end. Its client is forgotten first, so the adapter's later close() finds nothing. */
  dropConnection(conn, reason, code = CLOSE.REPLACED) {
    const c = this.clients.get(conn);
    if (!c) return;
    this.clients.delete(conn);
    if (c.player && c.player.conn === conn) { c.player.conn = null; c.player.connected = false; c.player.droppedAt = this.now(); }
    try { conn.send(JSON.stringify({ t: 'error', code, reason })); } catch { /* gone already */ }
    try { conn.close(code, reason); } catch { /* gone already */ }
  }

  /** Connections that have said nothing for LIVENESS seconds are dead networks, not quiet players. */
  reapSilent() {
    const t = this.now();
    for (const c of [...this.clients.values()]) {
      if (t - c.seen <= LIVENESS * 1000) continue;
      const p = c.player;
      this.dropConnection(c.conn, 'The connection timed out.', 1001);
      if (p) {
        p.alive = false; p.cooking = null; p.emote = 0; p.queue.length = 0; p.ready = false;
        this.log(`timeout ${p.name} (#${p.id})`);
        this.say(`${p.name} lost connection`);
        this.broadcastRoster();
      }
    }
  }

  message(conn, data) {
    const c = this.clients.get(conn);
    if (!c) return;
    this.governor.poll();   // a new UTC day first, so this message counts toward it
    c.seen = this.now();
    this.governor.add(1);
    this.stats.msgsIn++;
    this.stats.window.msgs++;
    if (typeof data === 'string') {
      this.stats.bytesIn += data.length;
      this.onJson(c, data);
    } else {
      this.stats.bytesIn += data.byteLength;
      this.onInput(c, data);
    }
  }

  send(c, data) {
    try { c.conn.send(data); } catch { /* closed under us; close() follows */ }
    const n = typeof data === 'string' ? data.length : data.byteLength;
    this.stats.bytesOut += n;
    this.stats.window.bytesOut += n;
  }

  sendJson(c, obj) { this.send(c, JSON.stringify(obj)); }

  broadcastJson(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients.values()) if (c.hello) this.send(c, s);
  }

  refuse(c, code, reason, extra = {}) {
    this.sendJson(c, { t: 'error', code, reason, ...extra });
    try { c.conn.close(code, reason); } catch { /* already gone */ }
  }

  onJson(c, text) {
    if (text.length > 1024) { this.stats.inputDropped++; return; }
    let m;
    try { m = JSON.parse(text); } catch { c.bad++; return; }
    if (!m || typeof m !== 'object') return;
    const t = this.now();
    // Chat has a bucket of its own (a line a second, bursts of three), so a spammer cannot starve
    // the lobby's ready and settings messages. Those are rare: 5 a second is plenty.
    if (m.t === 'chat') { this.onChat(c, m); return; }
    c.json = Math.max(0, c.json - (t - c.jsonAt) / 200);
    c.jsonAt = t;
    if (++c.json > 10) { this.stats.inputDropped++; return; }
    if (m.t === 'hello' && !c.hello) this.onHello(c, m);
    else if (!c.player) { /* spectators only talk */ } else if (m.t === 'ready') this.onReady(c.player, m);
    else if (m.t === 'settings') this.onSettings(c.player, m);
    else if (m.t === 'gear') this.onGear(c.player, m);
    else if (m.t === 'start') this.onStart(c.player);
    else if (m.t === 'end') this.onEnd(c.player);
    else if (m.t === 'lobby') this.onLobby(c.player);
    else if (m.t === 'kick') this.onKick(c.player, m);
    // Anything else (the client's 'ka' keepalive) is only a message: on Cloudflare, that tops up the CPU allowance.
  }

  onHello(c, m) {
    // A room closed for the day reopens here too, not only on the next tick.
    this.governor.poll();
    this.budgetCheck();
    if (m.v !== PROTOCOL_VERSION || m.hash !== this.hash) {
      this.refuse(c, CLOSE.REFRESH, 'A new version of the game is out. Refresh to update.');
      return;
    }
    if (this.phase === PHASE.CLOSED) {
      this.refuse(c, CLOSE.CLOSED, 'The server is closed for today: its free daily budget is used up.', { resetInSec: this.governor.resetIn });
      return;
    }
    if (typeof m.token === 'string' && (this.kicked.get(m.token) ?? 0) > this.now()) {
      this.refuse(c, CLOSE.KICKED, 'The host removed you from this room.');
      return;
    }
    c.hello = true;
    c.helloMsg = { name: m.name, character: m.character, loadout: m.loadout };
    let p = null;
    // A token resumes its seat: a held one, or one whose old connection is still "open" because the
    // network under it died without a close (poor wifi). Without the second case the returning
    // player was seated afresh and showed up twice.
    if (typeof m.token === 'string' && m.token) {
      p = this.players.find((q) => !q.bot && q.token === m.token) ?? null;
      if (p) {
        if (p.conn) this.dropConnection(p.conn, 'You signed in again from somewhere else.');
        this.resumeSeat(p, c);
      }
    }
    if (!p && !m.spectate && this.canSeat()) {
      p = this.newSeat(c, m);
    }
    if (!p) {
      const specs = [...this.clients.values()].filter((x) => x.spectator).length;
      if (specs >= MAX_SPECTATORS) { this.refuse(c, CLOSE.FULL, 'The server is full.'); return; }
      c.spectator = true;
      c.queued = !m.spectate;     // someone who wanted to play is seated when the next lobby opens
    }
    this.sendJson(c, {
      t: 'welcome', id: p ? p.id : null, token: p?.token ?? null, spectator: !p,
      full: c.queued && this.humanSeats().length >= this.seatLimit(), queued: c.queued,
      tick: this.tick, tickHz: TICK_HZ, snapshotHz: SNAPSHOT_HZ,
      ...this.matchInfo(),
    });
    if (p) this.say(`${p.name} joined`);
    this.broadcastRoster();
  }

  /** Seats a mode allows (a duel is two players). */
  seatLimit() { return Math.min(MAX_PLAYERS, this.phase === PHASE.LOBBY ? MAX_PLAYERS : MODE_INFO[this.mode].max); }

  /**
   * Whether a newcomer can be seated now. The lobby, the countdown and the results take anyone;
   * a round in progress takes them until the last LATE_JOIN_CUTOFF seconds, when there is no
   * point in spawning into it.
   */
  canSeat() {
    if (this.humanSeats().length >= this.seatLimit()) return false;
    if (this.phase === PHASE.PLAYING && !MODE_INFO[this.mode].untimed && this.timeLeft <= LATE_JOIN_CUTOFF) return false;
    return this.phase !== PHASE.CLOSED;
  }

  newSeat(c, m) {
    const used = new Set(this.players.map((q) => q.id));
    let id = 0;
    while (used.has(id)) id++;
    const p = this.blankSeat({
      id, conn: c.conn, connected: true, droppedAt: 0,
      token: Array.from({ length: 4 }, () => Math.floor(this.rng() * 2 ** 32).toString(36)).join(''),
      name: cleanName(m.name),
      character: CHARACTER_IDS.includes(m.character) ? m.character : CHARACTER_IDS[0],
      loadout: validLoadout(m.loadout) ? [...m.loadout] : [...DEFAULT_LOADOUT],
    });
    p.chosen = [...p.loadout];
    this.world.addBody(p.body);
    const inRound = this.phase === PHASE.PLAYING || this.phase === PHASE.COUNTDOWN;
    if (inRound && teamMode(this.mode)) p.team = this.smallerTeam();
    if (inRound) this.applyLoadout(p);
    this.players.push(p);
    c.player = p;
    this.respawn(p);
    this.log(`join ${p.name} (#${p.id})`);
    return p;
  }

  /** A seat with nothing in it yet: `fields` says who it is (a person's, or a hostile's). */
  blankSeat(fields) {
    return {
      connected: true, droppedAt: 0,
      team: TEAM.SOLO, kills: 0, deaths: 0, headshots: 0, damage: 0, captures: 0, ready: false,
      body: createPlayerBody(G_WORLD),   // players pass through each other and through grenades
      pos: new Vector3(), eye: new Vector3(), vel: new Vector3(),
      hb: HB_PLAYER, yaw: 0, pitch: 0, grounded: false, crouching: false, sprinting: false, aiming: false,
      slideTime: 0, landTime: 99, landKick: 0, airVy: 0,
      alive: false, health: 0, armor: 0, respawnTimer: 0, invulnTimer: 0,
      current: 'pistol', ammo: {}, fragCount: 3, smokeCount: 1,
      cooldown: 0, fireCarry: 0, reloading: 0, reloadTotal: 0, bloom: 0, sprayIndex: 0, sinceShot: 99,
      recoilPitch: 0, recoilYaw: 0, cooking: null, chargeTicks: 0, prevButtons: 0,
      items: emptyItems(), tiers: [0, 0, 0, 0, 0], useKind: 0, useT: 0, useWeapon: 'pistol',
      emote: 0, emoteBlock: 0,
      queue: [], lastCmd: IDLE_CMD, ackSeq: 0, ackTick: this.tick, lastSeq: 0, merge: 0, guesses: 0, minDepth: Infinity, depthAt: this.tick,
      rtt: 0, interpMs: 100, echoTime: 0, echoAt: 0,
      hist: new Float32Array(HIST * 5), histTick: new Int32Array(HIST).fill(-1),
      ...fields,
    };
  }

  resumeSeat(p, c) {
    p.conn = c.conn;
    p.connected = true;
    p.queue.length = 0;
    p.lastCmd = IDLE_CMD;
    p.lastSeq = 0; p.ackSeq = 0; p.ackTick = this.tick; p.merge = 0;
    c.player = p;
    this.respawn(p);
    this.log(`resume ${p.name} (#${p.id})`);
  }

  freeSeat(p) {
    this.world.removeBody(p.body);
    this.players.splice(this.players.indexOf(p), 1);
    this.broadcastRoster();
  }

  smallerTeam() {
    if (MODE_INFO[this.mode].coop) return TEAM.BLUE;
    let blue = 0, red = 0;
    for (const q of this.players) if (q.connected && !q.bot) { if (q.team === TEAM.BLUE) blue++; else if (q.team === TEAM.RED) red++; }
    if (blue !== red) return blue < red ? TEAM.BLUE : TEAM.RED;
    return this.rng() < 0.5 ? TEAM.BLUE : TEAM.RED;
  }

  roster() {
    return this.players.filter((p) => p.connected).map((p) => ({
      id: p.id, name: p.name, character: p.character, team: p.team, loadout: p.loadout, ready: p.ready, ...(p.bot ? { bot: true } : {}), ...(p.zombie ? { zombie: true } : {}),
    }));
  }

  /** The first seated player is the host: they choose the settings and start the round. */
  get hostSeat() { return this.players.find((p) => p.connected && !p.bot) ?? null; }

  /** The people in the room, held seats included. */
  humanSeats() { return this.players.filter((p) => !p.bot); }

  /** The people playing now. */
  humans() { return this.players.filter((p) => p.connected && !p.bot); }

  /** What the lobby screen draws besides the player list. */
  lobbyInfo() {
    return {
      host: this.hostSeat?.id ?? null, settings: this.settings, blocker: this.startBlocker(),
      spectators: [...this.clients.values()].filter((c) => c.spectator).length,
    };
  }

  broadcastRoster() {
    this.broadcastJson({ t: 'roster', players: this.roster(), ...this.lobbyInfo() });
  }

  matchInfo() {
    return {
      mode: this.mode, map: this.mapId, phase: this.phase, timeLeft: this.timeLeft, flags: flagsWire(this), zone: this.zb ? this.zb.zone : null,
      maps: MAP_IDS, modes: PLAYABLE, roster: this.roster(), ...this.lobbyInfo(),
    };
  }

  /* ----------------------------------------------------------------- chat */

  /** A line from the server itself (joins, leaves, warnings). */
  say(text) { this.broadcastJson({ t: 'chat', sys: true, text }); }

  sendFlags() { this.broadcastJson({ t: 'flags', flags: flagsWire(this) }); }

  onChat(c, m) {
    const text = String(m.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    const t = this.now();
    c.chat = Math.max(0, c.chat - (t - c.chatAt) / 1200);
    c.chatAt = t;
    if (++c.chat > 3) { this.sendJson(c, { t: 'chat', sys: true, text: 'SLOW DOWN' }); return; }
    const p = c.player;
    const inRound = this.phase === PHASE.PLAYING || this.phase === PHASE.COUNTDOWN;
    const tm = !!m.team && !!p && teamMode(this.mode) && inRound;
    const msg = JSON.stringify({ t: 'chat', id: p ? p.id : null, name: p ? p.name : 'SPECTATOR', team: p ? p.team : TEAM.SOLO, tm, text });
    for (const o of this.clients.values()) {
      if (!o.hello) continue;
      if (tm && o.player?.team !== p.team) continue;
      this.send(o, msg);
    }
  }

  /* ---------------------------------------------------------------- input */

  onInput(c, buf) {
    const p = c.player;
    if (!p) return;
    // Token bucket: 30 packets a second sustained, bursts of 10. The client sends 20 at most.
    const t = this.now();
    c.tokens = Math.min(10, c.tokens + (t - c.tokenAt) * 0.03);
    c.tokenAt = t;
    if (c.tokens < 1) { this.stats.inputDropped++; return; }
    c.tokens--;
    const pkt = decodeInput(buf);
    if (!pkt) {
      this.stats.inputBad++;
      if (++c.bad > 50) this.refuse(c, CLOSE.KICKED, 'Too many malformed packets.');
      return;
    }
    p.rtt = Math.min(1000, pkt.rtt);
    p.interpMs = pkt.interpMs;
    p.echoTime = pkt.clientTime;
    p.echoAt = t;
    // The newest tick with these low 16 bits that is not in the future.
    const vt = this.tick - ((this.tick - pkt.viewTick) & 0xffff);
    const n = pkt.cmds.length;
    for (let i = 0; i < n; i++) {
      const cmd = pkt.cmds[i];
      if (cmd.seq <= p.lastSeq && p.lastSeq - cmd.seq < 1e6) continue;   // duplicate or stale
      p.lastSeq = cmd.seq;
      cmd.viewTick = vt - (n - 1 - i);
      p.queue.push(cmd);
    }
    while (p.queue.length > QUEUE_MAX) {
      p.merge |= p.queue.shift().buttons & (ONE_SHOT_BITS | BTN.FIRE);
      this.stats.cmdsTrimmed++;
    }
  }

  /**
   * The command for this tick: the next queued one, or a repeat of the last one without its
   * one-shots. A repeat does not use up a sequence number, so a packet that arrives late is
   * played in full, a tick later; that is how the queue grows into a jitter buffer. A queue
   * that stays more than a packet deep for a whole second is trimmed back, so the buffer only
   * ever holds the jitter actually seen. A player who goes quiet mid-action (a stalled tab, a
   * dead link) stands still after MAX_GUESS ticks rather than run on.
   *
   * An idle client stops sending altogether (src/net/client.js); its last command was the idle
   * one, so the repeat is exactly what it is simulating too.
   */
  nextCommand(p) {
    p.minDepth = Math.min(p.minDepth, p.queue.length);
    if (this.tick - p.depthAt >= TICK_HZ) {
      const perPacket = Math.ceil(TICK_HZ / this.governor.inputRate);
      for (let k = p.minDepth - perPacket; k > 0 && p.queue.length > 1; k--) {
        p.merge |= p.queue.shift().buttons & (ONE_SHOT_BITS | BTN.FIRE);
        this.stats.cmdsTrimmed++;
      }
      p.minDepth = Infinity;
      p.depthAt = this.tick;
    }
    let cmd;
    if (p.queue.length) {
      cmd = p.queue.shift();
      if (p.merge) { cmd = { ...cmd, buttons: cmd.buttons | p.merge }; p.merge = 0; }
      p.ackSeq = cmd.seq;
      p.ackTick = this.tick;
      p.guesses = 0;
    } else {
      const last = p.lastCmd;
      cmd = { ...last, buttons: last.buttons & ~ONE_SHOT_BITS, viewTick: last.viewTick + 1 };
      if (last.ix || last.iz || (last.buttons & ~ONE_SHOT_BITS)) {
        this.stats.cmdsRepeated++;
        if (++p.guesses > MAX_GUESS) cmd = { ...cmd, ix: 0, iz: 0, buttons: 0 };
      }
    }
    p.lastCmd = cmd;
    return cmd;
  }

  /* ----------------------------------------------------------------- time */

  /** Run every fixed tick wall time owes, then send a snapshot if one is due. Returns ticks run. */
  update() {
    const t = this.now();
    const gap = t - this.last;
    this.last = t;
    this.stats.gaps.push(gap);
    if (this.stats.gaps.length > 2000) this.stats.gaps.splice(0, 1000);
    this.acc += gap;
    let n = 0;
    while (this.acc >= STEP_MS && n < MAX_CATCHUP) { this.step(); this.acc -= STEP_MS; n++; }
    if (this.acc > STEP_MS * MAX_CATCHUP) { this.stats.ticksDropped += Math.floor(this.acc / STEP_MS); this.acc = 0; }
    if (this.snapDue) { this.snapDue = false; this.sendSnapshots(); }
    this.governor.poll();
    this.budgetCheck();
    if (t - this.stats.window.at >= 1000) {
      const w = this.stats.window, s = (t - w.at) / 1000;
      this.stats.rate = { msgsInPerSec: +(w.msgs / s).toFixed(1), bytesOutPerSec: Math.round(w.bytesOut / s), ticksPerSec: +(w.ticks / s).toFixed(1) };
      this.stats.window = { at: t, msgs: 0, bytesOut: 0, ticks: 0 };
    }
    return n;
  }

  /** The adapter reports what an update cost, measured with its own clock. */
  recordCost(ms, ticks) {
    if (ticks <= 0) return;
    this.stats.costMs.push(ms / ticks);
    if (this.stats.costMs.length > 2000) this.stats.costMs.splice(0, 1000);
  }

  step() {
    this.tick++;
    this.stats.ticks++;
    this.stats.window.ticks++;
    const dt = FIXED_DT;
    const armed = this.phase === PHASE.PLAYING;
    // Before the match nobody walks: the lobby is a menu and the countdown a hold on the start line.
    const frozen = this.phase === PHASE.LOBBY || this.phase === PHASE.COUNTDOWN;
    for (const p of this.players) {
      if (!p.connected) continue;
      let cmd = p.bot ? botCommand(this, p) : this.nextCommand(p);
      if (frozen && (cmd.ix || cmd.iz || cmd.buttons || cmd.emote)) cmd = { ...cmd, ix: 0, iz: 0, buttons: 0, emote: 0 };
      applyCommand(this.world, p, p.cmd = cmd, dt, armed, this);
      if (!p.bot) this.stepItems(p, cmd, armed);
    }
    this.world.step(dt);
    const slot = this.tick % HIST;
    for (const p of this.players) {
      if (!p.connected) continue;
      const b = p.body;
      p.vel.set(b.velocity.x, b.velocity.y, b.velocity.z);
      syncPlayerPoints(p);
      if (b.position.y < -20) this.respawn(p, p.bot ? this.pickBotSpawn() : undefined);   // fell out of the world
      const h = p.hist, k = slot * 5;
      h[k] = p.pos.x; h[k + 1] = p.pos.y; h[k + 2] = p.pos.z; h[k + 3] = p.crouching ? 1 : 0; h[k + 4] = p.alive ? 1 : 0;
      p.histTick[slot] = this.tick;
      this.stepEmote(p);
    }
    this.stepBullets(dt, -1);
    this.stepGrenades(dt);
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      if ((this.smokes[i].t += dt) >= CONFIG.SMOKE_LIFE) this.smokes.splice(i, 1);
    }
    if (this.phase === PHASE.PLAYING) {
      this.stepPickups(dt);
      for (const p of this.players) {
        if (p.connected && !p.bot && !p.alive && p.respawnTimer > 0) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) this.respawn(p);
        }
      }
      if (this.mode === 'ctf') ctfStep(this, dt);
      if (this.mode === 'duel') this.stepDuel(dt);
      else if (this.mode === 'survival') this.stepSurvival(dt);
      else if (this.mode === 'zombie') this.stepZombie(dt);
      else if (this.mode !== 'war' && (this.timeLeft -= dt) <= 0) this.endOnTime();
    } else if (this.phase === PHASE.COUNTDOWN) {
      if (this.seated().length < MODE_INFO[this.mode].min) this.toLobby('NOT ENOUGH PLAYERS');
      else if ((this.timeLeft -= dt) <= 0) this.beginPlay();
    } else if (this.phase === PHASE.INTERMISSION) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.toLobby();
    }
    if (this.tick % TICK_HZ === 0) {
      const t = this.now();
      this.reapSilent();
      for (const p of [...this.players]) {
        if (!p.bot && !p.connected && t - p.droppedAt > RECONNECT_GRACE * 1000) this.freeSeat(p);
      }
      for (const [token, until] of this.kicked) if (until <= t) this.kicked.delete(token);
      this.checkAlone();
    }
    if (this.tick % SNAP_EVERY === 0) this.snapDue = true;
  }

  /**
   * A round of a mode that needs company, with the company gone: after a short grace (a friend's
   * wifi blip should not end it) everyone still here goes back to the lobby, instead of playing
   * on alone against nobody. A duel decides this itself (the one who stayed wins).
   */
  checkAlone() {
    const need = MODE_INFO[this.mode].min;
    if (this.phase !== PHASE.PLAYING || need < 2 || this.mode === 'duel' || this.humans().length >= need) { this.aloneFor = 0; return; }
    if (++this.aloneFor >= ALONE_GRACE) { this.aloneFor = 0; this.toLobby('EVERYONE ELSE LEFT'); }
  }

  /**
   * Healing items: the command holds the item's number in its upper button bits for as long as
   * the channel runs (src/sim/items.js has the rules). Anything that takes your hands cancels it.
   */
  stepItems(p, cmd, armed) {
    const sel = (cmd.buttons & ITEM_MASK) >> ITEM_SHIFT;
    if (!armed) { cancelUse(p); return; }
    const busy = (cmd.buttons & (BTN.FIRE | BTN.FRAG | BTN.SMOKE)) !== 0 || !!p.cooking || cmd.emote !== 0
      || (p.useKind !== 0 && p.current !== p.useWeapon);
    const r = stepUse(p, sel, busy, FIXED_DT);
    if (r === USE.START) p.useWeapon = p.current;
  }

  /** Emotes run until the player does anything, as in src/emotes.js; the server enforces it. */
  stepEmote(p) {
    const want = p.cmd?.emote ?? 0;
    const v = p.body.velocity;
    const busy = !p.alive || p.useKind !== 0 || (p.cmd.buttons & BTN.FIRE) || Math.hypot(v.x, v.z) > 1.2 || v.y > 1.5;
    if (want === 0) { p.emote = 0; p.emoteBlock = 0; return; }
    if (p.emote === want) {
      if (busy) { p.emote = 0; p.emoteBlock = want; }
      return;
    }
    if (want !== p.emoteBlock && !busy && p.grounded) p.emote = want;
  }

  /* --------------------------------------------------------------- combat */

  /** stepWeapons calls this for a shot: real projectiles, rewound to what the shooter saw. */
  fire(p, w, cone) {
    const aim = aimDirection(p, new Vector3());
    this.events.push({ kind: EV.SHOT, shooter: p.id, weapon: w.id, o: p.eye.clone(), d: aim, seed: 0 });
    const rewind = Math.max(0, Math.min(MAX_REWIND, this.tick - (p.cmd?.viewTick ?? this.tick)));
    for (let k = 0; k < w.pellets; k++) {
      const d = aim.clone();
      if (cone > 0) {
        d.x += (this.rng() * 2 - 1) * cone;
        d.y += (this.rng() * 2 - 1) * cone;
        d.z += (this.rng() * 2 - 1) * cone;
        d.normalize();
      }
      const b = { pos: p.eye.clone(), prev: p.eye.clone(), vel: d.multiplyScalar(w.speed), travelled: 0, damage: (p.bot ? (w.botDamage ?? w.damage) : w.damage * tierMult(p.tiers[WEAPON_IDS.indexOf(w.id)])) * (p.dmgMult ?? 1), owner: p, weapon: w.id };
      // Fly it through the ticks the shooter was behind, against where everyone was then.
      let gone = false;
      for (let j = rewind; j >= 1 && !gone; j--) gone = this.stepBullet(b, FIXED_DT, this.tick - j);
      if (!gone) this.bullets.push(b);
    }
  }

  reload() { /* the client plays its own click */ }

  throw(p, kind) {
    const dir = new Vector3();
    const power = throwAim(p, dir);
    const o = p.eye.clone().addScaledVector(dir, 0.7);
    const body = new CANNON.Body({
      mass: 0.4, material: MAT_NADE, shape: new CANNON.Sphere(0.06),
      linearDamping: 0.01, angularDamping: 0.22, collisionFilterGroup: G_NADE,
    });
    body.position.set(o.x, o.y, o.z);
    launchVelocity(p.body.velocity, dir, power, body.velocity);
    const spin = 11 + power * 0.25;
    body.angularVelocity.set(-dir.z * spin, this.rng() * 4 - 2, dir.x * spin);
    this.world.addBody(body);
    this.grenades.push({ id: this.entityId(), kind, body, owner: p, fuse: kind === 'frag' ? CONFIG.FRAG_FUSE : CONFIG.SMOKE_FUSE });
    this.events.push({ kind: EV.THROW, who: p.id, what: kind === 'frag' ? 1 : 2 });
  }

  entityId() { this.nextEntity = (this.nextEntity + 1) % 255; return this.nextEntity; }

  /** Where `q` was at `frame` (or now, for frame -1): its chest into _hist, its hitbox returned. */
  hitboxAt(q, frame) {
    if (frame < 0) { _hist.x = q.pos.x; _hist.y = q.pos.y; _hist.z = q.pos.z; return q.alive ? q.hb : null; }
    const slot = frame % HIST;
    if (q.histTick[slot] !== frame) return null;
    const h = q.hist, k = slot * 5;
    if (!h[k + 4]) return null;
    _hist.x = h[k]; _hist.y = h[k + 1]; _hist.z = h[k + 2];
    return h[k + 3] ? HB_PLAYER_CROUCH : HB_PLAYER;
  }

  /** One tick of one bullet, against hitboxes at `frame` (-1 = live). True when it is spent. */
  stepBullet(b, dt, frame) {
    b.prev.copy(b.pos);
    b.vel.y += CONFIG.GRAVITY * dt;
    _v.copy(b.vel).multiplyScalar(dt);
    b.pos.add(_v);
    const len = _v.length();
    if (len < 1e-6) return false;
    _dir.copy(_v).divideScalar(len);

    let best = null, bestT = Infinity, bestZone = 'body';
    const owner = b.owner;
    for (const q of this.players) {
      if (q === owner || !q.connected || !q.alive) continue;
      if (teamMode(this.mode) && q.team === owner.team) continue;
      const hb = this.hitboxAt(q, frame);
      if (!hb) continue;
      const t = analyticHit(b.prev, _dir, len, _hist, hb);
      if (t >= 0 && t < bestT) { bestT = t; best = q; bestZone = analyticHit.zone; }
    }
    _from.set(b.prev.x, b.prev.y, b.prev.z);
    _to.set(b.pos.x, b.pos.y, b.pos.z);
    _ray.reset();
    this.world.raycastClosest(_from, _to, RAY_OPTS, _ray);
    const wallT = _ray.hasHit ? _ray.distance : Infinity;
    if (best && bestT <= wallT) {
      _hp.copy(b.prev).addScaledVector(_dir, bestT);
      const base = owner.bot ? b.damage : damageAt(WEAPON_BY_ID[b.weapon], b.travelled + bestT, b.damage);
      this.applyDamage(best, base * (PLAYER_ZONE_MULT[bestZone] ?? 1), owner, _hp, bestZone === 'head', bestZone, b.weapon);
      return true;
    }
    if (_ray.hasHit) return true;
    b.travelled += len;
    return b.travelled > CONFIG.MAX_RANGE;
  }

  stepBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      if (this.stepBullet(this.bullets[i], dt, -1)) this.bullets.splice(i, 1);
    }
  }

  applyDamage(target, amount, source, at, headshot, zone, weapon) {
    if (!target.alive || this.phase !== PHASE.PLAYING) return;
    if (target.invulnTimer > 0) return;
    let dmg = amount, soaked = 0;
    if (source && source !== target) source.damage += Math.min(amount, target.health + target.armor);
    if (target.armor > 0) {
      soaked = Math.min(target.armor, dmg * CONFIG.ARMOR_ABSORB);
      target.armor -= soaked;
      dmg -= soaked;
    }
    target.health -= dmg;
    const lethal = target.health <= 0;
    this.events.push({
      kind: EV.HIT, attacker: source ? source.id : NO_ID, victim: target.id, dmg, zone: Math.max(0, ZONE_IDS.indexOf(zone)),
      flags: (soaked > 0 ? HIT_SHIELD : 0) | (soaked > 0 && target.armor <= 0 ? HIT_BREAK : 0) | (lethal ? HIT_LETHAL : 0),
      p: { x: at.x, y: at.y, z: at.z },
    });
    if (lethal) {
      target.health = 0;
      this.kill(target, source, headshot, weapon);
    }
  }

  kill(target, source, headshot, weapon) {
    if (source && source !== target) {
      source.kills++;
      if (headshot) source.headshots++;
      if (this.mode === 'tdm' && source.team !== target.team) {
        if (source.team === TEAM.BLUE) this.scoreA++; else if (source.team === TEAM.RED) this.scoreB++;
      }
    }
    target.deaths++;
    target.alive = false;
    if (this.mode === 'ctf') ctfDrop(this, target);
    target.respawnTimer = this.mode === 'duel' || this.mode === 'survival' ? 0 : this.mode === 'zombie' ? ZB.REINFORCE : CONFIG.PLAYER_RESPAWN;   // a duel death lasts until the round resets, a survival death until the next wave
    if (target.bot) target.removeAt = this.tick + 5 * TICK_HZ;
    target.cooking = null;
    target.emote = 0;
    cancelUse(target);
    this.dropLoot(target);
    this.idleCommand(target);
    const w = weapon ?? 'frag';
    const dist = source && source !== target ? source.pos.distanceTo(target.pos) : 0;
    const flags = source && source !== target
      ? killFlags({ weapon: w, zoom: !!WEAPONS.find((x) => x.id === w)?.zoom, scoped: source.aiming, dist, airborne: !source.grounded })
      : 0;
    this.events.push({ kind: EV.KILL, killer: source ? source.id : NO_ID, victim: target.id, head: !!headshot, weapon: w, flags, dist });
    if (this.mode === 'duel') this.duelRoundEnd(this.otherDuelist(target));
    else this.checkWin();
  }

  losClear(a, b) {
    _from.set(a.x, a.y, a.z);
    _to.set(b.x, b.y, b.z);
    _ray.reset();
    this.world.raycastClosest(_from, _to, RAY_OPTS, _ray);
    return !_ray.hasHit;
  }

  /** A frag going off: the same falloff, cover and team rules as single player's explode(). */
  explode(pos, owner) {
    this.events.push({ kind: EV.EXPLODE, p: { x: pos.x, y: pos.y, z: pos.z } });
    const live = this.players.includes(owner) ? owner : null;
    for (const q of this.players) {
      if (!q.connected || !q.alive) continue;
      if (live && q !== live && teamMode(this.mode) && q.team === live.team) continue;
      const d = q.pos.distanceTo(pos);
      if (d > CONFIG.FRAG_RADIUS) continue;
      if (!this.losClear(pos, q.pos)) continue;
      const dmg = CONFIG.FRAG_DAMAGE * (1 - d / CONFIG.FRAG_RADIUS);
      if (dmg > 1) this.applyDamage(q, dmg, live, q.pos, false, 'body', 'frag');
    }
    for (const q of this.players) {
      if (!q.connected || !q.alive) continue;
      _v.set(q.body.position.x - pos.x, q.body.position.y - pos.y, q.body.position.z - pos.z);
      const d = _v.length();
      if (d > CONFIG.FRAG_RADIUS * 1.6 || d < 1e-3) continue;
      _v.divideScalar(d);
      const mag = CONFIG.FRAG_IMPULSE / (d * d + 1);
      q.body.applyImpulse(new CANNON.Vec3(_v.x * mag, (_v.y + 0.45) * mag, _v.z * mag));
    }
  }

  stepGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const v = g.body.velocity;
      const planar = Math.hypot(v.x, v.z);
      if (planar > 0.02 && Math.abs(v.y) < 1.2 && planar < NADE_ROLL_SPEED) {
        const decay = Math.pow(0.12, dt);
        v.x *= decay; v.z *= decay;
        g.body.angularVelocity.scale(decay, g.body.angularVelocity);
      }
      g.fuse -= dt;
      if (g.fuse > 0) continue;
      const pos = new Vector3(g.body.position.x, g.body.position.y, g.body.position.z);
      if (g.kind === 'smoke') this.smokes.push({ id: g.id, pos, t: 0 });
      else if (this.phase === PHASE.PLAYING) this.explode(pos, g.owner);
      this.world.removeBody(g.body);
      this.grenades.splice(i, 1);
    }
  }

  /** A kill leaves something on the floor: a gun of some tier, or a few healing items. Never in a duel. */
  dropLoot(victim) {
    if (this.mode === 'duel') return;
    if (victim.zombie && this.rng() > 0.35) return;     // the dead carry little, and never a gun
    if (this.drops.length >= MAX_DROPS) this.drops.shift();
    const id = victim.current === 'frag' ? victim.loadout[0] : victim.current;
    const luck = this.mode === 'survival' && this.sv ? Math.min(0.25, this.sv.wave * 0.02) : 0;
    const d = victim.zombie ? rollDrop(0, 0.99, this.rng()) : rollDrop(Math.max(0, WEAPON_IDS.indexOf(id)), this.rng(), this.rng(), luck);
    this.nextDrop = (this.nextDrop + 1) % 250;
    this.drops.push({
      id: this.nextDrop, ...d, life: DROP_LIFE,
      x: victim.body.position.x, y: victim.body.position.y - CONFIG.PLAYER_RADIUS + 0.35, z: victim.body.position.z,
    });
  }

  /** Try to hand `d` to `p`: an upgrade or ammo for a gun, room in the bag for items. False leaves it on the floor. */
  takeDrop(p, d) {
    if (d.type === 1) return addItem(p, d.a, d.b) > 0;
    const w = WEAPON_BY_ID[WEAPON_IDS[d.a]];
    const a = p.ammo[w.id];
    if (!a) return false;
    const upgrade = d.b > p.tiers[d.a];
    if (!upgrade && a.mag >= w.mag && a.reserve >= w.reserve * 1.5) return false;
    if (upgrade) p.tiers[d.a] = d.b;
    a.mag = w.mag;
    a.reserve = Math.min(w.reserve * 1.5, a.reserve + Math.ceil(w.mag * 1.5));
    return true;
  }

  stepPickups(dt) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if ((d.life -= dt) <= 0) { this.drops.splice(i, 1); continue; }
      for (const p of this.players) {
        if (!p.connected || !p.alive || p.bot) continue;
        const b = p.body.position;
        if (Math.hypot(b.x - d.x, b.z - d.z) > DROP_RANGE || Math.abs(b.y - d.y) > 2) continue;
        if (!this.takeDrop(p, d)) continue;
        this.events.push({ kind: EV.PICKUP, who: p.id, what: 2, index: d.id });
        this.drops.splice(i, 1);
        break;
      }
    }
    this.chests.forEach((c, index) => {
      if (c.cooldown > 0) { c.cooldown -= dt; return; }
      for (const p of this.players) {
        if (!p.connected || !p.alive || p.bot) continue;
        const b = p.body.position;
        if (Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z) > CHEST_RANGE) continue;
        const w = WEAPONS.find((x) => x.id === p.current);
        const a = p.ammo[w.id];
        if (a) {
          a.mag = w.mag;
          a.reserve = Math.min(w.reserve * 1.5, a.reserve + Math.ceil(w.reserve * 0.3));
        }
        p.fragCount = Math.min(3, p.fragCount + 1);
        c.cooldown = CHEST_RESPAWN;
        this.events.push({ kind: EV.PICKUP, who: p.id, what: 0, index });
        return;
      }
    });
    this.consumables.forEach((c, index) => {
      if (c.cooldown > 0) { c.cooldown -= dt; return; }
      const loot = lootFor(c.kind, index);
      for (const p of this.players) {
        if (!p.connected || !p.alive || p.bot || !canCarry(p, loot.item)) continue;
        const b = p.body.position;
        if (Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z) > 1.5) continue;
        addItem(p, loot.item, loot.qty);
        c.cooldown = CONSUMABLE_RESPAWN[c.kind] ?? 30;
        this.events.push({ kind: EV.PICKUP, who: p.id, what: 1, index });
        return;
      }
    });
  }

  /** Furthest from every living enemy, with jitter: main.js's pickSpawn. */
  pickSpawn(p) {
    const pool = this.mode === 'survival' || this.mode === 'zombie' ? this.humanSpawns
      : this.mode === 'ctf' && this.sideSpawns[p.team]?.length ? this.sideSpawns[p.team] : this.spawns;
    let best = pool[0], bestScore = -Infinity;
    for (const sp of pool) {
      let score = Infinity;
      for (const q of this.players) {
        if (q === p || !q.connected || !q.alive) continue;
        if (teamMode(this.mode) && q.team === p.team) continue;
        const dx = q.pos.x - sp.x, dy = q.pos.y - sp.y, dz = q.pos.z - sp.z;
        score = Math.min(score, dx * dx + dy * dy + dz * dz);
      }
      if (score === Infinity) score = 1e6;
      score += this.rng() * 120;
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    return best;
  }

  respawn(p, sp = this.pickSpawn(p)) {
    const b = p.body;
    b.position.set(sp.x, sp.y + 0.6, sp.z);
    b.velocity.set(0, 0, 0);
    p.slideTime = 0;
    setCrouch(this.world, p, false);
    syncPlayerPoints(p);
    p.alive = true;
    p.health = CONFIG.MAX_HEALTH;
    p.armor = CONFIG.START_ARMOR;
    p.respawnTimer = 0;
    p.invulnTimer = SPAWN_INVULN;
    p.cooking = null;
    p.reloading = 0;
    p.cooldown = 0.4;
    p.bloom = 0; p.sprayIndex = 0; p.recoilPitch = 0; p.recoilYaw = 0;
    resetAmmo(p);
    p.current = p.loadout[0];
    p.pitch = 0;
    p.yaw = Math.atan2(sp.x, sp.z);
    p.emote = 0;
    this.idleCommand(p);
    // History before this tick belongs to the previous life.
    p.histTick.fill(-1);
    this.events.push({ kind: EV.SPAWN, id: p.id });
  }

  /**
   * Death and respawn forget the held command: a client sends nothing while dead, and the
   * repeat must not run a fresh spawn forward with the keys the last life died holding.
   */
  idleCommand(p) {
    p.lastCmd = { ...IDLE_CMD, seq: p.ackSeq, yawQ: quantYaw(p.yaw), weapon: Math.max(0, WEAPON_IDS.indexOf(p.current)), viewTick: this.tick };
  }

  /* ---------------------------------------------------------------- match */

  seated() { return this.players.filter((p) => p.connected && !p.bot); }

  /** Why the host cannot start the round yet, or null when they can. */
  startBlocker() {
    if (this.phase !== PHASE.LOBBY) return 'ROUND IN PROGRESS';
    const seated = this.seated(), info = MODE_INFO[this.settings.mode];
    if (seated.length < info.min) return `NEEDS ${info.min} PLAYERS`;
    if (seated.length > info.max) return `${info.label} IS FOR ${info.max} PLAYERS`;
    const waiting = seated.filter((p) => p !== this.hostSeat && !p.ready).length;
    if (waiting) return `WAITING FOR ${waiting} PLAYER${waiting > 1 ? 'S' : ''} TO READY UP`;
    return null;
  }

  onReady(p, m) {
    if (this.phase !== PHASE.LOBBY) return;
    p.ready = !!m.ready;
    this.broadcastRoster();
  }

  /** The locker, opened in the lobby: a new skin and loadout, shown to everyone at once. */
  onGear(p, m) {
    if (this.phase !== PHASE.LOBBY) return;
    if (CHARACTER_IDS.includes(m.character) && m.character !== CHARACTER_IDS[0]) p.character = m.character;
    if (validLoadout(m.loadout)) { p.loadout = [...m.loadout]; p.chosen = [...m.loadout]; }
    this.broadcastRoster();
  }

  onSettings(p, m) {
    if (this.phase !== PHASE.LOBBY || p !== this.hostSeat) return;
    this.settings = cleanSettings(m, this.settings, MAP_DATA);
    this.broadcastRoster();
  }

  /** Warzone has no clock and no limit: the host ends it, and the standings are the result. */
  onEnd(p) {
    if (p !== this.hostSeat || this.phase !== PHASE.PLAYING || !MODE_INFO[this.mode].untimed) return;
    this.endOnTime();
  }

  /** The host calls everyone back to the lobby, from any phase and any mode, to change the mode or map. */
  onLobby(p) {
    if (p !== this.hostSeat || this.phase === PHASE.LOBBY || this.phase === PHASE.CLOSED) return;
    this.toLobby('THE HOST SENT EVERYONE BACK TO THE LOBBY');
  }

  /**
   * The host removes a player (a stuck or doubled-up seat, or someone being a nuisance). The seat is
   * freed at once rather than held for a reconnect, and the same token is refused for a while.
   */
  onKick(p, m) {
    if (p !== this.hostSeat) return;
    const target = this.players.find((q) => !q.bot && q.id === m.id);
    if (!target || target === p) return;
    this.kicked.set(target.token, this.now() + KICK_BAN * 1000);
    const conn = target.conn;
    if (conn) this.dropConnection(conn, 'The host removed you from this room.', CLOSE.KICKED);
    this.log(`kick ${target.name} (#${target.id})`);
    this.say(`${target.name} was removed by the host`);
    this.freeSeat(target);
  }

  onStart(p) {
    if (p !== this.hostSeat) return;
    if (this.startBlocker()) { this.broadcastRoster(); return; }
    this.prepareRound(this.settings.mode, this.settings.map);
    this.phase = PHASE.COUNTDOWN;
    this.timeLeft = COUNTDOWN;
    this.broadcastJson({ t: 'match', ...this.matchInfo() });
    this.log(`countdown: ${this.mode} on ${this.mapId}`);
  }

  /** The loadout a round is played with: each player's own, or the one gun the host chose. */
  applyLoadout(p) {
    p.loadout = this.settings.weapons === 'loadout' ? [...p.chosen] : [this.settings.weapons];
  }

  /** Everything a round starts from: the map, teams, loadouts, scores and everyone at a spawn. */
  prepareRound(mode, mapId) {
    if (mapId !== this.mapId) this.loadMap(mapId);
    this.clearBots();
    this.sv = null; this.zb = null;
    this.mode = mode;
    this.scoreA = 0; this.scoreB = 0;
    this.flags = [];
    for (const g of this.grenades) this.world.removeBody(g.body);
    this.grenades = []; this.bullets = []; this.smokes = []; this.drops = [];
    for (const c of this.chests) c.cooldown = 0;
    for (const c of this.consumables) c.cooldown = 0;
    // Teams are dealt afresh each round: shuffled, then alternated.
    const seated = this.seated();
    for (let i = seated.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [seated[i], seated[j]] = [seated[j], seated[i]];
    }
    // A duel has no friendly-fire rules, but its two sides carry the blue and red colours and scores.
    seated.forEach((p, i) => { p.team = MODE_INFO[mode].coop ? TEAM.BLUE : teamScore(mode) ? (i % 2 ? TEAM.RED : TEAM.BLUE) : TEAM.SOLO; });
    if (mode === 'ctf') ctfInit(this);
    if (mode === 'survival') this.sv = { wave: 0, state: 'break', breakT: 4, queue: 0, cap: 8, spawnIn: 0, counter: 0, nextId: BOT_ID0 };
    if (mode === 'zombie') this.zb = { zone: this.pickZone(), age: 0, hold: 0, open: false, spawnIn: ZB.FIRST_SPAWN, counter: 0, nextId: BOT_ID0 };
    for (const p of this.players) {
      p.kills = 0; p.deaths = 0; p.headshots = 0; p.damage = 0; p.captures = 0; p.ready = false;
      this.applyLoadout(p);
      if (p.connected) this.respawn(p);
    }
  }

  beginPlay() {
    this.phase = PHASE.PLAYING;
    this.timeLeft = MODE_INFO[this.mode].untimed ? 0 : this.settings.time;
    this.roundReset = 0;
    if (this.mode === 'duel') this.startDuelRound();
    this.log(`round: ${this.mode} on ${this.mapId}`);
  }

  /* ------------------------------------------------------------- survival */

  /** Take every hostile out of the room; the clients are told on the next roster. */
  clearBots() {
    let any = false;
    for (let i = this.players.length - 1; i >= 0; i--) {
      const p = this.players[i];
      if (!p.bot) continue;
      this.world.removeBody(p.body);
      this.players.splice(i, 1);
      any = true;
    }
    if (any) this.broadcastRoster();
  }

  /** Far from every living person, out of their sight if it can be, and not on top of another hostile. */
  pickBotSpawn() {
    const people = this.humans().filter((q) => q.alive);
    let best = this.spawns[0], bs = -Infinity;
    const at = { x: 0, y: 0, z: 0 };
    for (const sp of this.spawns) {
      if (this.mapDef.svHumans && this.humanSpawns.includes(sp)) continue;   // the people's own spot, never the hostiles'
      if (this.zb && Math.hypot(sp.x - this.zb.zone.x, sp.z - this.zb.zone.z) < ZB.ZONE_R * 2.4) continue;   // nothing is born in the extraction zone
      if (this.players.some((q) => q.bot && q.alive && Math.hypot(q.pos.x - sp.x, q.pos.z - sp.z) < 2.5)) continue;
      let d = Infinity;
      for (const q of people) d = Math.min(d, Math.hypot(q.pos.x - sp.x, q.pos.z - sp.z));
      if (d === Infinity) d = 50;
      at.x = sp.x; at.y = sp.y + 0.8; at.z = sp.z;
      const seen = d < 70 && people.some((q) => this.losClear(at, q.pos));
      const score = Math.min(d, 60) - (seen ? 40 : 0) + this.rng() * 12;
      if (score > bs) { bs = score; best = sp; }
    }
    return best;
  }

  spawnBot(zombie = false) {
    const sv = zombie ? this.zb : this.sv;
    const spec = zombie ? zombieSpec(sv.age, this.rng) : botSpec(sv.wave, this.rng);
    const used = new Set(this.players.map((q) => q.id));
    let id = sv.nextId;
    for (let k = 0; k < BOT_IDS && used.has(id); k++) id = BOT_ID0 + ((id - BOT_ID0 + 1) % BOT_IDS);
    if (used.has(id)) return false;
    sv.nextId = BOT_ID0 + ((id - BOT_ID0 + 1) % BOT_IDS);
    const p = this.blankSeat({
      id, conn: null, bot: true, token: '', name: `${zombie ? 'ZOMBIE' : 'HOSTILE'} ${(sv.counter++ % 99) + 1}`, zombie,
      character: BOT_SKINS[Math.floor(this.rng() * BOT_SKINS.length)] ?? CHARACTER_IDS[0],
      loadout: [spec.weapon], team: TEAM.RED, dmgMult: spec.dmg, ai: newAi(spec, this.rng),
    });
    p.chosen = [spec.weapon];
    this.world.addBody(p.body);
    this.players.push(p);
    const sp = this.pickBotSpawn();
    this.respawn(p, sp);
    p.health = spec.health; p.armor = 0; p.invulnTimer = 0.4; p.fragCount = 0; p.smokeCount = 0;
    p.ai.yaw = Math.atan2(sp.x, sp.z);
    this.rosterDirty = true;
    return true;
  }

  startWave(w) {
    const sv = this.sv, people = this.humans();
    sv.wave = w; sv.state = 'wave';
    // The break is when the dead come back and the living catch their breath.
    for (const p of people) {
      if (!p.alive) { this.respawn(p); continue; }
      p.health = Math.min(CONFIG.MAX_HEALTH, p.health + 40);
      p.armor = Math.min(CONFIG.MAX_ARMOR, p.armor + 25);
      const { items, tiers } = p;
      resetAmmo(p);
      p.items = items; p.tiers = tiers;     // the between-wave refill keeps what you found
    }
    const n = Math.max(1, people.length);
    sv.queue = Math.min(80, Math.round((2 + 2 * w) * (1 + 0.5 * (n - 1))));
    sv.cap = Math.min(12, 6 + 2 * n);
    sv.spawnIn = 0;
    const text = `WAVE ${w} \u2014 ${sv.queue} HOSTILES`;
    this.say(text);
    this.broadcastJson({ t: 'toast', text });
  }

  /** Corpses stay a few seconds for the death animation, then the seat is freed. */
  sweepCorpses() {
    for (let i = this.players.length - 1; i >= 0; i--) {
      const p = this.players[i];
      if (p.bot && !p.alive && this.tick >= p.removeAt) {
        this.world.removeBody(p.body);
        this.players.splice(i, 1);
        this.rosterDirty = true;
      }
    }
  }

  /* ------------------------------------------------------------- zombie escape */

  /** The extraction zone: the spawn furthest from the people's start that they can actually walk to. */
  pickZone() {
    const home = this.humanSpawns[0];
    const far = (sp) => (sp.x - home.x) ** 2 + (sp.z - home.z) ** 2;
    const cands = this.spawns.filter((sp) => !this.humanSpawns.includes(sp)).sort((a, b) => far(b) - far(a));
    const sp = cands.find((c) => !this.nav || findPath(this.nav, home.x, home.z, c.x, c.z)) ?? cands[0] ?? home;
    return { x: sp.x, y: sp.y, z: sp.z, r: ZB.ZONE_R };
  }

  stepZombie(dt) {
    const zb = this.zb;
    if (!zb) return;
    zb.age += dt;
    this.sweepCorpses();
    const people = this.humans(), living = people.filter((p) => p.alive);
    const zombies = this.players.filter((p) => p.zombie && p.alive);
    if (people.length && !living.length) { this.endMatch('OVERRUN', 'Every survivor fell', { team: TEAM.RED }); return; }
    if ((this.timeLeft -= dt) <= 0) { this.endMatch('OVERRUN', 'The zone was never held', { team: TEAM.RED }); return; }
    if (!zb.open && zb.age >= ZB.OPEN_AT) {
      zb.open = true;
      this.say('EXTRACTION IS OPEN \u2014 REACH THE ZONE AND HOLD IT');
      this.broadcastJson({ t: 'toast', text: 'EXTRACTION OPEN \u2014 HOLD THE ZONE' });
    }
    const z = zb.zone;
    const inside = zb.open && living.some((p) => Math.hypot(p.pos.x - z.x, p.pos.z - z.z) < z.r && Math.abs(p.pos.y - z.y) < 3);
    zb.hold = inside ? zb.hold + dt : Math.max(0, zb.hold - dt * 0.5);
    if (zb.hold >= ZB.HOLD) { this.endMatch('ESCAPED', `${living.length} survivor${living.length === 1 ? '' : 's'} made it out`, { team: TEAM.BLUE }); return; }
    // The score words: how far the hold has got (0 while the zone is locked), and how many of the dead are about.
    this.scoreA = zb.open ? 1 + Math.round(zb.hold * 10) : 0;
    this.scoreB = zombies.length;
    // More of them as the minutes pass, and a surge while the zone is being held.
    const cap = Math.min(28, Math.round((5 + 3 * living.length + zb.age / 25) * (zb.hold > 0 ? 1.4 : 1)));
    if (living.length && zombies.length < cap && (zb.spawnIn -= dt) <= 0) {
      this.spawnBot(true);
      zb.spawnIn = ZB.SPAWN_EVERY;
    }
    // Claws: whoever is in reach and in sight of a zombie gets hit, once a swing.
    const now = this.tick / TICK_HZ;
    for (const m of zombies) {
      if (now < (m.ai.clawAt ?? 0)) continue;
      let tgt = null, bd = ZB.CLAW_RANGE * ZB.CLAW_RANGE;
      for (const q of living) {
        if (Math.abs(q.pos.y - m.pos.y) > 1.6) continue;
        const d2 = (q.pos.x - m.pos.x) ** 2 + (q.pos.z - m.pos.z) ** 2;
        if (d2 < bd) { bd = d2; tgt = q; }
      }
      if (!tgt || !this.losClear(m.eye, tgt.eye)) continue;
      m.ai.clawAt = now + m.ai.spec.swing;
      this.applyDamage(tgt, m.ai.spec.claw, m, { x: tgt.pos.x, y: tgt.pos.y + 1, z: tgt.pos.z }, false, 'body', 'claw');
    }
    if (this.rosterDirty) { this.rosterDirty = false; this.broadcastRoster(); }
  }

  stepSurvival(dt) {
    const sv = this.sv;
    if (!sv) return;
    const people = this.humans();
    this.sweepCorpses();
    const alive = this.players.reduce((n, p) => n + (p.bot && p.alive ? 1 : 0), 0);
    this.scoreA = sv.wave;
    this.scoreB = alive + sv.queue;
    if (people.length && sv.wave > 0 && !people.some((p) => p.alive)) {
      this.endMatch('DEFEAT', `Fell on wave ${sv.wave} of ${this.settings.limit}`, { team: TEAM.RED });
      return;
    }
    if (sv.state === 'break') {
      if ((sv.breakT -= dt) <= 0) this.startWave(sv.wave + 1);
    } else {
      if (sv.queue > 0 && alive < sv.cap && (sv.spawnIn -= dt) <= 0) {
        if (this.spawnBot()) sv.queue--;
        sv.spawnIn = 0.5;
      }
      if (sv.queue === 0 && alive === 0) {
        if (sv.wave >= this.settings.limit) {
          this.endMatch('VICTORY', `${sv.wave} waves survived`, { team: TEAM.BLUE });
          return;
        }
        sv.state = 'break'; sv.breakT = 7;
        this.say(`WAVE ${sv.wave} CLEARED`);
      }
    }
    if (this.rosterDirty) { this.rosterDirty = false; this.broadcastRoster(); }
  }

  /* ----------------------------------------------------------------- duel */

  otherDuelist(p) { return this.players.find((q) => q !== p && q.connected && q.team !== TEAM.SOLO) ?? null; }

  /** The two spawns furthest apart, in a random order: a mirror, as in src/match.js. */
  startDuelRound() {
    let a = this.spawns[0], b = this.spawns[this.spawns.length - 1], best = -1;
    for (let i = 0; i < this.spawns.length; i++) {
      for (let j = i + 1; j < this.spawns.length; j++) {
        const s = this.spawns[i], t = this.spawns[j];
        const d = (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
        if (d > best) { best = d; a = s; b = t; }
      }
    }
    if (this.rng() < 0.5) [a, b] = [b, a];
    for (const g of this.grenades) this.world.removeBody(g.body);
    this.grenades = []; this.bullets = []; this.smokes = [];
    const duelists = this.players.filter((p) => p.connected && p.team !== TEAM.SOLO);
    duelists.forEach((p, i) => { this.respawn(p, i ? b : a); p.invulnTimer = 0; });
    this.timeLeft = CONFIG.DUEL_ROUND_SECONDS;
    this.roundReset = 0;
  }

  /** `winner` is the player left standing, or null for a timed-out draw. */
  duelRoundEnd(winner) {
    if (this.roundReset > 0 || this.phase !== PHASE.PLAYING) return;
    if (winner) { if (winner.team === TEAM.BLUE) this.scoreA++; else this.scoreB++; }
    this.roundReset = CONFIG.DUEL_RESET_DELAY;
    this.say(winner ? `${winner.name} WINS THE ROUND  ${this.scoreA} - ${this.scoreB}` : `ROUND DRAW  ${this.scoreA} - ${this.scoreB}`);
    this.checkWin();
  }

  stepDuel(dt) {
    if (this.players.filter((p) => p.connected && p.team !== TEAM.SOLO).length < 2) {
      const left = this.players.find((p) => p.connected);
      this.endMatch(left ? `${left.name} WINS` : 'NO CONTEST', 'opponent left', left ? { id: left.id } : {});
      return;
    }
    if (this.roundReset > 0) {
      if ((this.roundReset -= dt) <= 0) this.startDuelRound();
    } else if ((this.timeLeft -= dt) <= 0) this.duelRoundEnd(null);
  }

  /** Straight into a round with no lobby and no countdown. */
  startMatch(mode, mapId) {
    this.settings = cleanSettings({ mode, map: mapId }, this.settings, MAP_DATA);
    this.prepareRound(mode, mapId);
    this.beginPlay();
    this.broadcastJson({ t: 'match', ...this.matchInfo() });
  }

  /** Back to the lobby: everyone unready, own loadouts restored, anyone who was waiting seated. */
  toLobby(note = '') {
    if (this.governor.lastRound) { this.closeRoom('The free daily budget is nearly used up, so that was the last round today.'); return; }
    this.phase = PHASE.LOBBY;
    this.timeLeft = 0;
    this.mode = this.settings.mode;
    this.flags = [];
    this.clearBots();
    this.sv = null; this.zb = null;
    for (const p of this.players) { p.ready = false; p.team = TEAM.SOLO; p.loadout = [...p.chosen]; }
    for (const c of this.clients.values()) {
      if (!c.queued || c.player || this.humanSeats().length >= MAX_PLAYERS) continue;
      c.spectator = false; c.queued = false;
      const p = this.newSeat(c, c.helloMsg ?? {});
      this.sendJson(c, { t: 'welcome', id: p.id, token: p.token, spectator: false, full: false, queued: false, tick: this.tick, tickHz: TICK_HZ, snapshotHz: SNAPSHOT_HZ, ...this.matchInfo() });
    }
    for (const p of this.players) if (p.connected) this.respawn(p);
    if (note) this.say(note);
    this.broadcastJson({ t: 'match', ...this.matchInfo() });
  }

  checkWin() {
    if (this.phase !== PHASE.PLAYING || MODE_INFO[this.mode].untimed || this.mode === 'zombie') return;
    const limit = this.settings.limit;
    if (this.mode === 'duel') {
      const win = this.scoreA >= limit ? TEAM.BLUE : this.scoreB >= limit ? TEAM.RED : null;
      const w = win === null ? null : this.players.find((p) => p.team === win);
      if (w) this.endMatch(`${w.name} WINS`, `${Math.max(this.scoreA, this.scoreB)} - ${Math.min(this.scoreA, this.scoreB)} in rounds`, { id: w.id });
    } else if (this.mode === 'dm') {
      const top = this.players.reduce((a, p) => (!a || p.kills > a.kills ? p : a), null);
      if (top && top.kills >= limit) this.endMatch(`${top.name} WINS`, `${top.kills} kills`, { id: top.id });
    } else if (this.scoreA >= limit) this.endMatch('BLUE TEAM WINS', `${this.scoreA} - ${this.scoreB}`, { team: TEAM.BLUE });
    else if (this.scoreB >= limit) this.endMatch('RED TEAM WINS', `${this.scoreB} - ${this.scoreA}`, { team: TEAM.RED });
  }

  endOnTime() {
    if (this.mode === 'survival') {
      const wave = this.sv?.wave ?? 0;
      this.endMatch('ENDED', `${wave} wave${wave === 1 ? '' : 's'} survived`, {});
    } else if (teamMode(this.mode)) {
      if (this.scoreA === this.scoreB) this.endMatch('DRAW', `${this.scoreA} - ${this.scoreB}`, {});
      else {
        const blue = this.scoreA > this.scoreB;
        this.endMatch(blue ? 'BLUE TEAM WINS' : 'RED TEAM WINS', `${Math.max(this.scoreA, this.scoreB)} - ${Math.min(this.scoreA, this.scoreB)}`, { team: blue ? TEAM.BLUE : TEAM.RED });
      }
    } else {
      const top = this.players.reduce((a, p) => (!a || p.kills > a.kills ? p : a), null);
      this.endMatch(top ? `${top.name} WINS` : 'TIME', top ? `${top.kills} kills` : '', top ? { id: top.id } : {});
    }
  }

  /** `winner` is { id } (a player), { team } or {} (a draw): the clients work out win or loss from it. */
  endMatch(title, detail, winner = {}) {
    this.phase = PHASE.INTERMISSION;
    this.timeLeft = INTERMISSION;
    for (const p of this.players) p.cooking = null;
    const standings = this.players.filter((p) => p.connected && !p.bot)
      .map((p) => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, headshots: p.headshots, damage: Math.round(p.damage), captures: p.captures }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.clearBots();
    this.broadcastJson({
      t: 'end', title, detail, standings, scoreA: this.scoreA, scoreB: this.scoreB, winner,
      lastRound: this.governor.lastRound, ...this.matchInfo(),
    });
  }

  budgetCheck() {
    if (this.phase === PHASE.CLOSED) {
      if (!this.governor.lastRound) this.toLobby();   // a new UTC day
      return;
    }
    if (this.governor.exhausted) this.closeRoom('The free daily budget is used up. The server is closed until 00:00 UTC.');
  }

  closeRoom(reason) {
    this.phase = PHASE.CLOSED;
    this.broadcastJson({ t: 'closed', reason, resetInSec: this.governor.resetIn });
    for (const c of [...this.clients.values()]) {
      try { c.conn.close(CLOSE.CLOSED, 'closed'); } catch { /* gone */ }
    }
    this.log(`closed: ${reason}`);
  }

  /* ------------------------------------------------------------- snapshot */

  sendSnapshots() {
    const sh = new Writer(512);
    const seated = this.players.filter((p) => p.connected);
    sh.u8(seated.length);
    for (const p of seated) writePlayer(sh, p);
    let chestMask = 0, consMask = 0;
    this.chests.forEach((c, i) => { if (c.cooldown <= 0) chestMask |= 1 << i; });
    this.consumables.forEach((c, i) => { if (c.cooldown <= 0) consMask |= 1 << i; });
    sh.u16(chestMask); sh.u16(consMask);
    sh.u8(this.drops.length);
    for (const d of this.drops) { sh.u8(d.id); sh.u8(d.type); sh.u8(d.a); sh.u8(d.b); sh.pos(d.x, d.y, d.z); }
    sh.u8(Math.min(255, this.grenades.length));
    for (const g of this.grenades.slice(0, 255)) { sh.u8(g.id); sh.u8(g.kind === 'smoke' ? 2 : 1); sh.pos(g.body.position.x, g.body.position.y, g.body.position.z); }
    sh.u8(Math.min(255, this.smokes.length));
    for (const s of this.smokes.slice(0, 255)) { sh.u8(s.id); sh.pos(s.pos.x, s.pos.y, s.pos.z); sh.u16(Math.round(s.t * 10)); }
    const events = this.events.splice(0, 255);
    this.events.length = 0;
    sh.u8(events.length);
    for (const e of events) writeEvent(sh, e);

    const t = this.now();
    const flags = (this.governor.inputRate < 20 ? BUDGET.REDUCED : 0) | (this.governor.lastRound ? BUDGET.LAST_ROUND : 0)
      | (this.phase === PHASE.CLOSED ? BUDGET.CLOSED : 0);
    for (const c of this.clients.values()) {
      if (!c.hello) continue;
      const p = c.player;
      const w = new Writer(sh.o + 220);
      w.u8(MSG_SNAPSHOT);
      w.u32(this.tick);
      w.u16(p ? p.echoTime : 0);
      w.u16(p ? Math.min(65535, t - p.echoAt) : 0);
      w.u32(p ? p.ackSeq : 0);
      w.u16(p ? Math.min(65535, this.tick - p.ackTick) : 0);
      w.u8(this.phase); w.u8(MODE_IDS.indexOf(this.mode)); w.u8(MAP_IDS.indexOf(this.mapId));
      w.u16(Math.max(0, Math.round(this.timeLeft * 10)));
      w.u16(this.scoreA); w.u16(this.scoreB);
      w.u8(this.governor.inputRate); w.u8(flags);
      w.u8(p ? p.id : NO_ID);
      if (p) writeYou(w, p);
      w.append(sh);
      const bytes = w.bytes();
      this.send(c, bytes);
      this.stats.snapshots++;
      this.stats.snapBytes += bytes.byteLength;
      this.stats.snapBytesMax = Math.max(this.stats.snapBytesMax, bytes.byteLength);
    }
  }

  /* ---------------------------------------------------------------- stats */

  report() {
    const pct = (arr, q) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(3);
    };
    const s = this.stats;
    return {
      players: this.humans().length,
      held: this.players.filter((p) => !p.connected).length,
      spectators: [...this.clients.values()].filter((c) => c.spectator).length,
      phase: Object.keys(PHASE).find((k) => PHASE[k] === this.phase), mode: this.mode, map: this.mapId,
      tick: this.tick, ...s.rate,
      msPerTick: { avg: +(s.costMs.reduce((a, b) => a + b, 0) / Math.max(1, s.costMs.length)).toFixed(3), p50: pct(s.costMs, 0.5), p95: pct(s.costMs, 0.95), max: pct(s.costMs, 1) },
      callbackGapMs: { p50: pct(s.gaps, 0.5), p95: pct(s.gaps, 0.95), p99: pct(s.gaps, 0.99), max: pct(s.gaps, 1) },
      snapshotBytes: { avg: Math.round(s.snapBytes / Math.max(1, s.snapshots)), max: s.snapBytesMax },
      totals: {
        msgsIn: s.msgsIn, bytesIn: s.bytesIn, bytesOut: s.bytesOut, snapshots: s.snapshots, ticksDropped: s.ticksDropped,
        inputDropped: s.inputDropped, inputBad: s.inputBad, cmdsRepeated: s.cmdsRepeated, cmdsTrimmed: s.cmdsTrimmed,
      },
      rtt: Object.fromEntries(this.players.filter((p) => p.connected).map((p) => [p.name, p.rtt])),
      budget: this.governor.stats(),
      hash: this.hash,
    };
  }
}
