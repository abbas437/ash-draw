#!/usr/bin/env node
// Browser end-to-end test of the Layers panel: filter, inline rename (+undo, invalid name), plot flag, LAYMCUR; same harness as run.mjs.
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
  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#layers .layer')].map((r) => r.dataset.layer));
  const row = (n) => page.locator(`#layers .layer[data-layer="${n}"]`);

  step = 'build: layers WALL, DOOR, WALL_HATCH, TEXT with one circle each';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    for (const n of ['WALL', 'DOOR', 'WALL_HATCH', 'TEXT']) M.addLayer(doc, { name: n });
    ['WALL', 'DOOR', 'WALL_HATCH', 'TEXT'].forEach((l, i) => M.addEntity(doc, M.makeCircle({ x: i * 10, y: 0 }, 2, { layer: l })));
    window.app.installDoc(doc, { path: null, name: 'layers.dxf', format: 'dxf' });
    window.app.setSidePanel?.(true);
  });
  await page.waitForSelector('#layers .layer[data-layer="WALL"]');
  assert.ok((await rows()).length >= 4);

  step = 'filter: only matching rows, then clear';
  await page.locator('#layer-filter').fill('wall');
  assert.deepEqual((await rows()).sort(), ['WALL', 'WALL_HATCH']);
  await page.locator('#layer-filter-clear').click();
  await page.waitForFunction(() => document.querySelectorAll('#layers .layer').length >= 5, null, { timeout: 5000 });
  assert.ok((await rows()).includes('DOOR'));
  assert.equal(await page.locator('#layer-filter').inputValue(), '');

  step = 'rename by double-click + Enter';
  await row('DOOR').locator('.lname').dblclick();
  await page.locator('input.lname-edit').fill('PORTE');
  await page.locator('input.lname-edit').press('Enter');
  await page.waitForSelector('#layers .layer[data-layer="PORTE"]');
  assert.equal(await row('PORTE').locator('.lname').textContent(), 'PORTE');
  assert.equal(await row('DOOR').count(), 0);
  assert.equal(await page.evaluate(() => window.app.doc.entities.some((e) => e.layer === 'PORTE') && !window.app.doc.entities.some((e) => e.layer === 'DOOR')), true);

  step = 'Ctrl+Z restores the old name';
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+z');
  await page.waitForSelector('#layers .layer[data-layer="DOOR"]');
  assert.equal(await row('PORTE').count(), 0);
  assert.equal(await page.evaluate(() => window.app.doc.entities.some((e) => e.layer === 'DOOR')), true);

  step = 'F2 on a focused row opens the inline editor (global F2 must not steal focus)';
  await row('DOOR').locator('.lname').click();
  await page.keyboard.press('F2');
  await page.waitForSelector('input.lname-edit', { timeout: 5000 });
  await page.locator('input.lname-edit').fill('PORTE');
  await page.locator('input.lname-edit').press('Enter');
  await page.waitForSelector('#layers .layer[data-layer="PORTE"]');
  assert.equal(await page.evaluate(() => window.app.doc.entities.some((e) => e.layer === 'PORTE') && !window.app.doc.entities.some((e) => e.layer === 'DOOR')), true);

  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+z');
  await page.waitForSelector('#layers .layer[data-layer="DOOR"]');

  step = 'invalid name: toast, editor stays open';
  await row('DOOR').locator('.lname').dblclick();
  await page.locator('input.lname-edit').fill('a/b');
  await page.locator('input.lname-edit').press('Enter');
  await page.waitForFunction(() => document.getElementById('toast')?.classList.contains('show') && document.getElementById('toast').textContent.length > 0, null, { timeout: 5000 });
  assert.equal(await page.locator('input.lname-edit').count(), 1);
  assert.equal(await page.evaluate(() => window.app.doc.layers.has('DOOR') && !window.app.doc.layers.has('a/b')), true);
  await page.locator('input.lname-edit').press('Escape');
  await page.waitForFunction(() => !document.querySelector('input.lname-edit'), null, { timeout: 5000 });

  step = 'plot toggle sets plot === false';
  await row('TEXT').locator('.lay-plot').click();
  await page.waitForFunction(() => window.app.doc.layers.get('TEXT')?.plot === false, null, { timeout: 5000 });

  step = 'LAYMCUR sets the current layer from the selection';
  const id = await page.evaluate(() => window.app.doc.entities.find((e) => e.layer === 'WALL_HATCH').id);
  await page.evaluate((i) => window.app.vp.setSelection([i]), id);
  await typeCmd('LAYMCUR');
  await page.waitForFunction(() => window.app.state.layer === 'WALL_HATCH', null, { timeout: 5000 });
  assert.match(await page.locator('#toast').textContent(), /Current layer: WALL_HATCH/);

  step = 'width: a 20-character layer name shows in full at the default panel width; the rename input is at least 160 px';
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(async () => { const M = await import('/src/core/model.js'); M.addLayer(window.app.doc, { name: 'M-HVAC-DUCT-SUPPLY1' }); window.app.refreshPanels(); });
  const longRow = row('M-HVAC-DUCT-SUPPLY1');
  await longRow.waitFor();
  const m = await longRow.locator('.lname').evaluate((n) => ({ client: n.clientWidth, scroll: n.scrollWidth, title: n.title }));
  assert.ok(m.client >= m.scroll, `name truncated: clientWidth ${m.client} < scrollWidth ${m.scroll}`);
  assert.ok(m.title.startsWith('M-HVAC-DUCT-SUPPLY1'), 'full name in the tooltip');
  assert.equal(await longRow.locator('.lay-tr').count(), 0, 'no stray number column in the row');
  await longRow.locator('.lname').dblclick();
  const rw = await longRow.locator('input.lname-edit').evaluate((i) => i.getBoundingClientRect().width);
  assert.ok(rw >= 160, `rename input ${rw}px < 160`);
  await longRow.locator('input.lname-edit').press('Escape');

  assert.deepEqual(problems, []);
  console.log('layers e2e: OK');
} catch (err) {
  console.error(`layers e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
