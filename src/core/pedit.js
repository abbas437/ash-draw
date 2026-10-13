// ASH Draw Studio - PEDIT, REVERSE and BREAKATPOINT as pure geometry (no DOM, no session).
// Behaviour follows AutoCAD LT. Like modify.js, every operation returns an EDIT SET
//   { add: [...], remove: [ids], change: [...] }  (apply with applyEditSet from edit.js)
// and a changed entity keeps its id, layer, colour, linetype, lineweight, transparency and xdata (it is a copy).
// Per-vertex widths are the optional vertex fields `sw` (start width) and `ew` (end width); `width` is the
// polyline's constant width. Failures throw Error with code 'GEOMETRY' or 'UNSUPPORTED'.
import { DEG, dist, ccwSweep } from './geom.js';
import { breakAt } from './modify.js';

function fail(code, msg) { const err = new Error(msg); err.code = code; return err; }
function clone(e) { const c = structuredClone(e); delete c.parent; return c; }
const editSet = () => ({ add: [], remove: [], change: [] });
const polar = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
const isPoly = (e) => e?.type === 'LWPOLYLINE';
const changed = (ne) => { const s = editSet(); s.change.push(ne); return s; };

/** Vertices of a LINE / ARC / LWPOLYLINE as polyline vertices (copies). */
function vertsOf(e) {
  if (e.type === 'LINE') return [{ x: e.p1.x, y: e.p1.y, bulge: 0 }, { x: e.p2.x, y: e.p2.y, bulge: 0 }];
  if (e.type === 'ARC') {
    const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
    return [{ ...polar(e.c, e.r, a0), bulge: Math.tan(sw / 4) }, { ...polar(e.c, e.r, a0 + sw), bulge: 0 }];
  }
  if (isPoly(e)) return e.vertices.map((v) => ({ ...v, bulge: v.bulge || 0 }));
  throw fail('UNSUPPORTED', `${e.type} is not a line, arc or polyline`);
}

/** LINE or ARC -> LWPOLYLINE with the same id and properties (PEDIT "turn it into one? <Y>"). */
export function toPolylineEntity(e) {
  if (e.type !== 'LINE' && e.type !== 'ARC') throw fail('UNSUPPORTED', `${e.type} cannot be turned into a polyline`);
  const c = clone(e);
  for (const k of ['p1', 'p2', 'c', 'r', 'a0', 'a1']) delete c[k];
  return { ...c, type: 'LWPOLYLINE', vertices: vertsOf(e), closed: false };
}
export function toPolyline(e) { return changed(toPolylineEntity(e)); }

function needPoly(e) { if (!isPoly(e)) throw fail('UNSUPPORTED', 'not a polyline'); }

/** Close / Open. */
export function setClosed(e, closed) {
  needPoly(e);
  if (closed && e.vertices.length < 2) throw fail('GEOMETRY', 'a polyline needs two vertices to close');
  return changed({ ...clone(e), closed: !!closed });
}

/** Width: one uniform width for every segment (per-vertex widths are replaced). */
export function setWidth(e, w) {
  needPoly(e);
  if (!(w >= 0)) throw fail('GEOMETRY', 'width must be 0 or more');
  const c = clone(e);
  c.vertices = c.vertices.map(({ sw, ew, ...v }) => v);
  if (c.frame) c.frame = c.frame.map(({ sw, ew, ...v }) => v); // a later Decurve must not bring old widths back
  if (w > 0) c.width = w; else delete c.width;
  return changed(c);
}

// ---- Fit and Spline -------------------------------------------------------------------------------
// Both keep the vertices they started from as `e.frame` (with `e.frameKind` 'fit' or 'spline5' / 'spline6' and the
// segments per span), so Decurve can give them back. A frame is used only while the polyline is still exactly the
// curve made from it (anything else edited it since), so a stale frame is ignored. The frame is not written to DXF.
const unit = (x, y) => { const l = Math.hypot(x, y); return l > 0 ? { x: x / l, y: y / l } : null; };
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
/** half the signed angle from direction a to direction b, as a bulge: tan(angle / 2) */
const halfTan = (a, b) => {
  const ang = Math.atan2(cross(a, b), dot(a, b));
  if (Math.PI - Math.abs(ang) < 2e-6) return 0; // hairpin (tangent opposes the chord): tan(pi/2) blows up -> straight half
  return Math.max(-1e6, Math.min(1e6, Math.tan(ang / 2)));
};
const stripVerts = (v) => v.map(({ x, y, sw, ew }) => ({ x, y, bulge: 0, ...(sw !== undefined && { sw }), ...(ew !== undefined && { ew }) }));
/** consecutive coincident vertices dropped (a closed polyline's last vertex too when it repeats the first) */
function distinct(v, closed) {
  const out = v.filter((p, i) => i === 0 || dist(p, v[i - 1]) > 1e-12);
  if (closed && out.length > 1 && dist(out[0], out.at(-1)) <= 1e-12) out.pop();
  return out;
}

/** Tangent directions of the fit curve at each vertex: the bisector of the two unit chords meeting there. At the ends
 *  of an open polyline, the end chord's reflection of the next tangent (the tangent of the circle through the first
 *  three vertices). */
function fitTangents(P, closed) {
  const n = P.length, ch = (i) => unit(P[(i + 1) % n].x - P[i].x, P[(i + 1) % n].y - P[i].y);
  const t = P.map((_, i) => {
    if (!closed && (i === 0 || i === n - 1)) return null;
    const a = ch((i - 1 + n) % n), b = ch(i);
    return unit(a.x + b.x, a.y + b.y) || b;
  });
  if (!closed) {
    const end = (d, m) => (m ? { x: 2 * dot(d, m) * d.x - m.x, y: 2 * dot(d, m) * d.y - m.y } : d);
    t[0] = end(ch(0), t[1]);
    t[n - 1] = end(ch(n - 2), t[n - 2]);
  }
  return t;
}

/** The two-arc (biarc) piece from p0 (tangent t0) to p1 (tangent t1): equal tangent legs a, joint J halfway between
 *  p0 + a t0 and p1 - a t1. Returns [bulge p0->J, J, bulge J->p1]. */
function biarc(p0, t0, p1, t1) {
  const d = { x: p1.x - p0.x, y: p1.y - p0.y }, s = { x: t0.x + t1.x, y: t0.y + t1.y };
  const A = 2 * (dot(t0, t1) - 1), B = -2 * dot(d, s), C = dot(d, d);
  let a = Math.abs(A) < 1e-12 ? (B < 0 ? -C / B : null) : (-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A);
  if (!(a > 0) || !Number.isFinite(a)) a = null;
  const J = a === null ? { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
    : { x: (p0.x + a * t0.x + p1.x - a * t1.x) / 2, y: (p0.y + a * t0.y + p1.y - a * t1.y) / 2 };
  const c0 = unit(J.x - p0.x, J.y - p0.y), c1 = unit(p1.x - J.x, p1.y - J.y);
  return [c0 ? halfTan(t0, c0) : 0, J, c1 ? halfTan(c1, t1) : 0];
}

/** Fit vertices through the frame `P`: every frame vertex stays, with one extra vertex between each pair; each pair of
 *  arcs is tangent-continuous at the extra vertex and at the frame vertices. Per-vertex widths run halfway each. */
function fitVertices(frame, closed) {
  const P = distinct(frame, closed), n = P.length;
  if (n < 2) throw fail('GEOMETRY', 'a polyline needs two distinct vertices to fit');
  const T = fitTangents(P, closed), out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, [b0, J, b1] = biarc(P[i], T[i], P[j], T[j]);
    const sw = P[i].sw, ew = P[i].ew, mid = sw !== undefined && ew !== undefined ? (sw + ew) / 2 : undefined;
    out.push({ x: P[i].x, y: P[i].y, bulge: b0, ...(sw !== undefined && { sw }), ...(mid !== undefined && { ew: mid }) });
    out.push({ x: J.x, y: J.y, bulge: b1, ...(mid !== undefined && { sw: mid }), ...(ew !== undefined && { ew }) });
  }
  if (!closed) out.push({ x: P[n - 1].x, y: P[n - 1].y, bulge: 0 });
  return out;
}

/** Points of a uniform B-spline of `degree` with control points P (clamped to the ends when open, periodic when
 *  closed), `segs` straight segments per span. */
function bsplinePoints(P, closed, degree, segs) {
  const n = P.length, p = Math.min(degree, n - 1);
  const C = closed ? [...P, ...P.slice(0, p)] : P;
  const m = C.length;
  const U = closed ? Array.from({ length: m + p + 1 }, (_, i) => i)
    : Array.from({ length: m + p + 1 }, (_, i) => Math.min(Math.max(i - p, 0), m - p));
  const t0 = U[p], t1 = U[m], spans = t1 - t0, out = [];
  const at = (t) => {
    let k = p; while (k < m - 1 && t >= U[k + 1]) k++;
    const d = Array.from({ length: p + 1 }, (_, j) => ({ x: C[k - p + j].x, y: C[k - p + j].y }));
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j, a = (t - U[i]) / (U[i + p + 1 - r] - U[i]);
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
      }
    }
    return d[p];
  };
  const N = spans * segs;
  for (let i = 0; i < N + (closed ? 0 : 1); i++) out.push(i === N ? { ...C[m - 1] } : at(t0 + (spans * i) / N));
  if (!closed) { out[0] = { x: C[0].x, y: C[0].y }; out[N] = { x: C[m - 1].x, y: C[m - 1].y }; }
  return out.map(({ x, y }) => ({ x, y, bulge: 0 }));
}

function curveOf(frame, closed, kind, segs) {
  if (kind === 'fit') return fitVertices(frame, closed);
  const P = distinct(frame, closed);
  if (P.length < 2) throw fail('GEOMETRY', 'a polyline needs two distinct vertices to spline');
  return bsplinePoints(P, closed, kind === 'spline5' ? 2 : 3, segs);
}

/** The frame of a fitted / splined polyline, or null when it has none or it no longer matches the curve. */
export function validFrame(e) {
  if (!Array.isArray(e.frame) || !e.frameKind) return null;
  let v;
  try { v = curveOf(e.frame, !!e.closed, e.frameKind, e.frameSegs || 8); } catch (err) { if (!err.code) throw err; return null; }
  const cur = e.vertices;
  if (v.length !== cur.length || v.some((q, i) => Math.abs(q.x - cur[i].x) > 1e-9 || Math.abs(q.y - cur[i].y) > 1e-9
    || Math.abs(q.bulge - (cur[i].bulge || 0)) > 1e-9)) return null;
  return e.frame;
}

function withCurve(e, kind, segs) {
  needPoly(e);
  const frame = validFrame(e) || stripVerts(e.vertices);
  const c = clone(e);
  c.vertices = curveOf(frame, !!e.closed, kind, segs);
  c.frame = structuredClone(frame); c.frameKind = kind;
  if (kind === 'fit') delete c.frameSegs; else c.frameSegs = segs;
  return changed(c);
}

/** PEDIT Fit: a curve of arcs through every vertex, tangent-continuous (AutoCAD's curve fit: one extra vertex between
 *  each pair of vertices). A polyline already fitted or splined is fitted from its frame. */
export function fitCurve(e) { return withCurve(e, 'fit'); }

/** PEDIT Spline: a quadratic (splineType 5) or cubic (6) B-spline with the vertices as control points, as `segs`
 *  straight segments per span (AutoCAD's SPLINETYPE / SPLINESEGS; a curve fit of the samples is not done). */
export function splineFit(e, { splineType = 6, segs = 8 } = {}) {
  if (splineType !== 5 && splineType !== 6) throw fail('GEOMETRY', 'spline type must be 5 or 6');
  if (!(Number.isInteger(segs) && segs >= 1)) throw fail('GEOMETRY', 'segments per span must be a whole number of 1 or more');
  return withCurve(e, `spline${splineType}`, segs);
}

/** Decurve: every arc segment becomes straight; a fitted or splined polyline goes back to its frame. */
export function decurve(e) {
  needPoly(e);
  const c = clone(e), frame = validFrame(e);
  c.vertices = frame ? stripVerts(frame) : c.vertices.map((v) => ({ ...v, bulge: 0 }));
  delete c.frame; delete c.frameKind; delete c.frameSegs;
  return changed(c);
}

/** Vertices in reverse order. New segment k runs over the old segment (n-2-k) mod n backwards, so it takes that
 *  segment's bulge negated and its start / end widths swapped. Works for open and closed polylines. */
export function reverseVertices(v, closed = false) {
  const n = v.length;
  return v.map((_, k) => {
    const out = { ...v[n - 1 - k] };
    delete out.sw; delete out.ew;
    const j = k < n - 1 ? n - 2 - k : closed ? n - 1 : -1; // the old segment the new segment k runs over
    const s = j >= 0 ? v[j] : null;
    out.bulge = s ? -(s.bulge || 0) || 0 : 0;
    if (s && s.ew !== undefined) out.sw = s.ew;
    if (s && s.sw !== undefined) out.ew = s.sw;
    return out;
  });
}

/** REVERSE one entity: the shape is unchanged, its direction is reversed. */
export function reverseEntity(e) {
  const c = clone(e);
  if (e.type === 'LINE') { c.p1 = { ...e.p2 }; c.p2 = { ...e.p1 }; return c; }
  // An ARC is always stored counter-clockwise from a0 to a1, so its geometry (and its stored form) stays as it is.
  if (e.type === 'ARC') return c;
  if (isPoly(e)) { c.vertices = reverseVertices(e.vertices, e.closed); return c; }
  if (e.type === 'SPLINE') {
    if (c.ctrl?.length) {
      c.ctrl = [...e.ctrl].reverse();
      if (e.weights?.length) c.weights = [...e.weights].reverse();
      if (e.knots?.length) { const a = e.knots[0], b = e.knots[e.knots.length - 1]; c.knots = e.knots.map((t) => a + b - t).reverse(); }
    }
    if (c.fit?.length) c.fit = [...e.fit].reverse();
    return c;
  }
  throw fail('UNSUPPORTED', `reverse of ${e.type}`);
}
export function reverse(ents) {
  const out = editSet();
  out.failed = [];
  for (const e of ents) { try { out.change.push(reverseEntity(e)); } catch (err) { if (!err.code) throw err; out.failed.push({ id: e.id, reason: err.message }); } }
  return out;
}

/** Join tolerance: the fuzz distance, at least 1e-9 x the extents of the involved objects. */
const fuzzOf = (fuzz) => Math.max(fuzz || 0, 1e-9);

/** PEDIT Join: LINEs, ARCs and open LWPOLYLINEs whose ends touch the open polyline `pl` (within `fuzz`) are added
 *  to it, end to end, in whichever direction fits; repeated until nothing more connects. The joined objects are
 *  removed; `pl` keeps its id and properties. Returns the edit set with `joined` = number of objects added. */
export function joinToPolyline(pl, ents, { fuzz = 0 } = {}) {
  needPoly(pl);
  if (pl.closed) throw fail('GEOMETRY', 'cannot join to a closed polyline');
  const T = fuzzOf(fuzz);
  const items = ents.filter((e) => e && e.id !== pl.id && (e.type === 'LINE' || e.type === 'ARC' || (isPoly(e) && !e.closed)))
    .map((e) => ({ e, v: vertsOf(e) }));
  let chain = vertsOf(pl);
  const used = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const it of items) {
      if (used.includes(it)) continue;
      const head = chain[0], tail = chain[chain.length - 1];
      const s = it.v[0], t = it.v[it.v.length - 1];
      let v = null, atEnd = true;
      if (dist(tail, s) <= T) v = it.v;
      else if (dist(tail, t) <= T) v = reverseVertices(it.v);
      else if (dist(head, t) <= T) { v = it.v; atEnd = false; } else if (dist(head, s) <= T) { v = reverseVertices(it.v); atEnd = false; }
      if (!v) continue;
      if (atEnd) chain = [...chain.slice(0, -1), { ...v[0], x: tail.x, y: tail.y }, ...v.slice(1)];
      else chain = [...v.slice(0, -1), { ...head }, ...chain.slice(1)];
      used.push(it); grew = true;
    }
  }
  const out = changed({ ...clone(pl), vertices: chain });
  out.remove = used.map((u) => u.e.id);
  out.joined = used.length;
  return out;
}

/** PEDIT Multiple + Join: lines and arcs among `ents` are turned into polylines, then each open polyline gathers
 *  the touching pieces. Returns one edit set (joined = objects merged away). */
export function joinMany(ents, { fuzz = 0 } = {}) {
  const cur = new Map(ents.filter((e) => e.type === 'LINE' || e.type === 'ARC' || (isPoly(e) && !e.closed))
    .map((e) => [e.id, isPoly(e) ? e : toPolylineEntity(e)]));
  const out = editSet();
  out.joined = 0;
  for (const id of [...cur.keys()]) {
    const pl = cur.get(id);
    if (!pl) continue; // already joined into another
    const r = joinToPolyline(pl, [...cur.values()], { fuzz });
    for (const g of r.remove) cur.delete(g);
    cur.set(id, r.change[0]);
    out.joined += r.joined;
    out.remove.push(...r.remove);
  }
  out.change = [...cur.values()].filter((e) => e !== ents.find((x) => x.id === e.id));
  return out;
}

/** BREAKATPOINT: one object split in two at `p`. Closed objects cannot be broken at a single point. */
export function breakAtPoint(e, p) {
  if (e.type === 'CIRCLE') throw fail('GEOMETRY', 'Arc cannot be full 360 degrees.');
  if (e.type === 'ELLIPSE' && Math.abs((e.a1 ?? 2 * Math.PI) - (e.a0 ?? 0)) >= 2 * Math.PI - 1e-9) throw fail('GEOMETRY', 'Arc cannot be full 360 degrees.');
  if ((isPoly(e) || e.type === 'SPLINE') && e.closed) throw fail('GEOMETRY', 'Cannot break a closed object at a single point.');
  return breakAt(e, p);
}

// ---- Edit vertex ----------------------------------------------------------------------------------
// PEDIT Edit vertex. `i`, `j` are vertex indices. Every edit drops a Fit / Spline frame (the curve is no longer the
// one made from it). Segment k runs from vertex k to vertex k+1 (to vertex 0 for the closing segment).
function vedit(e) {
  needPoly(e);
  const c = clone(e);
  delete c.frame; delete c.frameKind; delete c.frameSegs;
  return c;
}
function needIndex(e, ...ix) {
  for (const i of ix) if (!(Number.isInteger(i) && i >= 0 && i < e.vertices.length)) throw fail('GEOMETRY', `no vertex ${i}`);
}
/** an end vertex of an open polyline: no segment starts there, so no bulge and no widths */
const endVertex = ({ sw, ew, ...v }) => ({ ...v, bulge: 0 });

/** Insert: a new vertex at `p` after vertex `i`; the segment it splits becomes two straight ones (as AutoCAD). The
 *  new vertex carries vertex i's segment widths, so both halves keep them. */
export function insertVertex(e, i, p) {
  needIndex(e, i);
  const c = vedit(e), v = c.vertices[i];
  const nv = { x: p.x, y: p.y, bulge: 0, ...(v.sw !== undefined && { sw: v.sw }), ...(v.ew !== undefined && { ew: v.ew }) };
  v.bulge = 0;
  c.vertices.splice(i + 1, 0, nv);
  return changed(c);
}

/** Move: vertex `i` to `p` (the bulges stay, so arc segments keep their included angle). */
export function moveVertex(e, i, p) {
  needIndex(e, i);
  const c = vedit(e);
  Object.assign(c.vertices[i], { x: p.x, y: p.y });
  return changed(c);
}

/** Break: the segments between vertices i and j (in vertex order) are removed. Open: up to two polylines remain (the
 *  first keeps the id; a piece of one vertex is dropped, so a break at an end shortens it). Closed: it opens, starting
 *  at the later vertex. i === j: an open polyline is split there; a closed one is opened there. */
export function breakBetween(e, i, j) {
  needIndex(e, i, j);
  const a = Math.min(i, j), b = Math.max(i, j), c = vedit(e), v = c.vertices, n = v.length;
  if (c.closed) {
    const ring = a === b ? [...v.slice(a), ...v.slice(0, a + 1)] : [...v.slice(b), ...v.slice(0, a + 1)];
    const last = ring.length - 1;
    ring[last] = endVertex(ring[last]);
    return changed({ ...c, closed: false, vertices: structuredClone(ring) });
  }
  const first = v.slice(0, a + 1), second = v.slice(b);
  if (first.length < 2 && second.length < 2) throw fail('GEOMETRY', 'cannot break off the whole polyline');
  if (a === b && (first.length < 2 || second.length < 2)) throw fail('GEOMETRY', 'cannot break a polyline at its end');
  first[first.length - 1] = endVertex(first[first.length - 1]);
  const pieces = [first, second].filter((p) => p.length >= 2).map((p) => structuredClone(p));
  const out = changed({ ...c, vertices: pieces[0] });
  if (pieces[1]) out.add.push({ ...clone(c), vertices: pieces[1] });
  return out;
}

/** Straighten: the vertices between i and j (in vertex order) are removed and the segment from the first is straight.
 *  i === j straightens the segment after that vertex. */
export function straightenBetween(e, i, j) {
  needIndex(e, i, j);
  const a = Math.min(i, j), b = Math.max(i, j), c = vedit(e);
  if (a === b && !c.closed && a === c.vertices.length - 1) throw fail('GEOMETRY', 'no segment after the last vertex');
  c.vertices.splice(a + 1, Math.max(0, b - a - 1));
  c.vertices[a].bulge = 0;
  return changed(c);
}

/** Width: start and end width of the segment after vertex i (its `sw` / `ew`). */
export function setSegmentWidth(e, i, sw, ew = sw) {
  needIndex(e, i);
  if (!(sw >= 0 && ew >= 0)) throw fail('GEOMETRY', 'width must be 0 or more');
  if (!e.closed && i === e.vertices.length - 1) throw fail('GEOMETRY', 'no segment after the last vertex');
  const c = vedit(e);
  Object.assign(c.vertices[i], { sw, ew });
  return changed(c);
}

/** Merge the session's top `n` undo steps into one step called `label` (PEDIT is one undo step however many
 *  options were used). Returns true when merged. */
export function mergeTopSteps(session, n, label) {
  if (n < 2 || session.undoStack.length < n) return false;
  const steps = session.undoStack.splice(session.undoStack.length - n, n);
  session.undoStack.push({ id: ++session.stepSeq, label, ops: steps.flatMap((s) => s.ops), doc: steps[0].doc });
  return true;
}
