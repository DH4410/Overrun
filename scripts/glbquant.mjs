/**
 * Shrinks a map GLB in place: NORMAL becomes normalized int8 (KHR_mesh_quantization, which
 * three's GLTFLoader reads) and COLOR_0 normalized uint16. Positions and UVs stay float32: the
 * game swaps each mesh's material by name and the UVs run past [0, 1].
 *
 *   node scripts/glbquant.mjs assets/maps/port.glb
 *
 * The Blender map scripts run it after every export (see roundkit_dh.py, rk_quantize). Running
 * it twice does nothing: it only touches float32 attributes.
 */
import fs from 'node:fs';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const bin = buf.subarray(20 + jsonLen + 8, 20 + jsonLen + 8 + buf.readUInt32LE(20 + jsonLen));

const FLOAT = 5126, BYTE = 5120, USHORT = 5123;
const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

const todo = new Map();   // accessor index -> 'NORMAL' | 'COLOR_0'
for (const mesh of json.meshes || []) {
  for (const p of mesh.primitives) {
    for (const name of ['NORMAL', 'COLOR_0']) {
      const ai = p.attributes[name];
      if (ai !== undefined && json.accessors[ai].componentType === FLOAT) todo.set(ai, name);
    }
  }
}
if (!todo.size) process.exit(0);

// The converted data of each accessor, with the stride of its new view.
const converted = new Map();
for (const [ai, name] of todo) {
  const a = json.accessors[ai];
  const bv = json.bufferViews[a.bufferView];
  const n = comps[a.type];
  const stride = bv.byteStride || n * 4;
  const src = (bv.byteOffset || 0) + (a.byteOffset || 0);
  if (name === 'NORMAL') {
    const out = Buffer.alloc(a.count * 4);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < 3; c++) {
        const v = Math.max(-1, Math.min(1, bin.readFloatLE(src + i * stride + c * 4)));
        out.writeInt8(Math.round(v * 127), i * 4 + c);
      }
    }
    a.componentType = BYTE;
    converted.set(ai, { data: out, stride: 4 });
  } else {
    const out = Buffer.alloc(a.count * 8);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < 4; c++) {
        const v = c < n ? Math.max(0, Math.min(1, bin.readFloatLE(src + i * stride + c * 4))) : 1;
        out.writeUInt16LE(Math.round(v * 65535), i * 8 + c * 2);
      }
    }
    a.componentType = USHORT;
    a.type = 'VEC4';
    converted.set(ai, { data: out, stride: 8 });
  }
  a.normalized = true;
  delete a.min;
  delete a.max;
  delete a.byteOffset;
}

// Keep every view something else still points at; the views the converted accessors read are
// dropped when nothing else does.
const used = new Set();
json.accessors.forEach((a, i) => { if (a.bufferView !== undefined && !converted.has(i)) used.add(a.bufferView); });
for (const im of json.images || []) if (im.bufferView !== undefined) used.add(im.bufferView);

const parts = [];
let at = 0;
const push = (data) => {
  const pad = (4 - (at % 4)) % 4;
  if (pad) { parts.push(Buffer.alloc(pad)); at += pad; }
  const start = at;
  parts.push(data);
  at += data.length;
  return start;
};
const views = [];
const remap = new Map();
json.bufferViews.forEach((bv, i) => {
  if (!used.has(i)) return;
  const off = bv.byteOffset || 0;
  remap.set(i, views.length);
  views.push({ ...bv, byteOffset: push(bin.subarray(off, off + bv.byteLength)) });
});
json.accessors.forEach((a, i) => {
  const c = converted.get(i);
  if (c) {
    a.bufferView = views.length;
    views.push({ buffer: 0, byteOffset: push(c.data), byteLength: c.data.length, byteStride: c.stride, target: 34962 });
  } else if (a.bufferView !== undefined) {
    a.bufferView = remap.get(a.bufferView);
  }
});
for (const im of json.images || []) if (im.bufferView !== undefined) im.bufferView = remap.get(im.bufferView);
json.bufferViews = views;
json.buffers = [{ byteLength: at }];
json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'KHR_mesh_quantization'])];
json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), 'KHR_mesh_quantization'])];

const pad4 = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
const binBuf = pad4(Buffer.concat(parts), 0);
const head = Buffer.alloc(12);
head.write('glTF', 0);
head.writeUInt32LE(2, 4);
head.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jh = Buffer.alloc(8);
jh.writeUInt32LE(jsonBuf.length, 0);
jh.write('JSON', 4);
const bh = Buffer.alloc(8);
bh.writeUInt32LE(binBuf.length, 0);
bh.write('BIN\0', 4);
fs.writeFileSync(file, Buffer.concat([head, jh, jsonBuf, bh, binBuf]));
