import { CONFIG } from '../config.js';
import { MAP_IDS } from './mapData.js';

/**
 * What the lobby can offer, shared by the server (which validates every setting the host sends)
 * and the browser (which draws the pickers). A mode is only offered once the room can run it.
 */
export const MODE_INFO = {
  dm: { label: 'DEATHMATCH', short: 'DM', teams: false, min: 2, max: 10, limits: [10, 20, 30], limit: CONFIG.DM_TARGET, unit: 'KILLS', blurb: 'Free for all. First to the kill limit.' },
  tdm: { label: 'TEAM DEATHMATCH', short: 'TDM', teams: true, min: 2, max: 10, limits: [15, 25, 40], limit: CONFIG.TDM_TARGET, unit: 'KILLS', blurb: 'Blue against red. The team kill count is what counts.' },
  duel: { label: '1V1 DUEL', short: 'DUEL', teams: false, teamScore: true, min: 2, max: 2, limits: [3, 5, 7], limit: 5, unit: 'ROUNDS', blurb: 'One life a round, same gun for both. First to the round limit.' },
  ctf: { label: 'CAPTURE THE FLAG', short: 'CTF', teams: true, min: 2, max: 10, limits: [3, 5, 7], limit: 3, unit: 'CAPTURES', blurb: 'Steal the other flag and carry it home while yours is safe.' },
  war: { label: 'WARZONE', short: 'WAR', teams: false, untimed: true, min: 2, max: 10, limits: [], limit: 0, unit: 'KILLS', blurb: 'A big map, free for all. No timer and no kill limit: it goes on until the host ends it.' },
  survival: { label: 'SURVIVAL', short: 'SURVIVAL', teams: true, coop: true, untimed: true, min: 1, max: 10, limits: [5, 10, 15], limit: 10, unit: 'WAVES', blurb: 'Everyone together against waves of hostile bots. More players, more bots. Back up to the wave limit.' },
};
/** Modes the room runs today; the lobby offers these and the server refuses the rest. */
export const PLAYABLE = ['dm', 'tdm', 'duel', 'ctf', 'war', 'survival'];

export const TIME_OPTIONS = [180, 300, 480, 600];
/** 'loadout' keeps what each player picked in the locker; a gun id gives everyone only that gun. */
export const WEAPON_RULES = ['loadout', 'pistol', 'ar', 'smg', 'shotgun', 'sniper'];

export const DEFAULT_SETTINGS = Object.freeze({ mode: 'dm', map: 'port', time: CONFIG.MATCH_SECONDS, limit: CONFIG.DM_TARGET, weapons: 'loadout' });

export const teamMode = (mode) => MODE_INFO[mode]?.teams === true;
/** Whether the top bar shows a blue-red score (the duel counts rounds that way, without friendly-fire rules). */
export const teamScore = (mode) => MODE_INFO[mode]?.teams === true || MODE_INFO[mode]?.teamScore === true;

/** The settings a map can host: a map with no `modes` list hosts every mode. */
export function mapHosts(mapData, mapId, mode) {
  const list = mapData[mapId]?.modes;
  return !list || list.includes(mode === 'survival' ? 'sv' : mode);
}

/**
 * Fold a host's request into the current settings. Anything unknown is ignored, so a hand-made
 * message can only ever pick from the lists above. Changing the mode resets the limit to that
 * mode's default unless the old limit is one of its options.
 */
export function cleanSettings(raw, cur = DEFAULT_SETTINGS, mapData = null) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const next = { ...cur };
  if (PLAYABLE.includes(r.mode)) next.mode = r.mode;
  if (MAP_IDS.includes(r.map)) next.map = r.map;
  const info = MODE_INFO[next.mode];
  if (mapData && !mapHosts(mapData, next.map, next.mode)) {
    next.map = MAP_IDS.find((id) => mapHosts(mapData, id, next.mode)) ?? cur.map;
  }
  if (TIME_OPTIONS.includes(r.time)) next.time = r.time;
  if (info.limits.includes(r.limit)) next.limit = r.limit;
  else if (!info.limits.includes(next.limit)) next.limit = info.limit;
  if (WEAPON_RULES.includes(r.weapons)) next.weapons = r.weapons;
  return next;
}
