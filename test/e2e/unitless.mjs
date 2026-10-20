#!/usr/bin/env node
// Browser end-to-end test of a unitless drawing ($INSUNITS 0): the first measure asks once what a unit is, the answer
// labels the readout and scales a 1 : N plot; Cancel ends the command. Same harness as measuretab.mjs.
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };
  const panelText = () => page.evaluate(() => document.querySelector('#measure-panel')?.textContent ?? null);
  const dialogText = () => page.evaluate(() => { const d = document.getElementById('dlg'); return d?.open ? d.textContent : null; });
  const install = (name, units) => page.evaluate(async ([n, u]) => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    doc.units = u;
    M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    window.app.installDoc(doc, { path: null, name: n, format: 'dxf' });
  }, [name, units]);
  const measure = async () => { await typeCmd('0,0'); await typeCmd('5,0'); await page.waitForSelector('#measure-panel'); };
  const plotWarnings = async () => { // 1 : 1 on a page fitted to the drawing; the warnings message (null when none)
    page.evaluate(() => { window.app.exportPdf(); });
    await page.waitForSelector('#dlg[open] select[name=pageSize]');
    await page.locator('#dlg select[name=pageSize]').selectOption('fit');
    await page.locator('#dlg input[name=fit]').setChecked(false);
    await page.locator('#dlg input[name=scale]').fill('1');
    const dl = page.waitForEvent('download');
    await page.locator('#dlg button.primary').click();
    await dl;
    await page.waitForTimeout(300);
    const t = await dialogText();
    if (t) await page.locator('#dlg button.primary').click();
    return t;
  };

  step = 'measure in a unitless drawing asks once; Metre';
  await install('nounits.dxf', 0);
  await typeCmd('DIST');
  await page.waitForFunction(() => document.getElementById('dlg')?.open, null, { timeout: 5000 });
  assert.match(await dialogText(), /This drawing has no units set\. Treat 1 drawing unit as:/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Millimetre'); // preselected
  await page.getByRole('button', { name: 'Metre', exact: true }).click();
  await measure();
  assert.match(await panelText(), /Distance = 5 m\b/);
  assert.match(await panelText(), /Units: m\b/);
  assert.match(await page.evaluate(() => document.getElementById('units').textContent), /unitless \(taken as m\)/);

  step = 'a second measure does not ask again';
  await page.keyboard.press('Escape');
  await typeCmd('DIST');
  await page.waitForTimeout(300);
  assert.equal(await dialogText(), null);
  await measure();
  assert.match(await panelText(), /Distance = 5 m\b/);
  await page.evaluate(() => window.app.setTool('select'));

  step = 'a 1 : 1 plot takes 1 unit as 1000 mm (10 m does not fit a 200 inch page)';
  assert.equal(await plotWarnings(), 'PDF exported with warningsDrawing too large for one PDF page at the requested scale; scaled down to 1:1.976OK'); // 1:N in real millimetres per paper millimetre (1 unit taken as 1 m)

  step = 'the same plot of a millimetre drawing fits (control)';
  await install('mm.dxf', 4);
  assert.equal(await plotWarnings(), null);

  step = 'another unitless tab asks again; Cancel ends the measure';
  await install('nounits2.dxf', 0);
  await typeCmd('DIST');
  await page.waitForFunction(() => document.getElementById('dlg')?.open, null, { timeout: 5000 });
  await page.locator('#dlg button', { hasText: 'Cancel' }).click();
  await page.waitForFunction(() => window.app.toolId === 'select', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.app.active.assumedUnits), undefined);

  step = 'Cancel of a scaled plot aborts the plot (no download)';
  page.evaluate(() => { window.app.exportPdf(); });
  await page.waitForSelector('#dlg[open] select[name=pageSize]');
  await page.locator('#dlg input[name=fit]').setChecked(false);
  let downloaded = false;
  page.once('download', () => { downloaded = true; });
  await page.locator('#dlg button.primary').click();
  await page.waitForFunction(() => /no units set/.test(document.getElementById('dlg')?.textContent ?? ''), null, { timeout: 5000 });
  await page.locator('#dlg button', { hasText: 'Cancel' }).click();
  await page.waitForTimeout(500);
  assert.equal(downloaded, false);

  assert.deepEqual(problems, []);
  console.log('unitless e2e: OK');
} catch (err) {
  console.error(`unitless e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
