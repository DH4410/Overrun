import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEAPON_BY_ID, damageAt } from '../../src/sim/weaponData.js';
import { PLAYER_ZONE_MULT } from '../../src/sim/hitmath.js';
import { CONFIG } from '../../src/config.js';

/**
 * Time to kill, from the numbers. Every shot is assumed to land on the body with no bloom, so
 * these are the best a gun can do; the point is the ORDER of the guns at each range, which is
 * the design: the pump rules the first few metres, the rifle the middle, the sniper everything
 * beyond, and nothing is a one-button answer.
 */
const spawn = CONFIG.MAX_HEALTH + CONFIG.START_ARMOR;      // 150 effective hit points
const full = CONFIG.MAX_HEALTH + CONFIG.MAX_ARMOR;         // 200 with a full shield
const body = PLAYER_ZONE_MULT.body;

function perShot(w, dist, zone = 'body') {
  return damageAt(w, dist) * (PLAYER_ZONE_MULT[zone] ?? 1) * w.pellets;
}
/** Seconds from the first trigger pull to the shot that kills; Infinity when it cannot. */
function ttk(id, dist, hp = spawn, zone = 'body') {
  const w = WEAPON_BY_ID[id];
  const dmg = perShot(w, dist, zone);
  if (dmg <= 0) return Infinity;
  const shots = Math.ceil(hp / dmg);
  if (shots > w.mag) return Infinity;
  return (shots - 1) * w.cooldown;
}
const shots = (id, dist, hp = spawn, zone = 'body') => Math.ceil(hp / perShot(WEAPON_BY_ID[id], dist, zone));

test('damageAt: full out to near, straight line to min at far, flat after', () => {
  const w = { damage: 100, falloff: [10, 30, 0.5] };
  assert.equal(damageAt(w, 0), 100);
  assert.equal(damageAt(w, 10), 100);
  assert.equal(damageAt(w, 20), 75);
  assert.equal(damageAt(w, 30), 50);
  assert.equal(damageAt(w, 500), 50);
  assert.equal(damageAt({ damage: 80, falloff: null }, 500), 80);
});

test('the pump: one shot at the muzzle, nothing worth a shot at range', () => {
  assert.equal(shots('shotgun', 3), 1, 'a full load kills a fresh spawn at point-blank');
  assert.equal(shots('shotgun', 3, full), 2, 'but not a full shield');
  assert.ok(perShot(WEAPON_BY_ID.shotgun, 8) < spawn, 'two by 8 m');
  assert.ok(perShot(WEAPON_BY_ID.shotgun, 20) < 40, 'a graze at 20 m');
  assert.ok(ttk('shotgun', 3) < ttk('ar', 3), 'faster than the rifle up close');
  assert.ok(ttk('shotgun', 3) < ttk('smg', 3));
  assert.ok(ttk('shotgun', 30) > ttk('ar', 30), 'and worse than the rifle far out');
});

test('the sniper: a body shot kills a fresh spawn at any range, a head shot kills anything', () => {
  const s = WEAPON_BY_ID.sniper;
  for (const d of [5, 60, 200]) assert.equal(shots('sniper', d), 1, `${d} m`);
  assert.equal(shots('sniper', 60, full), 2, 'a full shield survives a body shot');
  assert.equal(shots('sniper', 60, full, 'head'), 1, 'but not a head shot');
  assert.ok(s.damage > WEAPON_BY_ID.ar.damage * 5);
});

test('the rifle is the all-rounder and is slower than it used to be', () => {
  const ar = WEAPON_BY_ID.ar;
  assert.ok(ar.damage < ar.botDamage, 'the player\'s rifle was nerfed');
  assert.equal(shots('ar', 10), 7);
  assert.ok(ttk('ar', 10) > 0.5 && ttk('ar', 10) < 0.7);
  assert.equal(shots('ar', 10, spawn, 'head'), 3, 'three to the head');
  assert.ok(ttk('ar', 80) > ttk('ar', 10), 'falls off, gently');
  assert.ok(perShot(ar, 80) >= ar.damage * 0.7 - 1e-9);
});

test('the SMG wins close and loses at range; the pistol is a backup', () => {
  assert.ok(ttk('smg', 5) <= ttk('ar', 5) + 1e-9);
  assert.ok(ttk('smg', 40) > ttk('ar', 40));
  assert.ok(ttk('pistol', 10) > ttk('ar', 10) * 2);
});

test('the sniper pays for a one-shot kill with the cost of a miss', () => {
  // Perfect aim makes it the best gun at every range, so the balance is the miss: a long
  // cooldown, a small magazine, and the heaviest movement penalty in the table.
  const s = WEAPON_BY_ID.sniper;
  assert.ok(s.cooldown >= 1.2 && s.mag <= 5);
  for (const id of ['ar', 'smg', 'shotgun', 'pistol']) assert.ok(s.move > WEAPON_BY_ID[id].move, id);
});

test('shields are a separate pool: nothing soaks only part of a hit', () => {
  assert.equal(CONFIG.ARMOR_ABSORB, 1);
  assert.equal(CONFIG.MAX_ARMOR, 100);
});

test('the shotgun at point-blank cannot out-damage the sniper', () => {
  assert.ok(perShot(WEAPON_BY_ID.shotgun, 0) < perShot(WEAPON_BY_ID.sniper, 0) * 1.1);
  assert.ok(body === 1);
});
