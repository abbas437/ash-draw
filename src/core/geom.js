// ASH Draw Studio - 2D geometry helpers over the drawing model (see model.js).
// Pure ES module. Matrices are canvas-style [a,b,c,d,e,f]:  x' = a*x + c*y + e ; y' = b*x + d*y + f.

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
      for (const be of blk.entities) {
        const t = transformEntity(be, m);
        // BYBLOCK / layer "0" inheritance is resolved by the renderer through `parent`.
        t.parent = e;
        out.push(t);
      }
    }
  }
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
      c.colSp = (e.colSp || 0); c.rowSp = (e.rowSp || 0);
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
    default: break;
  }
  return out;
}

// ---- offset / trim / extend -----------------------------------------------------------------
/** Offset by `d` (>0) to the side of `sidePt`. Supports LINE, CIRCLE, ARC, ELLIPSE-free; LWPOLYLINE made of straight segments.
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
  if (e.type === 'LWPOLYLINE') {
    if (e.vertices.some((v) => v.bulge && Math.abs(v.bulge) > 1e-12)) throw unsupported('offset of polylines containing arc segments');
    const v = e.vertices, n = v.length;
    if (n < 2) throw unsupported('polyline too short');
    const segN = e.closed ? n : n - 1;
    const normals = [];
    for (let i = 0; i < segN; i++) {
      const a = v[i], b = v[(i + 1) % n], l = dist(a, b) || 1;
      normals.push({ x: -(b.y - a.y) / l, y: (b.x - a.x) / l });
    }
    // side: use the nearest segment to decide the sign
    let bestI = 0, bd = Infinity;
    for (let i = 0; i < segN; i++) { const dd = distToSegment(sidePt, v[i], v[(i + 1) % n]); if (dd < bd) { bd = dd; bestI = i; } }
    const nb = normals[bestI], a0 = v[bestI];
    const sign = (sidePt.x - a0.x) * nb.x + (sidePt.y - a0.y) * nb.y >= 0 ? 1 : -1;
    const lines = normals.map((nn, i) => ({ a: { x: v[i].x + sign * nn.x * d, y: v[i].y + sign * nn.y * d }, b: { x: v[(i + 1) % n].x + sign * nn.x * d, y: v[(i + 1) % n].y + sign * nn.y * d } }));
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = i === 0 ? (e.closed ? lines[segN - 1] : null) : lines[i - 1];
      const next = i < segN ? lines[i] : null;
      if (!prev) out.push({ x: next.a.x, y: next.a.y, bulge: 0 });
      else if (!next) out.push({ x: prev.b.x, y: prev.b.y, bulge: 0 });
      else {
        const ip = segSegIntersect(prev.a, prev.b, next.a, next.b, true, true);
        out.push(ip ? { x: ip.x, y: ip.y, bulge: 0 } : { x: next.a.x, y: next.a.y, bulge: 0 });
      }
    }
    c.vertices = out; return c;
  }
  throw unsupported(`offset of ${e.type}`);
}
function unsupported(msg) { const err = new Error(`Not supported yet: ${msg}`); err.code = 'UNSUPPORTED'; return err; }

/** Trim a LINE / ARC / CIRCLE at the cutting edges, removing the part under `pick`.
 *  Returns {replace: [entities...]} (0, 1 or 2 pieces; ids 0 except the first keeps e.id) or null if nothing to trim. */
export function trimEntity(e, cutters, pick, doc = null) {
  const pts = [];
  for (const cu of cutters) for (const p of intersections(e, cu, doc)) pts.push(p);
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
  if (e.type === 'ARC' || e.type === 'CIRCLE') {
    const a0 = e.type === 'ARC' ? e.a0 * DEG : 0, sw = e.type === 'ARC' ? ccwSweep(e.a0 * DEG, e.a1 * DEG) : TAU;
    const rel = (p) => normAngle(Math.atan2(p.y - e.c.y, p.x - e.c.x) - a0);
    let ts = pts.map(rel).filter((t) => (e.type === 'CIRCLE' ? true : t > 1e-9 && t < sw - 1e-9)).sort((a, b) => a - b);
    ts = ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-9);
    const tp = rel(pick);
    if (e.type === 'CIRCLE') {
      if (ts.length < 2) return null; // need two cutting points to trim a circle
      const lo = [...ts.filter((t) => t <= tp)].pop() ?? ts[ts.length - 1], hi = ts.find((t) => t > tp) ?? ts[0];
      return { replace: [{ ...base, type: 'ARC', a0: normAngle(a0 + hi) / DEG, a1: normAngle(a0 + lo) / DEG }] };
    }
    if (!ts.length) return { replace: [] };
    const lo = [...ts.filter((t) => t <= tp)].pop() ?? 0, hi = ts.find((t) => t > tp) ?? sw;
    const out = [];
    if (lo > 1e-9) out.push({ ...base, a0: e.a0, a1: normAngle(a0 + lo) / DEG });
    if (hi < sw - 1e-9) out.push({ ...base, id: 0, a0: normAngle(a0 + hi) / DEG, a1: e.a1 });
    if (out.length) out[0].id = e.id;
    return { replace: out };
  }
  throw unsupported(`trim of ${e.type}`);
}
/** Extend the end of a LINE/ARC nearest `pick` up to the first boundary. Returns the new entity or null. */
export function extendEntity(e, boundaries, pick) {
  const c = structuredClone(e); delete c.parent;
  if (e.type === 'LINE') {
    const fromP1 = dist(pick, e.p1) < dist(pick, e.p2);
    const a = fromP1 ? e.p2 : e.p1, b = fromP1 ? e.p1 : e.p2; // extend b away from a
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    if (L < EPS) return null;
    let best = null;
    for (const bd of boundaries) for (const pr of toPrims(bd)) {
      const far = { x: b.x + (dx / L) * 1e7, y: b.y + (dy / L) * 1e7 };
      const hits = pr.k === 'seg' ? [segSegIntersect(b, far, pr.a, pr.b, false, false)].filter(Boolean) : segArcIntersect(b, far, pr);
      for (const h of hits) { const t = Math.hypot(h.x - b.x, h.y - b.y); if (t > 1e-9 && (!best || t < best.t)) best = { x: h.x, y: h.y, t }; }
    }
    if (!best) return null;
    if (fromP1) c.p1 = { x: best.x, y: best.y }; else c.p2 = { x: best.x, y: best.y };
    return c;
  }
  if (e.type === 'ARC') {
    const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
    const s = { x: e.c.x + e.r * Math.cos(a0), y: e.c.y + e.r * Math.sin(a0) };
    const t = { x: e.c.x + e.r * Math.cos(a0 + sw), y: e.c.y + e.r * Math.sin(a0 + sw) };
    const atStart = dist(pick, s) < dist(pick, t);
    let best = null;
    for (const bd of boundaries) for (const pr of toPrims(bd)) {
      const full = { k: 'arc', c: e.c, r: e.r, a0: 0, sweep: TAU };
      const pts = pr.k === 'seg' ? segArcIntersect(pr.a, pr.b, full, false, true) : arcArcIntersect(full, pr);
      for (const h of pts) {
        const ang = Math.atan2(h.y - e.c.y, h.x - e.c.x);
        const grow = atStart ? normAngle(a0 - ang) : normAngle(ang - (a0 + sw));
        if (grow > 1e-9 && (!best || grow < best.grow)) best = { ang, grow };
      }
    }
    if (!best) return null;
    if (atStart) c.a0 = normAngle(best.ang) / DEG; else c.a1 = normAngle(best.ang) / DEG;
    return c;
  }
  throw unsupported(`extend of ${e.type}`);
}
