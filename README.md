# Easy Mouse Macro

A Chrome extension (Manifest V3) that records the mouse **movements, clicks and wheel scrolling**
you make in a browser tab, along with the **TAB** and **SPACE** keys, and replays them — as many
times as you want, at 1×–10× speed — inside that same browser window.

It is a plain, unpacked extension: no bundler, no build step, no minifier. You can read every
line that runs.

---

## 1. Install (Load unpacked)

Requires Google Chrome **116 or newer** (built and verified against Chrome 149 for Testing and
Chromium 152; it uses only stable MV3 APIs, so Chrome **153.x** is supported). `minimum_chrome_version`
is pinned in `extension/manifest.json`.

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the **`extension/`** folder of this project
   (the one that contains `manifest.json` — not the project root).
5. Click the puzzle-piece icon in the toolbar and pin **Easy Mouse Macro**.

## 2. Use it

1. Go to the web page where the macro should run.
2. Open the popup and press **Record**. The toolbar badge turns red (`REC`) and the popup counts
   events live.
3. Move the mouse, click, scroll the wheel, press **TAB** or **SPACE** in the page — exactly the
   way you want it replayed. Press **Stop recording** when you are done.
4. The **Play** button becomes enabled. Press it and a dialog asks:
   * **Repetitions** — how many times the macro should play (default **1**)
   * **Speed** — `1×` (recorded speed) up to `10×` as fast (default **1×**)

   The dialog shows an estimate of the total playback time. Confirm with **Start playback**
   (or dismiss with **Cancel** / `Esc`).
5. A red ghost cursor shows where the macro is pointing, a ring pulses on every button press, and
   the popup shows progress. **Stop playback** aborts at any time. **Clear recording** starts over.

The recording you have in hand is kept in `chrome.storage.session`, so closing the popup — or
letting the browser recycle the extension's worker — does not lose it. It lasts until the browser
session ends, the tab is closed, or you clear it. Everything you finish is *also* filed in the
history below, and that is what survives a restart.

### The history

Every macro you finish is filed under **History**, newest first. **Keep** in the history header
chooses how many are kept: **5, 10, 20 or 50**, with **ten** as the default. Lowering it drops the
oldest immediately rather than waiting for the next macro to push them out, and the choice is stored
with the macros, so it is still yours after a restart. Nothing is filed when a recording holds no
events — a row that replays nothing is not a macro.

* **Click a row** to load that macro into the recording slot. The metrics, the estimate and the
  repetitions/speed dialog then describe it, and **Play** replays it exactly as a fresh recording
  would. The loaded row is outlined in blue.
* It replays in **the tab you are looking at**, not in the tab that recorded it: macros are stored
  per extension, and Play always aims at the current tab. Switch tabs, open the popup, pick the row.
  Coordinates were recorded on the page they were recorded on — see
  [Known limits](#known-limits) — which is why every row names the host it came from.
* Every row names the host it came from until you give it a name of your own: the **pencil** turns
  the row into a field, `Enter` or walking away commits it, `Esc` cancels. A name takes the row's
  label slot (the host moves into the tooltip with the counts), and an empty name hands the row back
  the host — so a rename is undoable. Like the macros themselves, names live in storage, not in a
  tab's memory.
* **Following a link stops the recording.** The recorder lives in the page, and a page that
  navigates is destroyed with it — nothing can go on recording into a document that is gone. What it
  had already seen is not lost: events are handed to the extension's worker as they happen, and a
  recording that a navigation ends is filed in the history exactly as **Stop recording** would file
  it. The popup says so, and **Play** replays it on the page that arrived. Closing a tab that was
  still recording files it the same way.
* **×** forgets one macro, **Clear history** forgets every one of them. Neither touches the macro
  loaded in the recording slot: the row is the store, and the copy in hand is what Play will run.
* **Clear recording** empties the slot only. It never touches the history.
* Macros are stored in `chrome.storage.local`: plain JSON in your Chrome profile, kept until you
  clear it. That means unencrypted and not synced to another machine, and it means the history is
  still there the next time you open Chrome — which the test suite checks by closing the browser
  and starting it again.

### Keyboard shortcuts

| Shortcut | Default | What it does |
| --- | --- | --- |
| Open the popup | `Alt+Shift+Q` | Chrome's *Activate extension* — the keyboard equivalent of clicking the toolbar icon. |
| Toggle recording | `Alt+Shift+E` | Starts recording in the focused tab; pressing it again stops and keeps the recording. |
| Stop playback | `Alt+Shift+S` | Aborts a running replay without losing the recording. |

* Opening the popup is Chrome's own `_execute_action` command ("Activate extension") and not one the
  extension implements: Chrome performs it, exactly as if the toolbar icon had been clicked, so there
  is nothing of ours in that path to get wrong.
* The popup sits on `Alt+Shift+Q` because `Alt+Shift+W` is not obtainable: Chrome refuses it —
  `chrome.commands.getAll()` reports that binding as empty and the key does nothing. That is how Chrome
  treats an accelerator it will not hand over: silently, with no error anywhere. So the suite asserts,
  for every command in the manifest, that the binding Chrome *reports* is the one asked for — a key
  Chrome will not take cannot then ship unnoticed.
* Rebind any of them at `chrome://extensions/shortcuts`. The popup always shows the bindings Chrome
  actually uses (via `chrome.commands.getAll()`), never stale text, and its tooltips point at the
  settings page.
* If Chrome cannot claim the suggested key on your system (it is reserved or grabbed), that
  shortcut comes up as *"not set"* — open `chrome://extensions/shortcuts` and assign any free
  combination; the popup updates to show it.

## 3. How the replay works

Two engines, selected per playback:

| Engine | What it does | When it is used |
| --- | --- | --- |
| **Real browser input** (default) | The service worker attaches with `chrome.debugger` and calls CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. The page receives genuine, trusted input — hover states, `:active` styles, drag-and-drop and sites that ignore scripted events all behave exactly like a real user. | Always, unless the debugger cannot attach to the tab or you uncheck the option. |
| **Page-level events** (fallback) | The content script dispatches `PointerEvent` / `MouseEvent` / `KeyboardEvent` at the recorded coordinates, and performs the default action the browser would have. | Automatic fallback, or when you untick *Use real browser input*. |

Notes that follow from how Chrome works:

* Attaching the debugger makes Chrome show its *"Easy Mouse Macro started debugging this
  browser"* banner. That is Chrome's own warning about `chrome.debugger`; it does not affect the
  macro. Untick the option to avoid it. The permission itself is declared in the manifest whatever
  you tick, because MV3 permissions are static and cannot be asked for per replay — unticking the
  option means the extension never calls `chrome.debugger` at all, not that it holds less granted.
* No extension can move your **operating-system** cursor or drive other applications. Everything
  happens inside the recorded tab, which is why the extension draws a ghost cursor: the OS pointer
  stays where you left it.
* Coordinates are stored in both viewport and document space, so a replay scrolls back to the
  recorded scroll position and still hits the same point in the document.
* The **mouse wheel** is recorded as a scroll gesture: each event keeps its pixel distance (a
  delta given in lines or pages is converted once, at recording time), so it replays as the same
  distance on the same element. The real-input engine sends an actual `mouseWheel` gesture; the
  fallback dispatches a `WheelEvent` *and* performs the scroll Chrome would have done, staying out
  of the way when a page handler calls `preventDefault()`.
* A click or wheel also remembers which scrollable panels it was inside and their offsets, so a
  replay inside a scrollable list, a table or an `overflow: auto` panel lands on the same row even
  if the page was scrolled elsewhere in between. Chrome applies a trusted wheel on the compositor,
  about a tenth of a second before the page's own offsets catch up, so the replay waits for a wheel
  to show up in the page before the event after it goes out, and only writes an offset back when no
  wheel is still on its way to produce it.
* **TAB and SPACE are recorded as key presses and replayed as key presses.** A press is one recorded
  event; the page sees a keydown *and* a keyup, and Chrome activates a focused control on the keyup,
  so the real-input engine sends both (`Input.dispatchKeyEvent`) — half a press would leave a
  checkbox stubbornly unchanged. The fallback dispatches the `KeyboardEvent` pair and does what the
  browser would with it: moves the focus (a radio group is one stop, as Chrome makes it), activates
  the focused button, checkbox or `<summary>`, types the space into a text field, or pages scrollable
  content. A key press has no coordinates — it acts on the *focused* element — so a recording that
  contains keys takes the sequenced lane too: every Tab depends on the focus the event before it left.
  Chrome also fires an unpositioned click to *perform* a Space activation; that click belongs to the
  press, so it is never recorded as a click of its own.
* **Speed acts on the recorded timeline, not on Chrome's input pipe.** Mouse moves never wait for a
  debugger acknowledgement (that round-trip alone can outlast the whole gap between two recorded
  events), so `10×` really does compress the recording to a tenth of its length. Inside Chrome, mouse
  moves that fall into the same frame are coalesced to the last one — exactly what happens when a
  real user moves fast — so at high speed the trail becomes sparser while every press, release and
  click still lands on the right element.
* **A recording that scrolls content is handed to the page one event at a time.** A click is
  hit-tested on the renderer's main thread while a wheel scrolls on the compositor, so on a busy page
  a click can still be sitting in the queue when the wheel the recording fired *later* has already
  been applied — and it would then hit a row nothing ever pointed at. Only such recordings — one with
  a wheel or a key in it, or with an event inside a scrollable panel — pay for the sequence: the replay
  waits for the page to have applied each press, release, click, wheel and key (bounded to a couple of
  seconds each) before the next one goes out, and a page that cannot keep up makes the replay *lag* behind its
  schedule instead of squeezing the remainder into a burst, which is what a lagging machine does to a
  real hand too. A recording without any scrolling keeps the pipelined, acknowledgement-free path, so
  an ordinary gesture stays as fast as its speed setting says.
* A navigation, reload or reload-of-URL in the recorded tab wipes the page-side recorder; the
  popup detects this and stops claiming to be recording.

### Known limits

* Of the keyboard, **TAB** (with `Shift` for backwards) and **SPACE** are recorded — and deliberately
  only those two: their whole job is an effect a replay can be checked against (the focus moved, this
  control was activated, this content paged). No other key and no typed text is recorded, so a control
  a page only ever activates with `Enter`, or a form filled by typing, is out of reach.
* Keys act on whatever is *focused*, so a replay follows the focus the page has when it starts: a macro
  that tabs across a page assumes it begins where the recording did, the way a real hand does.
* A focused `<select>` answers SPACE by opening Chrome's own dropdown — browser UI no replay can open,
  so that press lands nowhere. And the fallback engine wraps Tab around at the end of the document,
  where Chrome would have handed the focus to the browser UI; `keypress` (the deprecated event) is
  produced by real browser input only.
* A wheel is replayed as a scroll gesture at the recorded point. Gestures Chrome owns — pinch
  zoom, `Ctrl`+wheel page zoom, overscroll flinging — are not reproduced, and Chrome may batch two
  close-together notches into one scroll, so a replay can stop a notch away from where the recorded
  hand stopped.
* Only the top frame is recorded, and only on `http(s)://` and `file://` pages. Chrome forbids
  extensions on `chrome://`, the Web Store, and other extension pages. For `file://` pages enable
  *Allow access to file URLs* on the extension's details page.
* Cross-monitor / multi-window replay is out of scope: coordinates belong to the recorded tab.
* Picking a stored macro up in another tab is supported, and it is on you: a coordinate is a pixel on
  whatever is in front of you now, so a macro recorded on one page replayed on another presses the
  pixels it remembers. The row names the host a macro came from because that is the only context
  worth carrying, and a page that has changed since the recording is replayed against its new self.
* Keys act on whatever has focus in the tab the replay runs in, so a macro picked up cold usually
  needs the same starting point the recording had — a click first, or a tab order that begins where
  it began.
* A recorded right-click will open Chrome's native context menu on replay — that is real browser
  behaviour and it grabs focus until you dismiss it.
* A recording is capped at 40 000 events / 4 hours of movement, and `mousemove` is throttled
  (~10 ms or 2 px) so long sessions stay responsive. The history holds up to fifty such macros, so its file
  can in principle run to tens of megabytes; that is what the `unlimitedStorage` permission is for,
  and **Clear history** is the way back down.

## 4. Project layout

```
extension/            <- load THIS folder with "Load unpacked"
  manifest.json       MV3 manifest (permissions: storage, scripting, debugger)
  background.js       session state, tab targeting, CDP "trusted input" engine
  content.js          recorder + replay clock + ghost cursor
  popup.html/.css/.js Record / Play UI with the repetitions + speed dialog
  lib/macro-core.js   pure logic: throttling, clamping, scheduling, CDP mapping
  icons/              generated PNGs (see tools/make-icons.mjs)
tools/
  make-icons.mjs      regenerates the icons (pure Node, no deps)
  check-extension.mjs static "would Chrome accept this?" checks
  smoke.mjs           manual browser smoke script
  debug-speed.mjs     prints the page's own timestamps for 1x / 10x / 3x-10x replays
tests/
  core.test.mjs       unit tests for the scheduling/clamping/CDP logic
  manifest.test.mjs   manifest + UI contract tests
  e2e.test.mjs        real Chrome: loads the extension unpacked and drives it
  helpers/browser.mjs Playwright harness (persistent context + unpacked load)
  fixtures/           test page + tiny static server
```

## 5. Tests

The suite runs a **real Chrome with the extension loaded unpacked** (`--load-extension`, the same
code path as the button you press) under Xvfb, then:

* records real gestures with `page.mouse` and asserts the popup counts them,
* replays them at several repetition/speed settings and asserts the page received the events, at
  the recorded coordinates, once per repetition, in the recorded order, with the OS-level
  `isTrusted` flag set for the real-input engine,
* asserts `10×` is much faster than `1×`, that 5 repetitions emit 5× the events,
* opens a `<details>` block, wheels a 62-row list of checkboxes from top to bottom and replays that
  at `2×` on both engines: every checkbox the recorded hand ticked has to be ticked again, the panel
  has to end at the offset the recording left it at, the page has to see as many wheel gestures as
  were recorded — all of them trusted ones, for the real-input engine — and the trusted replay has
  to have been the sequenced one, since a guarantee nothing can observe is one that quietly stops
  being kept,
* walks the same fixture with **TAB** — forwards, and back with `Shift`+TAB — pressing **SPACE** on a
  checkbox, on the `<summary>` that opens the model list, and on the checkboxes that list then hands
  to Tab, and replays that on both engines: the focus has to end on the same control with the same
  boxes ticked and un-ticked, the recording must hold the keys in order with the shift modifier, and
  it must hold no click of its own — the click Chrome fires to perform an activation belongs to the
  key press, and replaying it separately would click the top-left pixel of the viewport,
* keeps two macros one box apart in the history, loads the older one in **a different tab**, replays
  it there and asks the page which box it clicked — so "the right macro, in the tab the user is
  looking at" is settled by the page rather than by a count that happens to fit — then forgets one
  row and checks that the macro in hand survives being forgotten, that *Clear recording* leaves the
  history alone and *Clear history* is the only thing that empties it,
* closes the browser, starts another one on the same profile, and finds the macro still in the list
  (while a tab's recording slot, being memory, is gone) — the difference between
  `chrome.storage.local` and `chrome.storage.session`, measured instead of asserted in a comment,
* records a click, follows a link mid-recording, and finds that same macro in the history on the
  other side of the navigation — then replays it on the page that arrived and asks that page which
  box it clicked: the recording a destroyed document ended with is settled the same way as any other,
* names a macro, reopens the popup and reads the name back out of storage, clears the name to get the
  host label back, and lowers the cap to five to watch the oldest macros fall off at once — the cap is
  a setting now, so the suite reads it from the popup instead of importing a constant.
* asserts the ghost cursor never intercepts the replayed input, that Stop works, that Cancel works,
  that defaults are 1 repetition at `1×`, that inputs are clamped, and that scrolling away before a
  replay still hits the same elements.

```bash
npm test          # static checks + unit tests + browser E2E (needs Xvfb)
npm run check     # static manifest / CSP / file-reference checks only
npm run test:unit # unit tests only (no browser)
npm run test:e2e  # browser E2E only (uses xvfb-run -a)
node tools/smoke.mjs  # manual smoke run, prints what the page received
```

`playwright` is the only dev dependency. If you do not have it installed locally, point Node at any
available copy (the harness used here symlinks the package out of an existing pnpm store):

```bash
npm install --save-dev playwright@1.61.1
```

Latest run on this machine (`npm test`, all green):

```
check-extension: OK (4 referenced files, manifest v3)
unit / static tests   61 pass  0 fail
Chrome end-to-end     26 pass  0 fail   (Chrome for Testing + Xvfb, --load-extension)
```

The E2E suite asserts, among other things:

* the extension loads unpacked and its service worker starts clean,
* recording counts live in the popup and survives closing the popup,
* a `3×` replay at `1×` lands every recorded click on the recorded coordinates with
  `event.isTrusted === true`,
* the replayed trail only visits recorded positions, in the recorded order,
* `10×` really compresses the timeline (~10× in the page's own clock) and `5` repetitions emit
  `5×` the events,
* the fallback engine reproduces the same gestures without the debugger, at full trail coverage,
* the click's **default action** really happens: a replayed click checks a checkbox, activates a
  `<label for>` (which toggles its control), selects a radio button, and fires the `change` events
  frameworks hook into - verified for both engines, for 1 and for 2 repetitions, from a reset
  baseline. One subtlety the suite pins down: clicking a `<label for>` makes the browser dispatch a
  *second* click on the labelled control in the same millisecond; the recorder drops that forwarded
  twin, otherwise a replay would toggle the checkbox twice and land back where it started. A radio
  that is already selected fires no further `change` - again exactly what real input does,
* the **mouse wheel** scrolls on replay: opening a `<details>` block, the suite wheels a 62-row list
  of checkboxes from the top to the bottom, ticking one checkbox per row on the way, and the replay
  has to tick all 62 again and leave the panel at the offset the recording left it at - on both
  engines, with as many wheel gestures reaching the page as were recorded (all of them trusted ones,
  for the real-input engine) each at the recorded point and with the recorded pixel distance,
* Stop and Cancel work, the dialog defaults to 1 repetition at `1×`, wild inputs are clamped,
  clearing works, replay after scrolling still hits the same element, and recordings are per tab,
* the popup is sized as one box for every view - the replay dialog (and its **Start playback**
  button) can never be cut off by the popup window, which Chrome measures from the document and
  never grows for overlays,
* the keyboard shortcuts survive Chrome, the popup's own activate key included: the bindings
  `chrome.commands.getAll()` reports are
  exactly the ones the manifest suggests (Chrome silently drops a suggested key it cannot claim),
  the popup shows those live bindings, the command path records / stops recording / cancels a
  replay through the same code an accelerator press takes, and a plain web page cannot fire a
  command - extension contexts only.

## 6. Privacy

Nothing leaves the extension: no network requests, no analytics, no external code. The recording
is a list of timestamps and coordinates held in memory and in `chrome.storage.session` for the
current browser session only.
