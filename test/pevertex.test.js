import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../src/core/pedit.js';
import { makePolyline } from '../src/core/model.js';

const pt = (x, y) => ({ x, y });
const PL = (pts, closed = false) => ({ ...makePolyline(pts), id: 5, layer: 'WALLS', closed });
const xy = (v) => v.map((q) => [q.x, q.y]);
const P4 = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];

test('insertVertex: a new vertex after vertex 1, both halves straight', () => {
  const e = PL(P4); e.vertices[1].bulge = 0.5;
  const [c] = X.insertVertex(e, 1, pt(15, 5)).change;
  assert.equal(c.vertices.length, 5);
  assert.deepEqual(xy(c.vertices), [[0, 0], [10, 0], [15, 5], [10, 10], [0, 10]]);
  assert.equal(c.vertices[1].bulge, 0); assert.equal(c.vertices[2].bulge, 0);
  assert.equal(c.id, 5); assert.equal(e.vertices.length, 4, 'the input is not changed');
});

test('insertVertex drops a Fit / Spline frame', () => {
  const [f] = X.fitCurve(PL(P4)).change;
  assert.ok(f.frame);
  const [c] = X.insertVertex(f, 0, pt(1, 1)).change;
  assert.equal(c.frame, undefined); assert.equal(c.frameKind, undefined);
});

test('moveVertex moves only that vertex', () => {
  const [c] = X.moveVertex(PL(P4), 2, pt(12, 13)).change;
  assert.deepEqual(xy(c.vertices), [[0, 0], [10, 0], [12, 13], [0, 10]]);
});

test('breakBetween 1 and 2 on an open polyline gives two polylines', () => {
  const r = X.breakBetween(PL(P4), 1, 2);
  assert.equal(r.change.length, 1); assert.equal(r.add.length, 1);
  assert.deepEqual(xy(r.change[0].vertices), [[0, 0], [10, 0]]);
  assert.equal(r.change[0].id, 5);
  assert.deepEqual(xy(r.add[0].vertices), [[10, 10], [0, 10]]);
  assert.equal(r.add[0].layer, 'WALLS');
  assert.ok(!r.change[0].closed && !r.add[0].closed);
});

test('breakBetween from the first vertex shortens; order of the marks does not matter', () => {
  const r = X.breakBetween(PL(P4), 2, 0);
  assert.equal(r.add.length, 0);
  assert.deepEqual(xy(r.change[0].vertices), [[10, 10], [0, 10]]);
  assert.throws(() => X.breakBetween(PL(P4), 0, 3), /whole/);
});

test('breakBetween on a closed polyline opens it, starting after the break', () => {
  const r = X.breakBetween(PL(P4, true), 1, 2);
  assert.equal(r.add.length, 0);
  const c = r.change[0];
  assert.equal(c.closed, false);
  assert.deepEqual(xy(c.vertices), [[10, 10], [0, 10], [0, 0], [10, 0]]);
  assert.equal(c.vertices.at(-1).bulge, 0);
});

test('straightenBetween 1..3 removes vertex 2 and zeroes the bulge at 1', () => {
  const e = PL([...P4, pt(-5, 5)]); e.vertices[1].bulge = 0.4; e.vertices[2].bulge = -0.3;
  const [c] = X.straightenBetween(e, 1, 3).change;
  assert.deepEqual(xy(c.vertices), [[0, 0], [10, 0], [0, 10], [-5, 5]]);
  assert.equal(c.vertices[1].bulge, 0);
});

test('setSegmentWidth sets sw / ew on the vertex the segment starts at', () => {
  const [c] = X.setSegmentWidth(PL(P4), 1, 2, 4).change;
  assert.equal(c.vertices[1].sw, 2); assert.equal(c.vertices[1].ew, 4);
  for (const k of [0, 2, 3]) assert.equal(c.vertices[k].sw, undefined);
  assert.throws(() => X.setSegmentWidth(PL(P4), 3, 1), /no segment/);
  assert.equal(X.setSegmentWidth(PL(P4, true), 3, 1).change[0].vertices[3].ew, 1, 'closed: the closing segment');
});
