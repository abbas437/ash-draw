#!/usr/bin/env node
// Runs the REAL Electron app (needs the electron binary and a display, e.g. xvfb-run) against a sample DWG.
// env: ASH_LIBREDWG_DIR (folder with dwg2dxf/dxf2dwg), ASH_E2E_DWG (path to a .dwg), ELECTRON_BIN (optional)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const electronBin = process.env.ELECTRON_BIN || require('electron');
const dwgIn = process.env.ASH_E2E_DWG;
assert.ok(dwgIn, 'set ASH_E2E_DWG to a sample .dwg');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-draw-e2e-'));
let step = 'launch';
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
  await win.waitForFunction(() => window.app && window.app.doc, null, { timeout: 20000 });

  step = 'opened the DWG given on the command line';
  await win.waitForFunction(() => window.app.file.format === 'dwg' && window.app.doc.entities.length > 0, null, { timeout: 30000 });
  const info = await win.evaluate(() => ({ n: window.app.doc.entities.length, name: window.app.file.name, electron: window.api.isElectron }));
  assert.ok(info.electron);
  console.log('opened', info.name, info.n, 'objects');
  await win.waitForTimeout(300);
  if (process.env.E2E_SHOTS) await win.screenshot({ path: path.join(process.env.E2E_SHOTS, 'electron_dwg.png') });

  step = 'save as DXF (native dialog stubbed)';
  const dxfOut = path.join(tmp, 'out.dxf');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, dxfOut);
  await win.evaluate(() => window.app.saveAs('dxf'));
  await win.waitForFunction(() => window.app.file.format === 'dxf', null, { timeout: 10000 });
  assert.match((await fs.readFile(dxfOut, 'utf8')).slice(0, 200), /SECTION/);

  step = 'plain Save now overwrites the DXF without a dialog';
  const before = (await fs.stat(dxfOut)).mtimeMs;
  await win.waitForTimeout(50);
  await win.evaluate(() => window.app.save());
  await win.waitForTimeout(300);
  assert.ok((await fs.stat(dxfOut)).mtimeMs >= before);

  step = 'Save over a file that would lose content asks first';
  await win.evaluate(() => { window.app.doc.skipped = { XLINE: 1 }; });
  const saving = win.evaluate(() => window.app.save());
  await win.waitForSelector('#dlg[open] h2');
  assert.match(await win.locator('#dlg').innerText(), /Overwrite the original file\?[\s\S]*1 XLINE/);
  await win.locator('#dlg button', { hasText: 'Cancel' }).click();
  assert.equal(await saving, false);
  await win.evaluate(() => { window.app.doc.skipped = {}; });

  step = 'save as DWG, verified by read-back';
  const dwgOut = path.join(tmp, 'out.dwg');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, dwgOut);
  const done = win.evaluate(() => window.app.saveAs('dwg'));
  await win.locator('#dlg button', { hasText: 'Save as DWG' }).click();
  await win.waitForSelector('#dlg[open] h2', { timeout: 60000 });
  const title = await win.locator('#dlg h2').innerText();
  console.log('DWG save dialog:', title, '|', (await win.locator('#dlg .dlg-body').innerText()).slice(0, 160).replace(/\n/g, ' '));
  await win.locator('#dlg button.primary').click();
  await done;
  assert.equal((await fs.readFile(dwgOut)).subarray(0, 4).toString(), 'AC10');

  step = 'Print (Ctrl+P) prints the plot from a hidden PDF window, not the main window';
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

  step = 'Plot to PDF: window picked by two typed corners, 1:50 on A3';
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

  step = 'no renderer errors';
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
