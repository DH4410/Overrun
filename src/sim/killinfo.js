/**
 * How a kill happened, beyond who and with what: shared by the server, single player and the HUD so
 * the feed, the banner and the death screen all say the same thing.
 */
export const KILL_FLAG = { NOSCOPE: 1, LONGSHOT: 2, MIDAIR: 4 };
export const LONGSHOT_M = 45;      // a kill from at least this far is called out

/** The flag bits for a kill. `scoped` is whether the shooter was aiming down the sights. */
export function killFlags({ weapon, zoom = false, scoped = false, dist = 0, airborne = false }) {
  let f = 0;
  if (weapon && weapon !== 'frag' && zoom && !scoped) f |= KILL_FLAG.NOSCOPE;
  if (weapon && weapon !== 'frag' && dist >= LONGSHOT_M) f |= KILL_FLAG.LONGSHOT;
  if (weapon && weapon !== 'frag' && airborne) f |= KILL_FLAG.MIDAIR;
  return f;
}

/** The labels to show for a kill, most impressive first. */
export function killTags({ head = false, flags = 0, dist = 0 }) {
  const tags = [];
  if (flags & KILL_FLAG.NOSCOPE) tags.push('NOSCOPE');
  if (head) tags.push('HEADSHOT');
  if (flags & KILL_FLAG.MIDAIR) tags.push('MIDAIR');
  if (flags & KILL_FLAG.LONGSHOT) tags.push(`${Math.round(dist)} M`);
  return tags;
}

/** One line for the death screen and the killcam: "SNIPER RIFLE · NOSCOPE · HEADSHOT · 87 M". */
export function killLine(weaponName, info) {
  return [weaponName, ...killTags(info)].filter(Boolean).join(' · ');
}
