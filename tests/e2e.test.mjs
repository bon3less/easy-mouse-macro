import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  launchWithExtension,
  openPopup,
  resetPageLog,
  readPageLog,
  boxCenter,
  glide,
  sleep,
  waitForContentScript,
  resetPlayState,
  waitPlaybackStarted,
  playSequenced,
  waitPlaybackFinished,
  waitForPageQuiet,
  recordedEvents,
  waitFor,
  VIEWPORT
} from './helpers/browser.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = require(join(here, '..', 'extension', 'lib', 'macro-core.js'));

const NEAR = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: expected ${b} +/- ${tol}, got ${a}`);

const app = { ctx: null };

test.before(async () => {
  app.ctx = await launchWithExtension();
});

test.after(async () => {
  if (app.ctx) await app.ctx.close();
});

/** Open a fresh fixture tab + popup pair; both are closed by the returned fn. */
async function session() {
  const { context, extensionId, server } = app.ctx;
  const page = await context.newPage();
  await page.goto(server.url('/testpage.html'));
  await page.waitForLoadState('load');
  // The declared content script must be live before we record anything.
  await waitForContentScript(page);
  const popup = await openPopup(context, `chrome-extension://${extensionId}`);
  const centers = {
    a: await boxCenter(page, '#box-a'),
    b: await boxCenter(page, '#box-b'),
    c: await boxCenter(page, '#box-c')
  };
  return {
    page,
    popup,
    centers,
    context,
    async close() {
      await popup.close().catch(() => {});
      await page.close().catch(() => {});
    }
  };
}

const pillText = (popup) => popup.locator('#state-pill').textContent();
const waitForPill = async (popup, text, timeout = 8_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if ((await pillText(popup)).trim() === text) return;
    if (Date.now() > deadline) throw new Error(`state pill never became "${text}" (got "${await pillText(popup)}")`);
    await sleep(120);
  }
};

async function startRecording(popup) {
  await popup.click('#btn-record');
  await waitForPill(popup, 'Recording');
}

async function stopRecording(popup) {
  await popup.click('#btn-record');
  await waitForPill(popup, 'Ready');
}

async function openPlayDialog(popup) {
  await popup.click('#btn-play');
  await popup.waitForSelector('#play-form', { state: 'visible' });
}

/**
 * Set an input to an arbitrary raw value. Playwright's fill() refuses to type
 * non-numeric text into input[type=number], and the clamping tests need that.
 */
async function setRawValue(popup, selector, value) {
  await popup.locator(selector).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function configurePlay(popup, { repetitions, speed, trusted }) {
  if (repetitions !== undefined) await setRawValue(popup, '#repetitions', repetitions);
  if (speed !== undefined) {
    await popup.locator('#speed').evaluate((el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, speed);
  }
  if (trusted !== undefined) await popup.locator('#trusted').setChecked(trusted);
}

async function confirmPlay(page, popup) {
  // Clear the marker first so the wait cannot observe a previous playback.
  await resetPlayState(page);
  await popup.click('#btn-confirm');
  await popup.waitForSelector('#play-form', { state: 'hidden' });
}

/** Click A, click B, then drag from C to a free spot: moves + 3 click pairs. */
async function performGesture(page, centers) {
  const m = page.mouse;
  const dragEnd = { x: centers.c.x + 120, y: centers.c.y + 60 };
  await m.move(20, 20);
  await sleep(90);
  await glide(m, { x: 20, y: 20 }, centers.a, 7);
  await sleep(110);
  await m.click(centers.a.x, centers.a.y);
  await sleep(150);
  await glide(m, centers.a, centers.b, 7);
  await sleep(110);
  await m.click(centers.b.x, centers.b.y);
  await sleep(150);
  await glide(m, centers.b, centers.c, 5);
  await sleep(90);
  await m.down();
  await sleep(70);
  await glide(m, centers.c, dragEnd, 6);
  await sleep(60);
  await m.up();
  await sleep(120);
  return { dragEnd };
}

/* -------------------------------------------------------------------------- *
 * The fixture's scrollable panel: 62 checkboxes that only come into view by
 * wheeling the container they live in.
 * -------------------------------------------------------------------------- */

const PANEL = '#mouse-wheel-click-test';

/** Panel geometry, plus a wheel step that can never skip a row past the top. */
async function panelGeometry(page) {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      top: r.top,
      bottom: r.bottom,
      // A notch smaller than the visible height: one wheel can then never carry
      // a row clean past the top of the window and lose it on the way.
      step: Math.max(16, Math.min(40, Math.round((r.bottom - r.top) * 0.55)))
    };
  }, PANEL);
}

async function panelState(page) {
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    const boxes = [...panel.querySelectorAll('input[type="checkbox"]')];
    return {
      open: !!panel.querySelector('details').open,
      total: boxes.length,
      checked: boxes.filter((b) => b.checked).length,
      scrollTop: Math.round(panel.scrollTop),
      scrollable: Math.round(panel.scrollHeight - panel.clientHeight)
    };
  }, PANEL);
}

/**
 * Watch the container from the page side: log every wheel it receives, and give
 * the test a promise that resolves once the container really stopped moving.
 *
 * Chrome applies a trusted wheel on the compositor and lets the page's own
 * scrollTop catch up about a hundred milliseconds later - and after two wheels
 * in a row, that catch-up can sit a whole notch behind. A "quiet scrollTop"
 * therefore proves nothing: the value can be a stable plateau the compositor is
 * about to leave, and a measurement taken on it aims the next click at the wrong
 * row. Only the container's own `scroll` events say that an offset has landed
 * where the page - and a click's hit test - can see it, so the wait demands a
 * scroll event for the wheel it was called after, then real quiet. A wheel at
 * the end of the scroll range fires no event at all, which is why "nothing
 * moved" has to settle on a timer instead.
 */
async function instrumentPanel(page) {
  await page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    window.__emmWheels = [];
    document.addEventListener(
      'wheel',
      (ev) => {
        window.__emmWheels.push({
          dy: Math.round(ev.deltaY),
          y: Math.round(ev.clientY),
          trusted: ev.isTrusted,
          inPanel: !!(ev.target.closest && ev.target.closest(sel))
        });
      },
      true
    );
    window.__scrollTicks = 0;
    panel.addEventListener(
      'scroll',
      () => {
        window.__scrollTicks++;
      },
      { passive: true }
    );
    window.__emmWaitScroll = () =>
      new Promise((resolve) => {
        const start = window.__scrollTicks;
        const t0 = performance.now();
        let seen = start;
        let movedAt = t0;
        const tick = () => {
          const t = performance.now();
          if (window.__scrollTicks !== seen) {
            seen = window.__scrollTicks;
            movedAt = t;
          }
          const moved = seen > start;
          if (!moved && t - t0 > 320) return resolve(Math.round(panel.scrollTop));
          if (moved && t - movedAt > 120 && t - t0 > 260) return resolve(Math.round(panel.scrollTop));
          if (t - t0 > 2_000) return resolve(Math.round(panel.scrollTop));
          setTimeout(tick, 30);
        };
        tick();
      });
    window.__emmPanelReset = () => {
      panel.querySelectorAll('details').forEach((d) => {
        d.open = false;
      });
      panel.scrollTop = 0;
      panel.querySelectorAll('input[type="checkbox"]').forEach((b) => {
        b.checked = false;
      });
      window.__emmWheels = [];
    };
  }, PANEL);
  await waitForScrollSettled(page);
}

/** Wait until the container stopped moving after a wheel. */
async function waitForScrollSettled(page) {
  await page.evaluate(() => window.__emmWaitScroll());
}

/** Whether checkbox `i` is ticked. */
async function checkboxChecked(page, i) {
  return page.evaluate(
    ({ sel, index }) =>
      document.querySelector(sel).querySelectorAll('input[type="checkbox"]')[index].checked,
    { sel: PANEL, index: i }
  );
}

/** Where checkbox `i` sits right now, and whether a click could hit it. */
async function checkboxSpot(page, i) {
  return page.evaluate(
    ({ sel, index }) => {
      const panel = document.querySelector(sel);
      const box = panel.querySelectorAll('input[type="checkbox"]')[index];
      const r = box.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      return {
        x,
        y,
        // Fully inside, not just its centre: clicking a row that is clipped at the
        // edge would let Chrome scroll the focused control into view underneath us.
        inside: r.top > pr.top + 1 && r.bottom < pr.bottom - 1 && r.left > pr.left + 1 && r.right < pr.right - 1,
        // elementFromPoint ignores the container's clip, so it is not enough alone.
        hit: document.elementFromPoint(x, y) === box,
        // Pixels left to scroll, signed: the row is this far from the middle of the
        // window. Wheeling by the residual converges; wheeling by a fixed notch
        // around the bottom edge oscillates, since a row there is neither clearly
        // above nor clearly below.
        dy: Math.round(y - (pr.top + pr.bottom) / 2)
      };
    },
    { sel: PANEL, index: i }
  );
}

/**
 * Open the details/summary block with a click, then tick every checkbox inside
 * it, wheeling the container so each row comes to the pointer.
 */
async function tickEveryCheckbox(page) {
  const m = page.mouse;
  const summary = await page.evaluate((sel) => {
    const r = document.querySelector(`${sel} summary`).getBoundingClientRect();
    return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) };
  }, PANEL);

  await glide(m, { x: summary.x - 40, y: summary.y }, summary, 4);
  await m.click(summary.x, summary.y);
  await sleep(250);

  const geo = await panelGeometry(page);
  await m.move(geo.x, geo.y);
  await sleep(80);

  const total = (await panelState(page)).total;
  let wheels = 0;
  let retries = 0;
  const misses = [];
  for (let i = 0; i < total; i++) {
    let spot = await checkboxSpot(page, i);
    for (let guard = 0; !spot.inside || !spot.hit; guard++) {
      assert.ok(guard < 40, `checkbox ${i} never became reachable by wheeling (${JSON.stringify(spot)})`);
      const dy = Math.max(-geo.step, Math.min(geo.step, spot.dy)) || geo.step;
      await m.wheel(0, dy);
      wheels++;
      await waitForScrollSettled(page);
      spot = await checkboxSpot(page, i);
    }
    // Click, and only click again when the first click plainly did nothing: a
    // click that missed toggles nothing, so recording a second one keeps the
    // gesture an odd number of toggles for this row - which is what makes the
    // replay end with the same row ticked.
    let ticked = false;
    for (let attempt = 0; attempt < 3 && !ticked; attempt++) {
      if (attempt) {
        retries++;
        spot = await checkboxSpot(page, i);
      }
      await m.move(spot.x, spot.y, { steps: 3 });
      await m.click(spot.x, spot.y);
      await sleep(30);
      ticked = await checkboxChecked(page, i);
    }
    // A click that did not tick its box has to fail here, not silently as a
    // "replay missed one" further down the line.
    if (!ticked) misses.push({ i, spot });
  }
  return { total, wheels, retries, misses };
}

/**
 * Wait for playback in the page itself: the content script mirrors its state to
 * <html data-emm-play>. The popup polls, so it cannot be the authority here.
 */
async function waitForPagePlayback(page, plannedMs) {
  await waitPlaybackStarted(page);
  return waitPlaybackFinished(page, plannedMs + 30_000);
}

/* ================================================================== *
 * 1. Loading "unpacked" and the UI contract
 * ================================================================== */

test('extension loads unpacked: service worker up, popup renders, Play disabled until something is recorded', async () => {
  const { page, popup, close } = await session();
  try {
    assert.equal(app.ctx.workerErrors.length, 0, 'service worker logged errors: ' + app.ctx.workerErrors.join('\n'));
    assert.match(app.ctx.worker.url(), /^chrome-extension:\/\/[a-p]{32}\/background\.js$/);

    assert.equal(await pillText(popup), 'Idle');
    assert.equal(await popup.locator('#btn-play').isDisabled(), true, 'Play must be disabled with no recording');
    assert.equal(await popup.locator('#btn-record').isEnabled(), true);
    assert.match(await popup.locator('#btn-record .btn-label').textContent(), /Record/);
    assert.match(popup.url(), /popup\.html$/);
    assert.match((await popup.locator('#target').getAttribute('title')) || '', /127\.0\.0\.1/);
  } finally {
    await close();
  }
});

test('Record -> Stop captures mouse moves and clicks and enables Play', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);

    // The popup counts live from the page while recording is running.
    await glide(page.mouse, { x: 10, y: 10 }, { x: 120, y: 120 }, 8);
    await page.mouse.click(centers.a.x, centers.a.y);
    await sleep(500);
    const live = Number(await popup.locator('#m-events').textContent());
    assert.ok(live > 0, `live counter must move while recording, got ${live}`);

    await performGesture(page, centers);
    const pageEvents = await page.evaluate(() => window.__emmLog.length);

    // Closing the popup must not interrupt the recorder or lose its buffer.
    await popup.close();
    await glide(page.mouse, centers.c, { x: 40, y: 300 }, 5);
    const popup2 = await openPopup(app.ctx.context, `chrome-extension://${app.ctx.extensionId}`);
    await waitForPill(popup2, 'Recording');
    await stopRecording(popup2);

    const metrics = {
      events: Number(await popup2.locator('#m-events').textContent()),
      moves: Number(await popup2.locator('#m-moves').textContent()),
      clicks: Number(await popup2.locator('#m-clicks').textContent()),
      length: await popup2.locator('#m-length').textContent()
    };

    assert.ok(metrics.events > 0, 'recording must capture events');
    assert.ok(metrics.moves >= 20, `expected a movement trail, got ${metrics.moves}`);
    // 3 press+release+click triples in the gesture, all survived the popup close
    assert.ok(metrics.clicks >= 9, `expected click events, got ${metrics.clicks}`);
    assert.ok(parseFloat(metrics.length) > 0.5, 'recorded length should be about a second: ' + metrics.length);
    assert.equal(await pillText(popup2), 'Ready');
    assert.equal(await popup2.locator('#btn-play').isDisabled(), false, 'Play must become available after recording');
    assert.ok(pageEvents > 0);
    await popup2.close();
  } finally {
    await close();
  }
});

/* ================================================================== *
 * 2. Replay fidelity
 * ================================================================== */

test('replay reproduces the recorded clicks at the recorded positions (trusted input, 3x @ 1x)', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    const { dragEnd } = await performGesture(page, centers);
    await stopRecording(popup);

    const lengthSec = parseFloat(await popup.locator('#m-length').textContent());
    const plannedMs = lengthSec * 1000 * 3 + 400 * 2 + 350;

    await resetPageLog(page);
    await openPlayDialog(popup);
    await configurePlay(popup, { repetitions: 3, speed: 1, trusted: true });
    await confirmPlay(page, popup);
    await waitForPagePlayback(page, plannedMs);
    await waitForPageQuiet(page);

    const { log, boxClicks } = await readPageLog(page);
    assert.ok(log.length > 0, 'the page received no events during replay');

    // 1) Trusted: the page must not be able to tell this from a real user.
    const trustedShare = log.filter((e) => e.isTrusted).length / log.length;
    assert.ok(trustedShare === 1, `replayed events must be trusted, got ${(trustedShare * 100).toFixed(1)}%`);

    // 2) The right elements were clicked, once per repetition.
    assert.equal(boxClicks.a, 3, 'box A must be clicked once per repetition');
    assert.equal(boxClicks.b, 3, 'box B must be clicked once per repetition');

    // 3) Positions match the recording within a pixel or two.
    const clicks = log.filter((e) => e.type === 'click');
    assert.equal(clicks.length, 9, '3 repetitions x (A, B, drag) click events');
    const want = [centers.a, centers.b, dragEnd];
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i < 3; i++) {
        const got = clicks[rep * 3 + i];
        NEAR(got.x, want[i].x, 2, `rep ${rep + 1} click ${i} x`);
        NEAR(got.y, want[i].y, 2, `rep ${rep + 1} click ${i} y`);
      }
    }

    // 4) Button presses and releases alternate exactly like the recording.
    const pressRelease = log.filter((e) => e.type === 'mousedown' || e.type === 'mouseup');
    let expectingDown = true;
    for (const e of pressRelease) {
      assert.equal(
        e.type,
        expectingDown ? 'mousedown' : 'mouseup',
        'press/release order broke: ' + pressRelease.map((x) => x.type).join(',')
      );
      expectingDown = !expectingDown;
    }
    assert.equal(expectingDown, true, 'unbalanced press/release pairs');
  } finally {
    await close();
  }
});

/** Fraction of recorded positions that appear in the played trail (+/- tol px). */
function coverage(played, recorded, tol = 2) {
  let matched = 0;
  for (const [x, y] of recorded) {
    if (played.some((e) => Math.abs(e[0] - x) <= tol && Math.abs(e[1] - y) <= tol)) matched++;
  }
  return matched / recorded.length;
}

/** Index of the closest recorded position to (x, y), or -1 when nothing is near. */
function nearestRecorded(recorded, x, y, tol = 3) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < recorded.length; i++) {
    const d = Math.hypot(recorded[i][0] - x, recorded[i][1] - y);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return bestDist <= tol ? best : -1;
}

/** Share of pairs that visit the recorded path out of order. */
function inversionRate(indices) {
  let inversions = 0;
  for (let i = 1; i < indices.length; i++) if (indices[i] < indices[i - 1]) inversions++;
  return indices.length > 1 ? inversions / (indices.length - 1) : 0;
}

test('replay follows the recorded path, without inventing positions (trusted)', async () => {
  const { page, popup, centers, context, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);

    // The extension's own store is the reference: the page log still holds the
    // raw moves that the recorder intentionally throttled away.
    const recordedMoves = (await recordedEvents(context))
      .filter((e) => e.type === 'move')
      .map((e) => [e.x, e.y]);
    assert.ok(recordedMoves.length > 12, 'gesture should leave a decent movement trail');

    await resetPageLog(page);
    await openPlayDialog(popup);
    await configurePlay(popup, { repetitions: 1, speed: 1, trusted: true });
    await confirmPlay(page, popup);
    await waitForPagePlayback(page, 6000);
    await waitForPageQuiet(page);

    const { log } = await readPageLog(page);
    const playedMoves = log.filter((e) => e.type === 'mousemove').map((e) => [e.x, e.y]);
    assert.ok(playedMoves.length > 10, `replay delivered almost no movement (${playedMoves.length})`);

    // 1) Fidelity: the replay may be sampled, but it must never invent a
    //    position the user never visited.
    const indices = playedMoves.map(([x, y]) => nearestRecorded(recordedMoves, x, y));
    const invented = indices.filter((i) => i < 0).length;
    assert.equal(invented, 0, `${invented} replayed positions were never recorded`);

    // 2) Order: the path is walked in the recorded direction.
    const ordered = indices.filter((i) => i >= 0);
    assert.ok(
      inversionRate(ordered) <= 0.2,
      `the replay jumped backwards through the path (${(inversionRate(ordered) * 100).toFixed(0)}% of steps)`
    );

    // 3) Density. Chrome folds several mouse moves that land in one frame into
    //    the last one - real input is coalesced the same way - so what survives
    //    in the page is bounded by the page's own frame rate. Requiring half
    //    the positions keeps this honest without testing the compositor.
    const cov = coverage(playedMoves, recordedMoves);
    assert.ok(cov >= 0.5, `trail coverage too low: ${(cov * 100).toFixed(0)}%`);
  } finally {
    await close();
  }
});

/* ================================================================== *
 * 3. Repetitions and speed actually take effect
 * ================================================================== */

test('repetitions multiply the emitted events; speed divides the elapsed time', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);
    const lengthSec = parseFloat(await popup.locator('#m-length').textContent());
    const spanMs = lengthSec * 1000;

    const measure = async ({ repetitions, speed }) => {
      await resetPageLog(page);
      const t0 = Date.now();
      await openPlayDialog(popup);
      await configurePlay(popup, { repetitions, speed, trusted: true });
      await confirmPlay(page, popup);
      await waitForPagePlayback(page, ((spanMs * repetitions) / speed + 400 * repetitions + 500) + 20_000);
      await waitForPageQuiet(page);
      const wall = Date.now() - t0;
      const { log, boxClicks } = await readPageLog(page);
      // The page's own clock is far more precise than wall time around a dialog.
      const span = log.length > 1 ? log[log.length - 1].t - log[0].t : 0;
      return {
        wall,
        span,
        clicks: log.filter((e) => e.type === 'click').length,
        boxA: boxClicks.a,
        events: log.length
      };
    };

    const slow1 = await measure({ repetitions: 1, speed: 1 });
    const fast10 = await measure({ repetitions: 1, speed: 10 });
    const slow5rep = await measure({ repetitions: 5, speed: 10 });

    assert.ok(slow1.events > 0 && fast10.events > 0 && slow5rep.events > 0, 'a playback delivered nothing');

    // Repetitions: 5x the repetitions at the same speed -> 5x the events.
    assert.equal(fast10.clicks * 5, slow5rep.clicks, 'repetitions must multiply click events');
    assert.equal(slow5rep.boxA, 5, 'box A must be clicked 5 times for 5 repetitions');
    assert.ok(Math.abs(slow1.clicks - fast10.clicks) <= 2, 'speed must not drop events');

    const ratio = slow1.span / fast10.span;
    assert.ok(ratio > 5 && ratio < 16, `10x speed should compress ~10x, measured ${ratio.toFixed(2)}x (${slow1.span}ms -> ${fast10.span}ms)`);
    // Five repetitions take (roughly) five times as long as one at equal speed.
    const repRatio = slow5rep.span / fast10.span;
    assert.ok(repRatio > 3 && repRatio < 8, `5 reps should stretch the timeline ~5x, measured ${repRatio.toFixed(2)}x`);
    // Absolute sanity: 1x lasts at least as long as the recording did.
    assert.ok(slow1.span >= spanMs * 0.8, `1x playback was too fast: ${slow1.span}ms vs recorded ${spanMs}ms`);
    assert.ok(fast10.wall < slow1.wall / 1.5, `10x (${fast10.wall}ms) should also be faster in wall time than 1x (${slow1.wall}ms)`);
  } finally {
    await close();
  }
});

/* ================================================================== *
 * 4. Fallback engine + controls
 * ================================================================== */

test('page-level replay engine works when trusted input is turned off', async () => {
  const { page, popup, centers, context, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);

    // The extension's own store is the reference: the page log still holds the
    // raw moves that the recorder intentionally throttled away.
    const recordedMoves = (await recordedEvents(context))
      .filter((e) => e.type === 'move')
      .map((e) => [e.x, e.y]);

    await resetPageLog(page);
    await openPlayDialog(popup);
    await configurePlay(popup, { repetitions: 2, speed: 3, trusted: false });
    await confirmPlay(page, popup);
    const terminal = await waitForPagePlayback(page, 4000);
    assert.equal(terminal, 'finished', 'the synthetic replay did not run to its end');
    await waitForPageQuiet(page);

    const { log, boxClicks } = await readPageLog(page);
    assert.ok(log.length > 0, 'synthetic replay delivered nothing');
    assert.equal(boxClicks.a, 2, 'synthetic replay must click A twice for 2 repetitions');
    assert.equal(boxClicks.b, 2, 'synthetic replay must click B twice for 2 repetitions');
    const clicks = log.filter((e) => e.type === 'click');
    NEAR(clicks[0].x, centers.a.x, 2, 'synthetic click x');
    NEAR(clicks[0].y, centers.a.y, 2, 'synthetic click y');

    // The synthetic engine dispatches one DOM event per recorded event, so the
    // whole trail has to survive - no browser coalescing in between.
    const playedMoves = log.filter((e) => e.type === 'mousemove').map((e) => [e.x, e.y]);
    assert.equal(
      playedMoves.filter(([x, y]) => nearestRecorded(recordedMoves, x, y) < 0).length,
      0,
      'synthetic replay invented positions that were never recorded'
    );
    const cov = coverage(playedMoves, recordedMoves);
    if (cov < 0.9) {
      const missed = recordedMoves.filter(
        ([x, y]) => !playedMoves.some((e) => Math.abs(e[0] - x) <= 2 && Math.abs(e[1] - y) <= 2)
      );
      assert.fail(
        `synthetic trail coverage ${(cov * 100).toFixed(0)}% < 90%: ` +
          `${missed.length}/${recordedMoves.length} recorded positions never played, e.g. ` +
          JSON.stringify(missed.slice(0, 8)) + `; played ${playedMoves.length} moves`
      );
    }
  } finally {
    await close();
  }
});

/* ================================================================== *
 * 2b. The click's *default action*: real form controls must change state
 * ================================================================== */

async function controlCenters(page) {
  return {
    chkA: await boxCenter(page, '#chk-a'),
    chkB: await boxCenter(page, '#chk-b-label'),
    radio2: await boxCenter(page, '#radio-2')
  };
}

/** Move to a checkbox, click it, click it again through its <label>, switch a radio. */
async function gestureOverControls(page, c) {
  const m = page.mouse;
  await m.move(40, 40);
  await sleep(80);
  await glide(m, { x: 40, y: 40 }, c.chkA, 5);
  await sleep(130);
  await m.click(c.chkA.x, c.chkA.y);
  await sleep(150);
  await glide(m, c.chkA, c.chkB, 5);
  await sleep(130);
  await m.click(c.chkB.x, c.chkB.y);
  await sleep(150);
  await glide(m, c.chkB, c.radio2, 5);
  await sleep(130);
  await m.click(c.radio2.x, c.radio2.y);
  await sleep(130);
}

const controlState = (page) => page.evaluate(() => window.__emmState());
const resetControls = (page) => page.evaluate(() => window.__emmResetControls());

for (const trusted of [true, false]) {
  const engine = trusted ? 'trusted' : 'synthetic';
  test(`replay performs the click's default action on form controls (${engine} input)`, async () => {
    const { page, popup, close } = await session();
    try {
      const c = await controlCenters(page);

      await startRecording(popup);
      await gestureOverControls(page, c);
      await stopRecording(popup);

      // The recording itself has to have flipped the controls, or we would be
      // testing the fixture instead of the macro.
      assert.deepEqual(await controlState(page), {
        chkA: true,
        chkB: true,
        radio: 'radio-2',
        changes: 3
      });

      // One playback checks them again, two take them back to where they were:
      // every repetition must really perform the browser's default action.
      for (const repetitions of [1, 2]) {
        await resetControls(page);
        await resetPageLog(page);
        await openPlayDialog(popup);
        await configurePlay(popup, { repetitions, speed: 1, trusted });
        await confirmPlay(page, popup);
        await waitForPagePlayback(page, 4000);
        await waitForPageQuiet(page);

        assert.deepEqual(
          await controlState(page),
          {
            chkA: repetitions % 2 === 1,
            chkB: repetitions % 2 === 1,
            radio: 'radio-2',
            // Both checkboxes fire a `change` on every repetition.  The radio
            // fires one: after the first repetition it is already the selected
            // button, and clicking a selected radio is a no-op by spec - which
            // is exactly what real input does, so the macro must too.
            changes: 2 * repetitions + 1
          },
          `${repetitions} playback(s) via ${engine} input must toggle the controls`
        );

        // And the page saw the events that drive the change, at the widget.
        const { log } = await readPageLog(page);
        const onWidget = log.filter((e) => e.type === 'click' && ['chk-a', 'chk-b', 'chk-b-label'].includes(e.target));
        assert.ok(onWidget.length >= repetitions, 'clicks did not land on the controls');
        if (trusted) {
          assert.ok(log.every((e) => e.isTrusted === true), 'trusted replay produced scripted events');
        }
      }
    } finally {
      await close();
    }
  });
}

test('a visible ghost cursor tracks the replay without stealing input', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);

    await resetPageLog(page);
    await openPlayDialog(popup);
    await configurePlay(popup, { repetitions: 2, speed: 1, trusted: false });
    await confirmPlay(page, popup);

    await page.waitForSelector('#emm-ghost-cursor', { timeout: 5_000 });
    const mid = await page.evaluate(() => {
      const c = document.getElementById('emm-ghost-cursor');
      const overlay = document.getElementById('emm-overlay');
      const hit = document.elementFromPoint(
        parseFloat((c.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px/) || [])[1] || 0),
        parseFloat((c.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px/) || [])[2] || 0)
      );
      return {
        display: getComputedStyle(c).display,
        transform: c.style.transform,
        overlayPointerEvents: getComputedStyle(overlay).pointerEvents,
        hitId: hit && hit.id ? hit.id : String(hit && hit.tagName)
      };
    });
    assert.equal(mid.display, 'block', 'ghost cursor must be visible while playing');
    assert.match(mid.transform, /translate\(\d+(\.\d+)?px,\s*\d+(\.\d+)?px\)/, 'ghost cursor must be positioned');
    assert.equal(mid.overlayPointerEvents, 'none', 'the overlay must never intercept the replayed input');
    assert.ok(!/emm-/.test(mid.hitId), `the overlay must not be the hit target, got ${mid.hitId}`);

    await waitForPagePlayback(page, 8000);
    await waitForPageQuiet(page);
    const gone = await page.evaluate(() => !document.getElementById('emm-overlay'));
    assert.ok(gone, 'the overlay must be removed when playback ends');
  } finally {
    await close();
  }
});

test('playback can be stopped and the dialog can be cancelled', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);

    // Cancel first: nothing must be dispatched.
    await resetPageLog(page);
    await openPlayDialog(popup);
    await popup.click('#btn-cancel');
    await popup.waitForSelector('#play-form', { state: 'hidden' });
    await sleep(700);
    assert.equal((await readPageLog(page)).log.length, 0, 'cancel must not start playback');

    // Then start a long replay and interrupt it.
    await resetPageLog(page);
    await openPlayDialog(popup);
    await configurePlay(popup, { repetitions: 40, speed: 1, trusted: false });
    await confirmPlay(page, popup);
    await waitPlaybackStarted(page);
    await sleep(700);
    await popup.click('#btn-stop-play');
    assert.equal(await waitPlaybackFinished(page, 15_000), 'stopped', 'the page must report a stopped playback');
    await waitForPageQuiet(page);
    const first = (await readPageLog(page)).log.length;
    await sleep(1200);
    const second = (await readPageLog(page)).log.length;
    assert.ok(first > 0, 'stopping so early that nothing was replayed is a test artefact');
    assert.equal(second, first, 'events kept arriving after Stop playback');
    await waitForPill(popup, 'Ready');
  } finally {
    await close();
  }
});

test('dialog defaults are 1 repetition at 1x and the inputs are clamped', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);

    await openPlayDialog(popup);
    assert.equal(await popup.inputValue('#repetitions'), '1');
    assert.equal(await popup.inputValue('#speed'), '1');
    assert.equal(await popup.locator('#repetitions-out').textContent(), '1');
    assert.equal(await popup.locator('#speed-out').textContent(), '1×');
    assert.equal(await popup.isChecked('#trusted'), true);

    await setRawValue(popup, '#repetitions', '0');
    assert.equal(await popup.locator('#repetitions-out').textContent(), '1', '0 repetitions must clamp to 1');

    // input[type=number] sanitises junk to "", which must fall back to the default
    await setRawValue(popup, '#repetitions', 'not-a-number');
    assert.equal(await popup.locator('#repetitions-out').textContent(), '1', 'garbage must fall back to 1');

    await setRawValue(popup, '#repetitions', '99999');
    assert.equal(await popup.locator('#repetitions-out').textContent(), '999', 'must clamp to the maximum');

    await setRawValue(popup, '#repetitions', '4');
    assert.equal(await popup.locator('#repetitions-out').textContent(), '4');
    await popup.locator('#speed').evaluate((el) => {
      el.value = '10';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await popup.locator('#speed-out').textContent(), '10×');
    const estimate = await popup.locator('#estimate').textContent();
    assert.match(estimate, /playback/, 'estimate should update');
    await popup.click('#btn-cancel');
  } finally {
    await close();
  }
});

/**
 * Geometry of the popup document.  Chrome sizes an action popup from the
 * document and never grows it, so every view has to fit inside that box - this
 * is what the layout test measures.
 */
const popupGeometry = (popup) =>
  popup.evaluate(() => {
    const rect = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const backdrop = document.getElementById('dialog');
    return {
      boxHeight: Math.round(document.body.getBoundingClientRect().height),
      documentHeight: document.body.scrollHeight,
      backdropPosition: getComputedStyle(backdrop).position,
      backdropOverflowPx: backdrop.scrollHeight - backdrop.clientHeight,
      cancel: rect('#btn-cancel'),
      confirm: rect('#btn-confirm'),
      hints: Array.from(document.querySelectorAll('.shortcuts kbd')).map((k) => ({
        text: k.textContent.trim(),
        bottom: Math.round(k.getBoundingClientRect().bottom)
      }))
    };
  });

test('the popup is sized for every view - the dialog is not cut off', async () => {
  const { page, popup, centers, close } = await session();
  try {
    const idle = await popupGeometry(popup);
    assert.ok(
      idle.documentHeight <= idle.boxHeight + 1,
      `the main view overflows its own popup box: ${idle.documentHeight}px of content in ${idle.boxHeight}px`
    );
    assert.equal(
      idle.backdropPosition,
      'absolute',
      'a position:fixed backdrop is invisible to the popup sizer, so its bottom gets clipped'
    );

    // Both shortcuts are announced next to their buttons, inside the box.
    assert.equal(idle.hints.length, 2, 'both keyboard shortcuts must be shown in the popup');
    for (const hint of idle.hints) {
      assert.match(hint.text, /^(Alt|Ctrl|Command|MacCtrl)\+/, `no real binding is shown for a shortcut: "${hint.text}"`);
      assert.ok(hint.bottom > 0 && hint.bottom <= idle.boxHeight, `shortcut hint is outside the popup: ${hint.bottom} > ${idle.boxHeight}`);
    }

    // Open the dialog the way a user does, then measure the buttons at its bottom.
    await startRecording(popup);
    await page.mouse.click(centers.a.x, centers.a.y);
    await stopRecording(popup);
    await openPlayDialog(popup);

    const open = await popupGeometry(popup);
    assert.ok(open.backdropOverflowPx <= 1, `the dialog needs ${open.backdropOverflowPx}px of scrolling - it does not fit the popup`);
    for (const [name, box] of [
      ['Cancel', open.cancel],
      ['Start playback', open.confirm]
    ]) {
      assert.ok(
        box.height > 0 && box.top >= -0.5 && box.bottom <= open.boxHeight + 0.5,
        `"${name}" is cut off: occupies ${box.top}..${box.bottom} of a ${open.boxHeight}px popup`
      );
    }

    // The tallest main-view state (progress row + footer visible) must fit too.
    await popup.click('#btn-cancel');
    await popup.evaluate(() => {
      document.getElementById('progress-row').hidden = false;
    });
    const busy = await popupGeometry(popup);
    assert.ok(
      busy.documentHeight <= busy.boxHeight + 1,
      `the playing view overflows its popup box: ${busy.documentHeight}px in ${busy.boxHeight}px`
    );
  } finally {
    await close();
  }
});

test('the keyboard shortcuts record, stop recording and cancel a replay', async () => {
  const { page, popup, centers, close } = await session();
  try {
    // Chrome itself has to accept the accelerators: an invalid or already
    // taken suggested_key is dropped silently - the binding Chrome reports
    // must be exactly what the manifest asks for (single source of truth).
    // That covers _execute_action too, and for it the claim *is* the whole
    // feature: Chrome opens the popup itself, so no handler of ours is left to
    // exercise.  It is also the only way to notice a key Chrome quietly
    // declines - Alt+Shift+W came back as an empty binding here, while this one
    // is what makes the key press mean anything.
    const manifest = JSON.parse(readFileSync(join(here, '..', 'extension', 'manifest.json'), 'utf8'));
    const commands = await popup.evaluate(() => chrome.commands.getAll());
    const binding = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
    for (const [name, cmd] of Object.entries(manifest.commands)) {
      const wanted = cmd.suggested_key.default;
      assert.equal(binding[name], wanted, `Chrome dropped or remapped ${name}: asked for "${wanted}", Chrome reports "${binding[name]}"`);
    }

    // The hints in the UI are the bindings Chrome reports, not hardcoded text.
    const shown = await popup.evaluate(() =>
      Array.from(document.querySelectorAll('[data-command]')).map((k) => [k.getAttribute('data-command'), k.textContent.trim()])
    );
    for (const [name, text] of shown) assert.equal(text, binding[name], `#${name} hint says "${text}" but Chrome says "${binding[name]}"`);
    assert.ok(shown.length >= 3, 'every place a shortcut is mentioned must be filled in');

    const tabId = await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tab = tabs.find((t) => (t.url || '').includes('/testpage.html'));
      return tab ? tab.id : null;
    });
    assert.ok(tabId, 'the fixture tab must be reachable');

    // A web page must not be able to pull this lever; only extension pages can.
    // In the page's own world `chrome.runtime` is not exposed at all, and even
    // a sender that reaches the router is refused - either way the command must
    // not fire, so the recorder has to be off right afterwards.
    const refused = await page.evaluate(async () => {
      try {
        return await chrome.runtime.sendMessage({ type: 'emm:command', name: 'emm-toggle-record' });
      } catch (err) {
        return { refused: String(err) };
      }
    });
    assert.ok(!refused || refused.ok !== true, `a page fired a command: ${JSON.stringify(refused)}`);
    assert.match((await pillText(popup)).trim(), /^(Idle|Ready)$/, 'a page message must never start the recorder');

    // The record-toggle accelerator: start recording.
    const started = await popup.evaluate(({ name, tabId }) => chrome.runtime.sendMessage({ type: 'emm:command', name, tabId }), {
      name: 'emm-toggle-record',
      tabId
    });
    assert.equal(started.ok, true, `record shortcut failed: ${JSON.stringify(started)}`);
    await waitForPill(popup, 'Recording');

    await page.mouse.click(centers.a.x, centers.a.y);
    await sleep(140);
    await page.mouse.click(centers.b.x, centers.b.y);
    await sleep(140);

    // The same accelerator again: stop, and keep the recording.
    const stopped = await popup.evaluate(({ name, tabId }) => chrome.runtime.sendMessage({ type: 'emm:command', name, tabId }), {
      name: 'emm-toggle-record',
      tabId
    });
    assert.equal(stopped.ok, true, `stop-recording shortcut failed: ${JSON.stringify(stopped)}`);
    await waitForPill(popup, 'Ready');
    const counters = await popup.evaluate(() => ({
      events: Number(document.getElementById('m-events').textContent.replace(/\D/g, '')),
      clicks: Number(document.getElementById('m-clicks').textContent.replace(/\D/g, ''))
    }));
    assert.ok(counters.clicks >= 2, `the shortcut recorded no clicks: ${JSON.stringify(counters)}`);
    assert.ok(counters.events >= 4, `the shortcut recorded too little: ${JSON.stringify(counters)}`);

    // A long replay, cancelled with Alt+Shift+S.
    await openPlayDialog(popup);
    await configurePlay(popup, { repetitions: 60, speed: 1, trusted: true });
    await confirmPlay(page, popup);
    await waitPlaybackStarted(page);

    const cancelled = await popup.evaluate(({ name, tabId }) => chrome.runtime.sendMessage({ type: 'emm:command', name, tabId }), {
      name: 'emm-stop-playback',
      tabId
    });
    assert.equal(cancelled.ok, true, `stop-playback shortcut failed: ${JSON.stringify(cancelled)}`);
    assert.equal(await waitPlaybackFinished(page, 15_000), 'stopped', 'the page must report a stopped playback');

    // Nothing arrives afterwards, the badge is cleared and the recording stays.
    await waitForPageQuiet(page);
    const first = (await readPageLog(page)).log.length;
    await sleep(900);
    assert.equal((await readPageLog(page)).log.length, first, 'events kept arriving after the shortcut stopped playback');
    assert.ok(first > 0, 'the replay never reached the page (test artefact)');
    const badge = await popup.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
    assert.equal(badge, '', 'the RUN badge survived the shortcut stop');
    await waitForPill(popup, 'Ready');
    assert.equal(await popup.locator('#btn-play').isDisabled(), false, 'the recording must survive the shortcut stop');
  } finally {
    await close();
  }
});

test('clearing the recording disables Play again', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);
    assert.equal(await popup.locator('#btn-play').isDisabled(), false);
    await popup.click('#btn-clear');
    await popup.waitForFunction(() => document.getElementById('m-events').textContent === '0');
    assert.equal(await popup.locator('#btn-play').isDisabled(), true);
    assert.equal(await pillText(popup), 'Idle');
  } finally {
    await close();
  }
});

test('replay lands on the same document position after the page scrolled away', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    await page.mouse.click(centers.a.x, centers.a.y);
    await sleep(120);
    await page.mouse.click(centers.b.x, centers.b.y);
    await stopRecording(popup);

    // Scroll the page far away, then replay: the macro must undo the scroll so
    // the coordinates still hit the same elements.
    await page.evaluate(() => window.scrollTo(0, 900));
    await sleep(200);
    assert.ok((await page.evaluate(() => window.scrollY)) > 500, 'fixture did not scroll');

    await resetPageLog(page);
    await openPlayDialog(popup);
    await configurePlay(popup, { repetitions: 1, speed: 2, trusted: false });
    await confirmPlay(page, popup);
    await waitForPagePlayback(page, 4000);
    await waitForPageQuiet(page);

    const { boxClicks } = await readPageLog(page);
    assert.equal(boxClicks.a, 1, 'A must still receive its click after scrolling');
    assert.equal(boxClicks.b, 1, 'B must still receive its click after scrolling');
  } finally {
    await close();
  }
});

/**
 * The whole point of recording the wheel: a list you have to scroll to work
 * through must still work through on replay.  Recorded once, replayed through
 * both engines.
 */
for (const trusted of [true, false]) {
  const engine = trusted ? 'trusted' : 'synthetic';
  test(`a replayed wheel scrolls its container and ticks all 62 checkboxes (${engine})`, async () => {
    const { page, popup, close } = await session();
    try {
      await instrumentPanel(page);
      const fresh = await panelState(page);
      assert.equal(fresh.total, 62, 'the fixture lost its 62 checkboxes');
      assert.equal(fresh.checked, 0, 'the fixture should start with nothing ticked');
      assert.equal(fresh.open, false, 'the details block should start closed');

      await startRecording(popup);
      const gesture = await tickEveryCheckbox(page);
      assert.ok(gesture.wheels >= 5, `the gesture barely used the wheel (${gesture.wheels})`);
      assert.deepEqual(
        gesture.misses,
        [],
        `the recorded gesture clicked past these rows: ${JSON.stringify(gesture.misses)}`
      );
      await stopRecording(popup);
      await waitForScrollSettled(page);

      const recorded = await panelState(page);
      assert.ok(recorded.scrollable > 100, `the panel never became scrollable (${recorded.scrollable}px)`);
      assert.equal(recorded.checked, 62, 'the recorded gesture itself missed a checkbox');
      assert.ok(recorded.scrollTop > 50, 'the wheel never scrolled the container');

      // The recording has to carry the wheel itself, not just the clicks.
      const events = await recordedEvents(app.ctx.context);
      const wheels = events.filter((e) => e.type === 'wheel');
      assert.ok(wheels.length >= 5, `the recording kept only ${wheels.length} wheel events`);
      assert.ok(
        wheels.every((e) => Number.isFinite(e.dy) && e.dy !== 0),
        'a recorded wheel lost its delta'
      );
      assert.ok(
        wheels.every((e) => Array.isArray(e.sc) && e.sc.length >= 1),
        'a recorded wheel lost the scroll container it belongs to'
      );

      // Back to the exact starting state, so a replay has to earn everything.
      await page.evaluate(() => window.__emmPanelReset());
      await waitForScrollSettled(page);
      const before = await panelState(page);
      assert.deepEqual(
        { open: before.open, checked: before.checked, scrollTop: before.scrollTop },
        { open: false, checked: 0, scrollTop: 0 },
        'the reset did not restore the starting state'
      );

      await resetPageLog(page);
      await openPlayDialog(popup);
      await configurePlay(popup, { repetitions: 1, speed: 2, trusted });
      await confirmPlay(page, popup);
      assert.equal(await waitPlaybackFinished(page, 120_000), 'finished');
      await waitForPageQuiet(page);
      await waitForScrollSettled(page);

      // The guarantee this recording is entitled to: trusted input hands a
      // recording that scrolls content to the page one event at a time, so no
      // click can be hit-tested against content a later wheel already moved.
      // Asserted from the page, because nothing else about a finished replay
      // says which of the two lanes it took.
      assert.equal(
        await playSequenced(page),
        trusted,
        trusted
          ? 'a trusted recording that scrolls was not replayed one event at a time'
          : 'the synthetic engine applies its events synchronously, no sequence needed'
      );

      const after = await panelState(page);
      assert.ok(after.open, 'the replayed click did not open the details block again');
      assert.equal(
        after.checked,
        after.total,
        `the replay ticked only ${after.checked} of ${after.total} checkboxes`
      );
      // One wheel notch of slack: Chrome batches trusted wheel events into the
      // scroll it applies, so a replay can legitimately land a notch away from
      // where the recorded hand happened to stop.
      NEAR(after.scrollTop, recorded.scrollTop, 20, 'the container ended at the wrong offset');
      // And the wheel really arrived in the page, in its own container.
      const seen = await page.evaluate(() => window.__emmWheels);
      assert.equal(
        seen.filter((w) => w.inPanel).length,
        wheels.length,
        `the replay delivered ${seen.length} wheels, of which ` +
          `${seen.filter((w) => w.inPanel).length} reached the container (${wheels.length} recorded)`
      );
      assert.equal(
        seen.every((w) => w.trusted),
        trusted,
        `replay claimed "${engine}" but the page saw isTrusted=${seen[0] && seen[0].trusted}`
      );
    } finally {
      await close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Keyboard: the TAB and SPACE keys
 * ------------------------------------------------------------------ */

/** Where the focus sits and what the keys have pressed so far. */
async function keyState(page) {
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    const boxes = [...panel.querySelectorAll('input[type="checkbox"]')];
    const active = document.activeElement;
    const at = boxes.indexOf(active);
    return {
      active: at >= 0 ? `panel-${at}` : active.id || active.tagName.toLowerCase(),
      open: panel.querySelector('details').open,
      panelChecked: boxes.filter((b) => b.checked).length,
      chkB: document.getElementById('chk-b').checked,
      radio1: document.getElementById('radio-1').checked,
      radio2: document.getElementById('radio-2').checked
    };
  }, PANEL);
}

const KEY_IDLE = {
  active: 'chk-a',
  open: false,
  panelChecked: 0,
  chkB: false,
  radio1: true,
  radio2: false
};

/** The page as it stood before a single key was pressed. */
async function keyReset(page) {
  await page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    panel.querySelector('details').open = false;
    panel.scrollTop = 0;
    for (const box of panel.querySelectorAll('input[type="checkbox"]')) box.checked = false;
    for (const id of ['chk-a', 'chk-b']) document.getElementById(id).checked = false;
    document.getElementById('radio-1').checked = true;
    document.getElementById('radio-2').checked = false;
    document.getElementById('chk-a').focus();
  }, PANEL);
}

/**
 * Tab across the fixture and press Space wherever it does something.
 *
 * The order is the fixture's own, and one detail of it belongs to Chrome rather
 * than to the page: the two same-named radio buttons are a single Tab stop, so
 * Tab arrives at the checked one and leaves the group again - the other radio is
 * an arrow key away, and the arrow keys are not something this recorder offers.
 * The model list is closed to start with, which makes the Space on its summary
 * the thing that hands the following Tabs their checkboxes.
 */
async function pressAround(page) {
  // A key only traverses focus in the tab the browser considers active, and the
  // popup tab has just been clicked.
  await page.bringToFront();
  const press = async (key) => {
    await page.keyboard.press(key);
    await sleep(150);
  };
  await press('Tab'); //       chk-a -> chk-b
  await press('Space'); //     chk-b takes the tick
  await press('Tab'); //       -> the radio group, at its checked button
  await press('Tab'); //       -> the summary of the model list
  await press('Space'); //     opens it
  await press('Tab'); //       -> the first model checkbox
  await press('Space'); //     ticks it
  await press('Tab'); //       -> the second one
  await press('Space'); //     ticks that one too
  await press('Shift+Tab'); // back to the first
  await press('Space'); //     and takes its tick back off
  await sleep(250);
}

const PRESSED = {
  active: 'panel-0',
  open: true,
  panelChecked: 1,
  chkB: true,
  radio1: true,
  radio2: false
};

const PRESSED_KEYS = [
  'Tab',
  'Space',
  'Tab',
  'Tab',
  'Space',
  'Tab',
  'Space',
  'Tab',
  'Space',
  'Tab+shift',
  'Space'
];

for (const trusted of [true, false]) {
  const engine = trusted ? 'trusted' : 'synthetic';
  test(`a replayed TAB walks the focus and a replayed SPACE presses it (${engine})`, async () => {
    const { page, popup, close } = await session();
    try {
      await keyReset(page);
      assert.deepEqual(await keyState(page), KEY_IDLE, 'the fixture did not start where this test expects');

      await startRecording(popup);
      await pressAround(page);
      await stopRecording(popup);
      await sleep(200);

      const recorded = await keyState(page);
      assert.deepEqual(recorded, PRESSED, 'the keys themselves did not do what they should');

      const events = await recordedEvents(app.ctx.context);
      const keys = events.filter((e) => e.type === 'key');
      assert.deepEqual(
        keys.map((k) => `${k.k}${k.sk ? '+shift' : ''}`),
        PRESSED_KEYS,
        'the recording did not keep the keys, in order, with the shift modifier'
      );
      // The click Chrome fires to perform a Space activation belongs to that
      // press.  Recorded as a click of its own it would replay as a click on the
      // top-left pixel of the viewport, where nobody pointed - and a press and
      // release would follow it, since that is what a recorded click means.
      assert.deepEqual(
        events
          .filter((e) => e.type === 'click' || e.type === 'down' || e.type === 'up')
          .map((e) => `${e.type}@${e.x},${e.y}`),
        [],
        'a key press leaked a mouse button event of its own into the recording'
      );
      // Everything else the recording holds is the keys and whatever mouse move
      // the page asked for as its content moved under the pointer - a hover
      // update, not a gesture.

      await keyReset(page);
      assert.deepEqual(await keyState(page), KEY_IDLE, 'the reset did not put the page back');

      await resetPageLog(page);
      await openPlayDialog(popup);
      await configurePlay(popup, { repetitions: 1, speed: 2, trusted });
      await confirmPlay(page, popup);
      // Same as above: the replay dispatches keys, and keys act in the tab that
      // the browser treats as the one being looked at.
      await page.bringToFront();
      assert.equal(await waitPlaybackFinished(page, 120_000), 'finished');
      await waitForPageQuiet(page);

      // A recording that carries keys is handed to the page one event at a time:
      // every Tab depends on the focus the previous event left behind.
      assert.equal(
        await playSequenced(page),
        trusted,
        trusted
          ? 'a trusted recording with keys was not replayed one event at a time'
          : 'the synthetic engine applies its events synchronously, no sequence needed'
      );

      assert.deepEqual(await keyState(page), PRESSED, `the ${engine} replay did not reproduce the keys`);
    } finally {
      await close();
    }
  });
}

test('recording is scoped to one tab and a navigation resets it', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await startRecording(popup);
    await performGesture(page, centers);
    await stopRecording(popup);
    const events = Number(await popup.locator('#m-events').textContent());
    assert.ok(events > 0);

    // Navigating the recorded tab wipes the page-side recorder; the popup must
    // fall back to Idle instead of lying about "Recording".
    await page.goto(app.ctx.server.url('/testpage.html?again=1'));
    await waitForContentScript(page);
    await sleep(600);
    await page.mouse.click(centers.a.x, centers.a.y);
    await sleep(400);
    const pill = await pillText(popup);
    assert.notEqual(pill, 'Recording', 'popup still claims to be recording after a navigation');
  } finally {
    await close();
  }
});

/* ------------------------------------------------------------------ *
 * History: the last few finished macros, replayable wherever the user wants
 * ------------------------------------------------------------------ */

/** The rows as the popup draws them, with the mark on the loaded one. */
async function historyRows(popup) {
  return popup.evaluate(() =>
    [...document.querySelectorAll('#history-list .history-item')].map((li) => {
      const row = li.querySelector('.history-row');
      const field = li.querySelector('.history-name');
      // A name takes the row's label slot, so one selector covers both states.
      const label = field || li.querySelector('.history-host');
      return {
        id: li.dataset.id,
        current: li.classList.contains('is-current'),
        count: row ? row.querySelector('.history-count').textContent : '',
        detail: row ? row.title : '',
        busy: row ? row.disabled : false,
        label: label ? (field ? field.value : label.textContent) : '',
        renaming: Boolean(field)
      };
    })
  );
}

/** The cap the user actually chose, as the popup currently holds it. */
const historyLimit = (popup) => popup.locator('#history-limit').inputValue();

const metricInt = async (popup, id) =>
  Number((await popup.locator(`#${id}`).textContent()).replace(/[^0-9]/g, ''));

async function clickHistoryRow(popup, index, { del = false } = {}) {
  await popup
    .locator('#history-list .history-item')
    .nth(index)
    .locator(del ? '.history-del' : '.history-row')
    .click();
  // One popup refresh, so the assertions below look at a settled view.
  await sleep(600);
}

/** Record exactly one click on one box: a macro the page can identify later. */
async function recordOneClick(popup, page, center) {
  await startRecording(popup);
  await glide(page.mouse, { x: 30, y: 30 }, center, 5);
  await page.mouse.click(center.x, center.y);
  await sleep(120);
  await stopRecording(popup);
}

test('finished macros are kept in the history and replay in the tab you choose', async () => {
  const { page, popup, centers, context, close } = await session();
  try {
    // Other tests record macros too, and the history is deliberately the one
    // thing in this extension that survives them, so everything below counts
    // relative to what was already stored rather than assuming an empty list.
    const base = (await historyRows(popup)).length;

    // Two macros a single box apart: "the right macro in the right tab" is then
    // something the page can testify to, not a count that happens to fit.
    await recordOneClick(popup, page, centers.a);
    const macroA = await metricInt(popup, 'm-events');
    await recordOneClick(popup, page, centers.b);
    const macroB = await metricInt(popup, 'm-events');
    assert.ok(macroA > 0 && macroB > 0);

    // Other tests record macros too, so the store may well be full by now: what
    // is promised is that the two macros just finished sit on top, and that the
    // list never grows past its cap - which is what pushes the oldest out.
    const cap = Number(await historyLimit(popup));
    let rows = await historyRows(popup);
    assert.equal(
      rows.length,
      Math.min(base + 2, cap),
      `two finished macros should be in the history, which held ${base} before`
    );
    assert.ok(rows.length <= cap, `the history outgrew its cap: ${rows.length} > ${cap}`);
    assert.equal(rows[0].count.split(' ')[0], String(macroB), 'the newest macro must be on top');
    assert.equal(rows[1].count.split(' ')[0], String(macroA));
    assert.match(rows[0].detail, /recorded on .*testpage|recorded on \d+\.\d+\.\d+\.\d+/, `a row should say where it came from: ${rows[0].detail}`);

    // The recording itself clicked those boxes in this tab, so its log has to
    // start clean or "the replay did not touch this tab" proves nothing.
    await resetPageLog(page);

    // A second tab, and the macro is picked up there - the history is not tied
    // to the tab that made it, which is the whole point of keeping it.
    const other = await context.newPage();
    await other.goto(app.ctx.server.url('/testpage.html?tab=two'));
    await other.waitForLoadState('load');
    await waitForContentScript(other);
    await other.bringToFront();
    await sleep(400);

    await clickHistoryRow(popup, 1); // the older macro: the one that clicked box A
    assert.equal(await metricInt(popup, 'm-events'), macroA, 'picking a row must load that macro');
    assert.equal((await historyRows(popup)).filter((r) => r.current).length, 1, 'exactly one row is marked as loaded');

    await resetPageLog(other);
    await openPlayDialog(popup);
    await confirmPlay(other, popup);
    await waitPlaybackFinished(other);
    await waitForPageQuiet(other);
    const replayA = await readPageLog(other);
    assert.equal(replayA.boxClicks.a, 1, `the loaded macro should click box A once, got ${JSON.stringify(replayA.boxClicks)}`);
    assert.equal(replayA.boxClicks.b, 0, 'the other macro must not have been replayed');
    assert.equal((await readPageLog(page)).boxClicks.a, 0, 'the replay belongs to the tab the user is looking at');

    // The other macro, same tab: the rows really are separate macros.
    await resetPageLog(other);
    await clickHistoryRow(popup, 0);
    assert.equal(await metricInt(popup, 'm-events'), macroB);
    await openPlayDialog(popup);
    await confirmPlay(other, popup);
    await waitPlaybackFinished(other);
    await waitForPageQuiet(other);
    const replayB = await readPageLog(other);
    assert.equal(replayB.boxClicks.b, 1, `the other macro clicks box B, got ${JSON.stringify(replayB.boxClicks)}`);
    assert.equal(replayB.boxClicks.a, 0);

    // Forgetting the macro that is loaded leaves the loaded copy alone: the row
    // is the store, the tab already has what it is going to replay.
    const beforeDelete = (await historyRows(popup)).length;
    const forgotten = (await historyRows(popup)).find((r) => r.current).id;
    await clickHistoryRow(popup, 0, { del: true });
    const afterDelete = await historyRows(popup);
    assert.equal(afterDelete.length, beforeDelete - 1, 'forgetting one macro removes exactly one row');
    assert.ok(!afterDelete.some((r) => r.id === forgotten), 'the forgotten macro must be gone from the list');
    assert.equal(await metricInt(popup, 'm-events'), macroB, 'forgetting a macro must not eat the recording in hand');
    assert.equal(afterDelete.filter((r) => r.current).length, 0, 'a row that is gone cannot still be marked loaded');

    // Clearing the recording leaves the history; clearing the history is the one
    // thing that empties it.
    await popup.click('#btn-clear');
    await sleep(600);
    assert.equal((await historyRows(popup)).length, afterDelete.length, 'Clear recording is not Clear history');
    assert.equal(await popup.locator('#btn-play').isDisabled(), true, 'Play must go dead with the recording');

    await popup.click('#btn-clear-history');
    await sleep(600);
    assert.equal((await historyRows(popup)).length, 0, 'Clear history must empty the list');
    assert.equal(await popup.locator('#history-empty').isVisible(), true, 'an empty history should say what fills it');

    await other.close();
  } finally {
    await close();
  }
});

test('the history outlives the browser; a tab\'s working recording does not', async () => {
  // A second Chrome on the same profile is the only honest way to ask what
  // survives a restart: chrome.storage.session is memory, and this test is
  // precisely about the difference.
  const dir = await mkdtemp(join(tmpdir(), 'emm-history-profile-'));
  let first = null;
  let second = null;
  try {
    first = await launchWithExtension({ userDataDir: dir });
    const page = await first.context.newPage();
    await page.goto(first.server.url('/testpage.html'));
    await page.waitForLoadState('load');
    await waitForContentScript(page);
    const popup = await openPopup(first.context, `chrome-extension://${first.extensionId}`);
    await startRecording(popup);
    await page.mouse.click(140, 140);
    await sleep(120);
    await stopRecording(popup);
    const events = await metricInt(popup, 'm-events');
    assert.ok(events > 0, 'the gesture has to be recorded before it can be kept');
    assert.equal((await historyRows(popup)).length, 1);
    await popup.close();
    await page.close();
    await first.close();
    first = null;

    second = await launchWithExtension({ userDataDir: dir });
    const popup2 = await openPopup(second.context, `chrome-extension://${second.extensionId}`);
    // No web tab is open in this session yet: the rows come from disk, and the
    // popup shows them whether or not there is anything to replay on.
    await waitFor(async () => (await historyRows(popup2)).length === 1, {
      label: 'the history after a browser restart'
    });
    const rows = await historyRows(popup2);
    assert.equal(rows[0].count.split(' ')[0], String(events), 'the macro came back whole');
    assert.match(rows[0].detail, /recorded on /);

    // Delete it, and watch the list really go empty: a leftover painting cannot
    // be forgotten.
    await clickHistoryRow(popup2, 0, { del: true });
    assert.equal((await historyRows(popup2)).length, 0);
    await popup2.close();
  } finally {
    if (first) await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a recording a link navigates away is saved, not thrown away', async () => {
  // The recorder lives in the page and a navigation destroys that page. What the
  // user clicked is still theirs: the recording ends, and it goes into the
  // history like any other finished macro.
  const { page, popup, centers, close } = await session();
  try {
    const base = (await historyRows(popup)).length;
    await resetPageLog(page);

    // A link in the page, followed with the mouse. The fixture stays untouched:
    // a query on the same file is a real navigation to the same layout, so the
    // recorded coordinates still mean the same boxes afterwards.
    const href = new URL(page.url());
    href.searchParams.set('page', 'two');
    await page.evaluate((target) => {
      const a = document.createElement('a');
      a.id = 'jump-link';
      a.href = target;
      a.textContent = 'Go on';
      a.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;padding:8px;background:#fff';
      document.body.appendChild(a);
    }, href.href);

    await startRecording(popup);
    await glide(page.mouse, { x: 30, y: 30 }, centers.a, 5);
    await page.mouse.click(centers.a.x, centers.a.y);
    // Longer than the handover interval, so part of the buffer is already with
    // the worker before the link is followed. The rest has to go with the page.
    await sleep(700);
    await page.click('#jump-link');
    await page.waitForURL(/page=two/);

    await waitForPill(popup, 'Ready', 8_000);
    const rows = await waitFor(
      async () => {
        const list = await historyRows(popup);
        return list.length > base ? list : null;
      },
      { label: 'the recording to be filed in the history' }
    );
    assert.equal(rows.length, base + 1, 'one navigation saves exactly one macro');

    const events = await metricInt(popup, 'm-events');
    assert.ok(events >= 2, `the navigation must keep the moves and the click, got ${events}`);
    assert.equal(parseInt(rows[0].count, 10), events, 'the stored macro is the recording in hand');
    assert.match(rows[0].detail, /recorded on /);
    // A row is marked loaded when it is picked from the list; a recording that
    // just ended is in the tab because it was made there.
    assert.equal(rows[0].current, false, 'the mark is for a loaded macro, not one still in hand');
    assert.match(await popup.locator('#hint').textContent(), /saved in the history/);

    // And it is a macro, not a memory: it replays on the page that replaced the
    // one it was recorded on.
    await resetPageLog(page);
    await openPlayDialog(popup);
    await confirmPlay(page, popup);
    await waitPlaybackFinished(page);
    await waitForPageQuiet(page);
    const log = await readPageLog(page);
    assert.equal(log.boxClicks.a, 1, `the saved macro replays its click, got ${JSON.stringify(log.boxClicks)}`);
    assert.equal(log.boxClicks.b, 0);
  } finally {
    await close();
  }
});

test('a history entry can be named, and how many are kept is a setting', async () => {
  const { page, popup, centers, close } = await session();
  try {
    await recordOneClick(popup, page, centers.a);
    await recordOneClick(popup, page, centers.b);
    const rows = await historyRows(popup);
    assert.ok(rows.length >= 2, 'two macros finished, two rows to name');
    // Until the user names one, where it came from is the best label there is.
    assert.ok(rows[0].label.length > 0, 'an unnamed row says where the macro was recorded');

    const name = 'weekly checkout run';
    await popup.locator('#history-list .history-item').nth(0).locator('.history-rename').click();
    await waitFor(() => historyRows(popup).then((r) => r[0].renaming), { label: 'the name field to open' });
    assert.equal((await historyRows(popup))[0].id, rows[0].id, 'the editor opens on the row it names');
    await popup.keyboard.type(name);
    await popup.keyboard.press('Enter');
    await sleep(600);

    const named = await historyRows(popup);
    assert.equal(named[0].label, name, 'the name takes the row\u0027s label slot');
    assert.equal(named[0].id, rows[0].id, 'naming is not a copy: the macro stays where it was');
    assert.equal(named[0].count, rows[0].count, 'and it stays the same macro');
    assert.equal(named.filter((r) => r.label === name).length, 1, 'only the row named, not the macro renamed twice');

    // A reopened popup reads from storage, so a name that only lived in the
    // view would be missing here.
    await popup.reload();
    await popup.waitForSelector('#btn-record');
    await sleep(700);
    assert.equal((await historyRows(popup))[0].label, name, 'the name is stored with the macro');

    // An empty name is the default label back again - undoing a rename is
    // possible, which an empty field would otherwise not be.
    const unnamed = rows[0].label;
    await popup.locator('#history-list .history-item').nth(0).locator('.history-rename').click();
    await waitFor(() => historyRows(popup).then((r) => r[0].renaming), { label: 'the name field to open again' });
    await popup.keyboard.press('Control+a');
    await popup.keyboard.press('Delete');
    await popup.keyboard.press('Enter');
    await sleep(600);
    assert.equal((await historyRows(popup))[0].label, unnamed, 'clearing a name falls back to the recorded host');

    // The cap: offered from core, chosen by the user, and enforced at once.
    const choices = await popup.locator('#history-limit').evaluate((sel) => [...sel.options].map((o) => Number(o.value)));
    assert.deepEqual(choices, core.LIMITS.HISTORY_CHOICES.slice().sort((x, y) => x - y), 'the offers must be the ones core publishes');
    assert.equal(choices.includes(core.LIMITS.MAX_HISTORY), true, 'the default has to be one of the offers');

    await popup.locator('#history-limit').selectOption('5');
    await sleep(700);
    assert.equal(await historyLimit(popup), '5', 'the popup must show the cap that is in force');
    const kept = await historyRows(popup);
    assert.ok(kept.length <= 5, `a cap of 5 left ${kept.length} macros stored`);
    assert.equal(kept.length, Math.min(rows.length, 5), 'lowering the cap drops the oldest, not everything');
    assert.equal(kept[0].count, rows[0].count, 'the newest macro survives a trim');
    assert.match(await popup.locator('#history-empty').textContent(), /last 5 are kept|Finished recordings/, 'the empty sentence is cap-aware');
  } finally {
    // The cap is durable storage: a run that stops midway would otherwise leave
    // every later test looking at a five-deep history.
    try {
      await popup.locator('#history-limit').selectOption(String(core.LIMITS.MAX_HISTORY));
      await sleep(400);
    } catch {
      /* the popup is gone; nothing left to restore */
    }
    await close();
  }
});

test('the extension never logs errors in the service worker', async () => {
  assert.deepEqual(app.ctx.workerErrors, [], 'unexpected service worker errors');
});

test('viewport used by the suite is large enough for the fixture', async () => {
  const { page, close } = await session();
  try {
    const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    assert.ok(size.w >= VIEWPORT.width - 40 && size.h >= 500, `unexpected viewport ${JSON.stringify(size)}`);
  } finally {
    await close();
  }
});
