import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quantPitch, quantYaw, readSnapshot, BTN, MSG_SNAPSHOT, PHASE, WEAPON_IDS } from '../../src/sim/protocol.js';
import {
  ITEM, ITEMS, ITEM_SHIFT, USE, addItem, canCarry, canUse, emptyItems, lootFor, packItems, packTiers,
  rollDrop, rollTier, stepUse, tierMult, unpackItems, unpackTiers,
} from '../../src/sim/items.js';
import { WEAPONS } from '../../src/sim/weaponData.js';
import { join, makeRoom, run, startRound } from './room-kit.mjs';

const person = (o = {}) => ({ alive: true, health: 50, armor: 0, items: emptyItems(), useKind: 0, useT: 0, ...o });

test('a bandage heals 15 after three seconds, never past 75, and is used up', () => {
  const p = person({ health: 50 }); p.items[ITEM.BANDAGE] = 2;
  assert.equal(stepUse(p, ITEM.BANDAGE, false, 1 / 120), USE.START);
  let r = USE.NONE;
  for (let i = 0; i < 360 && r !== USE.DONE; i++) r = stepUse(p, ITEM.BANDAGE, false, 1 / 120);
  assert.equal(r, USE.DONE);
  assert.equal(p.health, 65);
  assert.equal(p.items[ITEM.BANDAGE], 1);
  const q = person({ health: 70 }); q.items[ITEM.BANDAGE] = 1;
  stepUse(q, ITEM.BANDAGE, false, 1 / 120);
  for (let i = 0; i < 400; i++) stepUse(q, ITEM.BANDAGE, false, 1 / 120);
  assert.equal(q.health, 75, 'the ceiling');
  assert.ok(!canUse(q, ITEM.BANDAGE), 'and then it is no use at all');
});

test('nothing starts at the ceiling, with an empty bag, or while the hands are busy', () => {
  const p = person({ health: 80, armor: 50 }); p.items[ITEM.BANDAGE] = 1; p.items[ITEM.MINI] = 1;
  assert.equal(stepUse(p, ITEM.BANDAGE, false, 0.01), USE.NONE, 'health is past the bandage ceiling');
  assert.equal(stepUse(p, ITEM.MINI, false, 0.01), USE.NONE, 'shield is past the mini ceiling');
  assert.equal(stepUse(p, ITEM.MEDKIT, false, 0.01), USE.NONE, 'none carried');
  const q = person(); q.items[ITEM.BANDAGE] = 1;
  assert.equal(stepUse(q, ITEM.BANDAGE, true, 0.01), USE.NONE, 'firing');
});

test('an interrupted channel loses its progress and keeps its item', () => {
  const p = person({ health: 30 }); p.items[ITEM.MEDKIT] = 1;
  stepUse(p, ITEM.MEDKIT, false, 0.01);
  for (let i = 0; i < 300; i++) stepUse(p, ITEM.MEDKIT, false, 0.01);
  assert.ok(p.useT > 2.9 && p.useKind === ITEM.MEDKIT);
  assert.equal(stepUse(p, ITEM.MEDKIT, true, 0.01), USE.CANCEL);
  assert.equal(p.health, 30);
  assert.equal(p.items[ITEM.MEDKIT], 1);
  assert.equal(p.useT, 0);
  const q = person({ health: 30 }); q.items[ITEM.MEDKIT] = 1;
  stepUse(q, ITEM.MEDKIT, false, 0.01);
  assert.equal(stepUse(q, 0, false, 0.01), USE.CANCEL, 'letting go also cancels');
});

test('the shield items add to the separate pool', () => {
  const p = person({ health: 100, armor: 10 }); p.items[ITEM.BIG] = 1; p.items[ITEM.MINI] = 1;
  stepUse(p, ITEM.BIG, false, 0.01);
  for (let i = 0; i < 500; i++) stepUse(p, ITEM.BIG, false, 0.01);
  assert.equal(p.armor, 60);
  assert.equal(p.health, 100);
  p.armor = 40;
  stepUse(p, ITEM.MINI, false, 0.01);
  for (let i = 0; i < 300; i++) stepUse(p, ITEM.MINI, false, 0.01);
  assert.equal(p.armor, 50, 'a mini shield stops at 50');
});

test('the bag is capped per item', () => {
  const p = person();
  assert.equal(addItem(p, ITEM.MEDKIT, 5), ITEMS[ITEM.MEDKIT].max);
  assert.ok(!canCarry(p, ITEM.MEDKIT));
  assert.equal(addItem(p, ITEM.MEDKIT, 1), 0);
});

test('items, tiers and drops pack losslessly', () => {
  const items = [0, 5, 2, 15, 1];
  assert.deepEqual(unpackItems(packItems(items)), items);
  const tiers = [3, 0, 2, 1, 3];
  assert.deepEqual(unpackTiers(packTiers(tiers)), tiers);
  assert.equal(tierMult(0), 1);
  assert.ok(tierMult(3) > tierMult(2) && tierMult(2) > tierMult(1) && tierMult(1) > 1);
  assert.equal(rollTier(0.99), 0); assert.equal(rollTier(0.01), 3);
  assert.ok(rollTier(0.3, 0.25) > rollTier(0.3), 'luck raises the tier');
  assert.equal(rollDrop(2, 0.1, 0.5).type, 0);
  assert.equal(rollDrop(2, 0.9, 0.1).a, ITEM.BANDAGE);
  assert.notDeepEqual(lootFor('health', 0), lootFor('health', 1));
  assert.equal(lootFor('shield', 1).item, ITEM.MINI);
});

/* ------------------------------------------------------------------ in a room */

let seq = 0;
function push(p, { buttons = 0, weapon = 'pistol', emote = 0, room }) {
  p.queue.push({ seq: ++seq, ix: 0, iz: 0, yawQ: quantYaw(0), pitchQ: quantPitch(0), buttons, weapon: WEAPON_IDS.indexOf(weapon), emote, viewTick: room.tick });
}
const hold = (room, p, ticks, opts = {}) => { for (let i = 0; i < ticks; i++) { push(p, { ...opts, room }); room.step(); } };
const use = (kind) => kind << ITEM_SHIFT;

function twoInARound() {
  const { room, clock } = makeRoom();
  const A = join(room, 'A'), B = join(room, 'B');
  startRound(room, [A, B], { mode: 'dm' });
  for (const q of [A.p, B.p]) q.invulnTimer = 0;
  return { room, clock, A, B };
}

test('on the server the channel runs from the command bits, heals on completion, and the bag is spent', () => {
  const { room, A } = twoInARound();
  A.p.health = 40; A.p.items[ITEM.BANDAGE] = 2;
  hold(room, A.p, 60, { buttons: use(ITEM.BANDAGE) });
  assert.equal(A.p.useKind, ITEM.BANDAGE, 'half way through');
  assert.equal(A.p.health, 40, 'nothing lands early');
  hold(room, A.p, 330, { buttons: use(ITEM.BANDAGE) });
  assert.equal(A.p.health, 55);
  assert.equal(A.p.items[ITEM.BANDAGE], 1);
  assert.equal(A.p.useKind, 0);
});

test('firing, throwing, swapping or dancing cancels it on the server', () => {
  for (const [label, extra] of [['fire', { buttons: BTN.FIRE | use(ITEM.BANDAGE) }], ['frag', { buttons: BTN.FRAG | use(ITEM.BANDAGE) }], ['emote', { buttons: use(ITEM.BANDAGE), emote: 1 }]]) {
    const { room, A } = twoInARound();
    A.p.health = 40; A.p.items[ITEM.BANDAGE] = 1;
    hold(room, A.p, 120, { buttons: use(ITEM.BANDAGE) });
    assert.equal(A.p.useKind, ITEM.BANDAGE, label);
    hold(room, A.p, 3, extra);
    assert.equal(A.p.useKind, 0, `${label} cancelled`);
    assert.equal(A.p.items[ITEM.BANDAGE], 1, `${label} kept the item`);
    assert.equal(A.p.health, 40);
  }
  const { room, A } = twoInARound();
  A.p.health = 40; A.p.items[ITEM.BANDAGE] = 1;
  hold(room, A.p, 120, { buttons: use(ITEM.BANDAGE) });
  hold(room, A.p, 3, { buttons: use(ITEM.BANDAGE), weapon: 'ar' });
  assert.equal(A.p.useKind, 0, 'swapping guns cancelled');
});

test('a hit does not cancel it, and death does', () => {
  const { room, A, B } = twoInARound();
  A.p.health = 60; A.p.items[ITEM.BANDAGE] = 1;
  hold(room, A.p, 100, { buttons: use(ITEM.BANDAGE) });
  room.applyDamage(A.p, 10, B.p, A.p.pos, false, 'body', 'ar');
  hold(room, A.p, 5, { buttons: use(ITEM.BANDAGE) });
  assert.equal(A.p.useKind, ITEM.BANDAGE);
  A.p.armor = 0; A.p.health = 1;
  room.applyDamage(A.p, 50, B.p, A.p.pos, false, 'body', 'ar');
  assert.ok(!A.p.alive);
  assert.equal(A.p.useKind, 0);
});

test('dying drops loot where you fell, in everything but a duel; walking over it picks it up', () => {
  const { room, A, B } = twoInARound();
  room.drops.length = 0;
  A.p.health = 1; A.p.armor = 0;
  room.applyDamage(A.p, 50, B.p, A.p.pos, false, 'body', 'ar');
  assert.equal(room.drops.length, 1);
  const d = room.drops[0];
  assert.ok(Math.hypot(d.x - A.p.body.position.x, d.z - A.p.body.position.z) < 0.01);
  // Put the drop where B stands and make it something B can use.
  d.x = B.p.body.position.x; d.z = B.p.body.position.z; d.y = B.p.body.position.y;
  Object.assign(d, { type: 1, a: ITEM.MEDKIT, b: 1 });
  run(room, 0.1);
  assert.equal(B.p.items[ITEM.MEDKIT], 1);
  assert.equal(room.drops.length, 0);
});

test('a better gun on the floor upgrades yours; a worse one only gives ammo', () => {
  const { room, B } = twoInARound();
  const at = B.p.body.position;
  room.drops.length = 0;
  room.drops.push({ id: 9, type: 0, a: WEAPON_IDS.indexOf('ar'), b: 2, x: at.x, y: at.y, z: at.z, life: 30 });
  B.p.ammo.ar.reserve = 10;
  run(room, 0.1);
  assert.equal(B.p.tiers[WEAPON_IDS.indexOf('ar')], 2);
  assert.ok(B.p.ammo.ar.reserve > 10);
  room.drops.push({ id: 10, type: 0, a: WEAPON_IDS.indexOf('ar'), b: 1, x: at.x, y: at.y, z: at.z, life: 30 });
  B.p.ammo.ar.reserve = 10;
  run(room, 0.1);
  assert.equal(B.p.tiers[WEAPON_IDS.indexOf('ar')], 2, 'not downgraded');
  assert.equal(room.drops.length, 0, 'but the ammo was taken');
  room.drops.push({ id: 11, type: 0, a: WEAPON_IDS.indexOf('ar'), b: 0, x: at.x, y: at.y, z: at.z, life: 30 });
  B.p.ammo.ar.mag = 30; B.p.ammo.ar.reserve = 270;
  run(room, 0.1);
  assert.equal(room.drops.length, 1, 'a full gun leaves it on the floor');
});

test('a higher tier hits harder, and the drops and items reach the client in a snapshot', () => {
  const { room, clock, A } = twoInARound();
  A.p.items[ITEM.MINI] = 3; A.p.tiers[1] = 3;
  const ar = WEAPONS.find((w) => w.id === 'ar');
  room.bullets.length = 0;
  room.fire(A.p, ar, 0);
  assert.ok(Math.abs(room.bullets[0].damage - ar.damage * tierMult(3)) < 1e-9, 'legendary rifle damage');
  room.bullets.length = 0;
  A.p.tiers[1] = 0;
  room.fire(A.p, ar, 0);
  assert.equal(room.bullets[0].damage, ar.damage);
  A.p.tiers[1] = 3;
  const at = A.p.body.position;
  room.drops.push({ id: 5, type: 1, a: ITEM.BIG, b: 1, x: at.x + 20, y: at.y, z: at.z + 20, life: 30 });
  A.conn.sent.length = 0;
  clock.t += 100;
  room.update();
  const snap = readSnapshot(A.conn.sent.findLast((d) => typeof d !== 'string'));
  assert.ok(snap, 'a snapshot arrived');
  assert.equal(snap.you.items[ITEM.MINI], 3);
  assert.equal(snap.you.tiers[1], 3);
  assert.deepEqual(snap.drops.map((d) => [d.id, d.type, d.a, d.b]), [[5, 1, ITEM.BIG, 1]]);
  assert.ok(snap.phase === PHASE.PLAYING && MSG_SNAPSHOT === 2);
});
