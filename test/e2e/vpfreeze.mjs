#!/usr/bin/env node
// Browser end-to-end test: a layer frozen in one layout viewport only (Layers panel VP column, VPLAYER); same harness as
// run.mjs and vpundo.mjs.
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

  step = 'a drawing: red line on A, blue line on B, a layout with two viewports showing both';
  await page.evaluate(async () => {
    const { newDocument } = await import('/src/core/model.js');
    const { Session } = await import('/src/core/edit.js');
    const { makeViewport } = await import('/src/core/layouts.js');
    const { addLayout, layoutsOf } = await import('/src/core/layoutmgmt.js');
    const doc = newDocument(), s = new Session(doc);
    s.transact('setup', (tx) => {
      tx.layer('A', { color: 1 }); tx.layer('B', { color: 5 });
      const line = (layer, y) => ({ type: 'LINE', id: 0, layer, color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 0, y }, p2: { x: 100, y } });
      tx.add(line('A', 30)); tx.add(line('B', 70));
    });
    addLayout(s, 'Layout1');
    const fit = { minx: 0, miny: 0, maxx: 100, maxy: 100 };
    s.transact('paper', (tx) => tx.set(layoutsOf(doc)[0], 'entities', [
      { ...makeViewport({ x: 0, y: 0 }, { x: 420, y: 297 }, null, 1), paper: true, id: doc.nextId++ },
      { ...makeViewport({ x: 20, y: 50 }, { x: 200, y: 230 }, fit, 2), id: doc.nextId++ },
      { ...makeViewport({ x: 220, y: 50 }, { x: 400, y: 230 }, fit, 3), id: doc.nextId++ },
    ]));
    window.app.installDoc(doc, { path: null, name: 'vpfreeze.dxf', format: 'dxf' });
  });
  const vpCount = () => page.locator('#layers .lay-vpfrz').count();
  assert.equal(await vpCount(), 0, 'no VP column on the Model tab');
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Layout1');
  assert.equal(await vpCount(), 0, 'no VP column in paper space with nothing selected');

  // client position of a paper point (paper view in paper space, the saved paper view in MSPACE)
  const paperClient = (x, y) => page.evaluate(([x, y]) => {
    const vp = window.app.vp, v = vp.mspace ? { ...vp.mspace.paperView, width: vp.view.width, height: vp.view.height } : vp.view;
    const r = vp.canvas.getBoundingClientRect();
    return { x: r.left + v.width / 2 + (x - v.cx) * v.zoom, y: r.top + v.height / 2 - (y - v.cy) * v.zoom };
  }, [x, y]);
  /** [red, blue] pixel counts inside the paper rectangle of viewport n (1 = left, 2 = right), freshly rendered */
  const inks = (n) => page.evaluate((n) => {
    const vp = window.app.vp, v = vp.mspace ? { ...vp.mspace.paperView, width: vp.view.width, height: vp.view.height } : vp.view;
    vp.render();
    const x0 = n === 1 ? 25 : 225, d = vp.dpr;
    const sx = (x) => (v.width / 2 + (x - v.cx) * v.zoom) * d, sy = (y) => (v.height / 2 - (y - v.cy) * v.zoom) * d;
    const L = Math.round(sx(x0)), T = Math.round(sy(225)), W = Math.round(sx(x0 + 170) - L), H = Math.round(sy(55) - T);
    const px = vp.canvas.getContext('2d').getImageData(L, T, W, H).data;
    let red = 0, blue = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 180 && px[i + 1] < 90 && px[i + 2] < 90) red++;
      if (px[i + 2] > 180 && px[i] < 90 && px[i + 1] < 90) blue++;
    }
    return [red, blue];
  }, n);
  const shows = async (n) => { const [r, b] = await inks(n); assert.ok(r > 20, `viewport ${n} draws layer A (${r} red px)`); return b > 20; };
  const frozenOf = () => page.evaluate(() => window.app.active.doc.layouts[0].entities.filter((e) => e.vpId > 1).map((e) => e.frozen.join(',')));
  const steps = () => page.evaluate(() => window.app.active.session.undoStack.length);
  assert.equal(await shows(1), true, 'viewport 1 draws B at first');
  assert.equal(await shows(2), true, 'viewport 2 draws B at first');

  step = 'one viewport selected in paper space: the VP column appears';
  const b1 = await paperClient(20, 140);
  await page.mouse.click(b1.x, b1.y);
  await page.waitForFunction(() => window.app.vp.selection.size === 1);
  assert.equal(await vpCount(), 3, 'a VP button per layer (0, A, B)');
  assert.equal(await page.getAttribute('#layers .layer[data-layer="B"] .lay-vpfrz', 'title'), 'Freeze in this viewport');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.app.vp.selection.size === 0);
  assert.equal(await vpCount(), 0, 'selection cleared: the column goes');

  step = 'MSPACE in viewport 1: VP freeze B hides it there only, one undo step';
  const c1 = await paperClient(110, 140);
  await page.mouse.dblclick(c1.x, c1.y);
  await page.waitForFunction(() => window.app.vp.mspace?.vp.vpId === 2);
  assert.equal(await vpCount(), 3);
  const s0 = await steps();
  await page.click('#layers .layer[data-layer="B"] .lay-vpfrz');
  assert.deepEqual(await frozenOf(), ['B', '']);
  assert.equal(await steps(), s0 + 1, 'one undo step');
  assert.equal(await page.getAttribute('#layers .layer[data-layer="B"] .lay-vpfrz', 'title'), 'Thaw in this viewport');
  assert.equal(await shows(1), false, 'viewport 1 no longer draws B');
  assert.equal(await shows(2), true, 'viewport 2 still draws B');

  step = 'undo thaws B in viewport 1 again';
  await typeCmd('u');
  await page.waitForFunction(() => window.app.active.doc.layouts[0].entities.find((e) => e.vpId === 2).frozen.length === 0);
  assert.equal(await shows(1), true, 'viewport 1 draws B after undo (no stale cached scene)');
  assert.equal(await page.getAttribute('#layers .layer[data-layer="B"] .lay-vpfrz', 'title'), 'Freeze in this viewport');

  step = 'VPLAYER Freeze B All: both viewports hide B, one undo step';
  const s1 = await steps();
  await typeCmd('vplayer');
  assert.equal(await page.evaluate(() => window.app.toolId), 'vplayer');
  await typeCmd('f'); await typeCmd('b'); await typeCmd('a');
  assert.deepEqual(await frozenOf(), ['B', 'B']);
  assert.equal(await steps(), s1 + 1);
  assert.equal(await shows(1), false, 'viewport 1 hides B');
  assert.equal(await shows(2), false, 'viewport 2 hides B');

  step = 'VPLAYER Thaw * Current: only the active viewport draws B again';
  await typeCmd('vplayer'); await typeCmd('t'); await typeCmd('*'); await typeCmd('');
  assert.deepEqual(await frozenOf(), ['', 'B']);
  assert.equal(await shows(1), true);

  step = 'back to the Model tab: the column is hidden';
  await page.click('#spacebar button[data-space="Model"]');
  assert.equal(await vpCount(), 0);

  assert.deepEqual(problems, []);
  console.log('vpfreeze e2e: OK');
} catch (err) {
  console.error(`vpfreeze e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
