import { expect, test } from '@playwright/test';

import { bootGame, startMatch } from './helpers/game.mjs';

/**
 * Characters and animation clips both fail SILENTLY when they fail.
 *
 * A clip whose track names do not match the skeleton is not an error — AnimationMixer binds
 * what it can and ignores the rest, so a fully broken retarget looks exactly like a working
 * one until you watch a bot stand frozen in its T-pose. Both the FBX exporter and the GLB
 * converter strip the colon from `mixamorig:Hips`, and both are patched to put it back, so
 * these assert that the binding actually happened rather than that the files merely loaded.
 */

test('every roster character and animation clip loads', async ({ page }) => {
  await bootGame(page);

  const assets = await page.evaluate(() => globalThis.__game.assets);

  expect(assets.soldier).toBe(true);
  expect(assets.characters).toEqual(
    expect.arrayContaining(['soldier', 'swat', 'trooper', 'gasmask', 'crypto', 'ely', 'steve']),
  );
  expect(assets.anims).toEqual(
    expect.arrayContaining(['Idle', 'Walk', 'Run', 'StrafeLeft', 'StrafeRight', 'WalkBack', 'Crouch', 'Death']),
  );
});

test('clips bind to the skeleton of whichever character a bot got', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'hard' });

  const bound = await page.evaluate(() => {
    const g = globalThis.__game;
    const out = [];
    for (const bot of g.bots) {
      const clips = bot.mesh.userData.clips;
      const bones = bot.mesh.userData.bones;
      if (!clips) { out.push({ rigged: false }); continue; }

      // Every named object in the subtree, not just bones: AnimationMixer resolves a track
      // against any object by name, and soldier.glb's own clips drive a few non-bone nodes.
      const skeleton = new Set();
      bot.mesh.traverse((o) => { if (o.name) skeleton.add(o.name); });

      // And the nodes every loaded clip wants to drive.
      let wanted = 0, matched = 0;
      for (const action of Object.values(clips)) {
        for (const track of action.getClip().tracks) {
          wanted++;
          if (skeleton.has(track.name.split('.')[0])) matched++;
        }
      }
      out.push({
        rigged: true,
        clipNames: Object.keys(clips).sort(),
        wanted,
        matched,
        // The aim code drives these directly; a missing one silently disables spine aiming.
        aimBones: ['Spine1', 'Spine2', 'Neck', 'Head'].filter((b) => bones && bones[b]).length,
      });
    }
    return out;
  });

  expect(bound.length).toBeGreaterThan(0);
  for (const bot of bound) {
    expect(bot.rigged).toBe(true);
    expect(bot.clipNames).toEqual(
      ['Crouch', 'Death', 'Idle', 'Run', 'StrafeLeft', 'StrafeRight', 'Walk', 'WalkBack'],
    );
    expect(bot.wanted).toBeGreaterThan(0);
    // Every track must bind. A partial match means a retarget regression.
    expect(bot.matched).toBe(bot.wanted);
    expect(bot.aimBones).toBe(4);
  }
});

/**
 * Characters made of several skinned meshes (Trooper's head, Steve's gear) come out of
 * FBXLoader with a second bone of the same name wherever two meshes share one, parented to the
 * first. If those twins ever stopped following, that part of the character would stand frozen
 * in its bind pose while the rest ran — a floating head. Play a clip on every character and
 * check each twin stays on its namesake.
 */
test('every part of a split character moves with the one skeleton', async ({ page }) => {
  await bootGame(page);
  const r = await page.evaluate(() => {
    const g = globalThis.__game;
    const a = new g.THREE.Vector3(), b = new g.THREE.Vector3();
    return g.assets.characters.filter((id) => id !== 'soldier').map((id) => {
      const mesh = g.buildCharacterMesh(id);
      const { mixer, clips } = mesh.userData;
      const bones = new Map();
      mesh.traverse((o) => { if (o.isBone) bones.set(o.name, o); });
      mesh.updateMatrixWorld(true);
      const before = new Map([...bones].map(([n, o]) => [n, o.getWorldPosition(new g.THREE.Vector3())]));
      // Every clip is already playing at weight 0 except Idle; switch the pose to a run.
      clips.Idle.weight = 0;
      clips.Run.weight = 1;
      mixer.update(0.37);
      mesh.updateMatrixWorld(true);
      let twins = 0, worst = 0;
      for (const [name, bone] of bones) {
        const base = /^(.*)_\d+$/.exec(name)?.[1];
        if (!base || !bones.has(base)) continue;
        twins++;
        worst = Math.max(worst, bone.getWorldPosition(a).distanceTo(bones.get(base).getWorldPosition(b)));
      }
      // The clip really posed it: some limb has moved well away from where Idle held it.
      let moved = 0;
      for (const [n, o] of bones) moved = Math.max(moved, o.getWorldPosition(a).distanceTo(before.get(n)));
      return { id, twins, worst, moved };
    });
  });
  expect(r.length).toBeGreaterThanOrEqual(6);
  expect(r.some((c) => c.twins > 0)).toBe(true);        // the case this test is for is present
  for (const c of r) {
    expect(c.worst, c.id).toBeLessThan(1e-4);
    expect(c.moved, c.id).toBeGreaterThan(0.15);
  }
});

test('bots in a team match draw from that team\'s cast', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'tdm', map: 'warehouse', diff: 'medium' });

  const cast = await page.evaluate(() => {
    const g = globalThis.__game;
    const allowed = Object.fromEntries(g.bots.map((b) => [b.name, b.team]));
    void allowed;
    // Characters carry no id at runtime, so identify them by vertex count, which differs
    // per model and is stable for a given asset.
    return g.bots.map((b) => {
      let verts = 0;
      b.mesh.traverse((o) => {
        if (o.isSkinnedMesh) verts += o.geometry.attributes.position.count;
      });
      return { team: b.team, verts };
    });
  });

  expect(cast.length).toBeGreaterThan(2);
  const blue = new Set(cast.filter((c) => c.team === 1).map((c) => c.verts));
  const red = new Set(cast.filter((c) => c.team === 2).map((c) => c.verts));
  expect(blue.size).toBeGreaterThan(0);
  expect(red.size).toBeGreaterThan(0);
  // Disjoint casts: no model appears on both sides, which is the whole point of splitting
  // the roster by team.
  for (const v of blue) expect(red.has(v)).toBe(false);
});

test('a dead bot plays the death clip instead of the procedural tip-over', async ({ page }) => {
  await bootGame(page);
  await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });

  const death = await page.evaluate(() => {
    const g = globalThis.__game;
    const bot = g.bots[0];
    bot.die();
    bot.simStep(1 / 120);
    bot.renderStep(1 / 60);
    const clips = bot.mesh.userData.clips;
    return {
      hasDeathClip: Boolean(clips?.Death),
      deathWeight: clips?.Death?.weight ?? null,
      deathRunning: clips?.Death?.isRunning() ?? null,
      idleWeight: clips?.Idle?.weight ?? null,
      // The authored clip lays the body down itself, so the mesh must stay upright.
      meshPitch: bot.mesh.rotation.x,
    };
  });

  expect(death.hasDeathClip).toBe(true);
  expect(death.deathWeight).toBe(1);
  expect(death.deathRunning).toBe(true);
  expect(death.idleWeight).toBe(0);
  expect(death.meshPitch).toBe(0);
});
