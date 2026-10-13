#!/usr/bin/env node
// Browser end-to-end test of PICKADD selection: picks add to the selection, Shift+pick removes (AutoCAD PICKADD=2); same harness as run.mjs.
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
  const box = await page.locator('#cv').boundingBox();
  const D = Math.SQRT1_2 * 5; // a point on each circle at 45 deg: on the curve, away from the quadrant grips
  const clickWorld = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };
  const circles = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'CIRCLE').map((e) => ({ id: e.id, x: e.c.x, y: e.c.y })));
  const selected = () => page.evaluate(() => [...window.app.vp.selection]);

  step = 'draw three circles';
  for (const x of [10, 30, 50]) { await typeCmd('c'); await typeCmd(`${x},0`); await typeCmd('5'); }
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const vp = window.app.vp; vp.view = { ...vp.view, cx: 30, cy: 0, zoom: 8 }; vp.setSelection([]); vp.render(); });
  const c0 = await circles();
  assert.equal(c0.length, 3);

  step = 'MOVE: pick three circles one by one, Enter, 0,0 -> 10,0 moves all three';
  await typeCmd('m');
  for (const c of c0) await clickWorld(c.x + D, c.y + D);
  assert.equal((await selected()).length, 3, 'each pick adds to the selection');
  await typeCmd(''); await typeCmd('0,0'); await typeCmd('10,0');
  assert.deepEqual((await circles()).map((c) => c.x), c0.map((c) => c.x + 10), 'all three circles moved');
  assert.equal(await page.evaluate(() => window.app.toolId), 'select');

  step = 'idle Select: click two circles -> both selected';
  const c1 = await circles();
  await page.keyboard.press('Escape');
  await clickWorld(c1[0].x + D, c1[0].y + D); await clickWorld(c1[1].x + D, c1[1].y + D);
  assert.deepEqual((await selected()).sort(), [c1[0].id, c1[1].id].sort(), 'two picks -> two selected');

  step = 'idle Select: Shift+click a selected circle removes it';
  await page.keyboard.down('Shift'); await clickWorld(c1[0].x + D, c1[0].y + D); await page.keyboard.up('Shift');
  assert.deepEqual(await selected(), [c1[1].id], 'Shift+pick removes');

  step = 'idle Select: click empty space clears';
  await clickWorld(c1[1].x, c1[1].y + 20);
  assert.deepEqual(await selected(), [], 'click on empty space clears in idle Select');

  step = 'Escape clears the selection';
  await clickWorld(c1[2].x + D, c1[2].y + D);
  assert.equal((await selected()).length, 1);
  await page.keyboard.press('Escape');
  assert.deepEqual(await selected(), [], 'Escape clears');

  assert.deepEqual(problems, []);
  console.log('pickadd e2e: OK');
} catch (err) {
  console.error(`pickadd e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
