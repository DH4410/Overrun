import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * A key-value store kept in one JSON file, for the local Node server and for trying accounts out.
 * Everything is held in memory; each write schedules one atomic save (temp file, then rename), so
 * a crash leaves either the old file or the new one, never half of one.
 */
export function fileStore(path) {
  let data = {};
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ }
  let timer = null;
  const save = () => {
    timer = null;
    try { writeFileSync(`${path}.tmp`, JSON.stringify(data)); renameSync(`${path}.tmp`, path); } catch (e) { console.error('accounts: could not save', e.message); }
  };
  const later = () => { if (!timer) { timer = setTimeout(save, 200); timer.unref?.(); } };
  return {
    async get(key) { return key in data ? structuredClone(data[key]) : undefined; },
    async put(key, value) { data[key] = structuredClone(value); later(); },
    async delete(key) { delete data[key]; later(); },
    /** Write now (on shutdown and in tests). */
    flush() { if (timer) { clearTimeout(timer); save(); } },
  };
}

export function memoryStore() {
  const data = new Map();
  return {
    async get(key) { return data.has(key) ? structuredClone(data.get(key)) : undefined; },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
  };
}
