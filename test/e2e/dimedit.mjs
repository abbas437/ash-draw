#!/usr/bin/env node
// Browser end-to-end test of editing a file-read dimension: double-click text override, grip drag, undo, TEXTEDIT; same harness as run.mjs.
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
  const ents = () => page.evaluate(() => JSON.parse(JSON.stringify([...window.app.doc.entities.values?.() ?? window.app.doc.entities])));
  const clickWorld = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m}: ${a} vs ${b}`);
  // a file-read dimension keeps its measurement in group 42 until it is rebuilt
  const meas = (d) => d.measurement ?? parseFloat(d.raw.find(([c]) => c === 42)[1]);
  const dimNow = async () => (await ents()).find((e) => e.type === 'DIMENSION');
  const screen = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    return { x: box.x + s.x, y: box.y + s.y };
  };
  const measured = () => page.locator('[data-prop="Measurement"] b').textContent();
  const dialogOk = async (text) => {
    const inp = page.locator('#modal input[type=text], dialog input[type=text], .modal input[type=text]').first();
    await inp.waitFor({ timeout: 5000 });
    await inp.fill(text);
    await inp.press('Enter');
  };

  step = 'load a file-read linear dimension (100 long, *D102 block, file tags)';
  const LIBREDWG_DIM = [[100, 'AcDbDimension'], [280, '0'], [2, '*D102'], [10, '0'], [20, '20'], [30, '0.0'],
    [11, '50'], [21, '22'], [31, '0.0'], [1, ''], [71, '5'], [42, '100.0'], [73, '0'], [74, '0'], [75, '0'],
    [3, 'ISO-25'], [100, 'AcDbAlignedDimension'], [13, '0'], [23, '0'], [33, '0.0'], [14, '100'], [24, '0'], [34, '0.0'],
    [52, '0.0'], [50, '0.0'], [100, 'AcDbRotatedDimension']];
  const dxf = '0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\n*D102\n70\n1\n10\n0\n20\n0\n30\n0\n3\n*D102\n1\n\n0\nLINE\n8\n0\n10\n0\n20\n20\n30\n0\n11\n100\n21\n20\n31\n0\n0\nENDBLK\n8\n0\n0\nENDSEC\n' +
    `0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n5\n1312\n100\nAcDbEntity\n8\n0\n${LIBREDWG_DIM.map(([c, v]) => `${c}\n${v}`).join('\n')}\n0\nENDSEC\n0\nEOF\n`;
  await page.evaluate(async (text) => {
    const { readDxf } = await import('/src/core/dxfRead.js');
    window.app.installDoc(readDxf(new TextEncoder().encode(text)), { path: null, name: 'dimedit.dxf', format: 'dxf' });
    const vp = window.app.vp; vp.setSelection([]); vp.view = { ...vp.view, cx: 70, cy: 10, zoom: 6 }; vp.render();
  }, dxf);
  let d = await dimNow();
  assert.ok(d && d.raw && d.def, 'dimension with file tags and a definition');
  near(meas(d), 100, 'measurement');
  const id = d.id;

  step = 'double-click the dimension text: prompt, "<> TYP." gives "100 TYP."';
  const tp = await screen(50, 20);
  await page.mouse.dblclick(tp.x, tp.y);
  await dialogOk('<> TYP.');
  await page.waitForFunction((i) => [...window.app.doc.entities.values?.() ?? window.app.doc.entities].find((e) => e.id === i)?.dimText === '100 TYP.', id, { timeout: 5000 });
  d = await dimNow();
  assert.equal(d.def.text, '<> TYP.');
  assert.equal(d.dimText, '100 TYP.');

  step = 'select, drag the extension-line grip (index 1) from x=100 to x=140: measurement 140';
  await page.evaluate((i) => window.app.vp.setSelection([i]), id);
  const g0 = await screen(100, 0), g1 = await screen(140, 0);
  await page.mouse.move(g0.x, g0.y); await page.mouse.down();
  await page.mouse.move((g0.x + g1.x) / 2, g0.y, { steps: 3 }); await page.mouse.move(g1.x, g1.y, { steps: 3 }); await page.mouse.up();
  d = await dimNow();
  assert.ok(Math.abs(d.measurement - 140) < 1, `measurement ${d.measurement}`);
  assert.ok(Math.abs(d.def.p2.x - 140) < 1, `p2.x ${d.def.p2.x}`);
  assert.equal(d.dimText, `${Math.round(d.measurement)} TYP.`);
  assert.equal(d.raw, null, 'file tags dropped once rebuilt');
  assert.equal((await measured()).replace(/\.0+$/, ''), String(Math.round(d.measurement)), 'Properties Measurement row');

  step = 'Ctrl+Z: measurement back to 100, override kept; Ctrl+Z again: override gone';
  await page.keyboard.press('Control+z');
  d = await dimNow();
  near(meas(d), 100, 'measurement after undo');
  near(d.def.p2.x, 100, 'p2 after undo');
  assert.equal(d.dimText, '100 TYP.');
  await page.keyboard.press('Control+z');
  d = await dimNow();
  assert.equal(d.def.text ?? '', '');

  step = 'TEXTEDIT on the selected dimension';
  await page.evaluate((i) => window.app.vp.setSelection([i]), id);
  await typeCmd('TEXTEDIT');
  await dialogOk('L=<>');
  await page.waitForFunction((i) => [...window.app.doc.entities.values?.() ?? window.app.doc.entities].find((e) => e.id === i)?.dimText === 'L=100', id, { timeout: 5000 });
  d = await dimNow();
  assert.equal(d.def.text, 'L=<>');

  step = 'TEXTEDIT with nothing selected: pick the dimension';
  await page.keyboard.press('Control+z');
  assert.equal((await dimNow()).def.text ?? '', '');
  await page.evaluate(() => window.app.vp.setSelection([]));
  await typeCmd('TEXTEDIT');
  const pt = await screen(50, 20);
  await page.mouse.click(pt.x, pt.y);
  await dialogOk('<> MAX');
  await page.waitForFunction((i) => [...window.app.doc.entities.values?.() ?? window.app.doc.entities].find((e) => e.id === i)?.dimText === '100 MAX', id, { timeout: 5000 });

  assert.deepEqual(problems, []);
  console.log('dimedit e2e: OK');
} catch (err) {
  console.error(`dimedit e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
