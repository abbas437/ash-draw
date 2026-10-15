#!/usr/bin/env node
// Browser end-to-end test of the side panel: collapse to its strip, fold sections, state kept across a reload; window title.
// Uses the browser fallback of window.api (shim.js); Electron-only features (DWG) are covered elsewhere.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
let step = 'start';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  const ready = () => page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
  await ready();

  const canvasW = () => page.evaluate(() => document.getElementById('cv').getBoundingClientRect().width);
  const bufferW = () => page.evaluate(() => document.getElementById('cv').width);
  const shown = (sel) => page.locator(sel).isVisible();
  const markupsOpen = () => page.evaluate(() => getComputedStyle(document.getElementById('markups')).display !== 'none'); // the list is empty: no size

  step = 'defaults: panel shown, every section unfolded, toggle on the panel edge';
  assert.equal(await shown('#layers'), true);
  assert.equal(await markupsOpen(), true);
  assert.equal(await shown('#props'), true);
  assert.equal(await page.locator('#side-toggle').textContent(), '\u00BB');

  step = 'resize: drag the left edge; min 220 px, max half the window; width kept across a reload';
  const sideW = () => page.evaluate(() => document.getElementById('side').getBoundingClientRect().width);
  const dragTo = async (x) => {
    const g = await page.locator('#side-grip').boundingBox();
    await page.mouse.move(g.x + 2, g.y + 100); await page.mouse.down(); await page.mouse.move(x, g.y + 100, { steps: 5 }); await page.mouse.up();
  };
  assert.ok(Math.abs((await sideW()) - 340) <= 1, `default width ${await sideW()}`);
  await dragTo(1400 - 420);
  assert.ok(Math.abs((await sideW()) - 420) <= 2, `dragged width ${await sideW()}`);
  await dragTo(1400 - 100);
  assert.equal(Math.round(await sideW()), 220, 'min width');
  await dragTo(5);
  assert.equal(Math.round(await sideW()), 700, 'max half the window');
  await dragTo(1400 - 380);
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => Math.abs(document.getElementById('side').getBoundingClientRect().width - 380) <= 2, null, { timeout: 5000 });

  step = 'title shows the product and the build version';
  await page.waitForFunction(() => /ASH Draw Studio web$/.test(document.title), null, { timeout: 5000 }); // shim.js answers api.version() with 'web'
  assert.match(await page.title(), /ASH Draw Studio/);

  step = 'toggle: panel collapses to its icon rail, canvas takes the freed width and its buffer follows';
  const w0 = await canvasW(), b0 = await bufferW();
  await page.locator('#side-toggle').click();
  await page.waitForFunction((w) => document.getElementById('cv').getBoundingClientRect().width > w + 200, w0, { timeout: 5000 });
  assert.equal(await shown('#layers'), false, 'layer list hidden');
  assert.equal(await shown('#side-toggle'), true, 'strip button stays');
  assert.ok((await page.locator('#side').boundingBox()).width <= 41, 'icon rail');
  await page.waitForFunction((b) => document.getElementById('cv').width > b, b0, { timeout: 5000 });

  step = 'toggle back restores the panel and the canvas width';
  await page.locator('#side-toggle').click();
  await page.waitForFunction((w) => Math.abs(document.getElementById('cv').getBoundingClientRect().width - w) < 1, w0, { timeout: 5000 });
  assert.equal(await shown('#layers'), true);

  step = 'View > Side panel: Collapsed and Ctrl+3 toggle it too';
  await page.locator('#menubar .menu > button', { hasText: /^View$/ }).click();
  const item = page.locator('#menubar .menu.open .drop button', { hasText: /^.?Side panel: Expanded/ });
  assert.equal(await item.getAttribute('aria-checked'), 'true');
  await page.locator('#menubar .menu.open .drop button', { hasText: /^.?Side panel: Collapsed/ }).click();
  assert.equal(await shown('#layers'), false);
  await page.locator('#cv').focus();
  await page.keyboard.press('Control+3');
  assert.equal(await shown('#layers'), true, 'Ctrl+3 shows it again');

  step = 'header buttons do not fold; clicking the Layers header folds the layer list only';
  await page.locator('#mk-csv').evaluate((b) => b.closest('.phead').querySelector('select').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal(await markupsOpen(), true, 'a click on the filter list leaves Markups open');
  await page.locator('#side .panel[data-sec=layers] .phead').click({ position: { x: 30, y: 8 } });
  assert.equal(await shown('#layers'), false, 'layer list hidden');
  assert.equal(await shown('#layer-add'), true, 'header stays');
  assert.equal(await markupsOpen(), true);
  assert.equal(await shown('#props'), true);
  assert.equal(await page.locator('#side .panel[data-sec=layers] .phead').getAttribute('aria-expanded'), 'false');

  step = 'Defaults for new objects folds and stays folded when Properties re-renders';
  await page.locator('#props .phead').click();
  await page.evaluate(() => window.app.refreshPanels());
  assert.equal(await page.locator('#props label').first().isVisible(), false);
  assert.equal(await shown('#props .phead'), true);

  step = 'collapse the panel, reload: collapsed and folded states restored';
  await page.locator('#side-toggle').click();
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('no-side'), null, { timeout: 5000 });
  await page.locator('#side-toggle').click();
  assert.equal(await shown('#layers'), false, 'Layers still folded after reload');
  assert.equal(await page.locator('#props label').first().isVisible(), false, 'Properties still folded');
  assert.equal(await markupsOpen(), true);

  step = 'LA unfolds Layers; header click unfolds Properties';
  await page.locator('#cmd').fill('LA'); await page.locator('#cmd').press('Enter');
  assert.equal(await shown('#layers'), true);
  await page.locator('#props .phead').click();
  assert.equal(await page.locator('#props label').first().isVisible(), true);

  assert.deepEqual(problems, []);
  console.log('sidepanel e2e: OK');
} catch (err) {
  console.error(`sidepanel e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
