// Viewports: PSLTSCALE (linetype dashes at paper scale through a viewport) and polygon-clipped viewports (VPCLIP:
// flag 0x10000 + 340 -> the boundary entity): screen, PDF and DXF write-back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newLayout, paperRects } from '../src/core/layouts.js';
import { newDocument, addEntity, makeLine } from '../src/core/model.js';
import { buildScene, docWithFrozen, drawLayout } from '../src/core/render.js';
import { exportPdf } from '../src/core/exportPdf.js';

const PT = 72 / 25.4;
const vpOf = (viewHeight) => ({ type: 'VIEWPORT', id: 0, layer: '0', color: 256, vpId: 2, status: 1, on: true, flags: 32768, c: { x: 200, y: 150 }, width: 200, height: 100,
  viewCenter: { x: 0, y: 0 }, target: { x: 0, y: 0 }, viewHeight, twist: 0, frozen: [] });

/** a model with one DASHED line seen through a 1:50 viewport (LTSCALE 2) */
function dashedDoc(psltscale) {
  const doc = newDocument();
  doc.header.ltscale = 2;
  if (psltscale != null) doc.header.psltscale = psltscale;
  doc.linetypes.set('DASHED', { name: 'DASHED', description: '', pattern: [12.7, -6.35] });
  addEntity(doc, { ...makeLine({ x: -4000, y: 0 }, { x: 4000, y: 0 }), linetype: 'DASHED' });
  const lay = newLayout('Layout1', 1);
  addEntity(doc, vpOf(5000), lay.entities);
  doc.layouts = [lay];
  return { doc, lay };
}

const paperSceneOf = (doc, lay) => buildScene(Object.create(doc, { entities: { value: lay.entities } }));
const modelSceneOf = (doc) => (frozen) => buildScene(docWithFrozen(doc, frozen));

/** the dash arrays set while drawing the layout at `zoom` px per paper mm */
function screenDashes(doc, lay, zoom) {
  const cv = createCanvas(400, 300), ctx = cv.getContext('2d'), seen = [];
  const set = ctx.setLineDash.bind(ctx);
  ctx.setLineDash = (a) => { if (a.length) seen.push([...a]); set(a); };
  drawLayout(ctx, paperSceneOf(doc, lay), { cx: 200, cy: 150, zoom, width: 400, height: 300 }, lay, paperRects, modelSceneOf(doc));
  return seen.filter((a) => !(a.length === 2 && a[0] === 4 && a[1] === 3)); // the DASHED line (the printable-area frame is [4, 3])
}

async function pdfText(doc, lay) {
  const pdf = await PDFDocument.load((await exportPdf(doc, { layout: lay })).bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
}
const pdfDashes = (text) => [...text.matchAll(/\[([-\d. ]+)\] 0 d/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('PSLTSCALE 1 (default): dashes through a 1:50 viewport are pattern x LTSCALE long on paper (screen)', () => {
  const z = 2; // px per paper mm
  for (const psl of [undefined, 1]) {
    const d = screenDashes(...Object.values(dashedDoc(psl)), z);
    assert.ok(d.length, 'the dashed line is drawn dashed');
    assert.ok(near(d[0][0], 12.7 * 2 * z) && near(d[0][1], 6.35 * 2 * z), `dash ${d[0]} px`);
  }
});

test('PSLTSCALE 0: dashes through a 1:50 viewport are pattern x LTSCALE / 50 on paper (screen)', () => {
  const z = 100; // zoomed in so the model-scale pattern is still drawn dashed
  const d = screenDashes(...Object.values(dashedDoc(0)), z);
  assert.ok(d.length, 'the dashed line is drawn dashed');
  assert.ok(near(d[0][0], (12.7 * 2 / 50) * z) && near(d[0][1], (6.35 * 2 / 50) * z), `dash ${d[0]} px`);
});

test('PSLTSCALE: the PDF dash array through a 1:50 viewport is at paper scale (1) or model scale (0)', async () => {
  const one = pdfDashes(await pdfText(...Object.values(dashedDoc(1))));
  assert.ok(one.some((a) => near(a[0], 12.7 * 2 * PT) && near(a[1], 6.35 * 2 * PT)), `PSLTSCALE 1 dashes ${JSON.stringify(one)}`);
  const zero = pdfDashes(await pdfText(...Object.values(dashedDoc(0))));
  assert.ok(zero.some((a) => near(a[0], (12.7 * 2 / 50) * PT) && near(a[1], (6.35 * 2 / 50) * PT)), `PSLTSCALE 0 dashes ${JSON.stringify(zero)}`);
});

test('$PSLTSCALE is read and written back', () => {
  for (const v of [0, 1]) {
    const { doc } = dashedDoc(v);
    assert.equal(parseDxf(writeDxf(doc)).header.psltscale, v);
  }
});

/** a 1:1 viewport (paper x 100..300, y 100..200) clipped to the triangle (100,100) (300,100) (100,200), and two short
 *  model lines inside its rectangle: A inside the triangle (paper y 110), B outside it (paper y 190) */
function clippedDoc() {
  const doc = newDocument();
  addEntity(doc, makeLine({ x: -80, y: -40 }, { x: -60, y: -40 }));
  addEntity(doc, makeLine({ x: 60, y: 40 }, { x: 80, y: 40 }));
  const lay = newLayout('Layout1', 1);
  const tri = addEntity(doc, { type: 'LWPOLYLINE', id: 0, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, closed: true,
    vertices: [{ x: 100, y: 100, bulge: 0 }, { x: 300, y: 100, bulge: 0 }, { x: 100, y: 200, bulge: 0 }] }, lay.entities);
  addEntity(doc, { ...vpOf(100), flags: 32768 | 65536, clipId: tri.id }, lay.entities);
  doc.layouts = [lay];
  return { doc, lay, tri };
}

test('polygon-clipped viewport: model content outside its boundary is not drawn on screen', () => {
  const { doc, lay } = clippedDoc();
  const cv = createCanvas(500, 300), ctx = cv.getContext('2d');
  drawLayout(ctx, paperSceneOf(doc, lay), { cx: 200, cy: 150, zoom: 2, width: 500, height: 300 }, lay, paperRects, modelSceneOf(doc));
  const dark = (x0, x1, y0, y1) => {
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) n++;
    return n;
  };
  // screen: sx = (x - 200) * 2 + 250, sy = 150 - (y - 150) * 2
  assert.ok(dark(95, 125, 226, 234) > 10, 'line A (inside the boundary) is drawn');
  assert.equal(dark(375, 405, 66, 74), 0, 'line B (outside the boundary) is not drawn');
  // no rectangle frame: the viewport rectangle's top edge (paper y 200 -> sy 50) is not stroked away from the triangle corner
  assert.equal(dark(300, 440, 47, 53), 0, 'no rectangular viewport frame');
});

test('polygon-clipped viewport: the PDF clips the viewport to its boundary', async () => {
  const { doc, lay } = clippedDoc();
  const text = await pdfText(doc, lay);
  // after the viewport rectangle's clip: the triangle as a clip path (3 vertices, W n)
  const clips = [...text.matchAll(/((?:[-\d.]+ [-\d.]+ [ml]\s+)+)h\s+W\s+n/g)].map((m) => [...m[1].matchAll(/([-\d.]+) ([-\d.]+) [ml]/g)].map((q) => [+q[1], +q[2]]));
  const { sheet } = paperRects(lay), P = (x, y) => [(x - sheet.minx) * PT, (y - sheet.miny) * PT];
  const want = [P(100, 100), P(300, 100), P(100, 200)];
  for (const c of clips) if (c.length > 1 && near(c[0][0], c.at(-1)[0], 1e-6) && near(c[0][1], c.at(-1)[1], 1e-6)) c.pop(); // closing vertex
  assert.ok(clips.some((c) => c.length === 3 && c.every((p, i) => near(p[0], want[i][0], 1e-4) && near(p[1], want[i][1], 1e-4))), `clip paths ${JSON.stringify(clips)}`);
});

test('polygon-clipped viewport: read -> write -> re-read keeps flag 0x10000 and 340 -> the same boundary', () => {
  const { doc } = clippedDoc();
  let text = writeDxf(doc);
  for (let pass = 0; pass < 2; pass++) {
    // the written VIEWPORT (not the paper one) has the clip flag and its 340 is the written LWPOLYLINE's handle
    const lines = text.split(/\r?\n/), recs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const c = parseInt(lines[i], 10), v = lines[i + 1].trim();
      if (c === 0) recs.push({ type: v, tags: [] }); else recs.at(-1)?.tags.push([c, v]);
    }
    const tagOf = (r, code) => r.tags.find(([c]) => c === code)?.[1] ?? null;
    const poly = recs.find((r) => r.type === 'LWPOLYLINE');
    const vps = recs.filter((r) => r.type === 'VIEWPORT' && tagOf(r, 340));
    assert.equal(vps.length, 1, 'one clipped viewport written');
    assert.ok(parseInt(tagOf(vps[0], 90), 10) & 0x10000, 'clip flag kept');
    assert.equal(tagOf(vps[0], 340), tagOf(poly, 5), '340 names the boundary polyline');
    const back = parseDxf(text), lo = back.layouts[0], vp = lo.entities.find((e) => e.type === 'VIEWPORT' && !e.paper);
    const b = vp.clipId ? lo.entities.find((e) => e.id === vp.clipId) : null;
    assert.ok(b, 'the boundary is linked after reading');
    assert.equal(b.type, 'LWPOLYLINE');
    assert.deepEqual(b.vertices.map((v) => [v.x, v.y]), [[100, 100], [300, 100], [100, 200]]);
    text = writeDxf(back);
  }
});
