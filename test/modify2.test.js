import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../src/core/pedit.js';
import { makeLine, makeArc, makeCircle, makePolyline, makeSpline } from '../src/core/model.js';
import { plSegs, ccwSweep, DEG, tessellate } from '../src/core/geom.js';
import { Session, applyEditSet } from '../src/core/edit.js';
import { newDocument, addEntity } from '../src/core/model.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol); near(p.y, y, tol); };
const pt = (x, y) => ({ x, y });
const withId = (e, id, extra = {}) => ({ ...e, id, ...extra });
const plLen = (e) => plSegs(e).reduce((s, g) => s + g.len, 0);
const len = (e) => (e.type === 'LINE' ? Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y) : e.type === 'ARC' ? e.r * ccwSweep(e.a0 * DEG, e.a1 * DEG) : plLen(e));
const ends = (e) => { const v = e.vertices; return [v[0], v[v.length - 1]]; };
const PROPS = { layer: 'WALLS', color: 3, linetype: 'DASHED', lineweight: 35, transparency: 40, xdata: { ACAD: [[1000, 'x']] } };

test('PEDIT convert: a LINE and an ARC become polylines with the same id, properties and geometry', () => {
  const l = withId(makeLine(pt(0, 0), pt(10, 0)), 7, PROPS);
  const p = X.toPolyline(l).change[0];
  assert.equal(p.type, 'LWPOLYLINE'); assert.equal(p.id, 7); assert.equal(p.closed, false);
  for (const [k, v] of Object.entries(PROPS)) assert.deepEqual(p[k], v, k);
  assert.equal(p.p1, undefined);
  nearPt(p.vertices[0], 0, 0); nearPt(p.vertices[1], 10, 0);
  const a = withId(makeArc(pt(0, 0), 5, 0, 90), 8);
  const q = X.toPolyline(a).change[0];
  nearPt(q.vertices[0], 5, 0); nearPt(q.vertices[1], 0, 5); near(q.vertices[0].bulge, Math.tan(Math.PI / 8));
  near(plLen(q), 5 * Math.PI / 2);
  assert.throws(() => X.toPolyline(withId(makeCircle(pt(0, 0), 1), 9)), /cannot be turned/);
});

test('PEDIT Close / Open, Width, Decurve', () => {
  const pl = withId(makePolyline([pt(0, 0), { x: 10, y: 0, bulge: 0.5 }, pt(10, 10)]), 3, PROPS);
  const c = X.setClosed(pl, true).change[0];
  assert.equal(c.closed, true); assert.equal(c.id, 3); assert.equal(c.layer, 'WALLS');
  assert.equal(X.setClosed(c, false).change[0].closed, false);
  const w = X.setWidth({ ...pl, vertices: pl.vertices.map((v) => ({ ...v, sw: 1, ew: 2 })) }, 0.5).change[0];
  assert.equal(w.width, 0.5);
  assert.ok(w.vertices.every((v) => v.sw === undefined && v.ew === undefined), 'per-vertex widths replaced');
  assert.equal(X.setWidth(w, 0).change[0].width, undefined);
  const d = X.decurve(pl).change[0];
  assert.ok(d.vertices.every((v) => v.bulge === 0));
  near(plLen(d), 20);
  assert.equal(pl.vertices[1].bulge, 0.5, 'source untouched');
});

test('PEDIT Join chains touching lines and arcs, including pieces drawn the other way', () => {
  const pl = withId(makePolyline([pt(0, 0), pt(10, 0)]), 1, PROPS);
  const l1 = withId(makeLine(pt(10, 10), pt(10, 0)), 2);              // reversed, at the tail
  const arc = withId(makeArc(pt(0, 5), 5, 90, 270), 3);              // (0,10) -> (0,0) CCW: reversed at the head end
  const l3 = withId(makeLine(pt(0, 10), pt(10, 10)), 4);              // closes the loop
  const far = withId(makeLine(pt(50, 50), pt(60, 50)), 5);
  const r = X.joinToPolyline(pl, [l1, arc, l3, far], { fuzz: 0 });
  assert.equal(r.joined, 3);
  assert.deepEqual(r.remove.sort(), [2, 3, 4]);
  const j = r.change[0];
  assert.equal(j.id, 1); assert.equal(j.layer, 'WALLS'); assert.equal(j.closed, false);
  near(plLen(j), 10 + 10 + 10 + 5 * Math.PI);
  // consecutive vertices are joined end to end: every segment starts where the previous one ended
  const [s, e] = ends(j);
  nearPt(s, e.x, e.y); // the chain came round to its start
  // the arc piece kept its shape: its segment length is half a circle of radius 5
  assert.ok(plSegs(j).some((g) => g.arc && Math.abs(g.len - 5 * Math.PI) < 1e-9));
  // the arc bulges away from the square (x < 0)
  const arcSeg = plSegs(j).find((g) => g.arc);
  near(arcSeg.arc.c.x, 0); near(arcSeg.arc.c.y, 5);
  const midArc = { x: arcSeg.arc.c.x + 5 * Math.cos(arcSeg.arc.a0 + arcSeg.arc.sweep / 2), y: 5 + 5 * Math.sin(arcSeg.arc.a0 + arcSeg.arc.sweep / 2) };
  nearPt(midArc, -5, 5);
});

test('PEDIT Join with a fuzz distance, and onto the head of the polyline', () => {
  const pl = withId(makePolyline([pt(0, 0), pt(10, 0)]), 1);
  const head = withId(makeLine(pt(0.001, 0), pt(-5, 0)), 2); // start touches the head: reversed and prepended
  assert.equal(X.joinToPolyline(pl, [head]).joined, 0, 'no fuzz: not touching');
  const r = X.joinToPolyline(pl, [head], { fuzz: 0.01 });
  assert.equal(r.joined, 1);
  const v = r.change[0].vertices;
  assert.equal(v.length, 3); nearPt(v[0], -5, 0); nearPt(v[1], 0, 0); nearPt(v[2], 10, 0);
  assert.throws(() => X.joinToPolyline({ ...pl, closed: true }, [head]), /closed/);
});

test('PEDIT Multiple Join: three touching lines in any direction become one polyline', () => {
  const a = withId(makeLine(pt(0, 0), pt(10, 0)), 1), b = withId(makeLine(pt(10, 5), pt(10, 0)), 2), c = withId(makeLine(pt(10, 5), pt(0, 5)), 3);
  const r = X.joinMany([a, b, c]);
  assert.equal(r.change.length, 1); assert.equal(r.remove.length, 2); assert.equal(r.joined, 2);
  near(plLen(r.change[0]), 25);
});

test('REVERSE a polyline: vertex order, bulges and per-vertex widths move with their segments', () => {
  const v = [{ x: 0, y: 0, bulge: 0.3, sw: 1, ew: 2 }, { x: 10, y: 0, bulge: 0, sw: 3, ew: 4 }, { x: 10, y: 10, bulge: -0.2, sw: 5, ew: 6 }];
  const open = withId(makePolyline([]), 1); open.vertices = v; open.closed = false;
  const r = X.reverseEntity(open);
  assert.deepEqual(r.vertices.map((q) => [q.x, q.y]), [[10, 10], [10, 0], [0, 0]]);
  // new seg 0 = old seg 1 backwards; new seg 1 = old seg 0 backwards
  assert.deepEqual(r.vertices.map((q) => q.bulge), [-0, -0.3, 0].map((b) => b || 0));
  assert.deepEqual([r.vertices[0].sw, r.vertices[0].ew, r.vertices[1].sw, r.vertices[1].ew], [4, 3, 2, 1]);
  near(plLen(r), plLen(open));
  const closed = { ...open, closed: true };
  const rc = X.reverseEntity(closed);
  // closing segment: old seg 2 (v2 -> v0) becomes new seg 2 (v0 -> v2)
  assert.deepEqual(rc.vertices.map((q) => q.bulge), [-0, -0.3, 0.2].map((b) => b || 0));
  assert.deepEqual([rc.vertices[2].sw, rc.vertices[2].ew], [6, 5]);
  near(plLen(rc), plLen(closed));
  // reversing twice gives the original (the last vertex of an open polyline starts no segment: only its position counts)
  assert.deepEqual(X.reverseEntity(r).vertices.slice(0, -1), open.vertices.slice(0, -1));
  assert.deepEqual(X.reverseEntity(rc).vertices, closed.vertices);
});

test('REVERSE lines, arcs and splines: same shape, opposite direction', () => {
  const l = X.reverseEntity(withId(makeLine(pt(0, 0), pt(3, 4)), 1, PROPS));
  nearPt(l.p1, 3, 4); nearPt(l.p2, 0, 0); assert.equal(l.color, 3);
  const a = withId(makeArc(pt(1, 1), 2, 10, 100), 2);
  const ra = X.reverseEntity(a);
  assert.deepEqual([ra.c, ra.r, ra.a0, ra.a1], [a.c, a.r, a.a0, a.a1], 'arc geometry unchanged');
  const sp = withId(makeSpline({ ctrl: [pt(0, 0), pt(1, 2), pt(3, 2), pt(4, 0)], knots: [0, 0, 0, 0, 1, 1, 1, 1] }), 3);
  const rs = X.reverseEntity(sp);
  const P = tessellate(sp)[0], Q = tessellate(rs)[0];
  nearPt(Q[0], P[P.length - 1].x, P[P.length - 1].y); nearPt(Q[Q.length - 1], P[0].x, P[0].y);
  nearPt(Q[Math.floor(Q.length / 2)], P[Math.ceil((P.length - 1) / 2)].x, P[Math.ceil((P.length - 1) / 2)].y, 1e-6);
  const set = X.reverse([withId(makeLine(pt(0, 0), pt(1, 0)), 4), withId(makeCircle(pt(0, 0), 1), 5)]);
  assert.equal(set.change.length, 1); assert.equal(set.failed.length, 1);
});

test('BREAKATPOINT: the point lies on both pieces, the total length is kept, arcs keep centre and radius', () => {
  const l = withId(makeLine(pt(0, 0), pt(10, 0)), 1, PROPS);
  const r = X.breakAtPoint(l, pt(4, 0));
  const [p1, p2] = [r.change[0], r.add[0]];
  assert.equal(p1.id, 1); assert.equal(p2.layer, 'WALLS'); assert.deepEqual(p2.xdata, PROPS.xdata);
  nearPt(p1.p2, 4, 0); nearPt(p2.p1, 4, 0);
  near(len(p1) + len(p2), 10);

  const a = withId(makeArc(pt(2, 3), 5, 0, 180), 2);
  const ra = X.breakAtPoint(a, pt(2, 8));
  const [a1, a2] = [ra.change[0], ra.add[0]];
  for (const q of [a1, a2]) { nearPt(q.c, 2, 3); near(q.r, 5); }
  near(a1.a1, 90); near(a2.a0, 90);
  near(len(a1) + len(a2), len(a));

  const pl = withId(makePolyline([pt(0, 0), { x: 10, y: 0, bulge: 1 }, pt(10, 10)]), 3);
  const rp = X.breakAtPoint(pl, pt(5, 0));
  const [q1, q2] = [rp.change[0], rp.add[0]];
  nearPt(ends(q1)[1], 5, 0); nearPt(ends(q2)[0], 5, 0);
  near(plLen(q1) + plLen(q2), plLen(pl));

  const sp = withId(makeSpline({ ctrl: [pt(0, 0), pt(1, 2), pt(3, 2), pt(4, 0)], knots: [0, 0, 0, 0, 1, 1, 1, 1] }), 4);
  const rs = X.breakAtPoint(sp, pt(2, 1.5));
  const S1 = tessellate(rs.change[0])[0], S2 = tessellate(rs.add[0])[0];
  nearPt(S1[S1.length - 1], S2[0].x, S2[0].y, 1e-9);
  nearPt(S2[0], 2, 1.5, 1e-9);

  assert.throws(() => X.breakAtPoint(withId(makeCircle(pt(0, 0), 1), 5), pt(1, 0)), /360/);
  assert.throws(() => X.breakAtPoint({ ...pl, closed: true }, pt(5, 0)), /closed object/);
  assert.throws(() => X.breakAtPoint(l, pt(0, 0)), /end/);
});

test('mergeTopSteps: several PEDIT steps undo as one', () => {
  const doc = newDocument();
  const s = new Session(doc);
  const l = addEntity(doc, makeLine(pt(0, 0), pt(10, 0)));
  applyEditSet(s, 'Pedit', X.toPolyline(l));
  applyEditSet(s, 'Pedit', X.setWidth(doc.entities.find((e) => e.id === l.id), 2));
  assert.equal(X.mergeTopSteps(s, 2, 'Pedit'), true);
  assert.equal(s.undoStack.length, 1);
  s.undo();
  const back = doc.entities.find((e) => e.id === l.id);
  assert.equal(back.type, 'LINE'); assert.equal(back.width, undefined);
});
