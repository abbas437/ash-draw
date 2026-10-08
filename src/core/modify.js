// ASH Draw Studio - modify commands as pure geometry: FILLET, CHAMFER, BREAK, JOIN, LENGTHEN, STRETCH, ARRAY.
// Pure ES module (no DOM, no session). Behaviour follows AutoCAD LT.
//
// Every command returns an EDIT SET  { add: [...], remove: [ids], change: [...] }:
//   add    - new entities (id 0; the session assigns ids)
//   remove - ids of entities to delete
//   change - modified copies of existing entities, keeping their id (applied with Tx.replace)
// Apply one with applyEditSet(session, label, set) from edit.js.
// Failures throw Error with code 'GEOMETRY' (no solution for this input) or 'UNSUPPORTED' (entity type not handled).
import {
  DEG, dist, mid, normAngle, ccwSweep, bulgeToArc, transformEntity, translation, rotation, compose, bboxOf, unionBox, tessellate,
  plSegs, segPoint, segParam, plParamOf, plSegAt, plSlice,
} from './geom.js';

const TAU = Math.PI * 2;
const EPS = 1e-9;

// ---- small helpers --------------------------------------------------------------------------
function fail(code, msg) { const err = new Error(msg); err.code = code; return err; }
const PROPS = ['layer', 'color', 'linetype', 'lineweight', 'ltscale'];
/** New entity of `type` carrying the display properties of `src`. */
function like(src, type, geom) {
  const o = { id: 0, type };
  for (const k of PROPS) if (src[k] !== undefined) o[k] = structuredClone(src[k]);
  return { ...o, ...geom };
}
function clone(e) { const c = structuredClone(e); delete c.parent; return c; }
const editSet = () => ({ add: [], remove: [], change: [] });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const plus = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const perp = (a) => ({ x: -a.y, y: a.x });
const ang = (v) => Math.atan2(v.y, v.x);
const polar = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
const P = (p) => ({ x: p.x, y: p.y });
function unit(v) { const l = Math.hypot(v.x, v.y); return l < 1e-15 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l }; }

// ---- infinite intersections -----------------------------------------------------------------
function lineLine(p, d, q, e) {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12) return null;
  return plus(p, mul(d, cross(sub(q, p), e) / den));
}
function lineCircle(p, d, c, r) { // d unit
  const f = sub(p, c), b = dot(f, d), disc = b * b - (dot(f, f) - r * r);
  if (disc < -1e-9 * r * r) return [];
  if (disc <= 1e-12 * r * r) return [plus(p, mul(d, -b))];
  const s = Math.sqrt(disc);
  return [plus(p, mul(d, -b - s)), plus(p, mul(d, -b + s))];
}
function circleCircle(c1, r1, c2, r2) {
  const d = dist(c1, c2);
  if (d < EPS) return [];
  const tol = 1e-9 * Math.max(r1, r2, 1);
  if (d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = { x: (c2.x - c1.x) / d, y: (c2.y - c1.y) / d };
  const m = plus(c1, mul(u, a));
  return h < 1e-12 ? [m] : [plus(m, mul(perp(u), h)), plus(m, mul(perp(u), -h))];
}

// ---- curves: LINE (infinite carrier) / ARC, CIRCLE (full circle carrier) ---------------------
function curveOf(e) {
  if (e.type === 'LINE') {
    if (dist(e.p1, e.p2) < EPS) throw fail('GEOMETRY', 'zero-length line');
    return { k: 'line', e, p: e.p1, d: unit(sub(e.p2, e.p1)) };
  }
  if (e.type === 'ARC' || e.type === 'CIRCLE') return { k: 'arc', e, c: e.c, r: e.r };
  throw fail('UNSUPPORTED', `fillet/chamfer of ${e.type}`);
}
function offsetCurve(cv, s) {
  if (cv.k === 'line') return { k: 'line', p: plus(cv.p, mul(perp(cv.d), s)), d: cv.d };
  const r = cv.r + s;
  return r > EPS ? { k: 'arc', c: cv.c, r } : null;
}
function meet(a, b) {
  if (a.k === 'line' && b.k === 'line') { const x = lineLine(a.p, a.d, b.p, b.d); return x ? [x] : []; }
  if (a.k === 'line') return lineCircle(a.p, a.d, b.c, b.r);
  if (b.k === 'line') return lineCircle(b.p, b.d, a.c, a.r);
  return circleCircle(a.c, a.r, b.c, b.r);
}
function foot(cv, q) {
  if (cv.k === 'line') return plus(cv.p, mul(cv.d, dot(sub(q, cv.p), cv.d)));
  return plus(cv.c, mul(unit(sub(q, cv.c)), cv.r));
}
const ccwTan = (a) => ({ x: -Math.sin(a), y: Math.cos(a) });

/** Trim/extend curve `cv` so it ends at T, keeping the part on the side of `pick`.
 *  Returns { ent (changed copy, or null for circles), k: unit tangent at T pointing into the kept part }. */
function trimTo(cv, T, pick) {
  const e = cv.e;
  if (cv.k === 'line') {
    const t = (q) => dot(sub(q, cv.p), cv.d);
    const ent = clone(e);
    if (t(pick) >= t(T)) { ent.p1 = P(T); return { ent, k: cv.d }; }
    ent.p2 = P(T); return { ent, k: mul(cv.d, -1) };
  }
  const aT = ang(sub(T, cv.c)), aP = ang(sub(pick, cv.c));
  if (e.type === 'CIRCLE') return { ent: null, k: normAngle(aP - aT) < Math.PI ? ccwTan(aT) : mul(ccwTan(aT), -1) };
  const a0 = e.a0 * DEG, a1 = e.a1 * DEG, sw = ccwSweep(a0, a1);
  const relT = normAngle(aT - a0);
  let keepAfter; // true: keep [T .. a1] (the arc continues CCW from T)
  if (relT <= sw + 1e-9) keepAfter = normAngle(aP - a0) >= relT;
  else keepAfter = ccwSweep(aT, a1) < ccwSweep(a0, aT); // T beyond the arc: extend the nearer end
  const ent = clone(e);
  if (keepAfter) { ent.a0 = normAngle(aT) / DEG; return { ent, k: ccwTan(aT) }; }
  ent.a1 = normAngle(aT) / DEG; return { ent, k: mul(ccwTan(aT), -1) };
}
function degenerate(e) {
  if (e.type === 'LINE') return dist(e.p1, e.p2) < EPS;
  if (e.type === 'ARC') { const s = normAngle((e.a1 - e.a0) * DEG); return s < 1e-12 || s > TAU - 1e-12; }
  return false;
}
function pushTrim(out, t) {
  if (!t.ent) return;
  if (degenerate(t.ent)) out.remove.push(t.ent.id); else out.change.push(t.ent);
}
/** ARC entity from T1 to T2 around C, leaving T1 in direction `dir1`. */
function arcThrough(src, C, T1, T2, dir1) {
  const r = dist(C, T1), a1 = ang(sub(T1, C)), a2 = ang(sub(T2, C));
  const ccw = cross(sub(T1, C), dir1) > 0;
  return like(src, 'ARC', { c: P(C), r, a0: normAngle(ccw ? a1 : a2) / DEG, a1: normAngle(ccw ? a2 : a1) / DEG });
}

// ---- FILLET ---------------------------------------------------------------------------------
/** FILLET two objects (LINE, ARC, CIRCLE) with radius r >= 0; pick1/pick2 = the points used to select them
 *  (they choose the sides that stay and, among the possible tangent arcs, the one nearest to the picks).
 *  r = 0 gives a sharp corner. Parallel lines get a semicircle (r ignored) at the end of the first line
 *  nearest pick1; the second line is lengthened/shortened to match. Circles are never trimmed.
 *  The new arc takes the properties of the first object. */
export function fillet(e1, pick1, e2, pick2, r, { trim = true } = {}) {
  if (!(r >= 0)) throw fail('GEOMETRY', 'fillet radius must be >= 0');
  const c1 = curveOf(e1), c2 = curveOf(e2);
  if (c1.k === 'line' && c2.k === 'line' && Math.abs(cross(c1.d, c2.d)) < 1e-12) return filletParallel(c1, pick1, c2, trim);
  let best = null;
  const signs = r > 0 ? [1, -1] : [0];
  for (const s1 of signs) for (const s2 of signs) {
    const o1 = offsetCurve(c1, s1 * r), o2 = offsetCurve(c2, s2 * r);
    if (!o1 || !o2) continue;
    for (const C of meet(o1, o2)) {
      const T1 = r > 0 ? foot(c1, C) : C, T2 = r > 0 ? foot(c2, C) : C;
      const score = dist(T1, pick1) + dist(T2, pick2);
      if (!best || score < best.score - 1e-12) best = { C, T1, T2, score };
    }
  }
  if (!best) throw fail('GEOMETRY', 'no fillet possible with this radius');
  const out = editSet();
  const t1 = trimTo(c1, best.T1, pick1), t2 = trimTo(c2, best.T2, pick2);
  if (trim) { pushTrim(out, t1); pushTrim(out, t2); }
  if (r > 0) out.add.push(arcThrough(e1, best.C, best.T1, best.T2, mul(t1.k, -1)));
  return out;
}
function filletParallel(c1, pick1, c2, trim) {
  const e1 = c1.e, e2 = c2.e;
  const n = perp(c1.d), D = dot(sub(e2.p1, e1.p1), n);
  if (Math.abs(D) < EPS) throw fail('GEOMETRY', 'collinear lines cannot be filleted');
  const nearP1 = dist(pick1, e1.p1) <= dist(pick1, e1.p2);
  const E = nearP1 ? e1.p1 : e1.p2, O = nearP1 ? e1.p2 : e1.p1;
  const F = plus(E, mul(n, D)), C = mid(E, F), w = unit(sub(E, O));
  const out = editSet();
  if (trim) {
    const ent = clone(e2), t = (q) => dot(sub(q, E), w);
    if (t(e2.p1) > t(e2.p2)) ent.p1 = P(F); else ent.p2 = P(F);
    out.change.push(ent);
  }
  // semicircle E -> F bulging outwards (direction w); it leaves E in direction w
  out.add.push(arcThrough(e1, C, E, F, w));
  return out;
}

// ---- CHAMFER --------------------------------------------------------------------------------
/** CHAMFER two LINEs. opts: { d1, d2 } (distances from the corner along line 1 / line 2) or
 *  { d1, angle } (distance on line 1 and angle in degrees between line 1 and the chamfer line). */
export function chamfer(e1, pick1, e2, pick2, { d1, d2 = d1, angle = null } = {}, { trim = true } = {}) {
  if (e1.type !== 'LINE' || e2.type !== 'LINE') throw fail('UNSUPPORTED', 'chamfer needs two lines');
  const c1 = curveOf(e1), c2 = curveOf(e2);
  const X = lineLine(c1.p, c1.d, c2.p, c2.d);
  if (!X) throw fail('GEOMETRY', 'parallel lines cannot be chamfered');
  const side = (cv, pick) => (dot(sub(pick, X), cv.d) >= 0 ? cv.d : mul(cv.d, -1));
  const u1 = side(c1, pick1), u2 = side(c2, pick2);
  const L2 = chamferSecond(u1, u2, d1, d2, angle);
  const P1 = plus(X, mul(u1, d1)), P2 = plus(X, mul(u2, L2));
  const out = editSet();
  if (trim) { pushTrim(out, trimTo(c1, P1, pick1)); pushTrim(out, trimTo(c2, P2, pick2)); }
  if (dist(P1, P2) > EPS) out.add.push(like(e1, 'LINE', { p1: P1, p2: P2 }));
  return out;
}
function chamferSecond(u1, u2, d1, d2, angle) {
  if (!(d1 >= 0)) throw fail('GEOMETRY', 'chamfer distance must be >= 0');
  if (angle == null) { if (!(d2 >= 0)) throw fail('GEOMETRY', 'chamfer distance must be >= 0'); return d2; }
  const th = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2)))), a = angle * DEG;
  const s = Math.sin(Math.PI - th - a);
  if (!(s > EPS)) throw fail('GEOMETRY', 'chamfer angle too large for this corner');
  return (d1 * Math.sin(a)) / s;
}

// ---- polyline vertex FILLET / CHAMFER -------------------------------------------------------
function cornerAt(e, i) {
  const v = e.vertices, n = v.length;
  if (!e.closed && (i <= 0 || i >= n - 1)) return null;
  const ip = (i - 1 + n) % n, inx = (i + 1) % n;
  const prev = v[ip], V = v[i], next = v[inx];
  if (Math.abs(prev.bulge || 0) > 1e-12 || Math.abs(V.bulge || 0) > 1e-12) return null; // arc segment: not handled
  const L1 = dist(prev, V), L2 = dist(V, next);
  if (L1 < EPS || L2 < EPS) return null;
  const u1 = unit(sub(prev, V)), u2 = unit(sub(next, V));
  if (Math.abs(cross(u1, u2)) < 1e-12) return null; // collinear
  return { i, V, u1, u2, L1, L2, turn: cross(sub(V, prev), sub(next, V)) };
}
/** Apply `cut(corner) -> {t1, t2, bulge}` at the chosen vertices (index null = all), skipping corners whose segments
 *  are too short (as AutoCAD does). Returns the edit set with `count` = corners changed. */
function polyCorners(e, index, cut) {
  if (e.type !== 'LWPOLYLINE') throw fail('UNSUPPORTED', `polyline corner on ${e.type}`);
  const v = e.vertices, n = v.length;
  const idx = index == null ? [...Array(n).keys()] : [index];
  const used = new Map(); // segment index -> length consumed so far
  const res = new Map();
  for (const i of idx) {
    const c = cornerAt(e, i);
    if (!c) continue;
    const k = cut(c);
    if (!k) continue;
    const sPrev = (i - 1 + n) % n, sNext = i;
    if (k.t1 > c.L1 - (used.get(sPrev) || 0) + EPS || k.t2 > c.L2 - (used.get(sNext) || 0) + EPS) continue;
    used.set(sPrev, (used.get(sPrev) || 0) + k.t1); used.set(sNext, (used.get(sNext) || 0) + k.t2);
    res.set(i, { A: plus(c.V, mul(c.u1, k.t1)), B: plus(c.V, mul(c.u2, k.t2)), bulge: k.bulge });
  }
  if (index != null && !res.size) throw fail('GEOMETRY', 'this vertex cannot be changed (end vertex, arc segment or segments too short)');
  const verts = [];
  v.forEach((q, i) => {
    const r = res.get(i);
    if (!r) { verts.push({ ...q }); return; }
    verts.push({ ...q, x: r.A.x, y: r.A.y, bulge: r.bulge });
    if (dist(r.A, r.B) > EPS) verts.push({ ...q, x: r.B.x, y: r.B.y, bulge: q.bulge || 0 });
  });
  const out = editSet();
  if (res.size) { const c = clone(e); c.vertices = verts; out.change.push(c); }
  out.count = res.size;
  return out;
}
/** FILLET polyline corners between two straight segments: one vertex (index) or all (index null). */
export function filletPolyline(e, r, index = null) {
  if (!(r > 0)) throw fail('GEOMETRY', 'polyline fillet radius must be > 0');
  return polyCorners(e, index, (c) => {
    const th = Math.acos(Math.max(-1, Math.min(1, dot(c.u1, c.u2))));
    const t = r / Math.tan(th / 2), sweep = (c.turn > 0 ? 1 : -1) * (Math.PI - th);
    return { t1: t, t2: t, bulge: Math.tan(sweep / 4) };
  });
}
/** CHAMFER polyline corners: d1 on the incoming segment, d2 (or angle from the incoming segment) on the outgoing. */
export function chamferPolyline(e, { d1, d2 = d1, angle = null } = {}, index = null) {
  return polyCorners(e, index, (c) => ({ t1: d1, t2: chamferSecond(c.u1, c.u2, d1, d2, angle), bulge: 0 }));
}

// ---- polyline parameterisation: plSegs/segPoint/segParam/plParamOf/plSegAt/plSlice live in geom.js ----
function segDir(sg, f) {
  if (!sg.arc) return unit(sub(sg.b, sg.a));
  return mul(ccwTan(sg.arc.a0 + sg.arc.sweep * f), Math.sign(sg.arc.sweep));
}

// ---- BREAK ----------------------------------------------------------------------------------
function pieces(e, list) { // list of replacement entities -> edit set (first keeps the id)
  const out = editSet();
  if (!list.length) { out.remove.push(e.id); return out; }
  const [first, ...rest] = list;
  first.id = e.id; out.change.push(first);
  for (const r of rest) { r.id = 0; out.add.push(r); }
  return out;
}
const lineT = (e, p) => { const d = sub(e.p2, e.p1); return dot(sub(p, e.p1), d) / dot(d, d); };
const lineAt = (e, t) => ({ x: e.p1.x + (e.p2.x - e.p1.x) * t, y: e.p1.y + (e.p2.y - e.p1.y) * t });
const arcRel = (e, p) => normAngle(ang(sub(p, e.c)) - e.a0 * DEG);
function arcPiece(e, r0, r1) { const c = clone(e); c.a0 = normAngle(e.a0 * DEG + r0) / DEG; c.a1 = normAngle(e.a0 * DEG + r1) / DEG; return c; }
function plPiece(e, verts) { const c = clone(e); c.vertices = verts; c.closed = false; return c; }

/** BREAK at one point: LINE / ARC / LWPOLYLINE split in two (a closed polyline opens at the point). */
export function breakAt(e, p) {
  if (e.type === 'LINE') {
    const t = lineT(e, p);
    if (!(t > EPS && t < 1 - EPS)) throw fail('GEOMETRY', 'break point is at or beyond an end');
    const q = lineAt(e, t);
    return pieces(e, [{ ...clone(e), p2: q }, { ...clone(e), p1: { ...q } }]);
  }
  if (e.type === 'ARC') {
    const sw = ccwSweep(e.a0 * DEG, e.a1 * DEG), r = arcRel(e, p);
    if (!(r > EPS && r < sw - EPS)) throw fail('GEOMETRY', 'break point is at or beyond an end');
    return pieces(e, [arcPiece(e, 0, r), arcPiece(e, r, sw)]);
  }
  if (e.type === 'CIRCLE') throw fail('GEOMETRY', 'a circle cannot be broken at a single point');
  if (e.type === 'LWPOLYLINE') {
    const segs = plSegs(e), m = segs.length, s = plParamOf(segs, p);
    if (e.closed) return pieces(e, [plPiece(e, plSlice(segs, s, s + m))]);
    if (!(s > EPS && s < m - EPS)) throw fail('GEOMETRY', 'break point is at or beyond an end');
    return pieces(e, [plPiece(e, plSlice(segs, 0, s)), plPiece(e, plSlice(segs, s, m))]);
  }
  throw fail('UNSUPPORTED', `break of ${e.type}`);
}
/** BREAK between two points: removes the part between them. A circle loses the part CCW from p1 to p2
 *  (AutoCAD rule); a closed polyline loses the part from p1 to p2 in vertex order. */
export function breakBetween(e, p1, p2) {
  if (e.type === 'LINE') {
    let a = Math.max(0, Math.min(1, lineT(e, p1))), b = Math.max(0, Math.min(1, lineT(e, p2)));
    if (a > b) [a, b] = [b, a];
    const out = [];
    if (a > EPS) out.push({ ...clone(e), p2: lineAt(e, a) });
    if (b < 1 - EPS) out.push({ ...clone(e), p1: lineAt(e, b) });
    return pieces(e, out);
  }
  if (e.type === 'ARC') {
    const sw = ccwSweep(e.a0 * DEG, e.a1 * DEG);
    const clampRel = (p) => { const r = arcRel(e, p); return r <= sw ? r : (r - sw < TAU - r ? sw : 0); };
    let a = clampRel(p1), b = clampRel(p2);
    if (a > b) [a, b] = [b, a];
    const out = [];
    if (a > EPS) out.push(arcPiece(e, 0, a));
    if (b < sw - EPS) out.push(arcPiece(e, b, sw));
    return pieces(e, out);
  }
  if (e.type === 'CIRCLE') {
    const a1 = ang(sub(p1, e.c)), a2 = ang(sub(p2, e.c));
    if (Math.abs(normAngle(a2 - a1)) < 1e-12) throw fail('GEOMETRY', 'the two break points coincide');
    const arc = like(e, 'ARC', { c: P(e.c), r: e.r, a0: normAngle(a2) / DEG, a1: normAngle(a1) / DEG });
    return pieces(e, [arc]);
  }
  if (e.type === 'LWPOLYLINE') {
    const segs = plSegs(e), m = segs.length;
    let a = plParamOf(segs, p1), b = plParamOf(segs, p2);
    if (e.closed) {
      const end = a <= b ? a + m : a;
      return pieces(e, end - b > EPS ? [plPiece(e, plSlice(segs, b, end))] : []);
    }
    if (a > b) [a, b] = [b, a];
    const out = [];
    if (a > EPS) out.push(plPiece(e, plSlice(segs, 0, a)));
    if (b < m - EPS) out.push(plPiece(e, plSlice(segs, b, m)));
    return pieces(e, out);
  }
  throw fail('UNSUPPORTED', `break of ${e.type}`);
}

// ---- JOIN -----------------------------------------------------------------------------------
/** JOIN: collinear LINEs -> one LINE (gaps allowed, as AutoCAD); ARCs on the same circle -> one ARC (largest gap
 *  left open) or a CIRCLE when they close; otherwise LINE / ARC / open LWPOLYLINE end to end -> one LWPOLYLINE
 *  (closed when the chain closes). Tolerance defaults to 1e-6 x the diagonal of the objects' extents.
 *  The first object keeps its id (its type may change); joined others are removed. Objects that do not
 *  connect to the chain are left alone. */
export function join(ents, { tol = null } = {}) {
  if (ents.length < 2) throw fail('GEOMETRY', 'select at least two objects to join');
  let box = null;
  for (const e of ents) box = unionBox(box, bboxOf(e));
  const T = tol ?? Math.max(1e-6 * (box ? Math.hypot(box.maxx - box.minx, box.maxy - box.miny) : 1), 1e-9);
  const [first] = ents;
  const out = editSet();
  const finish = (ne, joined) => {
    ne.id = first.id; out.change.push(ne);
    for (const e of joined) if (e !== first) out.remove.push(e.id);
    return out;
  };
  if (ents.every((e) => e.type === 'LINE')) {
    const d = unit(sub(first.p2, first.p1));
    const off = (p) => Math.abs(cross(sub(p, first.p1), d));
    if (ents.every((e) => off(e.p1) <= T && off(e.p2) <= T)) {
      const ts = ents.flatMap((e) => [e.p1, e.p2]).map((p) => dot(sub(p, first.p1), d));
      const lo = Math.min(...ts), hi = Math.max(...ts);
      return finish({ ...clone(first), p1: plus(first.p1, mul(d, lo)), p2: plus(first.p1, mul(d, hi)) }, ents);
    }
  }
  if (ents.every((e) => e.type === 'ARC' || e.type === 'CIRCLE') && ents.every((e) => dist(e.c, first.c) <= T && Math.abs(e.r - first.r) <= T)) {
    return finish(joinArcs(first, ents, T / first.r), ents);
  }
  // chain into a polyline
  const items = ents.map((e) => ({ e, v: chainVerts(e) }));
  let chain = items[0].v.map((q) => ({ ...q }));
  const used = [items[0]];
  for (let grew = true; grew;) {
    grew = false;
    for (const it of items) {
      if (used.includes(it)) continue;
      const head = chain[0], tail = chain[chain.length - 1];
      const s = it.v[0], t = it.v[it.v.length - 1];
      let v = null, atEnd = true;
      if (dist(tail, s) <= T) v = it.v;
      else if (dist(tail, t) <= T) v = reverseVerts(it.v);
      else if (dist(head, t) <= T) { v = it.v; atEnd = false; } else if (dist(head, s) <= T) { v = reverseVerts(it.v); atEnd = false; }
      if (!v) continue;
      if (atEnd) { chain[chain.length - 1] = { ...tail, bulge: v[0].bulge }; chain.push(...v.slice(1).map((q) => ({ ...q }))); } else chain = [...v.slice(0, -1).map((q) => ({ ...q })), ...chain];
      used.push(it); grew = true;
    }
  }
  if (used.length < 2) throw fail('GEOMETRY', 'the objects do not connect end to end');
  let closed = false;
  if (chain.length > 2 && dist(chain[0], chain[chain.length - 1]) <= T) { chain.pop(); closed = true; }
  const base = first.type === 'LWPOLYLINE' ? clone(first) : like(first, 'LWPOLYLINE', {});
  return finish({ ...base, vertices: chain, closed }, used.map((u) => u.e));
}
function chainVerts(e) {
  if (e.type === 'LINE') return [{ ...P(e.p1), bulge: 0 }, { ...P(e.p2), bulge: 0 }];
  if (e.type === 'ARC') {
    const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
    return [{ ...polar(e.c, e.r, a0), bulge: Math.tan(sw / 4) }, { ...polar(e.c, e.r, a0 + sw), bulge: 0 }];
  }
  if (e.type === 'LWPOLYLINE' && !e.closed) return e.vertices.map((q) => ({ ...q, bulge: q.bulge || 0 }));
  throw fail('UNSUPPORTED', `join of ${e.type}${e.closed ? ' (closed)' : ''}`);
}
function reverseVerts(v) {
  const n = v.length;
  return v.map((_, k) => ({ ...v[n - 1 - k], bulge: k < n - 1 ? -(v[n - 2 - k].bulge || 0) : 0 }));
}
function joinArcs(first, ents, tolA) {
  const iv = ents.map((e) => (e.type === 'CIRCLE' ? { s: 0, sw: TAU } : { s: normAngle(e.a0 * DEG), sw: ccwSweep(e.a0 * DEG, e.a1 * DEG) }));
  const covered = (x) => iv.some((j) => { const d = normAngle(x - j.s); return d > tolA && d < j.sw - tolA; });
  let gap = null;
  for (const i of iv) {
    const E = normAngle(i.s + i.sw);
    if (i.sw >= TAU - tolA || covered(E)) continue;
    const toNext = Math.min(...iv.map((j) => normAngle(j.s - E)));
    if (toNext > tolA && (!gap || toNext > gap.len)) gap = { E, len: toNext };
  }
  if (!gap) return like(first, 'CIRCLE', { c: P(first.c), r: first.r });
  const base = first.type === 'ARC' ? clone(first) : like(first, 'ARC', { c: P(first.c), r: first.r });
  return { ...base, a0: normAngle(gap.E + gap.len) / DEG, a1: gap.E / DEG };
}

// ---- LENGTHEN -------------------------------------------------------------------------------
/** LENGTHEN the end of a LINE or ARC nearest `pick`.
 *  mode 'delta' (value = added length, negative shortens), 'percent' (value % of current length),
 *  'total' (value = new length), 'dynamic' (point = where the end goes). For arcs, angle: true reads
 *  value as degrees of included angle (delta / total). */
export function lengthen(e, pick, { mode = 'delta', value = 0, angle = false, point = null } = {}) {
  const out = editSet(), c = clone(e);
  if (e.type === 'LINE') {
    const atP1 = dist(pick, e.p1) < dist(pick, e.p2);
    const F = atP1 ? e.p2 : e.p1, M = atP1 ? e.p1 : e.p2, L = dist(F, M), d = unit(sub(M, F));
    const nl = mode === 'delta' ? L + value : mode === 'percent' ? (L * value) / 100 : mode === 'total' ? value
      : mode === 'dynamic' ? dot(sub(point, F), d) : NaN;
    if (!(nl > EPS)) throw fail('GEOMETRY', 'the new length must be positive');
    c[atP1 ? 'p1' : 'p2'] = plus(F, mul(d, nl));
    out.change.push(c); return out;
  }
  if (e.type === 'ARC') {
    const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
    const atStart = dist(pick, polar(e.c, e.r, a0)) < dist(pick, polar(e.c, e.r, a0 + sw));
    const k = angle ? DEG : 1 / e.r;
    let ns;
    if (mode === 'delta') ns = sw + value * k;
    else if (mode === 'percent') ns = (sw * value) / 100;
    else if (mode === 'total') ns = value * k;
    else if (mode === 'dynamic') { const ap = ang(sub(point, e.c)); ns = atStart ? normAngle(a0 + sw - ap) : normAngle(ap - a0); } else ns = NaN;
    if (!(ns > EPS && ns < TAU - EPS)) throw fail('GEOMETRY', 'the new arc angle must be between 0 and 360 degrees');
    if (atStart) c.a0 = normAngle(a0 + sw - ns) / DEG; else c.a1 = normAngle(a0 + ns) / DEG;
    out.change.push(c); return out;
  }
  throw fail('UNSUPPORTED', `lengthen of ${e.type}`);
}

// ---- STRETCH --------------------------------------------------------------------------------
/** STRETCH with a crossing window {minx,miny,maxx,maxy} and displacement (dx,dy):
 *  objects entirely inside move; LINE / LWPOLYLINE (bulges kept) / SPLINE / LEADER / SOLID move the points inside;
 *  an ARC with one end inside moves that end keeping its chord height (AutoCAD); CIRCLE / ELLIPSE move when
 *  the centre is inside; TEXT / MTEXT / INSERT / POINT move when the insertion point is inside. */
export function stretch(ents, win, dx, dy, doc = null) {
  const inW = (p) => p.x >= win.minx - EPS && p.x <= win.maxx + EPS && p.y >= win.miny - EPS && p.y <= win.maxy + EPS;
  const mv = (p) => ({ ...p, x: p.x + dx, y: p.y + dy });
  const out = editSet();
  for (const e of ents) {
    const b = bboxOf(e, doc);
    if (b && inW({ x: b.minx, y: b.miny }) && inW({ x: b.maxx, y: b.maxy })) {
      out.change.push({ ...transformEntity(e, translation(dx, dy)), id: e.id });
      continue;
    }
    const c = clone(e);
    let moved = false;
    const mvIf = (p) => { if (inW(p)) { moved = true; return mv(p); } return p; };
    switch (e.type) {
      case 'LINE': c.p1 = mvIf(e.p1); c.p2 = mvIf(e.p2); break;
      case 'LWPOLYLINE': c.vertices = e.vertices.map(mvIf); break;
      case 'SPLINE': c.ctrl = (e.ctrl || []).map(mvIf); c.fit = (e.fit || []).map(mvIf); break;
      case 'LEADER': case 'SOLID': c.pts = e.pts.map(mvIf); break;
      case 'CIRCLE': case 'ELLIPSE': c.c = mvIf(e.c); break;
      case 'TEXT': case 'MTEXT': case 'INSERT': case 'POINT':
        if (e.p && inW(e.p)) { Object.assign(c, transformEntity(e, translation(dx, dy))); c.id = e.id; moved = true; }
        break;
      case 'ARC': {
        const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
        const S = polar(e.c, e.r, a0), E = polar(e.c, e.r, a0 + sw);
        if (!inW(S) && !inW(E)) break;
        const S2 = mvIf(S), E2 = mvIf(E);
        const h = dist(polar(e.c, e.r, a0 + sw / 2), mid(S, E)); // chord height, kept
        const ch = dist(S2, E2);
        if (ch < EPS) throw fail('GEOMETRY', 'stretch would collapse the arc');
        const a = bulgeToArc(S2, E2, (2 * h) / ch);
        Object.assign(c, { c: a.c, r: a.r, a0: normAngle(a.a0) / DEG, a1: normAngle(a.a0 + a.sweep) / DEG });
        break;
      }
      default: break;
    }
    if (moved) out.change.push(c);
  }
  return out;
}

// ---- ARRAY (non-associative copies) ---------------------------------------------------------
function copiesBy(ents, m, out) { for (const e of ents) { const c = transformEntity(e, m); c.id = 0; out.add.push(c); } }
function selectionCentre(ents, doc) {
  let b = null;
  for (const e of ents) b = unionBox(b, bboxOf(e, doc));
  return b ? { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2 } : { x: 0, y: 0 };
}
/** Rectangular array: rows x cols items (the originals are item [0,0]); spacings along the array axes, the
 *  whole grid rotated by `angle` degrees. */
export function arrayRect(ents, { rows = 1, cols = 1, rowSpacing = 0, colSpacing = 0, angle = 0 } = {}) {
  const out = editSet(), c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    if (!i && !j) continue;
    const x = j * colSpacing, y = i * rowSpacing;
    copiesBy(ents, translation(x * c - y * s, x * s + y * c), out);
  }
  return out;
}
/** Polar array of `count` items (originals included) about `center`, filling `fillAngle` degrees
 *  (positive CCW; 360 spreads items evenly round the full circle). rotate: false keeps the items' orientation
 *  (they move with basePoint, default the selection's centre). */
export function arrayPolar(ents, { center, count, fillAngle = 360, rotate = true, basePoint = null, doc = null } = {}) {
  if (!(count >= 2)) throw fail('GEOMETRY', 'a polar array needs at least 2 items');
  const full = Math.abs(fillAngle) >= 360 - 1e-9;
  const step = (fillAngle / (full ? count : count - 1)) * DEG;
  const base = basePoint ?? selectionCentre(ents, doc);
  const out = editSet();
  for (let k = 1; k < count; k++) {
    const R = rotation(k * step, center.x, center.y);
    if (rotate) copiesBy(ents, R, out);
    else { const q = sub(plus(center, rotateVec(sub(base, center), k * step)), base); copiesBy(ents, translation(q.x, q.y), out); }
  }
  return out;
}
const rotateVec = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

function pathVerts(path, doc) {
  switch (path.type) {
    case 'LINE': return { vertices: [{ ...P(path.p1), bulge: 0 }, { ...P(path.p2), bulge: 0 }], closed: false };
    case 'ARC': return { vertices: chainVerts(path), closed: false };
    case 'CIRCLE': return { vertices: [{ ...polar(path.c, path.r, 0), bulge: 1 }, { ...polar(path.c, path.r, Math.PI), bulge: 1 }], closed: true };
    case 'LWPOLYLINE': return path;
    default: {
      const pl = tessellate(path, doc, 0)[0];
      if (!pl || pl.length < 2) throw fail('UNSUPPORTED', `path array along ${path.type}`);
      return { vertices: pl.map((q) => ({ ...q, bulge: 0 })), closed: false };
    }
  }
}
/** Path array: items along LINE / ARC / CIRCLE / LWPOLYLINE (other curves via their tessellation).
 *  Either `count` items spread over the whole path, or `spacing` (with optional count) from the start.
 *  The selection's basePoint (default its centre) is placed on the path; align: true turns each item with
 *  the path tangent relative to the start. The originals are moved into the array (removed; all items are added). */
export function arrayPath(ents, path, { count = null, spacing = null, align = true, basePoint = null, doc = null } = {}) {
  const pv = pathVerts(path, doc), segs = plSegs(pv);
  const L = segs.reduce((a, s) => a + s.len, 0);
  if (!(L > EPS)) throw fail('GEOMETRY', 'the path has no length');
  let n = count, sp = spacing;
  if (sp != null) { if (!(sp > EPS)) throw fail('GEOMETRY', 'spacing must be > 0'); if (n == null) n = Math.floor(L / sp + 1e-9) + 1; } else {
    if (!(n >= 1)) throw fail('GEOMETRY', 'give a count or a spacing');
    sp = n === 1 ? 0 : L / (pv.closed ? n : n - 1);
  }
  const at = (s) => {
    let acc = 0;
    for (const sg of segs) {
      if (s <= acc + sg.len + 1e-12 || sg === segs[segs.length - 1]) { const f = sg.len > 0 ? Math.min(1, Math.max(0, (s - acc) / sg.len)) : 0; return { p: segPoint(sg, f), d: segDir(sg, f) }; }
      acc += sg.len;
    }
    return null;
  };
  const base = basePoint ?? selectionCentre(ents, doc);
  const a0 = ang(at(0).d);
  const out = editSet();
  for (let k = 0; k < n; k++) {
    const { p, d } = at(Math.min(k * sp, L));
    let m = translation(p.x - base.x, p.y - base.y);
    if (align) m = compose(rotation(ang(d) - a0, p.x, p.y), m);
    copiesBy(ents, m, out);
  }
  for (const e of ents) out.remove.push(e.id);
  return out;
}
