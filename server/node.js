import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

import { MAP_IDS } from '../src/sim/mapData.js';
import { Governor } from './governor.js';
import { Room } from './room.js';

/**
 * Local multiplayer server: the game's static files, the room on /ws and its numbers on /stats,
 * all on one port. `node server/node.js [port]` (default 8790, or $PORT).
 *
 * The budget counter persists to .mp-budget.json next to this file; MP_BUDGET_LIMIT overrides
 * the daily limit (tests use it to walk the governor's tiers) and MP_BUDGET_FILE the file.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.hdr': 'application/octet-stream',
};
/** Never served: the server, the tests, the tooling. */
const PRIVATE = /^(server|tests|node_modules|scripts|spike|\.git|\.claude|\.wrangler)(\/|$)|^\.mp-budget/;

export function startServer({ port = 8790, host = '127.0.0.1', limit, budgetFile = join(ROOT, 'server', '.mp-budget.json'), log = console.log } = {}) {
  const colliders = Object.fromEntries(MAP_IDS.map((id) => [id, JSON.parse(readFileSync(join(ROOT, 'assets', 'maps', `${id}.json`), 'utf8'))]));
  let saved = null;
  try { saved = JSON.parse(readFileSync(budgetFile, 'utf8')); } catch { /* first run */ }
  const governor = new Governor({ limit, saved, save: (s) => writeFile(budgetFile, JSON.stringify(s)).catch(() => {}) });
  const room = new Room({ colliders, governor, log });

  let timer = null;
  const loop = () => {
    const t0 = performance.now();
    const n = room.update();
    room.recordCost(performance.now() - t0, n);
    if (room.empty) { clearInterval(timer); timer = null; governor.flush(); }
  };
  const wake = () => {
    if (timer) return;
    room.last = Date.now();
    room.acc = 0;
    timer = setInterval(loop, 4);
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(room.report(), null, 1));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    rel = normalize(rel).split(sep).join('/');
    const file = resolve(ROOT, rel);
    if (!file.startsWith(ROOT + sep) || rel.startsWith('..') || PRIVATE.test(rel)) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404); res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  http.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) };
      room.open(conn);
      wake();
      ws.on('message', (data, isBinary) => {
        if (isBinary) room.message(conn, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        else room.message(conn, data.toString());
      });
      ws.on('close', () => room.close(conn));
      ws.on('error', () => room.close(conn));
    });
  });

  return new Promise((done) => {
    http.listen(port, host, () => {
      log(`OVERRUN multiplayer on http://${host}:${port}  (stats: /stats)`);
      done({
        room, http, port,
        stop: () => new Promise((r) => {
          clearInterval(timer); timer = null;
          for (const c of wss.clients) c.terminate();
          wss.close();
          http.close(() => r());
          http.closeAllConnections?.();
        }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8790);
  const limit = process.env.MP_BUDGET_LIMIT ? Number(process.env.MP_BUDGET_LIMIT) : undefined;
  const budgetFile = process.env.MP_BUDGET_FILE || undefined;
  startServer({ port, host: process.env.HOST || '127.0.0.1', limit, budgetFile });
}
