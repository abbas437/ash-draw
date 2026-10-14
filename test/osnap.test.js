import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/model.js';
import { SpatialIndex, findSnap, polarPoint } from '../src/core/pick.js';
import { tangentPoints, parallelPoint, directionAt, geometricCenter, snapGlyph, OSNAP_MODES, cleanModes, parseAngles } from '../src/core/osnap.js';

const P = (x, y) => ({ x, y });
const nearPt = (p, x, y, tol = 1e-9) => assert.ok(p && Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol, `${JSON.stringify(p)} !~ ${x},${y}`);
function docWith(...ents) {
  const doc = M.newDocument();
  const out = ents.map((e) => M.addEntity(doc, e));
  return { doc, ents: out, index: new SpatialIndex(doc) };
}

test('tangentPoints: circle from outside, inside / on it none; arc only within its sweep', () => {
  const c = M.makeCircle(P(0, 0), 5);
  // from (10,0): tangent points at angle ±acos(0.5) = ±60 deg
  const t = tangentPoints(c, P(10, 0)).sort((a, b) => b.y - a.y);
  assert.equal(t.length, 2);
  nearPt(t[0], 2.5, 5 * Math.sin(Math.PI / 3)); nearPt(t[1], 2.5, -5 * Math.sin(Math.PI / 3));
  for (const q of t) assert.ok(Math.abs((q.x - 10) * q.x + q.y * q.y) < 1e-9, 'radius is perpendicular to the tangent line');
  assert.deepEqual(tangentPoints(c, P(1, 1)), []);
  assert.deepEqual(tangentPoints(c, P(5, 0)), []);
  const arc = M.makeArc(P(0, 0), 5, 0, 90); // upper-right quarter
  const ta = tangentPoints(arc, P(10, 0));
  assert.equal(ta.length, 1); nearPt(ta[0], 2.5, 5 * Math.sin(Math.PI / 3));
  assert.deepEqual(tangentPoints(M.makeLine(P(0, 0), P(1, 1)), P(10, 0)), []);
});

test('findSnap: tangent from the last point, only when the mode is on and there is a last point', () => {
  const { index, ents: [c] } = docWith(M.makeCircle(P(0, 0), 5));
  const p = P(2.6, 4.4), tp = { x: 2.5, y: 5 * Math.sin(Math.PI / 3) };
  const s = findSnap(index, p, 0.5, { from: P(10, 0), kinds: new Set(['tan', 'near']) });
  assert.equal(s.kind, 'tan'); assert.equal(s.id, c.id); nearPt(s, tp.x, tp.y);
  assert.equal(findSnap(index, p, 0.5, { from: P(10, 0), kinds: new Set(['near']) }).kind, 'near');
  assert.equal(findSnap(index, p, 0.5, { kinds: new Set(['tan']) }), null);
});

test('parallelPoint and directionAt; findSnap par with an acquired direction', () => {
  nearPt(parallelPoint(P(0, 0), P(5, 5.2), P(1, 1), 0.5), 5.1, 5.1);
  assert.equal(parallelPoint(P(0, 0), P(5, 7), P(1, 1), 0.5), null);
  assert.equal(parallelPoint(P(0, 0), P(5, 5), P(0, 0), 0.5), null);
  nearPt(directionAt(M.makeLine(P(1, 1), P(4, 5)), P(2, 2)), 0.6, 0.8);
  const pl = M.makePolyline([P(0, 0), P(10, 0), P(10, 10)], false);
  nearPt(directionAt(pl, P(10.1, 6)), 0, 1);
  assert.equal(directionAt(M.makeCircle(P(0, 0), 1), P(1, 0)), null);
  const { index } = docWith(M.makeLine(P(100, 100), P(110, 100)));
  const s = findSnap(index, P(20, 10.3), 0.5, { from: P(0, 0), parallel: P(2, 1), kinds: new Set(['par']) });
  assert.equal(s.kind, 'par'); nearPt(s, 20.12, 10.06); assert.deepEqual(s.from, P(0, 0));
  assert.equal(findSnap(index, P(20, 10.3), 0.5, { from: P(0, 0), parallel: P(2, 1), kinds: new Set(['end']) }), null);
});

test('geometricCenter: rectangle, circle from two bulges, D shape; open polyline none; findSnap gcen', () => {
  nearPt(geometricCenter(M.makePolyline([P(0, 0), P(4, 0), P(4, 2), P(0, 2)], true)), 2, 1);
  nearPt(geometricCenter(M.makePolyline([P(0, 0), P(6, 0), P(6, 3), P(3, 3), P(3, 6), P(0, 6)], true)), 2.5, 2.5); // L: 3 squares of 9
  const circ = M.makePolyline([{ x: 3, y: 1, bulge: 1 }, { x: 7, y: 1, bulge: 1 }], true);
  nearPt(geometricCenter(circ), 5, 1);
  // D: chord from (0,-2) to (0,2) with the half disc to the right (bulge -1 clockwise from top to bottom)
  const d = M.makePolyline([{ x: 0, y: -2, bulge: 0 }, { x: 0, y: 2, bulge: -1 }], true);
  nearPt(geometricCenter(d), (4 * 2) / (3 * Math.PI), 0);
  assert.equal(geometricCenter(M.makePolyline([P(0, 0), P(4, 0), P(4, 2)], false)), null);
  assert.equal(geometricCenter(M.makePolyline([P(0, 0), P(6, 4), P(6, 0), P(0, 2)], true)), null, 'self-intersecting (uneven bowtie)');
  const sq = M.makePolyline([P(0, 0), P(4, 0), P(4, 2), P(0, 2)], true);
  assert.equal(geometricCenter(sq), geometricCenter(sq), 'cached per entity object');
  const { index, ents: [r] } = docWith(M.makePolyline([P(0, 0), P(4, 0), P(4, 2), P(0, 2)], true));
  assert.deepEqual(findSnap(index, P(2.1, 1.1), 0.5, { kinds: new Set(['gcen']) }), { x: 2, y: 1, kind: 'gcen', id: r.id });
  assert.equal(findSnap(index, P(2.1, 1.1), 0.5, { kinds: new Set(['cen', 'end']) }), null);
});

test('polarPoint: additional angles', () => {
  const r = polarPoint(P(0, 0), P(10 * Math.cos(0.3), 10 * Math.sin(0.3)), 90, 5, [17]); // 17.19 deg
  assert.equal(r.snapped, true); assert.ok(Math.abs(r.angle - 17) < 1e-9);
  const w = polarPoint(P(0, 0), P(10 * Math.cos(-0.05), 10 * Math.sin(-0.05)), 90, 5, [358]); // -2.86 -> 358 beats 0
  assert.ok(Math.abs(w.angle - 358) < 1e-9);
  assert.equal(polarPoint(P(0, 0), P(10, 3), 90, 5, [30]).snapped, false); // 16.7 deg
  assert.deepEqual(parseAngles('12.5, 80; -10 x'), [12.5, 80, 350]);
});

test('OSNAP modes: every mode has its own glyph; cleanModes keeps implemented ones', () => {
  const g = OSNAP_MODES.map(([k]) => JSON.stringify(snapGlyph(k)));
  assert.equal(new Set(g).size, g.length);
  assert.deepEqual(cleanModes(['end', 'app', 'tan', 'bogus', 'end']), ['end', 'tan']);
  assert.equal(cleanModes('x'), null);
});
