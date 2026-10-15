#!/usr/bin/env node
// Browser end-to-end test of the drawing grid (GRID / F7): toggles, pixels, adaptive cap, pan, saved settings; same harness as run.mjs.
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

  await page.mouse.move(5, 845); // keep the crosshair off the sampled areas
  const vp = 'window.app.vp';
  // distinct colours in a region of the canvas (CSS px; the test runs at devicePixelRatio 1)
  const distinct = (x, y, w, h) => page.evaluate(([x, y, w, h]) => { const d = window.app.vp.ctx.getImageData(x, y, w, h).data, s = new Set(); for (let i = 0; i < d.length; i += 4) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return s.size; }, [x, y, w, h]);
  const render = () => page.evaluate(() => { window.app.vp.render(); return window.app.vp.gridDrawn; });
  const box = () => page.evaluate(() => { const v = window.app.vp.view; return [Math.round(v.width / 2 - 150), Math.round(v.height / 2 - 100), 300, 200]; });

  step = 'dark canvas, grid off: an empty area is plain';
  await page.evaluate(() => { localStorage.clear(); window.app.setCanvasDark(true); window.app.vp.view.zoom = 2; });
  assert.equal(await page.evaluate(() => window.app.vp.settings.grid), false);
  assert.equal(await render(), 0);
  const B = await box();
  assert.equal(await distinct(...B), 1, 'grid off: one colour');

  step = 'F7 turns the grid on';
  await page.keyboard.press('F7');
  assert.equal(await page.evaluate(() => window.app.vp.settings.grid), true);
  assert.ok(await page.evaluate(() => document.querySelector('#status button[data-key="grid"]').classList.contains('on')), 'GRID button lit');
  assert.ok(await render() > 0);
  assert.ok(await distinct(...B) > 1, 'grid on: a pattern in the empty area');

  step = 'the GRID button turns it off and on';
  await page.locator('#status button[data-key="grid"]').click();
  await page.mouse.move(5, 845);
  assert.equal(await page.evaluate(() => window.app.vp.settings.grid), false);
  assert.equal(await render(), 0);
  assert.equal(await distinct(...B), 1, 'off again: one colour');
  await page.locator('#status button[data-key="grid"]').click();
  await page.mouse.move(5, 845);
  assert.equal(await page.evaluate(() => window.app.vp.settings.grid), true);

  step = 'grid lines sit on world multiples and follow a pan gesture';
  // lines every 10 units at zoom 4 = 40 px; major every 5
  const lineCols = () => page.evaluate(() => {
    const vp = window.app.vp; vp.render();
    const y = Math.round(vp.view.height / 2) + 7, d = vp.ctx.getImageData(0, y, vp.canvas.width, 1).data, bg = [d[0], d[1], d[2]], out = [];
    // background where no line is: the most common colour
    const cnt = new Map(); for (let i = 0; i < d.length; i += 4) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
    const top = [...cnt].sort((a, b) => b[1] - a[1])[0][0];
    for (let i = 0; i < d.length; i += 4) if (((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) !== top) out.push(i / 4);
    return { out, bg };
  });
  await page.evaluate(() => { const v = window.app.vp.view; v.zoom = 4; v.cx = 0; v.cy = 0; });
  let cols = (await lineCols()).out;
  const W = await page.evaluate(() => window.app.vp.view.width);
  assert.ok(cols.length > 5, `vertical lines found: ${cols.length}`);
  for (const c of cols) assert.equal(((c - Math.round(W / 2)) % 40 + 40) % 40, 0, `line at column ${c} is on a 10-unit multiple (centre ${W / 2})`);
  await page.evaluate(() => window.app.vp.render()); // a cached frame to shift
  await page.evaluate(() => { const vp = window.app.vp; vp.beginGesture('pan'); vp.view.cx += 2.5; }); // 10 px to the left
  const moved = (await lineCols()).out;
  assert.ok(moved.length > 5);
  for (const c of moved) assert.equal(((c - Math.round(W / 2) + 10) % 40 + 40) % 40, 0, `after the pan, line at ${c} moved with the view`);
  await page.evaluate(() => { const vp = window.app.vp; vp.endGesture(0); });
  await page.waitForTimeout(50);

  step = 'GRID command: Style Dots, Spacing';
  const cmd = async (s) => { await page.locator('#cmd').fill(s); await page.locator('#cmd').press('Enter'); };
  await cmd('GRID'); await cmd('st'); await cmd('d');
  assert.equal(await page.evaluate(() => window.app.vp.settings.gridStyle), 'dots');
  await cmd('GRID'); await cmd('s'); await cmd('5');
  assert.equal(await page.evaluate(() => window.app.vp.settings.gridSpacing), 5);
  await cmd('GRID'); await cmd('10');
  assert.equal(await page.evaluate(() => window.app.vp.settings.gridSpacing), 10);
  await page.mouse.move(5, 845);

  step = 'zooming out keeps the dot count capped';
  const counts = [];
  for (const z of [4, 1, 0.85, 0.3, 0.05, 1e-3, 1e-6]) {
    const n = await page.evaluate((z) => { const vp = window.app.vp; vp.view.zoom = z; vp.render(); return vp.gridDrawn; }, z);
    counts.push(n);
    assert.ok(n > 0 && n <= 10000, `zoom ${z}: ${n} dots`);
  }
  assert.ok(await distinct(...B) > 1, 'dots visible');

  step = 'the settings survive a reload';
  await page.reload({ waitUntil: 'load' });
  await ready();
  await page.waitForFunction(() => window.app.vp.settings.grid === true && window.app.vp.settings.gridStyle === 'dots', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.app.vp.settings.gridSpacing), 10);

  step = 'screenshot (dark, grid lines, a drawing)';
  const dxf = ['0', 'SECTION', '2', 'ENTITIES',
    ...[[0, 0, 100, 0], [100, 0, 100, 60], [100, 60, 0, 60], [0, 60, 0, 0], [0, 0, 100, 60]]
      .flatMap(([a, b, c, d]) => ['0', 'LINE', '8', '0', '10', a, '20', b, '30', '0', '11', c, '21', d, '31', '0'].map(String)),
    '0', 'CIRCLE', '8', '0', '10', '50', '20', '30', '30', '0', '40', '20',
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const chooser = new Promise((r) => page.once('filechooser', r));
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'grid.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from(dxf) });
  await page.waitForFunction(() => window.app.file.name === 'grid.dxf', null, { timeout: 8000 });
  await cmd('GRID'); await cmd('st'); await cmd('l');
  await page.evaluate(() => { window.app.setCanvasDark(true); window.app.vp.zoomExtents(); window.app.vp.zoomBy?.(0.6); });
  await page.mouse.move(5, 845);
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => { window.app.vp.render(); return window.app.vp.gridDrawn; }) > 0);
  await fs.mkdir(path.join(ROOT, '.scratch'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, '.scratch', 'grid-dark.png') });

  step = 'GSNAP: F9 toggles it, a mouse-drawn LINE lands on grid points, an endpoint wins, LWT keeps its button';
  const on = (key) => page.evaluate((k) => document.querySelector(`#status button[data-key="${k}"]`).classList.contains('on'), key);
  const mouseAt = async (x, y) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]), box = await page.locator('#cv').boundingBox();
    await page.mouse.move(box.x + s.x, box.y + s.y); await page.waitForTimeout(80);
    await page.mouse.click(box.x + s.x, box.y + s.y); await page.waitForTimeout(80);
  };
  const last = () => page.evaluate(() => { const e = window.app.doc.entities.at(-1); return { p1: e.p1, p2: e.p2 }; });
  const pt = (p, x, y) => assert.ok(p && Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9, JSON.stringify(p));
  assert.equal(await on('gridSnap'), false);
  await page.keyboard.press('F9');
  assert.equal(await on('gridSnap'), true); assert.equal(await page.evaluate(() => window.app.vp.settings.gridSnap), true);
  assert.equal(await on('lineweights'), false, 'F9 no longer toggles LWT');
  await page.evaluate(() => { window.app.vp.settings.grid = false; window.app.vp.requestRender(); }); // grid snap works with the grid hidden
  await cmd('GRID'); await cmd('7'); // 7 units: the endpoint (100,60) is off the grid, so the two snaps give different points
  await cmd('LINE');
  await mouseAt(-13.4, -7.3); await mouseAt(-27.4, -22.6);
  await page.keyboard.press('Enter');
  const l1 = await last(); pt(l1.p1, -14, -7); pt(l1.p2, -28, -21);
  await cmd('LINE');
  await mouseAt(100.7, 59.4); // the grid point would be (98,56); the endpoint wins
  await mouseAt(-13.4, -27.3);
  await page.keyboard.press('Enter');
  const l2 = await last(); pt(l2.p1, 100, 60); pt(l2.p2, -14, -28);
  await cmd('GRID'); await cmd('10');
  await cmd('SNAP'); await cmd('off');
  assert.equal(await page.evaluate(() => window.app.vp.settings.gridSnap), false);
  await cmd('SN'); await cmd('on');
  assert.equal(await page.evaluate(() => window.app.vp.settings.gridSnap), true);
  await page.keyboard.press('F9');
  assert.equal(await on('gridSnap'), false);
  await page.locator('#status button[data-key="lineweights"]').click();
  assert.equal(await on('lineweights'), true);
  await page.locator('#status button[data-key="lineweights"]').click();
  assert.equal(await on('lineweights'), false);

  step = 'GSNAP on a layout: paper space snaps in paper mm, model space through a viewport (MSPACE) in the model spacing';
  await page.evaluate(async () => {
    const { readDxf } = await import('/src/core/dxfRead.js');
    const bytes = new Uint8Array(await (await fetch('/test/fixtures/layouts_r2000.dxf')).arrayBuffer());
    window.app.installDoc(readDxf(bytes), { path: null, name: 'layouts.dxf', format: 'dxf' });
  });
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Layout1');
  await cmd('GRID'); await cmd('5'); // paper spacing, mm
  const snapSp = () => page.evaluate(() => window.app.vp.gridSnapSpacing());
  const paperSp = await snapSp();
  const sp = await page.evaluate(() => [window.app.vp.settings.gridSpacing, window.app.vp.settings.gridPaperSpacing]);
  assert.deepEqual(sp, [10, 5], 'GRID on a layout sets the paper spacing, the model one is kept');
  const paperClient = (x, y) => page.evaluate(([x, y]) => {
    const vp = window.app.vp, v = vp.mspace ? { ...vp.mspace.paperView, width: vp.view.width, height: vp.view.height } : vp.view;
    const r = vp.canvas.getBoundingClientRect();
    return { x: r.left + v.width / 2 + (x - v.cx) * v.zoom, y: r.top + v.height / 2 - (y - v.cy) * v.zoom };
  }, [x, y]);
  const pIn = await paperClient(200, 150); await page.mouse.dblclick(pIn.x, pIn.y);
  assert.ok(await page.evaluate(() => !!window.app.vp.mspace), 'entered the viewport');
  assert.equal(await snapSp(), 10, 'MSPACE snaps in the model spacing');
  assert.notEqual(paperSp, 10, 'paper space snapped in paper units');
  await cmd('SNAP'); await cmd('2.5');
  assert.deepEqual(await page.evaluate(() => [window.app.vp.settings.gridSpacing, window.app.vp.settings.gridPaperSpacing, window.app.vp.settings.gridSnap]), [2.5, 5, true], 'SNAP in MSPACE sets the model spacing');
  const r = await page.evaluate(() => { const vp = window.app.vp, c = vp.toScreen({ x: 3.7, y: -1.1 }); return vp.resolve(c.x, c.y, { snap: false, from: null, gridSnap: true }).p; });
  assert.ok(Math.abs(r.x - 2.5) < 1e-9 && Math.abs(r.y + 0) < 1e-9, `MSPACE point snapped to the 2.5 model grid: ${JSON.stringify(r)}`);

  assert.deepEqual(problems, []);
  console.log(`grid e2e: OK (dot counts while zooming out: ${counts.join(', ')})`);
} catch (err) {
  console.error(`grid e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
