// ASH Draw Studio - 2D geometry helpers over the drawing model (see model.js).
// Pure ES module. Matrices are canvas-style [a,b,c,d,e,f]:  x' = a*x + c*y + e ; y' = b*x + d*y + f.

import { mleaderParts, transformMLeader } from './mleader.js';
import { nurbsOf, curveOfNurbs, curveCurveHits, nearestParam, slice as nurbsSlice, splineEntity, offsetNurbs, isClosed, derivsAt, domain, lineNurbs, joinCurves, subCurve } from './nurbs.js';

const TAU = Math.PI * 2;
const EPS = 1e-9;
export const DEG = Math.PI / 180;

// ---- matrices -------------------------------------------------------------------------------
export const IDENTITY = [1, 0, 0, 1, 0, 0];
/** compose(a, b): apply b first, then a. */
export function compose(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export const apply = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export const applyVec = (m, v) => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });
export const det = (m) => m[0] * m[3] - m[1] * m[2];
export const translation = (dx, dy) => [1, 0, 0, 1, dx, dy];
export function rotation(rad, cx = 0, cy = 0) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
export function scaling(sx, sy = sx, cx = 0, cy = 0) {
  return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}
/** Mirror about the line through p1 and p2. */
export function mirrorLine(p1, p2) {
  const a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const c = Math.cos(2 * a), s = Math.sin(2 * a);
  // reflection matrix about a line through origin at angle a: [[c, s],[s, -c]]
  const m = [c, s, s, -c, 0, 0];
  const o = apply(m, p1);
  m[4] = p1.x - o.x; m[5] = p1.y - o.y;
  return m;
}
export function invert(m) {
  const d = det(m);
  if (Math.abs(d) < EPS) throw new Error('singular matrix');
  const a = m[3] / d, b = -m[1] / d, c = -m[2] / d, dd = m[0] / d;
  return [a, b, c, dd, -(a * m[4] + c * m[5]), -(b * m[4] + dd * m[5])];
}
/** Is the linear part a similarity (rotation + uniform scale, optionally mirrored)? */
export function isSimilarity(m, tol = 1e-9) {
  const l1 = Math.hypot(m[0], m[1]), l2 = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return Math.abs(l1 - l2) <= tol * Math.max(l1, l2, 1) && Math.abs(dot) <= tol * Math.max(l1 * l2, 1);
}
export const matScale = (m) => Math.sqrt(Math.abs(det(m)));

// ---- vectors / angles -----------------------------------------------------------------------
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const normAngle = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };
/** CCW sweep from a0 to a1 in (0, 2π]. */
export function ccwSweep(a0, a1) {
  let s = normAngle(a1 - a0);
  if (s < 1e-12) s = TAU;
  return s;
}
const onSweep = (a, a0, sweep) => normAngle(a - a0) <= sweep + 1e-9;

// ---- bulge arcs -----------------------------------------------------------------------------
/** Arc described by a polyline segment p1->p2 with `bulge`. Returns {c,r,a0,sweep} (radians, sweep signed). */
export function bulgeToArc(p1, p2, bulge) {
  const d = dist(p1, p2);
  const h = 2 * Math.atan(bulge);              // half the included angle (signed)
  const r = d / (2 * Math.sin(Math.abs(h)));
  const m = mid(p1, p2);
  const nx = -(p2.y - p1.y) / d, ny = (p2.x - p1.x) / d; // left normal
  const off = (d / 2) / Math.tan(h);
  const c = { x: m.x + nx * off, y: m.y + ny * off };
  return { c, r, a0: Math.atan2(p1.y - c.y, p1.x - c.x), sweep: 4 * Math.atan(bulge) };
}
export function arcToBulge(sweep) { return Math.tan(sweep / 4); }

function arcSteps(r, sweep, tol) {
  if (!(r > 0)) return 1;
  const t = tol && tol > 0 ? Math.min(tol, r) : r * 0.002;
  const step = 2 * Math.acos(Math.max(0, Math.min(1, 1 - t / r)));
  const safe = Math.min(Math.max(step, 0.5 * DEG), 30 * DEG);
  return Math.max(2, Math.ceil(Math.abs(sweep) / safe));
}
function arcPoints(c, r, a0, sweep, tol) {
  const n = arcSteps(r, sweep, tol);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

// ---- spline evaluation ----------------------------------------------------------------------
function clampedKnots(n, degree) {
  const k = [];
  for (let i = 0; i <= degree; i++) k.push(0);
  const inner = n - degree - 1;
  for (let i = 1; i <= inner; i++) k.push(i);
  for (let i = 0; i <= degree; i++) k.push(inner + 1);
  return k;
}
function splinePoints(e, tol) {
  let ctrl = e.ctrl, knots = e.knots, weights = e.weights, degree = e.degree || 3;
  if ((!ctrl || ctrl.length < 2) && e.fit && e.fit.length >= 2) return catmullRom(e.fit, e.closed);
  if (!ctrl || ctrl.length < 2) return [];
  if (ctrl.length <= degree) degree = ctrl.length - 1;
  if (!knots || knots.length !== ctrl.length + degree + 1) knots = clampedKnots(ctrl.length, degree);
  const n = ctrl.length;
  const t0 = knots[degree], t1 = knots[n];
  if (!(t1 > t0)) return ctrl.map((p) => ({ x: p.x, y: p.y }));
  const samples = Math.min(2000, Math.max(24, n * 16 * Math.max(1, Math.round(1 / Math.max(tol ? tol / 0.01 : 1, 0.25)))));
  const out = [];
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? t1 - 1e-12 : t0 + ((t1 - t0) * s) / samples;
    out.push(deBoor(ctrl, knots, weights, degree, t));
  }
  out[out.length - 1] = deBoor(ctrl, knots, weights, degree, t1 - 1e-12);
  return out;
}
function deBoor(ctrl, knots, weights, p, t) {
  const n = ctrl.length;
  let k = p;
  while (k < n - 1 && t >= knots[k + 1]) k++;
  const d = [];
  for (let j = 0; j <= p; j++) {
    const w = weights && weights[j + k - p] != null ? weights[j + k - p] : 1;
    const q = ctrl[j + k - p];
    d.push({ x: q.x * w, y: q.y * w, w });
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const den = knots[j + 1 + k - r] - knots[j + k - p];
      const a = den === 0 ? 0 : (t - knots[j + k - p]) / den;
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y,
        w: (1 - a) * d[j - 1].w + a * d[j].w,
      };
    }
  }
  const w = d[p].w || 1;
  return { x: d[p].x / w, y: d[p].y / w };
}
// Fit-point splines are approximated by a centripetal Catmull-Rom curve through the fit points
// (DXF stores tangents/knots for an exact fit; this approximation is visually close for display).
function catmullRom(pts, closed) {
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P[i], p1 = P[i + 1], p2 = P[i + 2], p3 = P[i + 3];
    const t0 = 0;
    const t1 = t0 + Math.pow(dist(p0, p1), 0.5) || 1e-6;
    const t2 = t1 + Math.pow(dist(p1, p2), 0.5) || 1e-6;
    const t3 = t2 + Math.pow(dist(p2, p3), 0.5) || 1e-6;
    const N = 12;
    for (let j = 0; j < N; j++) {
      const t = t1 + ((t2 - t1) * j) / N;
      const L = (a, b, ta, tb) => ({ x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta), y: ((tb - t) * a.y + (t - ta) * b.y) / (tb - ta) });
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      out.push(L(B1, B2, t1, t2));
    }
  }
  out.push({ x: P[closed ? pts.length + 1 : pts.length].x, y: P[closed ? pts.length + 1 : pts.length].y });
  if (closed) out[out.length - 1] = { ...out[0] };
  return out;
}

// ---- ellipse --------------------------------------------------------------------------------
export function ellipseAxes(e) {
  const u = { x: e.major.x, y: e.major.y };
  const v = { x: -e.major.y * e.ratio, y: e.major.x * e.ratio };
  return { u, v };
}
export function ellipsePoint(e, t) {
  const { u, v } = ellipseAxes(e);
  return { x: e.c.x + u.x * Math.cos(t) + v.x * Math.sin(t), y: e.c.y + u.y * Math.cos(t) + v.y * Math.sin(t) };
}
function ellipsePoints(e, tol) {
  const sweep = ccwSweep(e.a0 ?? 0, e.a1 ?? TAU);
  const full = Math.abs((e.a1 ?? TAU) - (e.a0 ?? 0)) >= TAU - 1e-9;
  const sw = full ? TAU : sweep;
  const a = Math.hypot(e.major.x, e.major.y);
  const n = arcSteps(a, sw, tol);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(ellipsePoint(e, (e.a0 ?? 0) + (sw * i) / n));
  return out;
}

// ---- tessellation ---------------------------------------------------------------------------
/** Entity -> array of polylines (each an array of {x,y}); closed shapes repeat the first point. */
export function tessellate(e, doc = null, tol = 0) {
  switch (e.type) {
    case 'LINE': return [[{ ...e.p1 }, { ...e.p2 }]];
    case 'VIEWPORT': { const w = e.width / 2, h = e.height / 2, c = e.c; return [[{ x: c.x - w, y: c.y - h }, { x: c.x + w, y: c.y - h }, { x: c.x + w, y: c.y + h }, { x: c.x - w, y: c.y + h }, { x: c.x - w, y: c.y - h }]]; }
    case 'LWPOLYLINE': return [polylinePoints(e, tol)];
    case 'CIRCLE': return [arcPoints(e.c, e.r, 0, TAU, tol)];
    case 'ARC': return [arcPoints(e.c, e.r, e.a0 * DEG, ccwSweep(e.a0 * DEG, e.a1 * DEG), tol)];
    case 'ELLIPSE': return [ellipsePoints(e, tol)];
    case 'SPLINE': { const p = splinePoints(e, tol); return p.length ? [p] : []; }
    case 'SOLID': {
      const p = e.pts;
      if (!p || p.length < 3) return [];
      // DXF SOLID vertex order is 1,2,4,3
      const q = p.length === 4 ? [p[0], p[1], p[3], p[2]] : p;
      return [[...q.map((a) => ({ ...a })), { ...q[0] }]];
    }
    case 'POINT': return [[{ ...e.p }]];
    case 'LEADER': return e.pts && e.pts.length > 1 ? [e.pts.map((a) => ({ ...a }))] : [];
    case 'MLEADER': return mleaderParts(e).flatMap((sub) => (sub.type === 'MTEXT' ? [[{ ...sub.p }]] : tessellate(sub, doc, tol)));
    case 'HATCH': return (e.loops || []).map((l) => hatchLoopPoints(l, tol)).filter((l) => l.length > 1);
    case 'INSERT':
    case 'DIMENSION': {
      const out = [];
      for (const sub of explode(e, doc)) for (const pl of tessellate(sub, doc, tol)) out.push(pl);
      return out;
    }
    default: return [];
  }
}
export function polylinePoints(e, tol = 0) {
  const v = e.vertices;
  if (!v || v.length === 0) return [];
  const out = [{ x: v[0].x, y: v[0].y }];
  const n = e.closed ? v.length : v.length - 1;
  for (let i = 0; i < n; i++) {
    const p1 = v[i], p2 = v[(i + 1) % v.length];
    if (p1.bulge && Math.abs(p1.bulge) > 1e-12 && dist(p1, p2) > EPS) {
      const a = bulgeToArc(p1, p2, p1.bulge);
      const pts = arcPoints(a.c, a.r, a.a0, a.sweep, tol);
      for (let k = 1; k < pts.length - 1; k++) out.push(pts[k]);
    }
    out.push({ x: p2.x, y: p2.y });
  }
  return out;
}
function hatchLoopPoints(l, tol) {
  if (l.pts) return polylinePoints({ vertices: l.pts, closed: l.closed !== false }, tol);
  const out = [];
  for (const s of l.segs || []) {
    let pts = [];
    if (s.type === 'line') pts = [s.p1, s.p2];
    else if (s.type === 'arc') {
      let a0 = s.a0 * DEG, a1 = s.a1 * DEG;
      if (s.ccw === false) { const t = a0; a0 = a1; a1 = t; }
      pts = arcPoints(s.c, s.r, a0, ccwSweep(a0, a1), tol);
      if (s.ccw === false) pts.reverse();
    } else if (s.type === 'ellipse') {
      const ee = { c: s.c, major: s.major, ratio: s.ratio, a0: s.a0, a1: s.a1 };
      pts = ellipsePoints(ee, tol);
      if (s.ccw === false) pts.reverse();
    } else if (s.type === 'spline') pts = splinePoints(s, tol);
    for (const p of pts) {
      const q = out[out.length - 1];
      if (!q || dist(q, p) > 1e-9) out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

// ---- bounding boxes -------------------------------------------------------------------------
export function textExtent(e) {
  const h = e.height || 1;
  const raw = String(e.text ?? '');
  const lines = raw.split(/\\P|\n/);
  const w = Math.max(...lines.map((l) => l.length), 1) * h * 0.6 * (e.widthFactor || 1);
  const width = e.type === 'MTEXT' && e.width > 0 ? Math.min(e.width, w) : w;
  return { w: width, h: h * lines.length * (e.type === 'MTEXT' ? 1.4 : 1) };
}
/** Axis-aligned bbox {minx,miny,maxx,maxy} or null. */
export function bboxOf(e, doc = null) {
  if (e.type === 'TEXT' || e.type === 'MTEXT') {
    const { w, h } = textExtent(e);
    const r = (e.rot || 0) * DEG, c = Math.cos(r), s = Math.sin(r);
    const mtext = e.type === 'MTEXT';
    const corners = mtext
      ? [[0, 0], [w, 0], [w, -h], [0, -h]]
      : [[0, 0], [w, 0], [w, h], [0, h]];
    return boxOfPoints(corners.map(([x, y]) => ({ x: e.p.x + x * c - y * s, y: e.p.y + x * s + y * c })));
  }
  if (e.type === 'CIRCLE' || e.type === 'ARC' || e.type === 'LWPOLYLINE') {
    let b = null;
    for (const pr of toPrims(e, doc)) {
      if (pr.k === 'seg') { b = growBox(b, pr.a); b = growBox(b, pr.b); continue; }
      b = growBox(b, { x: pr.c.x + pr.r * Math.cos(pr.a0), y: pr.c.y + pr.r * Math.sin(pr.a0) });
      b = growBox(b, { x: pr.c.x + pr.r * Math.cos(pr.a0 + pr.sweep), y: pr.c.y + pr.r * Math.sin(pr.a0 + pr.sweep) });
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        if (onSweep(a, pr.a0, pr.sweep)) b = growBox(b, { x: pr.c.x + pr.r * Math.cos(a), y: pr.c.y + pr.r * Math.sin(a) });
      }
    }
    return b;
  }
  if (e.type === 'ELLIPSE') {
    const { u, v } = ellipseAxes(e);
    const a0 = e.a0 ?? 0;
    const full = Math.abs((e.a1 ?? TAU) - a0) >= TAU - 1e-9;
    const sw = full ? TAU : ccwSweep(a0, e.a1);
    let b = growBox(null, ellipsePoint(e, a0));
    b = growBox(b, ellipsePoint(e, a0 + sw));
    // extremes where d/dt = 0:  x: tan t = v.x/u.x ; y: tan t = v.y/u.y
    for (const t0 of [Math.atan2(v.x, u.x), Math.atan2(v.y, u.y)]) {
      for (const t of [t0, t0 + Math.PI]) if (full || onSweep(t, a0, sw)) b = growBox(b, ellipsePoint(e, t));
    }
    return b;
  }
  const pls = tessellate(e, doc, 0);
  let b = null;
  for (const pl of pls) for (const p of pl) b = growBox(b, p);
  return b;
}
export function growBox(b, p) {
  if (!b) return { minx: p.x, miny: p.y, maxx: p.x, maxy: p.y };
  if (p.x < b.minx) b.minx = p.x; if (p.x > b.maxx) b.maxx = p.x;
  if (p.y < b.miny) b.miny = p.y; if (p.y > b.maxy) b.maxy = p.y;
  return b;
}
export function boxOfPoints(pts) { let b = null; for (const p of pts) b = growBox(b, p); return b; }
export function unionBox(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  return { minx: Math.min(a.minx, b.minx), miny: Math.min(a.miny, b.miny), maxx: Math.max(a.maxx, b.maxx), maxy: Math.max(a.maxy, b.maxy) };
}
export function docExtents(doc) {
  let b = null;
  for (const e of doc.entities) {
    const l = doc.layers.get(e.layer);
    if (l && (!l.visible || l.frozen)) continue;
    b = unionBox(b, bboxOf(e, doc));
  }
  return b;
}

// ---- explode --------------------------------------------------------------------------------
/** INSERT/DIMENSION -> transformed copies of the block entities (one level; nested INSERTs stay INSERTs).
 *  LWPOLYLINE -> LINE/ARC entities. */
export function explode(e, doc) {
  if (e.type === 'LWPOLYLINE') {
    const out = [];
    const v = e.vertices;
    const n = e.closed ? v.length : v.length - 1;
    for (let i = 0; i < n; i++) {
      const p1 = v[i], p2 = v[(i + 1) % v.length];
      const common = { layer: e.layer, color: e.color, linetype: e.linetype, lineweight: e.lineweight, ltscale: e.ltscale };
      if (p1.bulge && Math.abs(p1.bulge) > 1e-12) {
        const a = bulgeToArc(p1, p2, p1.bulge);
        const ccw = a.sweep > 0;
        const a0 = a.a0, a1 = a.a0 + a.sweep;
        out.push({ id: 0, type: 'ARC', ...common, c: a.c, r: a.r, a0: normAngle(ccw ? a0 : a1) / DEG, a1: normAngle(ccw ? a1 : a0) / DEG });
      } else out.push({ id: 0, type: 'LINE', ...common, p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y } });
    }
    return out;
  }
  if (e.type !== 'INSERT' && e.type !== 'DIMENSION') return [];
  const blk = doc && doc.blocks.get(e.block);
  if (!blk) return [];
  const out = [];
  const cols = e.type === 'INSERT' ? Math.max(1, e.cols || 1) : 1;
  const rows = e.type === 'INSERT' ? Math.max(1, e.rows || 1) : 1;
  const sx = e.type === 'INSERT' ? e.sx ?? 1 : 1, sy = e.type === 'INSERT' ? e.sy ?? 1 : 1;
  const rot = e.type === 'INSERT' ? (e.rot || 0) * DEG : 0;
  const p = e.type === 'INSERT' ? e.p : { x: 0, y: 0 };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const off = { x: c * (e.colSp || 0), y: r * (e.rowSp || 0) };
      const m = compose(translation(p.x, p.y), compose(rotation(rot), compose(translation(off.x, off.y), compose(scaling(sx, sy), translation(-blk.base.x, -blk.base.y)))));
      for (const be0 of blk.entities) {
        // attribute definitions: only constant, visible ones are shown (as their value); ATTRIBs are added below
        const be = be0.attdef ? ((be0.attdef.flags & 3) === 2 ? { ...be0, attdef: undefined, text: be0.attdef.default } : null) : be0;
        if (!be) continue;
        const t = transformEntity(be, m);
        delete t.attdef;
        // BYBLOCK / layer "0" inheritance is resolved by the renderer through `parent`.
        t.parent = e;
        out.push(t);
      }
    }
  }
  // visible ATTRIBs become plain TEXT (they are already in the INSERT's own space)
  for (const at of e.attribs ?? []) if (!(at.attrib.flags & 1)) { const t = structuredClone(at); delete t.attrib; t.id = 0; t.parent = e; out.push(t); }
  return out;
}

// ---- transform ------------------------------------------------------------------------------
function linearAngle(m) { return Math.atan2(m[1], m[0]); }
/** Decompose the linear part into rot, sx, sy (L = R(rot) * S(sx, sy)); throws if it has shear. */
export function decompose(m) {
  const sx = Math.hypot(m[0], m[1]);
  const rot = Math.atan2(m[1], m[0]);
  const d = det(m);
  const sy = sx > EPS ? d / sx : 0;
  const dot = m[0] * m[2] + m[1] * m[3];
  if (Math.abs(dot) > 1e-6 * Math.max(sx * Math.hypot(m[2], m[3]), 1)) {
    const err = new Error('Transform would shear this object (non-uniform scale of a rotated block).');
    err.code = 'SHEAR';
    throw err;
  }
  return { rot, sx, sy };
}
/** Returns a transformed COPY (id kept). Throws Error{code:'SHEAR'} where the result cannot be represented. */
export function transformEntity(e, m) {
  const c = structuredClone(e);
  delete c.parent;
  const flip = det(m) < 0;
  const sim = isSimilarity(m);
  const s = matScale(m);
  switch (e.type) {
    case 'LINE': c.p1 = apply(m, e.p1); c.p2 = apply(m, e.p2); break;
    case 'POINT': c.p = apply(m, e.p); break;
    case 'SOLID': c.pts = e.pts.map((p) => apply(m, p)); break;
    case 'LEADER': c.pts = e.pts.map((p) => apply(m, p)); break;
    case 'MLEADER': return transformMLeader(e, (p) => apply(m, p));
    case 'SPLINE':
      c.ctrl = e.ctrl.map((p) => apply(m, p)); c.fit = (e.fit || []).map((p) => apply(m, p)); break;
    case 'CIRCLE':
      if (sim) { c.c = apply(m, e.c); c.r = e.r * s; } else return circleToEllipseTransformed(e, m);
      break;
    case 'ARC':
      if (sim) {
        const P0 = apply(m, ellipsePoint({ c: e.c, major: { x: e.r, y: 0 }, ratio: 1 }, e.a0 * DEG));
        const P1 = apply(m, ellipsePoint({ c: e.c, major: { x: e.r, y: 0 }, ratio: 1 }, e.a1 * DEG));
        c.c = apply(m, e.c); c.r = e.r * s;
        const first = flip ? P1 : P0, second = flip ? P0 : P1;
        c.a0 = normAngle(Math.atan2(first.y - c.c.y, first.x - c.c.x)) / DEG;
        c.a1 = normAngle(Math.atan2(second.y - c.c.y, second.x - c.c.x)) / DEG;
      } else return circleToEllipseTransformed(e, m);
      break;
    case 'ELLIPSE': return transformEllipse(e, m);
    case 'LWPOLYLINE': {
      const hasBulge = e.vertices.some((v) => v.bulge && Math.abs(v.bulge) > 1e-12);
      if (hasBulge && !sim) {
        c.vertices = polylinePoints(e, 0).map((p) => ({ ...apply(m, p), bulge: 0 }));
        if (e.closed) c.vertices.pop();
      } else {
        c.vertices = e.vertices.map((v) => ({ ...apply(m, v), bulge: flip ? -(v.bulge || 0) : v.bulge || 0 }));
      }
      break;
    }
    case 'TEXT': case 'MTEXT':
      c.p = apply(m, e.p); c.height = e.height * s; c.rot = ((e.rot || 0) + linearAngle(m) / DEG);
      if (det(m) < 0) {
        // mirrored: keep the text readable and not backwards (like MIRRTEXT = 0); only the insertion point is mirrored
        const a = (e.rot || 0) * DEG, v = applyVec(m, { x: Math.cos(a), y: Math.sin(a) });
        let r = (((Math.atan2(v.y, v.x) / DEG) % 360) + 360) % 360;
        if (r > 90 && r <= 270) r -= 180;
        c.rot = r;
      }
      if (e.type === 'MTEXT' && e.width) c.width = e.width * s;
      break;
    case 'HATCH':
      c.loops = e.loops.map((l) => {
        const pts = hatchLoopPoints(l, 0);
        return { closed: true, pts: pts.map((p) => ({ ...apply(m, p), bulge: 0 })) };
      });
      if (e.pattern !== 'SOLID') { c.scale = (e.scale || 1) * s; c.angle = (e.angle || 0) + linearAngle(m) / DEG; }
      break;
    case 'INSERT': {
      const rot = (e.rot || 0) * DEG;
      const Lins = compose([m[0], m[1], m[2], m[3], 0, 0], compose(rotation(rot), scaling(e.sx ?? 1, e.sy ?? 1)));
      const d = decompose(Lins);
      c.p = apply(m, e.p); c.rot = d.rot / DEG; c.sx = d.sx; c.sy = d.sy;
      // array spacing lives in the (rotated, unscaled) insert frame: carry the offsets through m into the new frame
      const toNew = compose(rotation(-d.rot), compose([m[0], m[1], m[2], m[3], 0, 0], rotation(rot)));
      c.colSp = applyVec(toNew, { x: e.colSp || 0, y: 0 }).x;
      c.rowSp = applyVec(toNew, { x: 0, y: e.rowSp || 0 }).y;
      if (e.attribs) c.attribs = e.attribs.map((at) => transformEntity(at, m));
      break;
    }
    case 'DIMENSION': {
      const d = decompose([m[0], m[1], m[2], m[3], 0, 0]);
      // A transformed dimension is no longer associative: it becomes an INSERT of its anonymous block.
      return { id: e.id, type: 'INSERT', layer: e.layer, color: e.color, linetype: e.linetype, lineweight: e.lineweight, ltscale: e.ltscale,
        block: e.block, p: apply(m, { x: 0, y: 0 }), sx: d.sx, sy: d.sy, rot: d.rot / DEG, cols: 1, rows: 1, colSp: 0, rowSp: 0 };
    }
    default: break;
  }
  return c;
}
function circleToEllipseTransformed(e, m) {
  const a0 = e.type === 'ARC' ? e.a0 * DEG : 0;
  const a1 = e.type === 'ARC' ? a0 + ccwSweep(e.a0 * DEG, e.a1 * DEG) : TAU;
  const ell = { id: e.id, type: 'ELLIPSE', layer: e.layer, color: e.color, linetype: e.linetype, lineweight: e.lineweight, ltscale: e.ltscale,
    c: { ...e.c }, major: { x: e.r, y: 0 }, ratio: 1, a0, a1 };
  return transformEllipse(ell, m);
}
function transformEllipse(e, m) {
  const { u, v } = ellipseAxes(e);
  const u2 = applyVec(m, u), v2 = applyVec(m, v);
  const t0 = 0.5 * Math.atan2(2 * (u2.x * v2.x + u2.y * v2.y), u2.x * u2.x + u2.y * u2.y - v2.x * v2.x - v2.y * v2.y);
  const M = { x: u2.x * Math.cos(t0) + v2.x * Math.sin(t0), y: u2.y * Math.cos(t0) + v2.y * Math.sin(t0) };
  const mi = { x: -u2.x * Math.sin(t0) + v2.x * Math.cos(t0), y: -u2.y * Math.sin(t0) + v2.y * Math.cos(t0) };
  let major = M, minor = mi;
  let a0 = (e.a0 ?? 0) - t0, a1 = (e.a1 ?? TAU) - t0;
  if (Math.hypot(minor.x, minor.y) > Math.hypot(major.x, major.y)) { // swap so `major` is the longer axis
    const nm = { x: -minor.x, y: -minor.y };
    major = minor; minor = { x: -M.x, y: -M.y };
    // rotate parameters by +90 deg: P(s) with axes (M, m) == axes (m, -M) at s - 90 deg
    a0 -= Math.PI / 2; a1 -= Math.PI / 2; void nm;
  }
  const ratio = Math.hypot(minor.x, minor.y) / Math.hypot(major.x, major.y);
  const ccwMinor = -major.y * ratio * minor.x + major.x * ratio * minor.y > 0; // minor == +rot90(major)*ratio ?
  if (!ccwMinor) { const t = a0; a0 = -a1; a1 = -t; }
  const full = Math.abs((e.a1 ?? TAU) - (e.a0 ?? 0)) >= TAU - 1e-9;
  if (full) { a0 = 0; a1 = TAU; } else { a0 = normAngle(a0); a1 = a0 + ccwSweep(a0, normAngle(a1)); if (a1 > TAU + 1e-9) { a0 -= TAU; a1 -= TAU; } }
  const out = structuredClone(e);
  out.c = apply(m, e.c); out.major = major; out.ratio = ratio; out.a0 = a0; out.a1 = a1;
  return out;
}

// ---- primitives, distance, snapping ---------------------------------------------------------
// Primitive: {k:'seg', a, b} | {k:'arc', c, r, a0, sweep}  (radians; sweep > 0 CCW)
export function toPrims(e, doc = null) {
  switch (e.type) {
    case 'LINE': return [{ k: 'seg', a: e.p1, b: e.p2 }];
    case 'CIRCLE': return [{ k: 'arc', c: e.c, r: e.r, a0: 0, sweep: TAU }];
    case 'ARC': return [{ k: 'arc', c: e.c, r: e.r, a0: e.a0 * DEG, sweep: ccwSweep(e.a0 * DEG, e.a1 * DEG) }];
    case 'LWPOLYLINE': {
      const out = [];
      const v = e.vertices, n = e.closed ? v.length : v.length - 1;
      for (let i = 0; i < n; i++) {
        const p1 = v[i], p2 = v[(i + 1) % v.length];
        if (p1.bulge && Math.abs(p1.bulge) > 1e-12 && dist(p1, p2) > EPS) {
          const a = bulgeToArc(p1, p2, p1.bulge);
          out.push(a.sweep > 0 ? { k: 'arc', c: a.c, r: a.r, a0: a.a0, sweep: a.sweep } : { k: 'arc', c: a.c, r: a.r, a0: a.a0 + a.sweep, sweep: -a.sweep });
        } else out.push({ k: 'seg', a: p1, b: p2 });
      }
      return out;
    }
    default: {
      const out = [];
      for (const pl of tessellate(e, doc, 0)) for (let i = 0; i + 1 < pl.length; i++) out.push({ k: 'seg', a: pl[i], b: pl[i + 1] });
      return out;
    }
  }
}
function segSegIntersect(a, b, c, d, infiniteAB = false, infiniteCD = false) {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  const tol = 1e-9;
  if (!infiniteAB && (t < -tol || t > 1 + tol)) return null;
  if (!infiniteCD && (u < -tol || u > 1 + tol)) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y, t, u };
}
function segArcIntersect(a, b, arc, infinite = false, arcFull = false) {
  const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - arc.c.x, fy = a.y - arc.c.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - arc.r * arc.r;
  const disc = B * B - 4 * A * C;
  if (A < EPS || disc < 0) return [];
  const sq = Math.sqrt(disc);
  const out = [];
  for (const t of disc < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (!infinite && (t < -1e-9 || t > 1 + 1e-9)) continue;
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    if (!arcFull && !onSweep(Math.atan2(p.y - arc.c.y, p.x - arc.c.x), arc.a0, arc.sweep)) continue;
    out.push({ ...p, t });
  }
  return out;
}
function arcArcIntersect(A, B) {
  const d = dist(A.c, B.c);
  if (d < EPS || d > A.r + B.r + 1e-9 || d < Math.abs(A.r - B.r) - 1e-9) return [];
  const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d);
  const h2 = A.r * A.r - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const ux = (B.c.x - A.c.x) / d, uy = (B.c.y - A.c.y) / d;
  const m = { x: A.c.x + a * ux, y: A.c.y + a * uy };
  const pts = h < 1e-9 ? [m] : [{ x: m.x - h * uy, y: m.y + h * ux }, { x: m.x + h * uy, y: m.y - h * ux }];
  return pts.filter((p) => onSweep(Math.atan2(p.y - A.c.y, p.x - A.c.x), A.a0, A.sweep) && onSweep(Math.atan2(p.y - B.c.y, p.x - B.c.x), B.a0, B.sweep));
}
function primIntersections(p, q) {
  if (p.k === 'seg' && q.k === 'seg') { const r = segSegIntersect(p.a, p.b, q.a, q.b); return r ? [r] : []; }
  if (p.k === 'seg' && q.k === 'arc') return segArcIntersect(p.a, p.b, q);
  if (p.k === 'arc' && q.k === 'seg') return segArcIntersect(q.a, q.b, p);
  return arcArcIntersect(p, q);
}
/** All intersection points {x,y} between two entities (real intersections only; no extension). */
export function intersections(e1, e2, doc = null) {
  const out = [];
  // a control-point spline against another spline or an ellipse: polyline crossings refined by Newton on both curves
  if ((e1.type === 'SPLINE' || e2.type === 'SPLINE') && SMOOTH.has(e1.type) && SMOOTH.has(e2.type)) {
    const a = smoothCurve(e1), b = a && smoothCurve(e2);
    if (a && b) return curveCurveHits(a, b).map((h) => ({ x: h.x, y: h.y }));
  }
  // ellipses and control-point splines against exact primitives: crossings refined on the exact curve
  const c1 = EXACT_PRIMS.has(e2.type) && exactCurve(e1), c2 = !c1 && EXACT_PRIMS.has(e1.type) && exactCurve(e2);
  if (c1 || c2) {
    for (const pr of toPrims(c1 ? e2 : e1)) for (const r of curveHits(c1 || c2, pr)) {
      if (!out.some((o) => Math.hypot(o.x - r.x, o.y - r.y) < 1e-7)) out.push({ x: r.x, y: r.y });
    }
    return out;
  }
  for (const p of toPrims(e1, doc)) for (const q of toPrims(e2, doc)) for (const r of primIntersections(p, q)) {
    if (!out.some((o) => Math.hypot(o.x - r.x, o.y - r.y) < 1e-7)) out.push({ x: r.x, y: r.y });
  }
  return out;
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 < EPS ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** Distance from point to entity outline (0 when inside text boxes / filled shapes). */
export function distanceToEntity(e, p, doc = null) {
  if (e.type === 'TEXT' || e.type === 'MTEXT') {
    const b = bboxOf(e, doc);
    if (!b) return Infinity;
    const dx = Math.max(b.minx - p.x, 0, p.x - b.maxx), dy = Math.max(b.miny - p.y, 0, p.y - b.maxy);
    return Math.hypot(dx, dy);
  }
  const pls = tessellate(e, doc, 0);
  if ((e.type === 'HATCH' && e.solid) || e.type === 'SOLID') for (const pl of pls) if (pl.length > 2 && pointInPoly(p, pl)) return 0;
  let best = Infinity;
  for (const pl of pls) {
    if (pl.length === 1) best = Math.min(best, dist(p, pl[0]));
    for (let i = 0; i + 1 < pl.length; i++) best = Math.min(best, distToSegment(p, pl[i], pl[i + 1]));
  }
  return best;
}
/** Nearest point on the entity outline to p. */
export function nearestPoint(e, p, doc = null) {
  let best = null, bd = Infinity;
  for (const pr of toPrims(e, doc)) {
    let q;
    if (pr.k === 'seg') {
      const dx = pr.b.x - pr.a.x, dy = pr.b.y - pr.a.y, l2 = dx * dx + dy * dy;
      const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - pr.a.x) * dx + (p.y - pr.a.y) * dy) / l2));
      q = { x: pr.a.x + t * dx, y: pr.a.y + t * dy };
    } else {
      const ang = Math.atan2(p.y - pr.c.y, p.x - pr.c.x);
      if (onSweep(ang, pr.a0, pr.sweep)) q = { x: pr.c.x + pr.r * Math.cos(ang), y: pr.c.y + pr.r * Math.sin(ang) };
      else {
        const s = { x: pr.c.x + pr.r * Math.cos(pr.a0), y: pr.c.y + pr.r * Math.sin(pr.a0) };
        const t = { x: pr.c.x + pr.r * Math.cos(pr.a0 + pr.sweep), y: pr.c.y + pr.r * Math.sin(pr.a0 + pr.sweep) };
        q = dist(p, s) < dist(p, t) ? s : t;
      }
    }
    const d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
/** Snap candidates for one entity: [{x,y,kind}] kind = end|mid|cen|quad|node|ins. */
export function snapPoints(e, doc = null) {
  const out = [];
  const add = (p, kind) => out.push({ x: p.x, y: p.y, kind });
  switch (e.type) {
    case 'LINE': add(e.p1, 'end'); add(e.p2, 'end'); add(mid(e.p1, e.p2), 'mid'); break;
    case 'LWPOLYLINE': {
      const v = e.vertices, n = e.closed ? v.length : v.length - 1;
      v.forEach((q) => add(q, 'end'));
      for (let i = 0; i < n; i++) {
        const p1 = v[i], p2 = v[(i + 1) % v.length];
        if (p1.bulge && Math.abs(p1.bulge) > 1e-12) {
          const a = bulgeToArc(p1, p2, p1.bulge);
          const am = a.a0 + a.sweep / 2;
          add({ x: a.c.x + a.r * Math.cos(am), y: a.c.y + a.r * Math.sin(am) }, 'mid');
        } else add(mid(p1, p2), 'mid');
      }
      break;
    }
    case 'CIRCLE':
      add(e.c, 'cen');
      for (let k = 0; k < 4; k++) add({ x: e.c.x + e.r * Math.cos((k * Math.PI) / 2), y: e.c.y + e.r * Math.sin((k * Math.PI) / 2) }, 'quad');
      break;
    case 'ARC': {
      add(e.c, 'cen');
      const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
      add({ x: e.c.x + e.r * Math.cos(a0), y: e.c.y + e.r * Math.sin(a0) }, 'end');
      add({ x: e.c.x + e.r * Math.cos(a0 + sw), y: e.c.y + e.r * Math.sin(a0 + sw) }, 'end');
      add({ x: e.c.x + e.r * Math.cos(a0 + sw / 2), y: e.c.y + e.r * Math.sin(a0 + sw / 2) }, 'mid');
      for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2; if (onSweep(a, a0, sw)) add({ x: e.c.x + e.r * Math.cos(a), y: e.c.y + e.r * Math.sin(a) }, 'quad'); }
      break;
    }
    case 'ELLIPSE': {
      add(e.c, 'cen');
      for (let k = 0; k < 4; k++) add(ellipsePoint(e, (k * Math.PI) / 2), 'quad');
      break;
    }
    case 'POINT': add(e.p, 'node'); break;
    case 'TEXT': case 'MTEXT': case 'INSERT': add(e.p, 'ins'); break;
    case 'SPLINE': { const pts = e.fit && e.fit.length ? e.fit : e.ctrl || []; if (pts.length) { add(pts[0], 'end'); add(pts[pts.length - 1], 'end'); } break; }
    case 'SOLID': e.pts.forEach((q) => add(q, 'end')); break;
    case 'LEADER': e.pts.forEach((q) => add(q, 'end')); break;
    case 'MLEADER': e.leaders.forEach((l) => l.lines.forEach((ln) => ln.length && add(ln[0], 'end'))); break;
    default: break;
  }
  return out;
}

// ---- polyline parameterisation (s = segment index + fraction; arc fractions are angle fractions) ----
const polar = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
const wrapPi = (a) => { a = normAngle(a); return a > Math.PI ? a - TAU : a; };
export function plSegs(e) {
  const v = e.vertices, n = v.length, m = e.closed ? n : n - 1, segs = [];
  for (let i = 0; i < m; i++) {
    const a = v[i], b = v[(i + 1) % n], bulge = a.bulge || 0;
    const arc = Math.abs(bulge) > 1e-12 && dist(a, b) > EPS ? bulgeToArc(a, b, bulge) : null;
    segs.push({ a, b, bulge, arc, len: arc ? Math.abs(arc.sweep) * arc.r : dist(a, b) });
  }
  return segs;
}
export function segPoint(sg, f) {
  if (!sg.arc) return { x: sg.a.x + (sg.b.x - sg.a.x) * f, y: sg.a.y + (sg.b.y - sg.a.y) * f };
  if (f <= 0) return { x: sg.a.x, y: sg.a.y };
  if (f >= 1) return { x: sg.b.x, y: sg.b.y };
  return polar(sg.arc.c, sg.arc.r, sg.arc.a0 + sg.arc.sweep * f);
}
export function segParam(sg, p) {
  if (!sg.arc) {
    const dx = sg.b.x - sg.a.x, dy = sg.b.y - sg.a.y, l2 = dx * dx + dy * dy;
    return l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - sg.a.x) * dx + (p.y - sg.a.y) * dy) / l2));
  }
  const { c, a0, sweep } = sg.arc, sw = Math.abs(sweep), t = Math.atan2(p.y - c.y, p.x - c.x);
  const rel = sweep > 0 ? normAngle(t - a0) : normAngle(a0 - t);
  if (rel <= sw) return rel / sw;
  return rel - sw < TAU - rel ? 1 : 0;
}
export function plParamOf(segs, p) {
  let best = 0, bd = Infinity;
  segs.forEach((sg, i) => { const f = segParam(sg, p), d = dist(segPoint(sg, f), p); if (d < bd - 1e-12) { bd = d; best = i + f; } });
  return best;
}
export function plSegAt(segs, s) {
  const m = segs.length;
  let i = Math.floor(s + 1e-12);
  let f = s - i;
  if (i >= m) { i = m - 1; f = 1; }
  if (f < 0) f = 0;
  return { sg: segs[((i % m) + m) % m], f, i };
}
/** Vertices of the open piece from s0 to s1 (s0 < s1; for closed polylines s1 may exceed the segment count). */
export function plSlice(segs, s0, s1) {
  const m = segs.length, out = [];
  let s = s0;
  while (s < s1 - 1e-12) {
    const i = Math.floor(s + 1e-12), f0 = Math.max(0, s - i), e = Math.min(s1, i + 1), f1 = e - i;
    const sg = segs[i % m];
    out.push({ ...segPoint(sg, f0), bulge: sg.arc ? Math.tan((sg.arc.sweep * (f1 - f0)) / 4) : 0 });
    s = e;
  }
  const end = s1 >= m ? (s1 - m * Math.floor((s1 - 1e-12) / m)) : s1;
  const { sg, f } = plSegAt(segs, end);
  out.push({ ...segPoint(sg, f), bulge: 0 });
  return out;
}

// ---- exact curves (ELLIPSE, control-point SPLINE) for intersections with lines/arcs/polylines ----
const ellipseFull = (e) => Math.abs((e.a1 ?? TAU) - (e.a0 ?? 0)) >= TAU - 1e-9;
/** Parameter of a point on the ellipse (atan2 in the axis frame). */
function ellipseParam(e, p) {
  const { u, v } = ellipseAxes(e), dx = p.x - e.c.x, dy = p.y - e.c.y;
  return Math.atan2((dx * v.x + dy * v.y) / (v.x * v.x + v.y * v.y), (dx * u.x + dy * u.y) / (u.x * u.x + u.y * u.y));
}
function exactCurve(e) {
  if (e.type === 'ELLIPSE') {
    const t0 = ellipseFull(e) ? 0 : normAngle(e.a0), sw = ellipseFull(e) ? TAU : ccwSweep(t0, normAngle(e.a1));
    return { at: (t) => ellipsePoint(e, t), t0, t1: t0 + sw, n: Math.max(16, Math.ceil((256 * sw) / TAU)) };
  }
  if (e.type === 'SPLINE') {
    const ctrl = e.ctrl;
    if (!ctrl || ctrl.length < 2) return null; // fit-point-only splines: tessellation
    let degree = e.degree || 3, knots = e.knots;
    if (ctrl.length <= degree) degree = ctrl.length - 1;
    if (!knots || knots.length !== ctrl.length + degree + 1) knots = clampedKnots(ctrl.length, degree);
    const t0 = knots[degree], t1 = knots[ctrl.length];
    if (!(t1 > t0)) return null;
    return { at: (t) => deBoor(ctrl, knots, e.weights, degree, Math.min(t, t1)), t0, t1, n: Math.min(4000, Math.max(64, ctrl.length * 32)) };
  }
  return null;
}
function rootIllinois(g, a, b, fa, fb) {
  let side = 0, c = a;
  for (let k = 0; k < 200; k++) {
    c = (a * fb - b * fa) / (fb - fa);
    const fc = g(c);
    if (fc === 0 || Math.abs(b - a) <= 1e-15 * (1 + Math.abs(c))) return c;
    if (fc * fb > 0) { b = c; fb = fc; if (side === -1) fa /= 2; side = -1; } else { a = c; fa = fc; if (side === 1) fb /= 2; side = 1; }
  }
  return c;
}
/** Sign-change crossings of exact curve `cv` with primitive `pr` (bounded unless `full`): [{x,y,t}].
 *  Tangential touches without a sign change between samples are not reported. */
function curveHits(cv, pr, full = false) {
  const L = pr.k === 'seg' ? dist(pr.a, pr.b) || 1 : 1;
  const f = pr.k === 'seg'
    ? (p) => ((pr.b.x - pr.a.x) * (p.y - pr.a.y) - (pr.b.y - pr.a.y) * (p.x - pr.a.x)) / L
    : (p) => Math.hypot(p.x - pr.c.x, p.y - pr.c.y) - pr.r;
  const g = (t) => f(cv.at(t));
  const out = [];
  let ta = cv.t0, fa = g(ta);
  for (let i = 1; i <= cv.n; i++) {
    const tb = cv.t0 + ((cv.t1 - cv.t0) * i) / cv.n, fb = g(tb);
    const roots = [];
    if (fa === 0) roots.push(ta); else if (fa * fb < 0) roots.push(rootIllinois(g, ta, tb, fa, fb));
    if (i === cv.n && fb === 0) roots.push(tb);
    for (const t of roots) {
      const p = cv.at(t);
      let ok = true;
      if (!full && pr.k === 'seg') { const u = ((p.x - pr.a.x) * (pr.b.x - pr.a.x) + (p.y - pr.a.y) * (pr.b.y - pr.a.y)) / (L * L); ok = u >= -1e-9 && u <= 1 + 1e-9; }
      else if (!full) ok = onSweep(Math.atan2(p.y - pr.c.y, p.x - pr.c.x), pr.a0, pr.sweep);
      if (ok && !out.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < 1e-9)) out.push({ x: p.x, y: p.y, t });
    }
    ta = tb; fa = fb;
  }
  return out;
}
const EXACT_PRIMS = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE']);
const SMOOTH = new Set(['SPLINE', 'ELLIPSE']);
/** Curve adaptor with a derivative {at, d1, t0, t1, n} for a control-point SPLINE or an ELLIPSE (else null). */
function smoothCurve(e, fitToo = false) {
  if (e.type === 'SPLINE') { const nu = (fitToo || (e.ctrl && e.ctrl.length >= 2)) && nurbsOf(e); return nu ? curveOfNurbs(nu) : null; }
  const cv = exactCurve(e);
  if (cv && e.type === 'ELLIPSE') { const { u, v } = ellipseAxes(e); cv.d1 = (t) => ({ x: -u.x * Math.sin(t) + v.x * Math.cos(t), y: -u.y * Math.sin(t) + v.y * Math.cos(t) }); }
  return cv;
}
/** Crossings of spline `nu` with entity `cu`: [{x, y, t}] with t the spline parameter. */
function splineHits(nu, cu, doc) {
  const A = curveOfNurbs(nu), out = [];
  const add = (h) => { if (!out.some((o) => Math.abs(o.t - h.t) <= 1e-12 * (1 + Math.abs(h.t)) || Math.hypot(o.x - h.x, o.y - h.y) < 1e-9)) out.push({ x: h.x, y: h.y, t: h.t }); };
  const B = SMOOTH.has(cu.type) ? smoothCurve(cu, true) : null;
  if (B) curveCurveHits(A, B).forEach(add);
  else for (const pr of toPrims(cu, doc)) curveHits(A, pr).forEach(add);
  return out;
}
/** Exact SPLINE piece of `e` from parameter a to b (closed splines: b may run past the end, through the seam). */
export function splinePiece(e, a, b) {
  const nu = nurbsOf(e);
  return splineEntity(e, nurbsSlice(nu, a, b));
}
/** Parameter of the point of SPLINE `e` nearest p, its domain and whether it is closed. */
export function splineParam(e, p) {
  const nu = nurbsOf(e);
  if (!nu) return null;
  const [t0, t1] = domain(nu);
  return { t: nearestParam(nu, p), t0, t1, closed: isClosed(nu) };
}

// ---- offset / trim / extend -----------------------------------------------------------------
const PROPS = ['layer', 'color', 'linetype', 'lineweight', 'ltscale'];
function polylineLike(src, vertices, closed) {
  const o = { id: 0, type: 'LWPOLYLINE' };
  for (const k of PROPS) if (src[k] !== undefined) o[k] = structuredClone(src[k]);
  return { ...o, vertices, closed };
}
/** Offset by `d` (>0) to the side of `sidePt`. Supports LINE, CIRCLE, ARC, LWPOLYLINE (with arc segments) and ELLIPSE
 *  (-> LWPOLYLINE through exact normal-offset points, chord error <= 1e-4 x major radius).
 *  Throws Error{code:'UNSUPPORTED'} otherwise. Returns a new entity (id 0). */
export function offsetEntity(e, d, sidePt) {
  const c = structuredClone(e); c.id = 0; delete c.parent;
  if (e.type === 'LINE') {
    const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y, l = Math.hypot(dx, dy);
    if (l < EPS) throw unsupported('zero-length line');
    let nx = -dy / l, ny = dx / l;
    if ((sidePt.x - e.p1.x) * nx + (sidePt.y - e.p1.y) * ny < 0) { nx = -nx; ny = -ny; }
    c.p1 = { x: e.p1.x + nx * d, y: e.p1.y + ny * d }; c.p2 = { x: e.p2.x + nx * d, y: e.p2.y + ny * d };
    return c;
  }
  if (e.type === 'CIRCLE' || e.type === 'ARC') {
    const outside = dist(sidePt, e.c) > e.r;
    const r = outside ? e.r + d : e.r - d;
    if (!(r > 0)) throw unsupported('offset radius would be zero or negative');
    c.r = r; return c;
  }
  if (e.type === 'LWPOLYLINE') { c.vertices = offsetPolyline(e, d, sidePt); return c; }
  if (e.type === 'ELLIPSE') return offsetEllipse(e, d, sidePt);
  if (e.type === 'SPLINE') return offsetSpline(e, d, sidePt);
  throw unsupported(`offset of ${e.type}`);
}
// SPLINE -> cubic SPLINE interpolating exact normal-offset points, refined until the deviation from the true offset is
// <= 1e-6 x (curve size + d). Closed splines: inside / outside decides (as polylines); open: the side of the nearest point.
function offsetSpline(e, d, sidePt) {
  const nu = nurbsOf(e);
  if (!nu) throw unsupported('spline without control or fit points');
  const closed = isClosed(nu), pl = tessellate(e)[0] || [];
  let s;
  if (closed) {
    let area = 0;
    for (let i = 0; i + 1 < pl.length; i++) area += pl[i].x * pl[i + 1].y - pl[i + 1].x * pl[i].y;
    s = pointInPoly(sidePt, pl) === area > 0 ? d : -d;
  } else {
    const { p, d1 } = derivsAt(nu, nearestParam(nu, sidePt));
    s = d1.x * (sidePt.y - p.y) - d1.y * (sidePt.x - p.x) >= 0 ? d : -d;
  }
  const b = boxOfPoints(pl), size = b ? Math.hypot(b.maxx - b.minx, b.maxy - b.miny) : 0;
  const o = splineEntity(e, offsetNurbs(nu, s, 1e-6 * (size + d)), closed);
  o.id = 0;
  return o;
}
function unsupported(msg) { const err = new Error(`Not supported yet: ${msg}`); err.code = 'UNSUPPORTED'; return err; }

// Each segment is offset on its own (arcs: radius r -/+ s, same centre and angles); arcs whose radius collapses are
// dropped. Neighbours are joined at the intersection of their extended curves nearest the shared vertex (AutoCAD
// OFFSETGAPTYPE 0); a pair that does not intersect is joined by a straight segment. A segment that the joins reverse
// is dropped and its neighbours re-joined.
function offsetPolyline(e, d, sidePt) {
  const segs = plSegs(e).filter((sg) => sg.len > EPS);
  if (!segs.length || (e.closed && segs.length < 2)) throw unsupported('polyline too short');
  let s;
  if (e.closed) { // inside/outside decides; left of a CCW loop is inside
    const pl = polylinePoints(e);
    let area = 0;
    for (let i = 0; i + 1 < pl.length; i++) area += pl[i].x * pl[i + 1].y - pl[i + 1].x * pl[i].y;
    s = pointInPoly(sidePt, pl) === area > 0 ? d : -d;
  } else {
    let best = null;
    for (const sg of segs) { const f = segParam(sg, sidePt), q = segPoint(sg, f), dd = dist(q, sidePt); if (!best || dd < best.dd) best = { sg, f, q, dd }; }
    const { sg, f, q } = best;
    const t = sg.arc ? ((a) => ({ x: -Math.sin(a) * Math.sign(sg.arc.sweep), y: Math.cos(a) * Math.sign(sg.arc.sweep) }))(sg.arc.a0 + sg.arc.sweep * f) : { x: sg.b.x - sg.a.x, y: sg.b.y - sg.a.y };
    s = t.x * (sidePt.y - q.y) - t.y * (sidePt.x - q.x) >= 0 ? d : -d;
  }
  const tolC = 1e-9 * (1 + d + segs.reduce((m, sg) => Math.max(m, Math.abs(sg.a.x), Math.abs(sg.a.y)), 0));
  const list = [];
  for (const sg of segs) { // offset to the left by s
    if (!sg.arc) {
      const nx = (-(sg.b.y - sg.a.y) / sg.len) * s, ny = ((sg.b.x - sg.a.x) / sg.len) * s;
      list.push({ k: 'seg', a: { x: sg.a.x + nx, y: sg.a.y + ny }, b: { x: sg.b.x + nx, y: sg.b.y + ny } });
    } else {
      const { c, r, a0, sweep } = sg.arc, r2 = sweep > 0 ? r - s : r + s;
      if (r2 > tolC) list.push({ k: 'arc', c, r: r2, a0, sweep, a: polar(c, r2, a0), b: polar(c, r2, a0 + sweep) });
    }
  }
  const joinAt = (A, B) => {
    const g = mid(A.b, B.a);
    if (dist(A.b, B.a) < tolC) return { p: g };
    let cands;
    if (A.k === 'seg' && B.k === 'seg') { const ip = segSegIntersect(A.a, A.b, B.a, B.b, true, true); cands = ip ? [ip] : []; }
    else if (A.k === 'seg') cands = segArcIntersect(A.a, A.b, B, true, true);
    else if (B.k === 'seg') cands = segArcIntersect(B.a, B.b, A, true, true);
    else cands = arcArcIntersect({ ...A, a0: 0, sweep: TAU }, { ...B, a0: 0, sweep: TAU });
    let best = null;
    for (const q of cands) { const dd = dist(q, g); if (!best || dd < best.dd) best = { p: { x: q.x, y: q.y }, dd }; }
    return best ? { p: best.p } : { p1: { ...A.b }, p2: { ...B.a } };
  };
  for (let guard = 0; guard <= segs.length; guard++) {
    const m = list.length;
    if (m === 0 || (e.closed && m < 2)) break;
    const J = [];
    for (let i = 0; i < m; i++) J.push(i === 0 && !e.closed ? { p: { ...list[0].a } } : joinAt(list[(i - 1 + m) % m], list[i]));
    if (!e.closed) J.push({ p: { ...list[m - 1].b } });
    const endJ = (i) => J[e.closed ? (i + 1) % m : i + 1];
    const st = (i) => J[i].p || J[i].p2, en = (i) => endJ(i).p || endJ(i).p1;
    const sw = [];
    let bad = -1;
    for (let i = 0; i < m && bad < 0; i++) {
      const A = list[i], p0 = st(i), p1 = en(i);
      if (A.k === 'seg') { if ((p1.x - p0.x) * (A.b.x - A.a.x) + (p1.y - p0.y) * (A.b.y - A.a.y) <= 0) bad = i; continue; }
      const t0 = A.a0 + wrapPi(Math.atan2(p0.y - A.c.y, p0.x - A.c.x) - A.a0);
      const t1 = A.a0 + A.sweep + wrapPi(Math.atan2(p1.y - A.c.y, p1.x - A.c.x) - (A.a0 + A.sweep));
      sw[i] = t1 - t0;
      if (!(sw[i] * Math.sign(A.sweep) > 1e-12) || Math.abs(sw[i]) >= TAU) bad = i;
    }
    if (bad >= 0 && (m > 1 || e.closed)) { list.splice(bad, 1); continue; }
    const out = [];
    for (let i = 0; i < m; i++) {
      const p = st(i);
      out.push({ x: p.x, y: p.y, bulge: list[i].k === 'arc' ? Math.tan(sw[i] / 4) : 0 });
      const ej = endJ(i);
      if (ej.p1) out.push({ x: ej.p1.x, y: ej.p1.y, bulge: 0 });
    }
    if (!e.closed) out.push({ x: J[m].p.x, y: J[m].p.y, bulge: 0 });
    return out;
  }
  throw unsupported('offset distance too large for this polyline');
}
function offsetEllipse(e, d, sidePt) {
  const { u, v } = ellipseAxes(e), a = Math.hypot(u.x, u.y), b = Math.hypot(v.x, v.y);
  const dx = sidePt.x - e.c.x, dy = sidePt.y - e.c.y;
  const X = (dx * u.x + dy * u.y) / (a * a), Y = (dx * v.x + dy * v.y) / (b * b);
  const s = X * X + Y * Y > 1 ? d : -d; // along the outward normal
  if (s < 0 && d >= Math.min(a, b)) throw unsupported('offset distance would collapse the ellipse');
  const Q = (t) => {
    const p = ellipsePoint(e, t), tx = -u.x * Math.sin(t) + v.x * Math.cos(t), ty = -u.y * Math.sin(t) + v.y * Math.cos(t), l = Math.hypot(tx, ty);
    return { x: p.x + (s * ty) / l, y: p.y - (s * tx) / l };
  };
  const cv = exactCurve(e), tol = 1e-4 * Math.max(a, b), pts = [];
  const rec = (t0, p0, t1, p1, depth) => {
    const tm = (t0 + t1) / 2, pm = Q(tm);
    if (depth < 20 && distToSegment(pm, p0, p1) > tol) { rec(t0, p0, tm, pm, depth + 1); pts.push(pm); rec(tm, pm, t1, p1, depth + 1); }
  };
  const N = 16;
  let tPrev = cv.t0, pPrev = Q(tPrev);
  pts.push(pPrev);
  for (let i = 1; i <= N; i++) {
    const t = cv.t0 + ((cv.t1 - cv.t0) * i) / N, p = Q(t);
    rec(tPrev, pPrev, t, p, 0); pts.push(p); tPrev = t; pPrev = p;
  }
  const full = ellipseFull(e);
  if (full) pts.pop();
  return polylineLike(e, pts.map((p) => ({ x: p.x, y: p.y, bulge: 0 })), full);
}

/** Trim a LINE / ARC / CIRCLE / LWPOLYLINE / ELLIPSE at the cutting edges, removing the part under `pick`.
 *  Returns {replace: [entities...]} (0, 1 or 2 pieces; ids 0 except the first keeps e.id) or null if nothing to trim. */
export function trimEntity(e, cutters, pick, doc = null) {
  const nu = e.type === 'SPLINE' ? nurbsOf(e) : null;
  if (e.type === 'SPLINE' && !nu) throw unsupported('trim of a spline without control or fit points');
  const pts = [];
  for (const cu of cutters) for (const p of nu ? splineHits(nu, cu, doc) : intersections(e, cu, doc)) pts.push(p);
  if (!pts.length) return null;
  const base = structuredClone(e); delete base.parent;
  if (e.type === 'LINE') {
    const d = { x: e.p2.x - e.p1.x, y: e.p2.y - e.p1.y }, l2 = d.x * d.x + d.y * d.y;
    const par = (p) => ((p.x - e.p1.x) * d.x + (p.y - e.p1.y) * d.y) / l2;
    const ts = pts.map(par).filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((a, b) => a - b);
    const tp = par(pick);
    const lo = [...ts.filter((t) => t <= tp)].pop() ?? 0, hi = ts.find((t) => t > tp) ?? 1;
    if (ts.length === 0) return { replace: [] }; // fully covered: remove
    const at = (t) => ({ x: e.p1.x + t * d.x, y: e.p1.y + t * d.y });
    const out = [];
    if (lo > 1e-9) out.push({ ...base, p1: { ...e.p1 }, p2: at(lo) });
    if (hi < 1 - 1e-9) out.push({ ...base, id: out.length ? 0 : e.id, p1: at(hi), p2: { ...e.p2 } });
    if (out.length) out[0].id = e.id;
    return { replace: out };
  }
  // Curves trimmed by parameter: rel(p) in [0, sw) from the start; closed curves need two cutting points.
  const byParam = (rel, sw, closed, piece) => {
    let ts = pts.map(rel).map((t) => (closed && t >= sw - 1e-9 ? 0 : t)).filter((t) => (closed ? true : t > 1e-9 && t < sw - 1e-9)).sort((a, b) => a - b);
    ts = ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-9);
    const tp = rel(pick);
    if (closed) {
      if (ts.length < 2) return null;
      const lo = [...ts.filter((t) => t <= tp)].pop() ?? ts[ts.length - 1] - sw, hi = ts.find((t) => t > tp) ?? ts[0] + sw;
      return { replace: [{ ...piece(hi, lo + sw), id: e.id }] };
    }
    if (!ts.length) return { replace: [] };
    const lo = [...ts.filter((t) => t <= tp)].pop() ?? 0, hi = ts.find((t) => t > tp) ?? sw;
    const out = [];
    if (lo > 1e-9) out.push(piece(0, lo));
    if (hi < sw - 1e-9) out.push({ ...piece(hi, sw), id: 0 });
    if (out.length) out[0].id = e.id;
    return { replace: out };
  };
  if (e.type === 'ARC' || e.type === 'CIRCLE') {
    const a0 = e.type === 'ARC' ? e.a0 * DEG : 0, sw = e.type === 'ARC' ? ccwSweep(e.a0 * DEG, e.a1 * DEG) : TAU;
    const rel = (p) => normAngle(Math.atan2(p.y - e.c.y, p.x - e.c.x) - a0);
    if (e.type === 'CIRCLE') return byParam(rel, TAU, true, (r0, r1) => ({ ...base, type: 'ARC', a0: normAngle(a0 + r0) / DEG, a1: normAngle(a0 + r1) / DEG }));
    return byParam(rel, sw, false, (r0, r1) => ({ ...base, a0: r0 > 0 ? normAngle(a0 + r0) / DEG : e.a0, a1: r1 < sw ? normAngle(a0 + r1) / DEG : e.a1 }));
  }
  if (e.type === 'ELLIPSE') {
    const full = ellipseFull(e), a0 = full ? normAngle(e.a0 ?? 0) : normAngle(e.a0), sw = full ? TAU : ccwSweep(a0, normAngle(e.a1));
    const rel = (p) => normAngle(ellipseParam(e, p) - a0);
    return byParam(rel, sw, full, (r0, r1) => ({ ...base, a0: normAngle(a0 + r0), a1: normAngle(a0 + r1) }));
  }
  if (nu) { // split exactly by knot insertion; a closed spline keeps the piece across its seam as one open spline
    const [t0, t1] = domain(nu);
    return byParam((p) => (p.t ?? nearestParam(nu, p)) - t0, t1 - t0, isClosed(nu), (r0, r1) => splineEntity(base, nurbsSlice(nu, t0 + r0, t0 + r1)));
  }
  if (e.type === 'LWPOLYLINE') {
    const segs = plSegs(e);
    return byParam((p) => plParamOf(segs, p), segs.length, !!e.closed, (s0, s1) => ({ ...base, closed: false, vertices: plSlice(segs, s0, s1) }));
  }
  throw unsupported(`trim of ${e.type}`);
}
/** Extend the end of a LINE / ARC / open LWPOLYLINE / elliptical arc nearest `pick` up to the first boundary.
 *  Returns the new entity or null. */
export function extendEntity(e, boundaries, pick) {
  const c = structuredClone(e); delete c.parent;
  const hitsOn = (ent) => { const out = []; for (const bd of boundaries) for (const h of intersections(ent, bd)) out.push(h); return out; };
  const rayHit = (a, b) => { // first boundary hit beyond b on the ray a -> b
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    if (L < EPS) return null;
    let best = null;
    for (const h of hitsOn({ type: 'LINE', p1: b, p2: { x: b.x + (dx / L) * 1e7, y: b.y + (dy / L) * 1e7 } })) {
      const t = Math.hypot(h.x - b.x, h.y - b.y);
      if (t > 1e-9 && (!best || t < best.t)) best = { x: h.x, y: h.y, t };
    }
    return best && { x: best.x, y: best.y };
  };
  // growth (radians, > 0) needed to reach each hit on the full curve, the nearest one wins
  const nearestGrow = (hits, growOf, maxGrow) => {
    let best = null;
    for (const h of hits) { const g = growOf(h); if (g > 1e-9 && g < maxGrow && (!best || g < best.g)) best = { h, g }; }
    return best;
  };
  if (e.type === 'LINE') {
    const fromP1 = dist(pick, e.p1) < dist(pick, e.p2);
    const h = fromP1 ? rayHit(e.p2, e.p1) : rayHit(e.p1, e.p2);
    if (!h) return null;
    if (fromP1) c.p1 = h; else c.p2 = h;
    return c;
  }
  if (e.type === 'ARC') {
    const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
    const atStart = dist(pick, polar(e.c, e.r, a0)) < dist(pick, polar(e.c, e.r, a0 + sw));
    const best = nearestGrow(hitsOn({ type: 'CIRCLE', c: e.c, r: e.r }), (h) => {
      const ang = Math.atan2(h.y - e.c.y, h.x - e.c.x);
      return atStart ? normAngle(a0 - ang) : normAngle(ang - (a0 + sw));
    }, Infinity);
    if (!best) return null;
    const ang = normAngle(Math.atan2(best.h.y - e.c.y, best.h.x - e.c.x)) / DEG;
    if (atStart) c.a0 = ang; else c.a1 = ang;
    return c;
  }
  if (e.type === 'LWPOLYLINE') {
    if (e.closed) return null;
    const v = c.vertices, segs = plSegs(e), m = segs.length;
    if (!m) return null;
    const atStart = dist(pick, v[0]) < dist(pick, v[m]);
    const sg = atStart ? segs[0] : segs[m - 1];
    if (!sg.arc) {
      const h = atStart ? rayHit(sg.b, sg.a) : rayHit(sg.a, sg.b);
      if (!h) return null;
      const k = atStart ? 0 : m;
      v[k] = { ...v[k], x: h.x, y: h.y };
      return c;
    }
    const { c: cc, r, a0, sweep } = sg.arc, dir = Math.sign(sweep), end = atStart ? a0 : a0 + sweep;
    const best = nearestGrow(hitsOn({ type: 'CIRCLE', c: cc, r }), (h) => {
      const t = Math.atan2(h.y - cc.y, h.x - cc.x);
      return atStart ? normAngle(dir * (end - t)) : normAngle(dir * (t - end));
    }, TAU - Math.abs(sweep));
    if (!best) return null;
    const bulge = Math.tan((sweep + dir * best.g) / 4);
    if (atStart) v[0] = { ...v[0], x: best.h.x, y: best.h.y, bulge };
    else { v[m - 1] = { ...v[m - 1], bulge }; v[m] = { ...v[m], x: best.h.x, y: best.h.y }; }
    return c;
  }
  if (e.type === 'ELLIPSE') {
    if (ellipseFull(e)) return null;
    const a0 = normAngle(e.a0), sw = ccwSweep(a0, normAngle(e.a1));
    const atStart = dist(pick, ellipsePoint(e, a0)) < dist(pick, ellipsePoint(e, a0 + sw));
    const best = nearestGrow(hitsOn({ ...e, a0: 0, a1: TAU }), (h) => {
      const t = ellipseParam(e, h);
      return atStart ? normAngle(a0 - t) : normAngle(t - (a0 + sw));
    }, TAU - sw);
    if (!best) return null;
    const t = normAngle(ellipseParam(e, best.h));
    if (atStart) c.a0 = t; else c.a1 = t;
    return c;
  }
  if (e.type === 'SPLINE') { // straight extension along the end tangent; the original curve is kept exactly
    const nu0 = nurbsOf(e);
    if (!nu0 || isClosed(nu0)) return null;
    const [t0, t1] = domain(nu0), nu = subCurve(nu0, t0, t1); // clamped at both ends
    const s = derivsAt(nu, t0), f = derivsAt(nu, t1, true);
    const atStart = dist(pick, s.p) < dist(pick, f.p);
    const h = atStart ? rayHit({ x: s.p.x + s.d1.x, y: s.p.y + s.d1.y }, s.p) : rayHit({ x: f.p.x - f.d1.x, y: f.p.y - f.d1.y }, f.p);
    if (!h) return null;
    const L = Math.hypot(h.x - (atStart ? s.p.x : f.p.x), h.y - (atStart ? s.p.y : f.p.y));
    const nn = atStart
      ? joinCurves(lineNurbs(h, s.p, nu.p, t0 - L / Math.hypot(s.d1.x, s.d1.y), L / Math.hypot(s.d1.x, s.d1.y)), nu)
      : joinCurves(nu, lineNurbs(f.p, h, nu.p, t1, L / Math.hypot(f.d1.x, f.d1.y)));
    return splineEntity(c, nn);
  }
  throw unsupported(`extend of ${e.type}`);
}
