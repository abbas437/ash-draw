import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonFromRadius, polygonFromEdge, polygonVertices, donutPolyline, splineFromFit } from '../src/core/draw2.js';
import { nurbsOf, pointAt, derivsAt, domain } from '../src/core/nurbs.js';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { offsetEntity, tessellate } from '../src/core/geom.js';
import * as M from '../src/core/model.js';

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const C = { x: 3, y: -2 };

test('POLYGON inscribed: 6 sides, R 10 -> every vertex at 10, a vertex at the picked point', () => {
  const v = polygonFromRadius(C, 6, true, { x: 13, y: -2 });
  assert.equal(v.length, 6);
  for (const p of v) close(d(p, C), 10);
  assert.ok(v.some((p) => d(p, { x: 13, y: -2 }) < 1e-9), 'vertex at the picked point');
  for (let i = 0; i < 6; i++) close(d(v[i], v[(i + 1) % 6]), 10); // hexagon side = R
});

test('POLYGON circumscribed: 6 sides, R 10 -> every edge midpoint at 10, one at the picked point', () => {
  const q = { x: 3, y: 8 }, v = polygonFromRadius(C, 6, false, q);
  const mids = v.map((p, i) => ({ x: (p.x + v[(i + 1) % 6].x) / 2, y: (p.y + v[(i + 1) % 6].y) / 2 }));
  for (const m of mids) close(d(m, C), 10);
  assert.ok(mids.some((m) => d(m, q) < 1e-9), 'edge midpoint at the picked point');
  for (const p of v) close(d(p, C), 10 / Math.cos(Math.PI / 6));
});

test('POLYGON typed radius: bottom edge horizontal (inscribed and circumscribed)', () => {
  for (const ins of [true, false]) {
    const v = polygonFromRadius(C, 5, ins, 4), ys = v.map((p) => p.y), lo = Math.min(...ys);
    assert.equal(ys.filter((y) => Math.abs(y - lo) < 1e-9).length, 2, 'two vertices on the bottom edge');
  }
  for (const p of polygonVertices(C, 4, 4, true)) close(d(p, C), 4);
});

test('POLYGON Edge: side length equals the picked edge, polygon on the left, closed regular shape', () => {
  const a = { x: 1, y: 1 }, b = { x: 4, y: 5 }, v = polygonFromEdge(a, b, 7);
  assert.equal(v.length, 7);
  assert.deepEqual(v[0], a); assert.deepEqual(v[1], b);
  for (let i = 0; i < 7; i++) close(d(v[i], v[(i + 1) % 7]), 5);
  const cx = v.reduce((s, p) => s + p.x, 0) / 7, cy = v.reduce((s, p) => s + p.y, 0) / 7;
  assert.ok((b.x - a.x) * (cy - a.y) - (b.y - a.y) * (cx - a.x) > 0, 'centre left of a->b');
  for (const p of v) close(d(p, { x: cx, y: cy }), d(a, { x: cx, y: cy }));
});

test('DONUT: two bulge-1 segments on the mid radius, width (outside - inside) / 2, closed', () => {
  const g = donutPolyline({ x: 5, y: 5 }, 2, 6);
  assert.equal(g.closed, true); assert.equal(g.vertices.length, 2);
  assert.deepEqual(g.vertices.map((v) => v.bulge), [1, 1]);
  for (const v of g.vertices) close(d(v, { x: 5, y: 5 }), 2); // (2 + 6) / 4
  close(g.width, 2);
  const s = donutPolyline({ x: 0, y: 0 }, 0, 1); // solid dot: inner edge at the centre
  close(s.width, 0.5); close(d(s.vertices[0], { x: 0, y: 0 }) - s.width / 2, 0);
  const e = M.makePolyline(g.vertices, true, {}); e.width = g.width;
  const out = parseDxf(writeDxf({ ...docWith(e) })).entities[0];
  close(out.width, 2); assert.deepEqual(out.vertices.map((v) => v.bulge), [1, 1]); assert.equal(out.closed, true);
});

function docWith(...ents) { const doc = M.newDocument(); for (const e of ents) M.addEntity(doc, e); return doc; }

const FIT = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 7, y: 3 }, { x: 9, y: -1 }, { x: 14, y: 2 }];
function throughFit(s) {
  const nu = nurbsOf(M.makeSpline(s));
  assert.ok(nu, 'evaluable');
  const pts = s.closed ? [...s.fit, s.fit[0]] : s.fit;
  let u = 0;
  pts.forEach((q, i) => { // fit point i sits at the chord-length parameter
    if (i) u += d(q, pts[i - 1]);
    const c = pointAt(nu, u, i === pts.length - 1);
    assert.ok(d(c, q) <= 1e-6, `fit point ${i} off by ${d(c, q)}`);
  });
  return nu;
}

test('SPLINE fit-point solve: the curve passes through every fit point (open, 2..5 points)', () => {
  for (let n = 2; n <= FIT.length; n++) {
    const s = splineFromFit(FIT.slice(0, n));
    assert.equal(s.degree, 3); assert.equal(s.ctrl.length, n + 2); assert.equal(s.knots.length, n + 6);
    throughFit(s);
  }
});

test('SPLINE closed: passes through every fit point, C2 periodic across the seam', () => {
  const s = splineFromFit(FIT, true);
  assert.equal(s.closed, true);
  const nu = throughFit(s), [t0, t1] = domain(nu);
  const A = derivsAt(nu, t0), B = derivsAt(nu, t1, true);
  for (const k of ['p', 'd1', 'd2']) { close(A[k].x, B[k].x, 1e-7); close(A[k].y, B[k].y, 1e-7); }
});

test('SPLINE survives DXF save / open (fit, control points, knots, closed) and stays usable by OFFSET', () => {
  for (const closed of [false, true]) {
    const e = M.makeSpline({ ...splineFromFit(FIT, closed), layer: '0' });
    const out = parseDxf(writeDxf(docWith(e))).entities.find((x) => x.type === 'SPLINE');
    assert.equal(out.closed, closed);
    assert.equal(out.fit.length, FIT.length); out.fit.forEach((q, i) => close(d(q, FIT[i]), 0, 1e-9));
    assert.equal(out.ctrl.length, e.ctrl.length); out.ctrl.forEach((q, i) => close(d(q, e.ctrl[i]), 0, 1e-9));
    out.knots.forEach((k, i) => close(k, e.knots[i], 1e-9));
    throughFit(out);
    assert.ok(tessellate(out)[0].length > 10);
    const off = offsetEntity(out, 0.5, { x: 3, y: 10 });
    assert.equal(off.type, 'SPLINE');
  }
});

test('a polyline with width (DONUT) is drawn filled: one ring per segment, out to the outside radius', async () => {
  const { buildScene } = await import('../src/core/render.js');
  const g = donutPolyline({ x: 0, y: 0 }, 2, 6), e = M.makePolyline(g.vertices, true, {}); e.width = g.width;
  const sc = buildScene(docWith(e)), its = sc.items.filter((it) => it.id === e.id);
  assert.equal(its.length, 2); assert.ok(its.every((it) => it.kind === 'fill'));
  close(Math.max(...its.map((it) => it.bbox.maxx)), 3); // outside radius: mid 2 + half width 1
});

test('a wide polyline gives each segment its own bbox (culling), not one box for the whole polyline', async () => {
  const { buildScene } = await import('../src/core/render.js');
  const e = M.makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }], false, {}); e.width = 2;
  const its = buildScene(docWith(e)).items.filter((it) => it.id === e.id);
  assert.equal(its.length, 3);
  assert.ok(its[0].bbox.maxx <= 10 + 1 + 1e-9, `first item maxx ${its[0].bbox.maxx}`);
  assert.ok(its[2].bbox.minx >= 20 - 1e-9, `last item minx ${its[2].bbox.minx}`);
});

test('a closed wide polyline that repeats its first vertex (with a bulge) keeps the scene extents finite', async () => {
  // as in a client block: the last vertex equals the first and carries a bulge, so the closing segment has no length
  const { buildScene } = await import('../src/core/render.js');
  const v = [{ x: 0, y: 0, bulge: 0.4142 }, { x: 1, y: 0.3, bulge: 0 }, { x: 0, y: 2, bulge: 0 }, { x: 0, y: 0, bulge: 0.4142 }];
  const e = M.makePolyline(v.map(({ x, y }) => ({ x, y })), true, {}); e.vertices.forEach((q, i) => { q.bulge = v[i].bulge; }); e.width = 0.01;
  const s = buildScene(docWith(e));
  for (const k of ['minx', 'miny', 'maxx', 'maxy']) assert.ok(Number.isFinite(s.bbox[k]), `scene ${k} = ${s.bbox[k]}`);
  assert.ok(s.items.every((it) => !it.bbox || Object.values(it.bbox).every(Number.isFinite)));
});

test('a wide polyline much thinner than a pixel still shows as a line (as AutoCAD draws at least one pixel)', async () => {
  const { buildScene, drawScene, fitView } = await import('../src/core/render.js');
  const { createCanvas } = await import('@napi-rs/canvas');
  const e = M.makePolyline([{ x: 0, y: 50 }, { x: 400, y: 50 }], false, { color: 1 }); e.width = 0.001;
  const sc = buildScene(docWith(e)), cv = createCanvas(400, 100), ctx = cv.getContext('2d');
  drawScene(ctx, sc, fitView({ minx: 0, miny: 0, maxx: 400, maxy: 100 }, 400, 100), { background: '#ffffff' });
  const px = ctx.getImageData(0, 0, 400, 100).data;
  let darkest = 765; for (let y = 0; y < 100; y++) { const i = (y * 400 + 200) * 4; darkest = Math.min(darkest, px[i] + px[i + 1] + px[i + 2]); }
  assert.ok(darkest < 600, `the band is visible in column 200 (darkest r+g+b ${darkest}; white is 765)`);
});
