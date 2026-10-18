#!/usr/bin/env node
// Browser end-to-end test: zoomed far into a layout sheet, a viewport is drawn only where it is on the canvas.
// (Reported 18-Oct-2026: zooming into a sheet froze the window for seconds and lines vanished, because every viewport's
// whole model view was drawn - and stroked at huge coordinates - at the zoomed size.)
//  1. Deep in a plain and in a twisted viewport, a render draws a handful of paths, not the whole model.
//  2. What is drawn is still right: the model line under the canvas centre is drawn there, in both viewports.
// Prints "layoutdeepzoom e2e: OK".
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

  step = 'a model of 20000 short lines; a layout with a plain and a twisted viewport onto it';
  await page.evaluate(async () => {
    const { newDocument } = await import('/src/core/model.js');
    const { Session } = await import('/src/core/edit.js');
    const { makeViewport } = await import('/src/core/layouts.js');
    const { addLayout, layoutsOf } = await import('/src/core/layoutmgmt.js');
    const doc = newDocument(), s = new Session(doc);
    s.transact('setup', (tx) => {
      tx.layer('A', { color: 1 });
      for (let i = 0; i < 20000; i++) {
        const x = (i * 37) % 1000, y = (i * 53) % 1000;
        tx.add({ type: 'LINE', id: 0, layer: 'A', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x, y }, p2: { x: x + 3, y: y + 5 } });
      }
      tx.add({ type: 'LINE', id: 0, layer: 'A', color: 5, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 0, y: 501.5 }, p2: { x: 1000, y: 501.5 } }); // the probe line
    });
    addLayout(s, 'Layout1');
    const fit = { minx: 0, miny: 0, maxx: 1000, maxy: 1000 };
    const tw = { ...makeViewport({ x: 220, y: 50 }, { x: 400, y: 230 }, fit, 3), id: doc.nextId++ }; tw.twist = 0.4;
    s.transact('paper', (tx) => tx.set(layoutsOf(doc)[0], 'entities', [
      { ...makeViewport({ x: 0, y: 0 }, { x: 420, y: 297 }, null, 1), paper: true, id: doc.nextId++ },
      { ...makeViewport({ x: 20, y: 50 }, { x: 200, y: 230 }, fit, 2), id: doc.nextId++ }, tw]));
    window.app.installDoc(doc, { path: null, name: 'deepzoom.dxf', format: 'dxf' });
    window.__paths = 0;
    for (const m of ['lineTo', 'moveTo']) { const f = CanvasRenderingContext2D.prototype[m]; CanvasRenderingContext2D.prototype[m] = function (...a) { window.__paths++; return f.apply(this, a); }; }
  });
  await page.click('#spacebar button[data-space="Layout1"]');
  await page.waitForTimeout(300);

  // centre the paper view on the sheet point that shows model (500.5, 501.5) through viewport `vpId`, at `zoom`
  const deep = (vpId, zoom) => page.evaluate(async ([vpId, zoom]) => {
    const vp = window.app.vp, v = vp.doc.entities.find((e) => e.type === 'VIEWPORT' && e.vpId === vpId);
    const s = v.height / v.viewHeight, t = v.twist || 0, mx = 500.5 - v.viewCenter.x, my = 501.5 - v.viewCenter.y;
    // inverse of paperToModel: paper offset = R(t) * model offset * paper-per-model
    const p = { x: v.c.x + (mx * Math.cos(t) - my * Math.sin(t)) * s, y: v.c.y + (mx * Math.sin(t) + my * Math.cos(t)) * s };
    vp.view = { ...vp.view, cx: p.x, cy: p.y, zoom }; vp.invalidate();
    window.__paths = 0; vp.render();
    const paths = window.__paths, c = vp.canvas, d = c.getContext('2d').getImageData(Math.round(c.width / 2) - 3, Math.round(c.height / 2) - 3, 7, 7).data;
    let blue = false;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 200 && d[i + 1] < 200) blue = true; // colour 5, antialiased
    return { paths, blue };
  }, [vpId, zoom]);

  for (const [vpId, label] of [[2, 'plain'], [3, 'twisted']]) {
    step = `deep in the ${label} viewport: few paths, the probe line under the centre`;
    const r = await deep(vpId, 2000);
    assert.ok(r.paths < 2000, `${label}: a deep render drew ${r.paths} paths (the whole model is ~80000)`);
    assert.ok(r.blue, `${label}: the model line under the canvas centre is not drawn there`);
  }

  assert.deepEqual(problems, []);
  console.log('layoutdeepzoom e2e: OK');
} catch (err) {
  console.error(`layoutdeepzoom e2e FAILED at step "${step}":`, err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
