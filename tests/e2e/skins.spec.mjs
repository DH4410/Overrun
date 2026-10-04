import { expect, test } from '@playwright/test';

import { SKINS } from '../../src/skins.js';
import { bootGame, watchRuntimeErrors } from './helpers/game.mjs';

/**
 * The locker's SKINS tab: every character, all unlocked, picked with one click and remembered.
 * Skins that are not `boot` load the first time somebody wears one.
 */

test('the locker lists every skin with a portrait, and wearing one is remembered', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await bootGame(page);
  await page.click('#locker-open');
  await page.click('#locker .lk-tabs [data-tab="skins"]');
  await expect(page.locator('#locker .lk-skin')).toHaveCount(SKINS.length);
  await expect(page.locator('#lk-gear')).toBeHidden();
  await expect(page.locator('#locker-reset')).toBeHidden();

  // Every card has its portrait, drawn from assets/skins/.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#locker .lk-skin img')].filter((i) => !i.naturalWidth).length)).toBe(0);

  const pick = SKINS[SKINS.length - 1];
  await page.click(`#locker .lk-skin[data-skin="${pick.id}"]`);
  await expect(page.locator(`#locker .lk-skin.worn[data-skin="${pick.id}"]`)).toHaveCount(1);
  await expect(page.locator('#lk-wear b')).toHaveText(pick.name);
  expect(await page.evaluate(() => localStorage.getItem('overrun-skin'))).toBe(pick.id);
  // Worn means loaded: the lobby, the emote and the other players' screens all draw it at once.
  await expect.poll(() => page.evaluate((id) => globalThis.__game.assets.characters.includes(id) || Boolean(globalThis.__game.buildCharacterMesh(id)), pick.id)).toBe(true);

  // Back to the weapons: the loadout panel is untouched.
  await page.click('#locker .lk-tabs [data-tab="gear"]');
  await expect(page.locator('#lk-gear')).toBeVisible();
  await expect(page.locator('#locker .lk-slot')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('a skin that is not loaded at boot loads on demand, and a made-up one does not', async ({ page }) => {
  await bootGame(page);
  const r = await page.evaluate(async (lazy) => {
    const g = globalThis.__game;
    const out = { bogus: await g.loadCharacter('nobody'), before: [], after: [] };
    for (const id of lazy) {
      out.before.push(Boolean(g.buildCharacterMesh(id)));
      out.after.push((await g.loadCharacter(id)) && Boolean(g.buildCharacterMesh(id)));
    }
    return out;
  }, SKINS.filter((s) => !s.boot).map((s) => s.id));
  expect(r.bogus).toBe(false);
  expect(r.before.every((v) => v === false)).toBe(true);
  expect(r.after.every((v) => v === true)).toBe(true);
});

/**
 * The same bar as the roster characters (characters.spec.mjs): every shared clip track finds its
 * bone, the aim bones exist, the extra skeleton copies of split characters follow their bones, and
 * a clip really poses the body. A skin that fails these stands frozen or lies flat on a screen,
 * so none ships without passing.
 */
test('every lazy skin binds the shared clips, aims, and animates as one piece', async ({ page }) => {
  test.setTimeout(180_000);
  await bootGame(page);
  const r = await page.evaluate(async (lazy) => {
    const g = globalThis.__game;
    const a = new g.THREE.Vector3(), b = new g.THREE.Vector3();
    const out = [];
    for (const id of lazy) {
      await g.loadCharacter(id);
      const mesh = g.buildCharacterMesh(id);
      const { mixer, clips, bones: named } = mesh.userData;
      const names = new Set();
      mesh.traverse((o) => { if (o.name) names.add(o.name); });
      let wanted = 0, matched = 0;
      const missing = new Set();
      for (const action of Object.values(clips)) {
        for (const track of action.getClip().tracks) {
          wanted++;
          const node = track.name.split('.')[0];
          if (names.has(node)) matched++; else missing.add(node);
        }
      }
      const bones = new Map();
      mesh.traverse((o) => { if (o.isBone) bones.set(o.name, o); });
      mesh.updateMatrixWorld(true);
      const before = new Map([...bones].map(([n, o]) => [n, o.getWorldPosition(new g.THREE.Vector3())]));
      clips.Idle.weight = 0; clips.Run.weight = 1;
      mixer.update(0.37);
      mesh.updateMatrixWorld(true);
      let worst = 0, moved = 0;
      for (const [name, bone] of bones) {
        const base = /^(.*)_\d+$/.exec(name)?.[1];
        if (base && bones.has(base)) worst = Math.max(worst, bone.getWorldPosition(a).distanceTo(bones.get(base).getWorldPosition(b)));
      }
      for (const [n, o] of bones) moved = Math.max(moved, o.getWorldPosition(a).distanceTo(before.get(n)));
      out.push({ id, wanted, matched, missing: [...missing], aim: ['Spine1', 'Spine2', 'Neck', 'Head'].filter((n) => named?.[n]).length, worst, moved });
    }
    return out;
  }, SKINS.filter((s) => !s.boot).map((s) => s.id));
  for (const c of r) {
    expect(c.wanted, c.id).toBeGreaterThan(0);
    // Mixamo's thin rigs (Prisoner, Mutant) have no fingers: those tracks have nothing to drive.
    // Any other bone missing would mean a body part stuck in its bind pose.
    expect(c.missing.filter((n) => !/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(n)), `${c.id}: unbound tracks`).toEqual([]);
    expect(c.matched, c.id).toBeGreaterThan(c.wanted * 0.5);
    expect(c.aim, `${c.id}: aim bones`).toBe(4);
    expect(c.worst, c.id).toBeLessThan(1e-4);
    expect(c.moved, c.id).toBeGreaterThan(0.15);
  }
});
