import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

import { CONFIG } from '../../src/config.js';
import { MAP_DATA, MAP_IDS } from '../../src/sim/mapData.js';
import {
  BTN, INPUT_HZ, PROTOCOL_VERSION, TICK_HZ, encodeInput, mapHash, quantPitch, quantYaw, readSnapshot,
} from '../../src/sim/protocol.js';
import { WEAPONS } from '../../src/sim/weaponData.js';

/** A scripted headless player for the swarm and unit tests: raw protocol, no browser. */

export const HASH = mapHash(
  Object.fromEntries(MAP_IDS.map((id) => [id, JSON.parse(readFileSync(new URL(`../../assets/maps/${id}.json`, import.meta.url), 'utf8'))])),
  MAP_DATA, { CONFIG, WEAPONS },
);

export class WsBot {
  constructor(url, { name = 'BOT', spectate = false, hash = HASH, character = 'soldier', loadout } = {}) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.snaps = 0; this.snap = null; this.welcome = null; this.json = []; this.closed = null;
    this.seq = 0; this.sent = 0; this.rtt = 0; this.ticks = 0; this.t0 = null;
    this.lagMs = 0;
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, hash, name, character, loadout, spectate })));
      this.ws.on('error', reject);
      this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; resolve(this); });
      this.ws.on('message', (data, isBinary) => {
        const handle = () => {
          if (!isBinary) {
            const m = JSON.parse(data.toString());
            this.json.push(m);
            if (m.t === 'welcome') { this.welcome = m; resolve(this); }
            if (m.t === 'error') resolve(this);
            return;
          }
          const s = readSnapshot(data);
          this.snaps++;
          this.snap = s;
          this.bytes = data.byteLength;
          if (s.you && s.echoClientTime) {
            this.rtt = ((Date.now() & 0xffff) - s.echoClientTime - s.echoAge + 0x10000) & 0xffff;
          }
          this.onSnap?.(s);
        };
        if (this.lagMs) setTimeout(handle, this.lagMs / 2); else handle();
      });
    });
  }

  /**
   * Send one command for every tick owed since the last send (like a real client, which makes
   * one per fixed tick), or exactly `n`.
   */
  input({ ix = 0, iz = 0, yaw = 0, pitch = 0, buttons = 0, weapon = 1, emote = 0 } = {}, n = null, viewTick = this.snap?.tick ?? 0) {
    if (n === null) {
      this.t0 ??= Date.now() - 1000 / INPUT_HZ;
      n = Math.max(1, Math.min(16, Math.floor((Date.now() - this.t0) * TICK_HZ / 1000) - this.ticks));
    }
    this.ticks += n;
    const cmds = [];
    for (let i = 0; i < n; i++) cmds.push({ ix, iz, yawQ: quantYaw(yaw), pitchQ: quantPitch(pitch), buttons, weapon, emote });
    const buf = encodeInput(cmds, this.seq + 1, Date.now() & 0xffff, this.rtt, 100, viewTick);
    this.seq += n;
    this.sent++;
    const go = () => { if (this.ws.readyState === 1) this.ws.send(buf); };
    if (this.lagMs) setTimeout(go, this.lagMs / 2); else go();
  }

  raw(buf) { this.ws.send(buf); this.sent++; }
  sendJson(m) { this.ws.send(JSON.stringify(m)); this.sent++; }
  close() { this.ws.close(); }
}

export { BTN };
