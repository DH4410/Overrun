import { expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXUAAAAASUVORK5CYII=',
  'base64',
);

export const APP_STATE = Object.freeze({
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  SETTINGS: 'settings',
});

async function installDependencyRoutes(page) {
  await page.route('https://unpkg.com/three@0.169.0/**', async (route) => {
    const marker = '/three@0.169.0/';
    const relative = new URL(route.request().url()).pathname.split(marker)[1];
    await route.fulfill({
      path: path.join(repoRoot, 'node_modules', 'three', relative),
      contentType: 'text/javascript; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });

  await page.route('https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/+esm', async (route) => {
    await route.fulfill({
      path: path.join(repoRoot, 'node_modules', 'cannon-es', 'dist', 'cannon-es.js'),
      contentType: 'text/javascript; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });

  await page.route('https://dl.polyhaven.org/**', async (route) => {
    await route.fulfill({
      body: tinyPng,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
}

async function installDeterministicSettingsAndGamepad(page) {
  await page.addInitScript(() => {
    localStorage.setItem('overrun.settings', JSON.stringify({ quality: 'low', masterVolume: 0 }));

    let clockMs = 0;
    let nextFrameId = 1;
    let frameQueue = [];
    const cancelledFrames = new Set();
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clockMs });
    globalThis.requestAnimationFrame = (callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frameQueue.push({ callback, id });
      return id;
    };
    globalThis.cancelAnimationFrame = (id) => cancelledFrames.add(id);
    globalThis.__testClock = {
      pump(frames = 1, dtMs = 1000 / 60) {
        for (let frame = 0; frame < frames; frame += 1) {
          clockMs += dtMs;
          const callbacks = frameQueue;
          frameQueue = [];
          for (const { callback, id } of callbacks) {
            if (cancelledFrames.delete(id)) continue;
            callback(clockMs);
          }
        }
      },
    };

    const buttons = Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 }));
    const onePollButtons = new Set();
    const gamepad = {
      axes: [0, 0, 0, 0],
      buttons,
      connected: true,
      id: 'OVERRUN automated test pad',
      index: 0,
      mapping: 'standard',
      timestamp: 0,
    };

    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => {
        const snapshot = { ...gamepad, buttons: buttons.map((button) => ({ ...button })) };
        for (const index of onePollButtons) {
          buttons[index].pressed = false;
          buttons[index].touched = false;
          buttons[index].value = 0;
          onePollButtons.delete(index);
        }
        return [snapshot];
      },
    });
    globalThis.__testGamepad = {
      setButton(index, down) {
        buttons[index].pressed = down;
        buttons[index].touched = down;
        buttons[index].value = down ? 1 : 0;
        gamepad.timestamp += 1;
      },
      tapButton(index) {
        buttons[index].pressed = true;
        buttons[index].touched = true;
        buttons[index].value = 1;
        onePollButtons.add(index);
        gamepad.timestamp += 1;
      },
    };
  });
}

export function watchRuntimeErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

export async function bootGame(page) {
  await installDependencyRoutes(page);
  await installDeterministicSettingsAndGamepad(page);

  // Fail immediately on any JS exception or unhandled promise rejection during boot.
  // Without this, a crash before 'DEPLOY' is set would only surface as a 45-second timeout,
  // obscuring the actual error. Any pageerror rejects the waitForFunction below.
  const pageErrorPromise = new Promise((_, reject) => {
    page.once('pageerror', (err) => reject(new Error(`Page error during boot: ${err.message}`)));
  });

  await page.goto('/');

  // Verify that the modular entry point is being served, not the old monolithic game.js.
  // A stale server (e.g. reuseExistingServer with a server from a different branch) would
  // serve the monolithic file which lacks the module check below, causing a false green.
  const gameJsContent = await page.evaluate(async () => {
    const r = await fetch('/game.js');
    return r.text();
  });
  if (!gameJsContent.includes('src/main.js')) {
    throw new Error(
      'game.js does not import src/main.js — test server is serving stale or monolithic code'
    );
  }

  await Promise.race([
    expect(page.locator('#play')).toBeEnabled({ timeout: 45_000 }),
    pageErrorPromise,
  ]);
  await expect(page.locator('#play')).toHaveText('DEPLOY');
  await page.waitForFunction(() => Boolean(globalThis.__game));
  await page.evaluate(() => {
    // Boot has already compiled and drawn the real scene once. Subsequent smoke assertions are
    // state-focused, so keep software-rendered CI responsive while explicitly pumped frames run.
    const { renderer } = globalThis.__game;
    // Stash the real methods before stubbing. WebGLRenderer assigns these as own
    // properties, so `delete` removes them outright rather than exposing a prototype
    // version — a test that wants real pixels (a visual check) needs them back.
    renderer.__real = {
      compile: renderer.compile.bind(renderer),
      render: renderer.render.bind(renderer),
      clear: renderer.clear.bind(renderer),
      clearDepth: renderer.clearDepth.bind(renderer),
    };
    renderer.compile = () => {};
    renderer.render = () => {};
    renderer.clear = () => {};
    renderer.clearDepth = () => {};
  });
}

export async function startMatch(page, { mode = 'dm', map = 'warehouse', diff = 'medium' } = {}) {
  // Mode and map are picked from popouts that each open from a card in the lobby.
  await page.locator('#mode-card').click();
  await page.locator(`.mode-btn[data-mode="${mode}"]`).click();
  await page.locator('#map-card').click();
  await page.locator(`#maps [data-map="${map}"]`).click();
  await page.locator(`#diffs [data-diff="${diff}"]`).click();
  await page.locator('#play').click();
  await page.waitForFunction(
    ({ expectedMode, expectedMap }) => (
      globalThis.__game?.match.running
      && globalThis.__game.match.mode === expectedMode
      && globalThis.__game.currentMapId() === expectedMap
    ),
    { expectedMode: mode, expectedMap: map },
  );
  await page.evaluate(() => {
    globalThis.__game.player.invulnTimer = Number.POSITIVE_INFINITY;
    for (const bot of globalThis.__game.bots) {
      bot.fireCd = Number.POSITIVE_INFINITY;
      bot.nadeCd = Number.POSITIVE_INFINITY;
    }
  });
}

/** Observe the public UI contract of the module-private APP_STATE/appState pair. */
export async function observedAppState(page) {
  return page.evaluate(() => {
    if (!globalThis.__game.match.running || !document.querySelector('#menu').classList.contains('hidden')) {
      return 'menu';
    }
    if (!document.querySelector('#settings').classList.contains('hidden')) return 'settings';
    if (document.querySelector('#pause').classList.contains('on')) return 'paused';
    return 'playing';
  });
}

export async function pumpFrames(page, frames = 1, dtMs = 1000 / 60) {
  await page.evaluate(
    ({ frameCount, frameDuration }) => globalThis.__testClock.pump(frameCount, frameDuration),
    { frameCount: frames, frameDuration: dtMs },
  );
}

export async function setGamepadButton(page, index, down) {
  await page.evaluate(
    ({ buttonIndex, isDown }) => globalThis.__testGamepad.setButton(buttonIndex, isDown),
    { buttonIndex: index, isDown: down },
  );
}

export async function pulseGamepadButton(page, index) {
  await setGamepadButton(page, index, true);
  await pumpFrames(page);
  await setGamepadButton(page, index, false);
  await pumpFrames(page);
}

export async function tapGamepadButton(page, index) {
  await page.evaluate((buttonIndex) => globalThis.__testGamepad.tapButton(buttonIndex), index);
  await pumpFrames(page);
}
