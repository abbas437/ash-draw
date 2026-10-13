#!/usr/bin/env node
// Browser end-to-end test of QSELECT, SELECTSIMILAR and PURGE (dialogs, undo, DXF output); same harness as run.mjs.
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

  step = 'build: 3 circles on A, 2 circles + 1 line on B, unused layer U, unused block UB';
  const ids = await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    for (const n of ['A', 'B', 'U']) M.addLayer(doc, { name: n });
    const add = (e) => M.addEntity(doc, e) ?? e;
    for (let i = 0; i < 3; i++) add(M.makeCircle({ x: i * 10, y: 0 }, 2, { layer: 'A' }));
    for (let i = 0; i < 2; i++) add(M.makeCircle({ x: i * 10, y: 20 }, 3, { layer: 'B' }));
    add(M.makeLine({ x: 0, y: 30 }, { x: 20, y: 30 }, { layer: 'B' }));
    M.addBlock(doc, 'UB', { x: 0, y: 0 }, [M.makeLine({ x: 0, y: 0 }, { x: 5, y: 5 })]);
    window.app.installDoc(doc, { path: null, name: 'selclean.dxf', format: 'dxf' });
    const d = window.app.doc;
    const of = (t, l) => d.entities.filter((e) => e.type === t && e.layer === l).map((e) => e.id).sort();
    return { circA: of('CIRCLE', 'A'), circB: of('CIRCLE', 'B'), lineB: of('LINE', 'B') };
  });
  assert.equal(ids.circA.length, 3); assert.equal(ids.circB.length, 2); assert.equal(ids.lineB.length, 1);
  assert.ok((await named()).blocks.includes('UB') && (await named()).layers.includes('U'));

  step = 'QSELECT: entire drawing, Circle, Layer = A';
  await page.evaluate(() => window.app.vp.setSelection([]));
  await typeCmd('QSELECT');
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  await page.locator('#dlg select[name=qs-apply]').selectOption('all');
  await page.locator('#dlg select[name=qs-type]').selectOption('CIRCLE');
  await page.locator('#dlg select[name=qs-prop]').selectOption('Layer');
  await page.locator('#dlg select[name=qs-op]').selectOption('=');
  await page.locator('#dlg [name=qs-value]').selectOption('A');
  await btn('OK').click();
  await page.waitForFunction(() => window.app.vp.selection.size === 3, null, { timeout: 5000 });
  assert.deepEqual(await sel(), ids.circA);
  assert.equal(await dlgOpen(), false);

  step = 'SELECTSIMILAR: one circle on B selects both circles on B';
  await page.evaluate((id) => window.app.vp.setSelection([id]), ids.circB[0]);
  await typeCmd('SELECTSIMILAR');
  await page.waitForFunction(() => window.app.vp.selection.size === 2, null, { timeout: 5000 });
  assert.deepEqual(await sel(), ids.circB);

  step = 'PURGE: dialog lists UB and U, Purge all removes both';
  await page.evaluate(() => window.app.vp.setSelection([]));
  const purgeAll = async () => {
    await typeCmd('PU');
    await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
    const listed = await page.evaluate(() => [...document.querySelectorAll('#dlg input[data-kind]')].map((b) => `${b.dataset.kind}:${b.dataset.name}`));
    assert.ok(listed.includes('Blocks:UB'), `UB listed: ${listed}`);
    assert.ok(listed.includes('Layers:U'), `U listed: ${listed}`);
    assert.ok(!listed.includes('Layers:A') && !listed.includes('Layers:B'), `used layers not listed: ${listed}`);
    await btn('Purge all').click();
    await page.waitForFunction(() => !window.app.doc.blocks.has('UB') && !window.app.doc.layers.has('U'), null, { timeout: 5000 });
  };
  await purgeAll();
  let n = await named();
  assert.ok(n.layers.includes('A') && n.layers.includes('B'), 'used layers kept');
  assert.equal(await page.evaluate(() => window.app.doc.entities.length), 6, 'no entity removed');

  step = 'PURGE: U restores both';
  await typeCmd('U');
  await page.waitForFunction(() => window.app.doc.blocks.has('UB') && window.app.doc.layers.has('U'), null, { timeout: 5000 });

  step = 'PURGE again, then DXF has no UB block and no layer U';
  await purgeAll();
  const dxf = await page.evaluate(async () => {
    const W = await import('/src/core/dxfWrite.js');
    const out = W.writeDxf(window.app.fileDoc);
    return typeof out === 'string' ? out : new TextDecoder().decode(out);
  });
  const lines = dxf.split(/\r?\n/).map((s) => s.trim());
  const names = (kind) => { // group-2 names of every LAYER table entry, or of every BLOCK
    const out = []; let cur = null;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const [c, v] = [lines[i], lines[i + 1]];
      if (c === '0') { cur = v; continue; }
      if (c === '2' && cur === kind) { out.push(v); cur = null; }
    }
    return out;
  };
  const blocks = names('BLOCK'), layers = names('LAYER');
  assert.ok(layers.includes('A') && layers.includes('B'), `DXF layer table parsed: ${layers}`);
  assert.ok(!layers.includes('U'), `no layer U in DXF: ${layers}`);
  assert.ok(blocks.length > 0 && !blocks.includes('UB'), `no UB block in DXF: ${blocks}`);

  step = 'Escape closes QSELECT and PURGE without changes';
  await page.evaluate((id) => window.app.vp.setSelection([id]), ids.lineB[0]);
  await typeCmd('U'); // bring UB and U back so PURGE has something it could remove
  await page.waitForFunction(() => window.app.doc.blocks.has('UB') && window.app.doc.layers.has('U'), null, { timeout: 5000 });
  await page.evaluate((id) => window.app.vp.setSelection([id]), ids.lineB[0]);
  const before = { sel: await sel(), named: await named(), count: await page.evaluate(() => window.app.doc.entities.length) };
  await typeCmd('QSELECT');
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  await typeCmd('PU');
  await page.waitForFunction(() => document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#dlg')?.open, null, { timeout: 5000 });
  await page.waitForTimeout(200);
  assert.deepEqual({ sel: await sel(), named: await named(), count: await page.evaluate(() => window.app.doc.entities.length) }, before);

  assert.deepEqual(problems, []);
  console.log('selclean e2e: OK');
} catch (err) {
  console.error(`selclean e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
