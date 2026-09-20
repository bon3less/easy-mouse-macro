/**
 * Static integrity checks for the unpacked extension.
 * Run with: node tools/check-extension.mjs
 *
 * These are the checks Chrome itself performs when you press "Load unpacked",
 * reproduced here so regressions are caught without a browser.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extension');
const problems = [];

const manifestPath = join(extDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const check = (cond, message) => {
  if (!cond) problems.push(message);
};

check(manifest.manifest_version === 3, 'manifest_version must be 3');
check(typeof manifest.name === 'string' && manifest.name.length <= 75, 'name missing or too long (>75)');
check(typeof manifest.description === 'string' && manifest.description.length <= 132, 'description missing or too long (>132)');
check(/^\d+(\.\d+){0,3}$/.test(manifest.version || ''), 'invalid version string');
check(!!manifest.action?.default_popup, 'action.default_popup missing');
check(!!manifest.background?.service_worker, 'background.service_worker missing');
check(manifest.background.type === undefined, 'background.service_worker must be a classic worker (no "type": "module") so importScripts works');

const files = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...(manifest.content_scripts || []).flatMap((cs) => cs.js || [])
];
for (const rel of new Set(files)) {
  const abs = join(extDir, rel);
  check(existsSync(abs) && statSync(abs).isFile(), `referenced file missing: ${rel}`);
  check(!rel.startsWith('/'), `referenced path must be relative: ${rel}`);
}
for (const [size, rel] of Object.entries(manifest.icons || {})) {
  check(existsSync(join(extDir, rel)), `icon missing: ${rel} (${size}px)`);
  check(Number(size) === Number(rel.match(/(\d+)/)?.[1]), `icon size key does not match file: ${rel}`);
}
check(
  existsSync(join(extDir, 'popup.css')),
  'popup.css missing (referenced by popup.html)'
);

// Popup HTML must not inline scripts or styles and must reference local files only.
const popupHtml = readFileSync(join(extDir, 'popup.html'), 'utf8');
check(!/<script[^>]*\ssrc=["']https?:/i.test(popupHtml), 'popup.html must not load remote scripts (MV3 CSP)');
check(!/<script[^>]*>(?!\s*<\/script>)[^<]/i.test(popupHtml), 'popup.html must not use inline scripts (MV3 CSP)');
for (const m of popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(https?:|data:|chrome-extension:)/.test(ref)) {
    problems.push(`popup.html references a non-local resource: ${ref}`);
    continue;
  }
  check(existsSync(join(extDir, ref)), `popup.html references missing file: ${ref}`);
}

// Content script order matters: the shared lib has to come first.
for (const cs of manifest.content_scripts || []) {
  const idx = (cs.js || []).indexOf('lib/macro-core.js');
  const contentIdx = (cs.js || []).indexOf('content.js');
  check(idx !== -1 && contentIdx !== -1, 'content_scripts must load lib/macro-core.js and content.js');
  check(idx < contentIdx, 'lib/macro-core.js must be listed before content.js');
  check(
    (cs.js || []).every((f) => existsSync(join(extDir, f))),
    'content_scripts references a missing file'
  );
}

// The shared core must stay free of browser APIs so it can be unit tested.
// (Comments are stripped first - documenting "chrome.debugger" is fine.)
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const core = stripComments(readFileSync(join(extDir, 'lib/macro-core.js'), 'utf8'));
check(!/\bchrome\./.test(core), 'lib/macro-core.js must not reference chrome.* APIs');
check(!/\bdocument\./.test(core), 'lib/macro-core.js must not reference document.*');
check(!/\bwindow\./.test(core), 'lib/macro-core.js must not reference window.*');

// Every permission has to be a real, known permission name.
const KNOWN_PERMISSIONS = new Set([
  'storage', 'unlimitedStorage', 'scripting', 'debugger', 'activeTab', 'tabs',
  'alarms', 'notifications', 'offscreen', 'sidePanel'
]);
for (const perm of manifest.permissions || []) {
  check(KNOWN_PERMISSIONS.has(perm), `unknown permission requested: ${perm}`);
}
check((manifest.host_permissions || []).length > 0, 'host_permissions must allow the target pages');
check(
  (manifest.host_permissions || []).every((h) => /^(https?:\/\/|file:\/\/|\*|<all_urls>$)/.test(h)),
  'host_permissions entries must be match patterns'
);

// No source file may contain stray build artefacts / TypeScript syntax.
const jsFiles = ['background.js', 'content.js', 'popup.js', 'lib/macro-core.js'];
for (const rel of jsFiles) {
  const src = readFileSync(join(extDir, rel), 'utf8');
  check(!src.includes('import.meta'), `${rel} must be a classic script (no import.meta)`);
  check(!/^\s*(import|export)\s/m.test(src), `${rel} must not use ESM syntax in a classic script`);
  try {
    execFileSync(process.execPath, ['--check', join(extDir, rel)], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${rel} has a syntax error: ${String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')}`);
  }
}

// Keyboard shortcuts: Chrome silently drops a command whose name or accelerator
// is invalid, so an unusable shortcut would ship without any visible error.
const MODIFIERS = new Set(['Alt', 'Ctrl', 'Command', 'MacCtrl', 'Shift']);
const ALLOWED_KEYS = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
);
const RESERVED_ACCELERATORS = new Set([
  'Ctrl+0', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7',
  'Ctrl+8', 'Ctrl+9', 'Ctrl+Shift+Backspace', 'Ctrl+Shift+Delete', 'Ctrl+Plus',
  'Ctrl+NumpadPlus', 'Alt+F4', 'Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+N'
]);
// One command name belongs to Chrome itself: `_execute_action` is Chrome's
// *Activate extension*, and Chrome performs it - the name is never delivered to
// `chrome.commands.onCommand`, so it is the single declared command that
// background.js must not handle (handling it would be dead code).
// Its suggested_key is honoured like any other (measured on Chrome 149: a
// manifest asking for Alt+Shift+K there got exactly that binding), but a key
// Chrome will not give to anyone is dropped silently, as Alt+Shift+W was - so
// the suite asserts chrome.commands.getAll() reports the asked-for binding.
const CHROME_OWNED_COMMAND = '_execute_action';
const seenAccelerators = new Set();
const commandNames = Object.keys(manifest.commands || {});
check(commandNames.length > 0, 'commands: at least one keyboard shortcut is expected');
for (const [name, cmd] of Object.entries(manifest.commands || {})) {
  check(
    name === CHROME_OWNED_COMMAND || /^[a-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/.test(name),
    `commands: odd name "${name}"`
  );
  check(typeof cmd.description === 'string' && cmd.description.length > 0, `commands: ${name} needs a description`);
  const accelerator = cmd.suggested_key && (cmd.suggested_key.default || cmd.suggested_key.chromeos);
  check(typeof accelerator === 'string', `commands: ${name} needs a suggested_key.default`);
  if (typeof accelerator !== 'string') continue;
  const parts = accelerator.split('+');
  const key = parts.pop();
  const mods = parts.slice().sort();
  check(ALLOWED_KEYS.has(key), `commands: ${name} has an unusable key "${key}"`);
  check(mods.length > 0, `commands: ${name} needs at least one modifier (${accelerator})`);
  check(mods.every((m) => MODIFIERS.has(m)), `commands: ${name} uses an unknown modifier in ${accelerator}`);
  check(new Set(mods).size === mods.length, `commands: ${name} repeats a modifier in ${accelerator}`);
  check(!RESERVED_ACCELERATORS.has(accelerator), `commands: ${accelerator} (${name}) is reserved by Chrome`);
  check(!seenAccelerators.has(accelerator), `commands: ${accelerator} is used by two commands`);
  seenAccelerators.add(accelerator);
}

const backgroundSrc = readFileSync(join(extDir, 'background.js'), 'utf8');
check(/chrome\.commands\.onCommand\.addListener/.test(backgroundSrc), 'background.js must listen for chrome.commands.onCommand');
for (const name of commandNames) {
  if (name === CHROME_OWNED_COMMAND) continue;
  check(backgroundSrc.includes(`'${name}'`), `background.js never handles the declared command ${name}`);
}

// The popup must be able to grow: an action popup is measured from its document,
// so a dialog in a fixed-position overlay gets clipped by the window instead.
const popupCss = readFileSync(join(extDir, 'popup.css'), 'utf8');
check(!/\.dialog-backdrop\s*{[^}]*position:\s*fixed/s.test(popupCss), 'popup.css: the dialog must not use position: fixed (an action popup never grows for it, so its bottom gets cut off)');
check(/body\s*{[^}]*height:\s*var\(--popup-h\)/s.test(popupCss), 'popup.css: body needs an explicit height so every view fits the popup window');

if (problems.length) {
  console.error('check-extension: FAILED');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('check-extension: OK (' + files.length + ' referenced files, manifest v' + manifest.manifest_version + ')');
