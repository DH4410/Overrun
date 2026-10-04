import { DurableObject } from 'cloudflare:workers';

import desert from '../assets/maps/desert.json';
import port from '../assets/maps/port.json';
import snow from '../assets/maps/snow.json';
import { Governor } from './governor.js';
import { Room } from './room.js';

/**
 * Cloudflare deployment: the Worker serves the game's static files (wrangler.jsonc, "assets")
 * and hands /ws and /stats to one Durable Object, GameRoom "main", which runs the same Room as
 * server/node.js. The room ticks on setInterval while anyone is connected and stops when it
 * empties; the budget counter lives in the object's storage.
 *
 * Inside a Worker the clock only moves between I/O events, so the room's own ms/tick figure
 * reads ~0 here; measure cost with server/node.js and tests/mp/swarm.mjs.
 */

const COLLIDERS = { port, desert, snow };

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.timer = null;
    ctx.blockConcurrencyWhile(async () => {
      const saved = (await ctx.storage.get('budget')) ?? null;
      const limit = Number(env.DAILY_MESSAGES) || undefined;
      this.governor = new Governor({ limit, saved, save: (s) => ctx.storage.put('budget', s) });
      this.room = new Room({ colliders: COLLIDERS, governor: this.governor, log: (m) => console.log(m) });
    });
  }

  async fetch(req) {
    if (new URL(req.url).pathname === '/stats') {
      return new Response(JSON.stringify(this.room.report(), null, 1), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const { 0: client, 1: ws } = new WebSocketPair();
    ws.accept();
    const conn = { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) };
    this.room.open(conn);
    this.wake();
    ws.addEventListener('message', (e) => this.room.message(conn, e.data));
    const gone = () => {
      this.room.close(conn);
      try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  wake() {
    if (this.timer) return;
    this.room.last = Date.now();
    this.room.acc = 0;
    this.timer = setInterval(() => {
      const n = this.room.update();
      this.room.recordCost(0, n);
      if (this.room.empty) { clearInterval(this.timer); this.timer = null; this.governor.flush(); }
    }, 4);
  }
}

export default {
  fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === '/ws' || pathname === '/stats') return env.ROOM.getByName('main').fetch(req);
    return env.ASSETS.fetch(req);
  },
};
