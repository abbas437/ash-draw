#!/usr/bin/env node
// Browser end-to-end test of XCLIP typed at the command line like a user (New boundary rectangular / polygonal, OFF, ON, Delete, Undo, Escape); same harness as run.mjs.
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
  const toolId = () => page.evaluate(() => window.app.toolId);
  const prompt = () => page.evaluate(() => window.app.tool.prompt);
  const clip = () => page.evaluate(() => window.app.doc.entities.find((e) => e.type === 'INSERT').clip ?? null);
  // every vertex the scene draws for the insert (clip frame left out), and the frame count
  const sceneOf = () => page.evaluate(() => {
    const vp = window.app.vp, id = window.app.doc.entities.find((e) => e.type === 'INSERT').id, out = [];
    const items = vp.scene.items.filter((it) => it.id === id);
    for (const it of items) {
      if (it.kind === 'clipFrame') continue;
      const o = it.ops;
      for (let i = 0; i < o.length;) { if (o[i] <= 1) { out.push([o[i + 1], o[i + 2]]); i += 3; } else i += o[i] === 2 ? 6 : o[i] === 3 ? 8 : 1; }
    }
    return { pts: out, frames: items.filter((it) => it.kind === 'clipFrame').length };
  });
  const inBox = (pts, x0, y0, x1, y1) => pts.every(([x, y]) => x >= x0 - 1e-6 && x <= x1 + 1e-6 && y >= y0 - 1e-6 && y <= y1 + 1e-6);
  // ink at world points: the largest colour difference from the background in a 5x5 pixel patch around each point
  const ink = (pts) => page.evaluate((pts) => new Promise((res) => { window.app.vp.requestRender(); requestAnimationFrame(() => requestAnimationFrame(() => {
    const vp = window.app.vp, cv = vp.canvas, k = cv.width / cv.clientWidth, ctx = cv.getContext('2d');
    const px = (w) => { const s = vp.toScreen(w); return ctx.getImageData(Math.round(s.x * k) - 2, Math.round(s.y * k) - 2, 5, 5).data; };
    const bg = px({ x: 87.5, y: 87.5 }).slice(0, 3);
    res(pts.map((w) => { const d = px(w); let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2])); return m > 150; }));
  })); }), pts);
  const OUT = [{ x: 90, y: 50 }, { x: 50, y: 90 }], IN = { x: 50, y: 40 };

  step = 'define block GRID (lines every 25 units over 0..100) and insert it at the origin, plus a loose LINE';
  await page.evaluate(async () => {
    const B = await import('/src/core/blocks.js'), M = await import('/src/core/model.js');
    const ents = [];
    for (let v = 0; v <= 100; v += 25) ents.push(M.makeLine({ x: 0, y: v }, { x: 100, y: v }), M.makeLine({ x: v, y: 0 }, { x: v, y: 100 }));
    const blk = { name: 'GRID', base: { x: 0, y: 0 }, entities: ents };
    window.app.session.transact('Setup', (tx) => { tx.block('GRID', blk); tx.add(B.instantiate(blk, { x: 0, y: 0 })); tx.add(M.makeLine({ x: 0, y: -20 }, { x: 100, y: -20 })); });
  });
  await typeCmd('ZE');
  assert.deepEqual(await ink([...OUT, IN]), [true, true, true], 'the whole grid is drawn');

  step = 'select the insert and the line, XCLIP, Enter (New), Enter (Rectangular), two corners: the insert is cut to the box';
  await page.evaluate(() => window.app.vp.setSelection(window.app.doc.entities.map((e) => e.id)));
  await typeCmd('XCLIP');
  assert.equal(await toolId(), 'xclip');
  assert.match(await prompt(), /Enter clipping option \[ON\/OFF\/Delete\/New boundary\] <New>:/);
  await typeCmd('');
  assert.match(await prompt(), /\[Select polyline\/Polygonal\/Rectangular\/Invert clip\] <Rectangular>:/);
  await typeCmd('');
  await typeCmd('20,20');
  await typeCmd('60,60');
  assert.equal(await toolId(), 'select');
  assert.deepEqual(await clip(), { pts: [{ x: 20, y: 20 }, { x: 60, y: 60 }], enabled: true, inverted: false, showFrame: true });
  assert.equal(await page.evaluate(() => window.app.doc.entities[1].clip), undefined, 'the LINE is left alone');
  let sc = await sceneOf();
  assert.ok(sc.pts.length > 0 && inBox(sc.pts, 20, 20, 60, 60), `no geometry outside the box: ${JSON.stringify(sc.pts)}`);
  assert.equal(sc.frames, 1);
  assert.deepEqual(await ink([...OUT, IN]), [false, false, true], 'outside the box nothing is drawn; inside it is');

  step = 'XCLIP OFF: the whole block is drawn again';
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('XC'); await typeCmd('OFF');
  assert.equal(await toolId(), 'select');
  assert.equal((await clip()).enabled, false);
  sc = await sceneOf();
  assert.ok(!inBox(sc.pts, 20, 20, 60, 60) && inBox(sc.pts, 0, 0, 100, 100) && sc.frames === 0);
  assert.deepEqual(await ink([...OUT, IN]), [true, true, true]);

  step = 'XCLIP ON: clipped again; U undoes the ON in one step';
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('XCLIP'); await typeCmd('on');
  assert.equal((await clip()).enabled, true);
  assert.ok(inBox((await sceneOf()).pts, 20, 20, 60, 60));
  await typeCmd('U');
  assert.equal((await clip()).enabled, false, 'U restores OFF');
  await typeCmd('REDO');
  assert.equal((await clip()).enabled, true);

  step = 'XCLIP Delete removes the clip; U brings it back; Delete again';
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('XCLIP'); await typeCmd('D');
  assert.equal(await clip(), null);
  assert.deepEqual(await ink([...OUT, IN]), [true, true, true]);
  await typeCmd('U');
  assert.equal((await clip())?.enabled, true);
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('XCLIP'); await typeCmd('delete');
  assert.equal(await clip(), null);

  step = 'XCLIP with no selection: pick the insert, Enter, New, Polygonal, 4 points, Enter: a diamond clip';
  await typeCmd('XCLIP');
  assert.equal(await toolId(), 'xclip');
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('');
  assert.match(await prompt(), /<New>:/);
  await typeCmd('N'); await typeCmd('P');
  for (const s of ['50,10', '90,50', '50,90', '10,50']) await typeCmd(s);
  assert.equal(await toolId(), 'xclip', 'still collecting points');
  await typeCmd('');
  assert.equal(await toolId(), 'select');
  assert.deepEqual((await clip()).pts, [{ x: 50, y: 10 }, { x: 90, y: 50 }, { x: 50, y: 90 }, { x: 10, y: 50 }]);
  sc = await sceneOf();
  assert.ok(sc.pts.length > 0 && sc.pts.every(([x, y]) => Math.abs(x - 50) + Math.abs(y - 50) <= 40 + 1e-6), 'all geometry inside the diamond');
  assert.deepEqual(await ink([{ x: 87.5, y: 25 }, { x: 50, y: 75 }]), [false, true], 'corner of the grid hidden, inside kept');

  step = 'New on a clipped insert asks to delete the old boundary; No ends with no change';
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  await typeCmd('XCLIP'); await typeCmd('N');
  assert.match(await prompt(), /Delete old boundary\? \[Yes\/No\] <Yes>:/);
  await typeCmd('No');
  assert.equal(await toolId(), 'select');
  assert.equal((await clip()).pts.length, 4);

  step = 'Escape at every step leaves the clip unchanged and returns to Select';
  const before = JSON.stringify(await clip());
  const undoDepth = () => page.evaluate(() => window.app.session.undoStack.length);
  const d0 = await undoDepth();
  for (const c of [[], [''], ['', ''], ['', '', 'R'], ['', '', 'R', '0,0'], ['', '', 'P', '0,0', '100,0', '100,100'], ['', '', 'S'], ['', '', 'I']]) {
    await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
    await typeCmd('XCLIP');
    for (const s of c) await typeCmd(s);
    assert.equal(await toolId(), 'xclip', `still in XCLIP after ${JSON.stringify(c)}`);
    await page.keyboard.press('Escape');
    assert.equal(await toolId(), 'select', `${JSON.stringify(c)} + Escape returns to Select`);
    assert.equal(JSON.stringify(await clip()), before, `${JSON.stringify(c)} + Escape changes nothing`);
  }
  assert.equal(await undoDepth(), d0, 'no undo step added');

  step = 'Rectangular on a 90-degree rotated insert keeps a 2-point clip in block coordinates; the replaced clip undoes in one U';
  await page.evaluate(() => window.app.session.transact('Rotate', (tx) => tx.replace({ ...structuredClone(window.app.doc.entities[0]), rot: 90 })));
  await page.evaluate(() => window.app.vp.setSelection([window.app.doc.entities[0].id]));
  for (const s of ['XCLIP', '', '', '', '-60,20', '-20,60']) await typeCmd(s);
  assert.deepEqual((await clip()).pts.map((p) => ({ x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 })), [{ x: 20, y: 20 }, { x: 60, y: 60 }]);
  await typeCmd('U');
  assert.equal((await clip()).pts.length, 4, 'U restores the diamond');

  assert.deepEqual(problems, []);
  console.log('xclip e2e: OK');
} catch (err) {
  console.error(`xclip e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
