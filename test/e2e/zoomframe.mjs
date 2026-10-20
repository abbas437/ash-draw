#!/usr/bin/env node
// Browser end-to-end test: a wheel zoom on a large drawing never shows a blank canvas.
// (Review #6, large DXF: the canvas went blank for 1-2 s after a wheel zoom while the new view was drawn progressively.)
//  1. 200,000 lines (drawn progressively, viewport.js PROGRESSIVE_ITEMS) and a red square drawn last. A burst of wheel
//     steps about a cursor point; every animation frame until the new view is finished is sampled: each canvas tile
//     that has drawing in the finished frame has drawing in every intermediate frame, and the red square is where the
//     current view shows it (the last frame scaled about the cursor, accumulated over the burst).
//  2. The finished frame equals a redraw of the same view from scratch.
// Prints "zoomframe e2e: OK".
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
  const file = path.join(ROOT, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const problems = [];
let step = 'start';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  step = '200,000 short lines in rows (drawn bottom row first) and a red square drawn last';
  await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    for (let i = 0; i < 200000; i++) {
      const x = (i % 500) * 1, y = Math.floor(i / 500) * 1;
      M.addEntity(doc, M.makeLine({ x, y }, { x: x + 0.7, y: y + 0.7 }));
    }
    M.addEntity(doc, M.makeHatch([{ closed: true, pts: [[230, 180], [250, 180], [250, 200], [230, 200]].map(([x, y]) => ({ x, y, bulge: 0 })) }], { color: 1 }));
    const vp = window.app.vp;
    vp.settings.grid = false;
    window.app.installDoc(doc, { path: null, name: 'zoomframe.dxf', format: 'dxf' });
  });
  const settled = () => page.waitForFunction(() => { const vp = window.app.vp, f = vp._frame; return !vp.drawing && !vp._gesture && f?.exact && f.view.cx === vp.view.cx && f.view.cy === vp.view.cy && f.view.zoom === vp.view.zoom; }, null, { timeout: 60000 });
  await settled();
  assert.ok(await page.evaluate(() => window.app.vp.scene.items.length >= 200000), 'a progressive-size scene');

  step = 'a burst of wheel steps about a cursor point: every frame until the new view is finished is sampled';
  const r = await page.evaluate(() => new Promise((done) => {
    const vp = window.app.vp, cv = vp.canvas, ctx = vp.ctx, d = vp.dpr;
    const bg = vp.sceneOpts().background, BG = [parseInt(bg.slice(1, 3), 16), parseInt(bg.slice(3, 5), 16), parseInt(bg.slice(5, 7), 16)];
    const T = 8; // T x T tiles
    // the view the canvas shows: vp.view moves at the wheel event, the canvas at the next render
    let shown = { ...vp.view };
    const render = vp.render;
    vp.render = function (...a) { shown = { ...this.view }; return render.apply(this, a); };
    const sample = () => {
      const { width: W, height: H } = cv, px = ctx.getImageData(0, 0, W, H).data, tiles = new Array(T * T).fill(0);
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (Math.abs(px[i] - BG[0]) + Math.abs(px[i + 1] - BG[1]) + Math.abs(px[i + 2] - BG[2]) > 30) tiles[Math.floor(y * T / H) * T + Math.floor(x * T / W)]++;
      }
      const c = { x: (240 - shown.cx) * shown.zoom + shown.width / 2, y: shown.height / 2 - (190 - shown.cy) * shown.zoom }, j = (Math.round(c.y * d) * W + Math.round(c.x * d)) * 4;
      let red = 0; // red-dominant pixels in the 5 x 5 pixels about the square's centre
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const k = j + (dy * W + dx) * 4; if (px[k] > 200 && px[k + 1] < 160 && px[k + 2] < 160) red++; }
      return { tiles, red: red >= 10, drawing: vp.drawing, gesture: vp._gesture, zoom: shown.zoom };
    };
    const r = cv.getBoundingClientRect(), at = vp.toScreen({ x: 200, y: 160 }), cx = r.left + at.x, cy = r.top + at.y; // near the red square, clear of it (the crosshair is drawn at the cursor)
    const frames = [];
    let wheels = 0;
    const wheel = () => {
      cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, deltaMode: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      if (++wheels < 4) setTimeout(wheel, 40);
    };
    const t0 = performance.now();
    const tick = () => {
      const s = sample(), f = vp._frame;
      const finished = wheels === 4 && !vp.drawing && !vp._gesture && f?.exact && f.view.zoom === vp.view.zoom && f.view.cx === vp.view.cx && f.view.cy === vp.view.cy;
      // the finished frame: rendered now (the job may have finished after the last render)
      if (finished || performance.now() - t0 > 30000) { if (wheels) frames.push(s); vp.render(); const last = sample(); vp.render = render; done({ frames, last, finished, zoom0: z0, zoom: vp.view.zoom }); return; }
      if (wheels) frames.push(s);
      requestAnimationFrame(tick);
    };
    const z0 = vp.view.zoom;
    requestAnimationFrame(() => { wheel(); requestAnimationFrame(tick); });
  }));
  assert.ok(r.finished, 'the new view was finished');
  assert.ok(r.zoom > r.zoom0 * 1.3, `zoomed in over the burst (${r.zoom0} -> ${r.zoom})`);
  const prog = r.frames.filter((f) => f.drawing).length, scaled = r.frames.filter((f) => f.gesture === 'zoom').length;
  assert.ok(prog >= 2, `frames sampled while the new view was drawn progressively: ${prog} (of ${r.frames.length})`);
  assert.ok(scaled >= 2, `frames sampled during the wheel burst: ${scaled}`);
  const content = r.last.tiles.map((n) => n > 0);
  assert.ok(content.filter(Boolean).length >= 40, `the finished frame has drawing in most tiles: ${r.last.tiles}`);
  assert.ok(r.last.red, 'the red square in the finished frame');
  r.frames.forEach((f, k) => {
    const blank = f.tiles.map((n, i) => (content[i] && n === 0 ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(blank, [], `frame ${k} (${f.drawing ? 'progressive' : f.gesture ?? 'direct'}, zoom ${f.zoom}): tiles blank where the drawing is`);
    assert.ok(f.red, `frame ${k} (${f.drawing ? 'progressive' : f.gesture ?? 'direct'}): the red square is not where the view shows it`);
  });
  console.log(`  ${r.frames.length} frames sampled: ${scaled} during the burst, ${prog} while drawing progressively`);

  step = 'the finished frame equals a redraw of the same view from scratch';
  const pixels = () => page.evaluate(() => { const vp = window.app.vp; vp.render(); const a = vp.ctx.getImageData(0, 0, vp.canvas.width, vp.canvas.height).data; let h = 0; for (let i = 0; i < a.length; i++) h = (h * 31 + a[i]) | 0; return h; });
  const zoomed = await pixels();
  await page.evaluate(() => window.app.vp.invalidate());
  await settled();
  assert.equal(await pixels(), zoomed);

  assert.deepEqual(problems, []);
  console.log('zoomframe e2e: OK');
} catch (err) {
  console.error(`zoomframe e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
