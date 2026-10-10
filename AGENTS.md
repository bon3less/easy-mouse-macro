# AGENTS.md

For anyone working on this repo - human or agent. It holds what you need to change the code safely:
layout, architecture, the Chrome behaviour the implementation leans on, how the suite proves it, and
the conventions an edit has to follow. User-facing how-to lives in [README.md](README.md).

## Ground rules for this codebase

* **Plain files, no build step.** Nothing is bundled, transpiled or minified, so what is in `extension/`
  is exactly what Chrome runs. Do not introduce a build step, a bundler or a generated file without
  saying why in a comment.
* **The extension is plain JavaScript** (ES2020-ish, `var`/`function` style, no modules in the page
  context). The service worker is a *classic* worker: `background.type` must stay absent so
  `importScripts('lib/macro-core.js')` keeps working - `tools/check-extension.mjs` asserts it.
* **No network code, ever.** No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`,
  no analytics, no remote config, no update endpoint, no remotely hosted code. The privacy policy and
  the Chrome Web Store justifications both claim this, so adding any of it makes them false.
* **Comments explain *why*, not *what*.** The house style is prose that names the Chrome behaviour a
  line exists for ("Chrome applies a trusted wheel on the compositor, about a tenth of a second before
  the page's own offsets catch up, so..."). Match that when you touch a file: a reader has to be able to
  tell which paragraph of the Chrome implementation a piece of code is standing in for.
* **House characters.** In anything you write (code comments, docs, commit messages): no em dash
  (U+2014), no en dash (U+2013), no middle dot (U+00B7), no curly quotes or apostrophes (U+2018-U+201D),
  no multiplication sign (U+00D7). Use `-`, `'`, `"` and `x` (`1x-10x`, not a multiplication sign).
* **Manifest facts that are checked, not cosmetic.** `name` <= 75 chars, `description` <= 132,
  `version` matches `^\d+(\.\d+){0,3}$`, `default_popup` and `background.service_worker` present, every
  referenced file and declared icon present, CSP `script-src 'self'; object-src 'self'`. Run
  `npm run check` after any manifest edit; `tests/manifest.test.mjs` re-asserts the UI and command
  contracts.

## Layout

```
extension/            <- load THIS folder with "Load unpacked"
  manifest.json       MV3 manifest (permissions: storage, unlimitedStorage, scripting, debugger)
  background.js       service worker: session state, tab targeting, CDP trusted-input engine,
                      recording orchestration, history + settings persistence, badge
  content.js          recorder, replay clock, ghost cursor, scroll-container capture, synthetic engine
  popup.html/.css/.js Record / Play UI with the repetitions + speed dialog, history, settings
  lib/macro-core.js   pure logic shared by worker and content script: throttling, clamping,
                      scheduling/timeline math, CDP parameter mapping. No DOM, no chrome.* calls.
  icons/              generated PNGs (see tools/make-icons.mjs)
tools/
  make-icons.mjs      regenerates the icons (pure Node, no deps)
  check-extension.mjs static "would Chrome accept this?" checks
  smoke.mjs           manual browser smoke script
  debug-speed.mjs     prints the page's own timestamps for 1x / 10x / 3x-10x replays
tests/
  core.test.mjs       unit tests for scheduling / clamping / CDP mapping
  manifest.test.mjs   manifest + UI contract tests
  e2e.test.mjs        real Chrome: loads the extension unpacked and drives it
  helpers/browser.mjs Playwright harness (persistent context + unpacked load)
  fixtures/           test page + tiny static server
privacy-policy.md     the policy text (Google needs a public URL for it)
privacy-policy.html   the same policy, ready to host as-is
```

`lib/macro-core.js` is loaded three ways: `importScripts` in the worker, a `script` tag list in the
manifest's `content_scripts`, and directly in tests. Keep it free of `chrome.*` and DOM so all three
keep working.

## Commands

```bash
npm test              # static checks + unit tests + browser E2E (needs Xvfb)
npm run check         # static manifest / CSP / file-reference checks only
npm run test:unit     # unit tests only, no browser
npm run test:e2e      # browser E2E only, via xvfb-run -a, concurrency 1
npm run icons         # regenerate icons/
node tools/smoke.mjs  # manual smoke run, prints what the page received
node tools/debug-speed.mjs  # 1x / 10x / 3x-10x timing from the page's own clock
```

`playwright@1.61.1` is the only dev dependency: `npm install --save-dev playwright@1.61.1`. The E2E
suite drives a **real Chrome with `--load-extension`**, i.e. the same code path as the button a user
presses, under Xvfb, with a persistent profile so storage survives a browser restart.

Baseline when this was last run green: `check-extension: OK`, 61 unit/static passes, 26 Chrome E2E
passes (Chrome for Testing + Xvfb).

## Architecture

Flow, per action: popup (or `chrome.commands`) -> `background.js` -> `chrome.tabs.sendMessage` to
`content.js` in one tab. `background.js` resolves *which* tab through `resolveTargetTab()` and refuses
anything that is not `http(s)://` or `file://`, or is one of the extension's own pages
(`isInjectableUrl` / `isOwnPage`). A tab that has no content script yet (opened before install or
after a reload of the extension) is patched by `ensureContent()`, which re-injects
`['lib/macro-core.js', 'content.js']` - the same two files the manifest already declares, literal
paths, nothing from outside the package.

Recording is page-side: `content.js` listens, throttles and batches events, and hands them to the
worker as they happen, so a recording survives the page being destroyed under it. Replay is split the
same way: the clock lives in `content.js` (it needs the page's frame timing and coordinates), the
trusted delivery lives in the worker (only it can call `chrome.debugger`).

### The two engines

* **Real browser input** - `attach()` / `sendTrusted()` in `background.js` attach `chrome.debugger` to
  one tab and send CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. **Only the `Input`
  domain is ever used**: no `Page`, `DOM`, `Runtime`, `Network`, so nothing about the page is read -
  this matters as much to the store justifications as to the design. `detach()` runs at the end of a
  playback, on stop, and on `chrome.debugger.onDetach`; a tab that refuses attach (restricted page,
  another debugger, "cannot access") is remembered in `cdpDisabled` and never retried, and the replay
  continues on the fallback engine instead.
* **Page-level events** - `content.js` dispatches `PointerEvent` / `MouseEvent` / `KeyboardEvent` at the
  recorded point and performs the default action Chrome would have, while staying out of the way when a
  handler calls `preventDefault()`.

The popup's *Use real browser input* switch decides per playback. Permissions are static in MV3, so
switching it off does not shrink the grant - it means `chrome.debugger` is never called.

### Timing, ordering and why there are two delivery lanes

* **Speed acts on the recorded timeline, not on Chrome's input pipe.** Mouse moves are never awaited:
  a debugger round-trip alone can outlast the gap between two recorded events, and pipelining them is
  what lets `10x` compress the recording to a tenth of its length. Chrome coalesces moves that land in
  one frame to the last one, exactly as with a fast real hand, so the trail thins out at high speed
  while every press, release and click still lands.
* **A recording that touches scrolling takes the sequenced lane.** A click is hit-tested on the
  renderer's main thread while a wheel scrolls on the compositor, so a queued click can be applied
  after a wheel the recording fired later - and hit a row nothing pointed at. `content.js` marks such a
  recording `ordered` (a wheel, a key, or an event inside a scrollable panel), and `queueInput()` then
  gives the page one command at a time per tab. Ordinary recordings keep the pipelined lane.
* **A lagging page makes the replay lag, not burst.** The sequenced lane waits for the page to have
  applied each press/release/click/wheel/key (bounded to a couple of seconds each) before the next goes
  out; a page that cannot keep up slips behind its schedule rather than squeezing the remainder into a
  burst, which is what a slow machine does to a real hand.
* **Scroll containers are part of the coordinate.** A click or wheel remembers which scrollable panels
  it was inside and their offsets, so a replay lands on the same row of a list, table or
  `overflow: auto` panel even if the page was scrolled elsewhere in between. Because Chrome applies a
  trusted wheel on the compositor before the page's offsets catch up, the replay waits for a wheel to
  show up in the page before releasing the next event, and only writes an offset back when no wheel is
  still on its way.
* **Keys.** A press is one recorded event but the page needs keydown *and* keyup - Chrome activates a
  focused control on the keyup - so both go out together. A key has no coordinates and acts on the
  *focused* element, which is why any recording with keys takes the sequenced lane: every TAB depends on
  the focus the previous event left. Chrome also fires an unpositioned click to *perform* a SPACE
  activation; that click belongs to the press and is never recorded as a click of its own, or a replay
  would click the viewport's top-left pixel.
* **Chrome's own forwarded clicks are dropped at recording time.** Clicking a `<label for>` makes the
  browser dispatch a second click on the labelled control in the same millisecond; the recorder drops
  that twin, otherwise a replay toggles the checkbox twice and lands where it started.

### Storage

| Where | What | Lifetime |
| --- | --- | --- |
| memory + `chrome.storage.session` (key `session:<tabId>`) | the recording in flight, per tab, plus why it ended | Chrome discards it at browser exit; the key is removed on `tabs.onRemoved` |
| `chrome.storage.local` (keys `history` and `settings`) | finished macros, their names, and the chosen keep-limit | until the user deletes them or uninstalls |

The split is deliberate and is tested by restarting the browser: the history is still there, a tab's
recording slot is not. `chrome.storage.sync` / `managed` are not used - macros are megabytes and stay
local. Caps live in `lib/macro-core.js`: `MAX_EVENTS` 40 000, `MAX_TRACK_MS` 4 hours, `MAX_REPETITIONS`
999, speed 1-10, history 1-50 (`MAX_HISTORY` default 10, choices 5/10/20/50). `mousemove` is filtered by
`shouldCaptureMove`: a move is kept when it is 2 px from the last kept one, one under 10 ms apart is
dropped, and a pause of 80 ms or more is kept because the pause itself is worth replaying. On replay,
moves are gated to one per frame (`MOVE_GATE_MS = 16`), matching Chrome's own same-frame coalescing.
Coordinates are stored in both viewport and document space, and wheel deltas in pixels (lines/pages
converted once, at recording time).

## Chrome behaviour that will bite you

* `chrome.debugger` shows Chrome's *"started debugging this browser"* banner. Not suppressible, not a
  bug: it is Chrome's notice. Dismissing it detaches, which `chrome.debugger.onDetach` handles by
  falling back to the synthetic engine.
* **Chrome silently drops a command key it will not claim.** `Alt+Shift+W` in particular is
  unobtainable: `chrome.commands.getAll()` reports it as empty and the key does nothing, with no error
  anywhere. That is why the popup sits on `Alt+Shift+Q`, and why `tests/manifest.test.mjs` asserts for
  every manifest command that the binding Chrome *reports* is the one asked for.
* **`activeTab` is not granted by an arbitrary command**, only by `_execute_action`. The
  `emm-toggle-record` shortcut is why the extension carries host permissions instead of leaning on
  `activeTab`.
* **Chrome sizes the popup from the document and never grows it for overlays**, so the popup must be
  one box for every view - the replay dialog and its **Start playback** button can never be cut off.
* A navigation, reload or closing the tab destroys the page-side recorder: events already handed over
  are filed exactly as a manual stop would file them, and the popup must stop claiming to record.
* `file://` pages need the user to enable *Allow access to file URLs*; `chrome://`, the Web Store and
  other extensions' pages are refused by an explicit URL check, not by hope.
* Only the top frame (`all_frames: false`). Gestures Chrome owns (pinch zoom, `Ctrl`+wheel zoom,
  overscroll flinging) are not reproduced, and Chrome may batch two close wheel notches into one scroll.

## What the suite pins down

`npm run test:e2e` loads the extension unpacked in real Chrome and, among other things:

* records real gestures with `page.mouse`, asserts the popup counts them and that counting survives
  closing the popup;
* replays at several repetition/speed settings and asserts the page received the events at the recorded
  coordinates, once per repetition, in the recorded order, with `isTrusted === true` for the real-input
  engine;
* asserts `10x` really compresses the timeline (~10x in the page's own clock) and 5 repetitions emit 5x
  the events, and that the replayed trail only visits recorded positions in the recorded order;
* proves the **default action** happens: a replayed click checks a checkbox, activates a `<label for>`,
  selects a radio, fires the `change` events frameworks hook into - both engines, 1 and 2 repetitions,
  from a reset baseline, and an already-selected radio fires no further `change`, as real input does;
* opens a `<details>` block, wheels a 62-row list of checkboxes top to bottom ticking one per row, and
  replays that at `2x` on both engines: all 62 ticked again, the panel ending at the offset the
  recording left it at, as many wheel gestures reaching the page as were recorded (all of them trusted
  for the real-input engine), each at the recorded point with the recorded pixel distance, and the
  trusted replay having taken the sequenced lane;
* walks the fixture with **TAB** forwards and `Shift`+TAB back, pressing **SPACE** on a checkbox, on a
  `<summary>` and on the boxes that list then hands to Tab, and replays it on both engines: focus ends on
  the same control with the same boxes ticked and un-ticked, the recording holds the keys in order with
  the shift modifier and holds no click of its own;
* replays a stored macro in **a different tab** and asks the page which box it clicked - "the right
  macro, in the tab the user is looking at" is settled by the page, not by a count that fits;
* closes the browser, restarts it on the same profile and finds the macro still in the list while the
  tab's slot is empty: `chrome.storage.local` versus `chrome.storage.session`, measured rather than
  asserted in a comment;
* records a click, follows a link mid-recording, finds the macro in the history on the other side and
  replays it on the page that arrived;
* renames a macro, reads the name back out of storage after reopening the popup, clears the name to get
  the host label back, and lowers the cap to five to watch the oldest macros fall off at once - the cap
  is a setting, so the suite reads it from the popup instead of importing a constant;
* asserts the ghost cursor never intercepts replayed input, that Stop and Cancel work, that defaults are
  1 repetition at `1x`, that wild inputs are clamped, that clearing works, that replay after scrolling
  hits the same elements, that recordings are per tab, and that a plain web page cannot fire a command.

When you change engine behaviour, extend a test rather than trusting a manual click-through: a
guarantee nothing observes is one that quietly stops being kept.

## Permissions, and what to keep them worth

| Permission | Why it is here | What would break if it went |
| --- | --- | --- |
| `storage` | recording in flight (`session`), history and settings (`local`) | a replay is lost when the worker recycles; no history across restarts |
| `unlimitedStorage` | `MAX_EVENTS` x up to 50 macros is tens of megabytes of JSON, past the default local quota | the history would fail to save, silently |
| `scripting` | `ensureContent()` re-injects the two packaged files into a tab opened before install/update | old tabs could not be recorded |
| `debugger` | trusted replay, CDP `Input.*` only | replay stops working on pages that ignore untrusted events |
| `http/https/file` hosts | the recorder must run on the page being recorded; also the only way to read `tab.url` | "record anywhere" is the product; the shortcut could not target a tab |

Do not add `tabs` (the host grants already expose `tab.url`, and only its host is ever shown), no
`<all_urls>` catch-all beyond what is there, no optional catch-ups at runtime. The Chrome Web Store
needs a written justification for each row above and a public privacy-policy URL; the claims it makes
are in [privacy-policy.md](privacy-policy.md) / [privacy-policy.html](privacy-policy.html), and they
are only true as long as the rules at the top of this file hold.
