/**
 * Build-time only: draws the supply crate's side-panel texture (stencilled lettering, hazard marks,
 * scuffs, grime) and a matching bump map. `npm run bake:textures` saves them as JPGs in
 * assets/textures/crate/. The game only loads the files.
 */

const W = 1024, H = 512;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function base(g, r, light) {
  g.fillStyle = light ? '#808080' : '#3b4757';
  g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * (light ? 22 : 16);
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** Pressed panel seams: a frame, a cross brace and a pair of recessed fields. */
function seams(g, light) {
  g.lineWidth = 6;
  g.strokeStyle = light ? '#202020' : '#1a212b';
  g.strokeRect(14, 14, W - 28, H - 28);
  g.lineWidth = 3;
  g.strokeRect(34, 34, W - 68, H - 68);
  g.strokeStyle = light ? '#e0e0e0' : '#5a6a80';
  g.lineWidth = 2;
  g.strokeRect(20, 20, W - 40, H - 40);
  g.strokeStyle = light ? '#303030' : '#202833';
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(W / 2, 40); g.lineTo(W / 2, H - 40); g.stroke();
}

function marks(g) {
  // Hazard band
  g.save();
  g.beginPath(); g.rect(60, H - 120, W - 120, 56); g.clip();
  g.fillStyle = '#e9b21a'; g.fillRect(60, H - 120, W - 120, 56);
  g.fillStyle = '#16181c';
  for (let x = -80; x < W; x += 56) { g.beginPath(); g.moveTo(x, H - 64); g.lineTo(x + 28, H - 64); g.lineTo(x + 28 + 56, H - 120); g.lineTo(x + 56, H - 120); g.fill(); }
  g.restore();
  // Stencil lettering
  g.fillStyle = '#e8ecf2';
  g.font = '800 120px "Arial Narrow", Impact, sans-serif';
  g.textBaseline = 'alphabetic';
  g.fillText('SUPPLY', 76, 190);
  g.font = '700 54px Impact, sans-serif';
  g.fillStyle = '#e9b21a';
  g.fillText('DROP · CLASS A', 80, 262);
  g.fillStyle = '#c3cad6';
  g.font = '600 26px monospace';
  g.fillText('OVR-0427  /  LOT 118  /  HANDLE WITH CARE', 80, 318);
  // Warning triangle
  g.save();
  g.translate(W - 190, 90);
  g.fillStyle = '#e9b21a';
  g.beginPath(); g.moveTo(0, 0); g.lineTo(120, 0); g.lineTo(60, 104); g.closePath(); g.fill();
  g.fillStyle = '#16181c';
  g.fillRect(55, 20, 10, 48); g.fillRect(55, 76, 10, 10);
  g.restore();
  // Arrows and barcode
  g.fillStyle = '#e8ecf2';
  for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(W - 340 + i * 40, 250); g.lineTo(W - 310 + i * 40, 280); g.lineTo(W - 340 + i * 40, 310); g.lineTo(W - 330 + i * 40, 310); g.lineTo(W - 300 + i * 40, 280); g.lineTo(W - 330 + i * 40, 250); g.fill(); }
  const r = rng(11);
  for (let x = W - 260; x < W - 90; x += 4 + r() * 6) g.fillRect(x, 340, 2 + r() * 4, 50);
}

function wear(g, r, light) {
  // Scratches
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = light ? `rgba(255,255,255,${0.2 + r() * 0.4})` : `rgba(210,220,235,${0.08 + r() * 0.16})`;
    g.lineWidth = 1 + r() * 1.6;
    const x = r() * W, y = r() * H, a = (r() - 0.5) * 0.9;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * (20 + r() * 90), y + Math.sin(a) * (20 + r() * 90)); g.stroke();
  }
  // Grime streaks running down from the seams
  for (let i = 0; i < 26; i++) {
    const x = r() * W;
    const grad = g.createLinearGradient(0, 30, 0, 30 + 120 + r() * 200);
    grad.addColorStop(0, light ? 'rgba(0,0,0,.25)' : 'rgba(10,8,6,.30)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x, 30, 3 + r() * 9, 360);
  }
  // Rust-edged chips
  for (let i = 0; i < 40; i++) {
    g.fillStyle = light ? 'rgba(20,20,20,.5)' : `rgba(${140 + r() * 40},${70 + r() * 30},30,${0.25 + r() * 0.3})`;
    g.beginPath(); g.ellipse(r() * W, r() * H, 2 + r() * 8, 1 + r() * 4, r() * 3, 0, 7); g.fill();
  }
}

function make(light) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const r = rng(light ? 5 : 3);
  base(g, r, light);
  seams(g, light);
  if (!light) marks(g);
  wear(g, r, light);
  return c;
}

/** The narrow end faces: a big warning mark, the class letter and a hazard band, on a 4:3 tile. */
function makeEnd(light) {
  const EW = 640, EH = 480;
  const c = document.createElement('canvas');
  c.width = EW; c.height = EH;
  const g = c.getContext('2d');
  const r = rng(light ? 9 : 7);
  g.fillStyle = light ? '#808080' : '#3b4757';
  g.fillRect(0, 0, EW, EH);
  const img = g.getImageData(0, 0, EW, EH);
  for (let i = 0; i < img.data.length; i += 4) { const n = (r() - 0.5) * (light ? 22 : 16); img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  g.lineWidth = 6; g.strokeStyle = light ? '#202020' : '#1a212b'; g.strokeRect(12, 12, EW - 24, EH - 24);
  g.lineWidth = 3; g.strokeRect(30, 30, EW - 60, EH - 60);
  g.lineWidth = 2; g.strokeStyle = light ? '#e0e0e0' : '#5a6a80'; g.strokeRect(18, 18, EW - 36, EH - 36);
  if (!light) {
    g.fillStyle = '#e9b21a';
    g.beginPath(); g.moveTo(EW / 2, 70); g.lineTo(EW / 2 + 130, 300); g.lineTo(EW / 2 - 130, 300); g.closePath(); g.fill();
    g.fillStyle = '#16181c';
    g.fillRect(EW / 2 - 9, 140, 18, 90); g.fillRect(EW / 2 - 9, 246, 18, 18);
    g.fillStyle = '#e8ecf2'; g.font = '800 64px Impact, sans-serif'; g.textAlign = 'center';
    g.fillText('CLASS A', EW / 2, 372);
    g.save(); g.beginPath(); g.rect(60, EH - 84, EW - 120, 36); g.clip();
    g.fillStyle = '#e9b21a'; g.fillRect(60, EH - 84, EW - 120, 36);
    g.fillStyle = '#16181c';
    for (let x = -40; x < EW; x += 40) { g.beginPath(); g.moveTo(x, EH - 48); g.lineTo(x + 20, EH - 48); g.lineTo(x + 60, EH - 84); g.lineTo(x + 40, EH - 84); g.fill(); }
    g.restore();
  }
  for (let i = 0; i < 50; i++) {
    g.strokeStyle = light ? `rgba(255,255,255,${0.2 + r() * 0.4})` : `rgba(210,220,235,${0.08 + r() * 0.16})`;
    g.lineWidth = 1 + r() * 1.5;
    const x = r() * EW, y = r() * EH, a = (r() - 0.5) * 0.9;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * (20 + r() * 80), y + Math.sin(a) * (20 + r() * 80)); g.stroke();
  }
  return c;
}

export const CRATE_TEXTURES = { panel: () => make(false), bump: () => make(true), end: () => makeEnd(false), endbump: () => makeEnd(true) };
