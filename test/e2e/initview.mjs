#!/usr/bin/env node
// Browser end-to-end test of opening a drawing on its saved view (VPORT *Active); same harness as run.mjs.
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

  const dxf = [
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'VPORT', '70', '1',
    '0', 'VPORT', '2', '*Active', '70', '0', '12', '50', '22', '50', '16', '0', '26', '0', '36', '1', '17', '0', '27', '0', '40', '120', '41', '1.5', '51', '0',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...[[0, 0, 100, 0], [100, 0, 100, 100], [100, 100, 0, 100], [0, 100, 0, 0], [5000, 5000, 5001, 5000]]
      .flatMap(([a, b, c, d]) => ['0', 'LINE', '8', '0', '10', a, '20', b, '30', '0', '11', c, '21', d, '31', '0'].map(String)),
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const chooser = new Promise((r) => page.once('filechooser', r));
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'initview.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from(dxf) });

  step = 'opens on the saved view';
  await page.waitForFunction(() => window.app.file.name === 'initview.dxf' && window.app.doc.entities.length === 5, null, { timeout: 8000 });
  const state = () => page.evaluate(() => { const v = window.app.vp.view; return { cx: v.cx, cy: v.cy, zoom: v.zoom, h: v.height }; });
  let s = await state();
  assert.ok(Math.abs(s.cx - 50) < 1 && Math.abs(s.cy - 50) < 1, `centre ${s.cx},${s.cy}`);
  assert.ok(100 * s.zoom > s.h / 2, `square spans ${100 * s.zoom}px of ${s.h}`);

  step = 'ZE shows both';
  await page.locator('#cmd').fill('ZE'); await page.locator('#cmd').press('Enter');
  await page.waitForFunction(() => window.app.vp.view.zoom < 0.5, null, { timeout: 3000 });
  s = await state();
  assert.ok(Math.abs(s.cx - 2500) < 5 && s.zoom * 5000 <= s.h, `ZE view ${JSON.stringify(s)}`);

  assert.deepEqual(problems, []);
  console.log('initview e2e: OK');
} catch (err) {
  console.error(`initview e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
