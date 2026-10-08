#!/usr/bin/env node
// Rendering benchmark: builds a synthetic contractor-size drawing in headless Chromium (playwright-core, as
// test/e2e/run.mjs does) and times parse, scene build, first frame, pan and zoom frames, and a one-entity edit.
//   node scripts/bench.mjs            full drawing (200k lines, 20k arcs, 5k pattern hatches, 2k x 50-entity inserts, 20k texts)
//   node scripts/bench.mjs --json     machine-readable output
//   BENCH_SCALE=0.1 node scripts/bench.mjs   smaller drawing (quick runs)
// Every frame is timed up to a 1-pixel getImageData, which waits for the canvas to finish rasterising.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SCALE = Number(process.env.BENCH_SCALE || 1);
const JSON_OUT = process.argv.includes('--json');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/__bench.html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><canvas id="cv" width="1400" height="850"></canvas>'); return; }
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await fs.readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** runs in the page */
async function benchInPage({ scale }) {
  const model = await import('/src/core/model.js');
  const { writeDxf } = await import('/src/core/dxfWrite.js');
  const { readDxf } = await import('/src/core/dxfRead.js');
  const R = await import('/src/core/render.js');
  const { newDocument, addLayer, addLinetype, addBlock, addEntity, makeLine, makeArc, makeCircle, makeHatch, makeText, makeInsert } = model;

  // deterministic pseudo-random numbers
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const W = 20000, H = 12000;
  const N = (n) => Math.max(1, Math.round(n * scale));

  function synth({ lines = 0, arcs = 0, hatches = 0, inserts = 0, texts = 0 }) {
    seed = 12345;
    const doc = newDocument();
    addLinetype(doc, { name: 'DASHED', description: '__ __', pattern: [5, -2.5] });
    const colours = [1, 2, 3, 4, 5, 6, 7, 8, 30, 140];
    colours.forEach((c, i) => addLayer(doc, { name: `L${i}`, color: c, linetype: i === 3 ? 'DASHED' : 'CONTINUOUS' }));
    const layer = () => `L${Math.floor(rnd() * colours.length)}`;
    const P = () => ({ x: rnd() * W, y: rnd() * H });
    for (let i = 0; i < lines; i++) {
      const p = P(), a = rnd() * Math.PI * 2, l = 2 + rnd() * 60;
      addEntity(doc, makeLine(p, { x: p.x + l * Math.cos(a), y: p.y + l * Math.sin(a) }, { layer: layer() }));
    }
    for (let i = 0; i < arcs; i++) addEntity(doc, makeArc(P(), 1 + rnd() * 20, rnd() * 360, rnd() * 360, { layer: layer() }));
    for (let i = 0; i < hatches; i++) {
      const p = P(), w = 10 + rnd() * 60, h = 10 + rnd() * 60;
      const pts = [{ x: p.x, y: p.y }, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }];
      addEntity(doc, makeHatch([{ pts }], { solid: false, pattern: i % 3 ? 'ANSI31' : 'ANSI37', scale: 1 + (i % 4), layer: layer() }));
    }
    if (inserts) {
      const ents = [];
      for (let k = 0; k < 44; k++) ents.push(makeLine({ x: k % 11, y: Math.floor(k / 11) * 2 }, { x: (k % 11) + 1, y: Math.floor(k / 11) * 2 + 1.5 }));
      for (let k = 0; k < 4; k++) ents.push(makeCircle({ x: 2 + k * 2.5, y: 9 }, 0.8));
      ents.push(makeArc({ x: 5, y: 5 }, 6, 0, 180));
      ents.push(makeText({ x: 0, y: -1.5 }, 0.8, 'FCU-01'));
      addBlock(doc, 'EQP', { x: 0, y: 0 }, ents);
      for (let i = 0; i < inserts; i++) addEntity(doc, makeInsert('EQP', P(), { rot: rnd() * 360, sx: 1 + rnd(), sy: 1 + rnd(), layer: layer() }));
    }
    const words = ['SUPPLY AIR DUCT 600x400', 'RA-12', 'FCU-3-07 2.5kW', 'FFL +3.250', 'NOTE: SEE DETAIL 4/M-501', 'ROOM 204'];
    for (let i = 0; i < texts; i++) addEntity(doc, makeText(P(), 1.5 + rnd() * 3, words[i % words.length], { rot: i % 5 === 0 ? 90 : 0, layer: layer() }));
    return doc;
  }

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const flush = () => ctx.getImageData(0, 0, 1, 1);
  const time = (f) => { const t = performance.now(); f(); return performance.now() - t; };
  const frame = (scene, view) => time(() => { R.drawScene(ctx, scene, view, { background: '#ffffff' }); flush(); });
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const r1 = (x) => Math.round(x * 10) / 10;

  /** per-phase time of the fit frame (drawScene's profile hook; each phase flushed with a 1-px read-back) */
  function profile(scene, view, n = 5) {
    const acc = {};
    let info = null, items = 0;
    for (let i = 0; i < n; i++) {
      let t = performance.now();
      R.drawScene(ctx, scene, view, {
        background: '#ffffff',
        profile: (ph, x) => { flush(); const now = performance.now(); acc[ph] = (acc[ph] ?? 0) + now - t; t = now; if (ph === 'bucket') info = x; if (ph === 'query') items = x; },
      });
    }
    const phases = {};
    for (const k in acc) phases[k] = r1(acc[k] / n);
    return { phases, total: r1(Object.values(acc).reduce((a, b) => a + b, 0) / n), visible: items, buckets: info };
  }

  function viewSeries(scene, view0) {
    // 30 pan steps of 25 px, then 10 zoom steps alternating in/out around the centre
    let v = view0;
    const pans = [], zooms = [];
    frame(scene, v); // warm the view
    for (let i = 0; i < 30; i++) { v = { ...v, cx: v.cx - 25 / v.zoom, cy: v.cy + 10 / v.zoom }; pans.push(frame(scene, v)); }
    for (let i = 0; i < 10; i++) { v = R.zoomAt(v, 700, 425, i % 2 ? 0.8 : 1.25); zooms.push(frame(scene, v)); }
    return { pan: r1(avg(pans)), panMax: r1(Math.max(...pans)), zoom: r1(avg(zooms)) };
  }

  async function run(name, spec, withParse) {
    const doc0 = synth(spec);
    const out = { name, entities: doc0.entities.length };
    let doc = doc0;
    if (withParse) {
      const bytes = new TextEncoder().encode(writeDxf(doc0));
      out.dxfMB = r1(bytes.length / 1e6);
      let parsed;
      out.parse = r1(time(() => { parsed = readDxf(bytes); }));
      doc = parsed.doc ?? parsed;
    }
    let scene;
    out.build = r1(time(() => { scene = R.buildScene(doc); }));
    out.items = scene.items.length;
    const fit = R.fitView(scene.bbox, 1400, 850, 0.04);
    out.first = r1(frame(scene, fit));
    out.profile = profile(scene, fit);
    out.fit = viewSeries(scene, fit);
    out.z10 = viewSeries(scene, { ...fit, zoom: fit.zoom * 10 });
    // one-entity edit: change an entity and refresh the scene
    const e = doc.entities[doc.entities.length >> 1];
    out.edit = r1(time(() => { e.layer = 'L1'; R.updateScene(scene, [e.id]); }));
    await new Promise((r) => setTimeout(r, 50));
    return out;
  }

  const res = [];
  res.push(await run('full', { lines: N(200000), arcs: N(20000), hatches: N(5000), inserts: N(2000), texts: N(20000) }, true));
  res.push(await run('text', { texts: N(20000) }, false));
  return res;
}

let results;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/__bench.html`);
  results = await page.evaluate(benchInPage, { scale: SCALE });
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  server.close();
}

if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
else {
  for (const r of results) {
    console.log(`[${r.name}] entities ${r.entities}, scene items ${r.items}${r.dxfMB ? `, DXF ${r.dxfMB} MB, parse ${r.parse} ms` : ''}`);
    console.log(`  scene build ${r.build} ms, first frame ${r.first} ms, edit 1 entity ${r.edit} ms`);
    if (r.profile) console.log(`  fit frame by phase (ms): ${Object.entries(r.profile.phases).map(([k, v]) => `${k} ${v}`).join(', ')} = ${r.profile.total}; visible ${r.profile.visible}, buckets ${JSON.stringify(r.profile.buckets)}`);
    for (const k of ['fit', 'z10']) console.log(`  ${k === 'fit' ? 'fit ' : '10x '}: pan avg ${r[k].pan} ms (max ${r[k].panMax}), zoom avg ${r[k].zoom} ms`);
  }
}
