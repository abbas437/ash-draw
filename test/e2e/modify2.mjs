#!/usr/bin/env node
// Browser end-to-end test of PEDIT, REVERSE and BREAKATPOINT (renderer/tools-modify2.js); same harness as run.mjs.
// Each step checks app.doc.entities, then one U must give back the entity list from before the step.
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
  const enter = () => typeCmd('');
  const clickWorld = async (x, y, opts = {}) => {
    const s = await page.evaluate(([a, b]) => window.app.vp.toScreen({ x: a, y: b }), [x, y]);
    const box = await page.locator('#cv').boundingBox();
    await page.mouse.click(box.x + s.x, box.y + s.y, opts);
  };
  const ents = () => page.evaluate(() => JSON.parse(JSON.stringify(window.app.doc.entities)));
  const shape = (list) => list.map((e) => e.type).sort().join(',');
  const toolId = () => page.evaluate(() => window.app.toolId);
  const line = async (a, b) => { await typeCmd('l'); await typeCmd(a); await typeCmd(b); await page.keyboard.press('Escape'); };
  const near = (p, x, y) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9;
  /** run a step: check the result, then U must give back the list from before (by type and count), then redo */
  const undoable = async (name, act, check) => {
    step = name;
    const before = await ents();
    await act();
    assert.equal(await toolId(), 'select', 'the command has ended');
    const after = await ents();
    check(after);
    await typeCmd('u');
    const undone = await ents();
    assert.equal(undone.length, before.length, 'one U restores the entity count');
    assert.equal(shape(undone), shape(before), 'one U restores the entity types');
    await typeCmd('redo');
    assert.equal(shape(await ents()), shape(after), 'redo gives the result back');
    return after;
  };
  const clear = async () => { await page.locator('#cv').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('Escape'); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); assert.equal((await ents()).length, 0); };

  // 1. a line turned into a polyline, then given a width
  step = 'draw a line';
  await line('0,0', '10,0'); await typeCmd('ze');
  await undoable('PE on a line: convert, W 2', async () => {
    await typeCmd('pe'); await clickWorld(5, 0); await enter(); await typeCmd('w'); await typeCmd('2'); await enter();
  }, (list) => {
    assert.equal(list.length, 1); assert.equal(list[0].type, 'LWPOLYLINE'); assert.equal(list[0].width, 2);
    assert.equal(list[0].vertices.length, 2);
  });

  // 2. three touching lines (the third drawn the other way) joined with PEDIT Multiple
  step = 'draw three lines'; await clear();
  await line('0,0', '10,0'); await line('10,0', '10,10'); await line('0,10', '10,10'); await typeCmd('ze');
  const joined = await undoable('PE M: convert and join three lines', async () => {
    await typeCmd('pe'); await typeCmd('m');
    await clickWorld(5, 0); await clickWorld(10, 5); await clickWorld(5, 10);
    assert.equal(await page.evaluate(() => window.app.vp.selection.size), 3, 'three objects selected');
    await enter(); await enter(); await typeCmd('j'); await typeCmd('0'); await enter();
  }, (list) => {
    assert.equal(list.length, 1); assert.equal(list[0].type, 'LWPOLYLINE');
    assert.equal(list[0].vertices.length, 4); assert.ok(!list[0].closed, 'open');
  });

  // 3. close it
  await undoable('PE C on the polyline', async () => {
    await typeCmd('pe'); await clickWorld(10, 5); await typeCmd('c'); await enter();
  }, (list) => {
    assert.equal(list.length, 1); assert.equal(list[0].id, joined[0].id); assert.equal(list[0].closed, true);
    assert.equal(list[0].vertices.length, 4);
  });

  // 3b. fit a curve through it: more vertices, with bulges; one U gives the straight square back exactly
  const square = (await ents())[0];
  await undoable('PE F on the polyline', async () => {
    await typeCmd('pe'); await clickWorld(10, 5); await typeCmd('f'); await enter();
  }, (list) => {
    assert.equal(list.length, 1); assert.equal(list[0].id, square.id);
    assert.equal(list[0].vertices.length, 2 * square.vertices.length, 'one extra vertex per segment (closed)');
    assert.ok(list[0].vertices.every((v) => Math.abs(v.bulge) > 1e-9), 'every segment is an arc');
  });
  step = 'U after PE F restores the vertices';
  await typeCmd('u');
  assert.deepEqual((await ents())[0].vertices, square.vertices);

  // 3c. Edit vertex: Next, Insert at 5,5 after vertex 1 of an open 3-segment polyline; one U gives it back
  step = 'draw a 3-segment polyline'; await clear();
  await typeCmd('pl'); for (const q of ['0,0', '10,0', '10,10', '0,10']) await typeCmd(q); await enter(); await typeCmd('ze');
  const open3 = (await ents())[0];
  assert.equal(open3.vertices.length, 4);
  await undoable('PE E N I 5,5 X', async () => {
    await typeCmd('pe'); await clickWorld(5, 0); await typeCmd('e'); await typeCmd('n'); await typeCmd('i'); await typeCmd('5,5');
    await typeCmd('x'); await enter();
  }, (list) => {
    assert.equal(list.length, 1); assert.equal(list[0].id, open3.id);
    assert.equal(list[0].vertices.length, 5); assert.ok(near(list[0].vertices[2], 5, 5), 'the new vertex follows vertex 1');
  });
  step = 'U after PE E I restores the vertices';
  await typeCmd('u');
  assert.deepEqual((await ents())[0].vertices, open3.vertices);

  // 4. break a line at a typed point
  step = 'draw a line for BREAKATPOINT'; await clear();
  await line('0,20', '10,20'); await typeCmd('ze');
  const broken = await undoable('BREAKATPOINT at 5,20', async () => {
    await typeCmd('breakatpoint'); await clickWorld(2, 20); await typeCmd('5,20');
  }, (list) => {
    assert.equal(list.length, 2); assert.deepEqual(list.map((e) => e.type), ['LINE', 'LINE']);
    const pts = list.flatMap((e) => [e.p1, e.p2]);
    assert.equal(pts.filter((p) => near(p, 5, 20)).length, 2, 'the two lines meet at 5,20');
    assert.ok(pts.some((p) => near(p, 0, 20)) && pts.some((p) => near(p, 10, 20)), 'the ends stay');
  });

  // 5. reverse one of them
  const left = broken.find((e) => near(e.p1, 0, 20) || near(e.p2, 0, 20));
  await undoable('REVERSE a line', async () => {
    await typeCmd('reverse'); await clickWorld(2, 20); await enter();
  }, (list) => {
    assert.equal(list.length, 2);
    const e = list.find((x) => x.id === left.id);
    assert.ok(near(e.p1, left.p2.x, left.p2.y) && near(e.p2, left.p1.x, left.p1.y), 'start and end swapped');
  });

  assert.deepEqual(problems, []);
  console.log('modify2 e2e: OK');
} catch (err) {
  console.error(`modify2 e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
