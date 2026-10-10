# Changelog

All notable changes to **Easy Mouse Macro** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The released version is the one in
`extension/manifest.json`.

One note on provenance: this repository was published from a single squashed commit, so what is below
is reconstructed from the code, the test suite and the manifest rather than from a granular commit
history. The "Development notes" entries are things the code and tests record as deliberate decisions.

## [Unreleased]

Nothing staged yet.

## [1.0.0] - 2026-09-21

First published version. Manifest V3, unpacked, Google Chrome 116 or newer.

### Added

* **Recording** of mouse movements, clicks and wheel scrolling in the visible tab, plus the **TAB**
  (with `Shift` for backwards) and **SPACE** keys. Events are throttled, batched page-side and handed to
  the service worker as they happen, so a recording survives the page it was made in being destroyed.
* **Two replay engines.** *Real browser input* through `chrome.debugger` and CDP
  `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, so the page receives genuine trusted input
  (hover states, `:active`, drag-and-drop, sites that ignore scripted events). *Page-level events* as an
  automatic fallback, or when the user unticks *Use real browser input*.
* **Repetitions (1-999) and speed (1x-10x)** per playback, with an estimate of the total playback time
  in the dialog before it starts.
* **A history of finished macros**: newest first, loadable in the tab you are looking at, renameable
  (the host stays as the label until you name it), removable one by one or all at once, and a
  user-selectable keep-limit of 5 / 10 / 20 / 50 entries with 10 as the default.
* **A split storage model**: the recording in flight in `chrome.storage.session`, the history and
  settings in `chrome.storage.local`, so the history survives a browser restart while a tab's slot does
  not.
* **Replay fidelity work**: coordinates in both viewport and document space, the scrollable panels a
  click or wheel was inside and their offsets, wheel distances in pixels, and a ghost cursor with a ring
  on each button press so a running replay is visible.
* **Keyboard shortcuts**: `Alt+Shift+Q` popup, `Alt+Shift+E` record, `Alt+Shift+S` stop playback, all
  rebindable and always shown as Chrome actually reports them.
* **A test suite that drives real Chrome**: static manifest checks, 61 unit/static tests, and 26
  end-to-end tests that load the extension unpacked (`--load-extension`) under Xvfb and assert what the
  page received, on both engines. See [AGENTS.md](AGENTS.md#what-the-suite-pins-down).
* **Documentation split**: a slim [README.md](README.md) for users, [AGENTS.md](AGENTS.md) for the
  implementation and its constraints, this file for history.
* **A privacy policy** in two forms, [privacy-policy.md](privacy-policy.md) and
  [privacy-policy.html](privacy-policy.html), stating per permission why it is needed.

### Security / privacy stance

* No network code of any kind: no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or
  `sendBeacon`, no analytics, no tracking, no remote config, no update endpoint.
* No remotely hosted or dynamically generated code; extension pages run under
  `script-src 'self'; object-src 'self'`.
* Only the CDP `Input` domain is ever called, so the debugger grant delivers input and reads nothing.
* Recorded data never leaves the device: it is plain JSON in the user's own Chrome profile, deleted by
  the popup's clear actions or by uninstalling.

### Development notes (decisions the code and tests record)

* The popup sits on `Alt+Shift+Q` rather than `Alt+Shift+W`: Chrome silently refuses the latter -
  `chrome.commands.getAll()` reports the binding as empty and no error is raised anywhere. The suite now
  asserts, for every manifest command, that the binding Chrome *reports* is the one asked for, so a key
  Chrome will not take cannot ship unnoticed.
* The history's cap became a **setting** rather than a constant (`MAX_HISTORY` default 10, 1-50
  allowed): lowering it drops the oldest macros immediately, and the choice is stored with the macros.
  The E2E suite reads it from the popup instead of importing a constant, for the same reason.
* A click a page forwards itself is dropped at recording time: clicking a `<label for>` makes the
  browser dispatch a second click on the labelled control in the same millisecond, and replaying that
  twin would toggle the checkbox twice and land back where it started.
* An unpositioned click that Chrome fires to *perform* a SPACE activation belongs to the key press and is
  never recorded as a click of its own.
* Recordings that touch scrolling - a wheel, a key, or an event inside a scrollable panel - are delivered
  one event at a time, because Chrome hit-tests a click on the renderer's main thread while a wheel
  scrolls on the compositor. Everything else keeps the pipelined, acknowledgement-free path so `10x`
  stays `10x` fast.
* A recording ended by a navigation, reload or tab close is filed in the history exactly as **Stop
  recording** would file it, instead of being lost with the document.
* Host permissions are declared rather than leaning on `activeTab`, because `activeTab` is granted only
  by `_execute_action` and not by the record/stop commands.
* `unlimitedStorage` was added for the history's size (`MAX_EVENTS` x up to 50 macros), and the caps
  (40 000 events, 4 hours, `mousemove` throttled to ~10 ms or 2 px) keep long sessions responsive.

### Known limits

Deliberate, and documented in the README: only TAB and SPACE from the keyboard, only the top frame of
`http(s)://` and `file://` pages, coordinates belong to the page they were recorded on, no
cross-monitor or multi-window replay, and no reproduction of gestures Chrome owns (pinch zoom,
`Ctrl`+wheel zoom, overscroll flinging). See
[README.md - Known limits](README.md#known-limits).
