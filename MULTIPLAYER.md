# Multiplayer (Phase 1)

One global, server-authoritative room: up to 10 players plus about 16 spectators, Deathmatch or Team Deathmatch on PORT, DESERT or SNOW, with a 20 s vote between rounds. Single player is unchanged. The lobby's **MULTIPLAYER** button joins the room and **Spectate** watches it.

## Layout

| File | What it is |
|---|---|
| `server/room.js` | The room. It runs at 120 Hz and sends snapshots at 20 Hz. It covers modes, the vote, spawns, lag-compensated hits, grenades, smoke and pickups, plus the input queue, rate limits, seats and reconnect tokens. |
| `server/governor.js` | The daily budget: 2,000,000 incoming messages, which is 100,000 billed requests. |
| `server/node.js` | A local server on one port: the static files, `/ws` and `/stats`. |
| `server/worker.js`, `wrangler.jsonc` | Cloudflare: a Worker serves the assets, and the `GameRoom` Durable Object named "main" runs the same `Room`. |
| `scripts/build-public.mjs` | Copies the browser files into `.cf-public/` for wrangler. |
| `src/sim/*` | Shared by the client and the server: movement, combat, hit maths, map colliders, the protocol and the map hash. |
| `src/net/predict.js` | Client prediction and reconciliation. It runs the same `applyCommand` as the server. |
| `src/net/client.js` | The browser side: connecting, prediction, puppets for the other players, events, spectator cameras, the vote card and the F3 overlay. |

## Run it locally

```sh
node server/node.js 8790          # then open http://127.0.0.1:8790 in two or more windows
```

- Press **MULTIPLAYER** in each window, or **Spectate**. In spectate, V toggles the free camera and a click cycles which player you follow.
- **F3** shows the debug overlay: RTT, interpolation delay, input rate, budget, snapshot size, and prediction agreement and corrections.
- On localhost you can simulate a bad network with `?lag=120&jitter=30&loss=2` (lag and jitter in ms, loss in %).
- `http://127.0.0.1:8790/stats` returns the room's numbers.

To run the Worker locally instead: `npx wrangler dev --port 8787`, then open http://127.0.0.1:8787.

## Tests

```sh
npm run lint && npm test                          # includes the room, prediction and hash unit tests
CI=1 npm run test:e2e                             # includes tests/e2e/multiplayer.spec.mjs (its own server on :8798)
SWARM_SECONDS=120 npm run test:mp                 # 10 players + 6 spectators over lagged sockets
```

## Deploy (Cloudflare free plan)

```sh
npx wrangler login        # once, in your browser
npx wrangler deploy       # builds .cf-public, uploads it, creates the GameRoom class (migration v1)
```

- The first deploy may ask you to pick a `workers.dev` subdomain.
- The game is then at `https://overrun.<subdomain>.workers.dev`. Check `/stats` there.
- `npx wrangler tail` streams the room's log.

**Budget.**
- Incoming WebSocket messages are billed at 20 per request. Outgoing messages are free.
- An active player sends about 16 messages/s, which is about 2,900 requests an hour.
- A silent client sends one keepalive every 10 s, about 18 requests an hour. The keepalive refills the Durable Object's CPU allowance while the room ticks.
- At 60% of the daily allowance, input drops to 15/s. At 85% it drops to 10/s.
- At 95% the room warns everyone and closes after the round. At 100% it closes immediately.
- The counter resets at 00:00 UTC.

## Known limits

- **Remote shooting is cosmetic.** Pellets, tracers and recoil are drawn locally; the server decides every hit.
- **Puppets are approximate.** They show crouch or aim, but not both at once.
- **Timing.** Remote events are shown when they arrive, not at the interpolated time.
- **Grenades.** Gamepads cannot throw grenades online. There is no aim assist online. Grenades and smoke are not rewound for lag compensation.
- **Seats.** A dropped player's seat is held for 60 s and counts toward the 10.
- **Not yet built.** Server bots, Survival and Duel.
