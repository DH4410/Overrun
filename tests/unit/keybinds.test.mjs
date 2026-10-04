import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIONS, bindKey, canon, codeOf, isRebound, keyName, resetKeybinds } from '../../src/keybinds.js';

test('by default every key stands for itself', () => {
  resetKeybinds();
  for (const a of ACTIONS) assert.equal(canon(a.def), a.def);
  assert.equal(canon('Escape'), 'Escape');
  assert.equal(canon('KeyZ'), 'KeyZ');
  assert.equal(isRebound(), false);
});

test('a rebound action answers to its new key, and its old key goes quiet', () => {
  resetKeybinds();
  assert.equal(bindKey('forward', 'KeyE'), true);
  assert.equal(canon('KeyE'), 'KeyW');     // the game still reads KeyW
  assert.equal(canon('KeyW'), null);       // nothing is left on the old key
  assert.equal(codeOf('forward'), 'KeyE');
  assert.equal(isRebound(), true);
});

test('taking a key that another action holds swaps the two', () => {
  resetKeybinds();
  bindKey('jump', 'KeyC');                 // C was crouch
  assert.equal(canon('KeyC'), 'Space');
  assert.equal(canon('Space'), 'KeyC');    // crouch moved to the jump key
  assert.equal(codeOf('crouch'), 'Space');
  // No key is ever on two actions.
  const used = ACTIONS.map((a) => codeOf(a.id));
  assert.equal(new Set(used).size, used.length);
});

test('keys the browser and the pause screen own cannot be bound; binding back to the default clears it', () => {
  resetKeybinds();
  assert.equal(bindKey('reload', 'Escape'), false);
  assert.equal(bindKey('nonsense', 'KeyQ'), false);
  assert.equal(codeOf('reload'), 'KeyR');
  bindKey('reload', 'KeyQ');
  bindKey('reload', 'KeyR');
  assert.equal(isRebound(), false);
});

test('key names read well', () => {
  assert.equal(keyName('KeyW'), 'W');
  assert.equal(keyName('Digit3'), '3');
  assert.equal(keyName('ShiftLeft'), 'L-SHIFT');
  assert.equal(keyName('Space'), 'SPACE');
  assert.equal(keyName('Numpad4'), 'NUM 4');
});
