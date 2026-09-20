/**
 * Debug helper: record one gesture, then replay it at 1x and 10x and dump the
 * page-side timestamps so the scheduling can be inspected.
 *
 *   xvfb-run -a node tools/debug-speed.mjs
 */
import {
  launchWithExtension,
  openPopup,
  resetPageLog,
  readPageLog,
  boxCenter,
  glide,
  sleep,
  waitForContentScript,
  resetPlayState,
  waitPlaybackFinished
} from '../tests/helpers/browser.mjs';

const app = await launchWithExtension();
const { context, extensionId, server } = app;
const base = `chrome-extension://${extensionId}`;

const page = await context.newPage();
await page.goto(server.url('/testpage.html'));
await page.waitForLoadState('load');
await waitForContentScript(page);
const popup = await openPopup(context, base);

const centers = {
  a: await boxCenter(page, '#box-a'),
  b: await boxCenter(page, '#box-b'),
  c: await boxCenter(page, '#box-c')
};

async function waitForPill(text) {
  for (;;) {
    const v = (await popup.locator('#state-pill').textContent()).trim();
    if (v === text) return;
    await sleep(120);
  }
}

async function gesture() {
  const m = page.mouse;
  const dragEnd = { x: centers.c.x + 120, y: centers.c.y + 60 };
  await m.move(20, 20);
  await sleep(90);
  await glide(m, { x: 20, y: 20 }, centers.a, 7);
  await sleep(110);
  await m.click(centers.a.x, centers.a.y);
  await sleep(150);
  await glide(m, centers.a, centers.b, 7);
  await sleep(110);
  await m.click(centers.b.x, centers.b.y);
  await sleep(150);
  await glide(m, centers.b, centers.c, 5);
  await sleep(90);
  await m.down();
  await sleep(70);
  await glide(m, centers.c, dragEnd, 6);
  await sleep(60);
  await m.up();
  await sleep(120);
}

async function play({ repetitions, speed }) {
  await resetPageLog(page);
  await popup.click('#btn-play');
  await popup.waitForSelector('#play-form', { state: 'visible' });
  await popup.locator('#repetitions').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, repetitions);
  await popup.locator('#speed').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, speed);
  const estimate = await popup.locator('#estimate').textContent();
  await resetPlayState(page);
  await popup.click('#btn-confirm');
  const t0 = Date.now();
  const state = await waitPlaybackFinished(page, 60_000);
  const wall = Date.now() - t0;
  const { log } = await readPageLog(page);
  return { state, wall, estimate, log };
}

await popup.click('#btn-record');
await waitForPill('Recording');
await gesture();
await popup.click('#btn-record');
await waitForPill('Ready');

const lengthSec = parseFloat(await popup.locator('#m-length').textContent());
const events = Number(await popup.locator('#m-events').textContent());
console.log(`recorded: ${events} events, ${lengthSec}s`);
const recordedMoves = await page.evaluate(() =>
  window.__emmLog.filter((e) => e.type === 'mousemove').map((e) => [e.x, e.y])
);
console.log('recorded moves:', recordedMoves.length);

for (const cfg of [{ repetitions: 1, speed: 1 }, { repetitions: 1, speed: 10 }, { repetitions: 3, speed: 10 }]) {
  const r = await play(cfg);
  const base = r.log.length ? r.log[0].t : 0;
  const gaps = r.log.map((e) => Math.round(e.t - base));
  const playedMoves = r.log.filter((e) => e.type === 'mousemove');
  let matched = 0;
  for (const [x, y] of recordedMoves) {
    if (playedMoves.some((e) => Math.abs(e.x - x) <= 2 && Math.abs(e.y - y) <= 2)) matched++;
  }
  console.log(
    `play ${JSON.stringify(cfg)} -> ${r.state} wall=${r.wall}ms span=${gaps.length ? gaps[gaps.length - 1] : 0}ms ` +
      `events=${r.log.length} coverage=${matched}/${recordedMoves.length} (${((100 * matched) / recordedMoves.length).toFixed(0)}%)\n` +
      `   estimate: ${r.estimate}  planned span=${(r.estimate.match(/[\d.]+/) || ['?'])[0]}s`
  );
}

await popup.close();
await page.close();
await app.close();
