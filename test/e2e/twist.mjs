#!/usr/bin/env node
// Browser end-to-end test of the twisted model view (VPORT *Active group 51): the Model tab opens turned, drawing and
// window / crossing selection follow the screen, View > Plan view (no twist) / Saved view orientation, and Save keeps
// the twist and the view centre. Same harness as run.mjs (headless Chromium, browser fallback of window.api).
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

// Two lines: a long one along world +x and a short one well away from it. The saved view is turned 90 degrees and
// centred on the extents centre (50, 30): with target 17/27 = 0, 12/22 is the centre in the twisted frame
// (cx = ct dx + st dy, cy = -st dx + ct dy, so dx = -30, dy = 50).
const LONG = [0, 0, 100, 0], SHORT = [50, 60, 55, 60], CENTRE = { x: 50, y: 30 };
const dxf = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'VPORT', '70', '1', '0', 'VPORT', '2', '*Active', '70', '0',
  '12', '-30', '22', '50', '16', '0', '26', '0', '36', '1', '17', '0', '27', '0', '40', '140', '41', '1.6', '51', '90',
  '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
  ...[LONG, SHORT].flatMap(([a, b, c, d]) => ['0', 'LINE', '8', '0', '10', a, '20', b, '30', '0', '11', c, '21', d, '31', '0'].map(String)),
  '0', 'ENDSEC', '0', 'EOF', ''].join('\n');

const problems = [];
let step = 'start';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.vp && window.app.doc, null, { timeout: 10000 });

  // one permanent 'filechooser' listener, as run.mjs: page.once() per dialog sometimes loses the chooser
  let chooserWaiter = null;
  page.on('filechooser', (c) => { const w = chooserWaiter; chooserWaiter = null; w?.(c); });
  const openText = async (name, buffer) => {
    const chooser = new Promise((r) => { chooserWaiter = r; });
    await page.keyboard.press('Control+o');
    await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
    await page.waitForFunction((n) => window.app.file.name === n, name, { timeout: 8000 });
  };
  const menu = async (top, item) => { await page.locator('#menubar .menu > button', { hasText: top }).click(); await page.locator('#menubar .drop button', { hasText: item }).click(); };
  const typeCmd = async (text) => { await page.locator('#cmd').fill(text); await page.locator('#cmd').press('Enter'); };
  const rot = () => page.evaluate(() => window.app.vp.view.rot || 0);
  const toScreen = (x, y) => page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
  const box = await page.locator('#cv').boundingBox();
  const drag = async (a, b) => { await page.mouse.move(box.x + a.x, box.y + a.y); await page.mouse.down(); await page.mouse.move(box.x + (a.x + b.x) / 2, box.y + (a.y + b.y) / 2, { steps: 3 }); await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 3 }); await page.mouse.up(); };
  const selected = () => page.evaluate(() => [...window.app.vp.selection]);
  const idOf = (pts) => page.evaluate((p) => window.app.doc.entities.find((e) => e.type === 'LINE' && e.p1.x === p[0] && e.p1.y === p[1] && e.p2.x === p[2] && e.p2.y === p[3])?.id, pts);
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
  const longOnScreen = async () => ({ a: await toScreen(LONG[0], LONG[1]), b: await toScreen(LONG[2], LONG[3]) });

  step = 'open a drawing saved with a 90 degree model view twist: the Model tab opens turned';
  await openText('twist.dxf', Buffer.from(dxf));
  await page.waitForFunction(() => window.app.doc.entities.length === 2, null, { timeout: 8000 });
  near(await rot(), Math.PI / 2, 1e-9, 'view rot after open');
  const opened = await page.evaluate(() => ({ cx: window.app.vp.view.cx, cy: window.app.vp.view.cy }));
  near(opened.cx, CENTRE.x, 1e-6, 'opened view centre x'); near(opened.cy, CENTRE.y, 1e-6, 'opened view centre y');
  {
    const { a, b } = await longOnScreen();
    near(a.x, b.x, 0.5, 'the world-horizontal line is vertical on screen (x)');
    assert.ok(a.y - b.y > 50, `world +x points up the screen: ${JSON.stringify([a, b])}`);
  }
  const longId = await idOf(LONG), shortId = await idOf(SHORT);
  assert.ok(longId != null && shortId != null, 'fixture lines found');

  step = 'Line tool: clicked screen points become the line ends (vp.toWorld of the clicks)';
  const W = box.width, H = box.height, c1 = { x: Math.round(W * 0.82), y: Math.round(H * 0.18) }, c2 = { x: Math.round(W * 0.9), y: Math.round(H * 0.3) };
  {
    const n = await page.evaluate(() => window.app.doc.entities.length);
    await typeCmd('l');
    await page.mouse.click(box.x + c1.x, box.y + c1.y); await page.mouse.click(box.x + c2.x, box.y + c2.y);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); // end the chain, then back to Select
    const r = await page.evaluate(([p, q]) => { const vp = window.app.vp, d = window.app.doc; return { n: d.entities.length, e: d.entities.at(-1), w1: vp.toWorld(p.x, p.y), w2: vp.toWorld(q.x, q.y) }; }, [c1, c2]);
    assert.equal(r.n, n + 1, 'one line added');
    assert.equal(r.e.type, 'LINE');
    const tol = 1e-6 * 140;
    near(r.e.p1.x, r.w1.x, tol, 'start x'); near(r.e.p1.y, r.w1.y, tol, 'start y');
    near(r.e.p2.x, r.w2.x, tol, 'end x'); near(r.e.p2.y, r.w2.y, tol, 'end y');
    assert.equal(await page.evaluate(() => window.app.toolId), 'select');
  }

  step = 'window selection (left to right) by the screen rectangle selects only the short line';
  {
    const s1 = await toScreen(SHORT[0], SHORT[1]), s2 = await toScreen(SHORT[2], SHORT[3]);
    const lo = { x: Math.min(s1.x, s2.x) - 15, y: Math.min(s1.y, s2.y) - 15 }, hi = { x: Math.max(s1.x, s2.x) + 15, y: Math.max(s1.y, s2.y) + 15 };
    await drag(lo, hi);
    assert.deepEqual(await selected(), [shortId], 'window over the short line');
    await page.keyboard.press('Escape');
    assert.deepEqual(await selected(), []);
  }
  step = 'over part of the long line: a left-to-right window selects nothing, a right-to-left crossing selects it';
  {
    const m = await toScreen(50, 0), l = { x: m.x - 20, y: m.y - 10 }, r = { x: m.x + 20, y: m.y + 10 };
    await drag(l, r);
    assert.deepEqual(await selected(), [], 'window that only crosses the long line');
    await drag({ x: r.x, y: l.y }, { x: l.x, y: r.y });
    assert.deepEqual(await selected(), [longId], 'crossing over part of the long line');
    await page.keyboard.press('Escape');
  }

  step = 'View > Plan view (no twist): rot 0 and the long line is horizontal on screen';
  await menu('View', 'Plan view (no twist)');
  assert.equal(await rot(), 0);
  {
    const { a, b } = await longOnScreen();
    near(a.y, b.y, 0.5, 'the long line is horizontal on screen (y)');
    assert.ok(b.x - a.x > 50, `world +x points right: ${JSON.stringify([a, b])}`);
  }

  step = 'View > Saved view orientation turns it back';
  await menu('View', 'Saved view orientation');
  near(await rot(), Math.PI / 2, 1e-9, 'view rot after Saved view orientation');

  step = 'save, reopen: the twist and the view centre survive';
  await page.keyboard.press('Control+z'); // take the drawn line out again, so the saved extents are the fixture's
  assert.equal(await page.evaluate(() => window.app.doc.entities.length), 2);
  {
    const dl = page.waitForEvent('download');
    await page.evaluate(() => window.app.saveAs('dxf'));
    const saved = await fs.readFile(await (await dl).path());
    await page.evaluate(() => window.app.newDrawing(true));
    assert.equal(await rot(), 0, 'a new drawing is not turned');
    await openText('twist-saved.dxf', saved);
    await page.waitForFunction(() => window.app.doc.entities.length === 2, null, { timeout: 8000 });
    near(await rot(), Math.PI / 2, 1e-9, 'view rot after save and reopen');
    const v = await page.evaluate(() => ({ cx: window.app.vp.view.cx, cy: window.app.vp.view.cy }));
    near(v.cx, opened.cx, 1e-3, 'reopened view centre x'); near(v.cy, opened.cy, 1e-3, 'reopened view centre y');
    const { a, b } = await longOnScreen();
    near(a.x, b.x, 0.5, 'reopened: the long line is vertical on screen');
  }

  assert.deepEqual(problems, []);
  console.log('TWIST OK');
} catch (err) {
  console.error(`twist e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
