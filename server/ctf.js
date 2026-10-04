import { TEAM } from '../src/config.js';
import { floorAt } from '../src/sim/colliders.js';

/**
 * Capture the flag, run by the room's tick. Flag 0 is blue's, flag 1 is red's; each stands at its
 * team's base (the map's `flags`). A flag is at home, carried, or dropped where its carrier died.
 *
 * Rules: touch the enemy flag to take it (home or dropped); touch your own dropped flag to send it
 * home; reach your own flag while it is home, carrying theirs, to score a capture. A carrier who
 * dies or leaves drops it, and a dropped flag goes home by itself after RETURN_AFTER seconds.
 *
 * Only changes are sent ({ t: 'flags' }); a carried flag is drawn at the carrier, whose position
 * the clients already have, so nothing here adds to the snapshots.
 */

export const TOUCH_R = 1.7;
export const RETURN_AFTER = 20;
export const FLAG_TEAMS = [TEAM.BLUE, TEAM.RED];
const NAMES = ['BLUE', 'RED'];

/** One flag per team, at home. */
export function ctfInit(room) {
  const def = room.mapDef;
  room.flags = FLAG_TEAMS.map((team, i) => {
    const [x, z] = def.flags[i];
    const y = floorAt(room.world, x, z, def.ceilY - 0.5) ?? 0;
    return { team, home: { x, y, z }, state: 'home', carrier: null, pos: { x, y, z }, timer: 0 };
  });
  room.sendFlags();
}

const wire = (f) => ({ s: f.state === 'home' ? 0 : f.state === 'carried' ? 1 : 2, c: f.carrier, x: +f.pos.x.toFixed(2), y: +f.pos.y.toFixed(2), z: +f.pos.z.toFixed(2) });
export const flagsWire = (room) => (room.flags ?? []).map(wire);

function goHome(room, f) {
  f.state = 'home'; f.carrier = null; f.timer = 0;
  f.pos = { ...f.home };
}

/** The flag a player is carrying, if any. */
export const carriedBy = (room, p) => room.flags?.find((f) => f.state === 'carried' && f.carrier === p.id) ?? null;

/** A carrier who is killed or gone: the flag falls where they stood and waits to be returned. */
export function ctfDrop(room, p) {
  const f = carriedBy(room, p);
  if (!f) return;
  const x = p.pos.x, z = p.pos.z;
  const y = floorAt(room.world, x, z, p.pos.y + 0.6) ?? p.pos.y - 0.55;
  f.state = 'dropped'; f.carrier = null; f.timer = RETURN_AFTER; f.pos = { x, y, z };
  room.say(`${NAMES[room.flags.indexOf(f)]} FLAG DROPPED`);
  room.sendFlags();
}

const near = (p, at) => Math.hypot(p.pos.x - at.x, p.pos.z - at.z) <= TOUCH_R && Math.abs(p.pos.y - 0.55 - at.y) <= 2.4;

export function ctfStep(room, dt) {
  let changed = false;
  for (const f of room.flags) {
    if (f.state !== 'carried') continue;
    const c = room.players.find((q) => q.id === f.carrier);
    if (!c || !c.connected || !c.alive) { if (c) ctfDrop(room, c); else { goHome(room, f); changed = true; } continue; }
    f.pos = { x: c.pos.x, y: c.pos.y - 0.55, z: c.pos.z };
  }
  room.flags.forEach((f, i) => {
    if (f.state === 'dropped' && (f.timer -= dt) <= 0) {
      goHome(room, f);
      room.say(`${NAMES[i]} FLAG RETURNED`);
      changed = true;
    }
    if (f.state === 'carried') return;
    for (const p of room.players) {
      if (!p.connected || !p.alive || !near(p, f.pos)) continue;
      if (p.team === f.team) {
        if (f.state === 'dropped') {
          goHome(room, f);
          room.say(`${p.name} RETURNED THE ${NAMES[i]} FLAG`);
          changed = true;
        } else {
          // At home: a carrier of the other flag scores with it.
          const held = carriedBy(room, p);
          if (held) {
            goHome(room, held);
            if (p.team === TEAM.BLUE) room.scoreA++; else room.scoreB++;
            p.captures = (p.captures ?? 0) + 1;
            room.say(`${p.name} CAPTURED THE ${NAMES[room.flags.indexOf(held)]} FLAG  ${room.scoreA} - ${room.scoreB}`);
            changed = true;
            room.checkWin();
          }
        }
      } else if (p.team !== TEAM.SOLO) {
        f.state = 'carried'; f.carrier = p.id; f.timer = 0;
        f.pos = { x: p.pos.x, y: p.pos.y - 0.55, z: p.pos.z };
        room.say(`${p.name} TOOK THE ${NAMES[i]} FLAG`);
        changed = true;
        break;
      }
    }
  });
  if (changed) room.sendFlags();
}
