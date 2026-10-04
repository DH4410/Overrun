/**
 * Rebindable keys.
 *
 * The rest of the game reads physical key codes (`keys.KeyW`, `case 'KeyR'`). Rather than touch
 * every reader, the one place keys enter (the keydown/keyup listeners) runs the code through
 * `canon()`: a key the player bound to an action comes out as that action's default code, and the
 * default code of an action that was moved elsewhere comes out as nothing. Everything downstream
 * keeps reading the defaults and never learns the keys were remapped.
 *
 * Bindings are one to one: giving a key to an action swaps with whichever action held it.
 */

export const ACTIONS = [
  { id: 'forward', label: 'Move forward', def: 'KeyW', group: 'MOVEMENT' },
  { id: 'back', label: 'Move back', def: 'KeyS', group: 'MOVEMENT' },
  { id: 'left', label: 'Move left', def: 'KeyA', group: 'MOVEMENT' },
  { id: 'right', label: 'Move right', def: 'KeyD', group: 'MOVEMENT' },
  { id: 'jump', label: 'Jump', def: 'Space', group: 'MOVEMENT' },
  { id: 'sprint', label: 'Sprint', def: 'ShiftLeft', group: 'MOVEMENT' },
  { id: 'crouch', label: 'Crouch', def: 'KeyC', group: 'MOVEMENT' },
  { id: 'reload', label: 'Reload', def: 'KeyR', group: 'COMBAT' },
  { id: 'frag', label: 'Frag grenade', def: 'KeyG', group: 'COMBAT' },
  { id: 'smoke', label: 'Smoke grenade', def: 'KeyF', group: 'COMBAT' },
  { id: 'slot1', label: 'Weapon slot 1', def: 'Digit1', group: 'WEAPONS' },
  { id: 'slot2', label: 'Weapon slot 2', def: 'Digit2', group: 'WEAPONS' },
  { id: 'slot3', label: 'Weapon slot 3', def: 'Digit3', group: 'WEAPONS' },
  { id: 'slot4', label: 'Weapon slot 4', def: 'Digit4', group: 'WEAPONS' },
  { id: 'slot5', label: 'Grenade slot', def: 'Digit5', group: 'WEAPONS' },
  { id: 'board', label: 'Scoreboard (hold)', def: 'Tab', group: 'OTHER' },
  { id: 'emote', label: 'Emote wheel (hold)', def: 'KeyB', group: 'OTHER' },
];

const STORE = 'overrun.keybinds';
const DEFAULT_OF = new Map(ACTIONS.map((a) => [a.id, a.def]));
const DEFAULTS = new Set(DEFAULT_OF.values());
/** Keys that cannot be given away: the browser and the pause screen own them. */
const RESERVED = new Set(['Escape', 'Enter', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'ContextMenu']);

let bound = {};              // action id -> code, only where it differs from the default
let toAction = new Map();    // code the player presses -> default code it stands for

function rebuild() {
  toAction = new Map();
  for (const a of ACTIONS) toAction.set(codeOf(a.id), a.def);
}

export function codeOf(id) {
  return bound[id] ?? DEFAULT_OF.get(id);
}

/** The code the rest of the game should see for a physical key press, or null to ignore it. */
export function canon(code) {
  const hit = toAction.get(code);
  if (hit) return hit;
  return DEFAULTS.has(code) ? null : code;   // a key that has moved away does nothing
}

export function loadKeybinds() {
  bound = {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    for (const [id, code] of Object.entries(raw)) if (DEFAULT_OF.has(id) && typeof code === 'string') bound[id] = code;
  } catch { /* corrupt or unavailable storage just means defaults */ }
  // A saved file with two actions on one key would lock both: fall back to defaults.
  const used = ACTIONS.map((a) => codeOf(a.id));
  if (new Set(used).size !== used.length) bound = {};
  rebuild();
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(bound)); } catch { /* ignore */ }
}

/** Gives `code` to `id`, swapping with the action that had it. Returns false for a key that cannot be bound. */
export function bindKey(id, code) {
  if (!DEFAULT_OF.has(id) || RESERVED.has(code) || !code) return false;
  const old = codeOf(id);
  const other = ACTIONS.find((a) => a.id !== id && codeOf(a.id) === code);
  const set = (k, c) => { if (c === DEFAULT_OF.get(k)) delete bound[k]; else bound[k] = c; };
  if (other) set(other.id, old);
  set(id, code);
  rebuild();
  save();
  return true;
}

export function resetKeybinds() {
  bound = {};
  rebuild();
  save();
}

export function isRebound() {
  return Object.keys(bound).length > 0;
}

const PRETTY = { ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', AltLeft: 'L-ALT', AltRight: 'R-ALT',
  Space: 'SPACE', Tab: 'TAB', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  CapsLock: 'CAPS', Backspace: 'BACKSPACE' };

export function keyName(code) {
  if (PRETTY[code]) return PRETTY[code];
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m) return m[1];
  return code.replace(/^Numpad/, 'NUM ').toUpperCase();
}

rebuild();
