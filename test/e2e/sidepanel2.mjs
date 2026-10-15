#!/usr/bin/env node
// Browser end-to-end test of the side panel modes: icon rail with flyouts (Esc, click outside, pin), Hidden, the SYMBOLS
// command from the rail, Symbols layouts (grid / list / floating window); modes kept across a reload. Screenshots in .scratch/.
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

  const canvasW = () => page.evaluate(() => document.getElementById('cv').getBoundingClientRect().width);
  const shown = (sel) => page.locator(sel).isVisible();
  const cls = (c) => page.evaluate((k) => document.getElementById('app').classList.contains(k), c);
  const SHOTS = path.join(ROOT, '.scratch');
  await fs.mkdir(SHOTS, { recursive: true });

  step = 'collapse with the edge chevron: a 40 px icon rail, the canvas gets wider';
  const w0 = await canvasW();
  await page.locator('#side-toggle').click();
  await page.waitForFunction((w) => document.getElementById('cv').getBoundingClientRect().width > w + 250, w0, { timeout: 5000 });
  assert.equal(Math.round((await page.locator('#side').boundingBox()).width), 40, 'rail width');
  assert.equal(await page.locator('#side-rail .rail-btn').count(), 4);
  assert.equal(await shown('#layers'), false);

  step = 'a rail button opens Layers as a flyout over the canvas; the canvas keeps its width; a layer toggles';
  const w1 = await canvasW();
  await page.locator('#side-rail .rail-btn[data-sec=layers]').click();
  assert.equal(await shown('#layers'), true);
  assert.equal(await shown('#side-pin'), true);
  assert.equal(await canvasW(), w1, 'overlay, not a resize');
  const fly = await page.locator('#side .panel[data-sec=layers]').boundingBox();
  assert.ok(Math.abs(fly.width - 340) <= 2 && fly.x + fly.width <= 1400 - 39, `flyout ${JSON.stringify(fly)}`);
  const on0 = await page.evaluate(() => [...window.app.doc.layers.values()][0].visible !== false);
  await page.locator('#layers .layer .lay-on').first().click();
  assert.equal(await page.evaluate(() => [...window.app.doc.layers.values()][0].visible !== false), !on0, 'layer toggled from the flyout');
  assert.equal(await shown('#layers'), true, 'a click inside keeps it open');
  await page.screenshot({ path: path.join(SHOTS, 'side-rail-layers-flyout.png') });

  step = 'Esc closes the flyout; a click on the canvas closes it too';
  await page.keyboard.press('Escape');
  assert.equal(await shown('#layers'), false);
  await page.locator('#side-rail .rail-btn[data-sec=props]').click();
  assert.equal(await shown('#props'), true);
  await page.mouse.click(500, 400);
  assert.equal(await shown('#props'), false, 'click outside closes');

  step = 'pin docks the panel back to expanded';
  await page.locator('#side-rail .rail-btn[data-sec=layers]').click();
  await page.locator('#side-pin').click();
  await page.waitForFunction((w) => Math.abs(document.getElementById('cv').getBoundingClientRect().width - w) < 1, w0, { timeout: 5000 });
  assert.equal(await cls('side-collapsed'), false);
  assert.equal(await shown('#layers'), true);
  assert.equal(await shown('#side-rail'), false);

  step = 'drag-to-resize still works when expanded, and the flyout takes that width';
  const g = await page.locator('#side-grip').boundingBox();
  await page.mouse.move(g.x + 2, g.y + 100); await page.mouse.down(); await page.mouse.move(1400 - 400, g.y + 100, { steps: 5 }); await page.mouse.up();
  assert.ok(Math.abs((await page.locator('#side').boundingBox()).width - 400) <= 2);
  await page.locator('#side-toggle').click();
  await page.locator('#side-rail .rail-btn[data-sec=markups]').click();
  assert.ok(Math.abs((await page.locator('#mk-panel').boundingBox()).width - 400) <= 2, 'flyout uses the dragged width');
  await page.keyboard.press('Escape');

  step = 'SYMBOLS while collapsed opens the Symbols flyout with the search focused';
  await page.locator('#cmd').fill('SYMBOLS'); await page.locator('#cmd').press('Enter');
  assert.equal(await cls('side-collapsed'), true, 'stays collapsed');
  assert.equal(await shown('#sym-grid'), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sym-search');
  await page.keyboard.press('Escape'); // clears nothing (empty search) and closes the flyout
  await page.locator('#cv').click({ position: { x: 300, y: 300 } });
  assert.equal(await shown('#sym-grid'), false);

  step = 'Symbols List at a 300 px panel: one line of header controls, one row per symbol with thumbnail and name';
  await page.locator('#side-toggle').click(); // expand
  const gb = await page.locator('#side-grip').boundingBox();
  await page.mouse.move(gb.x + 2, gb.y + 100); await page.mouse.down(); await page.mouse.move(1400 - 300, gb.y + 100, { steps: 5 }); await page.mouse.up();
  await page.locator('#side .panel[data-sec=symbols]').scrollIntoViewIfNeeded();
  assert.ok((await page.locator('#sym-panel .sym-src').boundingBox()).height < 32, 'source row on one line');
  assert.ok((await page.locator('#sym-panel .phead').boundingBox()).height < 30, 'header on one line');
  await page.locator('#sym-view-list').click();
  await page.waitForFunction(() => document.querySelectorAll('#sym-grid .sym-cell.ready').length >= 2, null, { timeout: 5000 });
  const [c1, c2] = await page.locator('#sym-grid .sym-cell').evaluateAll((cs) => cs.slice(0, 2).map((c) => c.getBoundingClientRect().toJSON()));
  assert.ok(c1.x === c2.x && c2.y > c1.y && c1.width > 200, `list rows ${JSON.stringify([c1, c2])}`);
  assert.ok((await page.locator('#sym-grid .sym-cell.ready .sym-thumb').first().boundingBox()).width <= 30, 'small thumbnail');
  await page.locator('#sym-panel').screenshot({ path: path.join(SHOTS, 'symbols-list.png') });
  await page.locator('#sym-more').click();
  assert.equal(await shown('#sym-add'), true, 'folder menu opens');
  await page.mouse.click(500, 400);
  assert.equal(await shown('#sym-add'), false, 'and closes on a click outside');

  step = 'Symbols Floating: own window, dragged by its title strip, search works, snaps inside a smaller window';
  await page.locator('#sym-view-float').click();
  assert.equal(await shown('#sym-float'), true);
  assert.equal(await page.evaluate(() => document.getElementById('sym-panel').parentElement.id), 'sym-float');
  const f0 = await page.locator('#sym-float').boundingBox();
  const hb = await page.locator('#sym-float .phead').boundingBox();
  await page.mouse.move(hb.x + 30, hb.y + 8); await page.mouse.down(); await page.mouse.move(hb.x - 270, hb.y + 88, { steps: 6 }); await page.mouse.up();
  const f1 = await page.locator('#sym-float').boundingBox();
  assert.ok(Math.abs(f1.x - (f0.x - 300)) <= 2 && Math.abs(f1.y - (f0.y + 80)) <= 2, `dragged ${JSON.stringify([f0, f1])}`);
  await page.locator('#sym-search').fill('diffuser');
  assert.ok((await page.locator('#sym-grid .sym-name').allTextContents()).every((n) => /diffuser/i.test(n)));
  await page.locator('#sym-search').fill('');
  await page.screenshot({ path: path.join(SHOTS, 'symbols-floating.png') });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForFunction(() => { const r = document.getElementById('sym-float').getBoundingClientRect(); return r.right <= 900 && r.bottom <= 600 && r.left >= 0 && r.top >= 0; }, null, { timeout: 5000 });
  await page.setViewportSize({ width: 1400, height: 850 });

  step = 'SYMBOLS focuses the floating window; closing it docks the symbols back in the List layout';
  await page.locator('#cmd').fill('SYMBOLS'); await page.locator('#cmd').press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sym-search');
  await page.locator('#sym-float-close').click();
  assert.equal(await shown('#sym-float'), false);
  assert.equal(await page.evaluate(() => document.getElementById('sym-panel').closest('#side') !== null), true, 'docked');
  assert.equal(await page.locator('#sym-view-list').getAttribute('aria-pressed'), 'true');
  await page.locator('#sym-view-float').click(); // float again: kept across the reload below
  const f2 = await page.locator('#sym-float').boundingBox();
  await page.locator('#side-toggle').click(); // back to the rail
  await page.locator('#side-rail .rail-btn[data-sec=symbols]').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sym-search', 'the rail focuses the floating window');

  step = 'View > Side panel: Hidden leaves no rail; LA still opens Layers over the canvas; Ctrl+3 expands';
  const w2 = await canvasW();
  await page.locator('#menubar .menu > button', { hasText: /^View$/ }).click();
  await page.locator('#menubar .menu.open .sub > button', { hasText: 'Panels' }).hover();
  await page.locator('#menubar .menu.open .drop button', { hasText: /^.?Side panel: Hidden/ }).click();
  await page.waitForFunction((w) => document.getElementById('cv').getBoundingClientRect().width > w + 30, w2, { timeout: 5000 });
  assert.equal(await shown('#side-rail'), false);
  assert.equal(await shown('#side-toggle'), false);
  await page.locator('#cmd').fill('LA'); await page.locator('#cmd').press('Enter');
  assert.equal(await shown('#layers'), true, 'LA opens a flyout in Hidden mode');
  await page.keyboard.press('Escape');
  assert.equal(await shown('#layers'), false);

  step = 'reload: Hidden mode restored';
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('side-hidden'), null, { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById('sym-float').hidden, null, { timeout: 5000 });
  const f3 = await page.locator('#sym-float').boundingBox();
  assert.ok(Math.abs(f3.x - f2.x) <= 1 && Math.abs(f3.y - f2.y) <= 1 && Math.abs(f3.width - f2.width) <= 1, `float rect kept ${JSON.stringify([f2, f3])}`);
  await page.locator('#sym-float-close').click();
  assert.equal(await page.locator('#sym-view-grid').getAttribute('aria-pressed'), 'true', 'docks to grid after a reload');
  await page.locator('#cv').focus();
  await page.keyboard.press('Control+3');
  assert.equal(await cls('no-side'), false, 'Ctrl+3 expands from Hidden');

  assert.deepEqual(problems, []);
  console.log('sidepanel2 e2e: OK');
} catch (err) {
  console.error(`sidepanel2 e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
