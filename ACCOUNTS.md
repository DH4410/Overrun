# Accounts and rewards

Sign up with a username (and optionally an email), sign in on any device, and keep your career
(XP, level, stats, what you wear) saved on the server. Levels and stats unlock operators, gun
finishes and titles.

## What is real, and what is not

- **Accounts are real server code**, with tests. Passwords are salted and hashed (PBKDF2-SHA256),
  sessions are random tokens in an `HttpOnly` cookie, and sign-in attempts are throttled.
- **Nothing is deployed from here.** Putting accounts online means deploying the Worker to your own
  Cloudflare account (`npx wrangler deploy`), which needs your login. Until then accounts work on the
  local server (`node server/node.js`) and are saved to `server/.accounts.json`.
- **Only the Cloudflare deploy could not be tried.** `wrangler deploy --dry-run` bundles it, and the
  same code runs against the local server in the tests, but I have not run the Durable Object live.
- **The career is a save file, not anti-cheat.** Single player is computed in the browser, so the
  server cannot know a match was played. It keeps a career from going backwards, refuses absurd
  numbers and refuses rewards the numbers have not earned. Someone who edits their own browser can
  still award themselves XP. Online play (the multiplayer room) is server-authoritative and does not
  pay career XP yet.

## Lost passwords: the recovery code

There is no email service, so there is no "email me a reset link". Instead sign-up shows a
**recovery code once** (`XXXXX-XXXXX-XXXXX-XXXXX`). It resets the password from the sign-in card
("Forgot password?") and issues a new code. The email, if given, is only another way to sign in.
Lose both the password and the code and the account cannot be recovered. That is the trade-off of
having no mail server; adding one (Cloudflare Email Service, or any SMTP relay) is the way to change it.

## Files

| File | What it is |
|---|---|
| `server/accounts.js` | The service: sign-up, sign-in, sessions, the saved career, password change, recovery, delete. Storage-agnostic. Also the `Throttle`. |
| `server/accounts-http.js` | The `/api/*` routes on web-standard `Request`/`Response`: cookie handling, JSON-only, same-site checks, throttling. |
| `server/accounts-file.js` | A JSON-file store (local server) and a memory store (tests). |
| `server/accounts-do.js` | The Cloudflare Durable Object `AccountsDO` that keeps every account. |
| `src/account.js` | The browser side: the chip in the top bar, the sign-in card, saving the career when it changes. |
| `src/rewards.js` | The unlock table (operators, finishes, titles). Shared by the browser and the server. |
| `src/career.js` | The career screen. |
| `src/shop.js` | Credits and the gun price list. Shared by the browser and the server's checks. |
| `server/friends.js` | Friends, requests, presence and invites (see "Friends" below). |
| `src/friends.js` | The friends drawer in the lobby. |

## The API

| Call | Body | Result |
|---|---|---|
| `POST /api/register` | `{ username, email?, password }` | account, career, recovery code; sets the cookie |
| `POST /api/login` | `{ login, password }` (login is a username or email) | account, career; sets the cookie |
| `POST /api/logout` | | clears the cookie |
| `GET /api/me` | | account and career, or `{ "user": null }` when signed out (always a 200, so it never shows up as a console error) |
| `PUT /api/profile` | `{ profile, rev }` | the saved career. 409 if `rev` is stale (another device saved first) |
| `POST /api/password` | `{ current, password }` | signs every other device out |
| `POST /api/recover` | `{ login, recoveryCode, password }` | signs in, issues a new recovery code |
| `DELETE /api/account` | `{ password }` | deletes the account |
| `GET /api/friends` | | friends (with presence), incoming and outgoing requests, invites |
| `POST /api/presence` | `{ status }` (`lobby`, `solo`, `online`) | checks in, answers like `GET /api/friends` |
| `POST /api/friends/request` `accept` `decline` `remove` `invite` `dismiss` | `{ name }` | the new friends panel |

Usernames are 3-12 letters, numbers, `-` or `_` (the callsign length), unique ignoring case.
Passwords are 8-128 characters.

## How the browser behaves

- No account server behind the page (the plain static test server, or a file): the chip reads
  `GUEST`, is greyed out, and the game is exactly the guest game.
- Signed out: the career lives in `localStorage` as before.
- Signing in merges: the career with more XP is kept, and no counter ever goes down, so a guest's
  matches are not lost to an empty account. Two devices that disagree merge the same way.
- Signed in: every saved career is sent to the server about 1.5 s later.

## Run and test

```sh
node server/node.js 8790                  # http://127.0.0.1:8790, accounts in server/.accounts.json
npm test                                  # server/accounts tests and the rewards table
CI=1 npx playwright test accounts         # the sign-up / sign-in / unlock flows on a real server
```

## Deploy

```sh
npx wrangler deploy
```

`wrangler.jsonc` already binds the `ACCOUNTS` Durable Object (migration `v2`) and routes `/api/*`
to it. Two things to check on a real deploy:

- **CPU time on the free plan.** Each sign-up and sign-in runs one or two PBKDF2 hashes at 100,000
  iterations, the most a Worker allows. The free plan's per-request CPU limit is small, so if
  sign-ins fail with a CPU error, lower `PBKDF2_ITERATIONS` in `wrangler.jsonc` or move to the paid
  plan. I could not measure this without deploying.
- **HTTPS.** The cookie is marked `Secure` automatically on HTTPS, which Cloudflare always serves.

## Rewards

`src/rewards.js` is one table:

| Kind | Unlocked by | Now |
|---|---|---|
| Operators | level | SWAT and TROOPER at 1, GAS MASK 3, CRYPTO 6, ELY 10, STEVE 14 |
| Gun finishes | level | STOCK 1, DESERT TAN 2, ARCTIC 5, CRIMSON 8, MIDNIGHT 12, GOLD 20 |
| Titles | stats | VETERAN, VICTOR, HEADHUNTER, UNSTOPPABLE, EXTERMINATOR, CHAMPION |

To add a reward, add a row there. The lobby picker, locker, career screen, podium ("UNLOCKED: ...")
and the server's check all read the same table. A finish only recolours the gun's `polymer`,
`alloy` and `steel` materials (see `applyGunSkin` in `src/gunmodels.js`); it needs no new art.

## Credits

Before this there was no currency: rewards were unlocked by level and stats only. Now matches pay
**credits** and the locker spends them.

- A match pays `round(XP earned x 0.5)` credits, plus a bonus on every level-up (`CREDITS` in `src/shop.js`).
- The first guns (pistol, AR, SMG, shotgun, sniper) are free. The revolver, machine pistol, auto
  shotgun, marksman rifle and LMG are bought in the locker (`GUN_PRICES`).
- A career keeps three numbers for this: `credits` (earned, only ever goes up), `spent` (only ever
  goes up) and `owned` (`gun:<id>` keys). Balance is `credits - spent`.
- The server checks the same three: credits cannot exceed what the XP and levels could have paid,
  spending cannot exceed earnings, and a bought item must be paid for. As above, that is a save
  file's sanity check, not anti-cheat: someone editing their own browser can still award themselves XP.
- Credits are not earned online yet (the multiplayer room does not report results to accounts).

## Friends

Sign in, press the two-people button beside your name in the lobby, and add a friend by username.

- Requests wait until accepted. If you ask someone who already asked you, you become friends at once.
- **Presence is a heartbeat, not a socket.** While the page is visible and you are signed in it checks
  in every 30 s (10 s with the drawer open). A friend is "online" if they checked in within 60 s. Status
  is `lobby`, `solo` or `online` (in the shared multiplayer room). The cost is about 2-6 requests a
  minute per open page, which is what the free Cloudflare plan counts, so watch that if many people play.
- **An invite is a nudge.** It lands as a banner (and a badge) the next time the invitee's page checks in,
  up to 30 s later, and expires after 10 minutes. Accepting it, or pressing the play arrow on a friend who
  is in the room, opens the ONLINE tab and joins.
- **There are no private parties or rooms yet.** The multiplayer server runs exactly one shared room, so
  "join a friend" means "join the room they are in". A real party (a private room per code, or group
  matchmaking) needs more than one Durable Object room and a decision on cost; it was not built.
- Not tried live: like the rest of the accounts server, it runs against the local server in the tests
  (unit and a two-browser e2e) but has not been deployed to Cloudflare.
