import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = require(join(here, '..', 'extension', 'lib', 'macro-core.js'));

const root = join(here, '..', 'extension');

const ev = (t, type = 'move', extra = {}) => ({
  t,
  type,
  x: 10,
  y: 20,
  px: 10,
  py: 20,
  sx: 0,
  sy: 0,
  button: 0,
  buttons: 0,
  detail: 0,
  ...extra
});

const approx = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message || ''} expected ~${expected}, got ${actual}`);

test('core is pure and exposes its whole surface', () => {
  for (const fn of [
    'clampRepetitions',
    'clampSpeed',
    'wheelPixels',
    'normalizeWheel',
    'isIdleWheel',
    'normalizeScrollChain',
    'makeEvent',
    'shouldCaptureMove',
    'isKeyPressActivation',
    'isDuplicateActivation',
    'pushEvent',
    'normalizeEvents',
    'delayScale',
    'buildSchedule',
    'scheduleDuration',
    'summarize',
    'replayPoint',
    'normalizeKey',
    'keySpec',
    'toCdpParams',
    'toCdpKeyCommands',
    'formatDuration',
    'formatCount',
    'addHistoryEntry',
    'removeHistoryEntry',
    'normalizeHistory',
    'historyRows',
    'historyEvents',
    'setHistoryName',
    'normalizeLimit',
    'normalizeName'
  ]) {
    assert.equal(typeof core[fn], 'function', `${fn} must exist`);
  }
});

/* ---------------- repetitions / speed validation ---------------- */

test('clampRepetitions matches the dialog contract (default 1)', () => {
  assert.equal(core.clampRepetitions(undefined), 1);
  assert.equal(core.clampRepetitions(null), 1);
  assert.equal(core.clampRepetitions(''), 1);
  assert.equal(core.clampRepetitions('7'), 7);
  assert.equal(core.clampRepetitions(3), 3);
  assert.equal(core.clampRepetitions(2.6), 3);
  assert.equal(core.clampRepetitions(0), 1);
  assert.equal(core.clampRepetitions(-5), 1);
  assert.equal(core.clampRepetitions(100000), core.LIMITS.MAX_REPETITIONS);
  assert.equal(core.clampRepetitions('abc'), 1);
  assert.equal(core.clampRepetitions(NaN), 1);
  assert.equal(core.clampRepetitions(Infinity), 1, 'non-finite input must fall back, not explode');
});

test('clampSpeed keeps the macro between 1x and 10x, defaulting to 1x', () => {
  assert.equal(core.clampSpeed(undefined), 1);
  assert.equal(core.clampSpeed('1'), 1);
  assert.equal(core.clampSpeed('10'), 10);
  assert.equal(core.clampSpeed(4), 4);
  assert.equal(core.clampSpeed(2.5), 2.5);
  assert.equal(core.clampSpeed(0), 1, '0x must not mean "instant"');
  assert.equal(core.clampSpeed(-1), 1);
  assert.equal(core.clampSpeed(11), 1, 'out of range falls back to 1x');
  assert.equal(core.clampSpeed('nope'), 1);
});

test('delayScale inverts the speed multiplier', () => {
  assert.equal(core.delayScale(1), 1);
  assert.equal(core.delayScale(2), 0.5);
  assert.equal(core.delayScale(4), 0.25);
  assert.equal(core.delayScale(10), 0.1);
});

/* ---------------- schedule building ---------------- */

test('buildSchedule: defaults are one repetition at recorded speed', () => {
  const events = [ev(0), ev(100, 'down'), ev(150, 'up'), ev(400)];
  const schedule = core.buildSchedule(events, {});
  assert.equal(schedule.length, events.length);
  assert.equal(schedule[0].event.type, 'move');
  assert.equal(schedule[0].repetition, 1);
  // lead-in 350ms, then the recorded inter-event gaps unchanged
  assert.equal(schedule[0].at, 350);
  assert.equal(schedule[1].at, 450);
  assert.equal(schedule[2].at, 500);
  assert.equal(schedule[3].at, 750);
});

test('buildSchedule: repetitions multiply the event count and label them', () => {
  const events = [ev(0), ev(100, 'click')];
  const schedule = core.buildSchedule(events, { repetitions: 4, interRepetitionMs: 400 });
  assert.equal(schedule.length, 8);
  assert.deepEqual(
    schedule.map((s) => s.repetition),
    [1, 1, 2, 2, 3, 3, 4, 4]
  );
  // second repetition starts after the first one's duration + the gap
  assert.equal(schedule[2].at, 350 + 100 + 400);
  assert.equal(schedule[3].at, 350 + 100 + 400 + 100);
});

test('buildSchedule: speed compresses the whole plan proportionally', () => {
  const events = [ev(0), ev(1000, 'click')];
  const one = core.buildSchedule(events, { repetitions: 1, speed: 1, interRepetitionMs: 0, leadInMs: 0 });
  const ten = core.buildSchedule(events, { repetitions: 1, speed: 10, interRepetitionMs: 0, leadInMs: 0 });
  approx(core.scheduleDuration(one), 1000, '1x length');
  approx(core.scheduleDuration(ten), 100, '10x length');
  const fiveReps = core.buildSchedule(events, { repetitions: 5, speed: 5, interRepetitionMs: 500, leadInMs: 0 });
  // 5 * 1000ms of recording + 4 * 500ms of gap, all divided by 5.
  approx(core.scheduleDuration(fiveReps), (1000 * 5 + 500 * 4) / 5, '5 reps at 5x');
});

test('buildSchedule: schedule is monotonically non-decreasing for any input', () => {
  const events = [];
  for (let i = 0; i < 200; i++) events.push(ev(i % 7 === 0 ? 5000 - i : i * 3, i % 5 === 0 ? 'click' : 'move'));
  for (const speed of [1, 1.5, 3, 7.5, 10]) {
    for (const reps of [1, 2, 13]) {
      const schedule = core.buildSchedule(events, { repetitions: reps, speed });
      assert.equal(schedule.length, events.length * reps);
      for (let i = 1; i < schedule.length; i++) {
        assert.ok(schedule[i].at >= schedule[i - 1].at, `regression at speed ${speed}, rep ${reps}, index ${i}`);
      }
    }
  }
});

test('buildSchedule: empty or garbage input yields an empty plan', () => {
  assert.deepEqual(core.buildSchedule([], {}), []);
  assert.deepEqual(core.buildSchedule(null, { repetitions: 3 }), []);
  assert.deepEqual(core.buildSchedule(undefined, {}), []);
  assert.equal(core.scheduleDuration([]), 0);
  assert.equal(core.scheduleDuration(null), 0);
});

test('popup estimate formula equals the real scheduler output', () => {
  // The popup estimates the playback length from a two-point stand-in.
  const durationMs = 4200;
  const estimate = core.scheduleDuration(
    core.buildSchedule(
      [ev(0), ev(durationMs)],
      { repetitions: 3, speed: 2, interRepetitionMs: 400, leadInMs: 350 }
    )
  );
  const events = [];
  for (let i = 0; i < 50; i++) events.push(ev((i / 49) * durationMs));
  const real = core.scheduleDuration(
    core.buildSchedule(events, { repetitions: 3, speed: 2, interRepetitionMs: 400, leadInMs: 350 })
  );
  assert.equal(estimate, real);
});

/* ---------------- recording helpers ---------------- */

test('shouldCaptureMove throttles jitter but keeps real motion and pauses', () => {
  const prev = { t: 0, x: 100, y: 100 };
  assert.equal(core.shouldCaptureMove(null, 0, 0, 0), true, 'first move always kept');
  assert.equal(core.shouldCaptureMove(prev, 100, 100, 5), false, 'too soon');
  assert.equal(core.shouldCaptureMove(prev, 100, 101, 40), false, 'below min distance');
  assert.equal(core.shouldCaptureMove(prev, 110, 100, 40), true, 'moved far enough');
  assert.equal(core.shouldCaptureMove(prev, 100, 100, 200), true, 'a long pause is content');
});

test('makeEvent normalises coordinates and rejects unknown types', () => {
  const e = core.makeEvent('down', 12.4, {
    clientX: 10.005,
    clientY: 20,
    pageX: 110,
    pageY: 120,
    scrollX: 100,
    scrollY: 100,
    button: 0,
    buttons: 1,
    detail: 1,
    innerWidth: 1280,
    innerHeight: 720
  });
  assert.equal(e.t, 12.4);
  assert.equal(e.type, 'down');
  assert.equal(e.x, 10.01);
  assert.equal(e.px, 110);
  assert.equal(e.sx, 100);
  assert.equal(e.buttons, 1);
  assert.equal(e.vw, 1280);
  assert.equal(core.makeEvent('keydown', 0, {}), null);
});

test('pushEvent enforces the event cap and total length cap', () => {
  const buffer = [];
  for (let i = 0; i < core.LIMITS.MAX_EVENTS + 10; i++) {
    core.pushEvent(buffer, core.makeEvent('move', i, { clientX: i % 500, clientY: 0 }), 0);
  }
  assert.equal(buffer.length, core.LIMITS.MAX_EVENTS);
  const huge = [];
  assert.equal(core.pushEvent(huge, core.makeEvent('move', core.LIMITS.MAX_TRACK_MS + 10, {}), 0), null);
  assert.equal(huge.length, 0);
});

test('the click a browser forwards from a <label> to its control is not recorded twice', () => {
  const clickAt = (t, x, y, detail = 1, button = 0) =>
    core.makeEvent('click', t, { clientX: x, clientY: y, detail, button });

  const labelClick = clickAt(1000, 700, 130);
  const forwarded = clickAt(1000, 700, 133); // same task, ~same spot
  assert.equal(core.isDuplicateActivation(labelClick, forwarded), true);

  const buffer = [];
  assert.ok(core.pushEvent(buffer, labelClick, 0));
  assert.equal(core.pushEvent(buffer, forwarded, 0), null, 'the forwarded twin must be dropped');
  assert.equal(buffer.length, 1);

  // A real second click is kept: a double click is a different gesture.
  assert.equal(core.isDuplicateActivation(labelClick, clickAt(1030, 700, 130, 2)), false);
  assert.equal(core.isDuplicateActivation(labelClick, clickAt(1500, 700, 130)), false);
  assert.equal(core.isDuplicateActivation(labelClick, clickAt(1000, 900, 130)), false);
  assert.equal(core.isDuplicateActivation(labelClick, clickAt(1000, 700, 130, 1, 2)), false);
  assert.equal(core.isDuplicateActivation(core.makeEvent('down', 1000, { clientX: 1, clientY: 1 }), forwarded), false);

  // Restoring an older session cleans the same twin up.
  const restored = core.normalizeEvents([
    { t: 5, type: 'click', x: 10, y: 10, detail: 1 },
    { t: 5, type: 'click', x: 10, y: 12, detail: 1 },
    { t: 400, type: 'click', x: 10, y: 12, detail: 1 }
  ]);
  assert.deepEqual(restored.map((e) => e.t), [5, 400]);
});

test('normalizeEvents sorts, sanitises and drops junk', () => {
  const out = core.normalizeEvents([
    { t: 300, type: 'move', x: 1, y: 1 },
    { t: 100, type: 'click', x: 2, y: 2, button: 0, buttons: 0, detail: 1 },
    { t: 'nonsense', type: 'move' },
    { t: 200, type: 'keydown' },
    null,
    'nope',
    { t: 250, type: 'up', x: 3, y: 3, button: 2, buttons: 0 }
  ]);
  assert.deepEqual(out.map((e) => e.t), [100, 250, 300]);
  assert.deepEqual(out.map((e) => e.type), ['click', 'up', 'move']);
  assert.equal(out[1].button, 2);
  assert.deepEqual(core.normalizeEvents(undefined), []);
});

test('summarize reports counts used by the popup UI', () => {
  const s = core.summarize([
    ev(0),
    ev(50),
    ev(100, 'down', { button: 0, detail: 1 }),
    ev(120, 'up', { button: 0 }),
    ev(121, 'click', { button: 0, detail: 1 }),
    ev(500, 'contextmenu', { button: 2 })
  ]);
  assert.equal(s.count, 6);
  assert.equal(s.moves, 2);
  assert.equal(s.clicks, 4);
  assert.equal(s.durationMs, 500);
  assert.deepEqual(s.buttons, { 0: 3, 2: 1 });
  assert.deepEqual(core.summarize([]).durationMs, 0);
});

/* ---------------- mouse wheel ---------------- */

const wheel = (deltaX, deltaY, deltaMode = 0, extra = {}) =>
  core.makeEvent('wheel', 10, {
    clientX: 300,
    clientY: 220,
    deltaX,
    deltaY,
    deltaMode,
    innerWidth: 1280,
    innerHeight: 720,
    ...extra
  });

test('the wheel is recorded in pixels whatever unit the wheel spoke in', () => {
  const pixels = wheel(0, -120);
  assert.equal(pixels.type, 'wheel');
  assert.equal(pixels.dy, -120);
  assert.equal(pixels.dx, 0);
  assert.equal(pixels.dmode, 0);

  // deltaMode 1 counts lines, 2 counts pages of the viewport.
  assert.equal(wheel(0, 3, 1).dy, 3 * core.LIMITS.LINE_PX);
  assert.equal(wheel(2, 0, 2).dx, 2 * 1280);
  assert.equal(wheel(0, 1, 2).dy, 720);
  assert.equal(wheel(0, 1, 99).dy, 1, 'an unknown unit is treated as pixels');

  assert.equal(wheel(0, 1e9).dy, core.LIMITS.MAX_WHEEL_DELTA, 'an absurd delta is clamped');
  assert.equal(wheel(0, -1e9).dy, -core.LIMITS.MAX_WHEEL_DELTA);
  assert.equal(wheel(NaN, undefined).dy, 0);
  assert.equal(wheel(0, 0).dmode, 0);
});

test('a wheel that scrolls nothing is never recorded - live or restored', () => {
  const buffer = [];
  assert.equal(core.pushEvent(buffer, wheel(0, 0), 0), null, 'a zero delta is noise');
  assert.ok(core.pushEvent(buffer, wheel(0, -53), 0));
  assert.equal(core.pushEvent(buffer, wheel(0, 0), 0), null, 'and not a duplicate-activation loophole either');
  assert.equal(buffer.length, 1);

  const restored = core.normalizeEvents([
    { t: 5, type: 'wheel', x: 1, y: 1, dx: 0, dy: 0, dmode: 0 },
    { t: 6, type: 'wheel', x: 1, y: 1, dx: 0, dy: -40, dmode: 0 },
    { t: 7, type: 'wheel', x: 1, y: 1 } // a wheel with no deltas at all
  ]);
  assert.deepEqual(restored.map((e) => e.dy), [-40]);
});

test('a stored wheel is not converted twice on the way back out of storage', () => {
  const recorded = core.normalizeEvents([wheel(0, 4, 1)]);
  assert.equal(recorded[0].dy, 4 * core.LIMITS.LINE_PX, 'converted once at recording');

  const revived = core.normalizeEvents(JSON.parse(JSON.stringify(recorded)));
  assert.equal(revived[0].dy, recorded[0].dy, 'pixels stay pixels');
  assert.equal(revived[0].dx, recorded[0].dx);
  assert.equal(revived[0].dmode, 1, 'the original unit is still remembered');
});

test('the scroll containers an event was captured in survive normalisation', () => {
  const chain = [
    { p: [1, 0, 3], g: 'div', x: 0, y: 240, i: 'mouse-wheel-click-test' },
    { p: [1], g: 'BODY', x: 12, y: 0 }
  ];
  const e = core.makeEvent('click', 5, { clientX: 10, clientY: 10, scrollChain: chain });
  assert.equal(e.sc.length, 2);
  assert.deepEqual(e.sc[0].p, [1, 0, 3]);
  assert.equal(e.sc[0].y, 240);
  assert.equal(e.sc[0].g, 'DIV', 'the tag hint is normalised for the lookup');
  assert.equal(e.sc[0].i, 'mouse-wheel-click-test');
  // A move needs no chain: the click and the wheel carry their own.
  assert.equal(core.makeEvent('move', 6, { clientX: 10, clientY: 10 }).sc, undefined);

  const revived = core.normalizeEvents(JSON.parse(JSON.stringify([e])))[0];
  assert.deepEqual(revived.sc, e.sc);
});

test('normalizeScrollChain drops anything it could never resolve', () => {
  assert.deepEqual(core.normalizeScrollChain(undefined), []);
  assert.deepEqual(core.normalizeScrollChain('nope'), []);
  assert.deepEqual(core.normalizeScrollChain([{ p: [], y: 1 }]), [], 'an empty path addresses nothing');
  assert.deepEqual(core.normalizeScrollChain([{ p: [-1], y: 1 }]), [], 'a negative index is garbage');
  assert.deepEqual(core.normalizeScrollChain([{ p: ['x'], y: 1 }]), [], 'a non-numeric index is garbage');
  assert.deepEqual(
    core.normalizeScrollChain([{ p: Array.from({ length: core.LIMITS.MAX_SCROLL_PATH + 5 }, (_, i) => i), y: 1 }]),
    [],
    'an unaddressably deep path is dropped'
  );
  const capped = core.normalizeScrollChain(Array.from({ length: 40 }, (_, i) => ({ p: [i], y: i })));
  assert.equal(capped.length, core.LIMITS.MAX_SCROLL_NODES, 'the chain is capped');
  const sloppy = core.normalizeScrollChain([{ p: [1.6], g: 'div', x: -5, y: NaN, i: 'x'.repeat(500) }])[0];
  assert.deepEqual(sloppy.p, [2]);
  assert.equal(sloppy.x, 0, 'a negative offset is not a scroll position');
  assert.equal(sloppy.y, 0);
  assert.equal(sloppy.i, undefined, 'an id too long to be an id is dropped');
});

test('summarize counts wheels apart from clicks', () => {
  const s = core.summarize([
    ev(0),
    ev(10, 'wheel', { dx: 0, dy: -100 }),
    ev(20, 'wheel', { dx: -30, dy: 0 }),
    ev(30, 'click', { button: 0, detail: 1 })
  ]);
  assert.equal(s.count, 4);
  assert.equal(s.moves, 1);
  assert.equal(s.wheels, 2);
  assert.equal(s.clicks, 1);
  assert.deepEqual(s.buttons, { 0: 1 }, 'a wheel is no button press');
});

/* ---------------- replay geometry ---------------- */

test('replayPoint keeps viewport coords when the scroll did not move', () => {
  const p = core.replayPoint(ev(0, 'move', { x: 40, y: 50, px: 40, py: 50, sx: 0, sy: 0 }), 0, 0, 0, 0);
  assert.deepEqual(p, { x: 40, y: 50 });
});

test('replayPoint converts back through page coords after a scroll', () => {
  const recorded = ev(0, 'move', { x: 40, y: 50, px: 140, py: 250, sx: 100, sy: 200 });
  // Page has scrolled elsewhere: keep the same document position.
  const p = core.replayPoint(recorded, 60, 100, 100, 200);
  assert.deepEqual(p, { x: 80, y: 150 });
});

/* ---------------- CDP mapping ---------------- */

test('toCdpParams maps recorded events onto Input.dispatchMouseEvent', () => {
  const move = core.toCdpParams(ev(0, 'move', { x: 12.3456, y: 30 }));
  assert.equal(move.type, 'mouseMoved');
  assert.equal(move.button, 'none');
  assert.equal(move.x, 12.346);

  const down = core.toCdpParams(ev(0, 'down', { button: 0, buttons: 1, detail: 1 }));
  assert.equal(down.type, 'mousePressed');
  assert.equal(down.button, 'left');
  assert.equal(down.clickCount, 1);
  assert.equal(down.buttons, 1);

  const up = core.toCdpParams(ev(0, 'up', { button: 0, buttons: 0, detail: 1 }));
  assert.equal(up.type, 'mouseReleased');
  assert.equal(up.buttons, 0);

  const right = core.toCdpParams(ev(0, 'down', { button: 2, buttons: 2, detail: 1 }));
  assert.equal(right.button, 'right');
  assert.equal(right.buttons, 2);

  const dbl = core.toCdpParams(ev(0, 'dblclick', { button: 0, buttons: 1, detail: 2 }));
  assert.equal(dbl.clickCount, 2);

  assert.equal(core.toCdpParams(ev(0, 'click', { button: 0, detail: 1 })), null);
  assert.equal(core.toCdpParams(ev(0, 'contextmenu', { button: 2 })), null);
  assert.equal(core.toCdpParams(null), null);
});

test('toCdpParams honours a viewport scale (pinch zoom)', () => {
  const p = core.toCdpParams(ev(0, 'move', { x: 10, y: 20 }), 2);
  assert.equal(p.x, 20);
  assert.equal(p.y, 40);
});

test('toCdpParams maps the wheel onto a CDP mouseWheel', () => {
  const w = core.toCdpParams(ev(0, 'wheel', { x: 320.5, y: 200.25, dx: 0, dy: -240 }));
  assert.equal(w.type, 'mouseWheel');
  assert.equal(w.deltaY, -240);
  assert.equal(w.deltaX, 0);
  assert.equal(w.x, 320.5);
  assert.equal(w.y, 200.25);
  assert.equal('button' in w, false, 'a wheel carries no button state');
  assert.equal('buttons' in w, false);
  assert.equal('clickCount' in w, false);

  const scaled = core.toCdpParams(ev(0, 'wheel', { x: 10, y: 20, dx: 1, dy: -1 }), 2);
  assert.deepEqual([scaled.x, scaled.y], [20, 40], 'the point scales, the delta does not');
  assert.equal(scaled.deltaY, -1);

  assert.equal(core.toCdpParams(ev(0, 'wheel', { x: 1, y: 1 })).deltaY, 0, 'a missing delta dispatches as zero');
});

test('wheels are scheduled in order with the rest of the gesture', () => {
  const events = [
    ev(0),
    ev(100, 'wheel', { dy: -100 }),
    ev(240, 'wheel', { dy: -100 }),
    ev(500, 'click', { button: 0, detail: 1 })
  ];
  const schedule = core.buildSchedule(events, { repetitions: 2, interRepetitionMs: 200 });
  assert.deepEqual(
    schedule.map((s) => s.event.type),
    ['move', 'wheel', 'wheel', 'click', 'move', 'wheel', 'wheel', 'click']
  );
});

/* ---------------- formatting ---------------- */

test('formatters are safe for the popup', () => {
  assert.equal(core.formatDuration(0), '0.0s');
  assert.equal(core.formatDuration(1234), '1.2s');
  assert.equal(core.formatDuration(65_000), '1m 5s');
  assert.equal(core.formatDuration(-5), '0.0s');
  assert.equal(core.formatDuration(NaN), '0.0s');
  assert.equal(core.formatCount(1234), '1,234');
  assert.equal(core.formatCount(undefined), '0');
});

/* ---------------- end-to-end logic simulation ---------------- */

test('a recorded click-drag-click replay produces the expected ordered stream', () => {
  // Simulated recording: move, press, drag, release, click.
  const recorded = core.normalizeEvents([
    { t: 0, type: 'move', x: 100, y: 100 },
    { t: 100, type: 'down', x: 100, y: 100, button: 0, buttons: 1, detail: 1 },
    { t: 200, type: 'move', x: 150, y: 120, buttons: 1 },
    { t: 300, type: 'up', x: 150, y: 120, button: 0, buttons: 0, detail: 1 },
    { t: 301, type: 'click', x: 150, y: 120, button: 0, detail: 1 }
  ]);
  const schedule = core.buildSchedule(recorded, { repetitions: 3, speed: 5, interRepetitionMs: 400, leadInMs: 0 });
  assert.equal(schedule.length, 15);
  approx(core.scheduleDuration(schedule), (301 * 3 + 400 * 2) / 5, '3 reps at 5x');

  const stream = schedule.map((s) => `${s.event.type}@${s.event.x},${s.event.y}`);
  assert.equal(stream[0], 'move@100,100');
  assert.equal(stream[1], 'down@100,100');
  assert.equal(stream[4], 'click@150,120');
  // Repetition 2 starts with the same first event.
  assert.equal(stream[5], 'move@100,100');
  assert.equal(schedule[5].repetition, 2);
  approx(schedule[5].at, 301 / 5 + 400 / 5, 'rep 2 start');
});

/* ---------------- keyboard: Tab and Space ---------------- */

test('normalizeKey names only the keys a macro can be trusted with', () => {
  assert.equal(core.normalizeKey({ key: 'Tab' }), 'Tab');
  assert.equal(core.normalizeKey({ code: 'Tab' }), 'Tab');
  assert.equal(core.normalizeKey({ key: ' ', code: 'Space' }), 'Space');
  assert.equal(core.normalizeKey({ code: 'Space' }), 'Space');
  // Shift is the one modifier that keeps the meaning: Shift+TAB walks backwards.
  assert.equal(core.normalizeKey({ key: 'Tab', shiftKey: true }), 'Tab');
  // With a browser modifier on it, TAB is a shortcut and not a focus move.
  assert.equal(core.normalizeKey({ key: 'Tab', ctrlKey: true }), null);
  assert.equal(core.normalizeKey({ key: ' ', altKey: true }), null);
  assert.equal(core.normalizeKey({ key: 'Tab', metaKey: true }), null);
  // Anything that types text, or is only a modifier, is not offered.
  for (const ignored of [{ key: 'a' }, { key: 'Enter' }, { key: 'Shift' }, { key: 'F5' }, null]) {
    assert.equal(core.normalizeKey(ignored), null, `${JSON.stringify(ignored)} is not a recorded key`);
  }
  assert.equal(core.keySpec('Tab').keyCode, 9);
  assert.equal(core.keySpec('nope'), null);
});

test('a key press is recorded without a position, with its key and modifier', () => {
  const e = core.makeEvent('key', 500, {
    key: core.normalizeKey({ key: 'Tab', shiftKey: true }),
    shiftKey: true,
    scrollX: 0,
    scrollY: 120
  });
  assert.equal(e.k, 'Tab');
  assert.equal(e.sk, 1);
  // A key acts on the focused element, so it claims no point on the page.
  assert.equal(e.x, 0);
  assert.equal(e.y, 0);
  // The scroll offset it was pressed at still matters: a Space pages content.
  assert.equal(e.sy, 120);
  assert.equal(core.makeEvent('key', 0, {}), null, 'an unknown key is not an event');
  assert.equal(core.makeEvent('key', 0, { key: 'Enter' }), null);
});

test('a key press survives the round trip through storage', () => {
  const kept = core.normalizeEvents([
    { t: 10, type: 'key', k: 'Space', sk: 1 },
    { t: 20, type: 'key', k: 'Tab' }
  ]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].k, 'Space');
  assert.equal(kept[0].sk, 1);
  assert.equal(kept[1].sk, 0, 'a press without the modifier is not shift-shift');
  // A session restored from a version that offered other keys drops them.
  assert.deepEqual(core.normalizeEvents([{ t: 1, type: 'key', k: 'Enter' }]), []);
});

test('toCdpKeyCommands sends the press and the release the page expects', () => {
  const tab = core.toCdpKeyCommands({ type: 'key', k: 'Tab', sk: 0 });
  assert.deepEqual(
    tab.map((c) => c.type),
    ['keyDown', 'keyUp'],
    'Chrome moves the focus on the keydown, but a listener sees both'
  );
  assert.equal(tab[0].key, 'Tab');
  assert.equal(tab[0].code, 'Tab');
  assert.equal(tab[0].windowsVirtualKeyCode, 9);
  assert.equal(tab[0].modifiers, 0);
  assert.ok(!('text' in tab[0]), 'Tab types nothing');

  const space = core.toCdpKeyCommands({ type: 'key', k: 'Space', sk: 1 });
  assert.equal(space[0].code, 'Space');
  assert.equal(space[0].windowsVirtualKeyCode, 32);
  assert.equal(space[0].text, ' ', 'without the character a focused field would receive nothing');
  assert.equal(space[0].modifiers, 8, 'CDP spells shift with bit 8');
  assert.ok(!('text' in space[1]), 'a release types nothing either');
  assert.deepEqual(core.toCdpKeyCommands({ type: 'click', k: 'Tab' }), []);
  assert.deepEqual(core.toCdpKeyCommands(null), []);
});

test('toCdpParams refuses to send half a key press', () => {
  assert.equal(core.toCdpParams({ type: 'key', k: 'Space' }, 1), null);
});

test('the click a key performs is not recorded as an action of its own', () => {
  const activation = ev(10, 'click', { x: 0, y: 0, detail: 0 });
  assert.equal(core.isKeyPressActivation(activation), true, 'Chrome activates a focused control with an unpositioned click');
  // A mouse click that happens to land on the very corner is still a click: it
  // carries a click count, which a keyboard activation never does.
  assert.equal(core.isKeyPressActivation(ev(10, 'click', { x: 0, y: 0, detail: 1 })), false);
  assert.equal(core.isKeyPressActivation(ev(10, 'click', { x: 640, y: 242, detail: 1 })), false);

  const buffer = [];
  assert.equal(core.pushEvent(buffer, activation, 0), null, 'the activation click must not enter the buffer');
  assert.equal(core.pushEvent(buffer, ev(20, 'click', { x: 100, y: 100, detail: 1 }), 0) ? buffer.length : 0, 1);
  // A session restored from storage is cleaned exactly the same way.
  assert.equal(core.normalizeEvents([activation]).length, 0);
});

test('summarize counts key presses apart from clicks and wheels', () => {
  const s = core.summarize([
    ev(0, 'key', { k: 'Tab' }),
    ev(10, 'key', { k: 'Space' }),
    ev(20, 'wheel', { dx: 0, dy: 40 }),
    ev(30, 'click', { button: 0 })
  ]);
  assert.equal(s.count, 4);
  assert.equal(s.keys, 2);
  assert.equal(s.wheels, 1);
  assert.equal(s.clicks, 1);
});


/* ---------------- history: the last few finished macros ---------------- */

/** A macro with a recognisable shape: a glide, a click, a wheel and a key. */
const macro = (n) => [
  ev(100, 'move', { x: n, y: 20 }),
  ev(200, 'click', { x: n, y: 20, detail: 1 }),
  ev(300, 'wheel', { x: n, y: 20, dx: 0, dy: 120, dmode: 0 }),
  ev(400, 'key', { x: undefined, y: undefined, k: 'Tab', sk: false })
];

test('the history files a finished macro newest first, and drops the oldest', () => {
  assert.ok(core.LIMITS.MAX_HISTORY >= 5, 'the user asked for at least the last five');
  let h = [];
  for (let i = 1; i <= core.LIMITS.MAX_HISTORY + 3; i++) {
    h = core.addHistoryEntry(h, { savedAt: 1000 * i, host: `m${i}.test`, events: macro(i) });
  }
  assert.equal(h.length, core.LIMITS.MAX_HISTORY);
  const rows = core.historyRows(h);
  assert.equal(rows[0].host, `m${core.LIMITS.MAX_HISTORY + 3}.test`, 'the newest macro must be on top');
  assert.ok(!rows.some((r) => r.host === 'm1.test'), 'the oldest macro must have fallen off');
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'every row needs its own id');
});

test('an empty recording files nothing, and junk from storage yields nothing', () => {
  const one = core.addHistoryEntry([], { savedAt: 5, events: macro(1) });
  assert.deepEqual(core.addHistoryEntry(one, { savedAt: 6, events: [] }), one, 'a recording with no events is not a macro');
  assert.deepEqual(core.addHistoryEntry(one, {}), one);
  assert.deepEqual(core.addHistoryEntry(one, { savedAt: 7, events: [{ type: 'nonsense' }, null, 3] }), one);
  assert.deepEqual(core.normalizeHistory(undefined), []);
  assert.deepEqual(core.normalizeHistory([null, 7, 'x', {}, { events: [] }]), []);
  assert.equal(core.historyRows(undefined).length, 0);
});

test('a stored macro restores through the same door as a session', () => {
  const h = core.addHistoryEntry([], { savedAt: 1, host: 'a.test', events: macro(3) });
  const round = core.normalizeHistory(h);
  assert.deepEqual(round[0].events, h[0].events, 'a history entry must survive storage exactly');
  assert.deepEqual(core.normalizeEvents(h[0].events), h[0].events);
  assert.equal(round[0].host, 'a.test');
  assert.equal(round[0].savedAt, 1);
});

test('a history row carries what a row draws, never the events', () => {
  const h = core.addHistoryEntry([], { savedAt: 1234, host: 'shop.test', events: macro(9) });
  const row = core.historyRows(h)[0];
  assert.equal(row.count, 4);
  assert.equal(row.clicks, 1);
  assert.equal(row.wheels, 1);
  assert.equal(row.keys, 1);
  assert.equal(row.durationMs, 300);
  assert.equal(row.host, 'shop.test');
  assert.equal(row.savedAt, 1234);
  assert.ok(!('events' in row), 'a row must not drag the whole macro to the popup');
});

test('removing a macro takes only that one and says whether it was there', () => {
  let h = core.addHistoryEntry([], { savedAt: 1, host: 'a.test', events: macro(1) });
  h = core.addHistoryEntry(h, { savedAt: 2, host: 'b.test', events: macro(2) });
  const rows = core.historyRows(h);

  const miss = core.removeHistoryEntry(h, 'no-such-id');
  assert.equal(miss.removed, 0);
  assert.equal(miss.history.length, 2);

  const gone = core.removeHistoryEntry(h, rows[1].id);
  assert.equal(gone.removed, 1);
  assert.equal(gone.history.length, 1);
  assert.equal(core.historyRows(gone.history)[0].host, 'b.test', 'the newer macro must survive');
  assert.deepEqual(core.removeHistoryEntry(h, '').removed, 0, 'an empty id matches nothing');
});

test('two rows can never end up sharing an id', () => {
  // Same instant, same length, same content: the only thing telling them apart
  // is that they are two rows, and deleting one must not delete both.
  let h = core.addHistoryEntry([], { savedAt: 77, events: macro(4) });
  h = core.addHistoryEntry(h, { savedAt: 77, events: macro(4) });
  const rows = core.historyRows(h);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(core.removeHistoryEntry(h, rows[0].id).history.length, 1);

  const stamped = [{ id: 'same', savedAt: 1, events: macro(1) }, { id: 'same', savedAt: 2, events: macro(2) }];
  assert.equal(new Set(core.historyRows(core.normalizeHistory(stamped)).map((r) => r.id)).size, 2);
});

test('a row that predates the stored counts gets one, once', () => {
  const fresh = core.addHistoryEntry([], { savedAt: 1, events: macro(2) });
  assert.equal(core.historyRows(fresh)[0].count, 4, 'a fresh entry carries its counts');

  // An entry as an older version wrote it: no summary at all.
  const aged = [{ id: 'old', savedAt: 1, host: 'x.test', events: macro(5) }];
  assert.ok(!aged[0].summary);
  const row = core.historyRows(core.normalizeHistory(aged))[0];
  assert.equal(row.count, 4);
  assert.equal(row.clicks, 1);
});

test('how many macros to keep is the user\u0027s to choose, bounded but not fixed', () => {
  assert.equal(core.LIMITS.MAX_HISTORY, 10, 'ten finished macros is the default');
  assert.ok(core.LIMITS.HISTORY_CHOICES.includes(core.LIMITS.MAX_HISTORY), 'the default must be one of the offers');
  for (const choice of core.LIMITS.HISTORY_CHOICES) {
    assert.ok(
      choice >= core.LIMITS.MIN_HISTORY && choice <= core.LIMITS.MAX_HISTORY_LIMIT,
      `${choice} is outside the bounds it would be clamped to`
    );
  }
  assert.equal(core.normalizeLimit(undefined), 10, 'no setting yet means the default');
  assert.equal(core.normalizeLimit(null), 10);
  assert.equal(core.normalizeLimit('20'), 10, 'a string off hand-edited storage is not a number of macros');
  assert.equal(core.normalizeLimit(0), core.LIMITS.MIN_HISTORY, 'keeping nothing is not a setting a user meant');
  assert.equal(core.normalizeLimit(9000), core.LIMITS.MAX_HISTORY_LIMIT, 'the ceiling is a bound, not a refusal');
  assert.equal(core.normalizeLimit(20), 20, 'a number inside the bounds is taken as asked');
});

test('the list follows the cap it is given, whichever way the user moves it', () => {
  let h = [];
  for (let i = 1; i <= 8; i++) h = core.addHistoryEntry(h, { savedAt: 100 * i, host: `m${i}.test`, events: macro(i) }, 8);
  assert.equal(h.length, 8, 'a cap of eight keeps eight');
  assert.equal(core.historyRows(core.normalizeHistory(h, 3)).length, 3, 'lowering the cap trims at once');
  assert.equal(core.historyRows(core.normalizeHistory(h, 3))[0].host, 'm8.test', 'the newest survive a trim');
  assert.equal(core.historyRows(core.normalizeHistory(h)).length, 8, 'raising the cap back above the trim lets the list be what it is');
  // A cap is only real if filing respects it too: five kept means the sixth is
  // the one that goes, whatever the default happens to be.
  let five = [];
  for (let i = 1; i <= 7; i++) five = core.addHistoryEntry(five, { savedAt: 100 * i, host: `m${i}.test`, events: macro(i) }, 5);
  assert.equal(five.length, 5);
  assert.deepEqual(core.historyRows(five).map((r) => r.host), ['m7.test', 'm6.test', 'm5.test', 'm4.test', 'm3.test']);
});

test('a macro can be named, renamed, and handed back its default label', () => {
  assert.equal(core.normalizeName('  checkout   flow  '), 'checkout flow', 'a name is typed, and read back trimmed');
  assert.equal(core.normalizeName(null), '', 'unnamed is the empty string, not the word null');
  assert.equal(core.normalizeName(42), '');
  assert.equal(core.normalizeName('x'.repeat(200)).length, core.LIMITS.MAX_NAME, 'a row has a width to keep');

  const h = core.addHistoryEntry([], { savedAt: 1, host: 'a.test', name: '  morning  routine ', events: macro(1) });
  assert.equal(core.historyRows(h)[0].name, 'morning routine', 'a filed name survives');
  assert.equal(core.historyRows(core.normalizeHistory(h))[0].name, 'morning routine', 'and survives storage');
  assert.equal(core.historyRows(core.addHistoryEntry([], { savedAt: 2, host: 'b.test', events: macro(1) }))[0].name, '');

  const renamed = core.setHistoryName(h, h[0].id, 'weekly tidy');
  assert.equal(renamed.renamed, 1);
  assert.equal(core.historyRows(renamed.history)[0].name, 'weekly tidy');
  assert.equal(core.historyRows(h)[0].name, 'morning routine', 'the caller\u0027s list is not rewritten behind it');

  const cleared = core.setHistoryName(renamed.history, h[0].id, '   ');
  assert.equal(core.historyRows(cleared.history)[0].name, '', 'an empty name is the default label back again');
  assert.equal(core.setHistoryName(h, 'no-such-id', 'x').renamed, 0, 'renaming a gone macro must say so');
  assert.equal(core.setHistoryName(h, '', 'x').renamed, 0);
  assert.deepEqual(core.setHistoryName(undefined, h[0].id, 'x').history, []);
});

test('historyEvents hands out a copy, and null for a macro that is gone', () => {
  const h = core.addHistoryEntry([], { savedAt: 1, events: macro(6) });
  const id = core.historyRows(h)[0].id;
  const events = core.historyEvents(h, id);
  assert.equal(events.length, 4);
  events.push(ev(9999, 'click', { detail: 1 }));
  assert.equal(core.historyEvents(h, id).length, 4, 'the stored macro must not be reachable through the copy');
  assert.equal(core.historyEvents(h, 'nope'), null);
  assert.equal(core.historyEvents(h, ''), null);
  assert.equal(core.historyEvents(undefined, id), null);
});
