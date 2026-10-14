#!/usr/bin/env node
// Browser end-to-end test of right-to-left text on screen: MTEXT words are placed in visual order and TEXT is drawn whole
// with an explicit left-to-right paragraph direction (the PDF's order); same harness as run.mjs.
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
  step = 'install a drawing with Arabic MTEXT and TEXT, record fillText calls on a render';
  const calls = await page.evaluate(async () => {
    const M = await import('/src/core/model.js');
    const doc = M.newDocument();
    M.addEntity(doc, M.makeMText({ x: 0, y: 0 }, 2, 'غرفة 12\\Pمطبخ 345\\Pواحد اثنان ثلاثة'));
    M.addEntity(doc, M.makeText({ x: 0, y: -30 }, 2, 'غرفة 101'));
    M.addEntity(doc, M.makeText({ x: 0, y: -40 }, 2, 'AHU-1 غرفة 123'));
    M.addEntity(doc, M.makeText({ x: 0, y: -50 }, 2, '(مرحبا) [AHU-1]'));
    window.app.installDoc(doc, { path: null, name: 'rtl.dxf', format: 'dxf' });
    const { drawScene } = await import('/src/core/render.js');
    const vp = window.app.vp; vp.zoomExtents();
    const cv = document.createElement('canvas'); cv.width = vp.canvas.width; cv.height = vp.canvas.height;
    const c2 = cv.getContext('2d'), seen = [], orig = c2.fillText;
    c2.fillText = function (t, x, y, ...r) { seen.push({ t: String(t), x: this.getTransform().e + x, dir: this.direction }); return orig.call(this, t, x, y, ...r); };
    drawScene(c2, vp.scene, vp.view, vp.sceneOpts());
    return seen;
  });
  const at = (t) => { const c = calls.filter((k) => k.t === t); assert.equal(c.length, 1, `"${t}" drawn once, saw ${JSON.stringify(calls.map((k) => k.t))}`); return c[0]; };

  step = 'MTEXT lines: digits left of the Arabic word, three words right to left, Arabic pieces drawn rtl';
  assert.ok(at('12').x < at('غرفة').x, 'line 1: 12 is left of غرفة');
  assert.ok(at('345').x < at('مطبخ').x, 'line 2: 345 is left of مطبخ');
  assert.ok(at('ثلاثة').x < at('اثنان').x && at('اثنان').x < at('واحد').x, 'line 3: words run right to left');
  for (const w of ['غرفة', 'مطبخ', 'ثلاثة', 'اثنان', 'واحد']) assert.equal(at(w).dir, 'rtl', `${w} drawn as a whole word in rtl`);
  assert.equal(at('12').dir, 'ltr');

  step = 'single-line TEXT: whole string, explicit ltr direction (browser bidi then gives the PDF order)';
  for (const t of ['غرفة 101', 'AHU-1 غرفة 123', '(مرحبا) [AHU-1]']) assert.equal(at(t).dir, 'ltr', `${t} drawn whole with ctx.direction ltr`);
  const order = await page.evaluate(() => {
    // the browser's own order for these strings under ltr, from DOM ranges (what fillText resolves with)
    const out = {};
    for (const t of ['غرفة 101', 'AHU-1 غرفة 123']) {
      const d = document.createElement('div'); d.dir = 'ltr'; d.style.cssText = 'position:absolute;font:20px Arial;white-space:pre';
      document.body.append(d);
      d.textContent = '';
      for (const w of t.split(' ')) { const s = document.createElement('span'); s.textContent = w + ' '; d.append(s); }
      out[t] = [...d.children].map((s) => [s.textContent.trim(), s.getBoundingClientRect().left]);
      d.remove();
    }
    return out;
  });
  const left = (k, w) => order[k].find((e) => e[0] === w)[1];
  assert.ok(left('غرفة 101', '101') < left('غرفة 101', 'غرفة'), '"غرفة 101": 101 is left of the Arabic word');
  assert.ok(left('AHU-1 غرفة 123', 'AHU-1') < left('AHU-1 غرفة 123', '123') && left('AHU-1 غرفة 123', '123') < left('AHU-1 غرفة 123', 'غرفة'), '"AHU-1 غرفة 123": AHU-1, 123, غرفة');

  step = 'hit boxes: the MTEXT scene bbox covers every drawn word';
  const fit = await page.evaluate(() => {
    const it = window.app.vp.scene.items.find((i) => i.mt), b = it.bbox, lay = it._lay;
    return { b, n: lay.glyphs.length, minx: Math.min(...lay.glyphs.map((g) => g.x)), maxx: Math.max(...lay.glyphs.map((g) => g.x + g.w)), x0: lay.x0, width: lay.width, p: it.p };
  });
  assert.ok(fit.minx >= fit.x0 - 1e-9 && fit.maxx <= fit.x0 + fit.width + 1e-9, 'reordered words stay inside the layout box the hit test uses');

  assert.deepEqual(problems, []);
  console.log('rtl e2e: OK');
} catch (err) {
  console.error(`rtl e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
