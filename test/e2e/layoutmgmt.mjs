#!/usr/bin/env node
// Browser end-to-end test: layout management (LAYOUT New, tab menu Rename / Copy / Delete with confirmation, undo); harness as vpundo.mjs.
// Uses the browser fallback of window.api (shim.js); Electron-only features (DWG) are covered elsewhere.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

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

  const btn = (text) => page.locator('dialog[open] .dlg-btns button', { hasText: text }).first().click();
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('#spacebar button')].map((b) => b.dataset.space).join(','));
  const menu = async (tab, act) => { await page.click(`#spacebar button[data-space="${tab}"]`, { button: 'right' }); await page.click(`.popmenu button[data-act="${act}"]`); };
  const nameAs = async (n) => { await page.locator('dialog[open] input[name="layoutName"]').fill(n); await btn('OK'); };

  step = 'open layouts_r2000.dxf';
  await page.evaluate(async () => {
    const { readDxf } = await import('/src/core/dxfRead.js');
    const bytes = new Uint8Array(await (await fetch('/test/fixtures/layouts_r2000.dxf')).arrayBuffer());
    window.app.installDoc(readDxf(bytes), { path: null, name: 'layouts.dxf', format: 'dxf' });
  });
  const t0 = await tabs(), n0 = t0.split(',').length;

  step = 'viewport scale list on a selected paper viewport: 1:50, one undo step';
  const lay1 = t0.split(',')[1];
  await page.click(`#spacebar button[data-space="${lay1}"]`);
  assert.equal(await page.locator('#vpscale').isHidden(), true, 'no list without a selected viewport');
  const vpInfo = () => page.evaluate(() => {
    const v = window.app.vp.mspace?.vp ?? window.app.vp.doc.entities.find((e) => e.type === 'VIEWPORT' && e.vpId !== 1 && e.height > 0);
    return { id: v.id, height: v.height, viewHeight: v.viewHeight, cx: v.viewCenter.x, cy: v.viewCenter.y, locked: !!v.locked, units: window.app.active.doc.units };
  });
  const v0 = await vpInfo();
  await page.evaluate((id) => window.app.vp.setSelection([id]), v0.id);
  assert.equal(await page.locator('#vpscale').isVisible(), true, 'the list shows for one selected paper viewport');
  const u0 = await page.evaluate(() => window.app.active.session.undoStack.length);
  await page.locator('#vpscale').selectOption('100');
  const mmPer = { 0: 1, 4: 1, 6: 1000 }[v0.units];
  let v1 = await vpInfo();
  assert.ok(Math.abs(v1.viewHeight - (v1.height * 100) / mmPer) < 1e-9 * v1.viewHeight, `1:100 viewHeight ${v1.viewHeight}`);
  assert.equal(await page.locator('#vpscale').inputValue(), '100');
  assert.equal(await page.evaluate(() => window.app.active.session.undoStack.length), u0 + 1, 'one undo step');
  assert.deepEqual([v1.cx, v1.cy], [v0.cx, v0.cy], 'the view centre is kept');
  await page.locator('#vpscale').selectOption('50');
  v1 = await vpInfo();
  assert.ok(Math.abs(v1.viewHeight - (v1.height * 50) / mmPer) < 1e-9 * v1.viewHeight, `1:50 viewHeight ${v1.viewHeight}`);
  assert.equal(await page.locator('label input[data-prop="Scale"]').inputValue(), '1:50', 'Properties shows the same scale');
  await typeCmd('u');
  assert.equal((await vpInfo()).viewHeight, (v0.height * 100) / mmPer, 'one undo restores the previous scale');
  await typeCmd('u');
  assert.equal((await vpInfo()).viewHeight, v0.viewHeight, 'and the next one the original');
  await page.evaluate((id) => window.app.vp.setSelection([id]), v0.id);
  assert.equal(await page.locator('#vpscale').inputValue(), String(+((v0.viewHeight / v0.height) * mmPer).toPrecision(6)));

  step = 'a locked viewport refuses a scale from the list';
  await typeCmd('vplock');
  assert.equal((await vpInfo()).locked, true);
  await page.evaluate((id) => window.app.vp.setSelection([id]), v0.id);
  const u1 = await page.evaluate(() => window.app.active.session.undoStack.length);
  await page.locator('#vpscale').selectOption('250');
  assert.equal((await vpInfo()).viewHeight, v0.viewHeight, 'unchanged');
  assert.equal(await page.evaluate(() => window.app.active.session.undoStack.length), u1);
  await page.waitForFunction(() => /locked/i.test(document.body.innerText), null, { timeout: 3000 });
  await typeCmd('u');
  assert.equal((await vpInfo()).locked, false);

  step = 'scale list in MSPACE: one undo step, the model view follows';
  await page.evaluate((id) => window.app.vp.setSelection([]), v0.id);
  await typeCmd('ms');
  assert.equal(await page.evaluate(() => !!window.app.vp.mspace), true);
  const u2 = await page.evaluate(() => window.app.active.session.undoStack.length);
  await page.locator('#vpscale').selectOption('20');
  assert.ok(Math.abs((await vpInfo()).viewHeight - (v0.height * 20) / mmPer) < 1e-9 * v0.height * 20);
  await typeCmd('ps');
  assert.equal(await page.evaluate(() => window.app.active.session.undoStack.length), u2 + 1, 'leaving MSPACE records no second step');
  await typeCmd('u');
  assert.equal((await vpInfo()).viewHeight, v0.viewHeight);
  await page.click('#spacebar button[data-space="Model"]');

  step = 'layout Plot dialog follows PAGESETUP (Extents, fit); the plot is the chosen paper';
  await page.click(`#spacebar button[data-space="${lay1}"]`);
  await typeCmd('pagesetup');
  await page.locator('dialog[open] select[name=area]').selectOption('1');
  await page.locator('dialog[open] input[name=fit]').check();
  await btn('OK');
  assert.deepEqual(await page.evaluate(() => [window.app.vp.layout.plot.plotType, window.app.vp.layout.plot.stdScale]), [1, 0]);
  await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
  await page.locator('#menubar .drop button', { hasText: 'Plot to PDF…' }).click();
  assert.equal(await page.locator('#dlg select[name=area]').inputValue(), 'extents', 'area from the page setup');
  assert.equal(await page.locator('#dlg input[name=fit]').isChecked(), true, 'fit from the page setup');
  assert.equal(await page.locator('#dlg input[name=fit]').isDisabled(), false, 'fit applies to an extents plot on its own paper');
  assert.equal(await page.locator('#dlg select[name=paper]').inputValue(), 'layout');
  assert.match(await page.locator('#dlg .plot-scale').innerText(), /^Fit: .*extents on the layout's own paper/);
  await page.locator('#dlg select[name=paper]').selectOption('A4');
  const dl = page.waitForEvent('download');
  await page.locator('#dlg button.primary').click();
  const pdfOut = path.join(os.tmpdir(), `ash-e2e-layoutplot-${process.pid}.pdf`);
  await (await dl).saveAs(pdfOut);
  const size = (await PDFDocument.load(await fs.readFile(pdfOut))).getPage(0).getSize();
  await fs.rm(pdfOut, { force: true });
  assert.deepEqual([Math.round(size.width), Math.round(size.height)].sort(), [595, 842].sort(), `A4 page ${size.width} x ${size.height}`);
  await typeCmd('u');
  assert.equal(await page.evaluate(() => window.app.vp.layout.plot.plotType), 5, 'undo restores the page setup');
  await page.click('#spacebar button[data-space="Model"]');

  step = 'LAYOUT New';
  await typeCmd('lo'); await btn('New'); await nameAs('Sheet X');
  assert.equal(await tabs(), `${t0},Sheet X`);
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Sheet X');
  assert.equal(await page.evaluate(() => window.app.vp.layout.plot.stdScale), undefined, 'a new layout has no page-setup scale');
  await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
  await page.locator('#menubar .drop button', { hasText: 'Plot to PDF…' }).click();
  assert.equal(await page.locator('#dlg select[name=paper]').inputValue(), 'A4', 'no page setup: the paper last plotted a layout on');
  assert.equal(await page.locator('#dlg input[name=fit]').isChecked(), true, 'and its fit');
  await btn('Cancel');

  step = 'tab menu Rename';
  await menu('Sheet X', 'rename'); await nameAs('Sheet Y');
  assert.equal(await tabs(), `${t0},Sheet Y`);
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Sheet Y', 'the shown layout follows its new name');

  step = 'Model tab cannot be renamed or deleted';
  await page.click('#spacebar button[data-space="Model"]', { button: 'right' });
  assert.equal(await page.locator('.popmenu button[data-act="rename"]').isDisabled(), true);
  assert.equal(await page.locator('.popmenu button[data-act="delete"]').isDisabled(), true);
  await page.keyboard.press('Escape'); await page.mouse.click(5, 5);

  step = 'tab menu Copy';
  await menu('Sheet Y', 'copy'); await nameAs('Sheet Z');
  assert.equal(await tabs(), `${t0},Sheet Y,Sheet Z`);

  step = 'tab menu Delete with confirmation, then undo';
  const steps = await page.evaluate(() => window.app.active.session.undoStack.length);
  await menu('Sheet Y', 'delete'); await btn('Cancel');
  assert.equal(await tabs(), `${t0},Sheet Y,Sheet Z`, 'Cancel keeps the layout');
  await menu('Sheet Y', 'delete'); await btn('Delete');
  assert.equal(await tabs(), `${t0},Sheet Z`);
  assert.equal(await page.evaluate(() => window.app.vp.layout), null, 'a deleted shown layout goes back to Model');
  assert.equal(await page.evaluate(() => window.app.active.session.undoStack.length), steps + 1, 'one undo step');
  await typeCmd('u');
  assert.equal(await tabs(), `${t0},Sheet Y,Sheet Z`, 'undo restores the layout');
  assert.equal(await page.evaluate(() => window.app.active.doc.layouts.length), n0 + 1);

  assert.deepEqual(problems, []);
  console.log('layoutmgmt e2e: OK');
} catch (err) {
  console.error(`layoutmgmt e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
