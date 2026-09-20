/*
 * Easy Mouse Macro - popup controller.
 *
 * The popup is a thin view: all state lives in the service worker, so closing
 * the popup never interrupts a recording or a playback.
 */
(function () {
  'use strict';

  var core = window.EMMCore;
  var MSG = 'emm';

  var els = {
    target: document.getElementById('target'),
    pill: document.getElementById('state-pill'),
    events: document.getElementById('m-events'),
    moves: document.getElementById('m-moves'),
    clicks: document.getElementById('m-clicks'),
    length: document.getElementById('m-length'),
    record: document.getElementById('btn-record'),
    recordLabel: document.querySelector('#btn-record .btn-label'),
    play: document.getElementById('btn-play'),
    playLabel: document.querySelector('#btn-play .btn-label'),
    clear: document.getElementById('btn-clear'),
    historyList: document.getElementById('history-list'),
    historyEmpty: document.getElementById('history-empty'),
    clearHistory: document.getElementById('btn-clear-history'),
    historyLimit: document.getElementById('history-limit'),
    hint: document.getElementById('hint'),
    error: document.getElementById('error'),
    progressRow: document.getElementById('progress-row'),
    progressBar: document.getElementById('progress-bar'),
    progressText: document.getElementById('progress-text'),
    stopPlay: document.getElementById('btn-stop-play'),
    dialog: document.getElementById('dialog'),
    form: document.getElementById('play-form'),
    repetitions: document.getElementById('repetitions'),
    repetitionsOut: document.getElementById('repetitions-out'),
    speed: document.getElementById('speed'),
    speedOut: document.getElementById('speed-out'),
    trusted: document.getElementById('trusted'),
    estimate: document.getElementById('estimate'),
    cancel: document.getElementById('btn-cancel'),
    confirm: document.getElementById('btn-confirm')
  };

  var state = {
    tabId: null,
    recording: false,
    playing: false,
    hasRecording: false,
    summary: core.summarize([]),
    injectable: false,
    history: [],
    loadedFrom: null
  };

  var playing = {
    active: false,
    startedAt: 0,
    plannedMs: 0
  };

  var pollTimer = null;

  /* ------------------------------------------------------------------ *
   * RPC
   * ------------------------------------------------------------------ */

  function send(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: 'No response from the background worker.' });
      });
    });
  }

  function showError(message) {
    if (!message) {
      els.error.hidden = true;
      els.error.textContent = '';
      return;
    }
    els.error.hidden = false;
    els.error.textContent = message;
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function render() {
    // While recording, count straight from the page-side buffer.
    var s = (state.recording && state.live) ? state.live : state.summary;
    els.events.textContent = core.formatCount(s.count);
    els.moves.textContent = core.formatCount(s.moves);
    els.clicks.textContent = core.formatCount(s.clicks);
    els.length.textContent = core.formatDuration(s.durationMs);

    var mode = 'idle';
    var label = 'Idle';
    if (state.recording) {
      mode = 'recording';
      label = 'Recording';
    } else if (state.playing || playing.active) {
      mode = 'playing';
      label = 'Playing';
    } else if (state.hasRecording) {
      mode = 'ready';
      label = 'Ready';
    }
    els.pill.dataset.state = mode;
    els.pill.textContent = label;

    els.target.textContent = state.url ? truncate(state.url, 58) : 'No web tab detected';
    els.target.title = state.url || 'No web tab detected';

    els.record.classList.toggle('is-recording', state.recording);
    els.recordLabel.textContent = state.recording ? 'Stop recording' : 'Record';

    var busy = state.recording || state.playing || playing.active;
    els.play.disabled = !state.hasRecording || busy;
    els.clear.disabled = !state.hasRecording || busy;

    var showProgress = state.playing || playing.active;
    els.progressRow.hidden = !showProgress;

    renderHistory();

    if (!state.recording && !busy && !state.hasRecording) {
      els.hint.textContent = 'Click Record, use the mouse and keys in the page, then click Stop.';
    } else if (state.recording) {
      els.hint.textContent = 'Move and click in the page. Click Stop when done.';
    } else if (busy) {
      els.hint.textContent = 'Replaying\u2026 you can stop it any time.';
    } else if (state.endedError) {
      // The macro is in the tab either way - only the keeping failed - so the
      // reason belongs where the user will hover it, not on a line of its own.
      els.hint.textContent = 'The page moved, so recording stopped - it could not be saved.';
      els.hint.title = state.endedError;
    } else if (state.endedBy === 'navigation') {
      els.hint.textContent = 'The page moved, so recording stopped - it is saved in the history.';
      els.hint.title = '';
    } else if (state.loadedFrom) {
      els.hint.textContent = 'Loaded from the history - Play replays it in this tab.';
    } else {
      els.hint.textContent = 'Ready to replay as many times as you like.';
    }
  }

  /* ------------------------------------------------------------------ *
   * History
   * ------------------------------------------------------------------ */

  // The rows come back with every refresh, four times a second; rebuilding the
  // list that often would drop the caret, the hover and the scroll position, so
  // it is rebuilt only when what they describe actually changed.
  var historyRendered = '';

  // Which macro's name is being typed, if any.  It is part of the cache key
  // below, so opening and closing the editor is itself a change worth drawing.
  var editing = null;

  function whenLabel(savedAt) {
    if (!savedAt) return '';
    var when = new Date(savedAt);
    var label = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (when.toDateString() === new Date().toDateString()) return label;
    return when.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + label;
  }

  function macroDetail(row) {
    // One of each kind should read like English, not like a count joined to a
    // fixed noun: a macro of a single click is "1 click", not "1 clicks".
    var n = function (value, one, many) {
      return core.formatCount(value) + ' ' + (value === 1 ? one : many);
    };
    var bits = [
      n(row.count, 'event', 'events'),
      n(row.moves, 'move', 'moves'),
      n(row.clicks, 'click', 'clicks')
    ];
    if (row.wheels) bits.push(n(row.wheels, 'wheel', 'wheels'));
    if (row.keys) bits.push(n(row.keys, 'key', 'keys'));
    bits.push(core.formatDuration(row.durationMs) + ' long');
    if (row.host) bits.push('recorded on ' + row.host);
    return bits.join(' \u00b7 ');
  }

  function buildRow(row) {
    var li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.id = row.id;

    var pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'history-row';
    pick.title = 'Replay this macro in the tab you are looking at';

    var when = document.createElement('span');
    when.className = 'history-when';
    when.textContent = whenLabel(row.savedAt);

    var host = document.createElement('span');
    host.className = 'history-host';
    // A name replaces the host rather than joining it: the row has room for one
    // idea, and the user's own words are the one they came to read.  The host is
    // still in the row's tooltip.
    host.textContent = row.name || row.host || '';

    var count = document.createElement('span');
    count.className = 'history-count';
    count.textContent = core.formatCount(row.count) + ' \u00b7 ' + core.formatDuration(row.durationMs);

    // A name longer than the row is cut with an ellipsis, so the whole of it
    // goes in front of the tooltip: the counts are already there, and so is the
    // host the name replaced.
    pick.title = row.name ? row.name + ' \u2014 ' + macroDetail(row) : macroDetail(row);
    pick.appendChild(when);
    pick.appendChild(host);
    pick.appendChild(count);

    var name = document.createElement('button');
    name.type = 'button';
    name.className = 'history-rename btn btn-ghost btn-sm';
    name.textContent = '\u270e';
    name.title = row.name ? 'Rename this macro' : 'Give this macro a name';
    name.setAttribute('aria-label', 'Name this macro');

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del btn btn-ghost btn-sm';
    del.textContent = '\u00d7';
    del.title = 'Forget this macro';

    if (editing === row.id) {
      // The row becomes the editor in place: the list must not grow by a line
      // just because a name is being typed - the popup has a height it keeps.
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'history-name';
      input.value = row.name || '';
      input.placeholder = row.host || 'Name this macro';
      input.maxLength = core.LIMITS.MAX_NAME;
      input.setAttribute('aria-label', 'Name for this macro');
      li.appendChild(input);
    } else {
      li.appendChild(pick);
    }
    li.appendChild(name);
    li.appendChild(del);
    return li;
  }

  function renderHistory() {
    var rows = Array.isArray(state.history) ? state.history : [];
    var key = state.loadedFrom + '|edit:' + (editing || '') + '|' + rows.map(function (r) {
      return r.id + ':' + r.count + ':' + r.savedAt + ':' + r.host + ':' + r.name;
    }).join(',');

    if (key !== historyRendered) {
      historyRendered = key;
      els.historyList.textContent = '';
      for (var i = 0; i < rows.length; i++) els.historyList.appendChild(buildRow(rows[i]));
    }
    els.historyEmpty.hidden = rows.length > 0;
    els.clearHistory.disabled = rows.length === 0;
    renderHistoryLimit(state.historyLimit);

    // While the page is busy - recording, or a replay running - the macros are
    // not swapped out from under it; the rows say so instead of silently queued.
    var busy = state.recording || state.playing || playing.active;
    var items = els.historyList.children;
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      // The mark is the row's own: whichever row is loaded, the outline moves to
      // it, and deleting that macro takes the mark with it.
      item.classList.toggle('is-current', item.dataset.id === state.loadedFrom);
      var buttons = item.querySelectorAll('button');
      for (var k = 0; k < buttons.length; k++) buttons[k].disabled = busy;
    }
  }

  /**
   * Offer the cap the user chose, and only that one among the choices core
   * publishes - a stored value outside the list (an older version, hand-edited
   * storage) is added rather than silently rewritten, so the popup never shows a
   * number that differs from the one being kept.
   */
  var limitRendered = '';
  function renderHistoryLimit(value) {
    var limit = core.normalizeLimit(value);
    if (limitRendered !== String(limit)) {
      limitRendered = String(limit);
      // concat rather than push: the array belongs to core. And the chosen cap
      // is only added when it is not already one of the offers, or the list
      // would grow a second copy of the number it is showing.
      var known = core.LIMITS.HISTORY_CHOICES.indexOf(limit) !== -1;
      var choices = core.LIMITS.HISTORY_CHOICES.concat(known ? [] : [limit]).sort(function (a, b) {
        return a - b;
      });
      els.historyLimit.textContent = '';
      for (var i = 0; i < choices.length; i++) {
        var opt = document.createElement('option');
        opt.value = String(choices[i]);
        opt.textContent = String(choices[i]);
        els.historyLimit.appendChild(opt);
      }
      els.historyEmpty.textContent =
        'Finished recordings land here as you stop them, and the last ' + limit +
        ' are kept - through another tab, and through closing Chrome.';
    }
    els.historyLimit.value = String(limit);
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
  }

  /* ------------------------------------------------------------------ *
   * Keyboard shortcuts shown in the UI
   * ------------------------------------------------------------------ */

  var TOOLTIPS = {
    'emm-toggle-record': 'Record or stop recording',
    'emm-stop-playback': 'Stop the running replay'
  };
  var TOOLTIP_TARGETS = {
    'emm-toggle-record': 'record',
    'emm-stop-playback': 'stopPlay'
  };

  /**
   * Show the binding Chrome actually uses for this install: it can be remapped
   * at chrome://extensions/shortcuts, and a hint that lies about the keys is
   * worse than no hint at all.
   */
  function renderShortcuts() {
    if (!window.chrome || !chrome.commands || typeof chrome.commands.getAll !== 'function') return;
    chrome.commands.getAll(function (commands) {
      if (chrome.runtime.lastError || !Array.isArray(commands)) return;
      var byName = {};
      commands.forEach(function (c) {
        byName[c.name] = (c.shortcut || '').trim();
      });

      var nodes = document.querySelectorAll('[data-command]');
      Array.prototype.forEach.call(nodes, function (node) {
        var name = node.getAttribute('data-command');
        var key = byName[name];
        if (key) {
          node.textContent = key;
          node.classList.remove('is-unassigned');
          node.title = (TOOLTIPS[name] || name) + ' - change it at chrome://extensions/shortcuts';
        } else {
          node.textContent = 'not set';
          node.classList.add('is-unassigned');
          node.title = 'No shortcut assigned - add one at chrome://extensions/shortcuts';
        }
        var target = TOOLTIP_TARGETS[name];
        if (target && els[target]) {
          els[target].title = (TOOLTIPS[name] || name) + (key ? ' (' + key + ')' : '');
        }
      });
    });
  }

  function tickProgress() {
    if (!playing.active) return;
    var elapsed = Date.now() - playing.startedAt;
    var ratio = playing.plannedMs > 0 ? Math.min(1, elapsed / playing.plannedMs) : 0;
    els.progressBar.style.width = Math.round(ratio * 100) + '%';
  }

  /* ------------------------------------------------------------------ *
   * Polling
   * ------------------------------------------------------------------ */

  async function refresh() {
    var res = await send({ type: MSG + ':state' });
    if (res && res.ok) {
      state = Object.assign({}, state, res);
      if (playing.active && !res.playing) {
        var elapsedMs = Date.now() - playing.startedAt;
        var ranToTheEnd = playing.plannedMs > 0 && elapsedMs >= playing.plannedMs * 0.97;
        playing.active = false;
        els.progressBar.style.width = '100%';
        els.progressText.textContent = ranToTheEnd
          ? 'Playback finished.'
          : 'Playback stopped - the recording is still loaded.';
        setTimeout(function () {
          if (!playing.active) els.progressBar.style.width = '0%';
        }, 900);
      }
    }
    render();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      refresh();
      tickProgress();
    }, 350);
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  async function toggleRecord() {
    showError('');
    var type = state.recording ? MSG + ':record-stop' : MSG + ':record-start';
    var res = await send({ type: type });
    if (!res.ok) {
      showError(res.error || 'Could not ' + (state.recording ? 'stop' : 'start') + ' recording.');
    } else if (res.historyError) {
      // The recording itself is safe in the tab; only the copy kept for later
      // is gone, and that difference is worth saying out loud.
      showError(res.historyError);
    }
    await refresh();
  }

  function openDialog() {
    els.repetitions.value = String(core.LIMITS.DEFAULT_REPETITIONS);
    els.speed.value = String(core.LIMITS.DEFAULT_SPEED);
    syncDialog();
    els.dialog.hidden = false;
    els.repetitions.focus();
    els.repetitions.select();
  }

  function closeDialog() {
    els.dialog.hidden = true;
  }

  function syncDialog() {
    var reps = core.clampRepetitions(els.repetitions.value);
    var speed = core.clampSpeed(els.speed.value);
    els.repetitionsOut.textContent = String(reps);
    els.speedOut.textContent = speed + '\u00d7';

    // Same scheduler the player uses, evaluated on a two-point stand-in so the
    // estimate always matches the real playback length.
    var durationMs = state.summary.durationMs || 0;
    var schedule = core.buildSchedule(
      [
        { t: 0, type: 'move', x: 0, y: 0 },
        { t: durationMs, type: 'move', x: 0, y: 0 }
      ],
      { repetitions: reps, speed: speed, interRepetitionMs: 400, leadInMs: 350 }
    );
    var planned = core.scheduleDuration(schedule);
    els.estimate.textContent =
      '\u2248 ' + core.formatDuration(planned) + ' of playback \u00b7 ' +
      core.formatCount(state.summary.count) + ' events \u00d7 ' + reps;
    return { reps: reps, speed: speed, planned: planned };
  }

  async function startPlayback() {
    var opts = syncDialog();
    var trusted = els.trusted.checked;
    showError('');
    closeDialog();

    var res = await send({
      type: MSG + ':play',
      repetitions: opts.reps,
      speed: opts.speed,
      trusted: trusted
    });

    if (!res.ok) {
      showError(res.error || 'Could not start playback.');
      await refresh();
      return;
    }

    playing.active = true;
    playing.startedAt = Date.now();
    playing.plannedMs = opts.planned;
    els.progressText.textContent =
      'Playing ' + opts.reps + ' time' + (opts.reps === 1 ? '' : 's') + ' at ' + opts.speed + '\u00d7\u2026';
    els.progressBar.style.width = '0%';
    await refresh();
    tickProgress();
  }

  async function stopPlayback() {
    await send({ type: MSG + ':play-stop' });
    playing.active = false;
    els.progressText.textContent = 'Playback stopped.';
    els.progressBar.style.width = '0%';
    await refresh();
  }

  async function clearRecording() {
    showError('');
    await send({ type: MSG + ':clear' });
    await refresh();
  }

  async function loadMacro(id) {
    showError('');
    editing = null;
    var res = await send({ type: MSG + ':history-load', id: id });
    if (!res.ok) showError(res.error || 'Could not load that macro.');
    await refresh();
  }

  async function forgetMacro(id) {
    showError('');
    if (editing === id) editing = null;
    var res = await send({ type: MSG + ':history-delete', id: id });
    if (!res.ok) showError(res.error || 'Could not forget that macro.');
    await refresh();
  }

  /**
   * Name a macro in place.  Nothing is sent until the name is committed: a row
   * is cheap to redraw and a half-typed name is not something to store.
   */
  function startRename(id) {
    showError('');
    editing = id;
    renderHistory();
    var input = els.historyList.querySelector('.history-name');
    if (input) {
      input.focus();
      input.select();
    }
  }

  async function commitRename(id, name) {
    editing = null;
    showError('');
    var res = await send({ type: MSG + ':history-rename', id: id, name: name });
    if (!res.ok) showError(res.error || 'Could not rename that macro.');
    await refresh();
  }

  function cancelRename() {
    editing = null;
    renderHistory();
  }

  async function keepHistory(value) {
    showError('');
    var res = await send({ type: MSG + ':history-limit', limit: Number(value) });
    if (!res.ok) showError(res.error || 'Could not change how many macros are kept.');
    await refresh();
  }

  async function wipeHistory() {
    showError('');
    var res = await send({ type: MSG + ':history-clear' });
    if (!res.ok) showError(res.error || 'Could not clear the history.');
    await refresh();
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  els.record.addEventListener('click', toggleRecord);
  els.play.addEventListener('click', openDialog);
  els.clear.addEventListener('click', clearRecording);
  els.clearHistory.addEventListener('click', wipeHistory);
  // One handler for the whole list: rows are created and destroyed as the
  // history changes, and a handler per row would have to be chased each time.
  els.historyList.addEventListener('click', async function (ev) {
    var item = ev.target && ev.target.closest ? ev.target.closest('.history-item') : null;
    if (!item || !item.dataset.id) return;
    var del = ev.target.closest('.history-del');
    // Forgetting a macro leaves the copy that is loaded here alone: it is what
    // the user is about to replay, and a row disappearing should not eat it.
    if (del) await forgetMacro(item.dataset.id);
    else if (ev.target.closest('.history-rename')) startRename(item.dataset.id);
    else await loadMacro(item.dataset.id);
  });
  // The editor is created and destroyed with each row, so its events are caught
  // here rather than on the input itself.
  els.historyList.addEventListener('keydown', async function (ev) {
    if (!ev.target || !ev.target.classList.contains('history-name')) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      await commitRename(editing, ev.target.value);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancelRename();
    }
  });
  els.historyList.addEventListener('focusout', async function (ev) {
    if (!editing || !ev.target || !ev.target.classList.contains('history-name')) return;
    // Walking away from the field commits it, as a name does anywhere else; an
    // empty field is not a name, it is the default label back again.
    await commitRename(editing, ev.target.value);
  });
  els.historyLimit.addEventListener('change', function () {
    keepHistory(els.historyLimit.value);
  });
  els.stopPlay.addEventListener('click', stopPlayback);
  els.cancel.addEventListener('click', closeDialog);
  els.repetitions.addEventListener('input', syncDialog);
  els.speed.addEventListener('input', syncDialog);
  els.form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    startPlayback();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !els.dialog.hidden) {
      ev.preventDefault();
      closeDialog();
    }
  });
  els.dialog.addEventListener('mousedown', function (ev) {
    if (ev.target === els.dialog) closeDialog();
  });

  window.addEventListener('focus', renderShortcuts);
  startPolling();
  renderShortcuts();
  refresh();
})();
