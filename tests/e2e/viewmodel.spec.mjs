import { expect, test } from '@playwright/test';

import { bootGame, pumpFrames, setGamepadButton, startMatch } from './helpers/game.mjs';

/**
 * The first-person gun, aimed. The playtest report was "when I aim, the gun covers the aiming
 * spot — I can't see anything". Aiming must put the gun's own sight on the centre of the screen
 * and keep every other part of it below the middle.
 */

/** Screen-space bounds (NDC) of every mesh in the held gun, split into sight parts and the rest. */
async function aimedBounds(page, id) {
  await page.evaluate((weaponId) => { globalThis.__game.player.current = weaponId; }, id);
  await setGamepadButton(page, 6, true);          // LT: aim
  await pumpFrames(page, 60);
  return page.evaluate(() => {
    const g = globalThis.__game;
    const { THREE, vmCamera, vmRig } = g;
    const model = g.vmModels[g.player.current];
    vmRig.updateMatrixWorld(true);
    vmCamera.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const out = { sight: [], rest: [] };
    model.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, inFront = 0;
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const z = v.clone().applyMatrix4(vmCamera.matrixWorldInverse).z;
        if (z > -vmCamera.near) continue;          // behind the near plane: never drawn
        inFront += 1;
        v.project(vmCamera);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      }
      if (!inFront) return;
      (o.userData.sightPart ? out.sight : out.rest).push({ minX, maxX, minY, maxY });
    });
    // Where the sight's own reference point lands on screen.
    const ref = model.userData.sight.clone().applyMatrix4(model.matrixWorld).project(vmCamera);
    return { ...out, ref: { x: ref.x, y: ref.y } };
  });
}

/**
 * An optic floats the sight line well above the gun, so the rest of a red-dot rifle must stay
 * clearly below the middle (NDC y = -0.06, about 3% of the screen). Iron sights ARE the top of
 * the gun — the slide or receiver sits just under them, as on the real thing — so for those the
 * rule is that nothing but the sights rises above the sight line.
 */
const CEILING = { ar: -0.06, pistol: 0.0, shotgun: 0.0 };

for (const id of ['ar', 'pistol', 'shotgun']) {
  test(`aiming the ${id} centres its sight and keeps the gun below the middle`, async ({ page }) => {
    await bootGame(page);
    await startMatch(page, { mode: 'dm', map: 'warehouse', diff: 'easy' });
    const b = await aimedBounds(page, id);
    // The sight line is on the axis.
    expect(Math.abs(b.ref.x)).toBeLessThan(0.01);
    expect(Math.abs(b.ref.y)).toBeLessThan(0.01);
    const intruders = b.rest.filter((r) => r.maxY > CEILING[id] && r.minX < 0.2 && r.maxX > -0.2);
    expect(intruders, JSON.stringify(intruders.slice(0, 3))).toHaveLength(0);
  });
}
