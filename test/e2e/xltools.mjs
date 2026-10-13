#!/usr/bin/env node
// Browser end-to-end test of XLINE (point, Hor, Bisect, Offset) and RAY typed at the command line like a user; same harness
// as run.mjs. Asserts on app.doc.entities, that one U removes exactly what each command run added, and that ZE ignores them.
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
  const H = Math.SQRT1_2;
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
  const dirIs = (e, x, y) => assert.ok(near(e.dir.x, x) && near(e.dir.y, y), `dir ${e.dir.x},${e.dir.y} is ${x},${y}`);
  /** the entities a command run added, and one U removes exactly those */
  const added = async (before, run) => {
    const ids0 = new Set(before.map((e) => e.id));
    await run();
    const after = await ents();
    const fresh = after.filter((e) => !ids0.has(e.id));
    return { fresh, undo: async () => {
      await typeCmd('U');
      assert.deepEqual((await ents()).map((e) => e.id).sort(), [...ids0].sort(), 'one U removes exactly what the run added');
    } };
  };
  /** a real mouse click at world point w */
  const clickWorld = async (w) => {
    const s = await page.evaluate((q) => { const vp = window.app.vp, r = vp.canvas.getBoundingClientRect(), s = vp.toScreen(q); return { x: r.left + s.x, y: r.top + s.y, in: s.x > 0 && s.y > 0 && s.x < r.width && s.y < r.height }; }, w);
    assert.ok(s.in, `${w.x},${w.y} is on screen`);
    await page.mouse.click(s.x, s.y);
  };

  step = 'XL 0,0 then through 10,10 and 10,0, Enter: two XLINEs through 0,0 at 45 and 0 degrees';
  {
    const { fresh, undo } = await added(await ents(), async () => { for (const s of ['XL', '0,0', '10,10', '10,0', '']) await typeCmd(s); });
    assert.equal(fresh.length, 2);
    for (const e of fresh) { assert.equal(e.type, 'XLINE'); assert.ok(near(e.p.x, 0) && near(e.p.y, 0), 'through 0,0'); }
    dirIs(fresh[0], H, H); dirIs(fresh[1], 1, 0);
    assert.equal(await toolId(), 'select', 'Enter ends XLINE');
    await undo();
  }

  step = 'XL H through 0,5, Enter: one horizontal XLINE at y = 5';
  {
    const { fresh, undo } = await added(await ents(), async () => { for (const s of ['XL', 'H', '0,5', '']) await typeCmd(s); });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].type, 'XLINE'); dirIs(fresh[0], 1, 0); assert.ok(near(fresh[0].p.y, 5));
    await undo();
  }

  step = 'XL B vertex 0,0, start 10,0, end 0,10, Enter: the bisector XLINE through 0,0 at 45 degrees';
  {
    const { fresh, undo } = await added(await ents(), async () => { for (const s of ['XL', 'B', '0,0', '10,0', '0,10', '']) await typeCmd(s); });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].type, 'XLINE'); dirIs(fresh[0], H, H); assert.ok(near(fresh[0].p.x, 0) && near(fresh[0].p.y, 0));
    await undo();
  }

  step = 'XL O 5, click a LINE, click below it, Enter: one XLINE parallel to the line, 5 below it';
  for (const s of ['L', '0,-20', '20,-20', '']) await typeCmd(s);
  await typeCmd('ZE');
  {
    const { fresh, undo } = await added(await ents(), async () => {
      for (const s of ['XL', 'O', '5']) await typeCmd(s);
      await clickWorld({ x: 7, y: -20 });
      await clickWorld({ x: 7, y: -22 });
      await typeCmd('');
    });
    assert.equal(fresh.length, 1);
    const [e] = fresh;
    assert.equal(e.type, 'XLINE'); assert.ok(near(Math.abs(e.dir.x), 1) && near(e.dir.y, 0), 'parallel'); assert.ok(near(e.p.y, -25), `at y = ${e.p.y}`);
    assert.equal(await toolId(), 'select');
    await undo();
  }

  step = 'RAY 0,0 through 0,10, Enter: one RAY from 0,0 straight up';
  {
    const { fresh, undo } = await added(await ents(), async () => { for (const s of ['RAY', '0,0', '0,10', '']) await typeCmd(s); });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].type, 'RAY'); dirIs(fresh[0], 0, 1); assert.ok(near(fresh[0].p.x, 0) && near(fresh[0].p.y, 0));
    assert.equal(await toolId(), 'select', 'Enter ends RAY');
    await undo();
  }

  step = 'ZE with an XLINE and a RAY in the drawing frames only the finite LINE';
  {
    const { undo } = await added(await ents(), async () => { for (const s of ['XL', 'H', '0,5', '']) await typeCmd(s); });
    const u2 = await added(await ents(), async () => { for (const s of ['RAY', '50,50', '60,60', '']) await typeCmd(s); });
    await typeCmd('ZE');
    const box = await page.evaluate(() => { const vp = window.app.vp, cv = vp.canvas, a = vp.toWorld(0, 0), b = vp.toWorld(cv.clientWidth, cv.clientHeight); return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) }; });
    assert.ok(box.x0 <= 0 && box.x1 >= 20 && box.x1 - box.x0 < 60, `view x ${box.x0}..${box.x1} frames the line`);
    assert.ok(box.y0 <= -20 && box.y1 >= -20 && box.y1 < 5, `view y ${box.y0}..${box.y1} does not reach the xline or the ray`);
    await u2.undo(); await undo();
  }

  step = 'Escape mid-command leaves nothing behind and returns to Select';
  {
    const n0 = (await ents()).length;
    for (const c of [['XL', '0,0'], ['XL', 'O', '5'], ['XL', 'B', '0,0', '10,0'], ['RAY', '0,0']]) {
      for (const s of c) await typeCmd(s);
      await page.keyboard.press('Escape');
      assert.equal(await toolId(), 'select', `${c.join(' ')} + one Escape returns to Select`);
      assert.equal((await ents()).length, n0, `${c.join(' ')} + Escape adds nothing`);
    }
  }

  assert.deepEqual(problems, []);
  console.log('xltools e2e: OK');
} catch (err) {
  console.error(`xltools e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
