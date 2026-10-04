/** Weapon silhouettes for the kill feed: one 72x20 drawing each, muzzle to the right, filled with currentColor. */
const SHAPES = {
  pistol: '<path d="M18 4h36v7h-8l-2 3h-8l-2 6h-8l2-6h-8z"/><rect x="54" y="5" width="4" height="4"/>',
  ar: '<path d="M2 7l8-1 3 2h25v-2h6v2h4v-2h18v3h-4v2h-9l-3 1h-6l-2 8h-6l2-8h-4l-3 7h-5l1-7h-10l-3 4H2z"/><rect x="22" y="3" width="9" height="2"/><rect x="66" y="5" width="4" height="6"/>',
  smg: '<path d="M6 7h6l3 2h20v-2h10v2h4v-3h8v3h4v3h-8v2h-8l-2 1h-5v8h-6v-8h-4l-3 5h-5l1-5h-6z"/><rect x="3" y="6" width="4" height="3"/>',
  shotgun: '<path d="M2 6l10-1 3 2h14v-1h38v3H31v1h14v3H32v-1h-4v1H14l-3 4H2z"/><rect x="38" y="10" width="16" height="4" rx="1"/>',
  sniper: '<path d="M2 6l12-1 4 2h18v2h28v2H38v1H24l-3 1h-5l-1 4h-5l1-4H8l-2 3H2z"/><rect x="20" y="1" width="18" height="4" rx="2"/><rect x="24" y="5" width="2" height="2"/><rect x="32" y="5" width="2" height="2"/><rect x="66" y="7" width="5" height="5"/>',
  frag: '<circle cx="36" cy="12" r="7"/><rect x="33" y="2" width="6" height="4"/><path d="M39 3h8v2h-8zM28 5l-4-3 2-2 5 4z"/>',
};

export const KILL_ICON_IDS = Object.keys(SHAPES);

/** An <svg> for `weaponId` (a pistol if unknown), or null for a death with no weapon. */
export function killIcon(weaponId) {
  const shape = SHAPES[weaponId];
  if (!shape) return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 72 22');
  svg.setAttribute('class', 'kicon');
  svg.setAttribute('aria-label', weaponId);
  svg.innerHTML = shape;
  return svg;
}
