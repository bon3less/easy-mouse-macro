import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extDir = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));

const read = (rel) => readFileSync(join(extDir, rel), 'utf8');

test('manifest is a loadable Manifest V3 (Chrome 116+ / 153.x) manifest', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
  assert.ok(manifest.name.length <= 75);
  assert.ok(manifest.description.length <= 132);
  assert.ok(Number(manifest.minimum_chrome_version) >= 100);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('every file the manifest references exists on disk (Load unpacked check)', () => {
  const refs = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
    ...Object.values(manifest.permissions && manifest.permissions ? manifest.icons || {} : {})
  ]);
  for (const rel of refs) {
    assert.ok(!rel.startsWith('/'), `path must be relative to the extension root: ${rel}`);
    assert.ok(existsSync(join(extDir, rel)), `missing: ${rel}`);
  }
});

test('permissions are the minimum needed and no host is over-broad', () => {
  assert.ok(manifest.permissions.includes('debugger'), 'trusted replay needs the debugger permission');
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(!manifest.permissions.includes('webRequest'), 'no unnecessary permissions');
  assert.ok(!manifest.permissions.includes('nativeMessaging'));
  assert.ok(!manifest.permissions.includes('<all_urls>'));
  for (const h of manifest.host_permissions) {
    assert.match(h, /^(https?:\/\/\*\/\*|file:\/\/\*\/\*)$/, `unexpected host pattern ${h}`);
  }
});

test('content scripts load the shared core before the recorder', () => {
  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.js, ['lib/macro-core.js', 'content.js']);
  assert.equal(cs.run_at, 'document_idle');
  assert.equal(cs.all_frames, false, 'only the top frame should be recorded');
});

test('popup is CSP-clean: no inline or remote code', () => {
  const html = read('popup.html');
  assert.ok(!/<script[^>]*\ssrc=["']https?:/i.test(html), 'remote script');
  assert.ok(!/onclick=|onload=|onchange=|oninput=/i.test(html), 'inline event handler');
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
});

test('the popup UI exposes Record, Play and the repetitions + speed dialog', () => {
  const html = read('popup.html');
  for (const id of [
    'btn-record',
    'btn-play',
    'repetitions',
    'speed',
    'btn-confirm',
    'btn-cancel',
    'btn-stop-play',
    'state-pill',
    'history-list',
    'btn-clear-history',
    'history-limit'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `popup is missing #${id}`);
  }
  const reps = html.match(/id="repetitions"[^>]*value="(\d+)"/);
  const speed = html.match(/id="speed"[^>]*value="(\d+)"/);
  assert.equal(reps[1], '1', 'repetitions must default to 1');
  assert.equal(speed[1], '1', 'speed must default to 1x');
  assert.match(html, /id="speed"[^>]*min="1"[^>]*max="10"/, 'speed slider must span 1-10');
});

test('all extension scripts parse as classic scripts', () => {
  for (const rel of ['background.js', 'content.js', 'popup.js', 'lib/macro-core.js']) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(extDir, rel)], { stdio: 'pipe' }), `${rel} must parse`);
  }
});

test('the service worker can importScripts the shared core', () => {
  const bg = read('background.js');
  assert.match(bg, /importScripts\(\s*'lib\/macro-core\.js'\s*\)/);
  assert.ok(!/^\s*import\s/m.test(bg), 'service worker is a classic worker: no ESM import');
});

test('recorded event vocabulary matches between recorder, scheduler and CDP mapper', () => {
  const core = read('lib/macro-core.js');
  const content = read('content.js');
  const bg = read('background.js');
  for (const type of ['move', 'down', 'up', 'click', 'dblclick', 'contextmenu', 'wheel', 'key']) {
    assert.ok(core.includes(`'${type}'`), `core must know "${type}"`);
  }
  // The recorder has to wire up moves, the wheel and the three click flavours.
  for (const listener of ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown']) {
    assert.ok(content.includes(`${listener}:`) || content.includes(`${listener}:`), `recorder missing ${listener}`);
  }
  // And the wheel has to reach both replay engines: the CDP mapper ...
  assert.match(core, /mouseWheel/, 'the CDP mapper never emits a mouse wheel');
  // ... and the page-side synthetic engine.
  assert.match(content, /WheelEvent/, 'the page-side replay never emits a wheel event');
  // A key reaches both engines too: CDP gets the press and the release ...
  assert.match(core, /toCdpKeyCommands/, 'the CDP mapper never emits a key press');
  assert.match(bg, /Input\.dispatchKeyEvent/, 'the trusted engine never dispatches a key');
  // ... and the page-side engine synthesizes one.
  assert.match(content, /KeyboardEvent/, 'the page-side replay never emits a key event');
  assert.match(content, /scrollChainFor/, 'the recorder ignores the page\u0027s own scroll containers');
  assert.match(content, /restoreScrollChain/, 'the replay never restores an inner scroll position');
});

test('popup wires its buttons to the background protocol', () => {
  // Messages are built as MSG + ':suffix', so assert on the suffixes.
  const popup = read('popup.js');
  const bg = read('background.js');
  assert.match(popup, /var MSG = 'emm';/, 'popup must use the emm message namespace');
  assert.match(bg, /var MSG = 'emm';/, 'background must use the emm message namespace');
  for (const msg of [
    ':record-start',
    ':record-stop',
    ':play-stop',
    ':play',
    ':clear',
    ':state',
    ':history-load',
    ':history-delete',
    ':history-clear',
    ':history-rename',
    ':history-limit'
  ]) {
    assert.ok(popup.includes(`'${msg}'`), `popup never sends ${msg}`);
  }
  for (const msg of [
    ':record-start',
    ':record-stop',
    ':play-stop',
    ':play',
    ':clear',
    ':state',
    ':trusted',
    ':history',
    ':history-load',
    ':history-delete',
    ':history-clear',
    ':history-rename',
    ':history-limit'
  ]) {
    assert.ok(bg.includes(`'${msg}'`), `background never handles ${msg}`);
  }
});

test('a stored macro outlives the browser, a working recording does not', () => {
  // chrome.storage.session is memory: Chrome throws it away when the browser
  // closes, which is right for the recording slot of a tab and wrong for the
  // history the user asked to keep.
  const bg = read('background.js');
  assert.match(bg, /chrome\.storage\.local\.get\(HISTORY_KEY\)/, 'the history is not read from durable storage');
  assert.match(bg, /chrome\.storage\.local\.set\(/, 'the history is never written to durable storage');
  assert.match(bg, /chrome\.storage\.session/, 'the per-tab session must stay in memory');
  assert.match(bg, /core\.addHistoryEntry\(list, \{[^}]*events: events/, 'a finished macro is filed without its events');
  // Everything the popup shows about a macro comes back as rows: sending ten
  // macros of events four times a second is not a thing the popup should ask for.
  assert.match(bg, /history: core\.historyRows\(history\)|history: rows/, 'the state leaks whole macros to the popup');
});

test('a recording outlives the page it was being made on', () => {
  // The buffer is in the page, and a page that navigates is destroyed with it.
  // So the recorder has to hand events over while the document is still alive:
  // there is no Stop to wait for when a link is what ended the recording.
  const content = read('content.js');
  const bg = read('background.js');
  assert.match(content, /MSG \+ ':record-flush'/, 'the recorder never hands events to the worker while recording');
  assert.match(content, /addEventListener\('pagehide'/, 'the buffer is never handed over as the document goes away');
  assert.match(bg, /case MSG \+ ':record-flush'/, 'the worker never accepts the recorder\u0027s handovers');
  assert.match(bg, /endRecordingAtNavigation/, 'a navigation still throws the finished recording away');
  assert.match(bg, /fileNavigationRecording/, 'a recording ended by navigation is never filed in the history');
  // A handover says where its slice starts, so one arriving twice is not two
  // clicks on replay.
  assert.match(bg, /s\.events\.slice\(0, start\)\.concat\(tail\)/, 'a repeated handover would duplicate events');
});

test('the history cap is read from storage, not baked into the calls', () => {
  // Every core call that needs the cap must be given it: a literal there would
  // quietly keep ten macros no matter what the user chose.
  const bg = read('background.js');
  assert.match(bg, /core\.addHistoryEntry\(list, \{ [^\n]*\}, limit\)/, 'filing ignores the user\u0027s cap');
  assert.match(bg, /core\.normalizeHistory\(got && got\[HISTORY_KEY\], limit\)/, 'loading ignores the user\u0027s cap');
  assert.match(bg, /payload\[SETTINGS_KEY\] = \{ historyLimit: limit \}/, 'the chosen cap is never saved');
  assert.match(bg, /core\.normalizeLimit\(/, 'a stored cap is taken on faith');
});
