/** Weapon silhouettes for the kill feed: one 72x20 drawing each, muzzle to the right, filled with currentColor. */
const SHAPES = {
  pistol: '<path d="M18 4h36v7h-8l-2 3h-8l-2 6h-8l2-6h-8z"/><rect x="54" y="5" width="4" height="4"/>',
  ar: '<path d="M2 7l8-1 3 2h25v-2h6v2h4v-2h18v3h-4v2h-9l-3 1h-6l-2 8h-6l2-8h-4l-3 7h-5l1-7h-10l-3 4H2z"/><rect x="22" y="3" width="9" height="2"/><rect x="66" y="5" width="4" height="6"/>',
  smg: '<path d="M6 7h6l3 2h20v-2h10v2h4v-3h8v3h4v3h-8v2h-8l-2 1h-5v8h-6v-8h-4l-3 5h-5l1-5h-6z"/><rect x="3" y="6" width="4" height="3"/>',
  shotgun: '<path d="M2 6l10-1 3 2h14v-1h38v3H31v1h14v3H32v-1h-4v1H14l-3 4H2z"/><rect x="38" y="10" width="16" height="4" rx="1"/>',
  sniper: '<path d="M2 6l12-1 4 2h18v2h28v2H38v1H24l-3 1h-5l-1 4h-5l1-4H8l-2 3H2z"/><rect x="20" y="1" width="18" height="4" rx="2"/><rect x="24" y="5" width="2" height="2"/><rect x="32" y="5" width="2" height="2"/><rect x="66" y="7" width="5" height="5"/>',
  revolver: '<path d="M16 5h38v6H44l-3 3h-6l-3 7h-7l3-7h-7l-6 4h-5l2-6z"/><circle cx="38" cy="8" r="4"/>',
  mp: '<path d="M10 7h8l3 2h18V7h12v3h6v3h-8v2h-9l-2 1h-4v7h-6v-7h-4l-3 4h-5l1-4h-5z"/><rect x="4" y="7" width="5" height="3"/>',
  lmg: '<path d="M2 8l9-1 3 2h22v-2h32v3h-8v2H48l-3 1h-8l-2 5h-5l1-5h-6l-3 6h-5l1-6H12l-3 3H2z"/><path d="M42 14h8l1 7h-9z"/><rect x="60" y="5" width="8" height="2"/>',
  ashotgun: '<path d="M2 7l9-1 3 2h18V6h36v3H34v2h14v3H35v1h-4v1h-5l-2 6h-5l1-6h-4l-3 4H2z"/><rect x="38" y="11" width="16" height="3" rx="1"/>',
  dmr: '<path d="M2 7l11-1 4 2h20v2h28v2H38v1H25l-3 1h-5l-1 5h-5l1-5H9l-3 3H2z"/><rect x="22" y="3" width="14" height="3" rx="1.5"/>',
  claw: '<path d="M14 2l14 18-3 1L11 4zM29 1l16 19-3 1L26 3zM44 2l14 18-3 1L41 4z"/>',
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
