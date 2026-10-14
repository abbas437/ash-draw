#!/usr/bin/env node
// Browser end-to-end test of named views (VIEW / V, the View menu, Plot with a named view); same harness as initview.mjs.
// Uses the browser fallback of window.api (shim.js); Electron-only features (DWG) are covered elsewhere.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

  const dxf = ['0', 'SECTION', '2', 'ENTITIES',
    ...[[0, 0, 100, 0], [100, 0, 100, 100], [100, 100, 0, 100], [0, 100, 0, 0], [5000, 5000, 5001, 5000]]
      .flatMap(([a, b, c, d]) => ['0', 'LINE', '8', '0', '10', a, '20', b, '30', '0', '11', c, '21', d, '31', '0'].map(String)),
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const chooser = new Promise((r) => page.once('filechooser', r));
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'namedview.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from(dxf) });
  await page.waitForFunction(() => window.app.file.name === 'namedview.dxf' && window.app.doc.entities.length === 5, null, { timeout: 8000 });

  const cmd = async (s) => { await page.locator('#cmd').fill(s); await page.locator('#cmd').press('Enter'); };
  const btn = (t) => page.locator('#dlg[open] .dlg-btns button', { hasText: t });
  const state = () => page.evaluate(() => { const v = window.app.vp.view; return { cx: v.cx, cy: v.cy, zoom: v.zoom, w: v.width / v.zoom, h: v.height / v.zoom }; });
  const near = (a, b, what) => assert.ok(Math.abs(a.cx - b.cx) < 0.01 * b.w && Math.abs(a.cy - b.cy) < 0.01 * b.h && Math.abs(a.zoom / b.zoom - 1) < 0.01, `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  const settle = () => page.waitForTimeout(700); // past the ZOOM Previous gesture window

  step = 'zoom to a known window';
  await page.evaluate(() => window.app.vp.zoomBox({ minx: 10, miny: 20, maxx: 60, maxy: 50 }, 0));
  const plant = await state();
  assert.ok(Math.abs(plant.cx - 35) < 0.01 && Math.abs(plant.cy - 35) < 0.01, `window view ${JSON.stringify(plant)}`);
  await settle();

  step = 'VIEW, Esc and Cancel do not throw';
  await cmd('VIEW'); await page.waitForSelector('#dlg[open] #view-list');
  await page.keyboard.press('Escape'); await page.waitForSelector('#dlg', { state: 'hidden' });
  await cmd('V'); await page.waitForSelector('#dlg[open] #view-list');
  await btn('New…').click(); await page.waitForSelector('#dlg[open] #view-name');
  await btn('Cancel').click(); await page.waitForSelector('#dlg[open] #view-list');
  await btn('Close').click(); await page.waitForSelector('#dlg', { state: 'hidden' });

  step = 'VIEW > New "Plant room" from the current display';
  await cmd('VIEW'); await page.waitForSelector('#dlg[open] #view-list');
  await btn('New…').click(); await page.waitForSelector('#dlg[open] #view-name');
  await page.locator('#view-name').fill('Plant room');
  await btn('OK').click(); await page.waitForSelector('#dlg[open] #view-list option[value="Plant room"]');
  await btn('Close').click(); await page.waitForSelector('#dlg', { state: 'hidden' });
  const saved = await page.evaluate(() => { const v = window.app.doc.views.get('PLANT ROOM'); return v && { ...v.center, w: v.width, h: v.height, space: v.space }; });
  assert.ok(saved && Math.abs(saved.x - 35) < 0.01 && Math.abs(saved.y - 35) < 0.01 && saved.space === 'model', `saved ${JSON.stringify(saved)}`);

  step = 'zoom extents, then Set current from the dialog';
  await cmd('ZE'); await page.waitForFunction(() => window.app.vp.view.zoom < 0.5, null, { timeout: 3000 });
  const ext = await state();
  await settle();
  await cmd('VIEW'); await page.waitForSelector('#dlg[open] #view-list');
  await page.locator('#view-list').selectOption('Plant room');
  await btn('Set current').click(); await page.waitForSelector('#dlg', { state: 'hidden' });
  near(await state(), plant, 'restored from the dialog');
  await settle();

  step = 'ZOOM P returns to the extents view';
  await cmd('Z'); await cmd('P');
  near(await state(), ext, 'ZOOM Previous');
  await settle();

  step = 'restore from the View menu';
  await page.locator('#menubar .menu > button', { hasText: 'View' }).click();
  await page.locator('#menubar .menu.open .drop button:not([hidden])', { hasText: 'Plant room' }).click();
  near(await state(), plant, 'restored from the View menu');

  step = 'plot to PDF with the named view';
  await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
  await page.locator('#menubar .drop button', { hasText: 'Plot to PDF…' }).click();
  await page.waitForSelector('#dlg[open] select[name=what]');
  await page.locator('#dlg select[name=what]').selectOption('named');
  await page.locator('#dlg select[name=namedView]').selectOption('Plant room');
  const dl = page.waitForEvent('download');
  await page.locator('#dlg button.primary').click();
  const pdf = path.join(os.tmpdir(), `ash-namedview-${process.pid}.pdf`);
  await (await dl).saveAs(pdf);
  assert.equal((await fs.readFile(pdf)).subarray(0, 4).toString(), '%PDF');
  await fs.rm(pdf, { force: true });

  step = 'rename, then delete';
  await cmd('VIEW'); await page.waitForSelector('#dlg[open] #view-list');
  await page.locator('#view-list').selectOption('Plant room');
  await btn('Rename…').click(); await page.waitForSelector('#dlg[open] input[type=text]');
  await page.locator('#dlg input[type=text]').fill('Boiler room');
  await btn('OK').click(); await page.waitForSelector('#dlg[open] #view-list option[value="Boiler room"]');
  assert.deepEqual(await page.evaluate(() => [...window.app.doc.views.keys()]), ['BOILER ROOM']);
  await page.locator('#view-list').selectOption('Boiler room');
  await btn('Delete').click(); await page.waitForSelector('#dlg[open] #view-list');
  assert.equal(await page.locator('#view-list option').count(), 0);
  await btn('Close').click(); await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.equal(await page.evaluate(() => window.app.doc.views.size), 0);

  assert.deepEqual(problems, []);
  console.log('namedview e2e: OK');
} catch (err) {
  console.error(`namedview e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
