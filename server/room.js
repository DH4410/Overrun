import * as CANNON from 'cannon-es';
import { Vector3 } from 'three';

import { CONFIG, FIXED_DT, SPAWN_INVULN, TEAM } from '../src/config.js';
import { DEFAULT_LOADOUT, validLoadout } from '../src/loadout.js';
import { buildMapColliders, floorAt, inBlockers, validSpawnPoints } from '../src/sim/colliders.js';
import { aimDirection, launchVelocity, resetAmmo, stepWeapons, throwAim } from '../src/sim/combat.js';
import { HB_PLAYER, PLAYER_ZONE_MULT, HB_PLAYER_CROUCH, analyticHit } from '../src/sim/hitmath.js';
import { MAP_DATA, MAP_IDS } from '../src/sim/mapData.js';
import { createPlayerBody, setCrouch, stepMovement, syncPlayerPoints } from '../src/sim/movement.js';
import {
  BTN, BUDGET, CHARACTER_IDS, CLOSE, EV, HIT_BREAK, HIT_LETHAL, HIT_SHIELD, MAX_PLAYERS, MAX_SPECTATORS,
  MODE_IDS, MSG_SNAPSHOT, NO_ID, ONE_SHOT_BITS, PHASE, PROTOCOL_VERSION, SNAPSHOT_HZ, TICK_HZ, WEAPON_IDS,
  Writer, ZONE_IDS, decodeInput, dequantPitch, dequantYaw, mapHash, quantYaw, writeEvent, writePlayer, writeYou,
} from '../src/sim/protocol.js';
import { WEAPONS } from '../src/sim/weaponData.js';
import { G_NADE, G_WORLD, MAT_NADE, RAY_OPTS, createWorld, makeStaticBox, makeStaticCylinder } from '../src/sim/world.js';
import { Governor } from './governor.js';

/**
 * The one multiplayer room: authoritative simulation, match flow and the wire, with no idea
 * what carries its bytes. An adapter (server/node.js, server/worker.js) hands it connections
 * ({ send(data), close(code, reason) }) and messages, and calls update() on a timer.
 *
 * The clock, the RNG and the map colliders are injected, so tests drive it directly.
 */

export const INTERMISSION = 20;          // s between rounds, with the vote
const STEP_MS = 1000 / TICK_HZ;
const SNAP_EVERY = TICK_HZ / SNAPSHOT_HZ;
const MAX_CATCHUP = 30;                  // ticks one update may run (250 ms) before time is dropped
const HIST = 64;                         // hitbox history, ticks (533 ms)
export const MAX_REWIND = 30;            // ticks lag compensation may rewind (250 ms)
export const QUEUE_MAX = 30;             // commands buffered per player (250 ms)
const MAX_GUESS = 12;                    // ticks a held command is repeated while starved (100 ms)
const RECONNECT_GRACE = 60;              // s a dropped player's seat is held for its token
const NAME_MAX = 16;
const CHEST_RANGE = 1.5, CHEST_RESPAWN = 25;
const CONSUMABLES = {
  health: { amount: 35, respawn: 22, stat: 'health', max: CONFIG.MAX_HEALTH },
  shield: { amount: 40, respawn: 30, stat: 'armor', max: CONFIG.MAX_ARMOR },
};
const NADE_ROLL_SPEED = 2.6;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

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
   * colliders: { port, desert, snow } parsed assets/maps/<id>.json
   * now(): ms; rng(): [0, 1); governor: a Governor; mapId/mode: the first round.
   */
  constructor({ colliders, now = () => Date.now(), rng = Math.random, governor = null, mapId = 'port', mode = 'dm', log = () => {} }) {
    this.colliders = colliders;
    this.now = now;
    this.rng = rng;
    this.log = log;
    this.governor = governor ?? new Governor({ now });
    this.hash = mapHash(colliders, MAP_DATA, { CONFIG, WEAPONS });
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
    this.votes = new Map();
    this.stats = {
      msgsIn: 0, bytesIn: 0, bytesOut: 0, snapshots: 0, snapBytes: 0, snapBytesMax: 0,
      inputDropped: 0, inputBad: 0, cmdsRepeated: 0, cmdsTrimmed: 0,
      ticks: 0, ticksDropped: 0, costMs: [], gaps: [], window: { at: now(), msgs: 0, bytesOut: 0, ticks: 0 }, rate: {},
    };
    this.mode = mode;
    this.loadMap(mapId);
    this.startMatch(mode, mapId);
  }

  /* ------------------------------------------------------------ the level */

  loadMap(id) {
    const def = MAP_DATA[id];
    const world = createWorld();
    const blockers = [];
    buildMapColliders(this.colliders[id], def.half, {
      addStaticBox: (hx, hy, hz, pos, q) => world.addBody(makeStaticBox(hx, hy, hz, pos, q)),
      addStaticCylinder: (r, h, pos) => world.addBody(makeStaticCylinder(r, h, pos)),
      addBlocker: (x, z, hx, hz) => blockers.push({ x, z, hx, hz }),
    });
    const castY = def.ceilY - 0.5;
    this.spawns = validSpawnPoints(world, blockers, def.spawns, def.spawns.slice(0, 4), castY).points;
    // Same placement rules as src/pickups.js.
    this.chests = [];
    for (const [x, z] of def.ammo) {
      if (this.chests.length >= 8) break;
      if (inBlockers(blockers, x, z, 1.2)) continue;
      const y = floorAt(world, x, z, castY);
      if (y !== null) this.chests.push({ x, y: y + 0.45, z, cooldown: 0 });
    }
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
    this.clients.set(conn, { conn, player: null, spectator: false, hello: false, tokens: 10, tokenAt: this.now(), json: 0, jsonAt: this.now(), bad: 0 });
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
      this.votes.delete(p.id);
      this.log(`leave ${p.name} (#${p.id})`);
      this.broadcastRoster();
    }
  }

  get empty() { return this.clients.size === 0; }

  message(conn, data) {
    const c = this.clients.get(conn);
    if (!c) return;
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
    // Text is rare (hello, votes): 5 a second is plenty, anything past that is dropped.
    const t = this.now();
    c.json = Math.max(0, c.json - (t - c.jsonAt) / 200);
    c.jsonAt = t;
    if (++c.json > 10 || text.length > 1024) { this.stats.inputDropped++; return; }
    let m;
    try { m = JSON.parse(text); } catch { c.bad++; return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !c.hello) this.onHello(c, m);
    else if (m.t === 'vote' && c.player && this.phase === PHASE.INTERMISSION) this.onVote(c.player, m);
  }

  onHello(c, m) {
    if (m.v !== PROTOCOL_VERSION || m.hash !== this.hash) {
      this.refuse(c, CLOSE.REFRESH, 'A new version of the game is out. Refresh to update.');
      return;
    }
    if (this.phase === PHASE.CLOSED) {
      this.refuse(c, CLOSE.CLOSED, 'The server is closed for today: its free daily budget is used up.', { resetInSec: this.governor.resetIn });
      return;
    }
    c.hello = true;
    let p = null;
    // A token resumes a held seat.
    if (typeof m.token === 'string') {
      p = this.players.find((q) => q.token === m.token && !q.connected) ?? null;
      if (p) this.resumeSeat(p, c);
    }
    if (!p && !m.spectate && this.players.length < MAX_PLAYERS) {
      p = this.newSeat(c, m);
    }
    if (!p) {
      const specs = [...this.clients.values()].filter((x) => x.spectator).length;
      if (specs >= MAX_SPECTATORS) { this.refuse(c, CLOSE.FULL, 'The server is full.'); return; }
      c.spectator = true;
    }
    this.sendJson(c, {
      t: 'welcome', id: p ? p.id : null, token: p?.token ?? null, spectator: !p,
      full: !p && !m.spectate, tick: this.tick, tickHz: TICK_HZ, snapshotHz: SNAPSHOT_HZ,
      ...this.matchInfo(),
    });
    this.broadcastRoster();
  }

  newSeat(c, m) {
    const used = new Set(this.players.map((q) => q.id));
    let id = 0;
    while (used.has(id)) id++;
    const p = {
      id, conn: c.conn, connected: true, droppedAt: 0,
      token: Array.from({ length: 4 }, () => Math.floor(this.rng() * 2 ** 32).toString(36)).join(''),
      name: cleanName(m.name),
      character: CHARACTER_IDS.includes(m.character) ? m.character : CHARACTER_IDS[0],
      loadout: validLoadout(m.loadout) ? [...m.loadout] : [...DEFAULT_LOADOUT],
      team: TEAM.SOLO, kills: 0, deaths: 0,
      body: createPlayerBody(G_WORLD),   // players pass through each other and through grenades
      pos: new Vector3(), eye: new Vector3(), vel: new Vector3(),
      hb: HB_PLAYER, yaw: 0, pitch: 0, grounded: false, crouching: false, sprinting: false, aiming: false,
      slideTime: 0, landTime: 99, landKick: 0, airVy: 0,
      alive: false, health: 0, armor: 0, respawnTimer: 0, invulnTimer: 0,
      current: 'pistol', ammo: {}, fragCount: 3, smokeCount: 1,
      cooldown: 0, fireCarry: 0, reloading: 0, reloadTotal: 0, bloom: 0, sprayIndex: 0, sinceShot: 99,
      recoilPitch: 0, recoilYaw: 0, cooking: null, chargeTicks: 0, prevButtons: 0,
      emote: 0, emoteBlock: 0,
      queue: [], lastCmd: IDLE_CMD, ackSeq: 0, lastSeq: 0, merge: 0, guesses: 0, minDepth: Infinity, depthAt: this.tick,
      rtt: 0, interpMs: 100, echoTime: 0, echoAt: 0,
      hist: new Float32Array(HIST * 5), histTick: new Int32Array(HIST).fill(-1),
    };
    this.world.addBody(p.body);
    if (this.mode === 'tdm') p.team = this.smallerTeam();
    this.players.push(p);
    c.player = p;
    this.respawn(p);
    this.log(`join ${p.name} (#${p.id})`);
    return p;
  }

  resumeSeat(p, c) {
    p.conn = c.conn;
    p.connected = true;
    p.queue.length = 0;
    p.lastCmd = IDLE_CMD;
    p.lastSeq = 0; p.ackSeq = 0; p.merge = 0;
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
    let blue = 0, red = 0;
    for (const q of this.players) if (q.connected) { if (q.team === TEAM.BLUE) blue++; else if (q.team === TEAM.RED) red++; }
    if (blue !== red) return blue < red ? TEAM.BLUE : TEAM.RED;
    return this.rng() < 0.5 ? TEAM.BLUE : TEAM.RED;
  }

  roster() {
    return this.players.filter((p) => p.connected).map((p) => ({
      id: p.id, name: p.name, character: p.character, team: p.team, loadout: p.loadout,
    }));
  }

  broadcastRoster() {
    const spectators = [...this.clients.values()].filter((c) => c.spectator).length;
    this.broadcastJson({ t: 'roster', players: this.roster(), spectators });
  }

  matchInfo() {
    return {
      mode: this.mode, map: this.mapId, phase: this.phase, timeLeft: this.timeLeft,
      maps: MAP_IDS, modes: MODE_IDS, roster: this.roster(), votes: this.tally(),
    };
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
    for (const p of this.players) {
      if (!p.connected) continue;
      const cmd = p.cmd = this.nextCommand(p);
      p.yaw = dequantYaw(cmd.yawQ);
      p.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, dequantPitch(cmd.pitchQ)));
      p.aiming = p.alive && (cmd.buttons & BTN.AIM) !== 0;
      stepWeapons(p, cmd, dt, armed, this);
      p.body.wakeUp();
      if (p.alive) {
        stepMovement(this.world, p, {
          ix: cmd.ix, iz: cmd.iz,
          crouch: (cmd.buttons & BTN.CROUCH) !== 0,
          sprint: (cmd.buttons & BTN.SPRINT) !== 0,
          aiming: p.aiming,
          jump: (cmd.buttons & BTN.JUMP) !== 0,
        }, dt);
      } else {
        p.body.velocity.x = 0; p.body.velocity.z = 0;
      }
    }
    this.world.step(dt);
    const slot = this.tick % HIST;
    for (const p of this.players) {
      if (!p.connected) continue;
      const b = p.body;
      p.vel.set(b.velocity.x, b.velocity.y, b.velocity.z);
      syncPlayerPoints(p);
      if (b.position.y < -20) this.respawn(p);   // fell out of the world
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
        if (p.connected && !p.alive && p.respawnTimer > 0) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) this.respawn(p);
        }
      }
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.endOnTime();
    } else if (this.phase === PHASE.INTERMISSION) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.nextRound();
    }
    if (this.tick % TICK_HZ === 0) {
      const t = this.now();
      for (const p of [...this.players]) {
        if (!p.connected && t - p.droppedAt > RECONNECT_GRACE * 1000) this.freeSeat(p);
      }
    }
    if (this.tick % SNAP_EVERY === 0) this.snapDue = true;
  }

  /** Emotes run until the player does anything, as in src/emotes.js; the server enforces it. */
  stepEmote(p) {
    const want = p.cmd?.emote ?? 0;
    const v = p.body.velocity;
    const busy = !p.alive || (p.cmd.buttons & BTN.FIRE) || Math.hypot(v.x, v.z) > 1.2 || v.y > 1.5;
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
      const b = { pos: p.eye.clone(), prev: p.eye.clone(), vel: d.multiplyScalar(w.speed), travelled: 0, damage: w.damage, owner: p, weapon: w.id };
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
      if (this.mode === 'tdm' && q.team === owner.team) continue;
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
      this.applyDamage(best, b.damage * (PLAYER_ZONE_MULT[bestZone] ?? 1), owner, _hp, bestZone === 'head', bestZone, b.weapon);
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
      if (this.mode === 'tdm' && source.team !== target.team) {
        if (source.team === TEAM.BLUE) this.scoreA++; else if (source.team === TEAM.RED) this.scoreB++;
      }
    }
    target.deaths++;
    target.alive = false;
    target.respawnTimer = CONFIG.PLAYER_RESPAWN;
    target.cooking = null;
    target.emote = 0;
    this.idleCommand(target);
    this.events.push({ kind: EV.KILL, killer: source ? source.id : NO_ID, victim: target.id, head: !!headshot, weapon: weapon ?? 'frag' });
    this.checkWin();
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
      if (live && q !== live && this.mode === 'tdm' && q.team === live.team) continue;
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

  stepPickups(dt) {
    this.chests.forEach((c, index) => {
      if (c.cooldown > 0) { c.cooldown -= dt; return; }
      for (const p of this.players) {
        if (!p.connected || !p.alive) continue;
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
      const spec = CONSUMABLES[c.kind];
      for (const p of this.players) {
        if (!p.connected || !p.alive || p[spec.stat] >= spec.max) continue;
        const b = p.body.position;
        if (Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z) > 1.5) continue;
        p[spec.stat] = Math.min(spec.max, p[spec.stat] + spec.amount);
        c.cooldown = spec.respawn;
        this.events.push({ kind: EV.PICKUP, who: p.id, what: 1, index });
        return;
      }
    });
  }

  /** Furthest from every living enemy, with jitter: main.js's pickSpawn. */
  pickSpawn(p) {
    let best = this.spawns[0], bestScore = -Infinity;
    for (const sp of this.spawns) {
      let score = Infinity;
      for (const q of this.players) {
        if (q === p || !q.connected || !q.alive) continue;
        if (this.mode === 'tdm' && q.team === p.team) continue;
        const dx = q.pos.x - sp.x, dy = q.pos.y - sp.y, dz = q.pos.z - sp.z;
        score = Math.min(score, dx * dx + dy * dy + dz * dz);
      }
      if (score === Infinity) score = 1e6;
      score += this.rng() * 120;
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    return best;
  }

  respawn(p) {
    const sp = this.pickSpawn(p);
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

  startMatch(mode, mapId) {
    if (mapId !== this.mapId) this.loadMap(mapId);
    this.mode = mode;
    this.phase = PHASE.PLAYING;
    this.timeLeft = CONFIG.MATCH_SECONDS;
    this.scoreA = 0; this.scoreB = 0;
    this.votes.clear();
    for (const g of this.grenades) this.world.removeBody(g.body);
    this.grenades = []; this.bullets = []; this.smokes = [];
    for (const c of this.chests) c.cooldown = 0;
    for (const c of this.consumables) c.cooldown = 0;
    // Teams are dealt afresh each round: shuffled, then alternated.
    const seated = this.players.filter((p) => p.connected);
    for (let i = seated.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [seated[i], seated[j]] = [seated[j], seated[i]];
    }
    seated.forEach((p, i) => { p.team = mode === 'tdm' ? (i % 2 ? TEAM.RED : TEAM.BLUE) : TEAM.SOLO; });
    for (const p of this.players) {
      p.kills = 0; p.deaths = 0;
      if (p.connected) this.respawn(p);
    }
    this.broadcastJson({ t: 'match', ...this.matchInfo() });
    this.log(`round: ${mode} on ${mapId}`);
  }

  checkWin() {
    if (this.phase !== PHASE.PLAYING) return;
    if (this.mode === 'dm') {
      const top = this.players.reduce((a, p) => (!a || p.kills > a.kills ? p : a), null);
      if (top && top.kills >= CONFIG.DM_TARGET) this.endMatch(`${top.name} WINS`, `${top.kills} kills`);
    } else if (this.scoreA >= CONFIG.TDM_TARGET) this.endMatch('BLUE TEAM WINS', `${this.scoreA} - ${this.scoreB}`);
    else if (this.scoreB >= CONFIG.TDM_TARGET) this.endMatch('RED TEAM WINS', `${this.scoreB} - ${this.scoreA}`);
  }

  endOnTime() {
    if (this.mode === 'tdm') {
      if (this.scoreA === this.scoreB) this.endMatch('DRAW', `${this.scoreA} - ${this.scoreB}`);
      else this.endMatch(this.scoreA > this.scoreB ? 'BLUE TEAM WINS' : 'RED TEAM WINS', `${Math.max(this.scoreA, this.scoreB)} - ${Math.min(this.scoreA, this.scoreB)}`);
    } else {
      const top = this.players.reduce((a, p) => (!a || p.kills > a.kills ? p : a), null);
      this.endMatch(top ? `${top.name} WINS` : 'TIME', top ? `${top.kills} kills` : '');
    }
  }

  endMatch(title, detail) {
    this.phase = PHASE.INTERMISSION;
    this.timeLeft = INTERMISSION;
    this.votes.clear();
    for (const p of this.players) p.cooking = null;
    const standings = this.players.filter((p) => p.connected)
      .map((p) => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.broadcastJson({
      t: 'end', title, detail, standings, scoreA: this.scoreA, scoreB: this.scoreB,
      lastRound: this.governor.lastRound, ...this.matchInfo(),
    });
  }

  onVote(p, m) {
    if (!MODE_IDS.includes(m.mode) || !MAP_IDS.includes(m.map)) return;
    this.votes.set(p.id, { mode: m.mode, map: m.map });
    this.broadcastJson({ t: 'votes', votes: this.tally() });
  }

  tally() {
    const modes = Object.fromEntries(MODE_IDS.map((k) => [k, 0]));
    const maps = Object.fromEntries(MAP_IDS.map((k) => [k, 0]));
    for (const v of this.votes.values()) { modes[v.mode]++; maps[v.map]++; }
    return { modes, maps };
  }

  /** Most votes wins; a tie (including nobody voting) is settled at random. */
  pickVoted(counts) {
    const top = Math.max(...Object.values(counts));
    const tied = Object.keys(counts).filter((k) => counts[k] === top);
    return tied[Math.floor(this.rng() * tied.length)];
  }

  nextRound() {
    if (this.governor.lastRound) { this.closeRoom('The free daily budget is nearly used up, so that was the last round today.'); return; }
    const { modes, maps } = this.tally();
    this.startMatch(this.pickVoted(modes), this.pickVoted(maps));
  }

  budgetCheck() {
    if (this.phase === PHASE.CLOSED) {
      if (!this.governor.lastRound) this.startMatch(this.mode, this.mapId);   // a new UTC day
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
      players: this.players.filter((p) => p.connected).length,
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
