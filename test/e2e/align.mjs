#!/usr/bin/env node
// Browser end-to-end test of ALIGN (AL) typed at the command line like a user; same harness as run.mjs.
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
  const ents = () => page.evaluate(() => JSON.parse(JSON.stringify([...window.app.doc.entities.values?.() ?? window.app.doc.entities])));
  const toolId = () => page.evaluate(() => window.app.toolId);
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
  const corners = (e) => e.vertices.map((v) => [+v.x.toFixed(6), +v.y.toFixed(6)]);
  const sides = (e) => e.vertices.map((v, i) => { const w = e.vertices[(i + 1) % e.vertices.length]; return Math.hypot(w.x - v.x, w.y - v.y); });

  step = 'REC 0,0 10,10: one 10x10 rectangle at the origin';
  for (const s of ['REC', '0,0', '10,10']) await typeCmd(s);
  const all0 = await ents();
  assert.equal(all0.length, 1);
  const rect0 = all0[0];
  assert.equal(rect0.type, 'LWPOLYLINE'); assert.equal(rect0.vertices.length, 4);
  assert.deepEqual(sides(rect0).map((x) => +x.toFixed(9)), [10, 10, 10, 10]);
  const id = rect0.id;

  const align = async (pts, answer) => {
    await typeCmd('AL');
    assert.equal(await toolId(), 'align');
    await page.evaluate((i) => window.app.vp.setSelection([i]), id);
    await typeCmd(''); // Enter ends the selection
    for (const s of pts) await typeCmd(s);
    await typeCmd(answer);
    assert.equal(await toolId(), 'select', 'ALIGN ends after the scale prompt');
    const all = await ents();
    assert.equal(all.length, 1, 'ALIGN transforms in place');
    return all[0];
  };
  const undoRestores = async () => {
    await typeCmd('U');
    const [e] = await ents();
    assert.deepEqual(corners(e), corners(rect0), 'one U restores the rectangle');
  };
  const hasCorner = (e, x, y) => e.vertices.some((v) => near(v.x, x) && near(v.y, y));

  step = 'AL, select, 0,0 100,100 10,0 100,120, Enter (No): turned 90 deg, corner at 100,100, side 10';
  {
    const e = await align(['0,0', '100,100', '10,0', '100,120'], '');
    assert.equal(e.id, id);
    for (const [x, y] of [[100, 100], [100, 110], [90, 110], [90, 100]]) assert.ok(hasCorner(e, x, y), `corner ${x},${y} in ${JSON.stringify(corners(e))}`);
    for (const L of sides(e)) assert.ok(near(L, 10), `side ${L}`);
    await undoRestores();
  }

  step = 'AL, select, 0,0 100,100 10,0 100,140, Y: turned 90 deg and scaled x4, side 40';
  {
    const e = await align(['0,0', '100,100', '10,0', '100,140'], 'Y');
    for (const [x, y] of [[100, 100], [100, 140], [60, 140], [60, 100]]) assert.ok(hasCorner(e, x, y), `corner ${x},${y} in ${JSON.stringify(corners(e))}`);
    for (const L of sides(e)) assert.ok(near(L, 40), `side ${L}`);
    await undoRestores();
  }

  step = 'AL, select, 0,0 5,5, Enter at the second source point: a move only';
  {
    await typeCmd('AL');
    await page.evaluate((i) => window.app.vp.setSelection([i]), id);
    for (const s of ['', '0,0', '5,5', '']) await typeCmd(s);
    assert.equal(await toolId(), 'select');
    const [e] = await ents();
    assert.deepEqual(corners(e), corners(rect0).map(([x, y]) => [x + 5, y + 5]));
    await undoRestores();
  }

  assert.deepEqual(problems, []);
  console.log('align e2e: OK');
} catch (err) {
  console.error(`align e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
