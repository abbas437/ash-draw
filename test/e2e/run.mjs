#!/usr/bin/env node
// Browser end-to-end test of the draw app (headless Chromium via playwright-core, served over http).
// Uses the browser fallback of window.api (shim.js); Electron-only features (DWG) are covered elsewhere.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.E2E_SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  const count = () => page.evaluate(() => window.app.doc.entities.length);
  const types = () => page.evaluate(() => window.app.doc.entities.map((e) => e.type));
  const clickWorld = async (x, y, opts = {}) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y, opts);
  };
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };

  step = 'ui present';
  assert.ok(await page.locator('#menubar .menu').count() >= 4);
  assert.ok(await page.locator('#tools button').count() >= 20);

  step = 'draw a line with the mouse';
  await page.evaluate(() => window.app.vp.zoomBy(0.0001)); // tiny zoom so clicks map to large world units
  await page.evaluate(() => { window.app.vp.view = { ...window.app.vp.view, cx: 50, cy: 25, zoom: 8 }; window.app.vp.render(); });
  await page.click('#tools button[data-tool=line]');
  await clickWorld(0, 0); await clickWorld(40, 0); await clickWorld(40, 30);
  await page.keyboard.press('Escape');
  assert.deepEqual(await types(), ['LINE', 'LINE']);

  step = 'typed coordinates';
  await typeCmd('rec'); await typeCmd('60,0'); await typeCmd('@30,20');
  assert.equal((await types()).filter((t) => t === 'LWPOLYLINE').length, 1);
  await typeCmd('c'); await typeCmd('75,10'); await typeCmd('6');
  assert.equal((await types()).filter((t) => t === 'CIRCLE').length, 1);
  const circle = await page.evaluate(() => window.app.doc.entities.find((e) => e.type === 'CIRCLE'));
  assert.deepEqual([circle.c.x, circle.c.y, circle.r], [75, 10, 6]);

  step = 'undo / redo';
  const n = await count();
  await page.keyboard.press('Control+z');
  assert.equal(await count(), n - 1);
  await page.keyboard.press('Control+y');
  assert.equal(await count(), n);

  step = 'select with window, move by typed offset';
  await page.click('#tools button[data-tool=select]');
  const a = await page.evaluate(() => window.app.vp.toScreen({ x: 55, y: -5 })), b = await page.evaluate(() => window.app.vp.toScreen({ x: 95, y: 28 }));
  const box = await page.locator('#cv').boundingBox();
  await page.mouse.move(box.x + a.x, box.y + a.y); await page.mouse.down(); await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.app.vp.selection.size), 2); // rectangle + circle fully inside
  await typeCmd('m'); await typeCmd('0,0'); await typeCmd('@0,-10');
  const rect = await page.evaluate(() => window.app.doc.entities.find((e) => e.type === 'LWPOLYLINE'));
  assert.equal(rect.vertices[0].y, -10);

  step = 'erase and layers';
  await page.keyboard.press('Control+a');
  assert.equal(await page.evaluate(() => window.app.vp.selection.size), await count());
  await page.click('#layer-add'); await page.locator('#dlg input').fill('DUCTS'); await page.locator('#dlg button.primary').click();
  assert.ok(await page.evaluate(() => window.app.doc.layers.has('DUCTS')));
  await page.locator('#cv').focus();
  await page.keyboard.press('Delete');
  assert.equal(await count(), 0);
  await page.keyboard.press('Control+z');
  assert.ok(await count() > 0);

  step = 'open a fixture DXF through the file chooser';
  const fixtures = ['hatch_r2000.dxf', 'blocks_r2000.dxf', 'text_r2000.dxf', 'dims_r2000.dxf', 'r2007_ac1021.dxf'];
  for (const f of fixtures) {
    page.once('dialog', (d) => d.accept());
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    // the unsaved-changes dialog may appear first
    if (await page.locator('#dlg[open]').count()) await page.locator('#dlg button', { hasText: "Don't save" }).click();
    (await chooser).setFiles(path.join(ROOT, 'test', 'fixtures', f));
    await page.waitForFunction((name) => window.app.file.name === name, f, { timeout: 8000 });
    assert.ok(await count() > 0, `${f} opened empty`);
    await page.waitForTimeout(100);
    await shot(`open_${f.replace('.dxf', '')}`);
    // the canvas must contain drawn pixels other than the background
    const painted = await page.evaluate(() => {
      const c = document.getElementById('cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) n++;
      return n;
    });
    assert.ok(painted > 200, `${f}: canvas looks blank (${painted})`);
  }

  step = 'binary DXF is rejected with a message';
  {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    (await chooser).setFiles(path.join(ROOT, 'test', 'fixtures', 'binary_sentinel.dxf'));
    await page.waitForSelector('#dlg[open]');
    assert.match(await page.locator('#dlg').innerText(), /binary DXF/i);
    await page.locator('#dlg button.primary').click();
  }

  step = 'export SVG, PDF, PNG and save DXF produce downloads';
  for (const [menuItem, ext, check] of [['Export SVG…', 'svg', (b) => b.toString('utf8').startsWith('<?xml') || b.toString('utf8').includes('<svg')], ['Export PNG image…', 'png', (b) => b[1] === 0x50 && b[2] === 0x4e], ['Save as DXF…', 'dxf', (b) => b.toString('utf8').includes('SECTION')]]) {
    const dl = page.waitForEvent('download');
    await page.locator('#menubar .menu > button', { hasText: menuItem.startsWith('Save') ? 'File' : 'File' }).click();
    await page.locator('#menubar .drop button', { hasText: menuItem }).click();
    const d = await dl;
    const p = path.join(os.tmpdir(), `ash-e2e-${process.pid}.${ext}`);
    await d.saveAs(p);
    assert.ok(check(await fs.readFile(p)), `${ext} content`);
    await fs.rm(p, { force: true });
  }
  {
    await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
    await page.locator('#menubar .drop button', { hasText: 'Export PDF…' }).click();
    const dl = page.waitForEvent('download');
    await page.locator('#dlg button.primary').click();
    const d = await dl;
    const p = path.join(os.tmpdir(), `ash-e2e-${process.pid}.pdf`);
    await d.saveAs(p);
    assert.equal((await fs.readFile(p)).subarray(0, 4).toString(), '%PDF');
    await fs.rm(p, { force: true });
  }

  step = 'csp';
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(problems, []);
  console.log('draw e2e: OK');
} catch (err) {
  console.error(`draw e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
