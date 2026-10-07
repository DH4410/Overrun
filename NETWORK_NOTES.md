# Network notes (client-side lag work)

Written quickly; the sources are search snippets and one article, not a deep read. Valve and Overwatch facts are secondary.

## What was found

- Transport is WebSocket, so TCP. Packet loss never arrives as a missing snapshot; it arrives as a stall (head-of-line blocking) followed by a burst. Sending inputs twice (redundancy) is pointless over TCP. The `?lag=&jitter=&loss=` simulator drops messages outright, which a real WebSocket never does, so it flatters or misrepresents real links.
- The server rewinds a shot by about `rtt + interpolation delay + ~30 ms of input queue`, and clamps it at `MAX_REWIND` (30 ticks, 250 ms, `server/room.js`). At 200 ms ping that is about 350-400 ms: already over budget, so at 200 ms moving targets are hit slightly behind where they were drawn. This is the main reason 200 ms feels bad, and no client change fixes it. The F3 line and the corner readout now say `LAG-COMP LIMIT` when this applies.
- Snapshots are 20 Hz (50 ms). Two intervals (100 ms) is the usual interpolation delay (Source's `cl_interp_ratio 2` default, which tolerates one lost packet; Valve developer wiki, via search snippet). Gabriel Gambetta's client-server series covers prediction, reconciliation, entity interpolation and lag compensation, which is what this game does.

## What changed

- `src/net/netQuality.js`: `InterpController` picks the interpolation delay from the measured p95 of snapshot lateness (floor 70 ms, ceiling 200 ms), adds one interval for 8 s after a missed snapshot, rises fast and falls slowly (slew-limited so puppets do not visibly speed up), and is capped so the delay alone does not eat the rewind budget. `qualityReadout` builds the `PING / JITTER / LOSS` corner text (good/warn/bad).
- `src/net/client.js` (small): uses the controller, shows the readout, sends FIRE and emote edges immediately (at most 50 packets/s, within the server's token bucket) instead of waiting for the 20 Hz flush, and preloads the emote clips on joining.
- Prediction is untouched (`mp-predict` still 0 divergences).

## Honest results (`node tests/mp/interp-bench.mjs`, offline replay, not a live match)

| link | old delay / rewind | new delay / rewind |
|---|---|---|
| LAN rtt 20 | 100 / 153 ms | 70 / 123 ms |
| cable rtt 60 | 100 / 197 ms | 74 / 172 ms |
| rtt 120, 1% loss, TCP | 120 / 283 ms | 108 / 270 ms |
| rtt 200, 3% drop-style loss | 100 / 350 ms, 0.8% starved | 146 / 396 ms, 0% starved |
| rtt 200, 3% TCP stalls | 143 / 393 ms | 146 / 396 ms (unchanged) |
| rtt 300, TCP stalls | 138 / 498 ms | 143 / 503 ms (unchanged) |

The win is on good and middling links (about 30 ms less delay, so less to rewind). On a real 200 ms link with stalls it changes almost nothing: the stalls and the rewind clamp are server and transport problems.

## Recommendations for the server (not done here)

1. Raise `MAX_REWIND` (and `QUEUE_MAX`) to about 48-60 ticks (400-500 ms), or at least log how often the clamp fires per rtt. This is the single change most likely to help 200 ms players.
2. Log rewind-clamp hits and the rtt histogram in `/stats`, and the Durable Object colo, to see if players are routed far away.
3. Long term: an unreliable transport (WebTransport or WebRTC data channels) removes head-of-line stalls; nothing at the WebSocket level can.
4. Optionally send snapshots at 30 Hz to far players; it lowers the needed delay at the cost of bandwidth.
