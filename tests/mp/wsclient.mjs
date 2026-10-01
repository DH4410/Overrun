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
  MAP_DATA, CONFIG, WEAPONS,
);

export class WsBot {
  /**
   * `lagMs` is the round trip added on top of the real one, `jitterMs` a random extra per
   * message each way. Delivery stays in order, as on a real WebSocket.
   */
  constructor(url, { name = 'BOT', spectate = false, hash = HASH, character = 'soldier', loadout, lagMs = 0, jitterMs = 0 } = {}) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.snaps = 0; this.snap = null; this.welcome = null; this.json = []; this.closed = null;
    this.seq = 0; this.sent = 0; this.rtt = 0; this.ticks = 0; this.t0 = null;
    this.lagMs = lagMs; this.jitterMs = jitterMs;
    this.lanes = { in: 0, out: 0 };
    this.bytesIn = 0;
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
        this.bytesIn += data.byteLength ?? data.length;
        this.delay('in', handle);
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
    this.raw(buf);
  }

  /** Send these commands as one packet, the first numbered `firstSeq`. */
  sendCmds(cmds, firstSeq, viewTick, interpMs = 100) {
    this.raw(encodeInput(cmds, firstSeq, Date.now() & 0xffff, this.rtt, interpMs, viewTick));
  }

  /** Run `fn` after this lane's simulated delay, never before the lane's previous message. */
  delay(lane, fn) {
    if (!this.lagMs && !this.jitterMs) { fn(); return; }
    const at = Math.max(this.lanes[lane], Date.now() + this.lagMs / 2 + Math.random() * this.jitterMs);
    this.lanes[lane] = at;
    setTimeout(fn, at - Date.now());
  }

  raw(buf) { this.sent++; this.delay('out', () => { if (this.ws.readyState === 1) this.ws.send(buf); }); }
  sendJson(m) { this.raw(JSON.stringify(m)); }
  close() { this.ws.close(); }
}

export { BTN };
