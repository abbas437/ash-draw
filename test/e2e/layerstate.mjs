#!/usr/bin/env node
// Browser end-to-end test of the Layer States Manager (LAYERSTATE / LAS / LMAN): save, restore (+undo, restore options),
// export / import .las, rename; same harness as layers.mjs (browser fallback of window.api, shim.js).
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
  const lay = (n) => page.evaluate((n) => { const l = window.app.doc.layers.get(n); return { frozen: !!l.frozen, color: l.color }; }, n);
  const dlgRows = () => page.evaluate(() => [...document.querySelectorAll('#dlg .ls-row')].map((r) => [r.dataset.name, r.querySelector('.ls-match').textContent]));
  const open = async (cmd) => { await typeCmd(cmd); await page.waitForSelector('#dlg[open] .ls-list'); };
  const closed = () => page.waitForFunction(() => !document.getElementById('dlg').open, null, { timeout: 5000 });

  step = 'build: layers WALL, DOOR, TEXT with one circle each';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    for (const n of ['WALL', 'DOOR', 'TEXT']) M.addLayer(doc, { name: n, color: 7 });
    ['WALL', 'DOOR', 'TEXT'].forEach((l, i) => M.addEntity(doc, M.makeCircle({ x: i * 10, y: 0 }, 2, { layer: l })));
    window.app.installDoc(doc, { path: null, name: 'laystate.dxf', format: 'dxf' });
    window.app.setSidePanel?.(true);
  });
  await page.waitForSelector('#layers .layer[data-layer="DOOR"]');

  step = 'LAYERSTATE: empty list; New… then Cancel returns to the manager; Esc closes it';
  await open('LAYERSTATE');
  assert.deepEqual(await dlgRows(), []);
  await page.locator('#ls-new').click();
  await page.waitForSelector('#dlg #ls-name');
  await page.locator('#dlg .dlg-btns button', { hasText: 'Cancel' }).click();
  await page.waitForSelector('#dlg[open] .ls-list');
  await page.keyboard.press('Escape');
  await closed();

  step = 'States… button: New… saves "A" (one undo step) and it matches the current layers';
  await page.locator('#layer-states').click();
  await page.waitForSelector('#dlg[open] .ls-list');
  await page.locator('#ls-new').click();
  await page.locator('#dlg #ls-name').fill('A');
  await page.locator('#dlg #ls-desc').fill('Base set-up');
  await page.locator('#dlg button.primary').click();
  await page.waitForSelector('#dlg[open] .ls-row[data-name="A"]');
  assert.deepEqual(await dlgRows(), [['A', '✓']]);
  assert.equal(await page.locator('#dlg .ls-row .ls-desc').textContent(), 'Base set-up');
  await page.locator('#dlg .dlg-btns button', { hasText: 'Close' }).click();
  await closed();
  assert.equal(await page.evaluate(() => window.app.session.undoLabel), 'Save layer state A');

  step = 'freeze DOOR (panel), WALL colour 1; the state no longer matches';
  await page.locator('#layers .layer[data-layer="DOOR"] .lay-frz').click();
  await page.evaluate(async () => (await import('/src/core/edit.js')).setLayerProps(window.app.session, 'WALL', { color: 1 }));
  assert.deepEqual(await lay('DOOR'), { frozen: true, color: 7 });
  assert.deepEqual(await lay('WALL'), { frozen: false, color: 1 });
  await open('LAS');
  assert.deepEqual(await dlgRows(), [['A', '']]);

  step = 'Restore "A": DOOR thawed, WALL colour 7, panel refreshed, dialog closed';
  await page.locator('#dlg button.primary', { hasText: 'Restore' }).click();
  await closed();
  assert.deepEqual(await lay('DOOR'), { frozen: false, color: 7 });
  assert.deepEqual(await lay('WALL'), { frozen: false, color: 7 });
  assert.equal(await page.locator('#layers .layer[data-layer="DOOR"] .lay-frz').getAttribute('data-state'), 'thawed');

  step = 'one undo takes the restore back';
  await typeCmd('u');
  assert.deepEqual(await lay('DOOR'), { frozen: true, color: 7 });
  assert.deepEqual(await lay('WALL'), { frozen: false, color: 1 });
  assert.equal(await page.locator('#layers .layer[data-layer="DOOR"] .lay-frz').getAttribute('data-state'), 'frozen');

  step = 'restore options: colour unchecked -> only the freeze comes back; the choice is saved as layerstates.restoreMask';
  await open('LMAN');
  await page.locator('#dlg input[data-prop="color"]').uncheck();
  await page.locator('#dlg button.primary', { hasText: 'Restore' }).click();
  await closed();
  assert.deepEqual(await lay('DOOR'), { frozen: false, color: 7 });
  assert.deepEqual(await lay('WALL'), { frozen: false, color: 1 });
  assert.equal(await page.evaluate(() => window.api.settingsGet('layerstates.restoreMask')), 2047 - 32);
  await open('LAS');
  assert.equal(await page.locator('#dlg input[data-prop="color"]').isChecked(), false, 'remembered');
  await page.locator('#dlg input[data-prop="color"]').check();

  step = 'Export .las…: a download named A.las holding the state';
  const dl = page.waitForEvent('download');
  await page.locator('#ls-export').click();
  const download = await dl;
  assert.equal(download.suggestedFilename(), 'A.las');
  const las = await fs.readFile(await download.path());
  const text = las.toString('utf8');
  assert.match(text, /LAYERSTATEDICTIONARY/);
  assert.match(text, /\r\n {2}1\r\nA\r\n/);

  step = 'Rename… A -> B, then Import .las… brings A back beside it';
  await page.locator('#ls-rename').click();
  await page.locator('#dlg input[type="text"]').fill('B');
  await page.locator('#dlg button.primary').click();
  await page.waitForSelector('#dlg[open] .ls-row[data-name="B"]');
  const fc = page.waitForEvent('filechooser');
  await page.locator('#ls-import').click();
  await (await fc).setFiles({ name: 'A.las', mimeType: 'application/octet-stream', buffer: las });
  await page.waitForSelector('#dlg[open] .ls-row[data-name="A"]');
  assert.deepEqual((await dlgRows()).map((r) => r[0]), ['A', 'B']);
  await page.keyboard.press('Escape');
  await closed();

  assert.deepEqual(problems, []);
  console.log('layerstate e2e: OK');
} catch (err) {
  console.error(`layerstate e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
