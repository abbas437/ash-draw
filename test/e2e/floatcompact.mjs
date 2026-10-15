#!/usr/bin/env node
// Browser end-to-end test of Floating compact: the Compact rail's strip floating over the drawing, its flyouts, opacity, docking and reload; same harness as run.mjs.
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


const SCRATCH = path.join(ROOT, '.scratch');
await fs.mkdir(SCRATCH, { recursive: true });
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
  const ready = () => page.waitForFunction(() => window.app && window.app.vp && window.app.doc && window.app.toolModes, null, { timeout: 10000 });
  await ready();
  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };
  const openMenu = () => page.click('#tools .tp-mode');
  const pickMode = async (m) => { await openMenu(); await page.click(`.tp-menu [data-mode=${m}]`); };
  const rect = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);
  const cls = (c) => page.evaluate((k) => document.getElementById('app').classList.contains(k), c);
  const waitOpacity = (v) => page.waitForFunction((x) => Math.abs(Number(getComputedStyle(document.getElementById('tools')).opacity) - x) < 0.02, v, { timeout: 2000 });
  const setting = (k) => page.evaluate((key) => window.api.settingsGet(key), k);
  /** the canvas follows the panel: it starts at x and the viewport has its width */
  const canvasAt = (x) => page.waitForFunction((l) => { const c = document.getElementById('cv').getBoundingClientRect(); return Math.round(c.left) === l && window.app.vp.view.width === Math.round(c.width); }, x, { timeout: 3000 });

  const flyRect = () => rect('#tools .rail-fly');
  /** drag the floating strip by its grip so that its left edge lands at x (top edge at y) */
  const dragTo = async (x, y, steps = 8) => {
    const g = await page.locator('#tools .float-head > span').boundingBox(), t0 = await rect('#tools');
    const gx = g.x + g.width / 2, gy = g.y + g.height / 2;
    await page.mouse.move(gx, gy); await page.mouse.down();
    await page.mouse.move(gx + (x - t0.left) / 2, gy + (y - t0.top) / 2, { steps });
    await page.mouse.move(gx + x - t0.left, gy + y - t0.top, { steps });
  };

  step = 'the ⋯ menu offers Floating compact: the rail strip floats (fixed, narrow)';
  await openMenu();
  assert.match(await page.textContent('.tp-menu [data-mode=float-rail]'), /Floating compact/);
  await page.click('.tp-menu [data-mode=float-rail]');
  assert.ok(await cls('tools-float') && await cls('tools-float-rail'), '#app has tools-float and tools-float-rail');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('tools')).position), 'fixed');
  let t = await rect('#tools');
  assert.ok(t.width <= 60, `strip at most 60 px wide (${t.width})`);
  assert.ok(await page.locator('#tools .float-head > span').isVisible(), 'the drag grip is visible');
  assert.ok(await page.locator('#tools .float-head .tp-mode').isVisible(), 'the ⋯ menu sits in the title strip');
  assert.equal(await setting('tools.floatLayout'), 'rail');

  step = 'the group buttons stack vertically and no Full-panel group shows';
  const btns = await page.evaluate(() => [...document.querySelectorAll('#tools .rail-btn')].map((b) => b.getBoundingClientRect().toJSON()));
  assert.ok(btns.length >= 3, `rail buttons (${btns.length})`);
  for (let i = 1; i < btns.length; i++) {
    assert.ok(btns[i].top > btns[i - 1].top, `button ${i} below button ${i - 1}`);
    assert.ok(Math.abs(btns[i].left - btns[0].left) < 1, `button ${i} in the same column`);
    assert.ok(btns[i].right <= t.right && btns[i].bottom <= t.bottom + 1, `button ${i} inside the strip`);
  }
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#tools > .tgroup, #tools > .lbl-toggle')].filter((g) => getComputedStyle(g).display !== 'none').length), 0, 'groups hidden');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#tools button[data-tool]')].filter((b) => b.getClientRects().length).length), 0, 'no tool button shows outside a flyout');

  step = 'the Draw flyout opens right of the strip; Circle in it becomes the tool and presses the Draw button';
  await page.click('#tools [data-rail-more="draw"]');
  let f = await flyRect();
  assert.ok(f.width > 0 && f.left >= t.right && f.right <= 1400, `flyout right of the strip (${f.left}..${f.right}, strip ends ${t.right})`);
  await page.click('#tools .rail-fly button[data-tool=circle]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'circle');
  assert.equal(await page.getAttribute('#tools [data-rail=draw]', 'aria-pressed'), 'true');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.evaluate(() => window.app.setTool('select'));

  step = 'dragged near the right window edge (side panel hidden) it keeps floating and its flyout opens to the left';
  await page.evaluate(() => window.app.setSideMode('hidden', false));
  await page.waitForFunction(() => document.getElementById('stage').getBoundingClientRect().right > 1370, null, { timeout: 3000 });
  await dragTo(1290, 120);
  assert.equal(await page.locator('.dock-hint').isVisible(), false, 'no dock hint short of the edge');
  await page.mouse.up();
  assert.ok(await cls('tools-float-rail'), 'still floating');
  t = await rect('#tools');
  assert.ok(Math.abs(t.left - 1290) < 2 && Math.abs(t.top - 120) < 2, `strip moved (${t.left}, ${t.top})`);
  await page.click('#tools [data-rail-more="draw"]');
  f = await flyRect();
  assert.ok(f.width > 0 && f.right <= t.left && f.left >= 0, `flyout left of the strip (${f.left}..${f.right}, strip starts ${t.left})`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.app.setSideMode('expanded', false));

  step = 'opacity 50 % from the ⋯ menu applies to the strip';
  await openMenu();
  await page.locator('.tp-menu input[type=range]').fill('50');
  await page.keyboard.press('Escape');
  await page.mouse.move(600, 600);
  await waitOpacity(0.5);
  assert.equal(await setting('tools.floatOpacity'), 50);

  step = 'double-clicking the title strip docks it as a Compact rail';
  await page.dblclick('#tools .float-head > span');
  assert.ok(await cls('tools-rail'), 'Compact rail');
  assert.equal(await cls('tools-float'), false); assert.equal(await cls('tools-float-rail'), false);
  t = await rect('#tools');
  await canvasAt(Math.round(t.right));
  assert.equal(await setting('tools.mode'), 'rail');

  step = 'Floating compact again, then a reload restores it';
  await pickMode('float-rail');
  assert.ok(await cls('tools-float-rail'));
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('tools-float-rail'), null, { timeout: 3000 });
  assert.ok(await cls('tools-float'));
  assert.equal(await page.evaluate(() => window.app.toolModes.layout), 'float-rail');
  assert.ok((await rect('#tools')).width <= 60, 'still the narrow strip');

  step = 'dragging the grip to the drawing\'s left edge docks it as a Compact rail on the left (narrow dock hint)';
  const s = await rect('#stage');
  await dragTo(s.left + 2, 200);
  assert.equal(await page.getAttribute('.dock-hint', 'data-side'), 'left');
  assert.ok(await page.locator('.dock-hint').isVisible(), 'dock hint shown');
  assert.ok((await rect('.dock-hint')).width <= 46, 'narrow dock hint');
  await page.mouse.up();
  assert.ok(await cls('tools-rail') && await cls('tools-left'), 'Compact rail on the left');
  assert.equal(await cls('tools-float'), false);
  t = await rect('#tools');
  await canvasAt(Math.round(t.right));

  step = 'screenshot: dark, Floating compact at 100 % with the Draw flyout open';
  await page.evaluate(() => window.app.setTheme('dark', false));
  for (const c of ['line', '0,0', '400,300', '0,300', '400,0', '0,0', '']) await typeCmd(c);
  await page.click('#z-fit');
  await page.keyboard.press('Escape');
  await pickMode('float-rail');
  await openMenu();
  await page.locator('.tp-menu input[type=range]').fill('100');
  await page.keyboard.press('Escape');
  await waitOpacity(1);
  await page.click('#tools [data-rail-more="draw"]');
  await page.screenshot({ path: path.join(SCRATCH, 'float-compact.png') });

  assert.deepEqual(problems, []);
  console.log('draw floatcompact e2e: OK');
} catch (err) {
  console.error(`draw floatcompact e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
