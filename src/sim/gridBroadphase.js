import * as CANNON from 'cannon-es';

/**
 * A broadphase for a level that never moves.
 *
 * cannon's default sweep-and-prune keeps every body, static ones included, in one sorted list and
 * re-sorts and re-walks it on every step, and its AABB query (what every raycast starts with) tests
 * every body. With a map of some 850 boxes (Warzone) that was ~6 ms per frame in the browser and
 * made every bot line-of-sight ray a scan of the whole level, for nothing: the level is static and
 * only a handful of things ever move through it.
 *
 * Here the static bodies are binned once into a flat grid on x/z. A step then only asks, for each
 * moving body, which static cells its box touches. Anything too large to bin sensibly (floors,
 * ceilings, long walls) goes in a short list that is tested against every mover. The pairs handed
 * to the narrowphase are the same set the sweep would have produced.
 */

const CELL = 4;          // metres; about the size of the player and of most cover
const BIG_SPAN = 14;     // a static box covering more cells than this on either axis is "big"
const OFFSET = 2048;     // keeps cell indices positive in the packed key
const key = (cx, cz) => (cx + OFFSET) * 4096 + (cz + OFFSET);

export class GridBroadphase extends CANNON.Broadphase {
  constructor(world) {
    super();
    this.world = world;
    this.cells = new Map();
    this.big = [];
    this.movers = [];
    this.stamp = 0;
    this.rebuilt = true;
    this._onChange = (e) => { if (e.body.type === CANNON.Body.STATIC) this.rebuilt = true; };
    world.addEventListener('addBody', this._onChange);
    world.addEventListener('removeBody', this._onChange);
  }

  setWorld(world) {
    this.world?.removeEventListener('addBody', this._onChange);
    this.world?.removeEventListener('removeBody', this._onChange);
    this.world = world;
    world.addEventListener('addBody', this._onChange);
    world.addEventListener('removeBody', this._onChange);
    this.rebuilt = true;
  }

  rebuild(bodies) {
    this.cells.clear();
    this.big.length = 0;
    for (const b of bodies) {
      if (b.type !== CANNON.Body.STATIC) continue;
      if (b.aabbNeedsUpdate) b.updateAABB();
      const { lowerBound: lo, upperBound: hi } = b.aabb;
      const x0 = Math.floor(lo.x / CELL), x1 = Math.floor(hi.x / CELL);
      const z0 = Math.floor(lo.z / CELL), z1 = Math.floor(hi.z / CELL);
      if (x1 - x0 > BIG_SPAN || z1 - z0 > BIG_SPAN) { this.big.push(b); continue; }
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          const list = this.cells.get(k);
          if (list) list.push(b); else this.cells.set(k, [b]);
        }
      }
    }
    this.rebuilt = false;
  }

  /** Calls `visit` once for every static body whose box overlaps `aabb`. */
  eachStatic(aabb, visit) {
    const stamp = ++this.stamp;
    const { lowerBound: lo, upperBound: hi } = aabb;
    const touch = (s) => {
      if (s.stamp === stamp) return;
      s.stamp = stamp;
      if (s.aabb.overlaps(aabb)) visit(s);
    };
    for (const s of this.big) touch(s);
    const x1 = Math.floor(hi.x / CELL), z1 = Math.floor(hi.z / CELL);
    for (let cx = Math.floor(lo.x / CELL); cx <= x1; cx++) {
      for (let cz = Math.floor(lo.z / CELL); cz <= z1; cz++) {
        const list = this.cells.get(key(cx, cz));
        if (list) for (const s of list) touch(s);
      }
    }
  }

  collisionPairs(world, p1, p2) {
    const bodies = world.bodies;
    if (this.rebuilt) this.rebuild(bodies);
    const movers = this.movers;
    movers.length = 0;
    for (const b of bodies) {
      if (b.type === CANNON.Body.STATIC) continue;
      if (b.aabbNeedsUpdate) b.updateAABB();
      movers.push(b);
    }
    for (let i = 0; i < movers.length; i++) {
      const a = movers[i];
      this.eachStatic(a.aabb, (s) => {
        if (this.needBroadphaseCollision(a, s)) { p1.push(a); p2.push(s); }
      });
      for (let j = i + 1; j < movers.length; j++) {
        const b = movers[j];
        if (this.needBroadphaseCollision(a, b) && a.aabb.overlaps(b.aabb)) { p1.push(a); p2.push(b); }
      }
    }
  }

  aabbQuery(world, aabb, result = []) {
    if (this.rebuilt) this.rebuild(world.bodies);
    this.eachStatic(aabb, (s) => result.push(s));
    for (const b of world.bodies) {
      if (b.type === CANNON.Body.STATIC) continue;
      if (b.aabbNeedsUpdate) b.updateAABB();
      if (b.aabb.overlaps(aabb)) result.push(b);
    }
    return result;
  }
}

/**
 * cannon keeps "who touched whom" in a triangular matrix of every body pair and zeroes the whole
 * thing on every step (to raise `collide` on first contact). At ~900 bodies that was 400,000
 * writes per step, 3 ms of every step, to remember a handful of contacts. Same interface, but only
 * the pairs actually touching are stored.
 */
export class SparseCollisionMatrix {
  constructor() { this.pairs = new Set(); }
  key(bi, bj) {
    let i = bi.index, j = bj.index;
    if (j > i) { const t = j; j = i; i = t; }
    return i * 65536 + j;
  }
  get(bi, bj) { return this.pairs.has(this.key(bi, bj)) ? 1 : 0; }
  set(bi, bj, value) { if (value) this.pairs.add(this.key(bi, bj)); else this.pairs.delete(this.key(bi, bj)); }
  reset() { this.pairs.clear(); }
  setNumObjects() { /* nothing to size */ }
}
