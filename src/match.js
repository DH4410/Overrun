import { BOT_NAMES, DIFFICULTY } from './bots.js';
import {
  CONFIG,
  SPAWN_INVULN,
  TEAM,
  TEAM_COLOR,
} from './config.js';

export const MODE_LABEL = { dm: 'DEATHMATCH', tdm: 'TEAM DEATHMATCH', sv: 'SURVIVAL', duel: '1V1 DUEL' };
export const APP_STATE = Object.freeze({ MENU: 0, PLAYING: 1, PAUSED: 2, SETTINGS: 3 });

export function createMatchState() {
  return {
    mode: 'dm',
    diff: DIFFICULTY.medium,
    running: false,
    time: 0,
    timeLeft: CONFIG.MATCH_SECONDS,
    scoreA: 0,
    scoreB: 0,
    kills: 0,
    wave: 1,
    waveBreak: 0,
    // Duel only. roundsA is the player's, roundsB the bot's; roundReset counts down the
    // interval between rounds and is <= 0 whenever a round is actually being played.
    roundsA: 0,
    roundsB: 0,
    roundTime: 0,
    roundReset: 0,
  };
}

/** Match setup, bots, respawns, scoring, win conditions, and mode progression. */
export function createMatchRuntime({
  match,
  player,
  bots,
  Bot,
  combatants,
  allyMarks,
  pickSpawn,
  spawnPoints,
  switchMap,
  getCurrentMapId,
  setAppState,
  resetPlayerAmmo,
  syncPlayerPoints,
  resetStance,
  clearEffects,
  resetAmmoChests,
  resetConsumables,
  playerBlip,
  warmUpShaders,
  Audio,
  requestLock,
  showBoard,
  showPause,
  showToast,
  updateAmmoHud,
  updateVitals,
  addKillFeed,
  refreshBoard,
  clearAlertsOn,
  stopFiring,
  isPointerLocked,
  elements: el,
}) {
let nameSeed = 0;
function nextBotName() { return BOT_NAMES[(nameSeed++) % BOT_NAMES.length]; }

function addBot(team, weaponId = null) {
  const b = new Bot(nextBotName(), team, match.diff, weaponId);
  const sp = pickSpawn(team);
  b.body.position.set(sp.x, sp.y + 0.5, sp.z);
  b.updateTransforms();
  bots.push(b);
  combatants.push(b);
  return b;
}

function clearBots() {
  for (const [, m] of allyMarks) m.root.remove();
  allyMarks.clear();
  for (const b of bots) {
    b.dispose();
    const i = combatants.indexOf(b);
    if (i >= 0) combatants.splice(i, 1);
  }
  bots.length = 0;
}

function startMatch(mode, diffKey, name, mapId = getCurrentMapId()) {
  // Rebuilding the level has to happen before any bot is spawned or the player is placed:
  // both read spawnPoints, and switchMap() empties it.
  switchMap(mapId);

  match.mode = mode;
  // The duel is the elite bot's mode — the menu difficulty does not apply to it. Note that
  // a tier also carries `bots`, the DM headcount, so elite must specify bots: 1.
  match.diff = mode === 'duel' ? DIFFICULTY.elite : DIFFICULTY[diffKey];
  match.running = true;
  setAppState(APP_STATE.PLAYING);
  match.time = 0;
  match.timeLeft = CONFIG.MATCH_SECONDS;
  match.scoreA = 0; match.scoreB = 0;
  match.kills = 0; match.wave = 1; match.waveBreak = 0;
  match.roundsA = 0; match.roundsB = 0;
  match.roundTime = CONFIG.DUEL_ROUND_SECONDS; match.roundReset = 0;
  nameSeed = 0;

  player.name = (name || 'PLAYER').toUpperCase().slice(0, 12);
  player.kills = 0; player.deaths = 0;
  player.team = mode === 'tdm' ? TEAM.BLUE : TEAM.SOLO;
  // A duel is a mirror match, so both sides start on the same gun rather than the player
  // opening on a pistol against whatever the bot happened to roll.
  match.loadout = mode === 'duel' ? CONFIG.DUEL_WEAPON : 'pistol';
  player.current = match.loadout;
  player.cooking = null;
  player.cooldown = 0; player.reloading = 0;
  player.recoilPitch = 0; player.recoilYaw = 0;
  resetPlayerAmmo();

  clearBots();
  clearEffects();
  resetAmmoChests();
  resetConsumables();
  el.feed.innerHTML = '';

  if (mode === 'tdm') {
    for (let i = 0; i < 2; i++) addBot(TEAM.BLUE);
    for (let i = 0; i < 3; i++) addBot(TEAM.RED);
  } else if (mode === 'dm') {
    for (let i = 0; i < match.diff.bots; i++) addBot(TEAM.SOLO);
  } else if (mode === 'duel') {
    addBot(TEAM.RED, CONFIG.DUEL_WEAPON);
  } else {
    for (let i = 0; i < 4; i++) addBot(TEAM.RED);
  }

  const playerBlipColor = TEAM_COLOR[player.team];
  playerBlip.traverse((o) => { if (o.material) o.material.color.setHex(playerBlipColor); });

  if (mode === 'duel') startDuelRound(); else respawnPlayer(true);
  el.vname.textContent = player.name;
  el.tbMode.textContent = MODE_LABEL[mode];
  el.menu.classList.add('hidden');
  el.hud.classList.remove('hidden');
  updateAmmoHud();
  updateVitals();

  // Bots and their cloned materials only exist now, so compile once more before play starts.
  warmUpShaders();

  Audio.init();
  Audio.startAmbient();
  requestLock();
}

function endMatch(title, sub) {
  match.running = false;
  setAppState(APP_STATE.MENU);
  showBoard(false);
  showPause(false);
  document.exitPointerLock?.();
  el.hud.classList.add('hidden');
  el.menu.classList.remove('hidden');
  el.menuResult.textContent = `${title} — ${sub}`;
  el.menuResult.appendChild(standingsTable());
  clearEffects();
}

/**
 * The final standings, shown on the menu under the result line.
 *
 * A match used to end by dropping you on the menu with one line of text, so there was no way to
 * see how it went. The live scoreboard cannot be reused here because it sits inside #hud, which
 * is hidden the moment the match ends. Built with DOM calls so names are never parsed as HTML.
 */
function standingsTable() {
  const rows = [player, ...bots].sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
  const table = document.createElement('table');
  for (const c of rows) {
    const tr = document.createElement('tr');
    if (c === player) tr.className = 'self';
    const cells = [c.name, c.kills, c.deaths];
    cells.forEach((value, i) => {
      const td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = String(value);
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }
  return table;
}

function respawnPlayer(immediate = false, at = null) {
  const sp = at ?? pickSpawn(player.team);
  player.body.position.set(sp.x, sp.y + 0.6, sp.z);
  player.body.velocity.set(0, 0, 0);
  player.body.wakeUp();
  resetStance();                       // dying crouched must not respawn you crouched
  // Eye and chest follow the body only when the player steps, so until then they still said
  // where you died: a grenade thrown on the first frame of a life left from your corpse.
  syncPlayerPoints();
  player.alive = true;
  player.health = CONFIG.MAX_HEALTH;
  player.armor = CONFIG.START_ARMOR;
  player.respawnTimer = 0;
  player.invulnTimer = SPAWN_INVULN;   // bots ignore you while this runs
  clearAlertsOn(player);               // and drop any lock they already had
  player.cooking = null;
  player.cookSource = null;
  player.reloading = 0;
  player.cooldown = 0.4;
  resetPlayerAmmo();                  // includes the one-smoke-per-life reset
  player.current = match.loadout ?? 'pistol';
  player.pitch = 0;
  // Face the middle of the arena, never the wall you happened to spawn against. Forward is
  // (-sin yaw, -cos yaw), so aiming it at the origin from (x, z) gives yaw = atan2(x, z).
  player.yaw = Math.atan2(sp.x, sp.z);
  if (!immediate) showPause(false);
  updateAmmoHud();
  updateVitals();
}

/* ----------------------------- 1v1 duel ----------------------------- */

/**
 * Place both duellists for a fresh round.
 *
 * pickSpawn() maximises distance from live enemies, which is right for a respawn mid-fight
 * but not for a duel: it is evaluated per combatant, so whoever is placed second reacts to
 * the first and the two sides get measurably unequal openings. A duel has to be a mirror,
 * so this picks the single farthest-apart PAIR of spawn points up front and coin-flips who
 * gets which end. Both then face the middle, as respawnPlayer() already does.
 */
function startDuelRound() {
  const pts = spawnPoints;
  let a = pts[0], b = pts[pts.length - 1], bestD = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = pts[i].distanceToSquared(pts[j]);
      if (d > bestD) { bestD = d; a = pts[i]; b = pts[j]; }
    }
  }
  if (Math.random() < 0.5) { const t = a; a = b; b = t; }

  // Nothing in flight carries across a round boundary.
  clearEffects();

  respawnPlayer(true, a);

  /**
   * Strip the player's spawn protection, and match the two sides' armour.
   *
   * respawnPlayer grants SPAWN_INVULN, which is right everywhere else and badly wrong here:
   * Bot.canSee returns false against an invulnerable target, so the elite bot would spend
   * the first three seconds of every round blind and unable to deal damage while the player
   * crossed most of the map onto its flank. The player also spawns with START_ARMOR and a
   * bot with none, which is another 50 effective health of advantage.
   *
   * A duel is decided by aim and timing or it is not a duel, so both of those go.
   */
  player.invulnTimer = 0;
  const bot = bots[0];
  if (bot) {
    bot.respawn(b);
    bot.invulnTimer = 0;
    bot.respawnTimer = 0;
    bot.armor = player.armor;
  }
  match.roundTime = CONFIG.DUEL_ROUND_SECONDS;
  match.roundReset = 0;
}

/** End a duel round. `winner` is 'player', 'bot', or null for a timed-out draw. */
function endDuelRound(winner) {
  if (match.roundReset > 0) return;          // already resetting; ignore a second death
  if (winner === 'player') match.roundsA++;
  else if (winner === 'bot') match.roundsB++;
  match.roundReset = CONFIG.DUEL_RESET_DELAY;
  const label = winner === 'player' ? 'ROUND WON' : winner === 'bot' ? 'ROUND LOST' : 'ROUND DRAW';
  showToast(`${label}  ${match.roundsA} – ${match.roundsB}`);
  checkWinConditions();
}

/** The single place a death is booked, for the player and for bots alike. */
function killCombatant(target, source, headshot) {
  if (source && source !== target) {
    source.kills++;
    if (match.mode === 'tdm') {
      // Teamkills do not award score — FF is now blocked in explode() but bullet damage
      // has no team filter, so this guard stays as the authoritative scoring check.
      const teamkill = source.team !== TEAM.SOLO && source.team === target.team;
      if (!teamkill) {
        if (source.team === TEAM.BLUE) match.scoreA++;
        else if (source.team === TEAM.RED) match.scoreB++;
      }
    } else if (match.mode === 'dm') {
      if (source === player) match.scoreA++;
      // scoreB is Red's score in TDM; don't write it here — dmLeader() reads kills directly.
    } else if (match.mode === 'duel') {
      // Rounds are scored in endDuelRound() below, off the death rather than off the kill,
      // so that a duellist who falls out of the map still loses the round.
    } else if (source === player) {
      match.kills++;
    }
  }
  target.deaths++;
  addKillFeed(source, target, headshot);

  if (target === player) {
    player.alive = false;
    player.respawnTimer = CONFIG.PLAYER_RESPAWN;
    if (player.cooking) player.cooking = null;
    stopFiring();
  } else {
    target.die();
    target.respawnTimer = CONFIG.RESPAWN_DELAY;
  }
  refreshBoard();
  // One life each: a duel death ends the round rather than starting a respawn timer.
  if (match.mode === 'duel') { endDuelRound(target === player ? 'bot' : 'player'); return; }
  checkWinConditions();
}

/** Single source of truth for the DM leader so HUD, win-check and time-limit agree. */
function dmLeader() {
  return bots.reduce((a, b) => (b.kills > a.kills ? b : a), bots[0] || player);
}

function checkWinConditions() {
  if (!match.running) return;
  if (match.mode === 'dm') {
    if (player.kills >= CONFIG.DM_TARGET) return endMatch('VICTORY', `${player.kills} kills`);
    for (const b of bots) {
      if (b.kills >= CONFIG.DM_TARGET) return endMatch('DEFEAT', `${b.name} reached ${CONFIG.DM_TARGET}`);
    }
  } else if (match.mode === 'tdm') {
    if (match.scoreA >= CONFIG.TDM_TARGET) return endMatch('BLUE TEAM WINS', `${match.scoreA} – ${match.scoreB}`);
    if (match.scoreB >= CONFIG.TDM_TARGET) return endMatch('RED TEAM WINS', `${match.scoreB} – ${match.scoreA}`);
  } else if (match.mode === 'duel') {
    const enemy = bots[0];
    if (match.roundsA >= CONFIG.DUEL_ROUNDS) {
      return endMatch('DUEL WON', `${match.roundsA} – ${match.roundsB} vs ${enemy ? enemy.name : 'ELITE'}`);
    }
    if (match.roundsB >= CONFIG.DUEL_ROUNDS) {
      return endMatch('DUEL LOST', `${match.roundsB} – ${match.roundsA} to ${enemy ? enemy.name : 'ELITE'}`);
    }
  }
}

function updateMatch(dt) {
  if (!match.running) return;
  match.time += dt;

  if (match.mode === 'duel') {
    if (match.roundReset > 0) {
      match.roundReset -= dt;
      if (match.roundReset <= 0 && match.running) startDuelRound();
    } else {
      match.roundTime -= dt;
      // A round nobody wins scores for nobody, so hiding out the clock gains you nothing.
      if (match.roundTime <= 0) { match.roundTime = 0; endDuelRound(null); }
    }
  } else if (match.mode === 'sv') {
    // Endless waves: 4 -> 6 -> 8 ... with a short breather between them.
    const anyAlive = bots.some((b) => b.alive);
    if (!anyAlive) {
      if (match.waveBreak <= 0) {
        match.waveBreak = 3.0;
        showToast(`WAVE ${match.wave} CLEARED`);
      } else {
        match.waveBreak -= dt;
        if (match.waveBreak <= 0) {
          match.wave++;
          clearBots();
          const n = 2 + match.wave * 2;
          for (let i = 0; i < n; i++) addBot(TEAM.RED);
          showToast(`WAVE ${match.wave} — ${n} HOSTILES`);
          match.waveBreak = 0;
        }
      }
    }
  } else {
    match.timeLeft -= dt;
    if (match.timeLeft <= 0) {
      match.timeLeft = 0;
      if (match.mode === 'dm') {
        const top = dmLeader();
        if (player.kills > top.kills) endMatch('TIME — VICTORY', `${player.kills} kills`);
        else if (player.kills < top.kills) endMatch('TIME — DEFEAT', `${top.kills} kills`);
        else endMatch('TIME — DRAW', `Tied at ${player.kills} kills`);
      } else {
        if (match.scoreA > match.scoreB) endMatch('TIME — BLUE WINS', `${match.scoreA} – ${match.scoreB}`);
        else if (match.scoreB > match.scoreA) endMatch('TIME — RED WINS', `${match.scoreB} – ${match.scoreA}`);
        else endMatch('TIME — DRAW', `${match.scoreA} – ${match.scoreB}`);
      }
      return;
    }
  }

  // Respawns. In a duel both sides are placed by startDuelRound() instead, so the only
  // thing left here is the death overlay, counting down to the next round rather than to
  // a respawn.
  if (!player.alive) {
    player.respawnTimer -= dt;
    el.pause.classList.add('on');
    el.pBig.textContent = 'ELIMINATED';
    el.pSm.textContent = match.mode === 'duel'
      ? `ROUND ${match.roundsA + match.roundsB + 1} IN ${Math.max(0, match.roundReset).toFixed(1)}s`
      : `RESPAWNING IN ${player.respawnTimer.toFixed(1)}s`;
    // The death screen is not a pause — the resume prompt would just be confusing here.
    el.pCta.style.display = isPointerLocked() ? 'none' : '';
    if (player.respawnTimer <= 0 && match.mode !== 'duel') {
      respawnPlayer();
      el.pCta.style.display = '';
      if (isPointerLocked()) el.pause.classList.remove('on');
    }
  } else if (match.mode === 'duel' && el.pBig.textContent === 'ELIMINATED') {
    // startDuelRound() revived the player; clear the overlay it left behind.
    el.pCta.style.display = '';
    el.pBig.textContent = 'PAUSED';
    el.pSm.textContent = '';        // otherwise the round countdown lingers under PAUSED
    if (isPointerLocked()) el.pause.classList.remove('on');
  }
  for (const b of bots) {
    // Survival waves and duel rounds both place their own bots; neither auto-respawns.
    if (b.alive || match.mode === 'sv' || match.mode === 'duel') continue;
    if (b.respawnTimer <= 0) b.respawn(pickSpawn(b.team));
  }

  // Top bar.
  if (match.mode === 'duel') {
    el.tbA.textContent = match.roundsA;
    el.tbB.textContent = match.roundsB;
    el.tbTime.textContent = match.roundReset > 0
      ? `NEXT ${Math.ceil(match.roundReset)}`
      : formatTime(match.roundTime);
  } else if (match.mode === 'sv') {
    el.tbA.textContent = match.kills;
    el.tbB.textContent = `W${match.wave}`;
    el.tbTime.textContent = formatTime(match.time);
  } else if (match.mode === 'tdm') {
    el.tbA.textContent = match.scoreA;
    el.tbB.textContent = match.scoreB;
    el.tbTime.textContent = formatTime(match.timeLeft);
  } else {
    const top = bots.length ? dmLeader() : null;
    el.tbA.textContent = player.kills;
    el.tbB.textContent = top ? top.kills : 0;
    el.tbTime.textContent = formatTime(match.timeLeft);
  }
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

return {
  addBot,
  clearBots,
  startDuelRound,
  startMatch,
  endMatch,
  respawnPlayer,
  killCombatant,
  dmLeader,
  checkWinConditions,
  updateMatch,
  formatTime,
  pickSpawn,
};
}
