#!/usr/bin/env node
// Browser end-to-end test of DIMCENTER (DCE) and CENTERLINE: plain LINEs, one undo step per run; same harness as run.mjs.
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
  const segs = (all) => all.filter((e) => e.type === 'LINE').map((e) => [e.p1.x, e.p1.y, e.p2.x, e.p2.y].map((v) => +v.toFixed(6) + 0));

  step = 'C 5,5 10: one circle';
  for (const s of ['C', '5,5', '10']) await typeCmd(s);
  assert.deepEqual((await ents()).map((e) => e.type), ['CIRCLE']);

  step = 'DCE, pick the circle at 15,5, Enter: two LINEs (the ISO-25 cross, DIMCEN 2.5)';
  await typeCmd('DCE');
  assert.equal(await toolId(), 'dimcenter');
  await typeCmd('15,5');
  assert.equal((await ents()).length, 1, 'marks are added when the command ends');
  await typeCmd('');
  assert.equal(await toolId(), 'select', 'Enter ends DIMCENTER');
  assert.deepEqual(segs(await ents()).sort(), [[2.5, 5, 7.5, 5], [5, 2.5, 5, 7.5]].sort());

  step = 'U removes both lines in one step';
  await typeCmd('U');
  assert.deepEqual((await ents()).map((e) => e.type), ['CIRCLE']);

  step = 'L 0,0 10,0 and L 2,4 12,4, CENTERLINE on both: one LINE y=2 from -2.5 to 14.5';
  for (const s of ['L', '0,0', '10,0', '', 'L', '2,4', '12,4', '']) await typeCmd(s);
  assert.equal((await ents()).length, 3);
  await typeCmd('CENTERLINE');
  assert.equal(await toolId(), 'centerline');
  await typeCmd('5,0');
  await typeCmd('7,4');
  assert.equal(await toolId(), 'select', 'CENTERLINE ends after the second line');
  const all = await ents();
  assert.equal(all.length, 4);
  assert.deepEqual(segs(all).at(-1), [-2.5, 2, 14.5, 2]);

  assert.deepEqual(problems, []);
  console.log('center e2e: OK');
} catch (err) {
  console.error(`center e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
