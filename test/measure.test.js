import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/model.js';
import { loopMeasure, entityMeasure, AreaTotal, angleAt, unitLabel } from '../src/core/measure.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test('rectangle 10 x 20: area 200, perimeter 60 (either winding)', () => {
  const r = entityMeasure(M.makeRect({ x: 0, y: 0 }, { x: 10, y: 20 }));
  close(r.area, 200, 'area'); close(r.perimeter, 60, 'perimeter');
  close(loopMeasure([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 0 }]).area, 200, 'clockwise area');
});

test('polyline with a bulge arc: semicircle added to a 20 x 10 rectangle', () => {
  const v = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10, bulge: 1 }, { x: 0, y: 10 }];
  const r = entityMeasure(M.makePolyline(v, true));
  close(r.area, 200 + 50 * Math.PI, 'area'); close(r.perimeter, 40 + 10 * Math.PI, 'perimeter');
  v[2].bulge = -1; // the same arc bulging inwards cuts the semicircle out
  close(loopMeasure(v).area, 200 - 50 * Math.PI, 'inward bulge area');
  close(entityMeasure(M.makePolyline(v, false)) ?? -1, -1, 'open polyline has no area');
});

test('circle, two-bulge circle, ellipse and hatch with island', () => {
  close(entityMeasure(M.makeCircle({ x: 1, y: 1 }, 5)).area, 25 * Math.PI, 'circle');
  close(loopMeasure([{ x: 5, y: 0, bulge: 1 }, { x: -5, y: 0, bulge: 1 }]).perimeter, 10 * Math.PI, 'bulge circle');
  const el = entityMeasure(M.makeEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5));
  close(el.area, 50 * Math.PI, 'ellipse area');
  assert.ok(Math.abs(el.perimeter - 48.4422411) < 1e-6, `ellipse perimeter ${el.perimeter}`);
  const sq = (s) => ({ pts: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }], closed: true });
  close(entityMeasure(M.makeHatch([sq(10), sq(2)])).area, 96, 'hatch minus island');
});

test('AREA add / subtract running total', () => {
  const t = new AreaTotal();
  t.push(200); t.push(50); t.mode = 'subtract'; t.push(30);
  close(t.total, 220, 'total');
});

test('angle and unit label', () => {
  close(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 3 }), 90, 'right angle');
  close(angleAt({ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 1, y: 1 }), 90, 'across 0');
  assert.equal(unitLabel(4), 'mm'); assert.equal(unitLabel(0), '');
});

test('hatch area by even-odd nesting: separate outer loops add, holes subtract, islands add again', () => {
  const sq = (x, y, s) => ({ pts: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }], closed: true });
  const two = entityMeasure(M.makeHatch([sq(0, 0, 10), sq(20, 0, 5)]));
  close(two.area, 125, 'two disjoint rooms add up'); assert.equal(two.loops, 2);
  close(two.perimeter, 60, 'perimeter of both');
  const hole = entityMeasure(M.makeHatch([sq(2, 2, 4), sq(0, 0, 10)])); // loop order does not matter
  close(hole.area, 84, 'outer minus hole'); assert.equal(hole.loops, 2);
  const island = entityMeasure(M.makeHatch([sq(0, 0, 10), sq(2, 2, 6), sq(4, 4, 2)]));
  close(island.area, 100 - 36 + 4, 'outer - hole + island'); assert.equal(island.loops, 3);
  // a separate room beside a room with a hole: 100 - 36 + 25
  close(entityMeasure(M.makeHatch([sq(0, 0, 10), sq(2, 2, 6), sq(20, 0, 5)])).area, 89, 'room with hole plus a second room');
  // a hole that touches the outer boundary (shared corner) and a bulged (circular) island inside a hole
  close(entityMeasure(M.makeHatch([sq(0, 0, 10), sq(0, 0, 4)])).area, 84, 'hole sharing a corner with the outer loop');
  const disc = { pts: [{ x: 4, y: 5, bulge: 1 }, { x: 6, y: 5, bulge: 1 }], closed: true };
  close(entityMeasure(M.makeHatch([sq(0, 0, 10), sq(2, 2, 6), disc])).area, 64 + Math.PI, 'round island in a hole');
});

test('hatch edge loops are measured from their tessellation, nested the same way', () => {
  const edge = (x, y, s) => ({ segs: [{ type: 'line', p1: { x, y }, p2: { x: x + s, y } }], closed: true });
  const poly = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
  const r = entityMeasure(M.makeHatch([edge(0, 0, 10), edge(20, 0, 5)]), [poly(0, 0, 10), poly(20, 0, 5)]);
  close(r.area, 125, 'edge loops add'); assert.equal(r.loops, 2);
});
