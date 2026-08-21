import * as THREE from 'three';

/** Shared physically based material helper used by maps, actors, pickups, and weapons. */
export function matte(color, rough = 0.65, metal = 0.35) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

/** Geometry that intentionally survives map teardown and is reused by runtime systems. */
const SHARED_GEO = new Set();

export function markShared(...geometries) {
  for (const geometry of geometries) SHARED_GEO.add(geometry);
}

export function disposeTree(root) {
  root.traverse((object) => {
    if (object.isMesh && object.geometry && !SHARED_GEO.has(object.geometry)) {
      object.geometry.dispose();
    }
  });
}
