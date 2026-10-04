import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildMapWorld, floorAt, inBlockers } from '../../src/sim/colliders.js';
import { MAP_DATA } from '../../src/sim/mapData.js';
import { PLAYABLE } from '../../src/sim/modes.js';
import { join, makeRoom, run, startRound } from './room-kit.mjs';

/**
 * The Blender maps added after WARZONE, hosted by the server: every mode the map lists that the
 * lobby can start opens with every player on solid ground inside the map, clear of every blocker.
 */

const NEW_MAPS = ['depot'];

for (const id of NEW_MAPS) {
  const def = MAP_DATA[id];
  const data = JSON.parse(readFileSync(new URL(`../../assets/maps/${id}.json`, import.meta.url), 'utf8'));
  const { world, blockers } = buildMapWorld(data, def.half);
  const modes = def.modes.filter((m) => PLAYABLE.includes(m));

  for (const mode of modes) {
    test(`${id}: a ${mode} round on the server opens on valid ground`, () => {
      const { room } = makeRoom();
      const players = ['A', 'B', 'C', 'D'].slice(0, mode === 'duel' ? 2 : 4).map((n) => join(room, n));
      startRound(room, players, { mode, map: id });
      run(room, 0.5);
      assert.equal(room.settings.map, id);
      for (const { p } of players) {
        const { x, y, z } = p.pos;
        assert.ok(Math.abs(x) < def.half[0] && Math.abs(z) < def.half[1], `${p.name} at ${x.toFixed(1)}, ${z.toFixed(1)} is inside the map`);
        assert.ok(!inBlockers(blockers, x, z, 0.3), `${p.name} spawned inside a blocker at ${x.toFixed(1)}, ${z.toFixed(1)}`);
        const floor = floorAt(world, x, z, def.ceilY - 0.5);
        assert.ok(floor !== null && y - floor < 1.2 && y - floor > -0.1, `${p.name} stands ${(y - floor).toFixed(2)} m above the floor`);
      }
    });
  }
}
