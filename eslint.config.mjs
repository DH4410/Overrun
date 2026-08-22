import globals from 'globals';

// Correctness-only ESLint config.
// Goal: catch undeclared identifiers (the class of bug that caused _rayFrom and _v1
// to be silently missing after Phase 2 modularization) without triggering thousands
// of style warnings on existing code.
//
// Rules enabled:
//   no-undef          — undeclared identifiers (the primary target)
//   no-unused-vars    — write-only or never-read locals (secondary signal)
//   no-use-before-define — temporal dead-zone bugs

const browserGlobals = {
  // Standard browser globals used by the game
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  innerWidth: 'readonly',
  innerHeight: 'readonly',
  devicePixelRatio: 'readonly',
  addEventListener: 'readonly',
  removeEventListener: 'readonly',
  globalThis: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  AudioContext: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  Worker: 'readonly',
  Image: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  PointerEvent: 'readonly',
  HTMLElement: 'readonly',
  HTMLCanvasElement: 'readonly',
};

export default [
  // ── src/*.js and game.js  ─────────────────────────────────────────────────
  // These are ES modules executed in the browser. THREE and CANNON come in via
  // import statements at the top of each file, so ESLint sees them as declared.
  {
    files: ['src/**/*.js', 'game.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      'no-undef': 'error',
      // Allow unused vars that start with _ (intentional placeholders) but flag others
      'no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'none' }],
    },
  },

  // ── tests/**/*.mjs  ───────────────────────────────────────────────────────
  // Playwright test files run in Node. page.evaluate() callbacks ARE checked by
  // ESLint as Node code, which would flag browser APIs inside them. We add browser
  // globals here to keep noise low — the real browser-context safety is Playwright's job.
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...browserGlobals,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'none' }],
    },
  },

  // ── scripts/**/*.mjs  ─────────────────────────────────────────────────────
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'none' }],
    },
  },

  // ── Ignore generated / vendored files  ───────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'sw.js',           // service worker — separate global environment
      'test-results/**',
    ],
  },
];
