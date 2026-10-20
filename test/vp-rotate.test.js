// Viewports under ROTATE / MIRROR (AutoCAD rules): a viewport turned off the axes becomes a clipped viewport (a closed
// polyline, the turned rectangle, is its boundary; its rectangle the box around it) and its view turns with it
// (VPROTATEASSOC = 1); a mirror moves the frame only; a clipped viewport and its boundary move together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { newLayout, paperRects, paperToModel, viewportClipEntity } from '../src/core/layouts.js';
import { Session, rotateEntities, mirrorEntities } from '../src/core/edit.js';
import { gripModeEdit } from '../renderer/grips.js';
import { newDocument, addEntity, makeLine } from '../src/core/model.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { DEG, rotation, transformEntity } from '../src/core/geom.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const nearPt = (p, q, tol = 1e-9, msg = '') => assert.ok(near(p.x, q.x, tol) && near(p.y, q.y, tol), `${msg} ${JSON.stringify(p)} vs ${JSON.stringify(q)}`);
const vpOf = () => ({ type: 'VIEWPORT', id: 0, layer: 'VP', color: 256, vpId: 2, status: 1, on: true, flags: 32768, c: { x: 200, y: 150 }, width: 200, height: 100,
  viewCenter: { x: 10, y: 20 }, target: { x: 0, y: 0 }, viewHeight: 500, twist: 0, frozen: [] });

/** a layout with one 1:5 viewport (paper 100..300 x 100..200 shows model centre 10,20), as an editing session on it */
function session({ clipped = false } = {}) {
  const doc = newDocument();
  addEntity(doc, makeLine({ x: -500, y: 20 }, { x: 500, y: 20 }));
  const lay = newLayout('Layout1', 1);
  let tri = null;
  if (clipped) {
    tri = addEntity(doc, { type: 'LWPOLYLINE', id: 0, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, closed: true,
      vertices: [{ x: 100, y: 100, bulge: 0 }, { x: 300, y: 100, bulge: 0 }, { x: 100, y: 200, bulge: 0 }] }, lay.entities);
  }
  const vp = addEntity(doc, { ...vpOf(), ...(tri ? { flags: 32768 | 65536, clipId: tri.id } : {}) }, lay.entities);
  doc.layouts = [lay];
  const paper = Object.create(doc, { entities: { value: lay.entities, writable: true } });
  const s = new Session(paper);
  const get = (id) => s.doc.entities.find((e) => e.id === id);
  return { doc, lay, s, vp, tri, get };
}
const boxOf = (pts) => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minx: Math.min(...xs), miny: Math.min(...ys), maxx: Math.max(...xs), maxy: Math.max(...ys) };
};
const rectOf = (v) => ({ minx: v.c.x - v.width / 2, miny: v.c.y - v.height / 2, maxx: v.c.x + v.width / 2, maxy: v.c.y + v.height / 2 });
const sameBox = (a, b, msg) => { for (const k of ['minx', 'miny', 'maxx', 'maxy']) assert.ok(near(a[k], b[k]), `${msg}: ${k} ${a[k]} vs ${b[k]}`); };

test('rotate an unclipped viewport by 30 degrees: clipped by the turned rectangle, its box as the rectangle, twist +30', () => {
  const { s, vp, get } = session();
  const base = { x: 50, y: 40 }, m = rotation(30 * DEG, base.x, base.y);
  const modelAt = (v, p) => paperToModel(v, p);
  const probe = { x: 260, y: 180 }, wantProbe = modelAt(vp, probe); // a paper point inside the frame and the model point it shows
  const r = rotateEntities(s, [vp.id], base, 30 * DEG);
  assert.deepEqual(r.failed, []);
  const v = get(vp.id), b = viewportClipEntity(v, s.doc.entities);
  assert.ok(b, 'the viewport is clipped');
  assert.equal(b.type, 'LWPOLYLINE');
  assert.ok(b.closed);
  assert.equal(b.vertices.length, 4);
  assert.equal(b.layer, 'VP', 'the boundary is on the viewport layer');
  const want = [[100, 100], [300, 100], [300, 200], [100, 200]].map(([x, y]) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }));
  b.vertices.forEach((p, i) => nearPt(p, want[i], 1e-9, `corner ${i}`));
  sameBox(rectOf(v), boxOf(want), 'rectangle = box of the turned rectangle');
  assert.ok(near(v.twist, 30 * DEG), `twist ${v.twist / DEG}`);
  nearPt(paperToModel(v, v.c), vp.viewCenter, 1e-9, 'model point at the frame centre');
  nearPt(paperToModel(v, { x: m[0] * probe.x + m[2] * probe.y + m[4], y: m[1] * probe.x + m[3] * probe.y + m[5] }), wantProbe, 1e-9, 'content turns with the frame');
  assert.ok(near(v.viewHeight / v.height, 5), 'scale 1:5 kept');
  assert.ok(r.created.includes(b), 'the new boundary is reported');
  s.undo();
  assert.equal(get(vp.id), vp, 'undo restores the viewport');
  assert.equal(s.doc.entities.length, 1, 'and removes the boundary (one step)');
});

test('rotate a viewport by 90 degrees: stays rectangular, width / height swapped, twist +90', () => {
  const { s, vp, get } = session();
  rotateEntities(s, [vp.id], { x: 0, y: 0 }, 90 * DEG);
  const v = get(vp.id);
  assert.equal(s.doc.entities.length, 1, 'no boundary');
  assert.equal(v.clipId, undefined);
  assert.ok(near(v.width, 100) && near(v.height, 200), `${v.width} x ${v.height}`);
  nearPt(v.c, { x: -150, y: 200 });
  assert.ok(near(v.twist, 90 * DEG));
  nearPt(paperToModel(v, v.c), vp.viewCenter);
  assert.ok(near(v.viewHeight / v.height, 5), 'scale kept');
  // 180 degrees (an axis-aligned matrix) turns the view too
  rotateEntities(s, [vp.id], { x: 0, y: 0 }, 90 * DEG);
  assert.ok(near(Math.abs(get(vp.id).twist), 180 * DEG));
  s.undo(); s.undo();
  assert.equal(get(vp.id), vp);
});

test('rotate a clipped viewport by 45 degrees: boundary turned, rectangle re-fitted to it, twist +45', () => {
  const { s, vp, tri, get } = session({ clipped: true });
  const base = { x: 0, y: 0 }, m = rotation(45 * DEG);
  const probe = { x: 130, y: 120 }, wantProbe = paperToModel(vp, probe);
  rotateEntities(s, [vp.id], base, 45 * DEG); // the boundary comes along (associated)
  const v = get(vp.id), b = get(tri.id);
  assert.equal(viewportClipEntity(v, s.doc.entities), b);
  const want = tri.vertices.map((p) => ({ x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y }));
  b.vertices.forEach((p, i) => nearPt(p, want[i], 1e-9, `vertex ${i}`));
  sameBox(rectOf(v), boxOf(want), 'rectangle = box of the boundary');
  assert.ok(near(v.twist, 45 * DEG));
  nearPt(paperToModel(v, { x: m[0] * probe.x + m[2] * probe.y, y: m[1] * probe.x + m[3] * probe.y }), wantProbe, 1e-9, 'content turns with the frame');
  assert.equal(s.doc.entities.length, 2, 'no extra boundary');
  s.undo();
  assert.equal(get(vp.id), vp); assert.equal(get(tri.id), tri);
});

test('mirror about a vertical axis: the frame is mirrored, the view is not', () => {
  const { s, vp, get } = session();
  mirrorEntities(s, [vp.id], { x: 0, y: 0 }, { x: 0, y: 1 }, { deleteSource: true });
  const v = get(vp.id);
  nearPt(v.c, { x: -200, y: 150 });
  assert.ok(near(v.width, 200) && near(v.height, 100));
  assert.equal(v.twist, 0);
  assert.deepEqual(v.viewCenter, vp.viewCenter);
  assert.equal(v.viewHeight, vp.viewHeight);
  // the view is not mirrored: right on paper is still +x in the model
  assert.ok(paperToModel(v, { x: v.c.x + 10, y: v.c.y }).x > vp.viewCenter.x);
  assert.equal(s.doc.entities.length, 1);
  s.undo();
  assert.equal(get(vp.id), vp);
});

test('mirror about a diagonal axis: a clipped viewport (frame mirrored, view not); a copy gets its own boundary', () => {
  const { s, vp, get } = session();
  const p1 = { x: 0, y: 0 }, p2 = { x: 2, y: 1 };
  mirrorEntities(s, [vp.id], p1, p2, { deleteSource: true });
  const v = get(vp.id), b = viewportClipEntity(v, s.doc.entities);
  assert.ok(b && b.vertices.length === 4, 'clipped by a 4-vertex boundary');
  sameBox(rectOf(v), boxOf(b.vertices), 'rectangle = box of the mirrored frame');
  assert.equal(v.twist, 0, 'the view is not turned');
  nearPt(paperToModel(v, v.c), vp.viewCenter, 1e-9, 'model point at the frame centre');
  assert.ok(near(v.viewHeight / v.height, 5), 'scale kept');
  s.undo();
  assert.equal(get(vp.id), vp);
  assert.equal(s.doc.entities.length, 1);
  // MIRROR keeping the source: the copy is clipped by its own new boundary, the original untouched
  const r = mirrorEntities(s, [vp.id], p1, p2);
  const copy = r.created.find((e) => e.type === 'VIEWPORT'), cb = r.created.find((e) => e.type === 'LWPOLYLINE');
  assert.ok(copy && cb && copy.clipId === cb.id);
  assert.equal(get(vp.id).clipId, undefined);
  s.undo();
  assert.equal(s.doc.entities.length, 1);
});

test('the single-entity transform still refuses a turn off the axes (a boundary is needed)', () => {
  assert.throws(() => transformEntity(vpOf(), rotation(30 * DEG)), { code: 'SHEAR' });
  assert.equal(transformEntity(vpOf(), rotation(90 * DEG)).width, 100);
});

test('grip-moving the boundary alone moves its viewport with it (one undo step)', () => {
  const { s, vp, tri, get } = session({ clipped: true });
  const r = gripModeEdit(s, [tri.id], 'MOVE', { x: 100, y: 100 }, { p: { x: 130, y: 90 } });
  assert.deepEqual(r.failed, []);
  const v = get(vp.id), b = get(tri.id);
  assert.deepEqual(b.vertices.map((p) => [p.x, p.y]), [[130, 90], [330, 90], [130, 190]]);
  nearPt(v.c, { x: 230, y: 140 }, 1e-9, 'the viewport moved with its boundary');
  nearPt(v.viewCenter, vp.viewCenter, 1e-9, 'showing the same model area');
  assert.equal(v.clipId, tri.id);
  // grip-rotating the boundary alone turns the viewport and its view
  gripModeEdit(s, [tri.id], 'ROTATE', { x: 0, y: 0 }, { value: 30 });
  assert.ok(near(get(vp.id).twist, 30 * DEG));
  sameBox(rectOf(get(vp.id)), boxOf(get(tri.id).vertices), 'rectangle re-fitted');
  s.undo();
  s.undo();
  assert.equal(get(vp.id), vp); assert.equal(get(tri.id), tri);
});

// ---- write / read and PDF of a 30-degree-turned viewport ----------------------------------------------------------

function turned() {
  const ctx = session();
  rotateEntities(ctx.s, [ctx.vp.id], { x: 200, y: 150 }, 30 * DEG); // about the frame centre
  return ctx;
}

test('write -> read of a turned (now clipped) viewport keeps the clip, the twist and the rectangle', () => {
  const { doc, lay } = turned();
  const v = lay.entities.find((e) => e.type === 'VIEWPORT'), b = viewportClipEntity(v, lay.entities);
  const back = parseDxf(writeDxf(doc)), lo = back.layouts[0], w = lo.entities.find((e) => e.type === 'VIEWPORT' && !e.paper);
  const wb = viewportClipEntity(w, lo.entities);
  assert.ok(wb, 'still clipped');
  wb.vertices.forEach((p, i) => nearPt(p, b.vertices[i], 1e-9, `vertex ${i}`));
  assert.ok(near(w.twist, 30 * DEG, 1e-9), `twist ${w.twist / DEG}`);
  nearPt(w.c, v.c); assert.ok(near(w.width, v.width) && near(w.height, v.height));
  nearPt(w.viewCenter, v.viewCenter, 1e-9, 'view centre');
  assert.ok(near(w.viewHeight, v.viewHeight));
});

test('PDF of a 30-degree-turned viewport: clipped to the turned frame, the view turned by 30 degrees', async () => {
  const { doc, lay } = turned();
  const v = lay.entities.find((e) => e.type === 'VIEWPORT'), b = viewportClipEntity(v, lay.entities);
  const pdf = await PDFDocument.load((await exportPdf(doc, { layout: lay })).bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  const text = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
  const PT = 72 / 25.4, { sheet } = paperRects(lay), P = (p) => [(p.x - sheet.minx) * PT, (p.y - sheet.miny) * PT];
  const clips = [...text.matchAll(/((?:[-\d.]+ [-\d.]+ [ml]\s+)+)h\s+W\s+n/g)].map((m) => [...m[1].matchAll(/([-\d.]+) ([-\d.]+) [ml]/g)].map((q) => [+q[1], +q[2]]));
  for (const cl of clips) if (cl.length > 1 && near(cl[0][0], cl.at(-1)[0], 1e-6) && near(cl[0][1], cl.at(-1)[1], 1e-6)) cl.pop();
  const want = b.vertices.map(P);
  assert.ok(clips.some((cl) => cl.length === 4 && cl.every((p, i) => near(p[0], want[i][0], 1e-4) && near(p[1], want[i][1], 1e-4))), `turned frame as a clip path: ${JSON.stringify(clips)}`);
  const cs = Math.cos(30 * DEG), sn = Math.sin(30 * DEG);
  const cm = [...text.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/g)].map((m) => m.slice(1, 5).map(Number));
  assert.ok(cm.some((q) => near(q[0], cs, 1e-4) && near(q[1], sn, 1e-4) && near(q[2], -sn, 1e-4) && near(q[3], cs, 1e-4)), `view turned 30 degrees: ${JSON.stringify(cm)}`);
});
