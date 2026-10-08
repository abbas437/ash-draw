import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { paperToModel, modelViewThrough, viewportFromModelView, viewportScale, viewportAt, newLayout, layoutPage } from '../src/core/layouts.js';
import { viewportToPaper, screenToWorld } from '../src/core/render.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { newDocument as createDocument } from '../src/core/model.js';

// a 200 x 100 paper viewport centred at (200,150) showing model (1000,500) at 1:50
const vp = { type: 'VIEWPORT', vpId: 2, on: true, c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 1000, y: 500 }, viewHeight: 5000, twist: 0 };
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

test('viewport scale from view height: 5000 model over 100 paper is 1:50', () => {
  assert.equal(viewportScale(vp), 50);
  assert.equal(viewportScale({ ...vp, viewHeight: 10000 }), 100);
});

test('paper -> model through a 1:50 viewport, centre and offsets; inverse of viewportToPaper (also twisted)', () => {
  near(paperToModel(vp, { x: 200, y: 150 }), { x: 1000, y: 500 });
  near(paperToModel(vp, { x: 210, y: 150 }), { x: 1500, y: 500 });
  near(paperToModel(vp, { x: 200, y: 145 }), { x: 1000, y: 250 });
  const tw = { ...vp, twist: Math.PI / 6 };
  for (const m of [{ x: 1234, y: -77 }, { x: 1000, y: 1000 }]) near(paperToModel(tw, viewportToPaper(tw, m)), m, 1e-7);
});

test('model view through a viewport maps screen points to the same model point as paper view + viewport', () => {
  const pv = { cx: 180, cy: 140, zoom: 3, width: 800, height: 600 };
  const mv = modelViewThrough(pv, vp);
  assert.equal(mv.zoom, 3 / 50);
  for (const [sx, sy] of [[400, 300], [123, 456], [700, 50]]) near(screenToWorld(mv, sx, sy), paperToModel(vp, screenToWorld(pv, sx, sy)), 1e-7);
  // zooming the model view by 2 about its centre halves the view height and keeps the viewport centre's model point consistent
  const r = viewportFromModelView(pv, vp, { ...mv, zoom: mv.zoom * 2 });
  assert.equal(r.viewHeight, 2500);
  const back = modelViewThrough(pv, { ...vp, ...r });
  near({ x: back.cx, y: back.cy }, { x: mv.cx, y: mv.cy }, 1e-7);
  assert.ok(Math.abs(back.zoom - mv.zoom * 2) < 1e-12);
});

test('viewportAt finds the viewport under a paper point and skips the paper viewport (id 1)', () => {
  const sheet = { ...vp, vpId: 1, c: { x: 210, y: 148 }, width: 420, height: 297 };
  assert.equal(viewportAt([sheet, vp], { x: 250, y: 160 }), vp);
  assert.equal(viewportAt([sheet, vp], { x: 20, y: 20 }), null);
});

/** all numbers of the page content stream(s) */
async function pageOps(bytes) {
  const pdf = await PDFDocument.load(bytes), page = pdf.getPage(0), c = page.node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return { size: page.getSize(), text: streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join('\n') };
}

test('layout plot: A3 landscape mm page is 420 x 297 mm and a 100 mm paper line is 283.46 pt; viewport content is 1:50 and clipped', async () => {
  const doc = createDocument();
  doc.entities.push({ type: 'LINE', id: 1, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 1000, y: 500 }, p2: { x: 2000, y: 500 } });
  const lay = newLayout('Layout1', 1);
  lay.entities.push({ type: 'LINE', id: 2, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: 10, y: 10 }, p2: { x: 110, y: 10 } });
  lay.entities.push({ ...vp, id: 3, layer: '0', color: 256 });
  doc.layouts = [lay];
  const lp = layoutPage(lay);
  assert.ok(Math.abs(lp.pw - 1190.55) < 0.01 && Math.abs(lp.ph - 841.89) < 0.01);
  const { size, text } = await pageOps((await exportPdf(doc, { layout: lay })).bytes);
  assert.ok(Math.abs(size.width - 1190.55) < 0.01 && Math.abs(size.height - 841.89) < 0.01, JSON.stringify(size));
  const k = 72 / 25.4, X = (x) => (x + 7.5) * k, Y = (y) => (y + 20) * k;
  const segs = [...text.matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l/g)].map((m) => m.slice(1).map(Number));
  const has = (x1, y1, x2, y2) => segs.some((q) => [X(x1), Y(y1), X(x2), Y(y2)].every((v, i) => Math.abs(v - q[i]) < 1e-3));
  assert.ok(has(10, 10, 110, 10), 'paper line at 1:1');
  assert.ok(Math.abs(X(110) - X(10) - 283.46) < 0.01);
  // model (1000,500)-(2000,500) at 1:50 through the viewport centred at paper (200,150): paper (200,150)-(220,150)
  assert.ok(has(200, 150, 220, 150), 'model line through the viewport at 1:50');
  assert.match(text, /\nW\s+n\n/, 'viewport clip');
});

test('inch layouts: paper size stays in mm, layout units are inches', () => {
  const lay = newLayout('L', 1);
  Object.assign(lay.plot, { units: 0, paperW: 431.8, paperH: 279.4, margins: { l: 0, b: 0, r: 0, t: 0 } });
  const lp = layoutPage(lay);
  assert.ok(Math.abs(lp.pw - 17 * 72) < 1e-6 && Math.abs(lp.ph - 11 * 72) < 1e-6 && lp.k === 72);
  assert.ok(Math.abs(lp.sheet.maxx - 17) < 1e-9);
});
