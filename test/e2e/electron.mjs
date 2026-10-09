#!/usr/bin/env node
// Runs the REAL Electron app (needs the electron binary and a display, e.g. xvfb-run) against a sample DWG.
// env: ASH_LIBREDWG_DIR (folder with dwg2dxf/dxf2dwg), ASH_E2E_DWG (path to a .dwg), ELECTRON_BIN (optional)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { newDocument, addEntity, addLayer } from '../../src/core/model.js';
import { writeDxf } from '../../src/core/dxfWrite.js';
import { readDxf } from '../../src/core/dxfRead.js';
import { listXrefs } from '../../src/core/xref.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const electronBin = process.env.ELECTRON_BIN || require('electron');
const dwgIn = process.env.ASH_E2E_DWG;
assert.ok(dwgIn, 'set ASH_E2E_DWG to a sample .dwg');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-draw-e2e-'));
// the app's renderer imports renderer/vendor (made by `node scripts/vendor.js`); without it app.js never loads
await fs.access(path.join(ROOT, 'renderer', 'vendor', 'pdf-lib.esm.js')).catch(() => { throw new Error('renderer/vendor is missing: run `node scripts/vendor.js` first'); });
let step = 'launch';
const setStep = (s) => { step = s; console.log(`step: ${s}`); };
// fail fast instead of hanging: an awaited app call that never settles (e.g. a dialog the test does not answer)
const bounded = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${ms} ms (an unanswered dialog?)`)), ms).unref())]);
const app = await electron.launch({
  executablePath: electronBin,
  args: ['--disable-gpu', ROOT, dwgIn],
  env: { ...process.env, ASH_USER_DATA: tmp },
  cwd: ROOT,
});
try {
  const errors = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await win.waitForFunction(() => window.app && window.app.doc, null, { timeout: 20000 })
    .catch((err) => { throw new Error(`the app did not load (${errors.join(' | ') || err.message})`); });

  setStep('opened the DWG given on the command line');
  await win.waitForFunction(() => window.app.file.format === 'dwg' && window.app.doc.entities.length > 0, null, { timeout: 30000 });
  const info = await win.evaluate(() => ({ n: window.app.doc.entities.length, name: window.app.file.name, electron: window.api.isElectron }));
  assert.ok(info.electron);
  console.log('opened', info.name, info.n, 'objects');
  await win.waitForTimeout(300);
  if (process.env.E2E_SHOTS) await win.screenshot({ path: path.join(process.env.E2E_SHOTS, 'electron_dwg.png') });

  setStep('xref:read resolves only xref files of a granted host');
  const viaXref = (host, ref) => win.evaluate(([h, r]) => window.api.xrefRead(h, r).then((x) => (x ? { name: x.name, format: x.format, dxf: new TextDecoder().decode(x.bytes.slice(0, 400)) } : null), (e) => ({ error: e.message })), [host, ref]);
  const sib = await viaXref(dwgIn, 'some\\folder\\Constraints.dwg'); // not there -> same file name in the host folder
  assert.equal(sib?.name, 'Constraints.dwg', JSON.stringify(sib));
  assert.match(sib.dxf, /SECTION/, 'a DWG xref comes back as DXF');
  assert.equal(await viaXref(dwgIn, path.join(path.dirname(dwgIn), 'Arc.jpg')), null, 'only .dxf/.dwg files are read');
  assert.equal(await viaXref(dwgIn, '/etc/passwd'), null);
  assert.equal(await viaXref(dwgIn, 'no-such-xref.dxf'), null);
  const notGranted = await viaXref(path.join(tmp, 'not-opened.dxf'), dwgIn);
  assert.match(notGranted?.error ?? '', /not opened or chosen/, `a host that was not opened is refused: ${JSON.stringify(notGranted)}`);

  setStep('xrefs: a host in a temp folder with ./sub/ref.dxf and a missing xref loads on open');
  const xdir = path.join(tmp, 'xhost'), hostDxf = path.join(xdir, 'host.dxf');
  await fs.mkdir(path.join(xdir, 'sub'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'test', 'fixtures', 'xref_host_r2000.dxf'), hostDxf); // xrefs REF -> sub/ref.dxf, GONE -> missing.dxf
  const refDoc = newDocument();
  addLayer(refDoc, { name: 'WALL', color: 3 });
  addEntity(refDoc, { type: 'LINE', layer: 'WALL', p1: { x: 3, y: 4 }, p2: { x: 777.25, y: 555.5 } });
  await fs.writeFile(path.join(xdir, 'sub', 'ref.dxf'), writeDxf(refDoc));
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, hostDxf);
  await bounded(win.evaluate(() => window.app.open()), 15000, 'open()');
  await win.waitForFunction(() => window.app.file.name === 'host.dxf', null, { timeout: 15000 });
  const refLines = () => win.evaluate(() => window.app.scene().items.filter((it) => it.kind === 'path' && it.style.layerName === 'REF|WALL').length);
  const xrefRows = () => win.$$eval('#dlg tr[data-xref]', (trs) => trs.map((tr) => [tr.dataset.xref, tr.querySelector('.xref-status').textContent]));
  await win.locator('#cmd').fill('xref'); await win.locator('#cmd').press('Enter');
  await win.waitForSelector('#dlg[open] .xref-table');
  assert.deepEqual(await xrefRows(), [['REF', 'Loaded'], ['GONE', 'Not found']]);
  assert.equal(await refLines(), 1, 'the line of sub/ref.dxf is in the scene');

  setStep('xrefs: Unload hides the xref, Reload restores it');
  await win.locator('#dlg tr[data-xref=REF] button[data-act=unload]').click();
  await win.waitForFunction(() => document.querySelector('#dlg tr[data-xref=REF] .xref-status')?.textContent === 'Unloaded');
  assert.equal(await refLines(), 0);
  await win.locator('#dlg tr[data-xref=REF] button[data-act=reload]').click();
  await win.waitForFunction(() => document.querySelector('#dlg tr[data-xref=REF] .xref-status')?.textContent === 'Loaded');
  assert.equal(await refLines(), 1);
  await win.locator('#dlg button.primary').click();

  setStep('xrefs: Save keeps the relative xref path and writes none of the xref content into the host');
  const hostBefore = (await fs.stat(hostDxf)).mtimeMs;
  await win.waitForTimeout(50);
  await bounded(win.evaluate(() => window.app.save()), 10000, 'save()');
  for (let i = 0; i < 50 && (await fs.stat(hostDxf)).mtimeMs <= hostBefore; i++) await win.waitForTimeout(100);
  assert.ok((await fs.stat(hostDxf)).mtimeMs > hostBefore, 'the host was not saved');
  const hostText = await fs.readFile(hostDxf, 'utf8');
  const back = readDxf(new TextEncoder().encode(hostText));
  assert.deepEqual(listXrefs(back).map((x) => [x.name, x.path]), [['REF', 'sub/ref.dxf'], ['GONE', 'missing.dxf']]);
  assert.equal(back.blocks.get('REF').entities.length, 0);
  const afterHeader = hostText.slice(hostText.indexOf('ENDSEC')); // $EXTMAX may include the xref: only tables, blocks and entities matter
  assert.ok(!/REF\|WALL/.test(hostText) && !/777\.25/.test(afterHeader), 'xref content was written into the host');
  assert.ok(!back.layers.has('REF|WALL') && back.entities.every((e) => e.type !== 'LINE' || e.p2.x !== 777.25));

  setStep('xrefs: a DWG xref loads (xref:read hands back DXF bytes)');
  const dwgHost = path.join(xdir, 'host-dwg.dxf');
  await fs.writeFile(dwgHost, (await fs.readFile(hostDxf, 'utf8')).replace('sub/ref.dxf', 'sub/arc.dwg'));
  await fs.copyFile(dwgIn, path.join(xdir, 'sub', 'arc.dwg'));
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, dwgHost);
  await bounded(win.evaluate(() => window.app.open()), 15000, 'open()');
  await win.waitForFunction(() => window.app.file.name === 'host-dwg.dxf', null, { timeout: 15000 });
  await win.locator('#cmd').fill('xref'); await win.locator('#cmd').press('Enter');
  await win.waitForSelector('#dlg[open] .xref-table');
  assert.deepEqual(await xrefRows(), [['REF', 'Loaded'], ['GONE', 'Not found']]);
  await win.locator('#dlg button.primary').click();

  setStep('xrefs: XATTACH picks sub/ref.dxf as att.dxf, a click places it, one Ctrl+Z removes everything');
  const attPath = path.join(xdir, 'att.dxf');
  await fs.copyFile(path.join(xdir, 'sub', 'ref.dxf'), attPath);
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, attPath);
  await win.locator('#cmd').fill('xa'); await win.locator('#cmd').press('Enter');
  await win.waitForFunction(() => window.app.toolId === 'xattach' && window.app.tool.x?.file.name === 'att.dxf', null, { timeout: 10000 });
  const cvBox = await win.locator('#cv').boundingBox();
  await win.mouse.click(cvBox.x + cvBox.width / 2, cvBox.y + cvBox.height / 2);
  const attItems = () => win.evaluate(() => window.app.scene().items.filter((it) => (it.style?.layerName ?? '').startsWith('ATT|')).length);
  await win.waitForFunction(() => window.app.scene().items.some((it) => (it.style?.layerName ?? '').startsWith('ATT|')), null, { timeout: 10000 });
  await win.locator('#cmd').fill('xref'); await win.locator('#cmd').press('Enter');
  await win.waitForSelector('#dlg[open] .xref-table');
  assert.deepEqual((await xrefRows()).filter(([n]) => n === 'ATT'), [['ATT', 'Loaded']]);
  assert.equal(await win.locator('#dlg tr[data-xref=ATT] td').nth(3).textContent(), '1', 'one insert');
  assert.match(await win.locator('#dlg tr[data-xref=ATT] td').nth(2).textContent(), /^\.[\\/]att\.dxf$/, 'path relative to the host');
  assert.ok(await attItems() > 0);
  await win.locator('#dlg button.primary').click();
  await win.locator('#cv').focus(); await win.keyboard.press('Control+z');
  await win.waitForFunction(() => !window.app.fileDoc.blocks.has('ATT'), null, { timeout: 10000 });
  assert.equal(await attItems(), 0, 'scene still has ATT| items after undo');
  assert.deepEqual(await win.evaluate(() => ({ blk: window.app.fileDoc.blocks.has('ATT'), layers: [...window.app.fileDoc.layers.keys()].filter((k) => k.startsWith('ATT|')) })), { blk: false, layers: [] });

  setStep('save as DXF (native dialog stubbed)');
  const dxfOut = path.join(tmp, 'out.dxf');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, dxfOut);
  await bounded(win.evaluate(() => window.app.saveAs('dxf')), 10000, "saveAs('dxf')");
  await win.waitForFunction(() => window.app.file.format === 'dxf', null, { timeout: 10000 });
  assert.match((await fs.readFile(dxfOut, 'utf8')).slice(0, 200), /SECTION/);

  setStep('plain Save now overwrites the DXF without a dialog');
  const before = (await fs.stat(dxfOut)).mtimeMs;
  await win.waitForTimeout(50);
  await bounded(win.evaluate(() => window.app.save()), 10000, 'save()');
  await win.waitForTimeout(300);
  assert.ok((await fs.stat(dxfOut)).mtimeMs >= before);

  setStep('Save over a file that would lose content asks first');
  await win.evaluate(() => { window.app.doc.skipped = { XLINE: 1 }; });
  const saving = win.evaluate(() => window.app.save());
  await win.waitForSelector('#dlg[open] h2');
  assert.match(await win.locator('#dlg').innerText(), /Overwrite the original file\?[\s\S]*1 XLINE/);
  await win.locator('#dlg button', { hasText: 'Cancel' }).click();
  assert.equal(await bounded(saving, 10000, 'save()'), false);
  await win.evaluate(() => { window.app.doc.skipped = {}; });

  setStep('save as DWG, verified by read-back');
  const dwgOut = path.join(tmp, 'out.dwg');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, dwgOut);
  const done = win.evaluate(() => window.app.saveAs('dwg'));
  await win.locator('#dlg button', { hasText: 'Save as DWG' }).click();
  await win.waitForSelector('#dlg[open] h2', { timeout: 60000 });
  const title = await win.locator('#dlg h2').innerText();
  console.log('DWG save dialog:', title, '|', (await win.locator('#dlg .dlg-body').innerText()).slice(0, 160).replace(/\n/g, ' '));
  assert.equal(title, 'DWG saved', 'the DWG read back differs from the drawing');
  await win.locator('#dlg button.primary').click();
  await bounded(done, 10000, "saveAs('dwg')");
  assert.equal((await fs.readFile(dwgOut)).subarray(0, 4).toString(), 'AC10');

  setStep('Print (Ctrl+P) prints the plot from a hidden PDF window, not the main window');
  await app.evaluate(({ webContents }) => {
    const fs = process.getBuiltinModule('node:fs');
    globalThis.__prints = [];
    Object.getPrototypeOf(webContents.getAllWebContents()[0]).print = function (opts, cb) {
      const url = this.getURL();
      globalThis.__prints.push({ id: this.id, url, opts, file: url.startsWith('file:') ? new URL(url).pathname : null, existed: url.startsWith('file:') && fs.existsSync(new URL(url).pathname) });
      setTimeout(() => cb(true, ''), 0);
    };
  });
  await win.locator('#cv').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+P');
  await win.waitForSelector('#dlg[open] h2');
  assert.equal(await win.locator('#dlg h2').innerText(), 'Print');
  await win.locator('#dlg select[name=pageSize]').selectOption('A4');
  await win.locator('#dlg button.primary').click();
  for (let i = 0; i < 200 && !(await app.evaluate(() => globalThis.__prints.length)); i++) await win.waitForTimeout(100);
  await win.waitForTimeout(300); // print callback -> clean-up
  const printed = await app.evaluate(({ BrowserWindow }) => ({ prints: globalThis.__prints, mainId: BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).webContents.id, windows: BrowserWindow.getAllWindows().length }));
  assert.equal(printed.prints.length, 1, JSON.stringify(printed));
  const [job] = printed.prints;
  assert.notEqual(job.id, printed.mainId, 'printed the main window instead of the plot');
  assert.match(job.url, /^file:.*\.pdf$/);
  assert.ok(job.existed, 'the plot PDF existed while printing');
  assert.equal(job.opts.silent, false);
  assert.equal(await fs.stat(job.file).then(() => true, () => false), false, 'temp PDF removed');
  assert.equal(await fs.stat(path.dirname(job.file)).then(() => true, () => false), false, 'temp folder removed');
  assert.equal(printed.windows, 1, 'hidden print window closed');

  setStep('Plot to PDF: window picked by two typed corners, 1:50 on A3');
  const pdfOut = path.join(tmp, 'plot.pdf');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, pdfOut);
  await win.locator('#menubar .menu > button', { hasText: 'File' }).click();
  await win.locator('#menubar .drop button', { hasText: 'Plot to PDF…' }).click();
  await win.waitForSelector('#dlg[open] h2');
  assert.equal(await win.locator('#dlg h2').innerText(), 'Plot to PDF');
  await win.locator('#dlg select[name=pageSize]').selectOption('A3');
  await win.locator('#dlg select[name=orientation]').selectOption('landscape');
  await win.locator('#dlg input[name=fit]').uncheck();
  await win.locator('#dlg input[name=scale]').fill('50');
  await win.locator('#dlg button', { hasText: 'Pick window…' }).click();
  const bb = await win.evaluate(() => window.app.scene().bbox);
  for (const p of [`${bb.minx},${bb.miny}`, `${bb.maxx},${bb.maxy}`]) { await win.locator('#cmd').fill(p); await win.locator('#cmd').press('Enter'); }
  await win.waitForSelector('#dlg[open] h2');
  assert.match(await win.locator('#dlg .plot-window').innerText(), /^Window: \(/);
  assert.equal(await win.locator('#dlg select[name=what]').inputValue(), 'window');
  assert.equal(await win.locator('#dlg input[name=scale]').inputValue(), '50');
  await win.locator('#dlg button.primary').click();
  for (let i = 0; i < 100 && !(await fs.stat(pdfOut).then(() => true, () => false)); i++) await win.waitForTimeout(100);
  const size = (await PDFDocument.load(await fs.readFile(pdfOut))).getPage(0).getSize();
  assert.ok(Math.abs(size.width - 1190.55) < 0.1 && Math.abs(size.height - 841.89) < 0.1, `page ${size.width} x ${size.height}`);
  if (await win.locator('#dlg[open]').count()) await win.locator('#dlg button.primary').click(); // warnings, if any

  setStep('IMAGE: a host with ./img/logo.png (solid colour) draws the PNG inside the frame');
  const idir = path.join(tmp, 'ihost'), imgHost = path.join(idir, 'host.dxf'), RGB = [20, 180, 60];
  await fs.mkdir(path.join(idir, 'img'), { recursive: true });
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2; // 8 x 8 RGB
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill(RGB).flat()])));
  await fs.writeFile(path.join(idir, 'img', 'logo.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
  await fs.writeFile(path.join(idir, 'img', 'logo.exe'), 'MZ');
  await fs.writeFile(path.join(idir, 'img', 'notes.txt'), 'x');
  const idoc = newDocument();
  addEntity(idoc, { type: 'LINE', p1: { x: -5, y: -5 }, p2: { x: 25, y: -5 } });
  addEntity(idoc, { type: 'CIRCLE', c: { x: 30, y: 30 }, r: 3 });
  addEntity(idoc, { type: 'IMAGE', p: { x: 0, y: 0 }, u: { x: 2.5, y: 0 }, v: { x: 0, y: 2.5 }, size: { x: 8, y: 8 }, flags: 7, clip: { on: false, type: 1, pts: [] }, brightness: 50, contrast: 50, fade: 0, path: './img/logo.png', def: { path: './img/logo.png', size: { x: 8, y: 8 }, pixel: { x: 1, y: 1 }, units: 0, loaded: 1 } });
  await fs.writeFile(imgHost, writeDxf(idoc));
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, imgHost);
  await bounded(win.evaluate(() => window.app.open()), 15000, 'open()');
  await win.waitForFunction(() => window.app.file.path?.endsWith('ihost/host.dxf'), null, { timeout: 15000 });
  assert.equal(await win.locator('#dlg[open]').count(), 0, 'no limitations dialog: the image was found');
  const px = await win.evaluate(() => {
    const vp = window.app.vp;
    vp.zoomExtents(); vp.render();
    const cv = document.getElementById('cv'), s = vp.toScreen({ x: 10, y: 10 }), d = vp.dpr;
    return [...cv.getContext('2d').getImageData(Math.round(s.x * d), Math.round(s.y * d), 1, 1).data].slice(0, 3);
  });
  assert.deepEqual(px, RGB, `pixel inside the image frame is ${px}`);

  setStep('image:read: only raster files of a granted host, only from the app window');
  const viaImg = (ref) => win.evaluate((r) => window.api.imageRead(r[0], r[1]).then((x) => (x ? { name: x.name, mime: x.mime, n: x.bytes.length } : null), (e) => ({ error: e.message })), [imgHost, ref]);
  assert.equal((await viaImg('./img/logo.png'))?.mime, 'image/png');
  assert.equal(await viaImg('./img/logo.exe'), null);
  assert.equal(await viaImg('./img/notes.txt'), null);
  const foreign = await app.evaluate(async ({ BrowserWindow }, [preload, h]) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
    try {
      await w.loadURL('data:text/html,<p>x</p>');
      return await w.webContents.executeJavaScript(`window.api.imageRead(${JSON.stringify(h)}, './img/logo.png').then(() => 'read', (e) => e.message)`);
    } finally { w.destroy(); }
  }, [path.join(ROOT, 'electron', 'preload.js'), imgHost]);
  assert.match(foreign, /unauthorised sender/);

  setStep('IMAGE: a DWG save keeps the other entities (and the image)');
  const imgDwg = path.join(idir, 'host.dwg');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, imgDwg);
  const savingImg = win.evaluate(() => window.app.saveAs('dwg'));
  await win.locator('#dlg button', { hasText: 'Save as DWG' }).click();
  await win.waitForSelector('#dlg[open] h2', { timeout: 60000 });
  assert.equal(await win.locator('#dlg h2').innerText(), 'DWG saved', await win.locator('#dlg').innerText());
  await win.locator('#dlg button.primary').click();
  await bounded(savingImg, 10000, "saveAs('dwg')");
  const backTypes = await win.evaluate(async (b) => { const r = await window.api.dwgToDxf(new Uint8Array(b)); return new TextDecoder().decode(r.dxfBytes); }, [...await fs.readFile(imgDwg)]);
  assert.deepEqual(readDxf(new TextEncoder().encode(backTypes)).entities.map((e) => e.type).sort(), ['CIRCLE', 'IMAGE', 'LINE']);

  setStep('DWG converter: Built-in fails on a truncated DWG with the ODA hint; Automatic with a (stub) ODA path opens it');
  const odir = path.join(tmp, 'oda', 'ODAFileConverter 99.1.0');
  await fs.mkdir(odir, { recursive: true });
  const stubExe = path.join(odir, 'ODAFileConverter'); // argv: in out ACAD2018 DXF 0 1 drawing.dwg -> writes out/drawing.dxf
  await fs.writeFile(stubExe, `#!${process.execPath}\nconst [i, o, v, t, , , f] = process.argv.slice(2);\nrequire('fs').writeFileSync(require('path').join(o, f.replace(/\\.dwg$/, '.dxf')), \`999\\n\${v} \${t}\\n  0\\nSECTION\\n  2\\nENTITIES\\n  0\\nLINE\\n  8\\nODA\\n 10\\n0\\n 20\\n0\\n 11\\n50\\n 21\\n25\\n  0\\nENDSEC\\n  0\\nEOF\\n\`);\n`);
  await fs.chmod(stubExe, 0o755);
  const truncated = path.join(tmp, 'truncated.dwg');
  await fs.writeFile(truncated, (await fs.readFile(dwgIn)).subarray(0, 600));
  const prefs = async (modeValue, browseTo) => {
    if (browseTo) await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, browseTo);
    const open = win.evaluate(() => window.app.preferences());
    await win.locator('#pref-dwg-mode').waitFor({ timeout: 5000 });
    await win.locator('#pref-dwg-mode').selectOption(modeValue);
    if (browseTo) { await win.locator('#dlg button', { hasText: 'Browse…' }).click(); await win.waitForFunction((p) => document.getElementById('pref-oda-path').value === p, browseTo); }
    await win.locator('#dlg button', { hasText: 'Save' }).click();
    await bounded(open, 5000, 'preferences()');
  };
  await prefs('libredwg', stubExe);
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, truncated);
  const failing = win.evaluate(() => window.app.open());
  await win.locator('#dlg button', { hasText: 'Open download page' }).waitFor({ timeout: 15000 });
  assert.match(await win.locator('#dlg .dlg-body').innerText(), /built-in converter could not read this DWG[\s\S]*Install the free ODA File Converter/);
  await win.locator('#dlg button', { hasText: 'OK' }).click();
  await bounded(failing, 5000, 'open()');
  await prefs('auto');
  const av = await win.evaluate(() => window.api.dwgAvailable());
  assert.equal(av.engine, 'oda', JSON.stringify(av));
  assert.equal(av.version, 'ODA File Converter 99.1.0');
  await bounded(win.evaluate(() => window.app.open()), 15000, 'open()');
  await win.waitForFunction(() => window.app.file.name === 'truncated.dwg', null, { timeout: 15000 });
  assert.deepEqual(await win.evaluate(() => window.app.doc.entities.map((e) => [e.type, e.layer])), [['LINE', 'ODA']]);
  await win.evaluate(() => window.api.dwgSetConfig({ mode: 'auto', odaPath: '' })); // leave the user's settings as found

  setStep('no renderer errors');
  assert.deepEqual(errors, []);
  console.log('draw electron e2e: OK');
} catch (err) {
  console.error(`draw electron e2e FAILED at step "${step}":`, err.message);
  try {
    const w = await app.firstWindow();
    console.error('state:', JSON.stringify(await w.evaluate(() => ({ file: window.app.file, n: window.app.doc.entities.length, dlg: document.getElementById('dlg').open ? document.getElementById('dlg').innerText : null, toast: document.getElementById('toast').innerText }))));
  } catch { /* ignore */ }
  process.exitCode = 1;
} finally {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
