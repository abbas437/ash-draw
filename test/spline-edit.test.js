import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/core/geom.js';
import * as N from '../src/core/nurbs.js';
import * as M from '../src/core/model.js';

const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol, `x ${p.x} !~ ${x}`); near(p.y, y, tol, `y ${p.y} !~ ${y}`); };
const R2 = Math.SQRT1_2;
// cubic S-curve, 6 control points, clamped non-uniform knots
const sCurve = () => M.makeSpline({ degree: 3, ctrl: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 25, y: 22 }, { x: 35, y: -5 }, { x: 50, y: -15 }, { x: 60, y: 5 }], knots: [0, 0, 0, 0, 1, 2.5, 4, 4, 4, 4] });
// rational quadratic quarter circles: unit circle at the origin (0 -> 90 deg) and r 1 about (1,0) (90 -> 180 deg)
const quarter = () => M.makeSpline({ degree: 2, ctrl: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], knots: [0, 0, 0, 1, 1, 1], weights: [1, R2, 1] });
const quarter2 = () => M.makeSpline({ degree: 2, ctrl: [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }], knots: [0, 0, 0, 1, 1, 1], weights: [1, R2, 1] });
const distTo = (nu, q) => { const c = N.pointAt(nu, N.nearestParam(nu, q)); return Math.hypot(c.x - q.x, c.y - q.y); };

test('spline split: both halves are exact pieces of the original curve (knot insertion)', () => {
  for (const e of [sCurve(), quarter()]) {
    const nu = N.nurbsOf(e), [t0, t1] = N.domain(nu), tc = t0 + (t1 - t0) * 0.37;
    const A = N.nurbsOf(G.splinePiece(e, t0, tc)), B = N.nurbsOf(G.splinePiece(e, tc, t1));
    for (const [P, a, b] of [[A, t0, tc], [B, tc, t1]]) {
      for (let i = 0; i <= 50; i++) {
        const t = a + ((b - a) * i) / 50, p = N.pointAt(P, t, i === 50), q = N.pointAt(nu, t, i === 50);
        nearPt(p, q.x, q.y, 1e-9);
      }
    }
    const cut = N.pointAt(nu, tc), end = N.pointAt(A, tc, true);
    nearPt(end, cut.x, cut.y, 1e-12); nearPt(N.pointAt(B, tc), cut.x, cut.y, 1e-12);
  }
});

test('spline intersections: line, circle and spline against known values', () => {
  // cubic Bezier with x = 3t: crosses x = 1.5 at t = 0.5, y = (0 + 3*2 + 3*-2 + 1)/8 = 0.125
  const bz = M.makeSpline({ degree: 3, ctrl: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: -2 }, { x: 3, y: 1 }], knots: [0, 0, 0, 0, 1, 1, 1, 1] });
  const hl = G.intersections(bz, M.makeLine({ x: 1.5, y: -5 }, { x: 1.5, y: 5 }));
  assert.equal(hl.length, 1); nearPt(hl[0], 1.5, 0.125, 1e-12);
  const hc = G.intersections(quarter(), M.makeCircle({ x: 1, y: 0 }, 1));
  assert.equal(hc.length, 1); nearPt(hc[0], 0.5, Math.sqrt(3) / 2, 1e-12);
  const hs = G.intersections(quarter(), quarter2());
  assert.equal(hs.length, 1); nearPt(hs[0], 0.5, Math.sqrt(3) / 2, 1e-12);
});

test('TRIM a spline between two lines leaves the outer pieces, each ending on its line and on the original curve', () => {
  const e = sCurve(); e.id = 7;
  const nu = N.nurbsOf(e);
  const cut = [M.makeLine({ x: 20, y: -50 }, { x: 20, y: 50 }), M.makeLine({ x: 40, y: -50 }, { x: 40, y: 50 })];
  const r = G.trimEntity(e, cut, { x: 30, y: N.pointAt(nu, N.nearestParam(nu, { x: 30, y: 0 })).y });
  assert.equal(r.replace.length, 2);
  assert.equal(r.replace[0].id, 7); assert.equal(r.replace[1].id, 0);
  const [L, Rt] = r.replace.map((x) => N.nurbsOf(x));
  assert.ok(r.replace.every((x) => x.type === 'SPLINE'));
  near(N.pointAt(L, N.domain(L)[1], true).x, 20, 1e-9); near(N.pointAt(Rt, N.domain(Rt)[0]).x, 40, 1e-9);
  nearPt(N.pointAt(L, N.domain(L)[0]), 0, 0); nearPt(N.pointAt(Rt, N.domain(Rt)[1], true), 60, 5);
  for (const P of [L, Rt]) { const [a, b] = N.domain(P); for (let i = 0; i <= 20; i++) { const t = a + ((b - a) * i) / 20; const p = N.pointAt(P, t, i === 20), q = N.pointAt(nu, t, i === 20); nearPt(p, q.x, q.y, 1e-9); } }
});

test('TRIM a closed spline between two crossings keeps one open piece through the seam', () => {
  const c = M.makeSpline({ degree: 3, ctrl: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: -10, y: 10 }, { x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 0 }], knots: [0, 0, 0, 0, 1, 2, 3, 3, 3, 3], closed: true });
  const r = G.trimEntity(c, [M.makeLine({ x: 0, y: -50 }, { x: 0, y: 50 })], { x: -7, y: 0 });
  assert.equal(r.replace.length, 1);
  const P = N.nurbsOf(r.replace[0]), [a, b] = N.domain(P);
  near(N.pointAt(P, a).x, 0, 1e-9); near(N.pointAt(P, b, true).x, 0, 1e-9);
  assert.ok(N.pointAt(P, (a + b) / 2).x > 0, 'kept the right-hand part');
});

test('OFFSET of a cubic S-curve keeps distance d at 50 samples on both sides; result is a SPLINE', () => {
  const e = sCurve(), nu = N.nurbsOf(e), d = 3;
  for (const side of [{ x: 10, y: 40 }, { x: 10, y: -20 }]) {
    const o = G.offsetEntity(e, d, side);
    assert.equal(o.type, 'SPLINE'); assert.equal(o.closed, false);
    const on = N.nurbsOf(o), [a, b] = N.domain(on);
    for (let i = 0; i <= 50; i++) near(distTo(nu, N.pointAt(on, a + ((b - a) * i) / 50, i === 50)), d, 1e-4);
    const mid = N.pointAt(on, (a + b) / 2), cm = N.pointAt(nu, N.nearestParam(nu, mid));
    assert.ok(Math.hypot(mid.x - side.x, mid.y - side.y) < Math.hypot(cm.x - side.x, cm.y - side.y) + d, 'offset is on the picked side');
  }
  const l = N.nurbsOf(G.offsetEntity(e, d, { x: 10, y: 40 })), r = N.nurbsOf(G.offsetEntity(e, d, { x: 10, y: -20 }));
  const pl = N.pointAt(l, N.domain(l)[0]), pr = N.pointAt(r, N.domain(r)[0]);
  near(Math.hypot(pl.x - pr.x, pl.y - pr.y), 2 * d, 1e-6, 'the two sides differ');
});

test('OFFSET of a closed spline stays closed, inside and outside', () => {
  const k = 4, ctrl = [], knots = [];
  for (let i = 0; i < 8 + k - 1; i++) { const a = (i * 2 * Math.PI) / 8; ctrl.push({ x: 20 * Math.cos(a), y: 12 * Math.sin(a) }); }
  for (let i = 0; i < ctrl.length + k; i++) knots.push(i);
  const e = M.makeSpline({ degree: 3, ctrl, knots, closed: true }), nu = N.nurbsOf(e);
  for (const [side, sign] of [[{ x: 0, y: 0 }, -1], [{ x: 40, y: 0 }, 1]]) {
    const o = G.offsetEntity(e, 2, side), on = N.nurbsOf(o), [a, b] = N.domain(on);
    assert.equal(o.closed, true);
    nearPt(N.pointAt(on, a), N.pointAt(on, b, true).x, N.pointAt(on, b, true).y, 1e-9);
    for (let i = 0; i <= 50; i++) near(distTo(nu, N.pointAt(on, a + ((b - a) * i) / 50, i === 50)), 2, 1e-4);
    const p = N.pointAt(on, a);
    assert.equal(Math.sign(Math.hypot(p.x, p.y) - Math.hypot(N.pointAt(nu, N.domain(nu)[0]).x, N.pointAt(nu, N.domain(nu)[0]).y)), sign);
  }
});

test('EXTEND an open spline to a line: straight along the end tangent, meets the line, original part unchanged', () => {
  const e = sCurve(), nu = N.nurbsOf(e);
  const x = G.extendEntity(e, [M.makeLine({ x: 70, y: -100 }, { x: 70, y: 100 })], { x: 59, y: 4 });
  assert.equal(x.type, 'SPLINE');
  const xn = N.nurbsOf(x), [a, b] = N.domain(xn), end = N.pointAt(xn, b, true);
  near(end.x, 70, 1e-9);
  const { p, d1 } = N.derivsAt(nu, 4, true);
  near((end.x - p.x) * d1.y - (end.y - p.y) * d1.x, 0, 1e-9, 'end on the tangent ray');
  for (let i = 0; i <= 20; i++) { const t = (4 * i) / 20, q = N.pointAt(nu, t, i === 20); nearPt(N.pointAt(xn, t, i === 20), q.x, q.y, 1e-9); }
  near(a, 0);
});
