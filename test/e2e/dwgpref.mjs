#!/usr/bin/env node
// Browser end-to-end test of the experimental-DWG-save preference gate (File menu item, command path) and the DWG-origin Save confirm; same harness as run.mjs.
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
  const dlgOpen = () => page.evaluate(() => !!document.querySelector('#dlg')?.open);
  const btn = (label) => page.locator('#dlg .dlg-btns button', { hasText: new RegExp(`^${label}$`) });
  const sel = () => page.evaluate(() => [...window.app.vp.selection].sort());
  const named = () => page.evaluate(() => ({ blocks: [...window.app.doc.blocks.keys()], layers: [...window.app.doc.layers.keys()] }));

  const dwgItem = () => page.locator('#menubar .drop button', { hasText: 'Save as DWG' });
  const openFile = async () => { await page.locator('#menubar .menu > button', { hasText: /^File$/ }).click(); };
  const dlgText = () => page.evaluate(() => document.querySelector('#dlg')?.innerText ?? '');

  step = 'default: the Save as DWG item is hidden';
  await openFile();
  assert.equal(await dwgItem().isVisible(), false);
  assert.equal(await page.locator('#menubar .drop button', { hasText: 'Save as DXF' }).isVisible(), true);
  await page.keyboard.press('Escape'); await page.mouse.click(700, 500);

  step = 'default: the command path explains and does not save';
  const p1 = page.evaluate(() => window.app.saveAs('dwg'));
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  const t1 = await dlgText();
  assert.match(t1, /experimental/); assert.match(t1, /Preferences/); assert.match(t1, /DXF/);
  await btn('OK').click();
  assert.equal(await p1, false);

  step = 'Preferences has the checkbox, and ticking it enables the item';
  await page.evaluate(() => { window.app.preferences(); });
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  assert.equal(await page.locator('#pref-dwg-save').isChecked(), false);
  await page.locator('#pref-dwg-save').check();
  await btn('Save').click();
  await page.waitForFunction(() => !document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  await openFile();
  assert.equal(await dwgItem().isVisible(), true);
  await page.mouse.click(700, 500);

  step = 'the preference persists across a reload (settingsSet in localStorage)';
  assert.equal(await page.evaluate(() => localStorage.getItem('ash-draw:dwg.allowSave')), 'true');
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => window.app.allowDwgSave === true, null, { timeout: 5000 });
  await openFile();
  assert.equal(await dwgItem().isVisible(), true);
  await page.mouse.click(700, 500);
  await page.evaluate(() => localStorage.removeItem('ash-draw:dwg.allowSave'));
  await page.reload({ waitUntil: 'load' }); await ready();
  await openFile();
  assert.equal(await dwgItem().isVisible(), false);
  await page.mouse.click(700, 500);

  step = 'Save on a DWG-origin drawing asks once; Cancel does not save';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    window.app.installDoc(M.newDocument(), { path: null, name: 'Plan A.dwg', format: 'dwg' });
  });
  const p2 = page.evaluate(() => window.app.save());
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  assert.match(await dlgText(), /opened from DWG\. It will be saved as DXF \(Plan A\.dxf\) next to the original; the DWG is not changed\./);
  await btn('Cancel').click();
  assert.equal(await p2, false);
  assert.equal(await page.evaluate(() => window.app.file.format), 'dwg');

  step = 'a slow DWG save applies to the tab it started on; a second Save on that tab is refused while it runs';
  // the browser api is frozen: from here on leave it open, so the desktop DWG calls can be stubbed
  await page.addInitScript(() => { const f = Object.freeze; Object.freeze = (o) => (o && 'saveFile' in o && 'isElectron' in o ? o : f(o)); });
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const api = window.api;
    window.__writes = []; window.__sent = null;
    window.__conv = new Promise((r) => { window.__release = r; });
    Object.assign(api, {
      isElectron: true,
      dwgAvailable: async () => ({ available: true, write: { oda: true } }),
      dxfToDwg: async (dxf) => { window.__sent = dxf; await window.__conv; return { dwgBytes: new Uint8Array([65, 67]) }; },
      dwgToDxf: async () => ({ dxfBytes: window.__sent, converter: 'ODA' }),
      writeFile: async (p) => { window.__writes.push(p); return { path: p, backup: null }; },
    });
    window.app.installDoc(M.newDocument(), { path: '/j/A.dwg', name: 'A.dwg', format: 'dwg' });
    window.__tabA = window.app.active;
    window.__pA = window.app.save();
  });
  await page.waitForFunction(() => window.__sent !== null, null, { timeout: 5000 });
  const again = await page.evaluate(() => Promise.race([window.app.save(), new Promise((r) => setTimeout(() => r('a second save started'), 3000))]));
  assert.equal(again, false, 'second Save on the same tab while saving');
  assert.equal(await page.evaluate(() => document.getElementById('toast').textContent), 'Still saving…');
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    window.app.installDoc(M.newDocument(), { path: null, name: 'B.dxf', format: 'dxf' }); // the user switches to another tab
    window.__tabB = window.app.active;
    window.__release();
  });
  assert.equal(await page.evaluate(() => window.__pA), true);
  const after = await page.evaluate(() => ({ a: window.__tabA.file, aVer: window.__tabA.dwgVersion, aDirty: window.__tabA.session.dirty, aSaving: window.__tabA.saving,
    b: window.__tabB.file, active: window.app.active === window.__tabB, writes: window.__writes }));
  assert.deepEqual(after.a, { path: '/j/A.dwg', name: 'A.dwg', format: 'dwg' });
  assert.equal(after.aVer, 'acad2018'); assert.equal(after.aDirty, false); assert.equal(after.aSaving, null);
  assert.deepEqual(after.b, { path: null, name: 'B.dxf', format: 'dxf' }, 'the tab shown when the save finished is not touched');
  assert.equal(after.active, true);
  assert.deepEqual(after.writes, ['/j/A.dwg']);

  step = 'the Save as DWG item: "(experimental)" only when ODA cannot write';
  await openFile();
  assert.equal((await dwgItem().innerText()).trim(), 'Save as DWG…');
  await page.mouse.click(700, 500);
  await page.evaluate(() => { window.api.dwgAvailable = async () => ({ available: true, write: { oda: false } }); window.app.allowDwgSave = true; return window.app.refreshDwgWrite(); });
  await openFile();
  assert.equal((await dwgItem().innerText()).trim(), 'Save as DWG… (experimental)');
  await page.mouse.click(700, 500);

  step = 'without ODA: Preferences shows the optional note and a Get button that opens the fixed download';
  await page.evaluate(() => {
    window.__opened = 0;
    Object.assign(window.api, {
      dwgConfig: async () => ({ mode: 'auto', odaPath: '' }),
      dwgAvailable: async () => ({ available: true, version: 'LibreDWG', write: { oda: false }, oda: { available: false, reason: 'not installed' } }),
      openOdaDownload: async () => { window.__opened++; return true; },
    });
    window.app.preferences();
  });
  await page.waitForFunction(() => document.querySelector('#pref-oda-note'), null, { timeout: 5000 });
  assert.match(await page.locator('#pref-dwg-status').innerText(), /ODA File Converter: not installed\./);
  assert.match(await page.locator('#pref-oda-note').innerText(), /^Optional: install the free ODA File Converter to save back to DWG \(2000.2018\) and to open drawings the built-in converter cannot read\./);
  await page.locator('#pref-oda-get').click();
  assert.equal(await page.evaluate(() => window.__opened), 1);
  await btn('Cancel').click();
  await page.waitForFunction(() => !document.querySelector('#dlg')?.open, null, { timeout: 5000 });

  step = 'without ODA: the DWG-origin Save confirm explains and offers Get ODA File Converter';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    window.app.installDoc(M.newDocument(), { path: '/j/C.dwg', name: 'C.dwg', format: 'dwg' });
    window.__pC = window.app.save();
  });
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  assert.match(await dlgText(), /Saving back to DWG needs the ODA File Converter \(free, optional\)\. Without it, save a DXF copy/);
  await btn('Get ODA File Converter').click();
  await page.waitForFunction(() => window.__opened === 2, null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 }); // the confirm is shown again
  await btn('Cancel').click();
  assert.equal(await page.evaluate(() => window.__pC), false);

  assert.deepEqual(problems, []);
  console.log('dwgpref e2e: OK');
} catch (err) {
  console.error(`dwgpref e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
