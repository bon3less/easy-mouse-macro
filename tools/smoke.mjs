/* Smoke check for the harness itself + the trusted-input engine.
 * xvfb-run -a node tools/smoke.mjs        (add EMM_HEADLESS=1 for headless) */
import {
  launchWithExtension,
  openPopup,
  boxCenter,
  glide,
  sleep,
  resetPageLog
} from '../tests/helpers/browser.mjs';

const app = await launchWithExtension({ headless: process.env.EMM_HEADLESS === '1' });
const log = (...a) => console.log(...a);

try {
  log('extension id:', app.extensionId);
  log('worker url:', app.worker.url());

  const page = await app.context.newPage();
  await page.goto(app.server.url('/testpage.html'));
  await page.waitForLoadState('load');
  await sleep(600);
  // Content scripts live in an isolated world; the DOM marker is what the page
  // (and therefore page.evaluate) can observe.
  log('content script ready:', await page.evaluate(() => document.documentElement.dataset.emmReady === '1'));

  const popup = await openPopup(app.context, `chrome-extension://${app.extensionId}`);
  log('pill:', await popup.locator('#state-pill').textContent());
  log('target:', await popup.locator('#target').getAttribute('title'));

  const state = await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: 'emm:state' }));
  log('state:', JSON.stringify({ ok: state.ok, url: state.url, recording: state.recording }));

  const c = await boxCenter(page, '#box-a');

  // --- record ---------------------------------------------------------
  await popup.click('#btn-record');
  await sleep(500);
  log('pill while recording:', await popup.locator('#state-pill').textContent());
  await page.mouse.move(30, 30);
  await glide(page.mouse, { x: 30, y: 30 }, c, 6);
  await sleep(120);
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  await popup.click('#btn-record');
  await sleep(600);
  log('pill after stop:', await popup.locator('#state-pill').textContent());
  log('metrics:', await popup.evaluate(() => ({
    events: document.getElementById('m-events').textContent,
    moves: document.getElementById('m-moves').textContent,
    clicks: document.getElementById('m-clicks').textContent,
    length: document.getElementById('m-length').textContent
  })));
  log('recorded page events (ground truth):', await page.evaluate(() => window.__emmLog.length));

  // --- replay, trusted ------------------------------------------------
  await resetPageLog(page);
  await popup.click('#btn-play');
  await popup.waitForSelector('#play-form', { state: 'visible' });
  log('estimate:', await popup.locator('#estimate').textContent());
  await popup.click('#btn-confirm');
  await sleep(4500);
  log('pill after replay:', await popup.locator('#state-pill').textContent());
  const after = await page.evaluate(() => ({
    n: window.__emmLog.length,
    trusted: window.__emmLog.filter((e) => e.isTrusted).length,
    boxA: Number(document.getElementById('box-a').dataset.clicks) || 0,
    first: window.__emmLog.slice(0, 6).map((e) => e.type + '@' + e.x + ',' + e.y + ' t=' + e.t + ' trusted=' + e.isTrusted)
  }));
  log('after trusted replay:', JSON.stringify(after, null, 1));

  // --- replay, synthetic ---------------------------------------------
  await resetPageLog(page);
  await popup.click('#btn-play');
  await popup.waitForSelector('#play-form', { state: 'visible' });
  await popup.locator('#trusted').setChecked(false);
  await popup.click('#btn-confirm');
  await sleep(4500);
  const after2 = await page.evaluate(() => ({
    n: window.__emmLog.length,
    trusted: window.__emmLog.filter((e) => e.isTrusted).length,
    boxA: Number(document.getElementById('box-a').dataset.clicks) || 0,
    first: window.__emmLog.slice(0, 4).map((e) => e.type + '@' + e.x + ',' + e.y + ' trusted=' + e.isTrusted)
  }));
  log('after synthetic replay:', JSON.stringify(after2, null, 1));

  log('worker errors:', app.workerErrors);
} catch (err) {
  console.error('SMOKE FAILED:', err);
  process.exitCode = 1;
} finally {
  await app.close();
}
