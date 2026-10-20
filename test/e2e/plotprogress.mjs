#!/usr/bin/env node
// Browser end-to-end test: Plot to PDF of a large generated drawing shows the progress toast (percentage + Cancel) once the
// export outlasts app.plotProgressDelayMs (lowered here from 1 s); Cancel leaves no download, no warnings box, no error box.
// Harness as incomplete.mjs.
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
  let body;
  try { body = await fs.readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
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

  // a drawing big enough that the plot outlasts the (lowered) delay: 300000 lines
  const N = 300000;
  await page.evaluate(async (N) => {
    const parts = ['0\nSECTION\n2\nENTITIES'];
    for (let i = 0; i < N; i++) parts.push(`0\nLINE\n8\n0\n10\n${i % 200}\n20\n${Math.floor(i / 200)}\n11\n${(i % 200) + 0.7}\n21\n${Math.floor(i / 200) + 0.4}`);
    parts.push('0\nENDSEC\n0\nEOF\n');
    await window.app.loadFile({ path: '/fake/big.dxf', name: 'big.dxf', bytes: new TextEncoder().encode(parts.join('\n')) });
    window.app.plotProgressDelayMs = 50;
  }, N);
  assert.ok(await page.evaluate(() => window.app.doc.entities.length) >= N, 'the big drawing is open');

  let downloads = 0;
  page.on('download', () => { downloads++; });
  const startPlot = async () => {
    await page.locator('#menubar .menu > button', { hasText: 'File' }).click();
    await page.locator('#menubar .drop button', { hasText: 'Plot to PDF…' }).click();
    await page.locator('#dlg[open]').waitFor({ timeout: 5000 });
    await page.locator('#dlg button.primary').click();
  };

  step = 'Cancel while plotting: progress toast with %, then no download, no box';
  await startPlot();
  const toast = page.locator('#toast.busy');
  await toast.waitFor({ timeout: 10000 });
  assert.match(await toast.innerText(), /Plotting… \d+%/);
  await toast.locator('.toast-cancel').click();
  await page.waitForFunction(() => /Plot cancelled\./.test(document.getElementById('toast').textContent), null, { timeout: 10000 });
  await page.waitForTimeout(1500);
  assert.equal(downloads, 0, 'no file is delivered');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'no warnings or error box');
  assert.equal(await page.locator('#toast.busy').count(), 0, 'the progress toast is gone');

  step = 'Not cancelled: the same plot completes and downloads';
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await startPlot();
  await dl;
  assert.equal(await page.locator('#toast.busy').count(), 0, 'the progress toast closes when the export ends');
  assert.equal(await page.locator('dialog[open]').count(), 0);

  assert.deepEqual(problems, []);
  console.log("plotprogress e2e: OK");
} catch (err) {
  console.error(`plotprogress e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
