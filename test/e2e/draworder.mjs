#!/usr/bin/env node
// Browser end-to-end test of View > Customize tools (hide, move, Quick Access, Compact/Expanded, persist, reset); same harness as run.mjs.
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
  const toolId = () => page.evaluate(() => window.app.toolId);
  const order = () => page.evaluate(() => window.app.doc.entities.map((e) => e.id));

  step = 'two overlapping SOLIDs: red (first) and blue (second, drawn on top)';
  const ids = await page.evaluate(async () => {
    const { addEntities } = await import('/src/core/edit.js');
    const { makeSolid } = await import('/src/core/model.js');
    const sq = (x, y) => [{ x, y }, { x: x + 10, y }, { x, y: y + 10 }, { x: x + 10, y: y + 10 }];
    const made = addEntities(window.app.session, [makeSolid(sq(0, 0), { color: 1 }), makeSolid(sq(5, 5), { color: 5 })]);
    window.app.vp.zoomExtents();
    return made.map((e) => e.id);
  });
  const sample = async () => {
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const vp = window.app.vp;
      vp.render?.();
      const s = vp.toScreen({ x: 7.5, y: 7.5 }), d = vp.dpr || 1;
      const [r, g, b] = vp.canvas.getContext('2d').getImageData(Math.round(s.x * d), Math.round(s.y * d), 1, 1).data;
      return r > 150 && b < 100 ? 'red' : b > 150 && r < 100 ? 'blue' : `rgb(${r},${g},${b})`;
    });
  };
  assert.equal(await sample(), 'blue', 'the later solid is on top before DRAWORDER');

  step = 'DR, select the red solid, Enter, F: red comes to front';
  await typeCmd('DR');
  assert.equal(await toolId(), 'draworder');
  await page.evaluate((i) => window.app.vp.setSelection([i]), ids[0]);
  await typeCmd(''); // Enter ends the selection
  await typeCmd('F');
  assert.equal(await toolId(), 'select', 'DRAWORDER ends after the option');
  assert.deepEqual(await order(), [ids[1], ids[0]]);
  assert.equal(await sample(), 'red', 'the overlap shows the first shape after Front');

  step = 'U: the second shape is on top again';
  await typeCmd('U');
  assert.deepEqual(await order(), ids);
  assert.equal(await sample(), 'blue', 'the overlap shows the second shape after undo');

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('draworder e2e: OK');
} catch (err) {
  console.error(`draworder e2e FAILED at step: ${step}\n${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
