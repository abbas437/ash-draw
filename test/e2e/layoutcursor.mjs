#!/usr/bin/env node
// Browser end-to-end test: on a layout the sheet (paper scene plus the model drawn through each viewport) is kept as a
// bitmap, so a cursor move or a rubber band does not redraw the viewports; edits, VP freeze, MSPACE and a viewport view
// change still show. Same harness as vpfreeze.mjs.
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
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  step = 'a drawing of 2000 lines on layers A and B, a layout with two viewports showing them';
  await page.evaluate(async () => {
    const { newDocument } = await import('/src/core/model.js');
    const { Session } = await import('/src/core/edit.js');
    const { makeViewport } = await import('/src/core/layouts.js');
    const { addLayout, layoutsOf } = await import('/src/core/layoutmgmt.js');
    const doc = newDocument(), s = new Session(doc);
    s.transact('setup', (tx) => {
      tx.layer('A', { color: 1 }); tx.layer('B', { color: 5 });
      for (let i = 0; i < 2000; i++) tx.add({ type: 'LINE', id: 0, layer: i % 2 ? 'B' : 'A', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 0, y: i / 20 }, p2: { x: 100, y: (i * 7) % 100 } });
    });
    addLayout(s, 'Layout1');
    const fit = { minx: 0, miny: 0, maxx: 100, maxy: 100 };
    s.transact('paper', (tx) => tx.set(layoutsOf(doc)[0], 'entities', [
      { ...makeViewport({ x: 0, y: 0 }, { x: 420, y: 297 }, null, 1), paper: true, id: doc.nextId++ },
      { ...makeViewport({ x: 20, y: 50 }, { x: 200, y: 230 }, fit, 2), id: doc.nextId++ },
      { ...makeViewport({ x: 220, y: 50 }, { x: 400, y: 230 }, fit, 3), id: doc.nextId++ },
    ]));
    window.app.installDoc(doc, { path: null, name: 'layoutcursor.dxf', format: 'dxf' });
    // canvas path calls: a viewport redraw makes thousands, the cursor overlays a handful
    window.__paths = 0;
    for (const m of ['lineTo', 'moveTo']) { const f = CanvasRenderingContext2D.prototype[m]; CanvasRenderingContext2D.prototype[m] = function (...a) { window.__paths++; return f.apply(this, a); }; }
  });
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Layout1');
  const frames = (n = 3) => page.evaluate((n) => new Promise((res) => { const f = () => (n-- <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  await frames();

  const client = (x, y) => page.evaluate(([x, y]) => {
    const vp = window.app.vp, v = vp.mspace ? { ...vp.mspace.paperView, width: vp.view.width, height: vp.view.height } : vp.view, r = vp.canvas.getBoundingClientRect();
    return { x: r.left + v.width / 2 + (x - v.cx) * v.zoom, y: r.top + v.height / 2 - (y - v.cy) * v.zoom };
  }, [x, y]);
  /** path calls per rendered frame over `n` pointer moves across the left viewport */
  const pathsPerMove = async (n = 10) => {
    await page.evaluate(() => { window.__paths = 0; window.__renders = 0; const vp = window.app.vp; if (!vp.__wrapped) { const r = vp.render.bind(vp); vp.render = () => { window.__renders++; r(); }; vp.__wrapped = true; } });
    for (let i = 0; i < n; i++) { const p = await client(40 + i * 12, 100 + i * 8); await page.mouse.move(p.x, p.y); await frames(2); }
    const { paths, renders } = await page.evaluate(() => ({ paths: window.__paths, renders: window.__renders }));
    assert.ok(renders >= n, `each move rendered (${renders} renders)`);
    return paths / renders;
  };
  /** a hash of the canvas without the cursor overlays, freshly rendered */
  const picture = () => page.evaluate(() => {
    const vp = window.app.vp; vp.showCross = false; vp.snapMarker = null; vp.render();
    const d = vp.canvas.getContext('2d').getImageData(0, 0, vp.canvas.width, vp.canvas.height).data;
    let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0;
    return h;
  });

  step = 'select tool idle: a cursor move on the layout does not redraw the viewports';
  const idle = await pathsPerMove();
  assert.ok(idle < 200, `path calls per move ${idle} (a sheet redraw makes > 4000)`);

  step = 'measure with a first point placed: the rubber band does not redraw the viewports either';
  await page.evaluate(() => window.app.setTool('measure'));
  const a = await client(30, 60); await page.mouse.click(a.x, a.y); await frames();
  assert.match(await page.evaluate(() => window.app.tool?.prompt ?? ''), /second point/);
  const rubber = await pathsPerMove();
  assert.ok(rubber < 200, `path calls per move with the rubber band ${rubber}`);
  await page.keyboard.press('Escape'); await page.evaluate(() => window.app.setTool('select')); await frames();

  step = 'the cached sheet follows a paper edit and its undo';
  const p0 = await picture();
  await page.evaluate(() => window.app.active.session.transact('paper line', (tx) => tx.add({ type: 'LINE', id: 0, layer: '0', color: 1, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 210, y: 20 }, p2: { x: 410, y: 280 } })));
  const p1 = await picture();
  assert.notEqual(p1, p0, 'paper edit shown');
  await page.evaluate(() => window.app.undo()); assert.equal(await picture(), p0, 'undo shown');

  step = 'the cached sheet follows a VP freeze of layer B in the left viewport';
  await page.evaluate(async () => {
    const { setVpFreeze } = await import('/src/core/vpfreeze.js');
    const v = window.app.vp.doc.entities.find((e) => e.type === 'VIEWPORT' && e.vpId === 2);
    setVpFreeze(window.app.active.session, [v], ['B'], true);
  });
  const pf = await picture();
  assert.notEqual(pf, p0, 'VP freeze shown');

  step = 'MSPACE in the right viewport: entering, a zoom there and leaving all show';
  const c = await client(310, 140); await page.mouse.dblclick(c.x, c.y); await frames();
  assert.ok(await page.evaluate(() => !!window.app.vp.mspace), 'in MSPACE');
  const pm = await picture();
  assert.notEqual(pm, pf, 'active viewport border shown');
  assert.ok((await pathsPerMove(6)) < 200, 'a cursor move in MSPACE does not redraw the sheet');
  await page.evaluate(() => window.app.vp.zoomBy(1.5));
  const pz = await picture();
  assert.notEqual(pz, pm, 'viewport zoom shown');
  await page.evaluate(() => window.app.layoutCommands.ps()); await frames();
  assert.notEqual(await picture(), pz, 'back in paper space');

  assert.deepEqual(problems, []);
  console.log(`layoutcursor e2e: OK (path calls per move: idle ${idle.toFixed(1)}, rubber band ${rubber.toFixed(1)})`);
} catch (err) {
  console.error(`layoutcursor e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
