import * as THREE from 'three';

/**
 * The glyph atlas for sign text on the Blender maps. The map script lays a word out as one quad
 * per character (scripts/blender/markkit.py, type_label) with UVs into this sheet, so a station's
 * worth of signs costs a few thousand faces where pixel rectangles cost tens of thousands, and the
 * letters are smooth where they are near and fade out where they are too small to read.
 *
 * TYPE_CHARS and the 8 x 8 grid are the same contract as the Python side's.
 */
export const TYPE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-!.:/><+';
const COLS = 8;
const ROWS = 8;
const CELL = 64;

let atlas = null;

/** One shared white-on-clear texture; the colour of each letter is the vertex colour. */
export function typeAtlas() {
  if (atlas || typeof document === 'undefined') return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL;
  canvas.height = ROWS * CELL;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = '900 78px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  for (let i = 0; i < TYPE_CHARS.length; i++) {
    const ch = TYPE_CHARS[i];
    const x = (i % COLS) * CELL + CELL / 2;
    const y = Math.floor(i / COLS) * CELL + 60;     // baseline; capitals reach up to about row + 4
    // Squeeze wide letters into the cell and leave narrow ones alone, so every character fits
    // the advance the layout gives it.
    const w = g.measureText(ch).width;
    const sx = Math.min(0.78, (CELL - 14) / Math.max(w, 1));
    g.save();
    g.translate(x, y);
    g.scale(sx, 1);
    g.fillText(ch, 0, 0);
    g.restore();
  }
  atlas = new THREE.CanvasTexture(canvas);
  atlas.flipY = false;                  // the GLB's V counts from the top of the sheet
  atlas.anisotropy = 4;
  atlas.needsUpdate = true;
  return atlas;
}
