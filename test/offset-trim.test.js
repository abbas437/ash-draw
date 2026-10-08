import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/core/geom.js';
import * as M from '../src/core/model.js';

const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol, `x ${p.x} !~ ${x}`); near(p.y, y, tol, `y ${p.y} !~ ${y}`); };
const B90 = Math.tan(Math.PI / 8); // bulge of a 90 degree CCW arc

// 20 x 10 rectangle with radius-2 corners, CCW
const roundedRect = () => M.makePolyline([
  { x: 2, y: 0 }, { x: 18, y: 0, bulge: B90 }, { x: 20, y: 2 }, { x: 20, y: 8, bulge: B90 },
  { x: 18, y: 10 }, { x: 2, y: 10, bulge: B90 }, { x: 0, y: 8 }, { x: 0, y: 2, bulge: B90 },
], true);

test('offset: rounded rectangle outward keeps the arcs (radius + d) and moves the sides', () => {
  const o = G.offsetEntity(roundedRect(), 2, { x: -5, y: -5 });
  assert.equal(o.type, 'LWPOLYLINE'); assert.equal(o.closed, true);
  // vertex i starts segment i: the arcs are on the odd segments, as in the source
  const got = o.vertices.map((v) => [v.x, v.y, v.bulge]);
  assert.equal(got.length, 8);
  const shift = got.findIndex((v) => Math.abs(v[0] - 2) < 1e-9 && Math.abs(v[1] + 2) < 1e-9);
  for (let i = 0; i < 8; i++) {
    const g = got[(i + shift) % 8], w = [[2, -2, 0], [18, -2, B90], [22, 2, 0], [22, 8, B90], [18, 12, 0], [2, 12, B90], [-2, 8, 0], [-2, 2, B90]][i];
    nearPt({ x: g[0], y: g[1] }, w[0], w[1]); near(g[2], w[2]);
  }
  const centres = [[18, 2], [18, 8], [2, 8], [2, 2]];
  const arcs = o.vertices.map((v, i) => [v, o.vertices[(i + 1) % 8]]).filter(([v]) => Math.abs(v.bulge) > 1e-12).map(([a, b]) => G.bulgeToArc(a, b, a.bulge));
  assert.equal(arcs.length, 4);
  for (const a of arcs) { near(a.r, 4); assert.ok(centres.some(([x, y]) => Math.hypot(a.c.x - x, a.c.y - y) < 1e-9), 'same centre'); }
});

test('offset: rounded rectangle inward beyond the corner radius drops the arcs (sharp corners)', () => {
  const o = G.offsetEntity(roundedRect(), 3, { x: 10, y: 5 });
  assert.deepEqual(o.vertices.map((v) => v.bulge), [0, 0, 0, 0]);
  const pts = o.vertices.map((v) => [Math.round(v.x * 1e9) / 1e9, Math.round(v.y * 1e9) / 1e9]);
  assert.deepEqual(pts, [[3, 3], [17, 3], [17, 7], [3, 7]]);
});

test('offset: open polyline with an arc segment, offset to the convex side', () => {
  // line (20,0)->(10,0), then a CW half circle (10,0)->(0,0) through (5,-5)
  const pl = M.makePolyline([{ x: 20, y: 0 }, { x: 10, y: 0, bulge: -1 }, { x: 0, y: 0 }]);
  const o = G.offsetEntity(pl, 1, { x: 5, y: -18 });
  assert.equal(o.vertices.length, 3);
  nearPt(o.vertices[0], 20, -1); nearPt(o.vertices[1], 5 + Math.sqrt(35), -1); nearPt(o.vertices[2], -1, 0);
  const a2 = G.bulgeToArc(o.vertices[1], o.vertices[2], o.vertices[1].bulge);
  near(a2.r, 6); nearPt(a2.c, 5, 0);
});

test('offset: ellipse -> polyline at distance d (chord error within 1e-3)', () => {
  const e = M.makeEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5);
  const o = G.offsetEntity(e, 1, { x: 20, y: 0 });
  assert.equal(o.type, 'LWPOLYLINE'); assert.equal(o.closed, true);
  const distToEllipse = (q) => { // nearest point on x = 10 cos t, y = 5 sin t
    let t = 0, bd = Infinity;
    for (let k = 0; k < 3600; k++) { const s = (k / 3600) * 2 * Math.PI, d = Math.hypot(10 * Math.cos(s) - q.x, 5 * Math.sin(s) - q.y); if (d < bd) { bd = d; t = s; } }
    for (let k = 0; k < 30; k++) {
      const px = 10 * Math.cos(t) - q.x, py = 5 * Math.sin(t) - q.y, dx = -10 * Math.sin(t), dy = 5 * Math.cos(t);
      const f = px * dx + py * dy, df = dx * dx + dy * dy + px * (-10 * Math.cos(t)) + py * (-5 * Math.sin(t));
      t -= f / df;
    }
    return Math.hypot(10 * Math.cos(t) - q.x, 5 * Math.sin(t) - q.y);
  };
  const v = o.vertices, n = v.length;
  for (let i = 0; i < n; i++) {
    near(distToEllipse(v[i]), 1, 1e-9, `vertex ${i}`);
    near(distToEllipse(G.mid(v[i], v[(i + 1) % n])), 1, 1e-3, `chord ${i}`);
  }
});

test('trim: bulge polyline cut on an arc segment keeps the arc radius', () => {
  // half circle below the x axis (centre (5,0), r 5) then a straight run
  const pl = M.makePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
  pl.id = 9;
  const r = G.trimEntity(pl, [M.makeLine({ x: 2, y: -10 }, { x: 2, y: 10 })], { x: 0.4, y: -2 });
  assert.equal(r.replace.length, 1);
  const k = r.replace[0];
  assert.equal(k.id, 9); assert.equal(k.closed, false);
  nearPt(k.vertices[0], 2, -4); nearPt(k.vertices[k.vertices.length - 1], 20, 0);
  const a = G.bulgeToArc(k.vertices[0], k.vertices[1], k.vertices[0].bulge);
  near(a.r, 5); nearPt(a.c, 5, 0); nearPt(k.vertices[1], 10, 0);
  // the same polyline as a cutting edge
  const t = G.trimEntity(M.makeLine({ x: 2, y: -10 }, { x: 2, y: 10 }), [pl], { x: 2, y: -8 });
  nearPt(t.replace[0].p1, 2, -4); nearPt(t.replace[0].p2, 2, 10);
});

test('trim: closed polyline needs two cuts and keeps the far side', () => {
  const sq = M.makeRect({ x: 0, y: 0 }, { x: 10, y: 10 });
  const r = G.trimEntity(sq, [M.makeLine({ x: 5, y: -5 }, { x: 5, y: 15 })], { x: 10, y: 5 });
  const v = r.replace[0].vertices.map((p) => [p.x, p.y]);
  assert.deepEqual(v, [[5, 10], [0, 10], [0, 0], [5, 0]]);
});

test('trim/extend: ellipses by parameter', () => {
  const e = M.makeEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5);
  const r = G.trimEntity(e, [M.makeLine({ x: 6, y: -10 }, { x: 6, y: 10 })], { x: 10, y: 0 });
  const k = r.replace[0];
  near(k.a0, Math.acos(0.6), 1e-12); near(k.a1, 2 * Math.PI - Math.acos(0.6), 1e-12);
  // elliptical arc: cutting removes the picked end
  const r2 = G.trimEntity(k, [M.makeLine({ x: -6, y: -10 }, { x: -6, y: 10 })], { x: -10, y: 0 });
  assert.equal(r2.replace.length, 2);
  // extend the upper-left quarter back to x = 6
  const q = M.makeEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5, Math.PI / 2, Math.PI);
  const x = G.extendEntity(q, [M.makeLine({ x: 6, y: -10 }, { x: 6, y: 10 })], { x: 0, y: 5 });
  near(x.a0, Math.acos(0.6), 1e-12); near(x.a1, Math.PI);
});

test('extend: line to a rotated ellipse ends exactly on it', () => {
  const e = M.makeEllipse({ x: 1, y: 2 }, { x: 6, y: 8 }, 0.5);
  const l = M.makeLine({ x: 1, y: 2 }, { x: 2, y: 2.3 });
  const x = G.extendEntity(l, [e], { x: 2, y: 2.3 });
  const p = { x: x.p2.x - 1, y: x.p2.y - 2 };
  const X = (p.x * 6 + p.y * 8) / 100, Y = (-p.x * 4 + p.y * 3) / 25; // axis frame: u = (6,8), v = (-4,3)
  near(X * X + Y * Y, 1, 1e-9);
  near((x.p2.y - 2) * 1 - (x.p2.x - 1) * 0.3, 0, 1e-9, 'stays on the line');
});

test('extend: open polyline with an arc end grows along its circle', () => {
  const pl = M.makePolyline([{ x: 20, y: 0 }, { x: 10, y: 0, bulge: B90 }, { x: 0, y: 10 }]);
  const x = G.extendEntity(pl, [M.makeLine({ x: -6, y: -20 }, { x: -6, y: 20 })], { x: 0, y: 10 });
  nearPt(x.vertices[2], -6, 8);
  const a = G.bulgeToArc(x.vertices[1], x.vertices[2], x.vertices[1].bulge);
  near(a.r, 10); nearPt(a.c, 0, 0);
});

test('spline as cutting edge trims a line at the exact crossing; trimming a spline is refused', () => {
  const sp = M.makeSpline({ degree: 2, ctrl: [{ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }], knots: [0, 0, 0, 1, 1, 1] });
  const r = G.trimEntity(M.makeLine({ x: 3, y: -5 }, { x: 3, y: 10 }), [sp], { x: 3, y: 9 });
  nearPt(r.replace[0].p2, 3, 4.2, 1e-6); nearPt(r.replace[0].p1, 3, -5);
  assert.throws(() => G.trimEntity(sp, [M.makeLine({ x: 3, y: -5 }, { x: 3, y: 10 })], { x: 1, y: 1 }),
    (e) => e.code === 'UNSUPPORTED' && /Trimming splines is not supported yet; explode\/convert first/.test(e.message));
});
