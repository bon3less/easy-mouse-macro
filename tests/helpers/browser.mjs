import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startFixtureServer } from '../fixtures/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = join(here, '..', '..', 'extension');

export const VIEWPORT = { width: 1100, height: 720 };

/** Wait for the MV3 service worker and derive the extension id from its URL. */
async function waitForServiceWorker(context, timeout = 20_000) {
  const existing = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout });
}

export async function openPopup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`${extensionId}/popup.html`);
  await page.waitForSelector('#btn-record');
  return page;
}

/**
 * Launch a real Chrome with the extension loaded unpacked - exactly the
 * chrome://extensions -> "Load unpacked" path the user will take.
 *
 * `extraFeatures` are appended to the --disable-features list.  The suite turns
 * off Chrome's smooth scrolling: it animates a wheel gesture over hundreds of
 * milliseconds, which makes "did this replayed wheel reach this offset yet" a
 * question about browser polish instead of about the macro.
 *
 * `userDataDir` reuses a profile instead of creating one - the way to ask a
 * question about what survives closing the browser.  A profile handed in is not
 * deleted on close: the caller owns it.
 */
export async function launchWithExtension({ headless = false, extraFeatures = [], userDataDir = null } = {}) {
  const ownProfile = !userDataDir;
  if (ownProfile) userDataDir = await mkdtemp(join(tmpdir(), 'emm-profile-'));
  const server = await startFixtureServer();

  const features = ['TranslateUI', 'OptimizationHints', ...extraFeatures];

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-features=${features.join(',')}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1280,860'
    ]
  });

  const worker = await waitForServiceWorker(context);
  const extensionId = new URL(worker.url()).host;

  const workerErrors = [];
  worker.on('console', (msg) => {
    if (msg.type() === 'error') workerErrors.push(msg.text());
  });
  worker.on('error', (err) => workerErrors.push(String(err)));

  return {
    context,
    server,
    worker,
    extensionId,
    workerErrors,
    userDataDir,
    async close() {
      try {
        await context.close();
      } finally {
        await server.close();
        if (ownProfile) await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  };
}

/** Small helpers shared by the specs. */
export async function resetPageLog(page) {
  await page.evaluate(() => {
    window.__emmLog.length = 0;
    window.__emmClicks.length = 0;
    window.__emmT0 = performance.now();
    document.querySelectorAll('.box').forEach((b) => {
      delete b.dataset.clicks;
    });
    document.getElementById('log-count').textContent = '0';
  });
}

export async function readPageLog(page) {
  return page.evaluate(() => ({
    log: window.__emmLog.map((e) => ({ ...e })),
    clicks: window.__emmClicks.map((e) => ({ ...e })),
    // Keyed by the fixture's data-name attribute: a, b, c.
    boxClicks: Object.fromEntries(
      [...document.querySelectorAll('.box')].map((b) => [
        (b.dataset.name || b.id).toLowerCase(),
        Number(b.dataset.clicks) || 0
      ])
    ),
    playState: document.documentElement.dataset.emmPlay || ''
  }));
}

export async function boxCenter(page, selector) {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
}

/**
 * Content scripts run in an isolated world, so the page's own JS can only see
 * the DOM marker the content script sets.
 */
export async function waitForContentScript(page, timeout = 15_000) {
  await page.waitForFunction(
    () => document.documentElement.dataset.emmReady === '1',
    null,
    { timeout }
  );
}

/** The playback marker the content script mirrors onto <html>. */
export async function playState(page) {
  return page.evaluate(() => document.documentElement.dataset.emmPlay || '');
}

/**
 * Whether the playback handed its events over one at a time.  A recording that
 * scrolls content is promised that sequence (see the note above the input queue
 * in background.js), and a finished replay reveals no other trace of it.
 */
export async function playSequenced(page) {
  return page.evaluate(() => document.documentElement.dataset.emmPlayOrdered === '1');
}

/** Clear the marker so the next playback can be awaited without a race. */
export async function resetPlayState(page) {
  await page.evaluate(() => document.documentElement.removeAttribute('data-emm-play'));
}

/**
 * Wait until playback is observable in the page. Returns 'running' when it is
 * still going, or the terminal state when playback was already done (a fast,
 * high-speed playback can finish before the first poll).
 */
export async function waitPlaybackStarted(page, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await playState(page).catch(() => '');
    if (value === 'running' || value === 'finished' || value === 'stopped') return value;
    if (Date.now() > deadline) {
      throw new Error(`playback never became observable (marker was "${value}")`);
    }
    await sleep(20);
  }
}

/** Wait for playback to leave 'running'; resolves to 'finished' or 'stopped'. */
export async function waitPlaybackFinished(page, timeout = 120_000) {
  await waitPlaybackStarted(page);
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await playState(page).catch(() => '');
    if (value === 'finished' || value === 'stopped') return value;
    if (Date.now() > deadline) {
      throw new Error(`playback did not finish (marker stayed "${value}")`);
    }
    await sleep(25);
  }
}

/**
 * Wait until the page stops receiving events. Trusted dispatch goes through
 * Chrome's input queue, so a handful of events can still land just after the
 * playback clock reports that it is done.
 */
export async function waitForPageQuiet(page, { idleMs = 450, timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = -1;
  let stableSince = Date.now();
  for (;;) {
    const count = await page.evaluate(() => window.__emmLog.length).catch(() => last);
    const now = Date.now();
    if (count !== last) {
      last = count;
      stableSince = now;
    } else if (now - stableSince >= idleMs) {
      return count;
    }
    if (now > deadline) return count;
    await sleep(60);
  }
}

/**
 * The events the extension itself has in its session store, read out of the
 * service worker.  This is the authoritative recording - the page's own log
 * also contains the raw moves that the recorder deliberately throttled away.
 */
export async function recordedEvents(context) {
  const read = (worker) =>
    worker.evaluate(async () => {
      const all = await chrome.storage.session.get();
      const keys = Object.keys(all).filter((k) => k.startsWith('session:'));
      if (!keys.length) return [];
      keys.sort((a, b) => ((all[b] && all[b].savedAt) | 0) - ((all[a] && all[a].savedAt) | 0));
      const entry = all[keys[0]];
      return entry && Array.isArray(entry.events) ? entry.events : [];
    });
  try {
    return await read(await waitForServiceWorker(context));
  } catch (err) {
    // The worker was recycled between the lookup and the evaluate: follow the
    // replacement rather than reporting a stale handle.
    const fresh = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    return read(fresh);
  }
}

/** Human-scale gesture: several intermediate moves so the trail is realistic. */
export async function glide(mouse, from, to, steps = 6) {
  for (let i = 1; i <= steps; i++) {
    await mouse.move(
      Math.round(from.x + ((to.x - from.x) * i) / steps),
      Math.round(from.y + ((to.y - from.y) * i) / steps)
    );
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate in the page until it holds or we time out. */
export async function waitFor(pageFn, { timeout = 15_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await pageFn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}
