import * as THREE from 'three';
import { TEAM, TEAM_COLOR } from './config.js';

/**
 * Hardpoint: one capture zone, standing in it alone scores for your team, and it moves on so
 * nobody can camp one corner. The zone is a ring on the floor with a tall beam so it can be seen
 * across the map; a small HUD chip carries the distance and an arrow when it is off screen.
 */
export const HP_RADIUS = 4.5;
export const HP_ROTATE = 45;          // seconds a zone stays put
export const HP_TARGET = 100;         // points to win; one a second for the holding team
const MIN_JUMP = 16;                  // the next zone is at least this far from the last
const NEUTRAL = 0xe8eef6, CONTESTED = 0xffc233;

export function createHardpoint({ scene, waypoints, setPatrolFocus, hud, player, camera }) {
  const group = new THREE.Group();
  group.visible = false;
  const mat = (opacity) => new THREE.MeshBasicMaterial({
    color: NEUTRAL, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(HP_RADIUS - 0.35, HP_RADIUS, 48), mat(0.9));
  ring.rotation.x = -Math.PI / 2;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(HP_RADIUS - 0.35, 48), mat(0.16));
  disc.rotation.x = -Math.PI / 2;
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(HP_RADIUS, HP_RADIUS, 2.2, 48, 1, true), mat(0.12));
  wall.position.y = 1.1;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 60, 12, 1, true), mat(0.35));
  beam.position.y = 30;
  group.add(disc, ring, wall, beam);
  group.traverse((o) => { o.frustumCulled = false; });
  scene.add(group);
  const parts = [ring, disc, wall, beam];
  const paint = (hex) => parts.forEach((m) => m.material.color.setHex(hex));

  // The chip: a flag icon, the distance, and an arrow that turns toward the zone.
  const chip = document.createElement('div');
  chip.id = 'hp-chip';
  chip.innerHTML = '<svg class="hp-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1l5 11-5-3-5 3z"/></svg>'
    + '<svg class="hp-flag" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 15V1.5M3 2h9l-2 3 2 3H3"/></svg>'
    + '<b class="hp-dist">0</b>';
  chip.hidden = true;
  hud.appendChild(chip);
  const arrow = chip.querySelector('.hp-arrow');
  const dist = chip.querySelector('.hp-dist');

  const st = {
    active: false, pos: new THREE.Vector3(), owner: 0, contested: false,
    age: 0, tick: 0, spots: 0,
  };

  function pickSpot() {
    if (!waypoints.length) return;
    // Waypoints near the middle of the map make the fairest zone, so weight toward them.
    const c = new THREE.Vector3();
    for (const w of waypoints) c.add(w.pos);
    c.divideScalar(waypoints.length);
    const ranked = waypoints
      .filter((w) => st.spots === 0 || w.pos.distanceTo(st.pos) >= MIN_JUMP)
      .map((w) => [w.pos.distanceToSquared(c) * (0.6 + Math.random() * 0.8), w])
      .sort((a, b) => a[0] - b[0]);
    const w = (ranked[0] ?? [0, waypoints[0]])[1];
    st.pos.copy(w.pos);
    // Waypoints sit a little above the floor; the ring wants to lie on it.
    group.position.set(w.pos.x, w.pos.y - 0.45, w.pos.z);
    st.spots++;
    setPatrolFocus(st.pos);
  }

  function begin() {
    st.active = true; st.owner = 0; st.contested = false; st.age = 0; st.tick = 0; st.spots = 0;
    pickSpot();
    group.visible = true; chip.hidden = false;
    paint(NEUTRAL);
  }

  function end() {
    st.active = false;
    group.visible = false; chip.hidden = true;
    setPatrolFocus(null);
  }

  /**
   * Called every sim step. `team` holders count only while alive and standing in the cylinder.
   * Returns the team that scored a point this call (or 0).
   */
  function update(dt, combatants) {
    if (!st.active) return 0;
    st.age += dt;
    let blue = 0, red = 0;
    for (const c of combatants) {
      if (!c.alive) continue;
      const p = c.body.position;
      const dx = p.x - st.pos.x, dz = p.z - st.pos.z;
      if (dx * dx + dz * dz > HP_RADIUS * HP_RADIUS || Math.abs(p.y - st.pos.y) > 3) continue;
      if (c.team === TEAM.BLUE) blue++; else if (c.team === TEAM.RED) red++;
    }
    st.contested = blue > 0 && red > 0;
    st.owner = st.contested ? 0 : blue > 0 ? TEAM.BLUE : red > 0 ? TEAM.RED : 0;
    paint(st.contested ? CONTESTED : st.owner ? TEAM_COLOR[st.owner] : NEUTRAL);
    // A slow breathing on the wall so a held zone reads as live rather than painted on.
    wall.material.opacity = 0.1 + 0.05 * Math.sin(st.age * 3);

    let scored = 0;
    if (st.owner) {
      st.tick += dt;
      if (st.tick >= 1) { st.tick -= 1; scored = st.owner; }
    } else {
      st.tick = 0;
    }
    if (st.age >= HP_ROTATE) { st.age = 0; pickSpot(); paint(NEUTRAL); st.moved = true; }
    return scored;
  }

  /** Per rendered frame: the distance and which way to turn, from the player's camera. */
  function updateHud() {
    if (!st.active) return;
    const dx = st.pos.x - camera.position.x, dz = st.pos.z - camera.position.z;
    dist.textContent = `${Math.round(Math.hypot(dx, dz))}`;
    // Bearing to the zone relative to where the camera looks, so the arrow points the way to turn.
    const look = Math.atan2(-dx, -dz);
    let d = look - player.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    arrow.style.transform = `rotate(${(-d * 180) / Math.PI}deg)`;
    chip.dataset.state = st.contested ? 'contested' : st.owner === TEAM.BLUE ? 'mine' : st.owner === TEAM.RED ? 'theirs' : 'open';
  }

  return { state: st, begin, end, update, updateHud, radius: HP_RADIUS, target: HP_TARGET, rotateEvery: HP_ROTATE };
}
