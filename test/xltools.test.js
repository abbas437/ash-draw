import test from 'node:test';
import assert from 'node:assert/strict';
import { bisectorDir, lineOf, offsetXline } from '../src/core/xline-tools.js';
import { makeLine, makeXline, makePolyline } from '../src/core/model.js';

const H = Math.SQRT1_2;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearPt = (p, q) => { near(p.x, q.x); near(p.y, q.y); };
const distToLine = (q, l) => Math.abs(l.dir.x * (q.y - l.p.y) - l.dir.y * (q.x - l.p.x));

test('bisector of a right angle, of an obtuse angle, of a straight angle; null for a zero leg', () => {
  nearPt(bisectorDir({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }), { x: H, y: H });
  nearPt(bisectorDir({ x: 1, y: 1 }, { x: 1, y: 5 }, { x: -3, y: 1 }), { x: -H, y: H });
  nearPt(bisectorDir({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: -2, y: 0 }), { x: 0, y: 1 });
  assert.equal(bisectorDir({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
});

test('lineOf a LINE, an XLINE, the nearest straight polyline segment; null for an arc segment or a circle', () => {
  const l = lineOf(makeLine({ x: 0, y: 0 }, { x: 0, y: 4 }));
  nearPt(l.p, { x: 0, y: 0 }); nearPt(l.dir, { x: 0, y: 1 });
  nearPt(lineOf(makeXline('RAY', { x: 1, y: 2 }, { x: 3, y: 0 })).dir, { x: 1, y: 0 });
  const pl = makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false);
  const s = lineOf(pl, { x: 9, y: 6 });
  nearPt(s.p, { x: 10, y: 0 }); nearPt(s.dir, { x: 0, y: 1 });
  const arc = makePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }], false);
  assert.equal(lineOf(arc, { x: 5, y: -5 }), null);
  assert.equal(lineOf({ type: 'CIRCLE', c: { x: 0, y: 0 }, r: 1 }, { x: 1, y: 0 }), null);
});

test('offsetXline lands on the picked side at the given distance, parallel to the source', () => {
  const src = { p: { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
  for (const [side, y] of [[{ x: 3, y: 2 }, 5], [{ x: -7, y: -1 }, -5]]) {
    const o = offsetXline(src, 5, side);
    nearPt(o.dir, src.dir); near(o.p.y, y);
    near(distToLine(o.p, src), 5);
  }
  const diag = { p: { x: 2, y: 2 }, dir: { x: H, y: H } };
  const o = offsetXline(diag, 3, { x: 0, y: 10 }); // above-left of y=x
  near(distToLine(o.p, diag), 3);
  assert.ok(o.p.y - o.p.x > 0, 'on the side of the pick');
  assert.equal(offsetXline(src, 5, { x: 9, y: 0 }), null);
});
