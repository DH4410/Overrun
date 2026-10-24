/**
 * Build-time only: draws the gun-skin pattern tiles that `npm run bake:textures` saves as JPGs in
 * assets/textures/guns/. The game itself never imports this file, so no drawing code ships and the
 * patterns cost one small image load each instead of a canvas pass on every device.
 */

const N = 256;
const TAU = Math.PI * 2;

/** A small seeded random number generator (mulberry32): a pattern always draws the same. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gray = (v, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

function surface() {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  return { c, g: c.getContext('2d') };
}

/** Run `fn` at the nine neighbouring offsets, so whatever crosses an edge comes back in on the other side: the tile repeats seamlessly. */
function wrap(g, fn) {
  for (const dx of [-N, 0, N]) {
    for (const dy of [-N, 0, N]) {
      g.save();
      g.translate(dx, dy);
      fn();
      g.restore();
    }
  }
}

/** A blob: a few overlapping ellipses, which reads as an irregular patch of paint. Planned once so every wrapped copy is identical. */
function planBlob(rnd, x, y, r) {
  const n = 5 + Math.floor(rnd() * 4);
  return Array.from({ length: n }, () => [
    x + (rnd() - 0.5) * r * 1.3, y + (rnd() - 0.5) * r * 0.9, r * (0.35 + rnd() * 0.45), r * (0.25 + rnd() * 0.35), rnd() * Math.PI,
  ]);
}

function paintBlob(g, plan, fill) {
  g.fillStyle = fill;
  for (const [x, y, rx, ry, rot] of plan) {
    g.beginPath();
    g.ellipse(x, y, rx, ry, rot, 0, TAU);
    g.fill();
  }
}

function camo(palette, seed) {
  return () => {
    const { c, g } = surface();
    const rnd = seeded(seed);
    g.fillStyle = palette[0];
    g.fillRect(0, 0, N, N);
    for (let layer = 1; layer < palette.length; layer++) {
      const count = 16 - layer * 2;
      for (let i = 0; i < count; i++) {
        const plan = planBlob(rnd, rnd() * N, rnd() * N, 26 + rnd() * 30);
        wrap(g, () => paintBlob(g, plan, palette[layer]));
      }
    }
    return c;
  };
}

function pixels(fn) {
  const { c, g } = surface();
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const [r, gr, b] = fn(x / N, y / N);
      const i = (y * N + x) * 4;
      img.data[i] = r; img.data[i + 1] = gr; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

const clamp = (v) => Math.max(0, Math.min(255, v));

const DRAW = {
  /** Twill carbon-fibre weave: two directions of glossy tows over and under each other. */
  carbon() {
    const { c, g } = surface();
    const cell = 16;
    g.fillStyle = gray(18);
    g.fillRect(0, 0, N, N);
    for (let j = 0; j < N / cell; j++) {
      for (let i = 0; i < N / cell; i++) {
        const horizontal = (((i + j) >> 1) & 1) === 0;
        const x = i * cell, y = j * cell;
        const grad = horizontal ? g.createLinearGradient(0, y, 0, y + cell) : g.createLinearGradient(x, 0, x + cell, 0);
        grad.addColorStop(0, gray(40));
        grad.addColorStop(0.5, gray(horizontal ? 215 : 170));
        grad.addColorStop(1, gray(40));
        g.fillStyle = grad;
        g.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        g.fillStyle = gray(0, 0.18);
        for (let k = 2; k < cell; k += 3) {
          if (horizontal) g.fillRect(x, y + k, cell, 1); else g.fillRect(x + k, y, 1, cell);
        }
      }
    }
    return c;
  },

  /** Brushed metal: long fine streaks along the barrel. */
  brushed() {
    const { c, g } = surface();
    const rnd = seeded(11);
    g.fillStyle = gray(168);
    g.fillRect(0, 0, N, N);
    for (let i = 0; i < 2600; i++) {
      const y = rnd() * N, x = rnd() * N, len = 20 + rnd() * 120;
      const v = rnd() < 0.5 ? 255 : 60;
      g.fillStyle = gray(v, 0.05 + rnd() * 0.09);
      wrap(g, () => g.fillRect(x, y, len, 1));
    }
    return c;
  },

  /** Fine speckle, like a cerakote or a granite finish. */
  speckle() {
    const { c, g } = surface();
    const rnd = seeded(23);
    g.fillStyle = gray(176);
    g.fillRect(0, 0, N, N);
    for (let i = 0; i < 2400; i++) {
      const x = rnd() * N, y = rnd() * N, r = 0.6 + rnd() * 1.6;
      g.fillStyle = gray(rnd() < 0.5 ? 70 + rnd() * 50 : 215 + rnd() * 40, 0.55);
      wrap(g, () => { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); });
    }
    return c;
  },

  camo_wood: camo(['#5c5a38', '#7c7648', '#3d4a28', '#2a3120'], 31),
  camo_desert: camo(['#cdb98d', '#b39765', '#97794c', '#d8cba5'], 37),
  camo_urban: camo(['#8b8f93', '#686c71', '#44484d', '#b3b6b9'], 41),

  /** Weathered, rusted steel: orange and brown blotches, streaked downward. */
  rust() {
    const { c, g } = surface();
    const rnd = seeded(53);
    g.fillStyle = '#7a4a2c';
    g.fillRect(0, 0, N, N);
    for (const [col, count, base] of [['#b4642a', 22, 24], ['#4e2d1c', 20, 18], ['#c98a4a', 12, 12]]) {
      for (let i = 0; i < count; i++) {
        const plan = planBlob(rnd, rnd() * N, rnd() * N, base + rnd() * 16);
        wrap(g, () => paintBlob(g, plan, col));
      }
    }
    for (let i = 0; i < 90; i++) {
      const x = rnd() * N, y = rnd() * N, len = 12 + rnd() * 50;
      g.fillStyle = `rgba(40,18,8,${0.08 + rnd() * 0.12})`;
      wrap(g, () => g.fillRect(x, y, 1.5, len));
    }
    return c;
  },

  /** Overlapping scales, each lit from above. */
  scales() {
    const { c, g } = surface();
    const w = 32, h = 16;
    g.fillStyle = gray(30);
    g.fillRect(0, 0, N, N);
    for (let row = -1; row <= N / h + 1; row++) {
      for (let col = -1; col <= N / w + 1; col++) {
        const cx = col * w + (row & 1 ? w / 2 : 0) + w / 2, cy = row * h + h;
        const grad = g.createRadialGradient(cx, cy - 6, 2, cx, cy, w * 0.62);
        grad.addColorStop(0, gray(235));
        grad.addColorStop(0.6, gray(150));
        grad.addColorStop(1, gray(50));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(cx, cy, w * 0.5, 0, TAU);
        g.fill();
        g.strokeStyle = gray(25, 0.8);
        g.lineWidth = 1.2;
        g.stroke();
      }
    }
    return c;
  },

  /** Pebbled leather grip. */
  leather() {
    const { c, g } = surface();
    const rnd = seeded(61);
    g.fillStyle = gray(105);
    g.fillRect(0, 0, N, N);
    for (let i = 0; i < 1100; i++) {
      const x = rnd() * N, y = rnd() * N, r = 3.5 + rnd() * 3.5;
      wrap(g, () => {
        const grad = g.createRadialGradient(x - 1, y - 1, 0.5, x, y, r);
        grad.addColorStop(0, gray(225));
        grad.addColorStop(1, gray(140, 0.8));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      });
    }
    return c;
  },

  /** Black rock cracked open on glowing lava. */
  magma() {
    const { c, g } = surface();
    const rnd = seeded(71);
    g.fillStyle = '#1b0e0a';
    g.fillRect(0, 0, N, N);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * N, y = rnd() * N, r = 6 + rnd() * 16;
      g.fillStyle = `rgba(0,0,0,${0.2 + rnd() * 0.3})`;
      wrap(g, () => { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); });
    }
    for (let k = 0; k < 14; k++) {
      let x = rnd() * N, y = rnd() * N, a = rnd() * TAU;
      const pts = [[x, y]];
      for (let s = 0; s < 10; s++) {
        a += (rnd() - 0.5) * 1.5;
        x += Math.cos(a) * (12 + rnd() * 16);
        y += Math.sin(a) * (12 + rnd() * 16);
        pts.push([x, y]);
      }
      for (const [w, col] of [[7, 'rgba(255,90,20,0.35)'], [3.4, '#ff7a1f'], [1.4, '#ffd36a']]) {
        g.strokeStyle = col;
        g.lineWidth = w;
        g.lineJoin = g.lineCap = 'round';
        wrap(g, () => { g.beginPath(); g.moveTo(...pts[0]); for (const p of pts) g.lineTo(...p); g.stroke(); });
      }
    }
    return c;
  },

  /** Pale stone with grey veins. */
  marble() {
    const { c, g } = surface();
    const rnd = seeded(83);
    g.fillStyle = gray(232);
    g.fillRect(0, 0, N, N);
    for (let i = 0; i < 26; i++) {
      const x = rnd() * N, y = rnd() * N, r = 30 + rnd() * 60;
      g.fillStyle = gray(rnd() < 0.5 ? 200 : 250, 0.18);
      wrap(g, () => { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); });
    }
    g.lineJoin = g.lineCap = 'round';
    for (let k = 0; k < 7; k++) {
      let x = rnd() * N, y = rnd() * N, a = rnd() * TAU;
      const pts = [[x, y]];
      for (let s = 0; s < 14; s++) {
        a += (rnd() - 0.5) * 1.1;
        x += Math.cos(a) * (10 + rnd() * 14);
        y += Math.sin(a) * (10 + rnd() * 14);
        pts.push([x, y]);
      }
      for (const [w, a2] of [[5, 0.12], [2, 0.45], [0.8, 0.8]]) {
        g.strokeStyle = gray(95, a2);
        g.lineWidth = w;
        wrap(g, () => { g.beginPath(); g.moveTo(...pts[0]); for (const p of pts) g.lineTo(...p); g.stroke(); });
      }
    }
    return c;
  },

  /** Honeycomb mesh. */
  hex() {
    const { c, g } = surface();
    const w = 32, hv = 17.07, rowH = 25.6;
    g.fillStyle = gray(24);
    g.fillRect(0, 0, N, N);
    for (let row = -1; row <= 10; row++) {
      for (let col = -1; col <= 8; col++) {
        const cx = col * w + (row & 1 ? w / 2 : 0), cy = row * rowH;
        g.beginPath();
        const P = [[0, -hv], [w / 2, -hv / 2], [w / 2, hv / 2], [0, hv], [-w / 2, hv / 2], [-w / 2, -hv / 2]];
        P.forEach(([px, py], i) => (i ? g.lineTo(cx + px * 0.86, cy + py * 0.86) : g.moveTo(cx + px * 0.86, cy + py * 0.86)));
        g.closePath();
        const grad = g.createLinearGradient(cx - w / 2, cy - hv, cx + w / 2, cy + hv);
        grad.addColorStop(0, gray(232));
        grad.addColorStop(1, gray(120));
        g.fillStyle = grad;
        g.fill();
      }
    }
    return c;
  },

  /** Circuit-board traces and pads. */
  circuit() {
    const { c, g } = surface();
    const rnd = seeded(97);
    const step = 16;
    g.fillStyle = gray(34);
    g.fillRect(0, 0, N, N);
    g.lineJoin = g.lineCap = 'round';
    for (let k = 0; k < 46; k++) {
      let x = Math.floor(rnd() * (N / step)) * step, y = Math.floor(rnd() * (N / step)) * step;
      const pts = [[x, y]];
      let dir = Math.floor(rnd() * 4);
      for (let s = 0; s < 3 + Math.floor(rnd() * 5); s++) {
        if (rnd() < 0.5) dir = (dir + (rnd() < 0.5 ? 1 : 3)) % 4;
        const len = step * (1 + Math.floor(rnd() * 3));
        x += [len, 0, -len, 0][dir];
        y += [0, len, 0, -len][dir];
        pts.push([x, y]);
      }
      const [lx, ly] = pts[pts.length - 1];
      wrap(g, () => {
        g.strokeStyle = gray(220);
        g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(...pts[0]); for (const p of pts) g.lineTo(...p); g.stroke();
        g.fillStyle = gray(245);
        g.beginPath(); g.arc(lx, ly, 3.6, 0, TAU); g.fill();
        g.fillStyle = gray(34);
        g.beginPath(); g.arc(lx, ly, 1.4, 0, TAU); g.fill();
      });
    }
    return c;
  },

  /** Diagonal warning stripes (light and dark; the skin's colour tints the light ones). */
  hazard() {
    const { c, g } = surface();
    const period = 64;
    g.fillStyle = gray(236);
    g.fillRect(0, 0, N, N);
    g.fillStyle = gray(34);
    for (let k = -N; k < N * 2; k += period) {
      g.beginPath();
      g.moveTo(k, 0); g.lineTo(k + period / 2, 0); g.lineTo(k + period / 2 - N, N); g.lineTo(k - N, N);
      g.closePath();
      g.fill();
    }
    return c;
  },

  /** Cut-crystal shards: each facet its own brightness, dark along the seams. */
  facets() {
    const rnd = seeded(113);
    const seeds = Array.from({ length: 34 }, () => [rnd(), rnd(), 0.62 + rnd() * 0.38]);
    return pixels((u, v) => {
      let d1 = 9, d2 = 9, shade = 1;
      for (const [sx, sy, sh] of seeds) {
        const dx = Math.min(Math.abs(u - sx), 1 - Math.abs(u - sx)), dy = Math.min(Math.abs(v - sy), 1 - Math.abs(v - sy));
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; shade = sh; } else if (d < d2) d2 = d;
      }
      const edge = Math.min(1, (Math.sqrt(d2) - Math.sqrt(d1)) * 38);
      const k = clamp(shade * 255 * (0.45 + 0.55 * edge));
      return [k, k, k];
    });
  },

  /** Folded-steel waves. */
  damascus() {
    return pixels((u, v) => {
      const w = Math.sin(TAU * (4 * v + 0.22 * Math.sin(TAU * 2 * u) + 0.1 * Math.sin(TAU * 5 * u + 1.3) + 0.08 * Math.sin(TAU * (u + v))));
      const grain = Math.sin(TAU * (23 * v + 0.6 * Math.sin(TAU * 4 * u))) * 7;
      const k = clamp(172 + 48 * Math.tanh(w * 1.1) + grain);
      return [k, k, k];
    });
  },

  /** Slow, warped ribbons, for the light-show skins. */
  swirl() {
    return pixels((u, v) => {
      const a = Math.sin(TAU * (2 * u + 0.5 * Math.sin(TAU * 2 * v) + 0.3 * Math.sin(TAU * 3 * (u + v))));
      const b = Math.sin(TAU * (3 * v + 0.4 * Math.sin(TAU * 2 * u + 1) + 0.25 * Math.sin(TAU * 4 * (u - v))));
      const k = clamp(130 + 70 * a + 55 * b);
      return [k, k, k];
    });
  },
};

export { DRAW, N };
