import * as THREE from 'three';

/**
 * PORT — the default map. A container port in daylight.
 *
 * Built because the existing levels were the weakest part of how the game moved and read: dark
 * sealed boxes with cartoon Kenney props, whose box colliders did not match their shapes (so you
 * bumped into air and snagged on corners), and ramps that were slabs you could get under. This
 * one follows a few rules the others did not:
 *
 *  - Every collider IS the visual. Cover is boxes and prisms — containers, barriers, crates, a
 *    loading dock — so what you see is exactly what you stand on, hide behind and slide along.
 *  - Heights are chosen for movement. Crates are 1.0 m, which a jump clears; containers are
 *    2.59 m, which it does not, so they are walls. The dock is 1.4 m: up by ramp, or by jumping
 *    off a crate beside it.
 *  - Daylight. A shooter is read by silhouette and contrast; a sunlit yard reads at 60 m where a
 *    dim warehouse loses you at 20.
 *  - 180-degree rotational symmetry, like Foundry, so a duel is decided by the players. Three
 *    lanes: a warehouse flank, a central plaza around the raised dock, a container-yard flank.
 *
 * Units are metres; +Z is south. Everything is placed for the south half through `both()`, which
 * emits each piece again rotated half a turn to the north.
 */
export const PORT_HALF_X = 50;
export const PORT_HALF_Z = 38;
export const PORT_CEIL = 16;

export function createPortMap({
  addSolid, addRamp, addBlocker, addStaticBox, mapGroup, pbrMat, ceilingLayer,
  addLightEmitter, buildSpawnPoints, spawnAmmoChests, spawnConsumables,
}) {
  const HX = PORT_HALF_X, HZ = PORT_HALF_Z;

  // Poly Haven materials, each with a fallback colour chosen to read correctly on its own when
  // the network is unavailable. repeat 1: tiling comes from each mesh's UV scale instead.
  let M = null;
  function materials() {
    if (M) return M;
    M = {
      ground: pbrMat('asphalt_floor', { repeat: 1, fallback: 0x55585b, rough: 0.95 }),
      dock: pbrMat('hangar_concrete_floor', { repeat: 1, fallback: 0x8d8a84, rough: 0.9 }),
      wall: pbrMat('concrete_block_wall', { repeat: 1, fallback: 0x9a958c, rough: 0.92 }),
      shed: pbrMat('factory_wall', { repeat: 1, fallback: 0x8a949c, rough: 0.7, metal: 0.3 }),
      barrier: pbrMat('rough_concrete', { repeat: 1, fallback: 0xa8a39a, rough: 0.95 }),
      crate: pbrMat('plywood', { repeat: 1, fallback: 0x9b7a52, rough: 0.8 }),
      metal: pbrMat('metal_plate', { repeat: 1, fallback: 0x5d646b, rough: 0.5, metal: 0.6 }),
      roof: new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.8, metalness: 0.3 }),
      trim: new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.6, metalness: 0.5 }),
      paint: new THREE.MeshStandardMaterial({
        color: 0xd8b13a, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2,
      }),
      paintWhite: new THREE.MeshStandardMaterial({
        color: 0xd6d8d4, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2,
      }),
      crane: new THREE.MeshStandardMaterial({ color: 0x9c8540, roughness: 0.6, metalness: 0.45 }),
      containers: [0x7d3b2e, 0x2f4a66, 0x3f5e4f, 0xb8b2a6, 0x9a5a2a, 0x4b4f55, 0x6b2f33, 0x2d5a63]
        .map((c) => pbrMat('container_side', { repeat: 1, fallback: c, tint: c, rough: 0.6, metal: 0.35 })),
    };
    return M;
  }

  /** Emit a piece in the south half and again rotated 180 degrees into the north half. */
  function both(emit) { emit(1); emit(-1); }

  /* ------------------------------ pieces ------------------------------ */

  /**
   * An ISO shipping container, 6.06 x 2.44 x 2.59 m, optionally stacked two high. `alongX` lays
   * its length along X. Corner posts and door rods are dressing; the collider is the box.
   */
  let containerIndex = 0;
  function container(x, z, alongX, stacked = false) {
    const L = 6.06, W = 2.44, H = 2.59;
    const w = alongX ? L : W, d = alongX ? W : L;
    for (let level = 0; level < (stacked ? 2 : 1); level++) {
      const y = H / 2 + level * H;
      const mat = M.containers[(containerIndex++ * 3) % M.containers.length];
      addSolid(w, H, d, x, y, z, mat, { uvScale: 1 / 2.6 });
      // Corner posts, and the lock rods on one end.
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, H, 0.16), M.trim);
        post.position.set(x + sx * (w / 2 - 0.06), y, z + sz * (d / 2 - 0.06));
        mapGroup.add(post);
      }
      for (let i = 0; i < 4; i++) {
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, H * 0.9, 6), M.trim);
        const t = (i - 1.5) * (W / 4.4);
        if (alongX) rod.position.set(x + L / 2 + 0.03, y, z + t);
        else rod.position.set(x + t, y, z + L / 2 + 0.03);
        mapGroup.add(rod);
      }
    }
  }

  /** A wooden crate on the floor (or on something: `baseY`). 1.0 m is jumpable. */
  function crate(x, z, size = 1.4, h = 1.0, baseY = 0) {
    addSolid(size, h, size, x, baseY + h / 2, z, M.crate, { uvScale: 1 / 1.2 });
    const band = new THREE.Mesh(new THREE.BoxGeometry(size + 0.02, 0.08, size + 0.02), M.trim);
    band.position.set(x, baseY + h * 0.78, z);
    mapGroup.add(band);
  }

  /** A concrete jersey barrier, 0.85 m tall: shoot over it standing, hide behind it crouched. */
  const barrierShape = (() => {
    const s = new THREE.Shape();
    s.moveTo(-0.3, 0); s.lineTo(0.3, 0); s.lineTo(0.3, 0.08); s.lineTo(0.12, 0.3);
    s.lineTo(0.09, 0.85); s.lineTo(-0.09, 0.85); s.lineTo(-0.12, 0.3); s.lineTo(-0.3, 0.08);
    s.closePath();
    return s;
  })();
  function barrier(x, z, alongX, len = 3.0) {
    const geo = new THREE.ExtrudeGeometry(barrierShape, { depth: len, bevelEnabled: false });
    geo.translate(0, 0, -len / 2);
    // UVs: scale so the concrete keeps a sensible size.
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.6, uv.getY(i) * 0.6);
    const m = new THREE.Mesh(geo, M.barrier);
    m.position.set(x, 0, z);
    if (alongX) m.rotation.y = Math.PI / 2;
    m.castShadow = true; m.receiveShadow = true;
    mapGroup.add(m);
    const hx = alongX ? len / 2 : 0.22, hz = alongX ? 0.22 : len / 2;
    addStaticBox(hx, 0.425, hz, { x, y: 0.425, z });
    addBlocker(x, z, alongX ? len / 2 : 0.3, alongX ? 0.3 : len / 2);
  }

  /** A cable spool: a wooden drum on its side. Collides as the box around it. */
  function spool(x, z, alongX) {
    const r = 0.7, len = 1.1;
    const g = new THREE.Group();
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, len, 16), M.crate);
    const f1 = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.08, 20), M.crate);
    const f2 = f1.clone();
    f1.position.y = len / 2; f2.position.y = -len / 2;
    g.add(drum, f1, f2);
    g.rotation.z = Math.PI / 2;
    if (!alongX) g.rotation.y = Math.PI / 2;
    g.position.set(x, r, z);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    mapGroup.add(g);
    addStaticBox(alongX ? len / 2 + 0.04 : r, r, alongX ? r : len / 2 + 0.04, { x, y: r, z });
    addBlocker(x, z, alongX ? len / 2 : r, alongX ? r : len / 2);
  }

  /** A wall run from (x0, z0) to (x1, z1), axis-aligned, `h` tall and `t` thick. */
  function wall(x0, z0, x1, z1, h, t, mat, uv = 1 / 3) {
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    if (len < 0.05) return;
    addSolid(alongX ? len : t, h, alongX ? t : len, (x0 + x1) / 2, h / 2, (z0 + z1) / 2, mat, { uvScale: uv });
  }

  /** A roof slab over a building, on the ceiling layer so the minimap sees under it. */
  function roof(x0, z0, x1, z1, y) {
    const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), M.roof);
    m.position.set((x0 + x1) / 2, y + 0.15, (z0 + z1) / 2);
    m.layers.set(ceilingLayer);
    m.castShadow = true; m.receiveShadow = true;
    mapGroup.add(m);
    addStaticBox(w / 2, 0.15, d / 2, { x: m.position.x, y: m.position.y, z: m.position.z });
  }

  /** A painted floor stripe. */
  function stripe(x, z, w, d, mat = M.paint) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.012, z);
    m.receiveShadow = true;
    mapGroup.add(m);
  }

  /* ------------------------------ sky ------------------------------ */

  function sky() {
    const geo = new THREE.SphereGeometry(420, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x4f86c0) },
        horizon: { value: new THREE.Color(0xc9dcea) },
        ground: { value: new THREE.Color(0x8e8a80) },
        sunDir: { value: new THREE.Vector3(-0.45, 0.72, 0.52).normalize() },
      },
      vertexShader: `varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.frustumCulled = false;
    dome.renderOrder = -10;
    mapGroup.add(dome);
  }

  /* ------------------------------ layout ------------------------------ */

  function buildPort() {
    materials();
    containerIndex = 0;
    sky();

    // Ground. One collider; the visible slab carries the asphalt at one tile per 4 m.
    const groundGeo = new THREE.PlaneGeometry(HX * 2, HZ * 2);
    const guv = groundGeo.attributes.uv;
    for (let i = 0; i < guv.count; i++) guv.setXY(i, guv.getX(i) * HX * 2 / 4, guv.getY(i) * HZ * 2 / 4);
    const ground = new THREE.Mesh(groundGeo, M.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    mapGroup.add(ground);
    addStaticBox(HX, 0.5, HZ, { x: 0, y: -0.5, z: 0 });

    // Perimeter: a 7 m block wall with a dark coping. These ARE the boundary, so no blocker
    // flag — the edge strips below keep spawns and the minimap honest.
    const WH = 7;
    wall(-HX - 0.75, -HZ, -HX - 0.75, HZ, WH, 1.5, M.wall);
    wall(HX + 0.75, -HZ, HX + 0.75, HZ, WH, 1.5, M.wall);
    wall(-HX - 1.5, -HZ - 0.75, HX + 1.5, -HZ - 0.75, WH, 1.5, M.wall);
    wall(-HX - 1.5, HZ + 0.75, HX + 1.5, HZ + 0.75, WH, 1.5, M.wall);
    addBlocker(0, -HZ, HX, 1.2); addBlocker(0, HZ, HX, 1.2);
    addBlocker(-HX, 0, 1.2, HZ); addBlocker(HX, 0, 1.2, HZ);

    /* ---- the dock: the contested centre, 1.4 m up, a ramp from each end ---- */
    const DOCK_H = 1.4;
    addSolid(16, DOCK_H, 10, 0, DOCK_H / 2, 0, M.dock, { uvScale: 1 / 4 });
    for (const [w, d, x, z] of [[16.2, 0.12, 0, 5.04], [16.2, 0.12, 0, -5.04], [0.12, 10.2, 8.04, 0], [0.12, 10.2, -8.04, 0]]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, d), M.paint);
      edge.position.set(x, DOCK_H + 0.07 - 0.07, z);
      mapGroup.add(edge);
    }
    both((s) => {
      // Ramp up onto the dock's end, and a 1.0 m crate beside the dock to jump up from.
      addRamp(s * 4.5, 0, s * 11.5, s * 4.5, DOCK_H, s * 5.0, 4.4, M.dock);
      crate(s * -9.3, s * 2.0);
      // Cover on the dock: a low steel barrier along the end away from the ramp, and crates.
      addSolid(8.5, 1.0, 0.5, s * -3.6, DOCK_H + 0.5, s * 4.5, M.metal, { uvScale: 1 / 2 });
      crate(s * 5.2, s * -1.8, 1.4, 1.0, DOCK_H);
      crate(s * -1.0, s * -2.6, 1.2, 1.0, DOCK_H);
    });

    /* ---- spawn sheds: a building at each end, open to the yard through two bays ---- */
    both((s) => {
      const z0 = 27, z1 = HZ, SH = 6;
      wall(s * -15, s * z0, s * -15, s * z1, SH, 0.6, M.shed);
      wall(s * 15, s * z0, s * 15, s * z1, SH, 0.6, M.shed);
      // Front wall with two 5 m bays, and lintels over them.
      wall(s * -15, s * z0, s * -11, s * z0, SH, 0.6, M.shed);
      wall(s * -6, s * z0, s * 6, s * z0, SH, 0.6, M.shed);
      wall(s * 11, s * z0, s * 15, s * z0, SH, 0.6, M.shed);
      for (const cx of [-8.5, 8.5]) {
        addSolid(5.2, 1.6, 0.6, s * cx, SH - 0.8, s * z0, M.shed, { block: false, uvScale: 1 / 3 });
      }
      roof(s * -15.3, s * (z0 - 0.3), s * 15.3, s * z1, SH);
      // Inside: a little cover so the doors are not a firing line into the back wall.
      crate(s * -9, s * 33, 1.6, 1.0);
      crate(s * 9.5, s * 31.5, 1.6, 1.0);
      stripe(s * 0, s * 29.2, 26, 0.18);
      addLightEmitter({ x: s * -7, y: SH - 0.6, z: s * 32.5, color: 0xffe1b8, intensity: 90, distance: 22, priority: 0 });
      addLightEmitter({ x: s * 7, y: SH - 0.6, z: s * 32.5, color: 0xffe1b8, intensity: 90, distance: 22, priority: 0 });
    });

    /* ---- the approach between each spawn and the plaza ---- */
    both((s) => {
      container(s * -5, s * 19.5, true);            // blocks the straight line spawn -> plaza
      container(s * 9, s * 17.2, false);
      barrier(s * 0.5, s * 14, true);
      barrier(s * -12.5, s * 15, false);
      crate(s * 2.4, s * 22.4);
      crate(s * -1.4, s * 23.0, 1.2, 1.0);
      spool(s * 13, s * 23.5, true);
    });

    /* ---- plaza cover round the dock ---- */
    both((s) => {
      barrier(s * -13, s * 6, false);
      barrier(s * 12.5, s * 9.5, true);
      spool(s * -11.5, s * -1.5, false);
      crate(s * 13.5, s * 1.0, 1.6, 1.0);
      stripe(s * 0, s * 12.5, 24, 0.18, M.paintWhite);
    });

    /* ---- the container yard (south-east, and north-west by symmetry) ---- */
    both((s) => {
      container(s * 22, s * 6, false);
      container(s * 22, s * 18.5, false, true);
      container(s * 29.5, s * 11.5, true);
      container(s * 36, s * 4.5, false, true);
      container(s * 36.5, s * 18, false);
      container(s * 44, s * 10.5, false);
      container(s * 44.5, s * 24, true, true);
      container(s * 29, s * 24.5, true);
      container(s * 24, s * 32.5, true);
      container(s * 40, s * 32.5, true, true);
      crate(s * 25.5, s * 14.2);
      crate(s * 40.2, s * 14.5, 1.4, 1.0);
      crate(s * 32.8, s * 30.2, 1.4, 1.0);
      // A gantry crane over the yard: legs collide, the beam is overhead dressing.
      for (const lz of [1.0, 28.5]) {
        addSolid(1.0, 13, 1.0, s * 32.5, 6.5, s * lz, M.crane, { uvScale: 1 / 3 });
        addSolid(1.0, 13, 1.0, s * 47, 6.5, s * lz, M.crane, { uvScale: 1 / 3 });
      }
      for (const lz of [1.0, 28.5]) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(15.5, 1.2, 1.2), M.crane);
        beam.position.set(s * 39.75, 13.4, s * lz);
        beam.castShadow = true;
        mapGroup.add(beam);
      }
      const girder = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 28.5), M.crane);
      girder.position.set(s * 39.75, 14.6, s * 14.75);
      girder.castShadow = true;
      mapGroup.add(girder);
      stripe(s * 26, s * 0.2, 0.18, 30);
      stripe(s * 33, s * 21.5, 0.18, 12);
    });

    /* ---- the warehouse flank (south-west, and north-east by symmetry) ---- */
    both((s) => {
      const x0 = -46, x1 = -20, z0 = 6, z1 = 24, H = 6, T = 0.5;
      wall(s * x0, s * z0, s * -36, s * z0, H, T, M.shed);        // north wall, door at -36..-32
      wall(s * -32, s * z0, s * x1, s * z0, H, T, M.shed);
      wall(s * x0, s * z1, s * -42, s * z1, H, T, M.shed);        // south wall, door at -42..-38
      wall(s * -38, s * z1, s * x1, s * z1, H, T, M.shed);
      wall(s * x1, s * z0, s * x1, s * 13, H, T, M.shed);         // east wall, door at z 13..17
      wall(s * x1, s * 17, s * x1, s * z1, H, T, M.shed);
      wall(s * x0, s * z0, s * x0, s * 10, H, T, M.shed);         // west wall, door at z 10..13.5
      wall(s * x0, s * 13.5, s * x0, s * z1, H, T, M.shed);
      for (const [lx, lz, alongX] of [[-34, z0, true], [-40, z1, true], [x1, 15, false], [x0, 11.75, false]]) {
        const w = alongX ? 4.2 : T, d = alongX ? T : 4.2;
        addSolid(w, 1.8, d, s * lx, H - 0.9, s * lz, M.shed, { block: false, uvScale: 1 / 3 });
      }
      roof(s * (x0 - 0.25), s * (z0 - 0.25), s * (x1 + 0.25), s * (z1 + 0.25), H);
      // Racking: tall shelving that splits the floor into aisles.
      addSolid(1.1, 3.0, 8.0, s * -38, 1.5, s * 15, M.metal, { uvScale: 1 / 2 });
      addSolid(1.1, 3.0, 6.0, s * -28, 1.5, s * 11.5, M.metal, { uvScale: 1 / 2 });
      crate(s * -24.5, s * 20.5, 1.6, 1.0);
      crate(s * -33, s * 20.0, 1.4, 1.0);
      crate(s * -42.5, s * 16.5, 1.6, 1.0);
      addLightEmitter({ x: s * -39, y: H - 0.7, z: s * 11, color: 0xffd9a8, intensity: 110, distance: 20, priority: 0 });
      addLightEmitter({ x: s * -27, y: H - 0.7, z: s * 18, color: 0xffd9a8, intensity: 110, distance: 20, priority: 0 });
    });

    /* ---- the lot between the warehouse and the spawn shed ---- */
    both((s) => {
      container(s * -27, s * 31.5, true, true);
      container(s * -40.5, s * 33, true);
      barrier(s * -21, s * 29.5, false);
      crate(s * -33.5, s * 28.0);
    });
  }

  /** Mirrored spawn candidates, listed in pairs. */
  const PORT_SPAWNS = [
    [0, 31], [0, -31], [-7, 33], [7, -33], [7, 33], [-7, -33],
    [-4, 35.5], [4, -35.5], [4, 35.5], [-4, -35.5],
    [-33, 30], [33, -30], [30, 30], [-30, -30],
    [-40, 17], [40, -17], [40, 7], [-40, -7],
  ];

  function buildPortMap() {
    buildPort();
    buildSpawnPoints(PORT_SPAWNS, [[0, 31], [0, -31], [7, 33], [-7, -33]], PORT_CEIL - 0.5);
    // Ammo in the lanes, health and shield out on the flanks.
    spawnAmmoChests([
      [0, 14.5], [0, -14.5], [17.5, 0], [-17.5, 0],
      [26, 20], [-26, -20], [-30, 16], [30, -16],
    ], 8);
    spawnConsumables([
      ['health', 40, 1], ['health', -40, -1],
      ['shield', -33, 13], ['shield', 33, -13],
      ['health', 0, 0], ['shield', 17, 25], ['shield', -17, -25],
    ], 8);
  }

  return { buildPortMap };
}
