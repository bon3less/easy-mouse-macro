/*
 * Easy Mouse Macro - shared core (pure logic, no Chrome APIs).
 *
 * Loaded as a classic script by:
 *   - the service worker      (importScripts('lib/macro-core.js'))
 *   - the content script      (manifest content_scripts js list)
 *   - the popup               (<script src="lib/macro-core.js">)
 *   - the Node unit tests     (require/import of this same file)
 *
 * Everything here is deterministic and free of DOM / chrome.* access so it can
 * be unit tested headlessly.
 */
(function (root, factory) {
  var api = factory();
  root.EMMCore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Hard limits, chosen to keep a session inside memory / message limits. */
  var LIMITS = {
    MIN_REPETITIONS: 1,
    MAX_REPETITIONS: 999,
    DEFAULT_REPETITIONS: 1,
    MIN_SPEED: 1,
    MAX_SPEED: 10,
    DEFAULT_SPEED: 1,
    MAX_EVENTS: 40000,
    /* How many finished macros the history keeps when the user has not chosen a
     * different number.  The oldest falls off when a new one is filed; the user
     * asked for "at least the last five". */
    MAX_HISTORY: 10,
    /* The history cap is a setting, and these are its bounds.  The ceiling is a
     * space guard rather than a preference: every entry holds up to MAX_EVENTS,
     * so a few dozen macros is already megabytes in chrome.storage.local. */
    MIN_HISTORY: 1,
    MAX_HISTORY_LIMIT: 50,
    /* What the popup offers to pick from.  A setting the user cannot tell apart
     * from the default is not a setting worth changing. */
    HISTORY_CHOICES: [5, 10, 20, 50],
    /* One row's label.  Long enough for a phrase, short enough that the row still
     * has room for the numbers that describe the macro. */
    MAX_NAME: 64,
    MAX_TRACK_MS: 4 * 60 * 60 * 1000,
    /* A wheel delta is recorded in pixels; a "line" / "page" delta is converted
     * with these guesses so the synthetic fallback can emulate the scroll. */
    LINE_PX: 40,
    /* How many nested scroll containers one event may carry. */
    MAX_SCROLL_NODES: 6,
    MAX_SCROLL_PATH: 24,
    MAX_WHEEL_DELTA: 10000
  };

  /** Event types that make up a recorded macro. */
  var EVENT_TYPES = ['move', 'down', 'up', 'click', 'dblclick', 'contextmenu', 'wheel', 'key'];

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  /** Coerce arbitrary user input into an integer inside [min, max]. */
  function clampInt(value, min, max, fallback) {
    var n = typeof value === 'string' ? Number(value.trim()) : Number(value);
    if (!isFiniteNumber(n)) return fallback;
    n = Math.round(n);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, min, max);
  }

  function clampRepetitions(value) {
    return clampInt(
      value,
      LIMITS.MIN_REPETITIONS,
      LIMITS.MAX_REPETITIONS,
      LIMITS.DEFAULT_REPETITIONS
    );
  }

  /**
   * Speed is a multiplier 1..10.  Anything outside the range (or garbage)
   * falls back to 1x so a typo can never make the macro run instantly.
   */
  function clampSpeed(value) {
    var n = typeof value === 'string' ? Number(value.trim()) : Number(value);
    if (!isFiniteNumber(n)) return LIMITS.DEFAULT_SPEED;
    if (n < LIMITS.MIN_SPEED || n > LIMITS.MAX_SPEED) return LIMITS.DEFAULT_SPEED;
    return n;
  }

  /* ------------------------------------------------------------------ *
   * Mouse wheel helpers
   * ------------------------------------------------------------------ */

  function round2(n) {
    return Math.round((isFiniteNumber(n) ? n : 0) * 100) / 100;
  }

  /**
   * A wheel event speaks in units: 0 = pixels, 1 = lines, 2 = pages.  CDP
   * expects pixels, so a recorded delta is converted once, at recording time.
   */
  function wheelPixels(delta, deltaMode, pagePx) {
    var d = isFiniteNumber(delta) ? delta : 0;
    var mode = deltaMode | 0;
    if (mode === 1) return d * LIMITS.LINE_PX;
    if (mode === 2) return d * (isFiniteNumber(pagePx) && pagePx > 0 ? pagePx : LIMITS.LINE_PX * 20);
    return d;
  }

  /**
   * Attach the wheel fields to an event.  `dx` / `dy` are CSS pixels - the unit
   * CDP's mouseWheel takes - and `dmode` remembers the unit the wheel itself
   * reported (0 pixels, 1 lines, 2 pages), kept for diagnosis only.
   */
  function normalizeWheel(event, pixelsX, pixelsY, deltaMode) {
    var max = LIMITS.MAX_WHEEL_DELTA;
    event.dx = clamp(round2(pixelsX), -max, max);
    event.dy = clamp(round2(pixelsY), -max, max);
    event.dmode = deltaMode | 0;
    return event;
  }

  /** True when a wheel delta would not move anything. */
  function isIdleWheel(event) {
    return !!event && !event.dx && !event.dy;
  }

  /**
   * The keys the recorder knows, named the way CDP names a press.
   *
   * Only these two are offered, and deliberately so: their whole job is an
   * effect - Tab moves the focus, Space activates the focused control or pages
   * the content - so a replay can be checked against what the page ended up
   * doing.  A key that only types text would need the reverse (a caret, an
   * input method, a form that validates), which is a different and much larger
   * promise than this recorder makes.
   */
  var KEYS = {
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '' },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' }
  };

  /** Map a DOM KeyboardEvent to a recorded key id; null for a key not offered. */
  function normalizeKey(event) {
    if (!event) return null;
    // Only a press that is unmodified - or merely shifted - is one of ours.
    // TAB with Ctrl or Alt is a browser shortcut, and replaying it as a bare
    // Tab would do something quite different from what the user did.
    if (event.ctrlKey || event.altKey || event.metaKey) return null;
    if (event.key === 'Tab' || event.code === 'Tab') return 'Tab';
    if (event.key === ' ' || event.code === 'Space') return 'Space';
    return null;
  }

  function keySpec(id) {
    return Object.prototype.hasOwnProperty.call(KEYS, id) ? KEYS[id] : null;
  }

  /**
   * Sanitise the snapshot of the scroll containers an event was captured in.
   *
   * The page may scroll inside its own element (`overflow: auto` panels, menus,
   * model pickers), and a viewport coordinate then says nothing about which
   * pixel of the *content* was pointed at.  Each entry says: "the scrollable
   * element found at index path `p` below <html> - id `i` and tag `g` where
   * that still resolves - was scrolled to (`x`, `y`)".  Restoring that before a
   * replayed click or wheel puts the content back under the pointer.
   */
  function normalizeScrollChain(chain) {
    if (!Array.isArray(chain)) return [];
    var out = [];
    for (var i = 0; i < chain.length && out.length < LIMITS.MAX_SCROLL_NODES; i++) {
      var node = chain[i];
      if (!node || typeof node !== 'object') continue;
      var path = Array.isArray(node.p) ? node.p : [];
      if (!path.length || path.length > LIMITS.MAX_SCROLL_PATH) continue;
      var ok = true;
      var clean = [];
      for (var j = 0; j < path.length; j++) {
        var step = Number(path[j]);
        if (!isFiniteNumber(step) || step < 0 || step > 65535) {
          ok = false;
          break;
        }
        clean.push(Math.round(step));
      }
      if (!ok) continue;
      var entry = {
        p: clean,
        x: round2(Math.max(0, Number(node.x) || 0)),
        y: round2(Math.max(0, Number(node.y) || 0))
      };
      if (typeof node.i === 'string' && node.i.length && node.i.length <= 200) entry.i = node.i;
      if (typeof node.g === 'string' && node.g.length && node.g.length <= 40) entry.g = node.g.toUpperCase();
      out.push(entry);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Recording
   * ------------------------------------------------------------------ */

  /**
   * Create a normalised event record.
   *
   * Coordinates are stored twice:
   *   x / y      - viewport (client) coordinates, used for the actual replay
   *   px / py    - document (page) coordinates, used to recover the position
   *                after scrolling back to the recorded scroll offset
   */
  function makeEvent(type, now, base) {
    if (EVENT_TYPES.indexOf(type) === -1) return null;
    var t = isFiniteNumber(now) ? Math.max(0, now) : 0;
    var e = {
      t: t,
      type: type,
      x: Math.round((base.clientX || 0) * 100) / 100,
      y: Math.round((base.clientY || 0) * 100) / 100,
      px: Math.round((base.pageX || 0) * 100) / 100,
      py: Math.round((base.pageY || 0) * 100) / 100,
      sx: Math.round((base.scrollX || 0) * 100) / 100,
      sy: Math.round((base.scrollY || 0) * 100) / 100,
      button: base.button | 0,
      buttons: base.buttons | 0,
      detail: base.detail | 0
    };
    if (type === 'wheel') {
      normalizeWheel(
        e,
        wheelPixels(base.deltaX, base.deltaMode, base.innerWidth),
        wheelPixels(base.deltaY, base.deltaMode, base.innerHeight),
        base.deltaMode
      );
    }
    if (type === 'key') {
      if (!keySpec(base.key)) return null;
      // A key press has no coordinates of its own - the fields above stay at 0,
      // which is honest, since a key acts on the focused element and not on a
      // point.  What it *does* act on is recorded as the scroll chain, because a
      // Space pages the content that is focused.
      e.k = base.key;
      e.sk = base.shiftKey ? 1 : 0;
    }
    var chain = normalizeScrollChain(base.scrollChain);
    if (chain.length) e.sc = chain;
    if (isFiniteNumber(base.innerWidth)) e.vw = Math.round(base.innerWidth);
    if (isFiniteNumber(base.innerHeight)) e.vh = Math.round(base.innerHeight);
    return e;
  }

  /**
   * mousemove fires far more often than a replay needs (and can blow up
   * memory).  A move is kept when it is far enough from the previous kept
   * move, or enough time has passed that the pause is itself worth replaying.
   */
  function shouldCaptureMove(prev, x, y, now, opts) {
    var o = opts || {};
    var minIntervalMs = isFiniteNumber(o.minIntervalMs) ? o.minIntervalMs : 10;
    var minDistance = isFiniteNumber(o.minDistance) ? o.minDistance : 2;
    var maxIdleMs = isFiniteNumber(o.maxIdleMs) ? o.maxIdleMs : 80;

    if (!prev) return true;
    var dt = now - prev.t;
    if (dt >= maxIdleMs) return true;
    if (dt < minIntervalMs) return false;
    var dx = x - prev.x;
    var dy = y - prev.y;
    return dx * dx + dy * dy >= minDistance * minDistance;
  }

  /**
   * One real click on a <label for="..."> reaches the page as *two* click
   * events: the one on the label, and the click the browser forwards to the
   * labelled control - dispatched in the same task, so the same millisecond and
   * essentially the same spot.  A real user cannot click twice that fast (the
   * genuine second click of a double click carries a higher `detail` and comes
   * much later), so the forwarded twin is dropped: replaying both would toggle a
   * checkbox twice and land back where it started.
   */
  function isDuplicateActivation(prev, event) {
    if (!prev || !event) return false;
    if (prev.type !== 'click' || event.type !== 'click') return false;
    if ((prev.button | 0) !== (event.button | 0)) return false;
    if (event.detail > prev.detail) return false;
    if (Math.abs(event.t - prev.t) > 2) return false;
    var dx = event.x - prev.x;
    var dy = event.y - prev.y;
    return dx * dx + dy * dy <= 25 * 25;
  }

  /**
   * The click a key press performs on itself.
   *
   * When Space toggles a focused checkbox, Chrome dispatches a click for that
   * activation as well.  It is unpositioned - (0, 0) - and carries no click
   * count, unlike every click a mouse produced, which is how it can be told
   * apart from a user pointing at the corner of the page.  Recording it would
   * replay the same activation twice: once from the key, and once as a click on
   * the top-left pixel of the viewport, where nobody pointed.
   */
  function isKeyPressActivation(event) {
    if (!event || event.type !== 'click') return false;
    if ((event.x | 0) !== 0 || (event.y | 0) !== 0) return false;
    return !(event.detail > 0);
  }

  /** Append an event to a buffer enforcing the global caps. Returns the event or null. */
  function pushEvent(buffer, event, startEpochMs) {
    if (!event) return null;
    if (buffer.length >= LIMITS.MAX_EVENTS) return null;
    var span = event.t - (isFiniteNumber(startEpochMs) ? startEpochMs : 0);
    if (span > LIMITS.MAX_TRACK_MS) return null;
    // A wheel event that moves nothing (a touchpad hover, a locked shift-scroll)
    // would only ever replay as noise.
    if (event.type === 'wheel' && isIdleWheel(event)) return null;
    if (isKeyPressActivation(event)) return null;
    if (isDuplicateActivation(buffer[buffer.length - 1], event)) return null;
    buffer.push(event);
    return event;
  }

  /** Validate + sanitise a list coming back from a content script. */
  function normalizeEvents(input) {
    if (!Array.isArray(input)) return [];
    var out = [];
    for (var i = 0; i < input.length && out.length < LIMITS.MAX_EVENTS; i++) {
      var raw = input[i];
      if (!raw || typeof raw !== 'object') continue;
      if (EVENT_TYPES.indexOf(raw.type) === -1) continue;
      var t = Number(raw.t);
      if (!isFiniteNumber(t)) continue;
      var e = makeEvent(raw.type, Math.max(0, t), {
        clientX: Number(raw.x),
        clientY: Number(raw.y),
        pageX: Number(raw.px),
        pageY: Number(raw.py),
        scrollX: Number(raw.sx),
        scrollY: Number(raw.sy),
        button: Number(raw.button),
        buttons: Number(raw.buttons),
        detail: Number(raw.detail),
        scrollChain: raw.sc,
        innerWidth: Number(raw.vw),
        innerHeight: Number(raw.vh),
        key: raw.k,
        shiftKey: !!raw.sk
      });
      if (!e) continue;
      if (e.type === 'wheel') {
        // makeEvent already had its turn at the units: a stored event carries
        // pixels, so they are copied through instead of converted twice.
        normalizeWheel(e, Number(raw.dx) || 0, Number(raw.dy) || 0, Number(raw.dmode) || 0);
      }
      // Guard: events whose coordinates are not numbers at all would sort and
      // dispatch as 0, so a session restored from storage stays sortable.
      out.push(e);
    }
    out.sort(function (a, b) {
      return a.t - b.t;
    });
    // Filter the forwarded label clicks and empty wheel events once the order is
    // settled, so a session restored from storage is cleaned exactly like a
    // freshly recorded one.
    var kept = [];
    for (var j = 0; j < out.length; j++) {
      if (out[j].type === 'wheel' && isIdleWheel(out[j])) continue;
      if (isKeyPressActivation(out[j])) continue;
      if (isDuplicateActivation(kept[kept.length - 1], out[j])) continue;
      kept.push(out[j]);
    }
    return kept;
  }

  /* ------------------------------------------------------------------ *
   * Scheduling (repetitions + speed)
   * ------------------------------------------------------------------ */

  /** Convert a speed multiplier into a delay scale factor (1x -> 1, 4x -> 0.25). */
  function delayScale(speed) {
    var s = clampSpeed(speed);
    return 1 / s;
  }

  /**
   * Build the absolute replay schedule.
   *
   * @param {Array} events  normalised recorded events (ascending t)
   * @param {Object} opts   { repetitions, speed, interRepetitionMs, leadInMs }
   * @returns {Array<{at:number, repetition:number, index:number, event:Object}>}
   */
  function buildSchedule(events, opts) {
    var o = opts || {};
    var list = Array.isArray(events) ? events : [];
    if (!list.length) return [];

    var reps = clampRepetitions(
      o.repetitions === undefined ? LIMITS.DEFAULT_REPETITIONS : o.repetitions
    );
    var speed = clampSpeed(
      o.speed === undefined ? LIMITS.DEFAULT_SPEED : o.speed
    );
    var scale = delayScale(speed);
    var gap =
      (isFiniteNumber(o.interRepetitionMs) ? Math.max(0, o.interRepetitionMs) : 400) *
      scale;
    var leadIn =
      (isFiniteNumber(o.leadInMs) ? Math.max(0, o.leadInMs) : 350) * scale;

    var first = list[0].t;
    var duration = list[list.length - 1].t - first;

    var out = [];
    var base = leadIn;
    for (var r = 0; r < reps; r++) {
      for (var i = 0; i < list.length; i++) {
        var ev = list[i];
        out.push({
          at: base + (ev.t - first) * scale,
          repetition: r + 1,
          index: i,
          event: ev
        });
      }
      base += duration * scale;
      if (r !== reps - 1) base += gap;
    }

    // Never emit a schedule that is not monotonically non-decreasing.
    var last = -Infinity;
    for (var k = 0; k < out.length; k++) {
      if (out[k].at < last) out[k].at = last;
      last = out[k].at;
    }
    return out;
  }

  /** Total wall-clock length of a scheduled playback, in ms. */
  function scheduleDuration(schedule) {
    if (!schedule || !schedule.length) return 0;
    return schedule[schedule.length - 1].at;
  }

  /** Human readable summary used by popup + tests. */
  function summarize(events) {
    var list = Array.isArray(events) ? events : [];
    var s = {
      count: list.length,
      moves: 0,
      clicks: 0,
      wheels: 0,
      keys: 0,
      buttons: {},
      durationMs: 0,
      first: null,
      last: null
    };
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.type === 'move') s.moves++;
      else if (e.type === 'wheel') s.wheels++;
      else if (e.type === 'key') s.keys++;
      else {
        s.clicks++;
        var b = e.button | 0;
        s.buttons[b] = (s.buttons[b] || 0) + 1;
      }
    }
    if (list.length) {
      s.first = list[0].t;
      s.last = list[list.length - 1].t;
      s.durationMs = list[list.length - 1].t - list[0].t;
    }
    return s;
  }

  /**
   * Recover the viewport coordinates to use at replay time.  When the page
   * scrolled since the moment the event was captured we convert back through
   * the page coordinates, so the pointer lands on the same document position.
   */
  function replayPoint(ev, currentScrollX, currentScrollY, recordedScrollX, recordedScrollY) {
    var cx = isFiniteNumber(currentScrollX) ? currentScrollX : 0;
    var cy = isFiniteNumber(currentScrollY) ? currentScrollY : 0;
    var rx = isFiniteNumber(recordedScrollX) ? recordedScrollX : ev.sx || 0;
    var ry = isFiniteNumber(recordedScrollY) ? recordedScrollY : ev.sy || 0;
    var x = isFiniteNumber(ev.x) ? ev.x : 0;
    var y = isFiniteNumber(ev.y) ? ev.y : 0;
    if (Math.abs(cx - rx) > 0.5 || Math.abs(cy - ry) > 0.5) {
      var pxc = isFiniteNumber(ev.px) ? ev.px : x + rx;
      var pyc = isFiniteNumber(ev.py) ? ev.py : y + ry;
      x = pxc - cx;
      y = pyc - cy;
    }
    return { x: x, y: y };
  }

  /* ------------------------------------------------------------------ *
   * Trusted (chrome.debugger / CDP) mapping
   * ------------------------------------------------------------------ */

  var BUTTON_TO_MASK = { 0: 1, 1: 4, 2: 2 };

  /**
   * Map a recorded event to CDP `Input.dispatchMouseEvent` parameters.
   * Returns null for event types that have no CDP equivalent.
   */
  function toCdpParams(ev, viewportScale) {
    if (!ev) return null;
    var scale = isFiniteNumber(viewportScale) && viewportScale > 0 ? viewportScale : 1;
    var x = (isFiniteNumber(ev.x) ? ev.x : 0) * scale;
    var y = (isFiniteNumber(ev.y) ? ev.y : 0) * scale;
    var buttonNames = ['left', 'middle', 'right'];
    var name = buttonNames[ev.button | 0] || 'left';

    var params = {
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
      button: name,
      buttons: ev.buttons | 0,
      clickCount: 0,
      pointerType: 'mouse'
    };

    switch (ev.type) {
      case 'move':
        if ((ev.buttons | 0) !== 0) {
          // A move with a button held is a drag: same mouseMoved, but it has to
          // keep the held button and its bit in `buttons` (filled in above), so
          // Chrome treats the trail as one continuous drag.  The press that
          // started it and the release that ends it are their own recorded
          // 'down' / 'up' events; a move never pretends to be one of those.
          params.type = 'mouseMoved';
        } else {
          // An unheld move has to say so explicitly, or CDP reads it as if the
          // primary button were down.
          params.type = 'mouseMoved';
          params.button = 'none';
        }
        return params;
      case 'down':
        params.type = 'mousePressed';
        params.clickCount = Math.max(1, ev.detail | 0);
        params.buttons = (ev.buttons | 0) || BUTTON_TO_MASK[ev.button | 0] || 1;
        return params;
      case 'up':
        params.type = 'mouseReleased';
        params.clickCount = Math.max(1, ev.detail | 0);
        params.buttons = 0;
        return params;
      case 'dblclick':
        params.type = 'mousePressed';
        params.clickCount = 2;
        params.buttons = (ev.buttons | 0) || BUTTON_TO_MASK[ev.button | 0] || 1;
        return params;
      case 'wheel':
        // CDP takes a wheel as its own mouse event type, in pixels, and wants no
        // button state on it - exactly what Chrome's own automation sends.
        return {
          type: 'mouseWheel',
          x: params.x,
          y: params.y,
          deltaX: isFiniteNumber(ev.dx) ? ev.dx : 0,
          deltaY: isFiniteNumber(ev.dy) ? ev.dy : 0
        };
      default:
        // click / contextmenu are implied by press+release pairs, and a key is
        // not one command: see toCdpKeyCommands.
        return null;
    }
  }

  /** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  var MOD_SHIFT = 8;

  /**
   * The CDP `Input.dispatchKeyEvent` parameters for one recorded key press.
   *
   * The recording holds a press; the page sees a keydown *and* a keyup - and for
   * Space the activation of a focused control happens on the keyup, so sending
   * only the press would leave a checkbox stubbornly unchanged.  Both commands
   * are returned together so the engine that sends them cannot send half.
   */
  function toCdpKeyCommands(ev) {
    var spec = ev && ev.type === 'key' ? keySpec(ev.k) : null;
    if (!spec) return [];
    var shared = {
      modifiers: ev.sk ? MOD_SHIFT : 0,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode
    };
    var down = Object.assign({ type: 'keyDown' }, shared);
    // The character is what lets a focused text field receive the space; a
    // keyDown without it moves nothing and types nothing.  Tab types nothing.
    if (spec.text) down.text = spec.text;
    return [down, Object.assign({ type: 'keyUp' }, shared)];
  }

  /* ------------------------------------------------------------------ *
   * History
   *
   * The last few finished macros, kept so one can be replayed again in another
   * tab or on another day.  These are pure list functions: the background
   * worker owns the storage, and an entry is
   *
   *   { id, savedAt, host, name, events, summary }
   *
   * Events are stored in exactly the compact form normalizeEvents() accepts, so
   * a history entry restores through the same door a session does.
   *
   * Every list function here takes the cap as an argument, because the cap is a
   * user setting and core must not know where settings live.  Callers pass what
   * they loaded; the default is LIMITS.MAX_HISTORY.
   * ------------------------------------------------------------------ */

  /**
   * A cap the extension will accept.  Anything unusable - undefined, a string
   * off hand-edited storage, 0, 1e9 - becomes the default or a bound, never a
   * surprise: a cap of 0 would mean "keep nothing", which is not a setting a
   * user can have meant.
   */
  function normalizeLimit(value) {
    var n = isFiniteNumber(value) ? Math.floor(value) : NaN;
    if (!isFiniteNumber(n)) return LIMITS.MAX_HISTORY;
    return Math.min(LIMITS.MAX_HISTORY_LIMIT, Math.max(LIMITS.MIN_HISTORY, n));
  }

  /**
   * A row label.  Runs of spaces collapse and the ends go, because a name is
   * typed at a keyboard and read back at 11px inside a 344px popup.  Unnamed is
   * the empty string, which is what lets a rename undo itself.
   */
  function normalizeName(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.MAX_NAME);
  }

  /**
   * The counts a row needs to describe itself.  They are stored with the entry
   * because summarize() walks every event, and the popup reads the rows on every
   * refresh: recomputing ten macros per refresh would cost more than recording
   * them did.  Missing - an entry written by an older version, or hand-edited
   * storage - it is computed once here and carried from then on.
   */
  function entrySummary(entry) {
    var s = entry && entry.summary;
    if (s && isFiniteNumber(s.count) && isFiniteNumber(s.durationMs)) return s;
    return summarize(entry ? entry.events : null);
  }

  /** A row label no other row in `list` already carries. */
  function uniqueHistoryId(list, savedAt, count) {
    var taken = Object.create(null);
    for (var i = 0; i < list.length; i++) taken[list[i].id] = 1;
    var base = (savedAt || 0).toString(36) + '-' + (count || 0).toString(36);
    var id = base;
    for (var n = 2; taken[id] !== undefined; n++) id = base + '-' + n;
    return id;
  }

  /**
   * Accept whatever came out of storage: keep the entries that still hold a
   * usable macro, drop the rest, cap the count.  A row whose events do not
   * survive normalizeEvents() is worse than no row - it offers a replay that
   * does nothing and calls it a macro.
   *
   * This is also how the cap is applied when the user lowers it: normalising
   * with the new number and saving the result drops the oldest rows at once,
   * rather than keeping them out of sight until something is filed.
   */
  function normalizeHistory(input, limit) {
    if (!Array.isArray(input)) return [];
    var kept = normalizeLimit(limit);
    var out = [];
    for (var i = 0; i < input.length && out.length < kept; i++) {
      var raw = input[i];
      if (!raw || typeof raw !== 'object') continue;
      var events = normalizeEvents(raw.events);
      if (!events.length) continue;
      var savedAt = isFiniteNumber(raw.savedAt) ? Math.max(0, Math.floor(raw.savedAt)) : 0;
      var id = typeof raw.id === 'string' && raw.id ? raw.id : '';
      // An id repeated across two rows would make "delete this one" delete both,
      // so a collision - however it got there - gets a label of its own.
      if (id) {
        for (var j = 0; j < out.length; j++) {
          if (out[j].id === id) {
            id = uniqueHistoryId(out, savedAt, events.length);
            break;
          }
        }
      } else {
        id = uniqueHistoryId(out, savedAt, events.length);
      }
      out.push({
        id: id,
        savedAt: savedAt,
        host: typeof raw.host === 'string' ? raw.host.slice(0, 120) : '',
        name: normalizeName(raw.name),
        events: events,
        summary: entrySummary(raw)
      });
    }
    return out;
  }

  /**
   * File a finished macro.  Newest first, and the list never grows past the cap:
   * the whole point of a history is that the recent ones are there, not that
   * everything ever recorded is.  An empty recording files nothing - a row that
   * replays nothing is noise.
   */
  function addHistoryEntry(list, entry, limit) {
    var kept = normalizeHistory(list, limit);
    var events = normalizeEvents(entry && entry.events);
    if (!events.length) return kept;
    var raw = entry || {};
    var savedAt = isFiniteNumber(raw.savedAt) ? Math.max(0, Math.floor(raw.savedAt)) : 0;
    var row = {
      id: uniqueHistoryId(kept, savedAt, events.length),
      savedAt: savedAt,
      host: typeof raw.host === 'string' ? raw.host.slice(0, 120) : '',
      name: normalizeName(raw.name),
      events: events,
      summary: summarize(events)
    };
    return [row].concat(kept).slice(0, normalizeLimit(limit));
  }

  /**
   * Name one macro, or pass an empty name to hand it back its default label.
   * `renamed` counts the rows that matched, so a rename aimed at a macro that
   * was deleted in the meantime reports that instead of looking like it worked.
   */
  function setHistoryName(list, id, name) {
    var out = [];
    var renamed = 0;
    var label = normalizeName(name);
    if (!Array.isArray(list)) return { history: out, renamed: renamed };
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e && id && e.id === id) {
        e = Object.assign({}, e, { name: label });
        renamed++;
      }
      out.push(e);
    }
    return { history: out, renamed: renamed };
  }

  /** Drop one macro by id; `removed` tells the caller whether the id was there. */
  function removeHistoryEntry(list, id) {
    var history = [];
    var removed = 0;
    if (!Array.isArray(list)) return { history: history, removed: removed };
    for (var i = 0; i < list.length; i++) {
      if (id && list[i] && list[i].id === id) {
        removed++;
        continue;
      }
      history.push(list[i]);
    }
    return { history: history, removed: removed };
  }

  /**
   * What a row draws - never the events.  Ten macros of up to MAX_EVENTS each
   * would otherwise be shipped to the popup four times a second, and the popup
   * only ever shows a line of numbers per row.
   */
  function historyRows(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e.id !== 'string' || !e.id) continue;
      var s = entrySummary(e);
      out.push({
        id: e.id,
        savedAt: e.savedAt || 0,
        host: e.host || '',
        name: normalizeName(e.name),
        count: s.count,
        moves: s.moves,
        clicks: s.clicks,
        wheels: s.wheels,
        keys: s.keys,
        durationMs: s.durationMs
      });
    }
    return out;
  }

  /** The stored events of one macro as a fresh array, or null when the id is gone. */
  function historyEvents(list, id) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && id && list[i].id === id) return list[i].events.slice(0);
    }
    return null;
  }

  function formatDuration(ms) {
    if (!isFiniteNumber(ms) || ms <= 0) return '0.0s';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    var m = Math.floor(s / 60);
    return m + 'm ' + Math.round(s % 60) + 's';
  }

  function formatCount(n) {
    if (!isFiniteNumber(n)) return '0';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return {
    LIMITS: LIMITS,
    EVENT_TYPES: EVENT_TYPES,
    BUTTON_TO_MASK: BUTTON_TO_MASK,
    isFiniteNumber: isFiniteNumber,
    clamp: clamp,
    clampInt: clampInt,
    clampRepetitions: clampRepetitions,
    clampSpeed: clampSpeed,
    wheelPixels: wheelPixels,
    normalizeWheel: normalizeWheel,
    isIdleWheel: isIdleWheel,
    KEYS: KEYS,
    normalizeKey: normalizeKey,
    keySpec: keySpec,
    normalizeScrollChain: normalizeScrollChain,
    makeEvent: makeEvent,
    shouldCaptureMove: shouldCaptureMove,
    isKeyPressActivation: isKeyPressActivation,
    isDuplicateActivation: isDuplicateActivation,
    pushEvent: pushEvent,
    normalizeEvents: normalizeEvents,
    delayScale: delayScale,
    buildSchedule: buildSchedule,
    scheduleDuration: scheduleDuration,
    summarize: summarize,
    replayPoint: replayPoint,
    toCdpParams: toCdpParams,
    toCdpKeyCommands: toCdpKeyCommands,
    formatDuration: formatDuration,
    formatCount: formatCount,
    addHistoryEntry: addHistoryEntry,
    setHistoryName: setHistoryName,
    normalizeLimit: normalizeLimit,
    normalizeName: normalizeName,
    removeHistoryEntry: removeHistoryEntry,
    normalizeHistory: normalizeHistory,
    historyRows: historyRows,
    historyEvents: historyEvents
  };
});
