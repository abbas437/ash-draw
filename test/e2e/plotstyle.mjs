#!/usr/bin/env node
// Browser end-to-end test of plot style tables (.ctb) in Plot to PDF and PAGESETUP: Load .ctb…, the PDF pens, the choice
// remembered (or not: a failed save), a layout's own table preselected, None, Monochrome disabled while a table is chosen. Harness as plotprogress.mjs.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await fs.readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;


// a .ctb as AutoCAD writes it (zlib-compressed): writePlotStyleTable's text, recompressed (its own writer stores it uncompressed)
const { writePlotStyleTable, BUILTIN_TABLES } = await import('../../src/core/plotStyle.js');
function compressedCtb(table) {
  const raw = writePlotStyleTable(table), dv = new DataView(raw.buffer);
  const zs = raw.subarray(60, 60 + dv.getUint32(56, true));
  const text = zlib.inflateSync(zs), z = zlib.deflateSync(text, { level: 9 });
  const out = new Uint8Array(60 + z.length); out.set(raw.subarray(0, 48));
  const o = new DataView(out.buffer); o.setUint32(48, 0, true); o.setUint32(52, text.length, true); o.setUint32(56, z.length, true);
  out.set(z, 60); return Buffer.from(out);
}
const acad = BUILTIN_TABLES['acad.ctb'];
const CTB = compressedCtb({ ...acad, styles: acad.styles.map((s, i) => (i === 0 ? { ...s, color: [0, 0, 0], lineweight: 0.7 } : i === 2 ? { ...s, screening: 50 } : s)) });
const NAME = 'XYZ-Pens.ctb';
/** [r, g, b, width pt] of every stroke state in the first page's content */
async function strokes(bytes) {
  const pdf = await PDFDocument.load(bytes), c = pdf.getPage(0).node.Contents();
  const st = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  const t = st.map((x) => new TextDecoder().decode(decodePDFRawStream(x).decode())).join('\n');
  return [...t.matchAll(/(\S+) (\S+) (\S+) RG\n(\S+) w\n/g)].map((m) => m.slice(1, 5).map(Number));
}
const near = (a, b, tol = 0.01) => Math.abs(a - b) < tol;

const problems = [];
let step = 'start';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  const ready = async () => {
    await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });
    await page.evaluate(async () => { // a red and a green line; layouts naming a loaded table (other case) and an unknown one
      const { newDocument } = await import('/src/core/model.js');
      const { Session } = await import('/src/core/edit.js');
      const { makeViewport } = await import('/src/core/layouts.js');
      const { addLayout, layoutsOf } = await import('/src/core/layoutmgmt.js');
      const doc = newDocument(), s = new Session(doc);
      doc.units = 4;
      const line = (y, color) => ({ type: 'LINE', id: 0, layer: '0', color, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 0, y }, p2: { x: 100, y } });
      s.transact('setup', (tx) => { tx.add(line(0, 1)); tx.add(line(20, 3)); });
      addLayout(s, 'L1'); addLayout(s, 'L2');
      const fit = { minx: 0, miny: -10, maxx: 100, maxy: 30 };
      for (const [lo, sheet] of [[layoutsOf(doc)[0], 'xyz-pens.CTB'], [layoutsOf(doc)[1], 'Other.ctb']]) {
        s.transact('paper', (tx) => { tx.set(lo, 'entities', [{ ...makeViewport({ x: 0, y: 0 }, { x: 420, y: 297 }, null, 1), paper: true, id: doc.nextId++ }, { ...makeViewport({ x: 20, y: 50 }, { x: 400, y: 230 }, fit, 2), id: doc.nextId++ }]); tx.set(lo, 'plot', { ...lo.plot, styleSheet: sheet }); });
      }
      window.app.installDoc(doc, { path: null, name: 'pens.dxf', format: 'dxf' });
    });
  };
  await ready();
  const dlg = page.locator('#dlg[open]');
  const openPlot = async () => {
    await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
    await page.locator('#menubar .drop button', { hasText: 'Plot to PDF…' }).click();
    await dlg.waitFor({ timeout: 5000 });
  };
  const save = async () => { const dl = page.waitForEvent('download', { timeout: 60000 }); await dlg.locator('button.primary').click(); return fs.readFile(await (await dl).path()); };
  const sel = dlg.locator('select[name=styleTable]');

  step = 'Plot to PDF: Load .ctb… takes the contractor table, lists and selects it; Monochrome is disabled with the note';
  await openPlot();
  assert.equal(await sel.inputValue(), '', 'None at first');
  assert.equal(await dlg.locator('input[name=monochrome]').isDisabled(), false);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), sel.selectOption({ label: 'Load .ctb…' })]);
  await chooser.setFiles({ name: NAME, mimeType: 'application/octet-stream', buffer: CTB });
  await page.waitForFunction((n) => document.querySelector('#dlg select[name=styleTable]').value === n, NAME, { timeout: 5000 });
  assert.equal(await dlg.locator('input[name=monochrome]').isDisabled(), true, 'Monochrome disabled');
  assert.equal(await dlg.locator('input[name=keepGreys]').isDisabled(), true, 'Keep greys disabled');
  assert.equal(await dlg.locator('.plot-style-note').isVisible(), true);

  step = 'the PDF: pen 1 black at 0.70 mm, pen 3 green screened 50 %';
  let st = await strokes(await save());
  assert.ok(st.some(([r, g, b, w]) => r === 0 && g === 0 && b === 0 && near(w, 0.7 * 72 / 25.4)), `black 0.70 mm in ${JSON.stringify(st)}`);
  assert.ok(st.some(([r, g, b]) => near(r, 0.5, 0.01) && g === 1 && near(b, 0.5, 0.01)), `screened green in ${JSON.stringify(st)}`);
  assert.ok(!st.some(([r, g, b]) => r === 1 && g === 0 && b === 0), 'no red');

  step = 'reload: the dialog reopens with the loaded table chosen';
  await ready();
  await openPlot();
  assert.equal(await sel.inputValue(), NAME);
  assert.equal(await dlg.locator('input[name=monochrome]').isDisabled(), true);

  step = 'None: the original colours, and Monochrome is enabled again';
  await sel.selectOption('');
  assert.equal(await dlg.locator('input[name=monochrome]').isDisabled(), false);
  assert.equal(await dlg.locator('.plot-style-note').isVisible(), false);
  st = await strokes(await save());
  assert.ok(st.some(([r, g, b]) => r === 1 && g === 0 && b === 0), `red in ${JSON.stringify(st)}`);
  assert.ok(st.some(([r, g, b]) => r === 0 && g === 1 && b === 0), `green in ${JSON.stringify(st)}`);

  step = 'layout L1 names the loaded table (other case): preselected although None is remembered';
  await page.click('#spacebar button[data-space="L1"]');
  await openPlot();
  assert.equal(await sel.inputValue(), NAME);
  assert.equal(await dlg.locator('.plot-style-sheet').isVisible(), false);
  st = await strokes(await save());
  assert.ok(st.some(([r, g, b, w]) => r === 0 && g === 0 && b === 0 && near(w, 0.7 * 72 / 25.4)), `layout plot black 0.70 mm in ${JSON.stringify(st)}`);

  step = 'layout L2 names an unknown table: the line says so and the remembered choice (None) is kept';
  await page.click('#spacebar button[data-space="L2"]');
  await openPlot();
  assert.equal(await sel.inputValue(), '');
  assert.match(await dlg.locator('.plot-style-sheet').innerText(), /This layout uses 'Other\.ctb'/);
  await dlg.locator('button', { hasText: 'Cancel' }).click();

  step = 'PAGESETUP: the unknown name is shown and kept; choosing the loaded table stores it in one undo step';
  await page.click('#spacebar button[data-space="L2"]', { button: 'right' });
  await page.locator('.popmenu button[data-act=pagesetup]').click();
  await dlg.waitFor({ timeout: 5000 });
  assert.equal(await sel.inputValue(), 'Other.ctb');
  await sel.selectOption(NAME);
  await dlg.locator('button.primary').click();
  const sheet = () => page.evaluate(() => window.app.doc.layouts.find((l) => l.name === 'L2').plot.styleSheet);
  assert.equal(await sheet(), NAME);
  await page.evaluate(() => window.app.undo());
  assert.equal(await sheet(), 'Other.ctb', 'one undo restores it');

  step = 'an .stb and a damaged file are refused with a message in the dialog';
  await openPlot();
  for (const [file, re] of [[{ name: 'named.stb', mimeType: 'application/octet-stream', buffer: CTB }, /Named plot style tables \(\.stb\) are not supported yet/], [{ name: 'bad.ctb', mimeType: 'application/octet-stream', buffer: Buffer.from('not a table') }, /bad\.ctb cannot be used: Plot style table: not a CTB\/STB file/]]) {
    const [ch] = await Promise.all([page.waitForEvent('filechooser'), sel.selectOption({ label: 'Load .ctb…' })]);
    await ch.setFiles(file);
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#dlg .plot-style-msg')?.textContent ?? ''), re.source, { timeout: 5000 });
    assert.equal(await sel.inputValue(), '', 'the choice is unchanged');
    assert.equal(await dlg.locator('button.primary').isVisible(), true, 'the Plot dialog stays open');
  }

  await dlg.locator('button', { hasText: 'Cancel' }).click();
  step = 'a table whose setting cannot be saved: the dialog says it could not be remembered, and it is used';
  // window.api is frozen by the shim: this page's settingsSet is made to fail as it is created
  await page.addInitScript(() => { const freeze = Object.freeze; Object.freeze = (o) => freeze(o && typeof o.settingsSet === 'function' ? Object.assign(o, { settingsSet: () => Promise.reject(new Error('disk full')) }) : o); });
  await ready();
  await openPlot();
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), sel.selectOption({ label: 'Load .ctb…' })]);
  await ch2.setFiles({ name: 'Second.ctb', mimeType: 'application/octet-stream', buffer: CTB });
  await page.waitForFunction(() => /Second\.ctb could not be remembered/.test(document.querySelector('#dlg .plot-style-msg')?.textContent ?? ''), null, { timeout: 5000 });
  assert.equal(await sel.inputValue(), 'Second.ctb');

  await dlg.locator('button', { hasText: 'Cancel' }).click();
  assert.deepEqual(problems, []);
  console.log('plotstyle e2e: OK');
} catch (err) {
  console.error(`plotstyle e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
