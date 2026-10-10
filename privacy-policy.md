# Privacy Policy

Applies to the **Easy Mouse** Macro browser extension (1.0.0 and later), in every channel in which it is distributed.
Last updated: 2026-10-10

> **Easy Mouse Macro does not collect, transmit, sell or share any data.** It has no server, no account, no analytics and no network code of any kind. Everything it records stays in your own Chrome profile, on your own computer, and you can delete it at any time.

## 1. What the extension does

Easy Mouse Macro records the pointer actions you make in the browser tab you are looking at - mouse movements, mouse-button clicks and wheel scrolling - together with two keys, **\<TAB\>** and **\<SPACE\>** - and replays that recording in the same tab, at the number of repetitions and the speed (1x-10x) you choose. It has this single purpose and no other feature.

## 2. What it processes

| Data | Why | Where it lives | How long |
| --- | --- | --- | --- |
| Timestamps, x/y coordinates, mouse button, wheel deltas | To replay your actions | Memory, then `chrome.storage.session` (recording in progress) and `chrome.storage.local` (history) in your local Chrome profile | Recording: until you clear it or close the browser. History: until you delete it, lower the "keep" limit, or uninstall. |
| Two key identifiers only: **\<TAB\>** and **\<SPACE\>** | To replay focus movement and control activation | Same as above | Same as above |
| The **host name** of the page a macro came from (no path, no query) | To label a stored macro with the page its coordinates belong to | `chrome.storage.local` | Same as above |
| Settings: how many macros to keep, whether to use real browser input | To remember your preferences | `chrome.storage.local` | Until changed or uninstalled |

**What it never touches:** text you type, passwords, form values, cookies, website storage, bookmarks, browsing history, downloads, other open tabs, your name, your e-mail address, or any identifier of you or your device. Only **\<TAB\>** and **\<SPACE\>** can be recorded - no other key produces an event, so the extension cannot capture credentials or typed content. Only the top-level frame of `http(s)://` and `file://` pages can be recorded; `chrome://` pages, the web store and other extensions' pages are refused in code.

## 3. No data leaves your device

The extension contains no network code at all - no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`. There is no backend, no telemetry, no crash reporting, no analytics, no advertising, no tracking, no update or licensing server, and no third-party script. Its content security policy is `script-src 'self'; object-src 'self'`, and every line of code it runs ships inside the installed package: no remotely hosted or dynamically generated code is loaded or executed.

For that reason none of the data in section 2 is *collected* in the sense of the Chrome Web Store user-data policy, the EU GDPR or the CCPA: it is processed locally on your device, by software you control, and is never transferred to us or to anyone else.

## 4. Where the data goes

Nowhere. It is not sold, rented, traded, transferred, or disclosed to third parties, advertisers, data brokers or affiliates - for any purpose, including marketing, personalisation, research or scoring. We have no technical ability to receive it.

## 5. Your control

* **Clear recording** empties the current recording; **x** removes one history entry; **Clear history** removes all of them.
* Lowering the history's **Keep** number deletes the oldest entries immediately.
* Data in `chrome.storage.session` is discarded by Chrome when the browser closes.
* **Uninstalling the extension deletes everything it stored.** No copy is retained anywhere else.
* You can verify all of this: the extension is published as plain, unminified source at [github.com/bon3less/easy-mouse-macro](https://github.com/bon3less/easy-mouse-macro).

## 6. Permissions, and why each one is needed

| Permission | Why it is needed |
| --- | --- |
| Host access to `http://*/*`, `https://*/*`, `file://*/*` | The recorder must run on the ordinary web page you are recording. Used only to inject the extension's own packaged files into that tab, to talk to it, and to read the tab's host for a label. Never used to contact a server. |
| `scripting` | Re-injecting the extension's two packaged content-script files into a tab that was already open before the extension was installed or updated. Literal file paths inside the package; nothing from outside is ever injected. |
| `debugger` | Replay only. Delivers your recorded input as genuine browser input through Chrome DevTools Protocol `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` on the one tab you are replaying in. No other CDP domain is used, so no page content, DOM, cookies or network data can be read. Chrome itself shows the "started debugging this browser" banner; dismissing it ends the session. The popup's *Use real browser input* switch turns the debugger off entirely and replays with page-level events instead. |
| `storage` | Keeping your recording, your history of macros and your settings in your local Chrome profile. |
| `unlimitedStorage` | A macro can hold up to 40 000 events and the history can keep up to 50 macros, which is larger than the default local quota; this raises the *local disk* limit only and does not change where data goes. |

## 7. Children

The extension is not directed at children and is intended for users aged 13 and over. It collects no data from anyone, including children.

## 8. Changes to this policy

If this policy changes, the date above changes and an updated copy is published at the same address. Material changes to what the extension does with data will also come with a new extension version.

---

*Easy Mouse Macro - Privacy Policy - No servers, no analytics, no tracking.*
