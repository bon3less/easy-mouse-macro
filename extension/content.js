/*
 * Easy Mouse Macro - content script.
 *
 * Lives in the page being recorded / replayed.  Responsibilities:
 *   1. record mouse moves + clicks (capture phase, so page handlers cannot
 *      hide them from us),
 *   2. replay them on an absolute clock, either as
 *        - "trusted" input  -> relayed to the service worker which uses
 *                              chrome.debugger / CDP Input.dispatchMouseEvent
 *        - "synthetic" input-> dispatched as real DOM MouseEvents here,
 *   3. draw a ghost cursor so the user can watch the macro run.
 *
 * The replay clock lives here (not in the service worker) because a page
 * context always has working timers, while a MV3 service worker can be torn
 * down at any time.
 */
(function () {
  'use strict';

  if (window.__emmContentLoaded) return;
  window.__emmLoaded = true;
  window.__emmContentLoaded = true;

  var core = window.EMMCore;
  if (!core) return; // lib/macro-core.js must be listed before us in the manifest

  // Marker visible to the page's main world (content scripts run in an
  // isolated world, so a plain window property would be invisible there).
  try {
    document.documentElement.setAttribute('data-emm-ready', '1');
  } catch (e) {
    /* detached document */
  }

  var MSG = 'emm';

  /**
   * How long the replay clock may wait for one debugger round-trip before
   * moving on.  Well under one display frame for a mouse move, so the trail
   * keeps its shape even when the CDP pipeline is slower than the recording.
   */
  var DISPATCH_BUDGET_MS = 8;

  /**
   * How long the replay clock waits for the page to have *applied* an event that
   * depends on a scroll offset before the next event goes out.  A click is
   * applied on the renderer's main thread, a wheel scrolls on the compositor,
   * and a busy page falls behind: a click still sitting in that queue then gets
   * hit-tested against content a *later* wheel has already moved, and lands on
   * something the recording never saw.  Waiting for the acknowledgement keeps
   * the events in the order the page applies them - a slow page makes such a
   * replay lag behind its schedule, which is honest, rather than misaim, which
   * is not.  An event that aims at a plain point on a page nobody scrolled has
   * nothing to be out of step with, so it is never held back: that is what keeps
   * a fast replay of an ordinary gesture fast.
   */
  var APPLY_BUDGET_MS = 2500;

  /**
   * How far the replay may fall behind its schedule before the rest of it is
   * shifted along with the delay.  Without this the events after a slow one are
   * all already "due" and go out in a burst, which flattens the recording the
   * page finally sees; shifting keeps the recorded gaps between events and lets
   * the whole replay finish late instead of squeezed.
   */
  var LAG_SHIFT_MS = 32;

  /**
   * Rough display frame interval.  Two mouse moves inside the same frame are
   * merged by the browser, so this is also the fastest faithful trail.
   */
  var MOVE_GATE_MS = 16;

  /**
   * How long a trusted wheel may still be travelling through Chrome's input
   * pipeline.  A wheel scrolls on the compositor, and the page's own scrollTop
   * only catches up after a compositor sync - about a hundred milliseconds in
   * practice.  A replay therefore has to let that land before the event after it
   * goes out: otherwise the browser hit-tests a click against content a *later*
   * wheel has already moved, and the replay lands somewhere the recording never
   * was.
   */
  var WHEEL_LAND_MS = 600;

  /** How often a pending wheel is checked while waiting for it to land. */
  var WHEEL_POLL_MS = 20;

  /**
   * Playback state, mirrored onto the document element so the page (and the
   * automated tests) can observe it from the main world.
   */
  function setPlayState(value) {
    try {
      document.documentElement.setAttribute('data-emm-play', value);
    } catch (e) {
      /* detached document */
    }
  }

  /**
   * How the playback is being handed to the page: one event at a time, or as
   * fast as Chrome will take them.  The page says so out loud because from the
   * outside nothing else distinguishes the two, and a guarantee nobody can
   * observe is a guarantee that quietly stops being kept.
   */
  function setPlaySequencing(ordered) {
    try {
      document.documentElement.setAttribute('data-emm-play-ordered', ordered ? '1' : '0');
    } catch (e) {
      /* detached document */
    }
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  var rec = {
    active: false,
    buffer: [],
    startedAt: 0, // performance.now() of session start
    lastMove: null,
    // How many events the worker already holds.  The buffer is append-only
    // (pushEvent rejects, never rewrites), so this index stays true and an
    // off-the-end slice is always exactly what has not been handed over yet.
    sent: 0,
    timer: 0
  };

  /* How often the recording is handed to the worker while it is still being
   * made.  The buffer lives in this document, and a document that navigates is
   * gone: without these handovers, a link clicked mid-recording takes the whole
   * recording with it.  The worker only ever receives what it does not have. */
  var FLUSH_MS = 400;

  var play = {
    active: false,
    token: 0,
    mode: 'synthetic', // 'synthetic' | 'trusted'
    trustedBroken: false,
    ordered: false, // this recording is handed over one event at a time
    rep: 0,
    reps: 0
  };

  /** The trusted wheel whose scroll has not shown up in the page's offsets yet. */
  var wheel = { landing: null };

  var overlay = null;

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  function now() {
    return performance.now();
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          // Swallow "receiving end does not exist" etc. - callers treat
          // a falsy response as "service worker unavailable".
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** Sleep until an absolute performance.now() deadline (no drift build-up). */
  async function waitUntil(deadline) {
    for (var guard = 0; guard < 6; guard++) {
      var delta = deadline - now();
      if (delta <= 1.5) return;
      if (delta > 24) {
        // Coarse sleep, leaving 12ms for the final approach.
        await sleep(delta - 12);
        continue;
      }
      // Final approach: a short bounded spin keeps sub-frame timing honest and
      // can never hang (capped at the remaining time, which is <= 24ms).
      var spinUntil = now() + Math.min(delta, 24);
      while (now() < deadline && now() < spinUntil) {
        /* busy wait */
      }
      return;
    }
  }

  function baseFrom(ev) {
    return {
      clientX: ev.clientX,
      clientY: ev.clientY,
      pageX: isFiniteNumber(ev.pageX) ? ev.pageX : ev.clientX + window.scrollX,
      pageY: isFiniteNumber(ev.pageY) ? ev.pageY : ev.clientY + window.scrollY,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      button: ev.button,
      buttons: ev.buttons,
      detail: ev.detail,
      deltaX: ev.deltaX,
      deltaY: ev.deltaY,
      deltaMode: ev.deltaMode,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    };
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /* ------------------------------------------------------------------ *
   * Scroll containers inside the page
   *
   * A viewport coordinate says nothing about *which line of a scrollable panel*
   * was pointed at: the same pixel hits a different row after the panel
   * scrolled.  So the recorder remembers, for every click and wheel, how far the
   * scrollable elements around that point were scrolled, and the replay puts the
   * content back under the pointer before it dispatches.
   * ------------------------------------------------------------------ */

  /* overflow values that make an element a scroll container of its own. */
  var SCROLLABLE_OVERFLOW = { auto: 1, scroll: 1, overlay: 1 };

  /** Which axes of `el` can actually scroll right now (null: none of them). */
  function scrollableAxes(el) {
    if (!el || el.nodeType !== 1) return null;
    // The root scroller is covered by the event's sx / sy already.
    if (el === document.documentElement || el === document.body) return null;
    var cs;
    try {
      cs = window.getComputedStyle(el);
    } catch (e) {
      return null;
    }
    var axes = { x: false, y: false };
    if (el.scrollHeight - el.clientHeight > 1 && SCROLLABLE_OVERFLOW[cs.overflowY]) axes.y = true;
    if (el.scrollWidth - el.clientWidth > 1 && SCROLLABLE_OVERFLOW[cs.overflowX]) axes.x = true;
    return axes.x || axes.y ? axes : null;
  }

  /** Index path from <html> down to `el`, or null when it is not addressable. */
  function elementPath(el) {
    var path = [];
    var node = el;
    while (node && node !== document.documentElement) {
      var parent = node.parentNode;
      if (!parent || path.length >= core.LIMITS.MAX_SCROLL_PATH) return null;
      var siblings = parent.children || [];
      var index = -1;
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === node) {
          index = i;
          break;
        }
      }
      if (index < 0) return null; // detached, or above a shadow root
      path.push(index);
      node = parent;
    }
    return node === document.documentElement ? path.reverse() : null;
  }

  /** Snapshot the scroll offsets of every scrollable ancestor of `el`. */
  function scrollChainFor(el) {
    var chain = [];
    var node = el && el.nodeType === 1 ? el : null;
    while (node && node !== document.documentElement && chain.length < core.LIMITS.MAX_SCROLL_NODES) {
      var axes = scrollableAxes(node);
      if (axes) {
        var path = elementPath(node);
        if (path) {
          var entry = {
            p: path,
            g: node.tagName,
            x: axes.x ? node.scrollLeft : 0,
            y: axes.y ? node.scrollTop : 0
          };
          if (node.id) entry.i = node.id;
          chain.push(entry);
        }
      }
      node = node.parentElement;
    }
    return chain;
  }

  /** The element a recorded chain entry refers to now, or null. */
  function resolveScrollNode(entry) {
    if (!entry) return null;
    var candidates = [];
    if (typeof entry.i === 'string' && entry.i) {
      try {
        candidates.push(document.getElementById(entry.i));
      } catch (e) {
        /* detached document */
      }
    }
    var node = document.documentElement;
    var path = Array.isArray(entry.p) ? entry.p : [];
    for (var i = 0; i < path.length && node; i++) {
      node = (node.children || [])[path[i]] || null;
    }
    candidates.push(node);
    for (var c = 0; c < candidates.length; c++) {
      var el = candidates[c];
      if (!el || el.nodeType !== 1) continue;
      if (entry.g && el.tagName.toUpperCase() !== String(entry.g).toUpperCase()) continue;
      if (el === document.documentElement || el === document.body) continue;
      return el;
    }
    return null;
  }

  /**
   * Put the page's inner scroll containers back where the recorder saw them,
   * outermost first so the layout has settled before the next one is moved.
   */
  function restoreScrollChain(chain) {
    if (!Array.isArray(chain) || !chain.length) return;
    for (var i = chain.length - 1; i >= 0; i--) {
      var entry = core.normalizeScrollChain([chain[i]])[0];
      if (!entry) continue;
      var el = resolveScrollNode(entry);
      if (!el) continue;
      try {
        if (Math.abs(el.scrollTop - entry.y) > 0.5) el.scrollTop = entry.y;
        if (Math.abs(el.scrollLeft - entry.x) > 0.5) el.scrollLeft = entry.x;
      } catch (e) {
        /* the element stopped being scrollable; nothing sane to restore */
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Recording
   * ------------------------------------------------------------------ */

  function capture(type, ev) {
    if (!rec.active) return;
    var t = now() - rec.startedAt;
    var b = baseFrom(ev);
    if (type === 'move') {
      if (!core.shouldCaptureMove(rec.lastMove, b.clientX, b.clientY, t)) return;
    }
    if (type === 'wheel' && !(ev.deltaX || ev.deltaY)) return;
    if (type !== 'move') b.scrollChain = scrollChainFor(ev.target);
    var event = core.makeEvent(type, t, b);
    if (!event) return;
    var added = core.pushEvent(rec.buffer, event, 0);
    if (!added) return;
    if (type === 'move') rec.lastMove = event;
  }

  var handlers = {
    mousemove: function (ev) {
      capture('move', ev);
    },
    wheel: function (ev) {
      capture('wheel', ev);
    },
    mousedown: function (ev) {
      // Make sure the exact click position is in the trail, even if the
      // last kept move was throttled away.
      if (rec.active) {
        var t = now() - rec.startedAt;
        var b = baseFrom(ev);
        if (
          !rec.lastMove ||
          rec.lastMove.x !== b.clientX ||
          rec.lastMove.y !== b.clientY
        ) {
          var forced = core.makeEvent('move', t, b);
          if (forced && core.pushEvent(rec.buffer, forced, 0)) rec.lastMove = forced;
        }
      }
      capture('down', ev);
    },
    mouseup: function (ev) {
      capture('up', ev);
    },
    click: function (ev) {
      capture('click', ev);
    },
    dblclick: function (ev) {
      capture('dblclick', ev);
    },
    contextmenu: function (ev) {
      capture('contextmenu', ev);
    },
    keydown: function (ev) {
      captureKey(ev);
    }
  };

  /**
   * A key press is recorded as the press itself; each engine is expected to give
   * the page the release that belongs with it.  Only the keys core.normalizeKey
   * knows are kept, and the scroll chain is read from the *focused* element
   * rather than the event target: that is the content a Space pages.
   */
  function captureKey(ev) {
    if (!rec.active) return;
    var key = core.normalizeKey(ev);
    if (!key) return;
    var t = now() - rec.startedAt;
    var b = baseFrom(ev);
    b.key = key;
    b.shiftKey = !!ev.shiftKey;
    b.scrollChain = scrollChainFor(document.activeElement || ev.target);
    var event = core.makeEvent('key', t, b);
    if (!event) return;
    core.pushEvent(rec.buffer, event, 0);
  }

  function startRecording() {
    stopRecordingListeners();
    rec.active = true;
    rec.buffer = [];
    rec.lastMove = null;
    rec.sent = 0;
    rec.startedAt = now();
    Object.keys(handlers).forEach(function (name) {
      window.addEventListener(name, handlers[name], { capture: true, passive: true });
    });
    if (!rec.timer) rec.timer = setInterval(flushEvents, FLUSH_MS);
    // Seed the trail with the current pointer position where we can know it
    // (a move event supplies it otherwise); nothing to synthesize here.
  }

  /**
   * Hand the worker the events it does not have yet, and say where they start.
   * `first` lets the worker place them without trusting that every earlier
   * handover arrived: it keeps the first `first` of its own copy and appends
   * this one, which makes a repeated handover change nothing.
   */
  function flushEvents() {
    if (!rec.active) return;
    var tail = core.normalizeEvents(rec.buffer.slice(rec.sent));
    if (!tail.length) return;
    rec.sent += tail.length;
    send({ type: MSG + ':record-flush', first: rec.sent - tail.length, events: tail });
  }

  // A navigation is the case this exists for, and pagehide is the last moment
  // the buffer is still here.  Hidden is not a navigation, but a handover costs
  // nothing and a backgrounded tab is one discard away from losing the document.
  window.addEventListener('pagehide', function () {
    if (rec.active) flushEvents();
  });
  document.addEventListener('visibilitychange', function () {
    if (rec.active && document.visibilityState === 'hidden') flushEvents();
  });

  function stopRecordingListeners() {
    Object.keys(handlers).forEach(function (name) {
      window.removeEventListener(name, handlers[name], { capture: true });
    });
  }

  function stopRecording() {
    if (!rec.active) return core.normalizeEvents(rec.buffer);
    rec.active = false;
    if (rec.timer) {
      clearInterval(rec.timer);
      rec.timer = 0;
    }
    stopRecordingListeners();
    var events = core.normalizeEvents(rec.buffer);
    rec.buffer = [];
    rec.lastMove = null;
    return events;
  }

  /* ------------------------------------------------------------------ *
   * Ghost cursor overlay (visual feedback only, never steals input)
   * ------------------------------------------------------------------ */

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    var host = document.createElement('div');
    host.id = 'emm-overlay';
    var st = host.style;
    st.cssText = [
      'position:fixed',
      'inset:0',
      'width:0',
      'height:0',
      'margin:0',
      'padding:0',
      'border:0',
      'pointer-events:none',
      'z-index:2147483647',
      'left:0',
      'top:0'
    ].join(';');
    host.setAttribute('aria-hidden', 'true');

    var cursor = document.createElement('div');
    cursor.id = 'emm-ghost-cursor';
    cursor.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:22px',
      'height:22px',
      'margin:-11px 0 0 -11px',
      'border-radius:50%',
      'border:2px solid #fff',
      'background:rgba(198,40,40,.85)',
      'box-shadow:0 0 0 2px rgba(0,0,0,.45)',
      'pointer-events:none',
      'display:none',
      'will-change:transform'
    ].join(';');

    var ring = document.createElement('div');
    ring.id = 'emm-ghost-ring';
    ring.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:44px',
      'height:44px',
      'margin:-22px 0 0 -22px',
      'border-radius:50%',
      'border:3px solid rgba(198,40,40,.9)',
      'opacity:0',
      'pointer-events:none',
      'transform:scale(.4)'
    ].join(';');

    var badge = document.createElement('div');
    badge.id = 'emm-badge';
    badge.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'font:12px/1.4 system-ui,sans-serif',
      'color:#fff',
      'background:rgba(20,20,20,.85)',
      'padding:6px 10px',
      'border-radius:8px',
      'pointer-events:none',
      'display:none'
    ].join(';');

    host.appendChild(cursor);
    host.appendChild(ring);
    host.appendChild(badge);
    (document.body || document.documentElement).appendChild(host);
    overlay = host;
    return host;
  }

  function removeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function moveGhost(x, y) {
    if (!overlay) return;
    var c = overlay.querySelector('#emm-ghost-cursor');
    if (!c) return;
    c.style.display = 'block';
    c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  function pulseGhost(x, y, color) {
    if (!overlay) return;
    var r = overlay.querySelector('#emm-ghost-ring');
    if (!r) return;
    r.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(1)';
    r.style.opacity = '1';
    if (color) r.style.borderColor = color;
    setTimeout(function () {
      r.style.opacity = '0';
      r.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(.4)';
    }, 140);
  }

  function setBadge(text) {
    if (!overlay) return;
    var b = overlay.querySelector('#emm-badge');
    if (!b) return;
    if (!text) {
      b.style.display = 'none';
      return;
    }
    b.textContent = text;
    b.style.display = 'block';
  }

  /* ------------------------------------------------------------------ *
   * Synthetic dispatch (fallback path, pure DOM events)
   * ------------------------------------------------------------------ */

  var MOUSE_TYPE = {
    move: 'mousemove',
    down: 'mousedown',
    up: 'mouseup',
    click: 'click',
    dblclick: 'dblclick',
    contextmenu: 'contextmenu',
    wheel: 'wheel'
  };

  var POINTER_TYPE = { move: 'pointermove', down: 'pointerdown', up: 'pointerup' };

  function buildInit(x, y, ev) {
    var scrollX = window.scrollX;
    var scrollY = window.scrollY;
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: ev.detail | 0,
      screenX: x + (window.screenX | 0),
      screenY: y + (window.screenY | 0),
      clientX: x,
      clientY: y,
      pageX: isFiniteNumber(ev.px) ? ev.px : x + scrollX,
      pageY: isFiniteNumber(ev.py) ? ev.py : y + scrollY,
      movementX: 0,
      movementY: 0,
      button: ev.button | 0,
      buttons: ev.buttons | 0,
      relatedTarget: null
    };
  }

  /**
   * A scripted WheelEvent carries no scrolling of its own - the browser only
   * scrolls for real input - so the synthetic engine has to move the content by
   * hand, the way the wheel would have: the nearest scrollable element takes it,
   * and only if nothing there can move does the gesture reach the document.
   */
  function scrollFromSyntheticWheel(target, dx, dy) {
    var node = target && target.nodeType === 1 ? target : null;
    while (node && node !== document.documentElement) {
      var axes = scrollableAxes(node);
      if (axes) {
        var moved = false;
        if (axes.y && dy) {
          var maxY = node.scrollHeight - node.clientHeight;
          var wantY = core.clamp(node.scrollTop + dy, 0, maxY);
          if (Math.abs(wantY - node.scrollTop) > 0.5) {
            node.scrollTop = wantY;
            moved = true;
          }
        }
        if (axes.x && dx) {
          var maxX = node.scrollWidth - node.clientWidth;
          var wantX = core.clamp(node.scrollLeft + dx, 0, maxX);
          if (Math.abs(wantX - node.scrollLeft) > 0.5) {
            node.scrollLeft = wantX;
            moved = true;
          }
        }
        if (moved) return true; // a real wheel stops chaining once something moved
      }
      node = node.parentElement;
    }
    if (dx || dy) window.scrollBy(dx, dy);
    return true;
  }

  /**
   * The elements a Tab can reach, in the order the browser walks them.
   * Shadow trees are not entered - a content script sees the light DOM, and a
   * scripted focus move cannot cross a boundary the page never exposed.
   */
  var FOCUSABLE =
    'a[href],area[href],input:not([type="hidden"]):not([disabled]),' +
    'select:not([disabled]),textarea:not([disabled]),button:not([disabled]),' +
    'summary,iframe,[contenteditable="true"],[contenteditable=""],[tabindex]';

  /**
   * The stop a radio group offers to Tab.
   *
   * A group of same-named radios is *one* stop: the browser stops on the checked
   * button, or on the first when none is, and the rest are reached with the arrow
   * keys - which this recorder does not record.  Without this rule the synthetic
   * engine would hand the focus to every radio in turn and land somewhere else
   * than Chrome does.
   */
  function radioStop(node) {
    var members = document.getElementsByName(node.name);
    var stop = null;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (m.tagName !== 'INPUT' || String(m.type).toLowerCase() !== 'radio') continue;
      if (m.disabled || m.getClientRects().length === 0) continue;
      if (!stop) stop = m;
      if (m.checked) return m;
    }
    return stop;
  }

  function isTabbable(node) {
    if (!node || node.nodeType !== 1) return false;
    var ti = node.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) < 0) return false; // reachable only by script
    if (node.disabled) return false;
    // Nothing that takes no box can be focused, which also covers display:none
    // and visibility:hidden without asking the style engine per node.
    if (!node.getClientRects().length) return false;
    if (node.tagName === 'INPUT' && String(node.type).toLowerCase() === 'radio' && node.name) {
      return radioStop(node) === node;
    }
    return true;
  }

  /**
   * Chrome hands the focus to the browser UI after the last element on the page,
   * which no script can reach.  Wrapping around inside the document is the
   * closest honest equivalent, and keeps a long Tab macro replayable.
   */
  function tabFocus(back) {
    var nodes = document.querySelectorAll(FOCUSABLE);
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isTabbable(nodes[i])) list.push(nodes[i]);
    }
    if (!list.length) return null;
    var active = document.activeElement;
    var at = list.indexOf(active === document.body ? null : active);
    var next;
    if (at === -1) next = back ? list[list.length - 1] : list[0];
    else next = list[(at + (back ? -1 : 1) + list.length) % list.length];
    try {
      next.focus();
    } catch (e) {
      return null;
    }
    return next === document.activeElement ? next : null;
  }

  /** The page distance a Space covers: one screen, keeping a little context. */
  function pageStep(node) {
    var h = window.innerHeight;
    if (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      h = node.clientHeight || h;
    }
    return Math.max(48, Math.round(h) - 24);
  }

  /** Insert the space a text field would have received. */
  function insertSpace(node) {
    if (node.isContentEditable) {
      try {
        document.execCommand('insertText', false, ' ');
      } catch (e) {
        /* a blocked edit command is reported by the value check, not swallowed */
      }
      return;
    }
    var value = node.value || '';
    var start = isFiniteNumber(node.selectionStart) ? node.selectionStart : value.length;
    var end = isFiniteNumber(node.selectionEnd) ? node.selectionEnd : start;
    node.value = value.slice(0, start) + ' ' + value.slice(end);
    try {
      node.setSelectionRange(start + 1, start + 1);
    } catch (e) {
      /* some inputs refuse a caret; the text is still inserted */
    }
    node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ' ', inputType: 'insertText' }));
  }

  /**
   * What Chrome does with a Space, as far as a scripted event can imitate it:
   * a control that has a Space action is activated, a text field gets its space,
   * and anything else pages the content.  Two things are deliberately not
   * imitated: a link (Chrome activates links with Enter, never with Space) and a
   * focused <select>, whose popup is browser UI no script can open.
   */
  function spaceDefault(node, back) {
    var tag = node && node.tagName ? node.tagName.toLowerCase() : '';
    var type = node && node.type ? String(node.type).toLowerCase() : '';
    var isBody = !node || node === document.body || node === document.documentElement;
    if (!isBody) {
      var texty =
        tag === 'textarea' ||
        node.isContentEditable ||
        (tag === 'input' &&
          ['text', 'search', 'url', 'tel', 'email', 'password', 'number', ''].indexOf(type) !== -1);
      if (texty) {
        insertSpace(node);
        return 'text';
      }
      if (
        tag === 'button' ||
        tag === 'summary' ||
        (tag === 'input' && ['checkbox', 'radio', 'submit', 'button', 'reset'].indexOf(type) !== -1)
      ) {
        node.click(); // the activation Chrome performs on the keyup, change event included
        return 'activate';
      }
      if (tag === 'select') return 'ignored';
    }
    var step = pageStep(node);
    scrollFromSyntheticWheel(node || document.body, 0, back ? -step : step);
    return 'scroll';
  }

  function dispatchSyntheticKey(ev) {
    var spec = core.keySpec(ev.k);
    if (!spec) return { ok: false, error: 'unsupported key ' + ev.k };
    var node =
      document.activeElement && document.activeElement.nodeType === 1
        ? document.activeElement
        : document.body;
    var init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      key: spec.key,
      code: spec.code,
      keyCode: spec.keyCode,
      which: spec.keyCode,
      repeat: false,
      shiftKey: !!ev.sk,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false
    };
    var acted;
    var accepted;
    try {
      accepted = node.dispatchEvent(new KeyboardEvent('keydown', init));
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (accepted === false) {
      // A page handler cancelled the press, so no default action happens -
      // exactly as with real input.  The release is still owed to the page.
      acted = 'cancelled';
    } else if (spec.code === 'Tab') {
      // Chrome moves the focus after the keydown and before the keyup, so the
      // release is delivered to whatever the page is focused on now.
      acted = tabFocus(!!ev.sk) ? 'focus' : 'no-target';
      node =
        document.activeElement && document.activeElement.nodeType === 1
          ? document.activeElement
          : document.body;
    }
    try {
      node.dispatchEvent(new KeyboardEvent('keyup', init));
    } catch (e) {
      /* a listener that throws must not lose the press that already happened */
    }
    if (acted === undefined && spec.code !== 'Tab') {
      // And a Space activates - or pages - only once the release is in.
      acted = spaceDefault(node, !!ev.sk);
    }
    return { ok: true, dispatched: ['keydown', 'keyup'], acted: acted };
  }

  function dispatchSynthetic(ev) {
    if (ev.type === 'key') return dispatchSyntheticKey(ev);
    var pt = core.replayPoint(ev, window.scrollX, window.scrollY, ev.sx, ev.sy);
    var x = pt.x;
    var y = pt.y;
    if (x < -1 || y < -1 || x > window.innerWidth + 1 || y > window.innerHeight + 1) {
      // Point is outside the current viewport: keep the ghost honest, but do
      // not dispatch to an element that the user cannot see.
      return { ok: true, skipped: 'offscreen', x: x, y: y };
    }
    var target = document.elementFromPoint(x, y) || document.documentElement;
    var init = buildInit(x, y, ev);
    var type = MOUSE_TYPE[ev.type];
    if (!type) return { ok: false, error: 'unsupported type ' + ev.type };

    var dispatched = [];
    try {
      var pointerType = POINTER_TYPE[ev.type];
      if (pointerType && typeof window.PointerEvent === 'function') {
        var pinit = Object.assign({}, init, {
          pointerId: 1,
          pointerName: '',
          pointerType: 'mouse',
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: (ev.buttons | 0) !== 0 ? 0.5 : 0,
          tiltX: 0,
          tiltY: 0,
          twist: 0
        });
        target.dispatchEvent(new PointerEvent(pointerType, pinit));
        dispatched.push(pointerType);
      }
      if (ev.type === 'wheel') {
        var accepted = target.dispatchEvent(
          new WheelEvent(type, Object.assign({}, init, {
            deltaX: ev.dx || 0,
            deltaY: ev.dy || 0,
            deltaZ: 0,
            deltaMode: 0
          }))
        );
        dispatched.push(type);
        // The event reaches the page handlers first; the scrolling the browser
        // would have performed as its default action follows - and is skipped
        // when a handler cancelled it, exactly like real input.
        if (accepted !== false) scrollFromSyntheticWheel(target, ev.dx || 0, ev.dy || 0);
      } else {
        target.dispatchEvent(new MouseEvent(type, init));
        dispatched.push(type);
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
    return { ok: true, dispatched: dispatched, x: x, y: y };
  }

  /* ------------------------------------------------------------------ *
   * Trusted dispatch (relayed to the service worker / CDP)
   * ------------------------------------------------------------------ */

  /**
   * clientX/clientY are relative to the *visual* viewport.  CDP expects CSS
   * pixels relative to the layout viewport, so undo any pinch-zoom transform.
   */
  function toLayoutViewport(x, y) {
    var vv = window.visualViewport;
    if (!vv) return { x: x, y: y };
    var scale = isFiniteNumber(vv.scale) && vv.scale > 0 ? vv.scale : 1;
    var offLeft = isFiniteNumber(vv.offsetLeft) ? vv.offsetLeft : 0;
    var offTop = isFiniteNumber(vv.offsetTop) ? vv.offsetTop : 0;
    if (scale === 1 && offLeft === 0 && offTop === 0) return { x: x, y: y };
    return { x: x * scale + offLeft, y: y * scale + offTop };
  }

  function dispatchTrusted(ev) {
    var pt = core.replayPoint(ev, window.scrollX, window.scrollY, ev.sx, ev.sy);
    var lv = toLayoutViewport(pt.x, pt.y);
    var local = {
      t: ev.t,
      type: ev.type,
      x: lv.x,
      y: lv.y,
      px: ev.px,
      py: ev.py,
      sx: ev.sx,
      sy: ev.sy,
      button: ev.button,
      buttons: ev.buttons,
      detail: ev.detail,
      k: ev.k,
      sk: ev.sk,
      dx: ev.dx,
      dy: ev.dy,
      dmode: ev.dmode
    };
    return send({ type: MSG + ':trusted', event: local, ordered: play.ordered }).then(function (res) {
      if (!res || !res.ok) {
        return { ok: false, fatal: !!(res && res.fatal), error: res && res.error };
      }
      return { ok: true, x: pt.x, y: pt.y };
    });
  }

  /**
   * Await a trusted dispatch, but never longer than the schedule can afford.
   *
   * A chrome.debugger command is only answered once the renderer has taken the
   * input, which can take a frame - or, when the debugger pipeline is busy,
   * many times the gap between two recorded events.  Blocking the replay clock
   * on it would stretch the playback and silently defeat a high speed setting,
   * so after the budget we move on: the commands stay in order inside Chrome,
   * and a late failure only demotes the *remaining* events to synthetic.
   */
  /**
   * Whether a recording has to be handed to the page one event at a time.  See
   * the note above the input queue in the service worker: the order of a
   * recording that never touches a scroll is nothing the page can notice, while
   * a recording that scrolls content only lands on the recorded elements while
   * its events stay in sequence.  Sequencing costs throughput - the page sets
   * the pace instead of the schedule - so it is paid for only where it buys the
   * right answer.
   */
  function needsSequencing(events) {
    for (var i = 0; i < events.length; i++) {
      if (events[i].type === 'wheel' || events[i].type === 'key') return true;
      if (Array.isArray(events[i].sc) && events[i].sc.length) return true;
    }
    return false;
  }

  function dispatchBudgetFor(ev) {
    if (!play.ordered || ev.type === 'move') return DISPATCH_BUDGET_MS;
    return APPLY_BUDGET_MS;
  }

  function raceDispatch(promise, budgetMs) {
    var budget = sleep(budgetMs).then(function () {
      return { ok: true, pending: true };
    });
    return Promise.race([
      promise.then(function (res) {
        return res && res.ok ? { ok: true } : { ok: false, error: res && res.error };
      }),
      budget
    ]).then(
      function (r) {
        return r || { ok: false };
      },
      function () {
        return { ok: false };
      }
    );
  }

  /* ------------------------------------------------------------------ *
   * Scroll restoration
   * ------------------------------------------------------------------ */

  /**
   * The offsets an event expects the page to hold: the document's own scroll
   * first, then the scrollable panels inside it, outermost first.
   */
  function scrollTargets(ev) {
    var targets = [];
    if (isFiniteNumber(ev.sx) && isFiniteNumber(ev.sy)) {
      targets.push({ node: null, x: ev.sx, y: ev.sy });
    }
    var chain = Array.isArray(ev.sc) ? ev.sc : [];
    for (var i = 0; i < chain.length; i++) {
      var entry = core.normalizeScrollChain([chain[i]])[0];
      var node = entry ? resolveScrollNode(entry) : null;
      if (node) targets.push({ node: node, x: entry.x, y: entry.y });
    }
    return targets;
  }

  function holdsOffset(target) {
    if (target.node) {
      return (
        Math.abs(target.node.scrollTop - target.y) <= 1 &&
        Math.abs(target.node.scrollLeft - target.x) <= 1
      );
    }
    return Math.abs(window.scrollY - target.y) <= 1 && Math.abs(window.scrollX - target.x) <= 1;
  }

  /**
   * Wait for the offsets a wheel was supposed to produce.  Reading them from
   * here is reading the page's own main thread, so once they match, everything
   * the browser dispatched up to that point has been applied too, and the next
   * event can only land on content the recorded timeline already saw.
   */
  function waitForOffsets(targets, deadline) {
    return new Promise(function (resolve) {
      var check = function () {
        for (var i = 0; i < targets.length; i++) {
          if (!holdsOffset(targets[i])) {
            if (play.active && now() < deadline) return setTimeout(check, WHEEL_POLL_MS);
            return resolve();
          }
        }
        resolve();
      };
      check();
    });
  }

  async function restoreScroll(ev) {
    // A wheel carries the content into place by itself, and the offset recorded
    // with it is the outcome of that scroll - restoring it first would be one
    // notch too far.  The event after it waits for the wheel to land instead.
    if (ev.type === 'wheel') return;

    var targets = scrollTargets(ev);
    if (!targets.length) return;

    // While a trusted wheel is still travelling, the offsets we could read are
    // behind the browser's.  Waiting for the wheel to finish is what keeps a
    // fast replay in step with the recorded order; writing back an offset read
    // too early would fight the scroll on its way.  The deadline bounds it, so a
    // wheel that cannot land - a container that stopped being scrollable - does
    // not stall the replay, it just falls back to writing the recorded offsets.
    if (play.mode === 'trusted' && wheel.landing) {
      if (now() > wheel.landing.until) wheel.landing = null;
      else await waitForOffsets(targets, wheel.landing.until);
    }

    if (isFiniteNumber(ev.sx) && isFiniteNumber(ev.sy)) {
      if (Math.abs(window.scrollX - ev.sx) > 1 || Math.abs(window.scrollY - ev.sy) > 1) {
        try {
          // Plain scrollTo is instantaneous (no CSS smooth-scroll interpolation).
          window.scrollTo(ev.sx, ev.sy);
        } catch (e) {
          /* non-scrollable document */
        }
      }
    }
    // Then the scrollable panels inside the page: a click or wheel inside one of
    // them only lands on the recorded content while it holds the recorded offset.
    restoreScrollChain(ev.sc);
  }

  /* ------------------------------------------------------------------ *
   * Playback
   * ------------------------------------------------------------------ */

  async function startPlayback(payload) {
    var events = core.normalizeEvents(payload && payload.events);
    if (!events.length) {
      return { ok: false, error: 'Nothing has been recorded yet.' };
    }
    var reps = core.clampRepetitions(payload && payload.repetitions);
    var speed = core.clampSpeed(payload && payload.speed);
    var wantTrusted = !!(payload && payload.trusted);

    var token = ++play.token;
    play.active = true;
    play.rep = 0;
    play.reps = reps;
    play.mode = wantTrusted ? 'trusted' : 'synthetic';
    play.trustedBroken = false;
    // Only trusted input can need a sequence, and only a recording that scrolls
    // content gains anything from paying for one (see needsSequencing).  This is
    // deliberately read from the mode this playback is about to run in, not from
    // play.mode as it stands - which is the mode the *previous* playback left.
    play.ordered = play.mode === 'trusted' && needsSequencing(events);
    wheel.landing = null;
    setPlayState('running');
    setPlaySequencing(play.ordered);

    var schedule = core.buildSchedule(events, {
      repetitions: reps,
      speed: speed,
      interRepetitionMs: 400,
      leadInMs: 350
    });

    var trustedAvailable = true;
    if (play.mode === 'trusted') {
      var probe = await send({ type: MSG + ':trusted-ping' });
      trustedAvailable = !!(probe && probe.ok);
      if (!trustedAvailable) {
        play.mode = 'synthetic';
        play.trustedBroken = true;
      }
    }

    var summary = core.summarize(events);
    var expected = schedule.length;
    var sent = 0;
    var t0 = now();
    var lastMoveAt = 0;
    var currentRep = 0;

    ensureOverlay();
    setBadge('Playing\u2026 rep 1/' + reps);

    for (var i = 0; i < schedule.length; i++) {
      if (play.token !== token) break; // cancelled
      var item = schedule[i];
      await waitUntil(t0 + item.at);
      if (play.token !== token) break;

      var ev = item.event;
      if (item.repetition !== currentRep) {
        currentRep = item.repetition;
        play.rep = currentRep;
        setBadge('Playing\u2026 rep ' + currentRep + '/' + reps);
      }

      // Chrome folds several mouse moves that arrive within one frame into the
      // last one, so pushing the whole trail through as fast as possible would
      // flatten it.  Pace trusted moves to about one per frame and, when we are
      // behind the schedule, drop the older one - which is what real input
      // coalescing does to a fast user too.
      if (ev.type === 'move' && play.mode === 'trusted' && trustedAvailable) {
        var gate = lastMoveAt + MOVE_GATE_MS - now();
        if (gate > 0) {
          var nextAt = i + 1 < schedule.length ? schedule[i + 1].at : item.at + MOVE_GATE_MS;
          if (now() + gate > t0 + nextAt + 4) continue; // coalesce, never pile up
          await waitUntil(now() + gate);
          if (play.token !== token) break;
        }
        lastMoveAt = now();
      }

      await restoreScroll(ev);
      var pt = core.replayPoint(ev, window.scrollX, window.scrollY, ev.sx, ev.sy);
      // A key press has no place it happened, so the ghost stays where it was.
      if (ev.type !== 'key') moveGhost(pt.x, pt.y);
      if (ev.type === 'down') pulseGhost(pt.x, pt.y, ev.button === 2 ? 'rgba(239,108,0,.9)' : 'rgba(198,40,40,.9)');
      if (ev.type === 'wheel') pulseGhost(pt.x, pt.y, 'rgba(21,101,192,.9)');

      var result;
      if (play.mode === 'trusted' && trustedAvailable) {
        var pendingDispatch = dispatchTrusted(ev);
        result = await raceDispatch(pendingDispatch, dispatchBudgetFor(ev));
        if (result.ok) {
          // CDP input does not move the OS cursor, the ghost is the feedback.
          sent++;
          if (result.pending) {
            pendingDispatch.then(function (late) {
              if (!late || !late.ok) {
                trustedAvailable = false;
                play.mode = 'synthetic';
                play.trustedBroken = true;
              }
            });
          }
        } else {
          trustedAvailable = false;
          play.mode = 'synthetic';
          play.trustedBroken = true;
          result = dispatchSynthetic(ev);
          if (result.ok) sent++;
        }
      } else {
        result = dispatchSynthetic(ev);
        if (result.ok) sent++;
      }

      if (ev.type === 'wheel' && play.mode === 'trusted' && trustedAvailable) {
        // Chrome is applying that scroll on the compositor now, and the page's
        // own offsets only show it after a sync (see WHEEL_LAND_MS).  The next
        // event waits for that to land rather than guessing a moment.
        wheel.landing = { until: now() + WHEEL_LAND_MS };
      }

      // A page that is still catching up makes every event after it "due" at
      // once.  Carry the delay instead: the timeline keeps its shape, it just
      // ends later, which is what a machine that lags does to a real hand too.
      if (play.ordered) {
        var lateness = now() - (t0 + item.at);
        if (lateness > LAG_SHIFT_MS) t0 += lateness;
      }
    }

    var cancelled = play.token === token ? false : true;
    if (!cancelled) {
      // Let the last pulse breathe before cleaning up.
      await sleep(180);
    }
    var wasCurrent = play.token === token;
    if (wasCurrent) {
      play.active = false;
      play.mode = 'synthetic';
      removeOverlay();
      setPlayState('finished');
    }

    var finish = {
      ok: true,
      cancelled: cancelled,
      scheduled: expected,
      dispatched: sent,
      mode: play.trustedBroken ? 'synthetic(fallback)' : play.mode,
      events: summary.count,
      durationMs: Math.round(now() - t0),
      plannedMs: Math.round(core.scheduleDuration(schedule))
    };

    if (wasCurrent) {
      send({ type: MSG + ':play-done', stats: finish });
    }
    return finish;
  }

  function stopPlayback() {
    play.token++;
    play.active = false;
    play.mode = 'synthetic';
    removeOverlay();
    setPlayState('stopped');
  }

  /* ------------------------------------------------------------------ *
   * Message router
   * ------------------------------------------------------------------ */

  function getState() {
    return {
      ok: true,
      recording: rec.active,
      playing: play.active,
      buffered: rec.buffer.length,
      mode: play.mode,
      // While recording, the buffer is the live truth: report it so the popup
      // counts events as they happen instead of only after stopping.
      live: rec.active ? core.summarize(rec.buffer) : null
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf(MSG) !== 0) return;

    if (msg.type === MSG + ':ping') {
      respond(getState());
      return;
    }

    if (msg.type === MSG + ':record-start') {
      startRecording();
      respond({ ok: true, recording: true });
      return;
    }

    if (msg.type === MSG + ':record-stop') {
      var events = stopRecording();
      respond({ ok: true, events: events, count: events.length });
      return;
    }

    if (msg.type === MSG + ':record-discard') {
      stopRecording();
      respond({ ok: true });
      return;
    }

    if (msg.type === MSG + ':play') {
      startPlayback(msg)
        .then(function (stats) {
          respond(stats);
        })
        .catch(function (e) {
          respond({ ok: false, error: String(e && e.message ? e.message : e) });
        });
      return true; // async
    }

    if (msg.type === MSG + ':play-stop') {
      stopPlayback();
      respond({ ok: true });
      return;
    }
  });

  // Announce ourselves so the service worker can track live tabs.
  send({ type: MSG + ':hello' });
})();
