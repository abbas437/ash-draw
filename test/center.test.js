import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLine, makeCircle, makeArc } from '../src/core/model.js';
import { defaultDimStyle } from '../src/core/dimsStyle.js';
import { dimCenOf, dimCenterSegs, centerMarkSegs, centerlineSeg } from '../src/core/center.js';

const r6 = (v) => +v.toFixed(6) + 0;
const flat = (segs) => segs.map(([a, b]) => [r6(a.x), r6(a.y), r6(b.x), r6(b.y)]);

test('DIMCEN defaults: 2.5 for ISO-25, 0.09 for Standard; DIMSCALE multiplies; a missing value falls back', () => {
  assert.equal(dimCenOf(defaultDimStyle('ISO-25')), 2.5);
  assert.equal(dimCenOf(defaultDimStyle('Standard')), 0.09);
  assert.equal(dimCenOf({ ...defaultDimStyle('ISO-25'), DIMCEN: -2.5, DIMSCALE: 2 }), -5);
  const { DIMCEN, ...old } = defaultDimStyle('ISO-25');
  assert.equal(DIMCEN, 2.5);
  assert.equal(dimCenOf(old), 2.5);
});

test('DIMCEN 2.5: a cross of two lines at the centre of R10 at (5,5)', () => {
  assert.deepEqual(flat(dimCenterSegs(makeCircle({ x: 5, y: 5 }, 10), 2.5)), [[2.5, 5, 7.5, 5], [5, 2.5, 5, 7.5]]);
});

test('DIMCEN -2.5: the cross plus four extension lines, a gap of 2.5 after the cross, ending 2.5 beyond the circle', () => {
  const s = flat(dimCenterSegs(makeArc({ x: 5, y: 5 }, 10, 0, 90), -2.5));
  assert.equal(s.length, 6);
  assert.deepEqual(s.slice(0, 2), [[2.5, 5, 7.5, 5], [5, 2.5, 5, 7.5]]);
  assert.deepEqual(s.slice(2), [[10, 5, 17.5, 5], [0, 5, -7.5, 5], [5, 10, 5, 17.5], [5, 0, 5, -7.5]]);
});

test('extension lines are left out when the circle is too small for them; 0 draws nothing; not a circle throws', () => {
  assert.equal(centerMarkSegs({ x: 0, y: 0 }, 2, 2.5, true).length, 2);
  assert.deepEqual(centerMarkSegs({ x: 0, y: 0 }, 10, 0, true), []);
  assert.throws(() => dimCenterSegs(makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }), 2.5), (e) => e.code === 'NOTARC');
});

test('centerline of two parallel lines is the midline over both projections plus 2.5 each end', () => {
  const s = centerlineSeg(makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), makeLine({ x: 2, y: 4 }, { x: 12, y: 4 }), 2.5);
  assert.deepEqual(flat([s]), [[-2.5, 2, 14.5, 2]]);
  // opposite drawing directions give the same axis
  const t = centerlineSeg(makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), makeLine({ x: 12, y: 4 }, { x: 2, y: 4 }), 2.5);
  assert.deepEqual(flat([t]).map((v) => v.slice().sort((a, b) => a - b)), [[-2.5, 2, 2, 14.5]]);
});

test('centerline of two non-parallel lines bisects the angle between them', () => {
  // y = 0 (x 2..10) and y = x (2,2)..(10,10): bisector at 22.5 deg through the origin
  const [a, b] = centerlineSeg(makeLine({ x: 10, y: 0 }, { x: 2, y: 0 }), makeLine({ x: 2, y: 2 }, { x: 10, y: 10 }), 1);
  const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  assert.ok(Math.abs(ang - 22.5) < 1e-9, `angle ${ang}`);
  assert.ok(Math.abs(a.x * Math.tan(Math.PI / 8) - a.y) < 1e-9, 'through the intersection');
  const t = (p) => Math.hypot(p.x, p.y);
  const proj = [2 * Math.cos(Math.PI / 8), 10 * Math.SQRT2 * Math.cos(Math.PI / 8)];
  assert.ok(Math.abs(t(a) - (Math.min(...proj) - 1)) < 1e-9 && Math.abs(t(b) - (Math.max(...proj) + 1)) < 1e-9);
  assert.throws(() => centerlineSeg(makeLine({ x: 0, y: 0 }, { x: 0, y: 0 }), makeLine({ x: 0, y: 1 }, { x: 1, y: 1 }), 1), (e) => e.code === 'ZERO');
});
