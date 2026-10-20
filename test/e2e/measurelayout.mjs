#!/usr/bin/env node
// Browser end-to-end test of MEASUREGEOM on a layout sheet: a distance inside a 1:50 model viewport reports the model
// distance first and the sheet distance second; outside the viewport only the sheet distance. Same harness as run.mjs.
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
  const panelText = () => page.evaluate(() => document.querySelector('#measure-panel')?.textContent ?? null);
  const click = async (x, y) => {
    const box = await page.locator('#stage canvas').first().boundingBox();
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    await page.mouse.click(box.x + s.x, box.y + s.y);
  };

  step = 'open layouts_r2000.dxf on Layout1 (model viewport 300 x 100 at 1:50)';
  await page.evaluate(async () => {
    const { readDxf } = await import('/src/core/dxfRead.js');
    const bytes = new Uint8Array(await (await fetch('/test/fixtures/layouts_r2000.dxf')).arrayBuffer());
    const doc = readDxf(bytes);
    doc.header.luprec = 2;
    window.app.installDoc(doc, { path: null, name: 'layouts.dxf', format: 'dxf' });
  });
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Layout1');
  await page.evaluate(() => { window.app.vp.settings.snap = false; window.app.vp.settings.gridSnap = false; window.app.vp.zoomExtents?.(); window.app.vp.requestRender(); });

  step = 'distance across the 1:50 viewport (paper space): model value first, sheet value second';
  await typeCmd('DIST');
  await click(100, 150); await click(116.2144, 150);
  await page.waitForSelector('#measure-panel');
  const body = await page.evaluate(() => document.querySelector('#measure-panel .mp-body').textContent);
  assert.match(body, /^Distance = 810\.72 mm {2}\(sheet 16\.21 mm, viewport 1:50\)$/m, body);
  assert.match(body, /^Delta X = 810\.72 mm, Delta Y = 0 mm$/m, body);
  assert.match(await page.evaluate(() => document.querySelector('#measure-panel .mp-units').textContent), /Units: mm/);

  step = 'the result panel does not cover the command line or the command history (collapsed or open with F2)';
  const overlaps = () => page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const p = r('#measure-panel');
    const hit = (b) => b && b.width > 0 && !(p.right <= b.left || p.left >= b.right || p.bottom <= b.top || p.top >= b.bottom);
    return { cmd: hit(r('#cmd')), bar: hit(r('#cmdbar')), hist: hit(r('#cmdhist .ch-box')), histH: r('#cmdhist .ch-box')?.height };
  });
  assert.deepEqual({ ...(await overlaps()), histH: 0 }, { cmd: false, bar: false, hist: false, histH: 0 }, 'panel over the command area');
  await page.locator('#cmd').press('F2');
  assert.equal(await page.evaluate(() => document.querySelector('#cmdhist')?.classList.contains('open')), true, 'F2 opens the history');
  assert.deepEqual({ ...(await overlaps()), histH: 0 }, { cmd: false, bar: false, hist: false, histH: 0 }, 'panel over the open history');
  await page.locator('#cmd').press('F2');

  step = 'outside the model viewport: the sheet distance only';
  await typeCmd('DIST');
  await click(100, 50); await click(110, 50);
  await page.waitForFunction(() => /^Distance = 10 mm$/m.test(document.querySelector('#measure-panel .mp-body')?.textContent ?? ''), null, { timeout: 5000 });

  assert.deepEqual(problems, []);
  console.log('measurelayout e2e: OK');
} catch (err) {
  console.error(`measurelayout e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
