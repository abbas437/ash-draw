#!/usr/bin/env node
// Browser end-to-end test: a pan or wheel zoom on a layout (paper space, and MSPACE through an unlocked and a locked
// viewport) shows the cached sheet bitmap shifted / scaled, so its frames do not redraw the viewports; one full sheet
// render follows when the gesture settles, and that picture equals a forced full redraw. Same harness as layoutcursor.mjs.
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

  step = 'a drawing of 2000 lines, a layout with two viewports showing them';
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
    window.app.installDoc(doc, { path: null, name: 'layoutpan.dxf', format: 'dxf' });
    window.__paths = 0;
    for (const m of ['lineTo', 'moveTo']) { const f = CanvasRenderingContext2D.prototype[m]; CanvasRenderingContext2D.prototype[m] = function (...a) { window.__paths++; return f.apply(this, a); }; }
    window.__snaps = {};
  });
  await page.click('#spacebar button[data-space="Layout1"]');
  assert.equal(await page.evaluate(() => window.app.vp.layout?.name), 'Layout1');
  const frames = (n = 3) => page.evaluate((n) => new Promise((res) => { const f = () => (n-- <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  await frames();

  const client = (x, y) => page.evaluate(([x, y]) => {
    const vp = window.app.vp, v = vp.mspace ? { ...vp.mspace.paperView, width: vp.view.width, height: vp.view.height } : vp.view, r = vp.canvas.getBoundingClientRect();
    return { x: r.left + v.width / 2 + (x - v.cx) * v.zoom, y: r.top + v.height / 2 - (y - v.cy) * v.zoom };
  }, [x, y]);
  const counters = () => page.evaluate(() => ({ draws: window.app.vp.sheetDraws ?? 0, paths: window.__paths, gesture: window.app.vp._gesture }));
  /** keep the canvas as it is now (cursor overlays off) under `name`; full: drop the cached sheet first (a forced full redraw) */
  const snap = (name, full = false) => page.evaluate(([name, full]) => {
    const vp = window.app.vp; vp.showCross = false; vp.snapMarker = null;
    if (full) vp._frame = null;
    vp.render();
    window.__snaps[name] = vp.canvas.getContext('2d').getImageData(0, 0, vp.canvas.width, vp.canvas.height).data.slice();
  }, [name, full]);
  /** share of pixels that differ between two snaps; block > 1: share of block x block squares whose mean brightness
   *  differs by more than 16 (a scaled bitmap is resampled, so its pixels differ from a fresh render at every line) */
  const differ = (a, b, block = 1) => page.evaluate(([a, b, B]) => {
    const p = window.__snaps[a], q = window.__snaps[b], W = window.app.vp.canvas.width, H = window.app.vp.canvas.height;
    if (B === 1) { let n = 0; for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) n++; return n / (p.length / 4); }
    let n = 0, all = 0;
    for (let by = 0; by + B <= H; by += B) for (let bx = 0; bx + B <= W; bx += B) {
      let s = 0;
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) { const i = (y * W + x) * 4; s += p[i] + p[i + 1] + p[i + 2] - q[i] - q[i + 1] - q[i + 2]; }
      all++; if (Math.abs(s) / (3 * B * B) > 16) n++;
    }
    return n / all;
  }, [a, b, block]);
  const settled = () => page.waitForFunction(() => !window.app.vp._gesture, null, { timeout: 5000 }).then(() => frames());

  /** a middle-button drag from paper point `from` by (dx, dy) CSS pixels in `n` moves, then the settle; returns what the
   *  gesture frames drew and how the gesture frame compares with the settled picture */
  const pan = async (label, from, dx, dy, n = 8) => {
    await snap(`${label}0`);
    const p = await client(...from);
    await page.mouse.move(p.x, p.y); await frames(1);
    const c0 = await counters();
    await page.mouse.down({ button: 'middle' });
    for (let i = 1; i <= n; i++) { await page.mouse.move(p.x + (dx * i) / n, p.y + (dy * i) / n); await frames(1); }
    const c1 = await counters();
    await snap(`${label}g`);
    await page.mouse.up({ button: 'middle' });
    return gestureEnd(label, c0, c1);
  };
  /** `n` wheel notches at paper point `at` (deltaY < 0 zooms in), a frame apart, then the settle */
  const wheel = async (label, at, deltaY, n = 4) => {
    await snap(`${label}0`);
    const p = await client(...at);
    await page.mouse.move(p.x, p.y); await frames(1);
    const c0 = await counters();
    for (let i = 0; i < n; i++) { await page.mouse.wheel(0, deltaY); await frames(1); }
    const c1 = await counters();
    await snap(`${label}g`);
    return gestureEnd(label, c0, c1);
  };
  const gestureEnd = async (label, c0, c1) => {
    assert.ok(c1.gesture, `${label}: still in the gesture when sampled`);
    await settled();
    const c2 = await counters();
    await snap(`${label}s`); await snap(`${label}f`, true);
    const r = { during: c1.draws - c0.draws, paths: c1.paths - c0.paths, settle: c2.draws - c1.draws, fresh: await differ(`${label}s`, `${label}f`), moved: await differ(`${label}0`, `${label}s`, 8), approx: await differ(`${label}g`, `${label}s`, 8) };
    assert.equal(r.during, 0, `${label}: the gesture frames redrew the sheet ${r.during} times (path calls ${r.paths})`);
    assert.ok(r.paths < 500, `${label}: path calls during the gesture ${r.paths} (a sheet redraw makes > 4000)`);
    assert.equal(r.settle, 1, `${label}: one full sheet render when the gesture settles`);
    assert.equal(r.fresh, 0, `${label}: the settled picture equals a forced full redraw`);
    assert.ok(r.moved > 0.02, `${label}: the view moved (${r.moved})`);
    assert.ok(r.approx < r.moved / 2, `${label}: the gesture frame shows the moved sheet (differs ${r.approx} from the settled one, the start ${r.moved})`);
    return `${label} ${r.paths} paths, approx ${(r.approx * 100).toFixed(1)}%`;
  };

  const out = [];
  step = 'paper space: middle-button pan';
  out.push(await pan('paper pan', [210, 140], 120, 60));
  step = 'paper space: wheel zoom in';
  out.push(await wheel('paper zoom', [110, 140], -100));

  step = 'MSPACE in the right viewport: pan and wheel zoom move the model inside it';
  await page.evaluate(() => window.app.zoomExtents?.() ?? window.app.vp.zoomExtents()); await frames();
  const c = await client(310, 140); await page.mouse.dblclick(c.x, c.y); await frames();
  assert.ok(await page.evaluate(() => window.app.vp.mspace?.vp.vpId === 3 && !window.app.vp.mspace.vp.locked), 'in MSPACE, right viewport, unlocked');
  await page.waitForTimeout(500); // no double middle click with the dblclick above
  out.push(await pan('mspace pan', [300, 150], -90, 40));
  out.push(await wheel('mspace zoom', [330, 120], -100, 3));

  step = 'MSPACE in a locked viewport: a pan moves the paper';
  await page.evaluate(() => { window.app.vp.mspace.vp.locked = true; });
  await page.waitForTimeout(500);
  out.push(await pan('locked pan', [300, 150], 70, -50));

  assert.deepEqual(problems, []);
  console.log(`layoutpan e2e: OK (${out.join('; ')})`);
} catch (err) {
  console.error(`layoutpan e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
