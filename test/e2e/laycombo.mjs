#!/usr/bin/env node
// Browser end-to-end test of the Quick Access layer combo: filter + make current, toggles in sync with the Layers panel,
// moving the selection (one undo step), 2,000 layers, fit at 1366 px; same harness as layers.mjs.
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
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  const ready = () => page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
  await ready();
  const head = page.locator('#layer-combo .lc-head');
  const list = page.locator('#layer-combo-list');
  const crow = (n) => page.locator(`#layer-combo-list .lc-row[data-layer="${n}"]`);
  const crows = () => page.evaluate(() => [...document.querySelectorAll('#layer-combo-list .lc-row')].map((r) => r.dataset.layer));
  const headName = () => head.locator('.lc-name').textContent();
  const openCombo = async () => { await head.click(); await list.waitFor({ state: 'visible' }); };

  step = 'build: layers A-WALL, B-DOOR, C-TEXT with one circle each';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    for (const n of ['A-WALL', 'B-DOOR', 'C-TEXT']) M.addLayer(doc, { name: n });
    ['A-WALL', 'B-DOOR', 'C-TEXT'].forEach((l, i) => M.addEntity(doc, M.makeCircle({ x: i * 10, y: 0 }, 2, { layer: l })));
    window.app.installDoc(doc, { path: null, name: 'laycombo.dxf', format: 'dxf' });
    window.app.setSidePanel?.(true);
  });
  await page.waitForSelector('#layers .layer[data-layer="A-WALL"]');
  assert.equal(await headName(), '0');
  assert.equal(await page.evaluate(() => document.querySelector('#layer-combo').previousElementSibling?.dataset.cmd), 'layers', 'combo sits right after the Layers button');

  step = 'open, filter, click a name: it becomes current; the list closes; the side panel follows';
  await openCombo();
  assert.deepEqual(await crows(), ['0', 'A-WALL', 'B-DOOR', 'C-TEXT'], 'same order as the Layers panel');
  await page.locator('#layer-combo-list .lc-filter').fill('do');
  assert.deepEqual(await crows(), ['B-DOOR']);
  await crow('B-DOOR').locator('.lc-name').click();
  await page.waitForFunction(() => window.app.state.layer === 'B-DOOR', null, { timeout: 5000 });
  assert.equal(await list.isHidden(), true);
  assert.equal(await headName(), 'B-DOOR');
  assert.equal(await page.locator('#layers .layer.current').getAttribute('data-layer'), 'B-DOOR');

  step = 'keyboard: arrows move, Enter picks, Esc closes';
  await openCombo();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.app.state.layer === 'C-TEXT', null, { timeout: 5000 });
  await openCombo();
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('lc-head')), true, 'Esc returns the focus to the combo');

  step = 'freeze A-WALL from the combo: list stays open, side panel and combo show it';
  await openCombo();
  await crow('A-WALL').locator('.lc-frz').click();
  await page.waitForFunction(() => window.app.doc.layers.get('A-WALL')?.frozen === true, null, { timeout: 5000 });
  assert.equal(await list.isVisible(), true, 'a toggle leaves the list open');
  assert.equal(await crow('A-WALL').locator('.lc-frz').getAttribute('data-state'), 'frozen');
  assert.equal(await crow('A-WALL').locator('.lc-frz').getAttribute('title'), 'Thaw layer');
  assert.equal(await page.locator('#layers .layer[data-layer="A-WALL"] .lay-frz').getAttribute('data-state'), 'frozen');
  step = 'thaw from the side panel (a programmatic click, so the list stays open): the open combo follows';
  await page.evaluate(() => document.querySelector('#layers .layer[data-layer="A-WALL"] .lay-frz').click());
  await page.waitForFunction(() => document.querySelector('#layer-combo-list .lc-row[data-layer="A-WALL"] .lc-frz')?.dataset.state === 'thawed', null, { timeout: 5000 });
  step = 'freeze A-WALL again from the combo, then Esc';
  await crow('A-WALL').locator('.lc-frz').click();
  await page.waitForFunction(() => window.app.doc.layers.get('A-WALL')?.frozen === true, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'hidden' });

  step = 'selection: common layer, (varies), then move it to B-DOOR as one undo step';
  const ids = await page.evaluate(() => Object.fromEntries(window.app.doc.entities.map((e) => [e.layer, e.id])));
  await page.evaluate((i) => window.app.vp.setSelection([i['C-TEXT'], i['B-DOOR']]), ids);
  await page.waitForFunction(() => document.querySelector('#layer-combo .lc-name').textContent === '(varies)', null, { timeout: 5000 });
  await page.evaluate((i) => window.app.vp.setSelection([i['C-TEXT']]), ids);
  await page.waitForFunction(() => document.querySelector('#layer-combo .lc-name').textContent === 'C-TEXT', null, { timeout: 5000 });
  await openCombo();
  await page.locator('#layer-combo-list .lc-filter').fill('b-d');
  await crow('B-DOOR').locator('.lc-name').click();
  await page.waitForFunction((i) => window.app.doc.entities.find((e) => e.id === i)?.layer === 'B-DOOR', ids['C-TEXT'], { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.app.state.layer), 'C-TEXT', 'moving objects leaves the current layer alone');
  assert.equal(await headName(), 'B-DOOR');
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+z');
  await page.waitForFunction((i) => window.app.doc.entities.find((e) => e.id === i)?.layer === 'C-TEXT', ids['C-TEXT'], { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.app.doc.layers.get('A-WALL')?.frozen), true, 'one undo step: the earlier freeze stays');
  await page.evaluate(() => window.app.vp.setSelection([]));

  step = 'the Layers button still shows / hides the side panel';
  const shownBefore = await page.evaluate(() => window.app.sideShown);
  await page.locator('#qat button[data-cmd="layers"]').click();
  assert.equal(await page.evaluate(() => window.app.sideShown), !shownBefore);
  await page.locator('#qat button[data-cmd="layers"]').click();
  assert.equal(await page.evaluate(() => window.app.sideShown), shownBefore);

  step = 'fit at 1366 px: no overflow in the Quick Access row; long name ellipsised with the full name in the tooltip';
  await page.evaluate(async () => { const M = await import('/src/core/model.js'); M.addLayer(window.app.doc, { name: 'M-HVAC-DUCT-SUPPLY-AIR-LEVEL-02-EXTRA-LONG' }); window.app.state.layer = 'M-HVAC-DUCT-SUPPLY-AIR-LEVEL-02-EXTRA-LONG'; window.app.refreshPanels(); });
  const fit = await page.evaluate(() => { const q = document.getElementById('qat'), c = document.getElementById('layer-combo').getBoundingClientRect(), r = q.getBoundingClientRect(); return { sw: q.scrollWidth, cw: q.clientWidth, right: c.right, qr: r.right, top: c.top, qt: r.top, bottom: c.bottom, qb: r.bottom }; });
  assert.ok(fit.sw <= fit.cw, `Quick Access row overflows: ${fit.sw} > ${fit.cw}`);
  assert.ok(fit.right <= fit.qr && fit.top >= fit.qt && fit.bottom <= fit.qb, `combo outside the row: ${JSON.stringify(fit)}`);
  const nm = await head.locator('.lc-name').evaluate((n) => ({ client: n.clientWidth, scroll: n.scrollWidth, css: getComputedStyle(n).textOverflow }));
  assert.ok(nm.scroll > nm.client && nm.css === 'ellipsis', `long name not ellipsised: ${JSON.stringify(nm)}`);
  assert.match(await head.getAttribute('title'), /M-HVAC-DUCT-SUPPLY-AIR-LEVEL-02-EXTRA-LONG/);

  step = 'screenshot of the toolbar with the drop-down open';
  await openCombo();
  await fs.mkdir(path.join(ROOT, '.scratch'), { recursive: true });
  const lb = await list.boundingBox();
  await page.screenshot({ path: path.join(ROOT, '.scratch', 'laycombo-toolbar.png'), clip: { x: 0, y: 0, width: 1366, height: Math.ceil(lb.y + lb.height + 8) } });
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'hidden' });

  step = '2,000 layers: opens in under 300 ms with fewer than 200 rows built; scrolling and End-of-list rows work';
  await page.evaluate(async () => { const M = await import('/src/core/model.js'); for (let i = 0; i < 2000; i++) M.addLayer(window.app.doc, { name: `L-${i}` }); window.app.state.layer = '0'; window.app.refreshPanels(); });
  const t = await page.evaluate(() => { const t0 = performance.now(); document.querySelector('#layer-combo .lc-head').click(); const l = document.getElementById('layer-combo-list'); void l.offsetHeight; return { ms: performance.now() - t0, rows: l.querySelectorAll('.lc-row').length, dom: l.querySelectorAll('*').length }; });
  assert.ok(t.ms < 300, `open took ${t.ms.toFixed(1)} ms`);
  assert.ok(t.rows > 0 && t.rows < 200, `${t.rows} rows built`);
  console.log(`  2,000 layers: opened in ${t.ms.toFixed(1)} ms, ${t.rows} rows, ${t.dom} list nodes`);
  await page.locator('#layer-combo-list .lc-scroll').evaluate((s) => { s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); });
  await crow('L-1999').waitFor();
  assert.ok((await crows()).length < 200);
  await page.locator('#layer-combo-list .lc-filter').fill('L-1234');
  assert.deepEqual(await crows(), ['L-1234']);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.app.state.layer === 'L-1234', null, { timeout: 5000 });

  assert.deepEqual(problems, []);
  console.log('laycombo e2e: OK');
} catch (err) {
  console.error(`laycombo e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
