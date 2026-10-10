import * as THREE from 'three';

import { buildItemMesh, part } from './itemModels.js';
import { ITEM } from './sim/items.js';

/**
 * What someone else's healing looks like from outside. The snapshot only says "using", not which
 * item, so every healer is shown opening a medkit in front of their chest, with a soft green pulse
 * round it that reads from across a room. Their gun is hidden for the duration (client.js).
 */

const glowGeo = new THREE.SphereGeometry(0.2, 14, 10);
const glowMat = new THREE.MeshBasicMaterial({
  color: 0x5fe39a, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending,
});

/**
 * Show, move or hide the prop on one puppet. `b.mesh` is the scaled rig, so the prop is placed in
 * its units. Its origin is the body centre (about 0.8 m up), so the chest is a little above it and
 * the prop sits a third of a metre ahead (the rig faces -Z).
 */
export function updateHealProp(b, using, now) {
  if (using && !b.healProp) {
    const root = new THREE.Group();
    const kit = buildItemMesh(ITEM.MEDKIT);
    kit.scale.setScalar(0.62);
    kit.rotation.x = -0.35;
    const lid = part(kit, 'lid');
    if (lid) lid.rotation.x = -1.25;
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.y = 0.02;
    root.add(kit, glow);
    b.healProp = root;
    b.mesh.add(root);
  }
  const root = b.healProp;
  if (!root) return;
  root.visible = using;
  if (!using) return;
  const k = 1 / (b.mesh.scale.y || 1);
  const s = Math.sin(now * 0.006);
  root.scale.setScalar(k);
  root.position.set(0.02 * k, (0.3 + s * 0.015) * k, -0.34 * k);
  glowMat.opacity = 0.26 + 0.12 * s;
}
