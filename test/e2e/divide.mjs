#!/usr/bin/env node
// Browser end-to-end test of DIVIDE and MEASUREPOINTS typed at the command line like a user; same harness as run.mjs.
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
  const clickWorld = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };
  const ents = () => page.evaluate(() => JSON.parse(JSON.stringify([...window.app.doc.entities.values?.() ?? window.app.doc.entities])));
  const toolId = () => page.evaluate(() => window.app.toolId);
  const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
  const ids = (list) => list.map((e) => e.id).sort();

  step = 'draw a line 0,0 -> 10,0 and zoom to it';
  await typeCmd('L'); await typeCmd('0,0'); await typeCmd('10,0'); await page.keyboard.press('Escape');
  await typeCmd('Z'); await typeCmd('E');
  await page.keyboard.press('Escape');
  const before = await ents();
  assert.equal(before.filter((e) => e.type === 'LINE').length, 1);

  step = 'DIV, pick the line, 4: three POINTs at 2.5, 5, 7.5';
  await typeCmd('DIV'); await clickWorld(1, 0); await typeCmd('4');
  assert.equal(await toolId(), 'select', 'DIVIDE has ended');
  let fresh = (await ents()).filter((e) => !before.some((b) => b.id === e.id));
  assert.equal(fresh.length, 3); assert.ok(fresh.every((e) => e.type === 'POINT'));
  assert.deepEqual(fresh.map((e) => e.p.x).sort((a, b) => a - b), [2.5, 5, 7.5]);

  step = 'one U removes all three points';
  await typeCmd('U');
  assert.deepEqual(ids(await ents()), ids(before));

  step = 'ME, pick the line near its right end, 3: points at 7, 4, 1';
  await typeCmd('ME'); await clickWorld(9, 0); await typeCmd('3');
  assert.equal(await toolId(), 'select', 'MEASUREPOINTS has ended');
  fresh = (await ents()).filter((e) => !before.some((b) => b.id === e.id));
  assert.equal(fresh.length, 3); assert.ok(fresh.every((e) => e.type === 'POINT'));
  const xs = fresh.map((e) => e.p.x).sort((a, b) => a - b);
  [1, 4, 7].forEach((x, i) => assert.ok(near(xs[i], x), `${xs}`));
  await typeCmd('U');
  assert.deepEqual(ids(await ents()), ids(before));

  assert.deepEqual(problems, []);
  console.log('divide e2e: OK');
} catch (err) {
  console.error(`divide e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
