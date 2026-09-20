/*
 * Easy Mouse Macro - MV3 service worker.
 *
 * Owns the authoritative session state (what was recorded, in which tab),
 * survives popup shutdowns, and provides the "trusted input" replay engine by
 * relaying recorded events to chrome.debugger -> CDP Input.dispatchMouseEvent,
 * which the page sees as genuine user input.
 *
 * The replay *clock* deliberately lives in the content script: a service
 * worker can be killed at any moment, a page cannot.
 */
importScripts('lib/macro-core.js');

var core = self.EMMCore;
var MSG = 'emm';
var SESSION_PREFIX = 'session:';
var HISTORY_KEY = 'history';
var SETTINGS_KEY = 'settings';
/* How long a recording that ended in a navigation waits before it is filed. The
 * page hands its buffer over as the document goes away, and that message and the
 * tab-changed event travel by different roads: filing immediately would often
 * file the recording as it looked a few hundred milliseconds before the click. */
var FILING_SETTLE_MS = 400;
var CDP_VERSION = '1.3';

/** tabId -> { recording, events, playing, trustedAttached, from } */
var sessions = new Map();
var lastKnownTabId = null;

/* ------------------------------------------------------------------ *
 * Session helpers
 * ------------------------------------------------------------------ */

function getSession(tabId) {
  var s = sessions.get(tabId);
  if (!s) {
    // `from` is the history entry this recording slot was filled from, or null
    // for something recorded here.  It exists so the popup can mark the row that
    // is loaded, and so nothing looks like a fresh recording by accident.
    s = {
      recording: false,
      events: [],
      playing: false,
      from: null,
      /* Why a recording that the user did not stop came to an end, and whether
       * the macro it left behind has been filed yet. */
      endedBy: null,
      endedError: null,
      filed: true
    };
    sessions.set(tabId, s);
  }
  return s;
}

function isInjectableUrl(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url);
}

function isOwnPage(url) {
  var base = chrome.runtime.getURL('');
  return typeof url === 'string' && url.indexOf(base) === 0;
}

function persist(tabId, session) {
  var payload = {};
  payload[SESSION_PREFIX + tabId] = {
    events: session.events,
    from: session.from || null,
    endedBy: session.endedBy || null,
    endedError: session.endedError || null,
    savedAt: Date.now()
  };
  return chrome.storage.session
    .set(payload)
    .catch(function () {
      /* quota / unavailable: the in-memory copy still works */
    });
}

async function restoreSession(tabId) {
  var key = SESSION_PREFIX + tabId;
  try {
    var got = await chrome.storage.session.get(key);
    var entry = got && got[key];
    if (entry && Array.isArray(entry.events)) {
      var s = getSession(tabId);
      if (!s.events.length) {
        s.events = core.normalizeEvents(entry.events);
        if (typeof entry.from === 'string') s.from = entry.from;
        if (typeof entry.endedBy === 'string') s.endedBy = entry.endedBy;
        if (typeof entry.endedError === 'string') s.endedError = entry.endedError;
      }
      return s;
    }
  } catch (e) {
    /* ignore */
  }
  return getSession(tabId);
}

function setBadge(tabId, text, color) {
  var details = { tabId: tabId, text: text || '' };
  chrome.action.setBadgeText(details).catch(function () {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color || '#c62828' }).catch(function () {});
  }
}

/* ------------------------------------------------------------------ *
 * Target tab resolution
 * ------------------------------------------------------------------ */

async function resolveTargetTab(hintTabId) {
  if (hintTabId && sessions.get(hintTabId) && sessions.get(hintTabId).recording) {
    return hintTabId;
  }

  var candidates = [];
  try {
    var tabs = await chrome.tabs.query({ currentWindow: true });
    candidates = tabs.filter(function (t) {
      return t.id && !isOwnPage(t.url) && isInjectableUrl(t.url);
    });
  } catch (e) {
    candidates = [];
  }

  // Prefer the hint tab when it is a real web page.
  if (typeof hintTabId === 'number') {
    try {
      var hint = await chrome.tabs.get(hintTabId);
      if (hint && hint.id && isInjectableUrl(hint.url) && !isOwnPage(hint.url)) {
        return hint.id;
      }
    } catch (e) {
      /* fall through */
    }
  }

  if (typeof lastKnownTabId === 'number') {
    try {
      var tracked = await chrome.tabs.get(lastKnownTabId);
      if (tracked && tracked.id && isInjectableUrl(tracked.url) && !isOwnPage(tracked.url)) {
        return tracked.id;
      }
    } catch (e) {
      /* fall through */
    }
  }

  if (candidates.length) {
    var active = candidates.filter(function (t) {
      return t.active;
    });
    return (active[0] || candidates[candidates.length - 1]).id;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Content-script RPC
 * ------------------------------------------------------------------ */

async function ensureContent(tabId) {
  try {
    var res = await chrome.tabs.sendMessage(tabId, { type: MSG + ':ping' });
    if (res && res.ok) return res;
  } catch (e) {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['lib/macro-core.js', 'content.js']
    });
  } catch (e) {
    return { ok: false, error: 'Cannot inject into this page: ' + String(e && e.message ? e.message : e) };
  }
  try {
    return await chrome.tabs.sendMessage(tabId, { type: MSG + ':ping' });
  } catch (e) {
    return { ok: false, error: 'Content script did not answer: ' + String(e && e.message ? e.message : e) };
  }
}

function tabSend(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(function (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  });
}

/* ------------------------------------------------------------------ *
 * Trusted input engine (chrome.debugger / CDP)
 * ------------------------------------------------------------------ */

var attached = new Set();
var cdpDisabled = new Set(); // tabs where attaching is impossible

async function attach(tabId) {
  if (attached.has(tabId)) return { ok: true };
  if (cdpDisabled.has(tabId)) return { ok: false, fatal: true, error: 'CDP unavailable for this tab' };
  try {
    await chrome.debugger.attach({ tabId: tabId }, CDP_VERSION);
    attached.add(tabId);
    return { ok: true };
  } catch (e) {
    var message = String(e && e.message ? e.message : e);
    // "Cannot access" / "Another debugger" / restricted page: never retry.
    if (/Cannot access|restricted|another debugger|in use|not allowed|Cannot attach/i.test(message)) {
      cdpDisabled.add(tabId);
      return { ok: false, fatal: true, error: message };
    }
    return { ok: false, error: message };
  }
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId: tabId });
  } catch (e) {
    /* already gone */
  }
}

/* Recorded input reaches the page as a Chrome DevTools Protocol command, and
 * commands sent close together race: whichever attach() settles first is the one
 * Chrome applies first. Most recordings cannot tell - a click lands on whatever
 * is under its coordinates, whenever it gets there - and they are sent straight
 * through, which is what lets a 10x replay stay 10x fast: several commands are
 * in flight at once, as fast as Chrome acknowledges them.
 *
 * A recording that touches scrolling is different. Inside a scrollable panel an
 * event lands on the content the recording saw only while the events run in the
 * recorded order, because a click is hit-tested on the renderer main thread
 * while a wheel is still scrolling on the compositor: queued behind a wheel that
 * the recording fired later, it hits a row nothing ever pointed at. Those
 * recordings - the content script marks them with `ordered` - go through one
 * chain per tab, so the page is given them one at a time, in order. */
var inputQueue = new Map();

function queueInput(tabId, task) {
  var previous = inputQueue.get(tabId) || Promise.resolve();
  var next = previous.then(task, task);
  var tail = next.then(
    function () {},
    function () {}
  );
  inputQueue.set(tabId, tail);
  tail.then(function () {
    // Once the queue has fully drained, forget it: a worker that lives for days
    // should not keep an entry per tab it ever touched.
    if (inputQueue.get(tabId) === tail) inputQueue.delete(tabId);
  });
  return next;
}

async function dispatchTrusted(tabId, event, ordered) {
  if (!ordered) return sendTrusted(tabId, event);
  return queueInput(tabId, function () {
    return sendTrusted(tabId, event);
  });
}

/**
   * Hand one recorded event to Chrome as real input.
   *
   * A mouse event maps to one CDP command.  A recorded key press is not one
   * command: the page has to see the keydown *and* the keyup, because that is
   * where Chrome performs the activation of a focused control.  Both commands
   * go out from this one queue entry, so the sequence stays what the user did.
   */
async function sendTrusted(tabId, event) {
  var a = await attach(tabId);
  if (!a.ok) return a;
  var commands = [];
  if (event && event.type === 'key') {
    var keys = core.toCdpKeyCommands(event);
    for (var i = 0; i < keys.length; i++) {
      commands.push({ method: 'Input.dispatchKeyEvent', params: keys[i] });
    }
  } else {
    var params = core.toCdpParams(event, 1);
    if (params) commands.push({ method: 'Input.dispatchMouseEvent', params: params });
  }
  if (!commands.length) return { ok: true, ignored: true };
  try {
    for (var j = 0; j < commands.length; j++) {
      await chrome.debugger.sendCommand({ tabId: tabId }, commands[j].method, commands[j].params);
    }
    return { ok: true };
  } catch (e) {
    var message = String(e && e.message ? e.message : e);
    attached.delete(tabId);
    if (/Detached|no longer|Cannot access|target closed/i.test(message)) {
      cdpDisabled.add(tabId);
      return { ok: false, fatal: true, error: message };
    }
    return { ok: false, error: message };
  }
}

chrome.debugger.onDetach.addListener(function (source) {
  if (source && typeof source.tabId === 'number') {
    attached.delete(source.tabId);
    cdpDisabled.add(source.tabId);
  }
});

/* ------------------------------------------------------------------ *
 * Recording orchestration
 * ------------------------------------------------------------------ */

async function startRecording(tabId) {
  var content = await ensureContent(tabId);
  if (!content || !content.ok) return { ok: false, error: content && content.error };
  var res = await tabSend(tabId, { type: MSG + ':record-start' });
  if (!res || !res.ok) return { ok: false, error: res && res.error };
  var s = getSession(tabId);
  s.recording = true;
  s.events = [];
  s.playing = false;
  s.from = null;
  s.endedBy = null;
  s.endedError = null;
  s.filed = false;
  setBadge(tabId, 'REC', '#c62828');
  await persist(tabId, s);
  return { ok: true, tabId: tabId };
}

async function stopRecording(tabId) {
  var res = await tabSend(tabId, { type: MSG + ':record-stop' });
  var s = getSession(tabId);
  s.recording = false;
  // A Stop is the end of a recording by the user's own hand: it replaces any
  // earlier note about how a recording ended, and nothing is filed twice.
  s.endedBy = null;
  s.endedError = null;
  s.filed = true;
  setBadge(tabId, '');
  if (!res || !res.ok) {
    await persist(tabId, s);
    return { ok: false, error: res && res.error, events: s.events };
  }
  s.events = core.normalizeEvents(res.events);
  await persist(tabId, s);
  var out = { ok: true, tabId: tabId, events: s.events, summary: core.summarize(s.events) };
  if (!s.events.length) return out;
  // Filing is the last thing a Stop does, and a failure to file must not turn a
  // successful recording into a failed one: the macro stays loaded either way.
  try {
    out.history = await fileRecording(tabId, s.events);
  } catch (e) {
    out.historyError = 'Recorded, but the history could not be written: ' + String((e && e.message) || e);
  }
  return out;
}

/**
 * Accept the events the page has recorded since its last handover.
 *
 * The recording is made in the page, and a page that navigates is destroyed -
 * taking its buffer with it - so the page sends each new event over as it makes
 * one.  `first` says where this slice begins, which lets the worker keep the
 * part it already has and append the rest: a handover that arrives twice then
 * changes nothing, and one that arrives late costs nothing but its own delay.
 *
 * The worker is only told about its own recording - a handover from a tab that
 * stopped recording here (a Stop, a clear) is stale by definition and is
 * dropped.  This is also what keeps a recording alive across a long session:
 * the handover is a message, and a message restarts the worker's idle timer.
 */
async function absorbFlush(tabId, msg) {
  var s = await restoreSession(tabId);
  if (!s.recording) return { ok: true, ignored: true, events: s.events.length };
  var first = Number(msg.first);
  var start = isFinite(first) && first > 0 ? Math.floor(first) : 0;
  var tail = core.normalizeEvents(msg.events);
  if (tail.length) {
    s.events = core.normalizeEvents(s.events.slice(0, start).concat(tail));
    await persist(tabId, s);
  }
  return { ok: true, events: s.events.length };
}

/**
 * A recording ended because the page it was being made on went away.
 *
 * The recording stops - that part is the nature of the browser, not a choice we
 * can revoke: the document that held the recorder is gone.  What is not
 * acceptable is that the macro goes with it, so the worker files it in the
 * history and leaves it loaded in the tab, where Play can still use it.
 */
function endRecordingAtNavigation(tabId, session) {
  session.recording = false;
  session.endedBy = 'navigation';
  session.endedError = null;
  session.filed = false;
  setBadge(tabId, '');
  persist(tabId, session);
  setTimeout(function () {
    fileNavigationRecording(tabId).catch(function () {
      /* the recording is still in the tab; see the note in the popup */
    });
  }, FILING_SETTLE_MS);
}

async function fileNavigationRecording(tabId) {
  var s = sessions.get(tabId);
  if (!s || s.filed) return;
  s.filed = true;
  if (!s.events.length) {
    await persist(tabId, s);
    return;
  }
  try {
    await fileRecording(tabId, s.events);
  } catch (e) {
    // A lost macro must be said out loud. The copy in the tab is unaffected, so
    // Play still works - it is the keeping that failed.
    s.endedError = 'Navigation ended the recording, and it could not be saved: ' + String((e && e.message) || e);
  }
  await persist(tabId, s);
}

async function clearSession(tabId) {
  var s = getSession(tabId);
  s.events = [];
  s.recording = false;
  s.playing = false;
  s.from = null;
  s.endedBy = null;
  s.endedError = null;
  s.filed = true;
  await tabSend(tabId, { type: MSG + ':record-discard' });
  await detach(tabId);
  cdpDisabled.delete(tabId);
  setBadge(tabId, '');
  try {
    await chrome.storage.session.remove(SESSION_PREFIX + tabId);
  } catch (e) {
    /* ignore */
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * History - the last few finished macros
 *
 * The per-tab session lives in chrome.storage.session, which Chrome throws away
 * when the browser closes; a macro worth keeping is filed in
 * chrome.storage.local instead, which is why the history is still there after a
 * restart and in a different tab.  `history` mirrors that key in memory, and
 * every change goes through historyTask() so two recordings stopping at once
 * cannot each write a list that lacks the other's entry.
 * ------------------------------------------------------------------ */

var history = null;
var settings = null;
var historyQueue = Promise.resolve();

function historyTask(task) {
  var run = historyQueue.then(task, task);
  historyQueue = run.then(
    function () {},
    function () {}
  );
  return run;
}

/**
 * The settings the user can change, kept beside the history rather than in
 * chrome.storage.sync: they describe how much of the history to keep, and a
 * setting that disagreed with the list it governs would be worse than a
 * slightly slower startup.
 */
async function loadSettings() {
  if (settings) return settings;
  var stored = null;
  try {
    var got = await chrome.storage.local.get(SETTINGS_KEY);
    stored = got && got[SETTINGS_KEY];
  } catch (e) {
    stored = null;
  }
  settings = { historyLimit: core.normalizeLimit(stored && stored.historyLimit) };
  return settings;
}

/** How many finished macros to keep, as the user last asked for. */
async function historyLimit() {
  return (await loadSettings()).historyLimit;
}

async function loadHistory() {
  if (history) return history;
  var limit = await historyLimit();
  try {
    var got = await chrome.storage.local.get(HISTORY_KEY);
    history = core.normalizeHistory(got && got[HISTORY_KEY], limit);
  } catch (e) {
    history = [];
  }
  return history;
}

async function saveHistory() {
  var payload = {};
  payload[HISTORY_KEY] = history || [];
  await chrome.storage.local.set(payload);
}

/** The host a macro was recorded on - the only context a row can offer. */
function hostOf(url) {
  try {
    return new URL(url).host || '';
  } catch (e) {
    return '';
  }
}

/** File a finished macro.  Resolves to the rows, or throws - and the caller
 *  decides how loudly a lost macro is reported, because the recording itself is
 *  never lost with it: it stays loaded in the tab that made it. */
async function fileRecording(tabId, events) {
  var host = '';
  try {
    var tab = await chrome.tabs.get(tabId);
    host = hostOf(tab.url);
  } catch (e) {
    /* a tab closed while stopping still leaves its macro */
  }
  return await historyTask(async function () {
    var list = await loadHistory();
    var limit = await historyLimit();
    history = core.addHistoryEntry(list, { savedAt: Date.now(), host: host, events: events }, limit);
    await saveHistory();
    return core.historyRows(history);
  });
}

async function readHistory() {
  return core.historyRows(await loadHistory());
}

async function deleteHistoryEntry(id) {
  return await historyTask(async function () {
    var list = await loadHistory();
    var res = core.removeHistoryEntry(list, id);
    history = res.history;
    await saveHistory();
    // A macro that is gone must not stay marked as the loaded one: the row that
    // carried the mark is about to disappear, and a tab still holding its copy
    // of the events is a recording slot like any other.
    sessions.forEach(function (session) {
      if (session.from === id) session.from = null;
    });
    return { ok: true, removed: res.removed, history: core.historyRows(history) };
  });
}

/**
 * Name a stored macro, or clear its name to hand it back the label derived from
 * where and when it was recorded.
 */
async function renameHistoryEntry(id, name) {
  return await historyTask(async function () {
    var list = await loadHistory();
    var res = core.setHistoryName(list, id, name);
    if (!res.renamed) return { ok: false, error: 'That macro is no longer in the history.' };
    history = res.history;
    await saveHistory();
    return { ok: true, history: core.historyRows(history) };
  });
}

/**
 * Change how many macros are kept.  Lowering the cap trims the list at once
 * rather than letting it sit over the limit until the next recording pushes
 * something out: a setting should describe what the user has, not only what
 * happens next.
 */
async function setHistoryLimit(value) {
  return await historyTask(async function () {
    var limit = core.normalizeLimit(value);
    var st = await loadSettings();
    st.historyLimit = limit;
    try {
      var payload = {};
      payload[SETTINGS_KEY] = { historyLimit: limit };
      await chrome.storage.local.set(payload);
    } catch (e) {
      return { ok: false, error: 'The setting could not be saved: ' + String((e && e.message) || e) };
    }
    var list = await loadHistory();
    var kept = core.normalizeHistory(list, limit);
    var trimmed = kept.length !== list.length;
    history = kept;
    if (trimmed) await saveHistory();
    return { ok: true, historyLimit: limit, history: core.historyRows(history) };
  });
}

async function clearHistory() {
  return await historyTask(async function () {
    history = [];
    sessions.forEach(function (session) {
      session.from = null;
    });
    try {
      await chrome.storage.local.remove(HISTORY_KEY);
    } catch (e) {
      /* ignore */
    }
    return { ok: true, history: [] };
  });
}

/**
 * Put a stored macro into a tab's recording slot, which is where Play looks.
 * Deliberately nothing is sent to the page: a macro can be picked up on a tab
 * the extension cannot even inject into, and pressing Play there stays the
 * user's own decision.
 */
async function loadHistoryEntry(tabId, id) {
  var s = getSession(tabId);
  if (s.recording) return { ok: false, error: 'Stop the recording before loading a macro from the history.' };
  var events = core.historyEvents(await loadHistory(), id);
  if (!events) return { ok: false, error: 'That macro is no longer in the history.' };
  s.events = events;
  s.playing = false;
  s.from = id;
  await persist(tabId, s);
  return { ok: true, tabId: tabId, events: s.events.length, summary: core.summarize(s.events) };
}

async function beginPlayback(tabId, opts) {
  var s = await restoreSession(tabId);
  if (!s.events.length) return { ok: false, error: 'Nothing has been recorded yet.' };
  var content = await ensureContent(tabId);
  if (!content || !content.ok) return { ok: false, error: content && content.error };

  var reps = core.clampRepetitions(opts.repetitions);
  var speed = core.clampSpeed(opts.speed);
  var trusted = opts.trusted !== false;

  s.playing = true;
  setBadge(tabId, 'RUN', '#1565c0');

  var payload = {
    type: MSG + ':play',
    events: s.events,
    repetitions: reps,
    speed: speed,
    trusted: trusted
  };
  // Fire and forget: the content script runs the clock and reports back with
  // emm:play-done.  Awaiting here would keep the worker alive unnecessarily.
  tabSend(tabId, payload);
  return {
    ok: true,
    tabId: tabId,
    repetitions: reps,
    speed: speed,
    trusted: trusted,
    events: s.events.length,
    summary: core.summarize(s.events)
  };
}

async function stopPlayback(tabId) {
  await tabSend(tabId, { type: MSG + ':play-stop' });
  var s = getSession(tabId);
  s.playing = false;
  setBadge(tabId, s.recording ? 'REC' : '');
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Keyboard commands (the manifest "commands" block)
 * ------------------------------------------------------------------ */

/**
 * Body of a keyboard command, for the tab Chrome reports as focused.
 *
 * It is a separate function because an OS-level accelerator cannot be
 * synthesised from a test: driving this entry point through `emm:command`
 * (accepted from extension contexts only, see the message router) exercises the
 * exact code path a real key press takes.
 */
async function runCommand(name, tabId) {
  var hint = typeof tabId === 'number' ? tabId : null;
  var target = await resolveTargetTab(hint);
  if (target === null || target === undefined) {
    return { ok: false, error: 'No usable web tab found.' };
  }

  if (name === 'emm-toggle-record') {
    var s = await restoreSession(target);
    var recording = s.recording;
    if (!recording) {
      // The page may be recording without the worker knowing (worker restart).
      try {
        var ping = await chrome.tabs.sendMessage(target, { type: MSG + ':ping' });
        recording = !!(ping && ping.recording);
      } catch (e) {
        recording = false;
      }
    }
    return recording ? await stopRecording(target) : await startRecording(target);
  }

  if (name === 'emm-stop-playback') return await stopPlayback(target);

  return { ok: false, error: 'unknown command ' + name };
}

chrome.commands.onCommand.addListener(function (command, tab) {
  runCommand(command, tab && typeof tab.id === 'number' ? tab.id : null).catch(function () {
    /* a shortcut press cannot show a dialog; the badge is the feedback */
  });
});

/* ------------------------------------------------------------------ *
 * State snapshot used by the popup
 * ------------------------------------------------------------------ */

async function buildState(hintTabId) {
  // The rows only - a macro's events never travel to the popup, which asks four
  // times a second and shows one line per macro.
  var rows = await readHistory().catch(function () {
    return [];
  });
  var tabId = await resolveTargetTab(hintTabId);
  if (tabId === null || tabId === undefined) {
    var limit = await historyLimit();
    return { ok: true, tabId: null, hasRecording: false, recording: false, playing: false, summary: core.summarize([]), live: null, url: null, loadedFrom: null, endedBy: null, endedError: null, historyLimit: limit, history: rows };
  }
  var s = await restoreSession(tabId);
  var content = null;
  try {
    content = await chrome.tabs.sendMessage(tabId, { type: MSG + ':ping' });
  } catch (e) {
    content = null;
  }
  var url = null;
  var title = null;
  try {
    var tab = await chrome.tabs.get(tabId);
    url = tab.url;
    title = tab.title;
  } catch (e) {
    /* ignore */
  }
  return {
    ok: true,
    tabId: tabId,
    url: url,
    title: title,
    recording: !!(s.recording || (content && content.recording)),
    playing: !!(s.playing || (content && content.playing)),
    hasRecording: s.events.length > 0,
    summary: core.summarize(s.events),
    live: (content && content.live) || null,
    injectable: isInjectableUrl(url) && !isOwnPage(url),
    loadedFrom: s.from || null,
    endedBy: s.events.length ? s.endedBy || null : null,
    endedError: s.events.length ? s.endedError || null : null,
    historyLimit: await historyLimit(),
    history: rows
  };
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf(MSG) !== 0) return;

  var fromTab =
    sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;

  var run = async function () {
    switch (msg.type) {
      case MSG + ':state':
        return await buildState(typeof msg.tabId === 'number' ? msg.tabId : fromTab);

      case MSG + ':record-start': {
        var tabId = await resolveTargetTab(msg.tabId);
        if (tabId === null) return { ok: false, error: 'No usable web tab found.' };
        return await startRecording(tabId);
      }

      case MSG + ':record-stop': {
        var stopId = await resolveTargetTab(msg.tabId);
        if (stopId === null) return { ok: false, error: 'No usable web tab found.' };
        return await stopRecording(stopId);
      }

      case MSG + ':play': {
        var playId = await resolveTargetTab(msg.tabId);
        if (playId === null) return { ok: false, error: 'No usable web tab found.' };
        return await beginPlayback(playId, msg);
      }

      case MSG + ':play-stop': {
        var stopPlayId = await resolveTargetTab(msg.tabId);
        if (stopPlayId === null) return { ok: false, error: 'No usable web tab found.' };
        return await stopPlayback(stopPlayId);
      }

      case MSG + ':clear': {
        var clearId = await resolveTargetTab(msg.tabId);
        if (clearId === null) return { ok: false, error: 'No usable web tab found.' };
        return await clearSession(clearId);
      }

      case MSG + ':history':
        return { ok: true, history: await readHistory() };

      case MSG + ':history-load': {
        var loadId = await resolveTargetTab(msg.tabId);
        if (loadId === null) return { ok: false, error: 'No usable web tab found.' };
        return await loadHistoryEntry(loadId, msg.id);
      }

      case MSG + ':history-delete':
        return await deleteHistoryEntry(msg.id);

      case MSG + ':history-rename':
        return await renameHistoryEntry(msg.id, msg.name);

      case MSG + ':history-limit':
        return await setHistoryLimit(msg.limit);

      case MSG + ':record-flush': {
        if (fromTab === null) return { ok: false, error: 'No sender tab.' };
        return await absorbFlush(fromTab, msg);
      }

      case MSG + ':history-clear':
        return await clearHistory();

      case MSG + ':trusted':
        if (fromTab === null) return { ok: false, error: 'No sender tab.' };
        return await dispatchTrusted(fromTab, msg.event, !!msg.ordered);

      case MSG + ':trusted-ping': {
        if (fromTab === null) return { ok: false, error: 'No sender tab.' };
        var probe = await attach(fromTab);
        return probe.ok ? { ok: true } : probe;
      }

      case MSG + ':play-done': {
        if (fromTab === null) return { ok: false };
        var done = getSession(fromTab);
        done.playing = false;
        setBadge(fromTab, done.recording ? 'REC' : '');
        return { ok: true, stats: msg.stats };
      }

      case MSG + ':command': {
        // Same path a keyboard shortcut takes.  Only this extension's own pages
        // may call it: a content script runs inside a web page, and a keyboard
        // shortcut stands for the user, which a page must not be able to fake.
        var fromOwnPage = sender && isOwnPage(sender.url);
        if (!fromOwnPage) return { ok: false, error: 'Extension contexts only.' };
        if (typeof msg.name !== 'string') return { ok: false, error: 'Missing command name.' };
        return await runCommand(msg.name, typeof msg.tabId === 'number' ? msg.tabId : null);
      }

      case MSG + ':hello': {
        if (fromTab !== null) await restoreSession(fromTab);
        return { ok: true };
      }

      default:
        return { ok: false, error: 'unknown message ' + msg.type };
    }
  };

  run().then(respond).catch(function (e) {
    respond({ ok: false, error: String(e && e.message ? e.message : e) });
  });
  return true; // async
});

/* ------------------------------------------------------------------ *
 * Tab lifecycle
 * ------------------------------------------------------------------ */

function trackTab(tabId) {
  if (typeof tabId !== 'number') return;
  Promise.resolve(chrome.tabs.get(tabId))
    .then(function (tab) {
      if (tab && isInjectableUrl(tab.url) && !isOwnPage(tab.url)) {
        lastKnownTabId = tabId;
      }
    })
    .catch(function () {
      /* tab vanished */
    });
}

chrome.tabs.onActivated.addListener(function (info) {
  trackTab(info.tabId);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo && changeInfo.status === 'complete') {
    trackTab(tabId);
    var s = sessions.get(tabId);
    if (s) {
      // Navigation wipes the page-side recorder.  It cannot be stopped from
      // happening, but the macro does not have to die with the document.
      if (s.recording) endRecordingAtNavigation(tabId, s);
      s.playing = false;
    }
    if (changeInfo.url && !isInjectableUrl(changeInfo.url)) {
      detach(tabId);
      cdpDisabled.add(tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  // Closing a tab mid-recording is the same loss by another road. The page has
  // already handed over what it had, so the worker can still file it - best
  // effort, because this worker may not survive long enough to finish writing.
  var closing = sessions.get(tabId);
  if (closing && closing.recording && !closing.filed && closing.events.length) {
    closing.filed = true;
    fileRecording(tabId, closing.events).catch(function () {
      /* nothing left to report to */
    });
  }
  sessions.delete(tabId);
  attached.delete(tabId);
  cdpDisabled.delete(tabId);
  if (lastKnownTabId === tabId) lastKnownTabId = null;
  try {
    chrome.storage.session.remove(SESSION_PREFIX + tabId);
  } catch (e) {
    /* ignore */
  }
});

chrome.runtime.onInstalled.addListener(function () {
  // Nothing to migrate; kept for clarity when the session schema changes.
});
