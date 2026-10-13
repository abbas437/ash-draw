import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../src/core/pedit.js';
import { makePolyline, newDocument, addEntity } from '../src/core/model.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { transformEntity } from '../src/core/geom.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const pt = (x, y) => ({ x, y });
const PL = (pts, closed = false) => ({ ...makePolyline(pts), id: 5, layer: 'WALLS', closed });

/** start and end tangent directions (radians) of the segment from a (bulge a.bulge) to b */
function segTangents(a, b) {
  const ch = Math.atan2(b.y - a.y, b.x - a.x), half = 2 * Math.atan(a.bulge || 0);
  return [ch - half, ch + half];
}
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** every vertex where two segments meet: the incoming end tangent equals the outgoing start tangent */
function assertTangentContinuous(v, closed) {
  const n = v.length, segs = closed ? n : n - 1;
  const tan = Array.from({ length: segs }, (_, i) => segTangents(v[i], v[(i + 1) % n]));
  for (let i = 1; i < (closed ? segs + 1 : segs); i++) {
    const inc = tan[(i - 1) % segs][1], out = tan[i % segs][0];
    assert.ok(angDiff(inc, out) <= 1e-6, `tangent break at vertex ${i % n}: ${inc} vs ${out}`);
  }
}

const P4 = [pt(0, 0), pt(10, 5), pt(20, 0), pt(35, 8)];

test('PEDIT Fit: every vertex kept, one extra vertex per segment, tangent-continuous arcs', () => {
  const pl = PL(P4);
  const f = X.fitCurve(pl).change[0];
  assert.equal(f.id, 5); assert.equal(f.layer, 'WALLS');
  assert.equal(f.vertices.length, 2 * P4.length - 1);
  P4.forEach((p, i) => { near(f.vertices[2 * i].x, p.x); near(f.vertices[2 * i].y, p.y); });
  assert.ok(f.vertices.slice(0, -1).every((v) => Math.abs(v.bulge) > 1e-6), 'every segment is an arc');
  assertTangentContinuous(f.vertices, false);
  assert.deepEqual(pl.vertices.map((v) => v.bulge), [0, 0, 0, 0], 'source untouched');
  // closed: one extra vertex per segment including the closing one
  const c = X.fitCurve(PL(P4, true)).change[0];
  assert.equal(c.vertices.length, 2 * P4.length);
  assertTangentContinuous(c.vertices, true);
});

test('PEDIT Spline: cubic and quadratic B-spline samples start / end on the frame and stay in its hull', () => {
  const frame = [pt(0, 0), pt(10, 10), pt(20, 10), pt(30, 0)]; // convex: its hull is the frame closed
  const hull = [frame[0], frame[3], frame[2], frame[1]]; // counter-clockwise
  const inHull = (q) => hull.every((a, i) => {
    const b = hull[(i + 1) % hull.length];
    return (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) >= -1e-9;
  });
  for (const [type, spans] of [[6, 1], [5, 2]]) {
    const s = X.splineFit(PL(frame), { splineType: type }).change[0];
    const v = s.vertices;
    assert.equal(v.length, spans * 8 + 1, `type ${type}: 8 segments per span`);
    near(v[0].x, 0); near(v[0].y, 0); near(v.at(-1).x, 30); near(v.at(-1).y, 0);
    assert.ok(v.every((q) => q.bulge === 0 && inHull(q)), `type ${type}: straight and inside the hull`);
    assert.ok(!frame.slice(1, 3).some((p) => v.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)), 'inner frame points are not on the curve');
  }
  // the cubic is symmetric about x = 15 and its middle point is the B-spline value there
  const m = X.splineFit(PL(frame)).change[0].vertices[4];
  near(m.x, 15); near(m.y, 7.5);
  assert.throws(() => X.splineFit(PL(frame), { splineType: 4 }), /spline type/);
});

test('PEDIT Decurve after Fit or Spline gives back the original straight frame; a stale frame is ignored', () => {
  for (const op of [X.fitCurve, (e) => X.splineFit(e), (e) => X.splineFit(e, { splineType: 5, segs: 3 })]) {
    const curved = op(PL(P4)).change[0];
    assert.equal(curved.frame.length, 4);
    const d = X.decurve(curved).change[0];
    assert.deepEqual(d.vertices.map(({ x, y, bulge }) => [x, y, bulge]), P4.map((p) => [p.x, p.y, 0]));
    assert.equal(d.frame, undefined); assert.equal(d.frameKind, undefined);
  }
  // Spline of a fitted polyline works from the frame, not from the fit vertices
  const sf = X.splineFit(X.fitCurve(PL(P4)).change[0]).change[0];
  assert.equal(sf.vertices.length, 1 * 8 + 1);
  // edited since (a vertex moved): Decurve just straightens what is there
  const f = X.fitCurve(PL(P4)).change[0];
  const moved = { ...f, vertices: f.vertices.map((v, i) => (i === 2 ? { ...v, y: v.y + 1 } : v)) };
  assert.equal(X.validFrame(moved), null);
  const d = X.decurve(moved).change[0];
  assert.equal(d.vertices.length, f.vertices.length);
  assert.ok(d.vertices.every((v) => v.bulge === 0));
});

test('PEDIT Fit / Spline frame is not written to DXF', () => {
  const doc = newDocument();
  addEntity(doc, X.splineFit(PL(P4)).change[0]);
  const txt = writeDxf(doc);
  const s = typeof txt === 'string' ? txt : txt.text ?? txt.dxf;
  assert.equal(typeof s, 'string');
  const lines = s.split(/\r?\n/).map((l) => l.trim()), at = lines.indexOf('AcDbPolyline');
  assert.deepEqual(lines.slice(at + 1, at + 3), ['90', '9'], 'the 9 samples (one cubic span) are written');
  assert.ok(!/frame/i.test(s));
});

test('PEDIT Fit: a polyline doubling back 180 degrees stays finite (hairpin guard)', () => {
  const f = X.fitCurve(PL([pt(0, 0), pt(10, 0), pt(5, 0)])).change[0];
  assert.ok(f.vertices.every((v) => Number.isFinite(v.bulge) && Math.abs(v.bulge) <= 1e6 && Math.abs(v.x) <= 20 && Math.abs(v.y) <= 10),
    JSON.stringify(f.vertices));
  // a near-hairpin still fits smoothly (arcs, tangent-continuous)
  const g = X.fitCurve(PL([pt(0, 0), pt(10, 0), pt(5, 0.001)])).change[0];
  assert.ok(g.vertices.some((v) => v.bulge !== 0));
  assert.ok(g.vertices.every((v) => Number.isFinite(v.bulge)));
});

test('PEDIT Fit -> Width -> Decurve: old per-vertex widths do not come back', () => {
  const src = PL(P4); src.vertices = src.vertices.map((v, i) => ({ ...v, sw: 1 + i, ew: 2 + i }));
  const f = X.fitCurve(src).change[0];
  const w = X.setWidth(f, 3).change[0];
  const d = X.decurve(w).change[0];
  assert.equal(d.width, 3);
  assert.ok(d.vertices.every((v) => v.sw === undefined && v.ew === undefined), JSON.stringify(d.vertices));
});

test('PEDIT Fit -> move -> Decurve restores the frame at the new position', () => {
  const f = X.fitCurve(PL(P4)).change[0];
  const t = transformEntity(f, [1, 0, 0, 1, 5, 5]);
  const d = X.decurve(t).change[0];
  assert.equal(d.vertices.length, P4.length);
  d.vertices.forEach((v, i) => { near(v.x, P4[i].x + 5); near(v.y, P4[i].y + 5); });
});
