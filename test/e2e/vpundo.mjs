#!/usr/bin/env node
// Browser end-to-end test: a layout viewport's view changed in MSPACE (ZE, wheel) is one undo step; same harness as run.mjs.
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

  step = 'open layouts_r2000.dxf, Layout1, saved state';
  await page.evaluate(async () => {
    const { readDxf } = await import('/src/core/dxfRead.js');
    const bytes = new Uint8Array(await (await fetch('/test/fixtures/layouts_r2000.dxf')).arrayBuffer());
    window.app.installDoc(readDxf(bytes), { path: null, name: 'layouts.dxf', format: 'dxf' });
  });
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Layout1');
  await page.evaluate(() => window.app.active.session.markSaved());
  // client position of a paper point (paper view in paper space, the saved paper view in MSPACE)
  const paperClient = (x, y) => page.evaluate(([x, y]) => {
    const vp = window.app.vp, v = vp.mspace ? { ...vp.mspace.paperView, width: vp.view.width, height: vp.view.height } : vp.view;
    const r = vp.canvas.getBoundingClientRect();
    return { x: r.left + v.width / 2 + (x - v.cx) * v.zoom, y: r.top + v.height / 2 - (y - v.cy) * v.zoom };
  }, [x, y]);
  const vpId = await page.evaluate(() => window.app.vp.doc.entities.find((e) => e.type === 'VIEWPORT' && e.vpId !== 1).id);
  const view = () => page.evaluate((id) => {
    const v = window.app.active.doc.layouts.find((l) => l.name === 'Layout1').entities.find((e) => e.id === id);
    return [v.viewCenter.x, v.viewCenter.y, v.viewHeight];
  }, vpId);
  const dirty = () => page.evaluate(() => window.app.active.session.dirty);
  const inMs = () => page.evaluate(() => !!window.app.vp.mspace);
  const enter = async () => { const p = await paperClient(200, 150); await page.mouse.dblclick(p.x, p.y); assert.ok(await inMs(), 'entered the viewport'); };
  const leave = async () => { const p = await paperClient(200, 215); await page.mouse.dblclick(p.x, p.y); assert.equal(await inMs(), false, 'back in paper space'); };
  const wheel = async (dy) => {
    const b = await page.locator('#cv').boundingBox();
    await page.mouse.move(b.x + b.width / 2 + 7, b.y + b.height / 2 + 5); await page.mouse.wheel(0, dy);
  };
  const v0 = await view();

  step = 'MSPACE: ZE and a wheel zoom, back to paper space, Ctrl+Z restores the view, Ctrl+Y changes it again';
  await enter();
  assert.equal(await dirty(), false, 'entering MSPACE leaves the drawing clean');
  const steps0 = await page.evaluate(() => window.app.active.session.undoStack.length);
  await typeCmd('ze');
  await page.waitForFunction((vh) => Math.abs(window.app.vp.mspace.vp.viewHeight - vh) > 1e-6, v0[2]);
  await wheel(-100);
  await page.waitForTimeout(300);
  const v1 = await view();
  assert.notDeepEqual(v1, v0, 'the viewport view changed');
  assert.equal(await dirty(), true, 'a view change in MSPACE marks the drawing changed');
  await leave();
  assert.deepEqual(await view(), v1, 'leaving MSPACE keeps the new view');
  assert.equal(await page.evaluate(() => window.app.active.session.undoStack.length), steps0 + 1, 'one undo step for the view session');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await view(), v0, 'undo restores the viewport view');
  assert.equal(await dirty(), false, 'undo back to the saved state: clean');
  await page.keyboard.press('Control+y');
  assert.deepEqual(await view(), v1, 'redo changes the view again');
  assert.equal(await dirty(), true);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await view(), v0);

  step = 'Ctrl+Z inside MSPACE undoes the zoom and shows the restored view through the viewport';
  await enter();
  const mv0 = await page.evaluate(() => window.app.vp.view.zoom);
  await wheel(-100);
  await page.waitForFunction((vh) => Math.abs(window.app.vp.mspace.vp.viewHeight - vh) > 1e-6, v0[2]);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await view(), v0, 'undo in MSPACE restores the viewport view');
  assert.ok(Math.abs(await page.evaluate(() => window.app.vp.view.zoom) - mv0) < 1e-9 * mv0, 'model view follows the restored viewport view');
  assert.equal(await dirty(), false);
  await leave();
  assert.deepEqual(await view(), v0, 'leaving after the undo records nothing new');
  assert.equal(await dirty(), false);

  step = 'locked viewport: ZE and wheel leave its view alone and record no step';
  await enter();
  await typeCmd('vplock');
  assert.equal(await page.evaluate(() => window.app.vp.mspace.vp.locked), true);
  const steps1 = await page.evaluate(() => window.app.active.session.undoStack.length);
  await typeCmd('ze'); await wheel(-100); await page.waitForTimeout(300);
  assert.deepEqual(await view(), v0, 'a locked viewport keeps its view');
  await leave();
  assert.equal(await page.evaluate(() => window.app.active.session.undoStack.length), steps1, 'no view step for a locked viewport');

  assert.deepEqual(problems, []);
  console.log('vpundo e2e: OK');
} catch (err) {
  console.error(`vpundo e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
