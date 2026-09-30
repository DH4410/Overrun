import { TEAM } from './config.js';

/**
 * The minimap: a round, rotating radar drawn on a 2D canvas. Forward is always up, the compass
 * ring turns around you, a cone shows where you are looking, and blips follow the spotting rule
 * (allies always, enemies only once spotted, see updateSpotting).
 *
 * It used to be a second WebGL render of the whole scene from above every frame. The plan is
 * now drawn once per map from `blockers` into an offscreen canvas, and each frame is a single
 * rotated drawImage plus a handful of dots.
 */
const PPM = 4;              // plan resolution, pixels per metre
const CSS_SIZE = 180;       // matches #mapframe

export function createMinimap({ canvas, blockers, player, bots, getPlan, getScale }) {
  const ctx = canvas.getContext('2d');
  let plan = null, planExtent = 0, view = 46, planKey = null;

  /** Draw the floor plan: the ground, a 10 m grid, and every solid footprint. */
  function rebuild() {
    const p = getPlan();
    planKey = p;
    planExtent = p.extent;
    view = p.view;
    const size = Math.ceil(planExtent * 2 * PPM);
    plan = document.createElement('canvas');
    plan.width = plan.height = size;
    const g = plan.getContext('2d');
    const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
    g.fillStyle = hex(p.plates.ground);
    g.fillRect(0, 0, size, size);
    g.strokeStyle = 'rgba(255, 255, 255, .05)';
    g.lineWidth = 1;
    for (let m = 0; m <= planExtent * 2; m += 10) {
      g.beginPath(); g.moveTo(m * PPM, 0); g.lineTo(m * PPM, size); g.stroke();
      g.beginPath(); g.moveTo(0, m * PPM); g.lineTo(size, m * PPM); g.stroke();
    }
    g.fillStyle = hex(p.plates.solid);
    g.strokeStyle = 'rgba(0, 0, 0, .45)';
    for (const b of blockers) {
      const x = (b.x - b.hx + planExtent) * PPM, y = (b.z - b.hz + planExtent) * PPM;
      g.fillRect(x, y, b.hx * 2 * PPM, b.hz * 2 * PPM);
      g.strokeRect(x + 0.5, y + 0.5, b.hx * 2 * PPM - 1, b.hz * 2 * PPM - 1);
    }
  }

  function blip(x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = r * 0.45;
    ctx.strokeStyle = 'rgba(0, 0, 0, .7)';
    ctx.stroke();
  }

  function draw() {
    if (getPlan() !== planKey) rebuild();
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(CSS_SIZE * getScale() * dpr);
    if (canvas.width !== px) { canvas.width = canvas.height = px; }
    const S = px, c = S / 2, R = c - 2 * dpr;
    const s = S / view;                              // canvas pixels per metre
    const yaw = player.yaw;
    const ox = player.body.position.x, oz = player.body.position.z;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#0b0e12';
    ctx.fillRect(0, 0, S, S);

    // World layer, rotated so the way you face is up. Forward is (-sin yaw, -cos yaw) in xz;
    // with +x right and +z down on the canvas, a clockwise turn of `yaw` points it up.
    ctx.translate(c, c);
    ctx.rotate(yaw);
    ctx.drawImage(plan, (-planExtent - ox) * s, (-planExtent - oz) * s, planExtent * 2 * s, planExtent * 2 * s);

    const dot = Math.max(3, 3.2 * dpr * getScale());
    for (const b of bots) {
      if (!b.alive || !b.blip?.visible) continue;
      let x = (b.pos.x - ox) * s, y = (b.pos.z - oz) * s;
      const friendly = player.team !== TEAM.SOLO && b.team === player.team;
      const d = Math.hypot(x, y);
      if (d > R - dot) {
        if (!friendly) continue;                   // an enemy off the edge is not on your radar
        x *= (R - dot) / d; y *= (R - dot) / d;    // an ally is pinned to the rim
      }
      blip(x, y, dot, friendly ? '#58aefc' : '#ff5a4e');
    }
    ctx.restore();

    // Screen layer: your view cone, your arrow, the compass ring.
    ctx.save();
    ctx.translate(c, c);
    const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    cone.addColorStop(0, 'rgba(255, 255, 255, .22)');
    cone.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
    ctx.closePath();
    ctx.fill();

    const a = 7 * dpr * getScale();
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.2); ctx.lineTo(a * 0.85, a); ctx.lineTo(0, a * 0.45); ctx.lineTo(-a * 0.85, a);
    ctx.closePath();
    ctx.fillStyle = '#f3b53f';
    ctx.fill();
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = 'rgba(0, 0, 0, .8)';
    ctx.stroke();

    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = 'rgba(255, 255, 255, .28)';
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    // Ticks every 30 degrees, turning with the world.
    ctx.strokeStyle = 'rgba(255, 255, 255, .35)';
    for (let i = 0; i < 12; i++) {
      const t = yaw + (i * Math.PI) / 6;
      const sx = Math.sin(t), cy = -Math.cos(t);
      ctx.beginPath(); ctx.moveTo(sx * (R - 5 * dpr), cy * (R - 5 * dpr)); ctx.lineTo(sx * R, cy * R); ctx.stroke();
    }
    // North is world -z: (0, -1) turned clockwise by yaw lands at (sin yaw, -cos yaw).
    ctx.font = `800 ${Math.round(12 * dpr * getScale())}px 'Barlow Condensed', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const L = R - 13 * dpr * getScale();
    for (const [label, off] of [['N', 0], ['E', Math.PI / 2], ['S', Math.PI], ['W', -Math.PI / 2]]) {
      const t = yaw + off;
      ctx.fillStyle = label === 'N' ? '#f3b53f' : 'rgba(238, 241, 244, .8)';
      ctx.fillText(label, Math.sin(t) * L, -Math.cos(t) * L);
    }
    ctx.restore();
  }

  return { draw, rebuild };
}
