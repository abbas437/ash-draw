#!/usr/bin/env node
// Browser end-to-end test: layout management (LAYOUT New, tab menu Rename / Copy / Delete with confirmation, undo); harness as vpundo.mjs.
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

  step = 'LAYOUT New';
  await typeCmd('lo'); await btn('New'); await nameAs('Sheet X');
  assert.equal(await tabs(), `${t0},Sheet X`);
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Sheet X');

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
