#!/usr/bin/env node
// Browser end-to-end test of the tool panel dock side (Left / Right), the floating opacity and docking the floating panel; same harness as run.mjs.
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
  const viewItem = async (text) => { await page.locator('#menubar .menu > button', { hasText: 'View' }).click(); await page.locator('#menubar .menu.open .sub > button', { hasText: 'Toolbars' }).hover(); await page.locator('#menubar .drop button', { hasText: text }).click(); };
  const rect = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);
  const cls = (c) => page.evaluate((k) => document.getElementById('app').classList.contains(k), c);
  const opacity = () => page.evaluate(() => Number(getComputedStyle(document.getElementById('tools')).opacity));
  const waitOpacity = (v) => page.waitForFunction((x) => Math.abs(Number(getComputedStyle(document.getElementById('tools')).opacity) - x) < 0.02, v, { timeout: 2000 });
  const ents = () => page.evaluate(() => [...(window.app.doc.entities.values?.() ?? window.app.doc.entities)].map((e) => String(e.type).toUpperCase()));
  const setting = (k) => page.evaluate((key) => window.api.settingsGet(key), k);
  /** the canvas follows the panel: it starts at x and the viewport has its width */
  const canvasAt = (x) => page.waitForFunction((l) => { const c = document.getElementById('cv').getBoundingClientRect(); return Math.round(c.left) === l && window.app.vp.view.width === Math.round(c.width); }, x, { timeout: 3000 });

  step = 'View > Tool panel: Right docks the Full panel on the right of the canvas; the canvas starts at x = 0';
  const leftCv = await rect('#cv');
  assert.ok(leftCv.left > 40, 'Full on the left: the canvas starts after the panel');
  await viewItem('Tool panel: Right');
  assert.ok(await cls('tools-right'));
  await canvasAt(0);
  let t = await rect('#tools'), c = await rect('#cv'), side = await rect('#side');
  assert.ok(t.left >= c.right - 1 && t.right <= side.left + 1, `panel between the canvas and the side panel (${t.left}..${t.right}, canvas ends ${c.right}, side starts ${side.left})`);
  assert.equal(await setting('tools.placement'), 'right');

  step = 'Compact rail on the right: a flyout opens to the left of the rail';
  await pickMode('rail');
  assert.ok(await cls('tools-rail') && await cls('tools-right'), 'the rail stays on the right');
  await page.waitForFunction(() => document.getElementById('tools').getBoundingClientRect().width <= 46, null, { timeout: 3000 });
  t = await rect('#tools'); c = await rect('#cv');
  assert.ok(t.left >= c.right - 1, 'rail at the right of the canvas');
  await page.click('#tools [data-rail=draw]');
  const fly = await rect('#tools .rail-fly');
  assert.ok(fly.right <= t.left && fly.left >= 0, `flyout left of the rail (${fly.left}..${fly.right}, rail at ${t.left})`);
  await page.screenshot({ path: path.join(SCRATCH, 'tooldock-rail-right.png') });
  await page.keyboard.press('Escape');

  step = 'Floating at 40 %: opaque under the pointer, back to 40 % after it leaves';
  await pickMode('float');
  assert.ok(await cls('tools-float'));
  await openMenu();
  assert.ok(await page.locator('.tp-menu input[type=range]').isVisible(), 'opacity slider in the ⋯ menu');
  await page.locator('.tp-menu input[type=range]').fill('40');
  assert.equal(await page.textContent('.tp-menu .tp-op-val'), '40 %');
  await page.keyboard.press('Escape');
  await page.mouse.move(900, 500);
  await waitOpacity(0.4);
  t = await rect('#tools');
  await page.mouse.move(t.left + t.width / 2, t.top + t.height / 2);
  await waitOpacity(1);
  await page.mouse.move(900, 500);
  await waitOpacity(0.4);
  assert.equal(await setting('tools.floatOpacity'), 40);

  step = 'clicks outside the semi-transparent panel still draw; clicks on it still choose tools';
  const n0 = (await ents()).length;
  await page.click('#tools button[data-tool=line]');
  assert.equal(await page.evaluate(() => window.app.toolId), 'line', 'the panel takes its clicks');
  await page.mouse.click(t.right + 30, t.top + 40);
  await page.mouse.click(t.right + 300, t.top + 200);
  await page.keyboard.press('Escape');
  const e1 = await ents();
  assert.equal(e1.length, n0 + 1, 'one line drawn through the canvas'); assert.equal(e1.at(-1), 'LINE');
  await page.evaluate(() => window.app.setTool('select'));

  step = 'screenshot: floating at 50 % over a drawing';
  for (const s of ['line', '0,0', '400,300', '0,300', '400,0', '0,0', '']) await typeCmd(s);
  await page.click('#z-fit');
  await openMenu();
  await page.locator('.tp-menu input[type=range]').fill('50');
  await page.keyboard.press('Escape');
  await page.mouse.move(900, 600);
  await waitOpacity(0.5);
  await page.screenshot({ path: path.join(SCRATCH, 'tooldock-float-50.png') });

  step = '"Opaque on hover" off: the panel stays at its level under the pointer; all of it persists after a reload';
  await openMenu();
  assert.equal(await page.getAttribute('.tp-menu .tp-op-hover', 'aria-checked'), 'true', 'on by default');
  await page.click('.tp-menu .tp-op-hover');
  assert.equal(await page.getAttribute('.tp-menu .tp-op-hover', 'aria-checked'), 'false');
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('tools-float'), null, { timeout: 3000 });
  assert.ok(await cls('tools-right'), 'dock side remembered');
  await page.mouse.move(900, 600);
  await waitOpacity(0.5);
  t = await rect('#tools');
  await page.mouse.move(t.left + t.width / 2, t.top + t.height / 2);
  await page.waitForTimeout(300);
  assert.ok(Math.abs(await opacity() - 0.5) < 0.02, 'no hover override');
  assert.equal(await setting('tools.floatOpaqueHover'), false);
  await openMenu(); await page.click('.tp-menu .tp-op-hover'); await page.keyboard.press('Escape');

  step = 'drag the floating panel to the canvas\'s left edge: a dock hint, then it docks there as a Full panel';
  const head = await page.locator('#tools .float-head > span').boundingBox();
  await page.mouse.move(head.x + 5, head.y + 5);
  await page.mouse.down();
  await page.mouse.move(head.x - 100, head.y + 40, { steps: 5 });
  await page.mouse.move(2, head.y + 60, { steps: 5 });
  assert.equal(await page.getAttribute('.dock-hint', 'data-side'), 'left');
  assert.ok(await page.locator('.dock-hint').isVisible(), 'dock hint shown');
  await page.mouse.up();
  assert.ok(await cls('tools-full') && await cls('tools-left'), 'docked on the left as Full');
  assert.equal(await page.locator('.dock-hint').isVisible(), false);
  t = await rect('#tools');
  await canvasAt(Math.round(t.right));
  assert.equal(await setting('tools.placement'), 'left'); assert.equal(await setting('tools.mode'), 'full');

  step = 'double-click the floating title strip: back to the last docked side and layout (Compact rail on the right)';
  await viewItem('Tool panel: Right');
  await pickMode('rail');
  await pickMode('float');
  assert.ok(await cls('tools-float'));
  await page.dblclick('#tools .float-head > span');
  assert.ok(await cls('tools-rail') && await cls('tools-right'), 'Compact rail on the right again');
  await canvasAt(0);

  step = 'the dock side and layout persist';
  await page.reload({ waitUntil: 'load' }); await ready();
  await page.waitForFunction(() => document.getElementById('app').classList.contains('tools-rail'), null, { timeout: 3000 });
  assert.ok(await cls('tools-right'));
  await canvasAt(0);
  assert.equal(await page.evaluate(() => window.app.toolModes.opacity), 50);

  assert.deepEqual(problems, []);
  console.log('draw tooldock e2e: OK');
} catch (err) {
  console.error(`draw tooldock e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
