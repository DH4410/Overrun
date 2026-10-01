/**
 * The multiplayer wire format, shared by the browser and the server. Hot traffic is binary
 * (inputs up, snapshots down); rare messages (hello, roster, votes, errors) are JSON text.
 *
 * Bump PROTOCOL_VERSION whenever anything here or in the shared simulation changes meaning: it
 * is folded into the map hash, so a stale client is told to refresh instead of desyncing.
 */
export const PROTOCOL_VERSION = 1;

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

export const TICK_HZ = 120;
export const SNAPSHOT_HZ = 20;
export const INPUT_HZ = 20;
export const MAX_CMDS_PER_PACKET = 16;

/** Command buttons. FIRE/AIM/CROUCH/SPRINT/FRAG/SMOKE are held state; JUMP/RELOAD are one-shots. */
export const BTN = {
  FIRE: 1, AIM: 2, JUMP: 4, CROUCH: 8, SPRINT: 16, RELOAD: 32, FRAG: 64, SMOKE: 128,
};
/** Bits a repeated command drops, so a late packet cannot reload or jump twice. */
export const ONE_SHOT_BITS = BTN.JUMP | BTN.RELOAD;

export const WEAPON_IDS = ['pistol', 'ar', 'smg', 'shotgun', 'sniper', 'frag'];
/** Index 0 is "not emoting". Matches EMOTES in src/emotes.js. */
export const EMOTE_IDS = [null, 'wave', 'hiphop', 'robot', 'chicken', 'macarena', 'ymca', 'thriller', 'victory'];
export const MODE_IDS = ['dm', 'tdm'];
/** Matches CHARACTERS in src/bots.js. */
export const CHARACTER_IDS = ['soldier', 'swat', 'trooper', 'gasmask', 'crypto', 'ely', 'steve'];
export const MAX_PLAYERS = 10;
export const MAX_SPECTATORS = 16;
/** Close codes the client explains to the player instead of reconnecting. */
export const CLOSE = { REFRESH: 4001, FULL: 4002, CLOSED: 4003, KICKED: 4004 };

export const PHASE = { PLAYING: 1, INTERMISSION: 2, CLOSED: 3 };
export const EV = { SHOT: 1, HIT: 2, KILL: 3, EXPLODE: 4, SMOKE: 5, PICKUP: 6, SPAWN: 7, THROW: 8 };
export const NO_ID = 255;

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

export function quantYaw(yaw) {
  const w = ((yaw % TAU) + TAU) % TAU;
  return Math.round((w / TAU) * 65536) & 0xffff;
}
export function dequantYaw(q) { return (q / 65536) * TAU; }
export function quantPitch(p) {
  return Math.max(-32767, Math.min(32767, Math.round((p / HALF_PI) * 32767)));
}
export function dequantPitch(q) { return (q / 32767) * HALF_PI; }

/** Positions in centimetres (+-327 m), velocities in cm/s, unit directions in 1/32767. */
const P = 100;
const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

/* ------------------------------------------------------------------ input */

/**
 * An input packet: header, then one 10-byte record per fixed tick.
 *   u8 type, u8 count, u32 firstSeq, u16 clientTime (ms), u16 rtt (ms), u8 interp (2 ms units),
 *   u16 viewTick: the server tick the client was drawing other players at when it built the
 *   LAST command (low 16 bits); each earlier command was one tick earlier. Lag compensation
 *   rewinds to it (clamped), which is the "serverNow - rtt/2 - interp" estimate measured
 *   directly instead of guessed.
 *   per command: i8 ix, i8 iz, u16 yaw, i16 pitch, u16 buttons, u8 weapon, u8 emote
 */
export const INPUT_HEADER = 13;
export const INPUT_CMD = 10;

export function encodeInput(cmds, firstSeq, clientTime, rtt, interpMs, viewTick) {
  const buf = new ArrayBuffer(INPUT_HEADER + cmds.length * INPUT_CMD);
  const v = new DataView(buf);
  v.setUint8(0, MSG_INPUT);
  v.setUint8(1, cmds.length);
  v.setUint32(2, firstSeq >>> 0);
  v.setUint16(6, clientTime & 0xffff);
  v.setUint16(8, Math.max(0, Math.min(65535, Math.round(rtt))));
  v.setUint8(10, Math.max(0, Math.min(255, Math.round(interpMs / 2))));
  v.setUint16(11, viewTick & 0xffff);
  let o = INPUT_HEADER;
  for (const c of cmds) {
    v.setInt8(o, c.ix); v.setInt8(o + 1, c.iz);
    v.setUint16(o + 2, c.yawQ); v.setInt16(o + 4, c.pitchQ);
    v.setUint16(o + 6, c.buttons); v.setUint8(o + 8, c.weapon); v.setUint8(o + 9, c.emote);
    o += INPUT_CMD;
  }
  return buf;
}

/** Decode and clamp; returns null for anything malformed. Never trusts a field. */
export function decodeInput(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < INPUT_HEADER) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_INPUT) return null;
  const n = v.getUint8(1);
  if (n < 1 || n > MAX_CMDS_PER_PACKET || buf.byteLength !== INPUT_HEADER + n * INPUT_CMD) return null;
  const out = {
    firstSeq: v.getUint32(2), clientTime: v.getUint16(6), rtt: v.getUint16(8), interpMs: v.getUint8(10) * 2,
    viewTick: v.getUint16(11), cmds: [],
  };
  let o = INPUT_HEADER;
  for (let i = 0; i < n; i++) {
    out.cmds.push({
      seq: out.firstSeq + i,
      ix: Math.sign(v.getInt8(o)), iz: Math.sign(v.getInt8(o + 1)),
      yawQ: v.getUint16(o + 2),
      pitchQ: Math.max(-32000, Math.min(32000, v.getInt16(o + 4))),
      buttons: v.getUint16(o + 6) & 0xff,
      weapon: Math.min(v.getUint8(o + 8), WEAPON_IDS.length - 1),
      emote: v.getUint8(o + 9) < EMOTE_IDS.length ? v.getUint8(o + 9) : 0,
    });
    o += INPUT_CMD;
  }
  return out;
}

/* --------------------------------------------------------------- snapshot */

/** A growable little binary writer; snapshots are built once per recipient at 20 Hz. */
export class Writer {
  constructor(size = 1024) { this.buf = new ArrayBuffer(size); this.v = new DataView(this.buf); this.o = 0; }
  need(n) {
    if (this.o + n <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.o + n));
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.o));
    this.buf = next; this.v = new DataView(next);
  }
  u8(x) { this.need(1); this.v.setUint8(this.o, x); this.o += 1; }
  u16(x) { this.need(2); this.v.setUint16(this.o, x); this.o += 2; }
  i16(x) { this.need(2); this.v.setInt16(this.o, clampI16(x)); this.o += 2; }
  u32(x) { this.need(4); this.v.setUint32(this.o, x >>> 0); this.o += 4; }
  f32(x) { this.need(4); this.v.setFloat32(this.o, x); this.o += 4; }
  f64(x) { this.need(8); this.v.setFloat64(this.o, x); this.o += 8; }
  pos(x, y, z) { this.i16(x * P); this.i16(y * P); this.i16(z * P); }
  dir(x, y, z) { this.i16(x * 32767); this.i16(y * 32767); this.i16(z * 32767); }
  bytes() { return this.buf.slice(0, this.o); }
  /** Copy another writer's contents in (shared parts of a snapshot are built once). */
  append(w) { this.need(w.o); new Uint8Array(this.buf, this.o, w.o).set(new Uint8Array(w.buf, 0, w.o)); this.o += w.o; }
}

export class Reader {
  constructor(buf) { this.v = new DataView(buf); this.o = 0; }
  u8() { const x = this.v.getUint8(this.o); this.o += 1; return x; }
  u16() { const x = this.v.getUint16(this.o); this.o += 2; return x; }
  i16() { const x = this.v.getInt16(this.o); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o); this.o += 4; return x; }
  f32() { const x = this.v.getFloat32(this.o); this.o += 4; return x; }
  f64() { const x = this.v.getFloat64(this.o); this.o += 8; return x; }
  pos() { return { x: this.i16() / P, y: this.i16() / P, z: this.i16() / P }; }
  dir() { return { x: this.i16() / 32767, y: this.i16() / 32767, z: this.i16() / 32767 }; }
}

/** Player flags in a snapshot. */
export const PF = { ALIVE: 1, CROUCH: 2, AIM: 4, INVULN: 8, GROUNDED: 16, SPRINT: 32, CONNECTED: 64 };

/**
 * Snapshot layout (all big-endian):
 *   u8 type, u32 tick, u16 echoClientTime, u16 echoAge, u32 ackSeq, u16 ackAge,
 *   u8 phase, u8 mode, u8 map, u16 timeLeft (1/10 s), u16 scoreA, u16 scoreB,
 *   u8 inputRate, u8 budgetFlags, u8 youId
 *   [you block when youId != NO_ID]
 *   u8 nPlayers, players..., u16 chestMask, u16 consumableMask,
 *   u8 nGrenades, grenades..., u8 nSmokes, smokes..., u8 nEvents, events...
 * The header and you-block are per recipient; everything from nPlayers on is shared. The
 * you-block is the state after command ackSeq and then ackAge ticks without a new command.
 */
export function writeYou(w, p) {
  const b = p.body;
  w.f64(b.position.x); w.f64(b.position.y); w.f64(b.position.z);
  w.f64(b.velocity.x); w.f64(b.velocity.y); w.f64(b.velocity.z);
  w.u8((p.alive ? PF.ALIVE : 0) | (p.crouching ? PF.CROUCH : 0) | (p.grounded ? PF.GROUNDED : 0)
    | (p.sprinting ? PF.SPRINT : 0) | (p.invulnTimer > 0 ? PF.INVULN : 0));
  w.f64(p.slideTime); w.f64(p.airVy); w.f64(p.landTime);
  w.f64(p.health); w.f64(p.armor);
  w.u8(WEAPON_IDS.indexOf(p.current));
  for (const id of WEAPON_IDS.slice(0, 5)) {
    const a = p.ammo[id] || { mag: 0, reserve: 0 };
    w.u8(a.mag); w.u16(a.reserve);
  }
  w.u8(p.fragCount); w.u8(p.smokeCount);
  // Everything stepWeapons reads, at full precision, so the client can replay it exactly.
  w.f64(p.cooldown); w.f64(p.fireCarry); w.f64(p.reloading); w.f64(p.reloadTotal);
  w.f64(p.bloom); w.u8(Math.min(255, p.sprayIndex)); w.f64(p.sinceShot);
  w.f64(p.recoilPitch); w.f64(p.recoilYaw);
  w.u8(p.cooking === 'frag' ? 1 : p.cooking === 'smoke' ? 2 : 0); w.u16(Math.min(65535, p.chargeTicks));
  w.u16(p.prevButtons);
  w.f64(p.respawnTimer); w.f64(p.invulnTimer);
}

export function readYou(r) {
  const y = {
    px: r.f64(), py: r.f64(), pz: r.f64(), vx: r.f64(), vy: r.f64(), vz: r.f64(),
  };
  const f = r.u8();
  y.alive = !!(f & PF.ALIVE); y.crouching = !!(f & PF.CROUCH); y.grounded = !!(f & PF.GROUNDED);
  y.sprinting = !!(f & PF.SPRINT); y.invuln = !!(f & PF.INVULN);
  y.slideTime = r.f64(); y.airVy = r.f64(); y.landTime = r.f64();
  y.health = r.f64(); y.armor = r.f64();
  y.current = WEAPON_IDS[r.u8()] ?? 'pistol';
  y.ammo = {};
  for (const id of WEAPON_IDS.slice(0, 5)) y.ammo[id] = { mag: r.u8(), reserve: r.u16() };
  y.fragCount = r.u8(); y.smokeCount = r.u8();
  y.cooldown = r.f64(); y.fireCarry = r.f64(); y.reloading = r.f64(); y.reloadTotal = r.f64();
  y.bloom = r.f64(); y.sprayIndex = r.u8(); y.sinceShot = r.f64();
  y.recoilPitch = r.f64(); y.recoilYaw = r.f64();
  y.cooking = [null, 'frag', 'smoke'][r.u8()] ?? null; y.chargeTicks = r.u16();
  y.prevButtons = r.u16();
  y.respawnTimer = r.f64(); y.invulnTimer = r.f64();
  return y;
}

export function writePlayer(w, p) {
  const b = p.body;
  w.u8(p.id);
  w.u8((p.alive ? PF.ALIVE : 0) | (p.crouching ? PF.CROUCH : 0) | (p.aiming ? PF.AIM : 0)
    | (p.invulnTimer > 0 ? PF.INVULN : 0) | (p.grounded ? PF.GROUNDED : 0) | (p.sprinting ? PF.SPRINT : 0)
    | (p.connected ? PF.CONNECTED : 0));
  w.u8(p.team);
  w.pos(b.position.x, b.position.y, b.position.z);
  w.pos(b.velocity.x, b.velocity.y, b.velocity.z);
  w.u16(quantYaw(p.yaw)); w.i16(quantPitch(p.pitch));
  w.u8(Math.ceil(Math.max(0, p.health)));
  w.u8(WEAPON_IDS.indexOf(p.current));
  w.u8(p.emote);
  w.u8(Math.min(255, p.kills)); w.u8(Math.min(255, p.deaths));
}

export function readPlayer(r) {
  const id = r.u8(), f = r.u8(), team = r.u8();
  const pos = r.pos(), vel = r.pos();
  return {
    id, team, pos, vel,
    alive: !!(f & PF.ALIVE), crouching: !!(f & PF.CROUCH), aiming: !!(f & PF.AIM),
    invuln: !!(f & PF.INVULN), grounded: !!(f & PF.GROUNDED), sprinting: !!(f & PF.SPRINT),
    connected: !!(f & PF.CONNECTED),
    yaw: dequantYaw(r.u16()), pitch: dequantPitch(r.i16()),
    health: r.u8(), weapon: WEAPON_IDS[r.u8()] ?? 'pistol', emote: r.u8(),
    kills: r.u8(), deaths: r.u8(),
  };
}

export function writeEvent(w, e) {
  w.u8(e.kind);
  switch (e.kind) {
    case EV.SHOT: w.u8(e.shooter); w.u8(WEAPON_IDS.indexOf(e.weapon)); w.pos(e.o.x, e.o.y, e.o.z); w.dir(e.d.x, e.d.y, e.d.z); w.u16(e.seed); break;
    case EV.HIT: w.u8(e.attacker); w.u8(e.victim); w.u8(Math.min(255, Math.round(e.dmg))); w.u8(e.zone); w.u8(e.flags); w.pos(e.p.x, e.p.y, e.p.z); break;
    case EV.KILL: w.u8(e.killer); w.u8(e.victim); w.u8(e.head ? 1 : 0); w.u8(WEAPON_IDS.indexOf(e.weapon)); break;
    case EV.EXPLODE: case EV.SMOKE: w.pos(e.p.x, e.p.y, e.p.z); break;
    case EV.PICKUP: w.u8(e.who); w.u8(e.what); w.u8(e.index); break;
    case EV.SPAWN: w.u8(e.id); break;
    case EV.THROW: w.u8(e.who); w.u8(e.what); break;
    default: break;
  }
}

export function readEvent(r) {
  const kind = r.u8();
  switch (kind) {
    case EV.SHOT: return { kind, shooter: r.u8(), weapon: WEAPON_IDS[r.u8()], o: r.pos(), d: r.dir(), seed: r.u16() };
    case EV.HIT: return { kind, attacker: r.u8(), victim: r.u8(), dmg: r.u8(), zone: r.u8(), flags: r.u8(), p: r.pos() };
    case EV.KILL: return { kind, killer: r.u8(), victim: r.u8(), head: r.u8() === 1, weapon: WEAPON_IDS[r.u8()] };
    case EV.EXPLODE: case EV.SMOKE: return { kind, p: r.pos() };
    case EV.PICKUP: return { kind, who: r.u8(), what: r.u8(), index: r.u8() };
    case EV.SPAWN: return { kind, id: r.u8() };
    case EV.THROW: return { kind, who: r.u8(), what: r.u8() };
    default: throw new Error(`unknown event ${kind}`);
  }
}

export const ZONE_IDS = ['body', 'head', 'leg'];
export const HIT_SHIELD = 1, HIT_BREAK = 2, HIT_LETHAL = 4;

/* ---------------------------------------------------------------- map hash */

/** FNV-1a over a string, as 8 hex digits. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The CONFIG keys the simulation reads. Presentation keys (MAX_DECALS, SENS...) change at runtime. */
export const HASHED_CONFIG = [
  'GRAVITY', 'PHYSICS_HZ', 'EYE_HEIGHT', 'CROUCH_HEIGHT', 'PLAYER_RADIUS', 'CROUCH_RADIUS', 'PLAYER_MASS',
  'WALK_SPEED', 'SPRINT_MULT', 'CROUCH_MULT', 'GROUND_ACCEL', 'FRICTION', 'STOP_SPEED', 'AIR_ACCEL',
  'PLAYER_GRAVITY', 'JUMP_SPEED', 'MAX_HEALTH', 'MAX_ARMOR', 'START_ARMOR', 'ARMOR_ABSORB', 'MAX_RANGE',
  'FRAG_FUSE', 'THROW_CHARGE_TIME', 'FRAG_DAMAGE', 'FRAG_RADIUS', 'FRAG_IMPULSE', 'SMOKE_FUSE', 'SMOKE_LIFE',
  'SMOKE_RADIUS', 'DM_TARGET', 'TDM_TARGET', 'MATCH_SECONDS', 'PLAYER_RESPAWN',
];
const HASHED_WEAPON = [
  'id', 'auto', 'damage', 'speed', 'cooldown', 'mag', 'reserve', 'reload', 'spread', 'pellets', 'recoil',
  'rest', 'move', 'air', 'bloomStep', 'bloomMax', 'bloomDecay', 'pattern',
];
const pick = (o, keys) => keys.map((k) => o[k]);

/**
 * What both sides must agree on before they can play together: every map's colliders and
 * gameplay data, the simulation's constants and weapons, and this protocol's version.
 * `colliders` is { mapId: parsed assets/maps/<id>.json }.
 */
export function mapHash(colliders, mapData, config, weapons) {
  const ids = Object.keys(mapData).sort();
  return fnv1a(JSON.stringify([
    PROTOCOL_VERSION, ids.map((id) => [colliders[id], mapData[id]]),
    pick(config, HASHED_CONFIG), weapons.map((w) => pick(w, HASHED_WEAPON)),
  ]));
}

/** Parse a whole snapshot (see the layout above writeYou). */
export function readSnapshot(buf) {
  const r = new Reader(buf);
  if (r.u8() !== MSG_SNAPSHOT) return null;
  const s = {
    tick: r.u32(), echoClientTime: r.u16(), echoAge: r.u16(), ackSeq: r.u32(), ackAge: r.u16(),
    phase: r.u8(), mode: MODE_IDS[r.u8()] ?? 'dm', map: r.u8(), timeLeft: r.u16() / 10,
    scoreA: r.u16(), scoreB: r.u16(), inputRate: r.u8(), budgetFlags: r.u8(), youId: r.u8(),
    you: null, players: [], grenades: [], smokes: [], events: [],
  };
  if (s.youId !== NO_ID) s.you = readYou(r);
  for (let n = r.u8(); n > 0; n--) s.players.push(readPlayer(r));
  s.chestMask = r.u16(); s.consumableMask = r.u16();
  for (let n = r.u8(); n > 0; n--) s.grenades.push({ id: r.u8(), kind: r.u8() === 2 ? 'smoke' : 'frag', pos: r.pos() });
  for (let n = r.u8(); n > 0; n--) s.smokes.push({ id: r.u8(), pos: r.pos(), age: r.u16() / 10 });
  for (let n = r.u8(); n > 0; n--) s.events.push(readEvent(r));
  return s;
}

/** Budget flags in a snapshot header. */
export const BUDGET = { REDUCED: 1, LAST_ROUND: 2, CLOSED: 4 };
