# Easy Mouse Macro

Record the mouse **movements, clicks and wheel scrolling** you make in a browser tab, plus the
**TAB** and **SPACE** keys, and replay them in that same tab - as many times as you want, at
1x-10x speed.

Plain, unpacked Manifest V3: no bundler, no build step, no minifier. Every line that runs is
readable.

Jump to: [Install](#install), [Use it](#use-it), [Shortcuts](#shortcuts),
[How the replay works](#how-the-replay-works), [Known limits](#known-limits), [Privacy](#privacy)

Working on the code? Read [AGENTS.md](AGENTS.md). What shipped and when: [CHANGELOG.md](CHANGELOG.md).

## Install

Needs Google Chrome **116 or newer**.

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the **`extension/`** folder (the one holding `manifest.json`,
   not the project root).
3. Pin **Easy Mouse Macro** from the puzzle-piece menu.

To record local pages, also enable *Allow access to file URLs* on the extension's details page.

## Use it

1. Go to the page the macro should run on.
2. Open the popup and press **Record**. The toolbar badge turns red (`REC`) and the popup counts
   events live.
3. Move the mouse, click, scroll the wheel, press **TAB** or **SPACE** - exactly the way you want it
   replayed. Press **Stop recording**.
4. Press **Play**: pick **Repetitions** (default 1) and **Speed** (`1x` recorded, up to `10x` as
   fast, default `1x`), check the time estimate, confirm with **Start playback**.
5. A red ghost cursor shows where the macro points and a ring pulses on every button press.
   **Stop playback** aborts at any time, **Clear recording** starts over.

The recording in hand lives in `chrome.storage.session`, so closing the popup - or Chrome recycling
the extension's worker - does not lose it. It lasts until the browser session ends, the tab closes,
or you clear it. Everything you finish is also filed in **History**, and that is what survives a
restart.

### History

| To | Do |
| --- | --- |
| Load a macro | click its row. **Play** then replays it in the tab you are looking at now |
| Rename a row | the pencil turns it into a field, `Enter` commits, `Esc` cancels, an empty name hands the row back its host label |
| Forget one macro | `x` on the row. **Clear history** forgets every one |
| Choose how many are kept | **Keep** in the history header: 5, 10 (default), 20 or 50. Lowering it drops the oldest at once |

**Clear recording** empties the slot only, never the history. A recording that holds no events is not
filed: a row that replays nothing is not a macro. Macros live as plain JSON in `chrome.storage.local`
in your own Chrome profile - unencrypted, not synced, gone when you clear it.

Following a link, reloading or closing the tab **ends a recording** - the recorder lives in the page -
but nothing already seen is lost: it is filed in the history as if you had pressed Stop recording.

## Shortcuts

| Shortcut | What it does |
| --- | --- |
| `Alt+Shift+Q` | open the popup (Chrome's *Activate extension*) |
| `Alt+Shift+E` | start or stop recording in the focused tab |
| `Alt+Shift+S` | stop a running playback without losing the recording |

Rebind them at `chrome://extensions/shortcuts`. The popup always shows the bindings Chrome actually
uses; if Chrome cannot claim a suggested key, that shortcut comes up as *not set* and any free
combination will do.

## How the replay works

| Engine | What it does | When |
| --- | --- | --- |
| **Real browser input** (default) | the worker attaches with `chrome.debugger` and sends CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, so the page sees genuine trusted input: hover states, `:active` styles, drag-and-drop, sites that ignore scripted events | always, unless the debugger cannot attach or you untick the option |
| **Page-level events** (fallback) | the content script dispatches `PointerEvent` / `MouseEvent` / `KeyboardEvent` at the recorded coordinates and performs the default action | automatic fallback, or when you untick *Use real browser input* |

Two things to know:

* Real input makes Chrome show its *"Easy Mouse Macro started debugging this browser"* banner. That is
  Chrome's own notice about `chrome.debugger`, it does not affect the macro, and unticking the option
  avoids it.
* No extension can move your **operating-system** cursor or drive other applications. Everything
  happens inside the recorded tab, which is why the extension draws a ghost cursor.

## Known limits

* Only the top frame of `http(s)://` and `file://` pages, never `chrome://`, the Web Store or other
  extensions' pages.
* Only **TAB** (with `Shift` for backwards) and **SPACE** are recorded. No other key, and no typed
  text, so a control a page only activates with `Enter` is out of reach.
* Keys act on whatever is **focused**, so a replay needs to start where the recording started.
* Coordinates belong to the recorded page: replaying a macro on a different page presses the pixels it
  remembers. Every row names the host it came from for that reason.
* Cross-monitor and multi-window replay is out of scope.
* A focused `<select>` answers SPACE with Chrome's own dropdown, which no replay can open.
* Gestures Chrome owns - pinch zoom, `Ctrl`+wheel zoom, overscroll flinging - are not reproduced, and
  Chrome may batch two close notches into one scroll.
* A recorded right-click opens Chrome's native context menu on replay.
* A recording is capped at 40 000 events / 4 hours, `mousemove` is throttled (~10 ms or 2 px), and the
  history can hold up to 50 macros: that is what `unlimitedStorage` is for, and **Clear history** is
  the way back down.

## Privacy

Nothing leaves the extension: no network requests, no analytics, no external code, no remote code. A
recording is a list of timestamps and coordinates held in memory and in `chrome.storage.local` inside
your own Chrome profile, and uninstalling deletes it. Details, permission by permission:
[privacy-policy.md](privacy-policy.md).

## Development

```bash
npm test          # static checks + unit tests + browser E2E (needs Xvfb)
npm run check     # static manifest / CSP / file-reference checks only
npm run test:unit # unit tests only (no browser)
npm run test:e2e  # browser E2E only (uses xvfb-run -a)
```

`playwright` (1.61.1) is the only dev dependency. Layout, architecture, gotchas and how to work on
this without breaking it: [AGENTS.md](AGENTS.md).
