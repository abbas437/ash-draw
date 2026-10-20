#!/usr/bin/env node
// Browser end-to-end test: a DXF cut short (no ENDSEC / EOF) asks before opening (Open anyway / Cancel); opened anyway,
// the open notice says so and Save does not overwrite the original (it offers Save as a new file). Harness as savedspace.mjs.
// Uses the browser fallback of window.api (shim.js): writeFile rejects (a Save that tried it would report "Save failed"),
// Save as downloads the DXF.
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

  // the basic fixture cut two-thirds through ENTITIES (no ENDSEC, no EOF), opened like a file from disk (with a path)
  const open = (name) => page.evaluate(async (name) => {
    const t = await (await fetch('/test/fixtures/basic_r2000.dxf')).text();
    const a = t.indexOf('ENTITIES'), b = t.indexOf('ENDSEC', a);
    const cut = t.indexOf('\n', a + Math.floor((b - a) * 2 / 3)) + 1;
    window.__open = window.app.loadFile({ path: `/fake/${name}`, name, bytes: new TextEncoder().encode(t.slice(0, cut)) });
  }, name);
  const dialog = async (title) => {
    const d = page.locator('dialog[open]').filter({ has: page.locator('h2', { hasText: title }) });
    await d.waitFor({ timeout: 10000 });
    return d;
  };

  step = 'Cancel: the drawing is not opened';
  const tabs0 = await page.evaluate(() => window.app.tabs.length);
  await open('cut1.dxf');
  let d = await dialog('Incomplete DXF file');
  assert.match(await d.innerText(), /This DXF file is incomplete \(it ends inside ENTITIES without ENDSEC\/EOF; \d+ objects? read\)\. It may have been cut by a download or e-mail\./);
  await d.getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => window.__open);
  assert.equal(await page.evaluate(() => window.app.tabs.filter((t) => t.file.name === 'cut1.dxf').length), 0);
  assert.ok(await page.evaluate((n) => window.app.tabs.length === n, tabs0));

  step = 'Open anyway: the open notice says the file is incomplete';
  await open('cut2.dxf');
  d = await dialog('Incomplete DXF file');
  await d.getByRole('button', { name: 'Open anyway' }).click();
  d = await dialog('Opened with limitations');
  assert.match(await d.innerText(), /This DXF file is incomplete .* the original file is kept as it is/s);
  await d.getByRole('button', { name: 'OK' }).click();
  await page.evaluate(() => window.__open);
  assert.equal(await page.evaluate(() => window.app.active.file.path), '/fake/cut2.dxf');

  step = 'Save does not overwrite the original: it offers Save as a new file';
  page.evaluate(() => { window.__save = window.app.save(); });
  d = await dialog('Save as a new file');
  assert.deepEqual(await d.locator('button').allInnerTexts(), ['Save as new file…', 'Cancel'], 'no "overwrite" choice');
  await d.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => window.__save), false);
  page.evaluate(() => { window.__save = window.app.save(); });
  d = await dialog('Save as a new file');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), d.getByRole('button', { name: 'Save as new file…' }).click()]);
  const text = await fs.readFile(await dl.path(), 'latin1');
  assert.match(text, /\n\s*EOF\s*$/, 'the copy is a complete DXF');
  await page.evaluate(() => window.__save);
  assert.equal(await page.locator('dialog[open]').count(), 0, 'no "Save failed" (writeFile was not tried)');

  assert.deepEqual(problems, []);
  console.log('incomplete e2e: OK');
} catch (err) {
  console.error(`incomplete e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
