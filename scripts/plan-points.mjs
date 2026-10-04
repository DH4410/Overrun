// Picks a Blender map's spawn, ammo and pickup points from its collider JSON, the same way the game
// will validate them (2 m clear of every blocker, ground under the point).
//
//   node scripts/plan-points.mjs <map> --base=0,21 --spawns=14 --ammo=4 --cons=4 [--flags=0,21]
//
// Prints the three arrays ready for src/sim/mapData.js. Points come in half-turn pairs, so the
// layout stays fair: `base` is the first spawn, its mirror is the second. Spawns are then picked
// by furthest-point sampling over every valid candidate, ammo from spots that sit beside cover,
// and pickups from the open ground between.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMapWorld, floorAt, inBlockers } from '../src/sim/colliders.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [map, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
const data = JSON.parse(readFileSync(join(root, 'assets', 'maps', `${map}.json`), 'utf8'));
const { world, blockers } = buildMapWorld(data, data.half);
const castY = data.ceilY - 0.5;
const [HX, HZ] = data.half;
const nSpawn = Number(opt.spawns ?? 14), nAmmo = Number(opt.ammo ?? 4), nCons = Number(opt.cons ?? 4);
const base = (opt.base ?? '0,20').split(',').map(Number);
const round = (v) => Math.round(v * 2) / 2;

const clear = (x, z, pad) => !inBlockers(blockers, x, z, pad);
const onGround = (x, z) => { const y = floorAt(world, x, z, castY); return y !== null && Math.abs(y) < 0.05; };

// Candidates: the half-metre grid, kept to the south-east half plane so every pick has a mirror.
const cands = [];
for (let x = -HX + 2; x <= HX - 2; x += 1.5) {
  for (let z = -HZ + 2; z <= HZ - 2; z += 1.5) {
    const px = round(x), pz = round(z);
    if (clear(px, pz, 2.0) && clear(-px, -pz, 2.0) && onGround(px, pz) && onGround(-px, -pz)) cands.push([px, pz]);
  }
}

function farthest(chosen, pool, n) {
  const out = [];
  while (out.length < n && pool.length) {
    let best = null, bd = -1;
    for (const p of pool) {
      let d = Infinity;
      for (const c of [...chosen, ...out]) {
        d = Math.min(d, Math.hypot(p[0] - c[0], p[1] - c[1]), Math.hypot(p[0] + c[0], p[1] + c[1]));
      }
      if (d > bd) { bd = d; best = p; }
    }
    out.push(best);
    pool = pool.filter((p) => p !== best);
  }
  return out;
}

const [bx, bz] = base;
const spawnPick = farthest([[bx, bz]], cands.filter((p) => Math.hypot(p[0] - bx, p[1] - bz) > 1), nSpawn - 1);
const spawns = [[bx, bz], ...spawnPick.map((p) => [p[0], p[1]])];
const pairs = (list) => list.flatMap(([x, z]) => [[x, z], [-x, -z]]);

// Ammo: next to cover (a blocker between 1.2 and 3 m away) but not inside any spawn pair's circle.
const nearCover = (x, z) => !clear(x, z, 3.0) && clear(x, z, 1.2);
const ammoPool = cands.filter(([x, z]) => nearCover(x, z) && spawns.every(([sx, sz]) => Math.hypot(x - sx, z - sz) > 4 && Math.hypot(x + sx, z + sz) > 4));
const ammo = farthest(spawns.slice(0, 2), ammoPool, nAmmo);

const consPool = cands.filter(([x, z]) => clear(x, z, 1.2) && ammo.every(([ax, az]) => Math.hypot(x - ax, z - az) > 3.5 && Math.hypot(x + ax, z + az) > 3.5)
  && spawns.every(([sx, sz]) => Math.hypot(x - sx, z - sz) > 4));
const cons = farthest([...spawns.slice(0, 2), ...ammo], consPool, nCons);

const fmt = (list) => list.map(([x, z]) => `[${x}, ${z}]`).join(', ');
console.log(`candidates ${cands.length}`);
console.log(`spawns: [\n  ${pairs(spawns).reduce((s, p, i) => s + (i && i % 6 === 0 ? ',\n  ' : i ? ', ' : '') + `[${p[0]}, ${p[1]}]`, '')},\n],`);
console.log(`ammo: [\n  ${pairs(ammo).reduce((s, p, i) => s + (i && i % 6 === 0 ? ',\n  ' : i ? ', ' : '') + `[${p[0]}, ${p[1]}]`, '')},\n],`);
console.log('consumables: [\n  ' + cons.flatMap(([x, z], i) => {
  const kind = i % 2 ? 'shield' : 'health';
  return [`['${kind}', ${x}, ${z}]`, `['${kind}', ${-x}, ${-z}]`];
}).reduce((s, t, i) => s + (i && i % 4 === 0 ? ',\n  ' : i ? ', ' : '') + t, '') + ',\n],');
void fmt;
