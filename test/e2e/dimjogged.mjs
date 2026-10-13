#!/usr/bin/env node
// Browser end-to-end test of DIMJOGGED (jogged radius dimension): pick an arc, override centre, location, jog, undo; same harness as run.mjs.
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
  const clickWorld = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };
  const S = 10 * Math.SQRT1_2;

  step = 'A 10,0 / 7.07,7.07 / 0,10: one 90 degree arc of radius 10 about the origin';
  for (const s of ['A', '10,0', `${S},${S}`, '0,10', 'Z', 'E']) await typeCmd(s);
  const arcs = (await ents()).filter((e) => e.type === 'ARC');
  assert.equal(arcs.length, 1);
  assert.ok(Math.abs(arcs[0].r - 10) < 1e-6, `r = ${arcs[0].r}`);

  step = 'DIMJOGGED, pick the arc, override centre, dimension line location, jog: one jogged radius dimension';
  await typeCmd('DJO');
  assert.equal(await page.evaluate(() => window.app.toolId), 'dimjogged');
  await clickWorld(S, S);
  for (const s of ['3,1', '9.19,9.19', '6,5']) await typeCmd(s);
  const dims = (await ents()).filter((e) => e.type === 'DIMENSION');
  assert.equal(dims.length, 1);
  assert.equal(dims[0].def.kind, 'jogged');
  assert.equal(dims[0].dimText, 'R10');
  assert.ok(Math.abs(dims[0].measurement - 10) < 1e-6, `measurement ${dims[0].measurement}`);
  assert.ok(Math.abs(dims[0].def.chord.x - S) < 1e-6 && Math.abs(dims[0].def.chord.y - S) < 1e-6, 'chord point on the arc');
  assert.ok(Math.abs(dims[0].def.override.x - 3) < 1e-9 && Math.abs(dims[0].def.override.y - 1) < 1e-9, 'override centre');
  const blk = await page.evaluate((n) => window.app.doc.blocks.get(n)?.entities.filter((g) => g.type === 'LINE').length ?? 0, dims[0].block);
  assert.equal(blk, 3, 'radial segment, jog and segment to the override centre');

  step = 'U: one undo step removes the dimension and keeps the arc';
  await typeCmd('U');
  const after = await ents();
  assert.equal(after.filter((e) => e.type === 'DIMENSION').length, 0);
  assert.equal(after.filter((e) => e.type === 'ARC').length, 1);

  assert.deepEqual(problems, []);
  console.log('dimjogged e2e: OK');
} catch (err) {
  console.error(`dimjogged e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
