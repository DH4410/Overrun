# Multiplayer

One global, server-authoritative room: up to 10 players plus about 16 spectators, Deathmatch, Team Deathmatch, 1v1 Duel or Capture the Flag on PORT, DESERT or SNOW, played from a lobby (see below). Single player is unchanged. The lobby's **MULTIPLAYER** button joins the room and **Spectate** watches it.

## Layout

| File | What it is |
|---|---|
| `server/room.js` | The room. It runs at 120 Hz and sends snapshots at 20 Hz. It covers the lobby, modes, spawns, lag-compensated hits, grenades, smoke and pickups, plus the input queue, rate limits, seats and reconnect tokens. |
| `server/governor.js` | The daily budget: 2,000,000 incoming messages, which is 100,000 billed requests. |
| `server/node.js` | A local server on one port: the static files, `/ws` and `/stats`. |
| `server/worker.js`, `wrangler.jsonc` | Cloudflare: a Worker serves the assets, and the `GameRoom` Durable Object named "main" runs the same `Room`. |
| `scripts/build-public.mjs` | Copies the browser files into `.cf-public/` for wrangler. |
| `src/sim/*` | Shared by the client and the server: movement, combat, hit maths, map colliders, the protocol and the map hash. |
| `src/net/predict.js` | Client prediction and reconciliation. It runs the same `applyCommand` as the server. |
| `src/net/client.js` | The browser side: connecting, prediction, puppets for the other players, events, spectator cameras, the killcam and the F3 overlay. |
| `src/net/lobby.js` | The lobby panels (match settings, ready / start bar) and the match history kept in `localStorage`. |
| `src/net/stage.js` | The lobby stage: every player in a line-up in their own character, with name plates, built far above the map in the same scene. It stays up through the countdown. |
| `src/net/flags.js`, `server/ctf.js` | Capture the flag: the server's flag state, and the client's flag meshes and chips. |
| `src/loading.js` | The loading screen used by single player and by joining, so a match never starts with the world visible and moving. |
| `src/net/chat.js` | The chat log and box. |
| `src/sim/modes.js` | Mode info and the settings whitelist, shared by the client and the server. |

## The lobby

- A room starts in the **lobby**. The first player in is the **host**: they pick mode, map, kill limit, time and a weapon rule (own loadout, or one gun for everyone) and start the match. Everyone else presses **READY**. It starts only with 2 or more players and every guest ready, then a 5 s countdown.
- **Nobody walks in the lobby or the countdown.** The server zeroes movement in those two phases and the client sends idle commands, so prediction agrees.
- **Loading.** Joining shows the loading screen until the server has welcomed you and the lobby (or the first snapshot) is there. The map is drawn from a few angles first so textures and shaders are on the GPU. If the host changes the map in the lobby, everyone gets a short loading screen while it builds.
- The server checks every setting against a fixed list, so a forged message cannot pick anything else. If the host leaves, the next player is host.
- After a match: the results screen (kills, deaths, headshots, K/D, damage; also saved to a short match history), 15 s, then back to the lobby.
- **Latecomers** join a round in progress, unless it has under 10 s left. Then they watch and join at the next lobby.
- **Chat**: Enter (Shift+Enter for team chat in team modes). Lines are capped at 120 characters, rate limited on their own bucket, and a line costs about 1/20 of a billed request.
- **Killcam**: after being killed by a player you watch the last ~2 s from the killer's eyes. It is replayed from snapshots the client already has, so it costs the server nothing.
- **Spectating**: Q/E or the arrow keys switch player, V is a free camera, K follows whoever killed the followed player.
- **Network overlay**: F3 cycles off, PING/LOSS, and the full debug text. It shows by itself when ping is over 150 ms or loss is 3% or more. A reconnect shows a card with the retry timer.
- Tests that need a match at once start the room with `autostart` (`MP_AUTOSTART=1` for `server/node.js`).

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
- **Duel** is one life per round, 75 s, first to 3, 5 or 7 rounds; if the opponent leaves you win. **CTF** needs your own flag at home to capture, a dropped flag returns after 20 s, and the carrier is drawn with the flag on their back.
- **Not yet built.** Server bots and Survival (the lobby lists only the modes that run).
