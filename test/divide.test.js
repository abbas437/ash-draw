import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLine, makeCircle, makePolyline, makeSpline, makeEllipse } from '../src/core/model.js';
import { nurbsOf, pointAt, nearestParam } from '../src/core/nurbs.js';
import { divideStations, measureStations, placeAt, curveOf } from '../src/core/divide.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const nearP = (p, x, y, tol = 1e-9) => near(p.x, x, tol) && near(p.y, y, tol);

test('DIVIDE a line 0->10 into 4: points at 2.5, 5, 7.5', () => {
  const st = divideStations(makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), 4);
  assert.deepEqual(st.map((s) => s.p.x), [2.5, 5, 7.5]);
  assert.ok(st.every((s) => s.p.y === 0));
  const pts = placeAt(st, { props: { layer: 'L1' } });
  assert.ok(pts.every((e) => e.type === 'POINT' && e.layer === 'L1'));
});

test('DIVIDE a circle R10 into 4: four points from angle 0, counter-clockwise', () => {
  const st = divideStations(makeCircle({ x: 0, y: 0 }, 10), 4);
  assert.equal(st.length, 4);
  [[10, 0], [0, 10], [-10, 0], [0, -10]].forEach(([x, y], i) => assert.ok(nearP(st[i].p, x, y), `${i}: ${JSON.stringify(st[i].p)}`));
});

test('DIVIDE a closed polyline starts at its first vertex and gives N points', () => {
  const sq = makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true);
  const st = divideStations(sq, 8);
  assert.equal(st.length, 8);
  assert.ok(nearP(st[0].p, 0, 0)); assert.ok(nearP(st[1].p, 5, 0)); assert.ok(nearP(st[7].p, 0, 5));
});

test('DIVIDE an open polyline with an arc segment: equal arc lengths, points on the arc', () => {
  // 0,0 -> 10,0 straight (10), then a half circle (bulge 1) to 10,10: radius 5, length 5*pi
  const pl = makePolyline([{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 1 }, { x: 10, y: 10, bulge: 0 }], false);
  const L = 10 + 5 * Math.PI;
  assert.ok(near(curveOf(pl).len, L));
  const st = divideStations(pl, 3);
  assert.equal(st.length, 2);
  // first at L/3 = 8.57 on the straight part, second at 2L/3 on the arc: 2L/3 - 10 along it from the arc start
  assert.ok(nearP(st[0].p, L / 3, 0));
  const a = -Math.PI / 2 + (2 * L / 3 - 10) / 5; // arc centre (10,5), ccw from the bottom
  assert.ok(nearP(st[1].p, 10 + 5 * Math.cos(a), 5 + 5 * Math.sin(a)), JSON.stringify(st[1].p));
});

test('DIVIDE a spline: every point on the curve within 1e-6, spaced by equal arc length', () => {
  const sp = makeSpline({ degree: 3, ctrl: [{ x: 0, y: 0 }, { x: 3, y: 8 }, { x: 7, y: -4 }, { x: 12, y: 5 }, { x: 15, y: 0 }] });
  const nu = nurbsOf(sp), n = 5, st = divideStations(sp, n);
  assert.equal(st.length, n - 1);
  for (const s of st) { const q = pointAt(nu, nearestParam(nu, s.p)); assert.ok(Math.hypot(q.x - s.p.x, q.y - s.p.y) < 1e-6); }
  // arc length by a fine polyline: the pieces between stations are equal
  const [t0, t1] = [nu.U[nu.p], nu.U[nu.P.length]], K = 20000;
  let acc = 0, prev = pointAt(nu, t0), next = 0;
  const L = curveOf(sp).len, marks = [];
  for (let i = 1; i <= K; i++) {
    const q = pointAt(nu, t0 + ((t1 - t0) * i) / K); acc += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q;
    if (next < st.length && Math.hypot(q.x - st[next].p.x, q.y - st[next].p.y) < 2e-3) { marks.push(acc); next++; }
  }
  assert.ok(near(acc, L, 1e-4), `${acc} vs ${L}`);
  assert.equal(marks.length, n - 1);
  marks.forEach((m, i) => assert.ok(near(m, (L * (i + 1)) / n, 5e-3), `${m}`));
});

test('DIVIDE a full ellipse: N points from the end of the major axis', () => {
  const st = divideStations(makeEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5), 4);
  assert.equal(st.length, 4);
  assert.ok(nearP(st[0].p, 10, 0)); assert.ok(nearP(st[2].p, -10, 0, 1e-7)); // symmetric: half way round is the other end
});

test('DIVIDE rejects counts outside 2..32767', () => {
  const ln = makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  for (const n of [1, 0, 32768, 2.5]) assert.throws(() => divideStations(ln, n), /2 to 32767/);
});

test('MEASURE 3 along a 10 line from the end nearest the pick: 3, 6, 9 from that end', () => {
  const ln = makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  assert.deepEqual(measureStations(ln, 3, { x: 1, y: 0.2 }).map((s) => s.p.x), [3, 6, 9]);
  const back = measureStations(ln, 3, { x: 9.5, y: -0.1 }).map((s) => s.p.x);
  [7, 4, 1].forEach((x, i) => assert.ok(near(back[i], x), `${back}`));
  assert.equal(measureStations(ln, 5, { x: 0, y: 0 }).length, 1, 'no point on the far end');
});

test('Block option: INSERTs aligned with the tangent, or at rotation 0 when not aligned', () => {
  const blk = { name: 'TICK', base: { x: 0, y: 0 }, entities: [makeLine({ x: -1, y: 0 }, { x: 1, y: 0 })] };
  const st = divideStations(makeCircle({ x: 0, y: 0 }, 10), 4);
  const ins = placeAt(st, { block: blk, align: true, props: { layer: 'B' } });
  assert.ok(ins.every((e) => e.type === 'INSERT' && e.block === 'TICK' && e.layer === 'B'));
  [90, 180, -90, 0].forEach((deg, i) => assert.ok(near(((ins[i].rot - deg) % 360 + 540) % 360 - 180, 0, 1e-9), `${i}: ${ins[i].rot}`));
  const diag = divideStations(makeLine({ x: 0, y: 0 }, { x: 10, y: 10 }), 2);
  assert.ok(near(placeAt(diag, { block: blk, align: true })[0].rot, 45));
  assert.equal(placeAt(diag, { block: blk, align: false })[0].rot, 0);
});
