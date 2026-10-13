#!/usr/bin/env node
// Browser end-to-end test of POLYGON, SPLINE and DONUT typed at the command line like a user; same harness as run.mjs.
// Asserts on app.doc.entities after each step, that one U removes exactly what the step added, and that a donut renders filled.
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
  const ents = () => page.evaluate(() => JSON.parse(JSON.stringify([...window.app.doc.entities.values?.() ?? window.app.doc.entities])));
  const toolId = () => page.evaluate(() => window.app.toolId);
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
  /** the entities a step added, and one U removes exactly those */
  const added = async (before, run) => {
    const ids0 = new Set(before.map((e) => e.id));
    await run();
    const after = await ents();
    const fresh = after.filter((e) => !ids0.has(e.id));
    return { fresh, undo: async () => {
      await typeCmd('U');
      assert.deepEqual((await ents()).map((e) => e.id).sort(), [...ids0].sort(), 'one U removes exactly what the step added');
    } };
  };

  step = 'POL 6, centre 0,0, Inscribed, radius 10: one closed hexagon with every vertex 10 from the centre';
  {
    const { fresh, undo } = await added(await ents(), async () => { for (const s of ['POL', '6', '0,0', 'I', '10']) await typeCmd(s); });
    assert.equal(fresh.length, 1);
    const [p] = fresh;
    assert.equal(p.type, 'LWPOLYLINE'); assert.equal(p.closed, true); assert.equal(p.vertices.length, 6);
    for (const v of p.vertices) assert.ok(near(Math.hypot(v.x, v.y), 10), `vertex ${v.x},${v.y} at radius 10`);
    await undo();
  }

  step = 'POL, Enter keeps 6 sides, Edge 0,0 -> 10,0: hexagon with side 10';
  {
    const { fresh, undo } = await added(await ents(), async () => { await typeCmd('POL'); await typeCmd(''); for (const s of ['E', '0,0', '10,0']) await typeCmd(s); });
    assert.equal(fresh.length, 1);
    const [p] = fresh, v = p.vertices;
    assert.equal(p.type, 'LWPOLYLINE'); assert.equal(p.closed, true); assert.equal(v.length, 6);
    for (let i = 0; i < 6; i++) { const a = v[i], b = v[(i + 1) % 6]; assert.ok(near(Math.hypot(b.x - a.x, b.y - a.y), 10), `side ${i} is 10`); }
    assert.ok(v.some((q) => near(q.x, 0) && near(q.y, 0)) && v.some((q) => near(q.x, 10) && near(q.y, 0)), 'the edge endpoints are vertices');
    await undo();
  }

  step = 'SPL through four points, Enter: one open SPLINE with those fit points';
  {
    const pts = [[0, 0], [10, 5], [20, 0], [30, 5]];
    const { fresh, undo } = await added(await ents(), async () => { await typeCmd('SPL'); for (const [x, y] of pts) await typeCmd(`${x},${y}`); await typeCmd(''); });
    assert.equal(fresh.length, 1);
    const [s] = fresh;
    assert.equal(s.type, 'SPLINE'); assert.ok(!s.closed, 'open');
    assert.deepEqual(s.fit.map((q) => [q.x, q.y]), pts);
    await undo();
  }

  step = 'SPL, three points, U drops the last, one more point, C: closed SPLINE with three fit points';
  {
    const { fresh, undo } = await added(await ents(), async () => { await typeCmd('SPL'); for (const s of ['0,0', '10,0', '99,99', 'U', '5,8', 'C']) await typeCmd(s); });
    assert.equal(fresh.length, 1);
    const [s] = fresh;
    assert.equal(s.type, 'SPLINE'); assert.equal(s.closed, true);
    assert.deepEqual(s.fit.map((q) => [q.x, q.y]), [[0, 0], [10, 0], [5, 8]]);
    await page.keyboard.press('Escape');
    await undo();
  }

  step = 'DO 2, 4, two centres, Enter: two closed width-1 LWPOLYLINEs of two segments; a ring pixel is drawn in ink';
  {
    const { fresh, undo } = await added(await ents(), async () => { for (const s of ['DO', '2', '4', '50,50', '60,50', '']) await typeCmd(s); });
    assert.equal(fresh.length, 2);
    for (const p of fresh) { assert.equal(p.type, 'LWPOLYLINE'); assert.equal(p.closed, true); assert.equal(p.width, 1); assert.equal(p.vertices.length, 2); }
    assert.equal(await toolId(), 'select', 'Enter at the centre prompt ends DONUT');
    await typeCmd('ZE');
    const px = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const vp = window.app.vp, cv = vp.canvas, k = cv.width / cv.clientWidth, ctx = cv.getContext('2d');
      const at = (w) => { const s = vp.toScreen(w); return [...ctx.getImageData(Math.round(s.x * k), Math.round(s.y * k), 1, 1).data]; };
      res({ ring: at({ x: 51.5, y: 50 }), hole: at({ x: 50, y: 50 }), outside: at({ x: 55, y: 50 }) });
    }))));
    const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    assert.ok(diff(px.hole, px.outside) < 10, `the hole is background ${px.hole} vs ${px.outside}`);
    assert.ok(diff(px.ring, px.outside) > 150, `the ring is ink ${px.ring}, not background ${px.outside}`);
    await undo();
  }

  step = 'Escape mid-command leaves nothing behind and returns to Select';
  {
    const n0 = (await ents()).length;
    const cases = [['POL', '5', '0,0'], ['POL', '', 'E', '0,0'], ['SPL', '0,0', '10,0', '20,5'], ['DO', '1', '3']];
    for (const c of cases) {
      for (const s of c) await typeCmd(s);
      await page.keyboard.press('Escape');
      assert.equal(await toolId(), 'select', `${c.join(' ')} + one Escape returns to Select`);
      assert.equal((await ents()).length, n0, `${c.join(' ')} + Escape adds nothing`);
    }
  }

  assert.deepEqual(problems, []);
  console.log('draw2 e2e: OK');
} catch (err) {
  console.error(`draw2 e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
