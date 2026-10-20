#!/usr/bin/env node
// Browser end-to-end test of the Layers panel Columns toggle (linetype, lineweight, transparency); same harness as layers.mjs.
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
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#layers .layer')].map((r) => r.dataset.layer));
  step = 'build: DASHED layer, 0.35 mm layer, 60 % transparent layer';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    M.addLayer(doc, { name: 'DASH', linetype: 'DASHED' });
    M.addLayer(doc, { name: 'THICK', lineweight: 0.35 });
    M.addLayer(doc, { name: 'TRANS', alpha: M.parseTransparency('60').alpha });
    window.app.installDoc(doc, { path: null, name: 'cols.dxf', format: 'dxf' });
    window.app.setSidePanel?.(true);
  });
  await page.waitForSelector('#layers .layer[data-layer="TRANS"]');
  const cell = (n, c) => page.locator(`#layers .layer[data-layer="${n}"] [data-col="${c}"]`);

  step = 'compact by default';
  assert.equal(await page.locator('#layers [data-col]').count(), 0);
  assert.equal(await page.locator('#layer-cols').getAttribute('aria-pressed'), 'false');

  step = 'Columns on: values in the right rows';
  await page.locator('#layer-cols').click();
  assert.equal(await cell('DASH', 'linetype').textContent(), 'DASHED');
  assert.equal(await cell('THICK', 'lineweight').textContent(), '0.35 mm');
  assert.equal(await cell('TRANS', 'transparency').textContent(), '60%');
  assert.equal(await cell('DASH', 'lineweight').textContent(), 'Default');
  assert.equal(await cell('THICK', 'transparency').textContent(), '0%');
  assert.equal(await page.locator('#layer-cols').getAttribute('aria-pressed'), 'true');

  step = 'remembered after a reload';
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => document.querySelectorAll('#layers [data-col]').length > 0, null, { timeout: 5000 });

  step = 'Columns off: hidden, and remembered';
  await page.locator('#layer-cols').click();
  assert.equal(await page.locator('#layers [data-col]').count(), 0);
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForSelector('#layers .layer');
  assert.equal(await page.locator('#layers [data-col]').count(), 0);

  assert.deepEqual(problems, []);
  console.log('layercols e2e: OK');
} catch (err) {
  console.error(`layercols e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

