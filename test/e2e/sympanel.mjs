#!/usr/bin/env node
// Browser end-to-end test of the Symbols panel docks (setting 'symbols.dock'): in the side panel, its own column right or
// left of the canvas (resize, fold to a strip), floating, hidden; search and place from the left dock; the dock kept across
// a reload. Screenshots in .scratch/. Uses the browser fallback of window.api (shim.js).
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

  const canvasW = () => page.evaluate(() => document.getElementById('cv').getBoundingClientRect().width);
  const shown = (sel) => page.locator(sel).isVisible();
  const cls = (c) => page.evaluate((k) => document.getElementById('app').classList.contains(k), c);
  const SHOTS = path.join(ROOT, '.scratch');
  const cmd = async (s) => { await page.locator('#cmd').fill(s); await page.locator('#cmd').press('Enter'); };
  const parentId = () => page.evaluate(() => document.getElementById('sym-panel').parentElement.id);
  const inSide = () => page.evaluate(() => !!document.querySelector('#side #sym-panel'));
  const dockTo = async (d) => { await page.locator('#sym-dock-more').click(); await page.locator(`#sym-dock-menu button[data-dock=${d}]`).click(); };
  const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left, w: r.width, right: r.right }; }, sel);
  const canvasNear = (w, tol = 3) => page.waitForFunction(([w0, t]) => Math.abs(document.getElementById('cv').getBoundingClientRect().width - w0) <= t, [w, tol], { timeout: 5000 });
  const inserts = () => page.evaluate(() => window.app.doc.entities.filter((e) => e.type === 'INSERT').length);
  const clickAt = async (fx, fy) => {
    const r = await box('#cv'), top = await page.evaluate(() => document.getElementById('cv').getBoundingClientRect().top), h = await page.evaluate(() => document.getElementById('cv').getBoundingClientRect().height);
    const x = r.x + r.w * fx, y = top + h * fy;
    await page.mouse.move(x - 5, y - 5); await page.mouse.move(x, y); await page.mouse.click(x, y);
  };

  step = 'default: Symbols is a section of the side panel';
  assert.equal(await inSide(), true);
  assert.equal(await shown('#sym-dock'), false);
  const w0 = await canvasW();

  step = 'Dock right: own column between the canvas and the side panel; the canvas narrows by its width';
  await dockTo('right');
  assert.equal(await parentId(), 'sym-dock');
  assert.equal(await inSide(), false, 'the side panel no longer holds Symbols');
  assert.equal(await cls('sym-dock-right'), true);
  await canvasNear(w0 - 280);
  const d1 = await box('#sym-dock'), cv1 = await box('#cv'), sd1 = await box('#side');
  assert.ok(d1.x >= cv1.right - 1 && d1.right <= sd1.x + 1, `between canvas and side ${JSON.stringify([cv1, d1, sd1])}`);
  assert.equal(await shown('#sym-float-close'), true, 'close button');
  assert.ok(await page.locator('#sym-dock .sym-cell').count() > 3, 'grid shown');
  await page.locator('#sym-view-list').click();
  assert.equal(await page.evaluate(() => document.getElementById('sym-panel').classList.contains('view-list')), true, 'List in the dock');
  await page.locator('#sym-view-grid').click();
  await page.screenshot({ path: path.join(SHOTS, 'sympanel-right.png') });

  step = 'drag the inner edge: wider; the chevron folds it to a strip and back';
  const g = await box('#sym-dock-grip');
  const gy = (await page.locator('#sym-dock-grip').boundingBox()).y + 100;
  await page.mouse.move(g.x + 2, gy); await page.mouse.down(); await page.mouse.move(g.x - 60, gy, { steps: 4 }); await page.mouse.up();
  await canvasNear(w0 - 340, 4);
  await page.locator('#sym-dock-fold').click();
  await canvasNear(w0 - 22);
  assert.equal(await shown('#sym-search'), false, 'folded');
  await page.locator('#sym-dock-fold').click();
  await canvasNear(w0 - 340, 4);

  step = 'View menu: Symbols panel: Dock left; search and place a symbol from the left dock';
  await page.locator('#menubar .menu > button', { hasText: /^View$/ }).click();
  await page.locator('#menubar .menu.open .drop button', { hasText: /Symbols panel: Dock left/ }).click();
  assert.equal(await cls('sym-dock-left'), true);
  assert.equal(await parentId(), 'sym-dock');
  const d2 = await box('#sym-dock'), cv2 = await box('#cv'), tl = await box('#tools');
  assert.ok(d2.x >= tl.right - 1 && d2.right <= cv2.x + 1, `between tools and canvas ${JSON.stringify([tl, d2, cv2])}`);
  await canvasNear(w0 - 340, 4);
  await page.locator('#sym-search').fill('round diff');
  await page.waitForFunction(() => document.querySelectorAll('#sym-grid .sym-cell').length === 1, null, { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, 'sympanel-left.png') });
  const n0 = await inserts();
  await page.locator('#sym-grid .sym-cell', { hasText: /^Round Diffuser$/ }).click();
  assert.equal(await page.evaluate(() => window.app.toolId), 'symbolinsert');
  await clickAt(0.4, 0.5); await clickAt(0.6, 0.5);
  await page.waitForFunction((n) => window.app.doc.entities.filter((e) => e.type === 'INSERT').length === n + 1, n0, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.locator('#sym-search').fill('');

  step = 'Float: the floating window; the canvas gets the column back';
  await dockTo('float');
  assert.equal(await parentId(), 'sym-float');
  assert.equal(await shown('#sym-float'), true);
  assert.equal(await shown('#sym-dock'), false);
  await canvasNear(w0);

  step = 'Hide: not shown anywhere; SYMBOLS shows it again where it was';
  await dockTo('hidden');
  assert.equal(await shown('#sym-panel'), false);
  assert.equal(await inSide(), false);
  await canvasNear(w0);
  await cmd('SYMBOLS');
  assert.equal(await parentId(), 'sym-float', 'SYMBOLS reopens the floating window');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sym-search');

  step = 'Dock in side panel: back to a section of the side panel';
  await dockTo('side');
  assert.equal(await inSide(), true);
  assert.equal(await shown('#sym-float'), false);
  assert.equal(await shown('#sym-search'), true);
  await canvasNear(w0);

  step = 'right dock, close button hides it, SYMBOLS reopens it on the right';
  await dockTo('right');
  await page.locator('#sym-float-close').click();
  assert.equal(await shown('#sym-panel'), false);
  await canvasNear(w0);
  await cmd('SYMBOLS');
  assert.equal(await cls('sym-dock-right'), true);
  await canvasNear(w0 - 340, 4);

  step = 'reload: the right dock and its width are kept';
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('sym-dock-right'), null, { timeout: 5000 });
  assert.equal(await parentId(), 'sym-dock');
  await canvasNear(w0 - 340, 4);
  await dockTo('side');
  assert.equal(await inSide(), true);

  assert.deepEqual(problems, []);
  console.log('sympanel e2e: OK');
} catch (err) {
  console.error(`sympanel e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
