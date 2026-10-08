import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../src/core/modify.js';
import { makeLine, makeArc, makeCircle, makeRect, makePolyline, newDocument, addEntity } from '../src/core/model.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { readDxf } from '../src/core/dxfRead.js';
import { Session, applyEditSet } from '../src/core/edit.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol); near(p.y, y, tol); };
const withId = (e, id) => ({ ...e, id });
const pt = (x, y) => ({ x, y });

test('fillet two perpendicular lines r=5: centre (5,5), tangent points (5,0),(0,5)', () => {
  const a = withId(makeLine(pt(0, 0), pt(10, 0)), 1), b = withId(makeLine(pt(0, 0), pt(0, 10)), 2);
  const r = X.fillet(a, pt(8, 0), b, pt(0, 8), 5);
  const arc = r.add[0];
  nearPt(arc.c, 5, 5); near(arc.r, 5); near(arc.a0, 180); near(arc.a1, 270);
  nearPt(r.change.find((e) => e.id === 1).p1, 5, 0);
  nearPt(r.change.find((e) => e.id === 2).p1, 0, 5);
  // r = 0: sharp corner extends both lines to the intersection
  const c = withId(makeLine(pt(2, 0), pt(10, 0)), 3), d = withId(makeLine(pt(0, 3), pt(0, 10)), 4);
  const z = X.fillet(c, pt(8, 0), d, pt(0, 8), 0);
  assert.equal(z.add.length, 0);
  nearPt(z.change[0].p1, 0, 0); nearPt(z.change[1].p1, 0, 0);
});

test('fillet parallel lines -> semicircle at the end of the first line', () => {
  const a = withId(makeLine(pt(0, 0), pt(10, 0)), 1), b = withId(makeLine(pt(0, 4), pt(8, 4)), 2);
  const r = X.fillet(a, pt(9, 0), b, pt(5, 4), 1);
  const arc = r.add[0];
  nearPt(arc.c, 10, 2); near(arc.r, 2); near(arc.a0, 270); near(arc.a1, 90);
  nearPt(r.change[0].p2, 10, 4);
});

test('fillet line-arc and arc-arc are tangent', () => {
  const ln = withId(makeLine(pt(-10, 0), pt(10, 0)), 1), ar = withId(makeArc(pt(0, 5), 3, 180, 360), 2);
  const r = X.fillet(ln, pt(6, 0), ar, pt(3, 5), 1);
  const f = r.add[0];
  near(f.r, 1); near(f.c.y, 1); near(Math.hypot(f.c.x, f.c.y - 5), 4); // tangent to line and externally to the arc circle
  const a1 = withId(makeArc(pt(0, 0), 5, 0, 180), 3), a2 = withId(makeArc(pt(12, 0), 5, 0, 180), 4);
  const g = X.fillet(a1, pt(5, 0.5), a2, pt(7, 0.5), 1).add[0];
  near(Math.hypot(g.c.x, g.c.y), 6); near(Math.hypot(g.c.x - 12, g.c.y), 6);
});

test('polyline vertex fillet (one and all) and chamfer', () => {
  const sq = withId(makeRect(pt(0, 0), pt(10, 10)), 1);
  const one = X.filletPolyline(sq, 2, 0).change[0];
  assert.equal(one.vertices.length, 5);
  nearPt(one.vertices[0], 0, 2); nearPt(one.vertices[1], 2, 0); near(one.vertices[0].bulge, Math.tan(Math.PI / 8));
  const all = X.filletPolyline(sq, 2);
  assert.equal(all.count, 4); assert.equal(all.change[0].vertices.length, 8);
  const ch = X.chamferPolyline(sq, { d1: 2, d2: 2 }, 2).change[0];
  nearPt(ch.vertices[2], 10, 8); nearPt(ch.vertices[3], 8, 10); near(ch.vertices[2].bulge, 0);
});

test('chamfer 2,2 and distance+angle on a right-angle corner', () => {
  const a = withId(makeLine(pt(0, 0), pt(10, 0)), 1), b = withId(makeLine(pt(0, 0), pt(0, 10)), 2);
  const r = X.chamfer(a, pt(8, 0), b, pt(0, 8), { d1: 2, d2: 2 });
  nearPt(r.add[0].p1, 2, 0); nearPt(r.add[0].p2, 0, 2);
  nearPt(r.change[0].p1, 2, 0); nearPt(r.change[1].p1, 0, 2);
  const q = X.chamfer(a, pt(8, 0), b, pt(0, 8), { d1: 2, angle: 60 });
  nearPt(q.add[0].p2, 0, 2 * Math.tan(60 * Math.PI / 180));
});

test('break: line at point, circle between two points (CCW part removed), polyline', () => {
  const l = withId(makeLine(pt(0, 0), pt(10, 0)), 1);
  const r = X.breakAt(l, pt(4, 0));
  nearPt(r.change[0].p2, 4, 0); nearPt(r.add[0].p1, 4, 0);
  const c = withId(makeCircle(pt(0, 0), 1), 2);
  const a = X.breakBetween(c, pt(1, 0), pt(0, 1)).change[0];
  assert.equal(a.type, 'ARC'); assert.equal(a.id, 2); near(a.a0, 90); near(a.a1, 0);
  const pl = withId(makePolyline([pt(0, 0), { x: 10, y: 0, bulge: 1 }, pt(10, 10)]), 3);
  const b = X.breakBetween(pl, pt(5, 0), pt(15, 5));
  nearPt(b.change[0].vertices.at(-1), 5, 0);
  nearPt(b.add[0].vertices[0], 15, 5); near(b.add[0].vertices[0].bulge, Math.tan(Math.PI / 8));
  assert.throws(() => X.breakAt(c, pt(1, 0)), (e) => e.code === 'GEOMETRY');
});

test('join: collinear lines, co-circular arcs, lines+arc chain to polyline', () => {
  const r = X.join([withId(makeLine(pt(0, 0), pt(5, 0)), 1), withId(makeLine(pt(5, 0), pt(12, 0)), 2)]);
  assert.deepEqual(r.remove, [2]); nearPt(r.change[0].p1, 0, 0); nearPt(r.change[0].p2, 12, 0);
  const arcs = X.join([withId(makeArc(pt(0, 0), 2, 0, 90), 1), withId(makeArc(pt(0, 0), 2, 90, 200), 2)]);
  near(arcs.change[0].a0, 0); near(arcs.change[0].a1, 200);
  const circ = X.join([withId(makeArc(pt(0, 0), 2, 0, 180), 1), withId(makeArc(pt(0, 0), 2, 180, 360), 2)]);
  assert.equal(circ.change[0].type, 'CIRCLE');
  const pl = X.join([withId(makeLine(pt(0, 0), pt(10, 0)), 1), withId(makeArc(pt(10, 5), 5, 270, 90), 2), withId(makeLine(pt(0, 10), pt(10, 10)), 3)]);
  const v = pl.change[0].vertices;
  assert.equal(pl.change[0].type, 'LWPOLYLINE'); assert.equal(v.length, 4);
  nearPt(v[1], 10, 0); near(v[1].bulge, 1); nearPt(v[3], 0, 10);
});

test('lengthen line by 5, arc by angle, dynamic', () => {
  const l = withId(makeLine(pt(0, 0), pt(10, 0)), 1);
  nearPt(X.lengthen(l, pt(9, 0), { mode: 'delta', value: 5 }).change[0].p2, 15, 0);
  nearPt(X.lengthen(l, pt(1, 0), { mode: 'percent', value: 50 }).change[0].p1, 5, 0);
  nearPt(X.lengthen(l, pt(9, 0), { mode: 'dynamic', point: pt(12, 3) }).change[0].p2, 12, 0);
  const a = withId(makeArc(pt(0, 0), 2, 0, 90), 2);
  near(X.lengthen(a, pt(0, 2), { mode: 'delta', value: 30, angle: true }).change[0].a1, 120);
  near(X.lengthen(a, pt(2, 0), { mode: 'total', value: Math.PI }).change[0].a0, 0); // total length pi = 90 deg: unchanged
});

test('stretch a rectangle right side; arc keeps chord height', () => {
  const r = withId(makeRect(pt(0, 0), pt(10, 5)), 1);
  const s = X.stretch([r], { minx: 8, miny: -1, maxx: 12, maxy: 6 }, 5, 0).change[0];
  nearPt(s.vertices[0], 0, 0); nearPt(s.vertices[1], 15, 0); nearPt(s.vertices[2], 15, 5); nearPt(s.vertices[3], 0, 5);
  const a = withId(makeArc(pt(0, 0), 1, 0, 180), 2); // chord height 1
  const t = X.stretch([a], { minx: 0.5, miny: -0.5, maxx: 1.5, maxy: 0.5 }, 2, 0).change[0];
  const top = { x: t.c.x + t.r * Math.cos(((t.a0 + ((t.a1 - t.a0 + 360) % 360) / 2) * Math.PI) / 180), y: t.c.y + t.r * Math.sin(((t.a0 + ((t.a1 - t.a0 + 360) % 360) / 2) * Math.PI) / 180) };
  near(top.y, 1); near(t.c.x + t.r * Math.cos(t.a0 * Math.PI / 180), 3);
});

test('arrays: rectangular, polar 6 rotated, path 4 along a line', () => {
  const l = withId(makeLine(pt(10, 0), pt(12, 0)), 1);
  const rect = X.arrayRect([l], { rows: 2, cols: 3, rowSpacing: 5, colSpacing: 4 });
  assert.equal(rect.add.length, 5); nearPt(rect.add[4].p1, 18, 5);
  const pol = X.arrayPolar([l], { center: pt(0, 0), count: 6 });
  assert.equal(pol.add.length, 5);
  nearPt(pol.add[0].p1, 5, 10 * Math.sin(Math.PI / 3)); nearPt(pol.add[2].p2, -12, 0, 1e-9);
  const c = withId(makeCircle(pt(0, 0), 1), 2);
  const path = X.arrayPath([c], makeLine(pt(0, 0), pt(30, 0)), { count: 4, basePoint: pt(0, 0) });
  assert.deepEqual(path.add.map((e) => e.c.x), [0, 10, 20, 30]); assert.deepEqual(path.remove, [2]);
  const arcPath = X.arrayPath([l], makeArc(pt(0, 0), 10, 0, 180), { count: 3, basePoint: pt(10, 0) });
  nearPt(arcPath.add[1].p1, 0, 10); nearPt(arcPath.add[1].p2, 0, 12); // aligned: rotated 90 deg with the tangent
});

test('G2: results survive a DXF round trip; applyEditSet applies one undo step', () => {
  const doc = newDocument();
  const a = addEntity(doc, makeLine(pt(0, 0), pt(10, 0))), b = addEntity(doc, makeLine(pt(0, 0), pt(0, 10)));
  const s = new Session(doc);
  const added = applyEditSet(s, 'Fillet', X.fillet(a, pt(8, 0), b, pt(0, 8), 5));
  assert.equal(added.length, 1); assert.equal(doc.entities.length, 3);
  const pl = makeRect(pt(20, 0), pt(30, 10));
  addEntity(doc, X.filletPolyline({ ...pl, id: 9 }, 2).change[0]);
  addEntity(doc, X.breakBetween({ ...makeCircle(pt(50, 0), 3), id: 8 }, pt(53, 0), pt(50, 3)).change[0]);
  const back = readDxf(Buffer.from(writeDxf(doc)));
  const geo = (e) => JSON.stringify(e, (k, v) => (['id', 'parent', 'handle', 'owner'].includes(k) ? undefined : typeof v === 'number' ? Math.round(v * 1e9) / 1e9 + 0 : v));
  const pick = (d) => d.entities.map((e) => ({ type: e.type, p1: e.p1, p2: e.p2, c: e.c, r: e.r, a0: e.a0, a1: e.a1, vertices: e.vertices?.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge ?? 0 })), closed: e.closed }));
  assert.equal(geo(pick(back)), geo(pick(doc)));
  s.undo(); assert.equal(doc.entities.length, 4);
});
