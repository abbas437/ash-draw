// ASH Draw Studio - NURBS kernel for SPLINE editing (split, join, projection, intersections, offset fit).
// Pure ES module. A curve is { p, P, U, closed }: degree p, homogeneous control points P = [{x: w*x, y: w*y, w}],
// knot vector U (length P.length + p + 1); the domain is [U[p], U[P.length]] (same convention as geom.js tessellation).

const lerpH = (a, b, t) => ({ x: (1 - t) * a.x + t * b.x, y: (1 - t) * a.y + t * b.y, w: (1 - t) * a.w + t * b.w });
const hyp = (v) => Math.hypot(v.x, v.y);

export function clampedKnots(n, degree) {
  const k = [];
  for (let i = 0; i <= degree; i++) k.push(0);
  const inner = n - degree - 1;
  for (let i = 1; i <= inner; i++) k.push(i);
  for (let i = 0; i <= degree; i++) k.push(inner + 1);
  return k;
}
export const domain = (nu) => [nu.U[nu.p], nu.U[nu.P.length]];

/** NURBS of a SPLINE entity, or null. Control-point splines are taken as stored (degree / knot fallbacks as in
 *  geom.js); fit-point-only splines become the C2 cubic interpolating the fit points (chord-length parameters). */
export function nurbsOf(e) {
  let ctrl = e.ctrl, p = e.degree || 3, U = e.knots;
  if ((!ctrl || ctrl.length < 2) && e.fit && e.fit.length >= 2) return fitNurbs(e.fit, !!e.closed);
  if (!ctrl || ctrl.length < 2) return null;
  if (ctrl.length <= p) p = ctrl.length - 1;
  if (!U || U.length !== ctrl.length + p + 1) U = clampedKnots(ctrl.length, p);
  const W = e.weights && e.weights.length === ctrl.length ? e.weights : null;
  const P = ctrl.map((q, i) => { const w = W ? W[i] : 1; return { x: q.x * w, y: q.y * w, w }; });
  if (!(U[P.length] > U[p])) return null;
  return { p, P, U: U.slice(), closed: !!e.closed };
}

// ---- evaluation -----------------------------------------------------------------------------
/** Span k (U[k] <= t < U[k+1], inside [p, n-1]); `left` takes the span ending at t when t is a knot. */
function span(p, U, n, t, left) {
  if (t >= U[n]) { let k = n - 1; while (k > p && U[k] >= U[n]) k--; return k; }
  if (t <= U[p]) { let k = p; while (k < n - 1 && U[k + 1] <= U[p]) k++; return k; }
  let lo = p, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t < U[m]) hi = m; else lo = m; }
  if (left) while (lo > p && U[lo] >= t) lo--;
  return lo;
}
function deBoorH(Q, V, q, k, t) {
  if (q < 0) return { x: 0, y: 0, w: 0 };
  const d = [];
  for (let j = 0; j <= q; j++) { const c = Q[j + k - q]; d.push({ x: c.x, y: c.y, w: c.w }); }
  for (let r = 1; r <= q; r++) {
    for (let j = q; j >= r; j--) {
      const den = V[j + 1 + k - r] - V[j + k - q];
      d[j] = lerpH(d[j - 1], d[j], den === 0 ? 0 : (t - V[j + k - q]) / den);
    }
  }
  return d[q];
}
function derivNet(Q, V, q) { // control net of the derivative curve (degree q-1, knots V[1..-1])
  const out = [];
  for (let i = 0; i + 1 < Q.length; i++) {
    const den = V[i + q + 1] - V[i + 1], f = den === 0 ? 0 : q / den;
    out.push({ x: f * (Q[i + 1].x - Q[i].x), y: f * (Q[i + 1].y - Q[i].y), w: f * (Q[i + 1].w - Q[i].w) });
  }
  return { Q: out, V: V.slice(1, -1), q: q - 1 };
}
function nets(nu) {
  if (!nu._d) { const d1 = derivNet(nu.P, nu.U, nu.p); nu._d = [d1, derivNet(d1.Q, d1.V, d1.q)]; }
  return nu._d;
}
/** Point at t. */
export function pointAt(nu, t, left = false) {
  const k = span(nu.p, nu.U, nu.P.length, t, left), a = deBoorH(nu.P, nu.U, nu.p, k, t);
  return { x: a.x / a.w, y: a.y / a.w };
}
/** Point, first and second derivative at t (rational quotient rule). */
export function derivsAt(nu, t, left = false) {
  const k = span(nu.p, nu.U, nu.P.length, t, left), [d1, d2] = nets(nu);
  const A = deBoorH(nu.P, nu.U, nu.p, k, t);
  const A1 = d1.q >= 0 ? deBoorH(d1.Q, d1.V, d1.q, k - 1, t) : { x: 0, y: 0, w: 0 };
  const A2 = d2.q >= 0 ? deBoorH(d2.Q, d2.V, d2.q, k - 2, t) : { x: 0, y: 0, w: 0 };
  const c = { x: A.x / A.w, y: A.y / A.w };
  const c1 = { x: (A1.x - A1.w * c.x) / A.w, y: (A1.y - A1.w * c.y) / A.w };
  const c2 = { x: (A2.x - 2 * A1.w * c1.x - A2.w * c.x) / A.w, y: (A2.y - 2 * A1.w * c1.y - A2.w * c.y) / A.w };
  return { p: c, d1: c1, d2: c2 };
}
/** Curve adaptor {at, d1, t0, t1, n} used by the intersection code. */
export function curveOfNurbs(nu) {
  const [t0, t1] = domain(nu);
  return { at: (t) => pointAt(nu, t), d1: (t) => derivsAt(nu, t).d1, t0, t1, n: Math.min(4000, Math.max(64, nu.P.length * 32)), nu };
}
/** True when the curve's end meets its start (a closed flag on an open shape is ignored). */
export function isClosed(nu) {
  if (!nu.closed) return false;
  const [t0, t1] = domain(nu), a = pointAt(nu, t0), b = pointAt(nu, t1, true);
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9 * (1 + size(nu));
}
function size(nu) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of nu.P) { const x = q.x / q.w, y = q.y / q.w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return Math.hypot(x1 - x0, y1 - y0);
}

// ---- knot insertion, split, join -----------------------------------------------------------
function snapKnot(nu, u) {
  const [t0, t1] = domain(nu), tol = 1e-10 * (t1 - t0);
  for (const k of nu.U) if (Math.abs(k - u) <= tol) return k;
  return u;
}
const mult = (U, u) => U.reduce((m, k) => m + (k === u ? 1 : 0), 0);
/** Boehm knot insertion of u once (exact: the curve is unchanged). */
function insertOnce(nu, u) {
  const { p, P, U } = nu, n = P.length, s = mult(U, u);
  let k = U.length - 1;
  while (k > 0 && U[k] > u) k--;
  const Q = [];
  for (let i = 0; i <= k - p; i++) Q.push(P[i]);
  for (let i = k - p + 1; i <= k - s; i++) Q.push(lerpH(P[i - 1], P[i], (u - U[i]) / (U[i + p] - U[i])));
  for (let i = k - s; i < n; i++) Q.push(P[i]);
  return { p, P: Q, U: [...U.slice(0, k + 1), u, ...U.slice(k + 1)], closed: nu.closed };
}
function insertTo(nu, u, m) { let c = nu; for (let s = mult(c.U, u); s < m; s++) c = insertOnce(c, u); return c; }
/** Exact piece of the curve on [a, b] (t0 <= a < b <= t1), clamped at both ends; same parameterisation. */
export function subCurve(nu, a, b) {
  const p = nu.p;
  a = snapKnot(nu, a); let c = insertTo(nu, a, p);
  b = snapKnot(c, b); c = insertTo(c, b, p);
  const U = c.U;
  const La = U.lastIndexOf(a), Fb = U.indexOf(b);
  return {
    p, P: c.P.slice(La - p, Fb).map((q) => ({ ...q })),
    U: [...Array(p + 1).fill(a), ...U.slice(La + 1, Fb), ...Array(p + 1).fill(b)], closed: false,
  };
}
/** B appended to A (both clamped, same degree, A's end on B's start): exact, C0 joint, B's parameters shifted. */
export function joinCurves(A, B) {
  const p = A.p, shift = A.U[A.U.length - 1] - B.U[0], s = A.P[A.P.length - 1].w / B.P[0].w;
  return {
    p, closed: false,
    P: [...A.P, ...B.P.slice(1).map((q) => ({ x: q.x * s, y: q.y * s, w: q.w * s }))],
    U: [...A.U.slice(0, A.U.length - 1), ...B.U.slice(p + 1).map((u) => u + shift)],
  };
}
/** Straight segment a -> b as a degree-p Bezier on [u, u + du]. */
export function lineNurbs(a, b, p, u = 0, du = 1) {
  const P = [];
  for (let i = 0; i <= p; i++) P.push({ x: a.x + ((b.x - a.x) * i) / p, y: a.y + ((b.y - a.y) * i) / p, w: 1 });
  return { p, P, U: [...Array(p + 1).fill(u), ...Array(p + 1).fill(u + du)], closed: false };
}
/** Piece from a to b; on a closed curve b may run past t1 (the piece then wraps through the seam). */
export function slice(nu, a, b) {
  const [t0, t1] = domain(nu), per = t1 - t0;
  if (b <= t1 + 1e-12 * per) return subCurve(nu, a, Math.min(b, t1));
  const w = b - per;
  if (a >= t1 - 1e-12 * per) return subCurve(nu, t0, w);
  if (w <= t0 + 1e-12 * per) return subCurve(nu, a, t1);
  return joinCurves(subCurve(nu, a, t1), subCurve(nu, t0, w));
}
/** SPLINE entity for curve `nu`, keeping the properties of `src` (fit points dropped: they no longer apply). */
export function splineEntity(src, nu, closed = false) {
  const c = structuredClone(src); delete c.parent; delete c._d;
  const w0 = nu.P[0].w, rational = nu.P.some((q) => Math.abs(q.w / w0 - 1) > 1e-14);
  c.type = 'SPLINE'; c.degree = nu.p;
  c.ctrl = nu.P.map((q) => ({ x: q.x / q.w, y: q.y / q.w }));
  c.knots = nu.U.slice();
  c.weights = rational ? nu.P.map((q) => q.w / w0) : null;
  c.fit = []; c.closed = closed;
  return c;
}

// ---- projection -----------------------------------------------------------------------------
/** Parameter of the point of the curve nearest q (sampling + Newton). */
export function nearestParam(nu, q) {
  const [t0, t1] = domain(nu), N = Math.min(4000, Math.max(64, nu.P.length * 32));
  let best = t0, bd = Infinity;
  for (let i = 0; i <= N; i++) {
    const t = t0 + ((t1 - t0) * i) / N, c = pointAt(nu, t, i === N), d = Math.hypot(c.x - q.x, c.y - q.y);
    if (d < bd) { bd = d; best = t; }
  }
  let t = best;
  for (let it = 0; it < 30; it++) {
    const { p, d1, d2 } = derivsAt(nu, t), rx = p.x - q.x, ry = p.y - q.y;
    const g = d1.x * rx + d1.y * ry, gp = d2.x * rx + d2.y * ry + d1.x * d1.x + d1.y * d1.y;
    if (!(gp > 0)) break;
    const tn = Math.max(t0, Math.min(t1, t - g / gp));
    if (Math.abs(tn - t) <= 1e-15 * (1 + Math.abs(t))) { t = tn; break; }
    t = tn;
  }
  const dt = (u) => { const c = pointAt(nu, u, u === t1); return Math.hypot(c.x - q.x, c.y - q.y); };
  return dt(t) <= bd ? t : best;
}

// ---- curve / curve intersections -----------------------------------------------------------
/** Crossings of two curve adaptors {at, d1, t0, t1, n}: polyline crossings refined by 2-D Newton. [{x,y,t,s}] */
export function curveCurveHits(A, B) {
  const sample = (cv) => {
    const n = Math.min(cv.n, 1024), ts = [], ps = [];
    for (let i = 0; i <= n; i++) { const t = cv.t0 + ((cv.t1 - cv.t0) * i) / n; ts.push(t); ps.push(cv.at(Math.min(t, cv.t1))); }
    return { ts, ps };
  };
  const a = sample(A), b = sample(B), out = [];
  const box = (ps, i, j) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = i; k <= j; k++) { const q = ps[k]; if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    return [x0, y0, x1, y1];
  };
  const leaf = (i, j) => {
    const p = a.ps[i], q = a.ps[i + 1], c = b.ps[j], d = b.ps[j + 1];
    const r = { x: q.x - p.x, y: q.y - p.y }, s = { x: d.x - c.x, y: d.y - c.y }, den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-300) return;
    const u = ((c.x - p.x) * s.y - (c.y - p.y) * s.x) / den, v = ((c.x - p.x) * r.y - (c.y - p.y) * r.x) / den;
    if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) return;
    let t = a.ts[i] + u * (a.ts[i + 1] - a.ts[i]), w = b.ts[j] + v * (b.ts[j + 1] - b.ts[j]);
    let P = A.at(t), Q = B.at(w);
    for (let it = 0; it < 40; it++) {
      const fx = P.x - Q.x, fy = P.y - Q.y, da = A.d1(t), db = B.d1(w);
      const D = -da.x * db.y + db.x * da.y; // det [da, -db]
      if (Math.abs(D) < 1e-300) break;
      const dt = (-fx * db.y + db.x * fy) / D, dw = (da.x * fy - da.y * fx) / D;
      t = Math.max(A.t0, Math.min(A.t1, t - dt)); w = Math.max(B.t0, Math.min(B.t1, w - dw));
      P = A.at(t); Q = B.at(w);
      if (Math.abs(dt) <= 1e-15 * (1 + Math.abs(t)) && Math.abs(dw) <= 1e-15 * (1 + Math.abs(w))) break;
    }
    const scale = 1 + Math.abs(P.x) + Math.abs(P.y);
    if (Math.hypot(P.x - Q.x, P.y - Q.y) > 1e-9 * scale) return;
    if (!out.some((o) => Math.hypot(o.x - P.x, o.y - P.y) < 1e-9 * scale)) out.push({ x: P.x, y: P.y, t, s: w });
  };
  const rec = (i0, i1, j0, j1) => {
    const ba = box(a.ps, i0, i1), bb = box(b.ps, j0, j1), m = 1e-9 * (1 + Math.abs(ba[0]) + Math.abs(ba[1]));
    if (ba[0] > bb[2] + m || bb[0] > ba[2] + m || ba[1] > bb[3] + m || bb[1] > ba[3] + m) return;
    if (i1 - i0 === 1 && j1 - j0 === 1) { leaf(i0, j0); return; }
    if (i1 - i0 >= j1 - j0) { const im = (i0 + i1) >> 1; rec(i0, im, j0, j1); rec(im, i1, j0, j1); }
    else { const jm = (j0 + j1) >> 1; rec(i0, i1, j0, jm); rec(i0, i1, jm, j1); }
  };
  rec(0, a.ps.length - 1, 0, b.ps.length - 1);
  return out;
}

// ---- interpolation --------------------------------------------------------------------------
/** C2 cubic through points Q at parameters u (increasing) with end derivatives D0, Dn (P&T 9.2.2, tridiagonal). */
export function interpolateCubic(Q, u, D0, Dn) {
  const m = Q.length - 1, U = [u[0], u[0], u[0], u[0], ...u.slice(1, m), u[m], u[m], u[m], u[m]];
  const P = new Array(m + 3);
  P[0] = Q[0]; P[m + 2] = Q[m];
  P[1] = { x: Q[0].x + ((u[1] - u[0]) / 3) * D0.x, y: Q[0].y + ((u[1] - u[0]) / 3) * D0.y };
  P[m + 1] = { x: Q[m].x - ((u[m] - u[m - 1]) / 3) * Dn.x, y: Q[m].y - ((u[m] - u[m - 1]) / 3) * Dn.y };
  if (m >= 2) { // unknowns P[2..m]; row k (k = 1..m-1): N_k P_k + N_k+1 P_k+1 + N_k+2 P_k+2 = Q_k
    const a = [], b = [], c = [], r = [];
    for (let k = 1; k < m; k++) {
      const N = basis3(U, k + 3, u[k]);
      a.push(N[0]); b.push(N[1]); c.push(N[2]); r.push({ x: Q[k].x, y: Q[k].y });
    }
    r[0].x -= a[0] * P[1].x; r[0].y -= a[0] * P[1].y;
    r[m - 2].x -= c[m - 2] * P[m + 1].x; r[m - 2].y -= c[m - 2] * P[m + 1].y;
    for (let i = 1; i < m - 1; i++) { // Thomas
      const f = a[i] / b[i - 1];
      b[i] -= f * c[i - 1]; r[i].x -= f * r[i - 1].x; r[i].y -= f * r[i - 1].y;
    }
    for (let i = m - 2; i >= 0; i--) {
      const nx = i < m - 2 ? P[i + 3].x : 0, ny = i < m - 2 ? P[i + 3].y : 0, cc = i < m - 2 ? c[i] : 0;
      P[i + 2] = { x: (r[i].x - cc * nx) / b[i], y: (r[i].y - cc * ny) / b[i] };
    }
  }
  return { p: 3, P: P.map((q) => ({ x: q.x, y: q.y, w: 1 })), U, closed: false };
}
function basis3(U, k, t) { // the 4 cubic basis functions nonzero on span k at t (P&T A2.2)
  const N = [1, 0, 0, 0], L = [], R = [];
  for (let j = 1; j <= 3; j++) {
    L[j] = t - U[k + 1 - j]; R[j] = U[k + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) { const tmp = N[r] / (R[r + 1] + L[j - r]); N[r] = saved + R[r + 1] * tmp; saved = L[j - r] * tmp; }
    N[j] = saved;
  }
  return N;
}
/** Fit points -> interpolating cubic (chord-length parameters, Bessel end tangents; closed: periodic tangent). */
function fitNurbs(fit, closed) {
  const Q = fit.map((q) => ({ x: q.x, y: q.y }));
  if (closed && Math.hypot(Q[0].x - Q[Q.length - 1].x, Q[0].y - Q[Q.length - 1].y) > 1e-12) Q.push({ ...Q[0] });
  const u = [0];
  for (let i = 1; i < Q.length; i++) u.push(u[i - 1] + (Math.hypot(Q[i].x - Q[i - 1].x, Q[i].y - Q[i - 1].y) || 1e-9));
  const m = Q.length - 1;
  const d = (i) => ({ x: (Q[i + 1].x - Q[i].x) / (u[i + 1] - u[i]), y: (Q[i + 1].y - Q[i].y) / (u[i + 1] - u[i]) });
  let D0, Dn;
  if (m === 1) D0 = Dn = d(0);
  else if (closed) {
    const h0 = u[1] - u[0], h1 = u[m] - u[m - 1], a = d(m - 1), b = d(0);
    D0 = Dn = { x: (h0 * a.x + h1 * b.x) / (h0 + h1), y: (h0 * a.y + h1 * b.y) / (h0 + h1) };
  } else {
    const bessel = (d1, d2, h1, h2) => ({ x: ((2 * h1 + h2) * d1.x - h1 * d2.x) / (h1 + h2), y: ((2 * h1 + h2) * d1.y - h1 * d2.y) / (h1 + h2) });
    D0 = bessel(d(0), d(1), u[1] - u[0], u[2] - u[1]);
    const e = bessel(d(m - 1), d(m - 2), u[m] - u[m - 1], u[m - 1] - u[m - 2]);
    Dn = e;
  }
  const nu = interpolateCubic(Q, u, D0, Dn);
  nu.closed = closed;
  return nu;
}

// ---- offset ---------------------------------------------------------------------------------
/** Offset by signed distance `d` (> 0: to the left of the direction of travel), as a cubic interpolating the exact
 *  offset at adaptively refined parameters until every check point is within `tol`. C0 corners (interior knots of
 *  multiplicity >= degree) split the curve; the offset pieces are bridged by straight segments. */
export function offsetNurbs(nu, d, tol) {
  const [t0, t1] = domain(nu);
  const breaks = [t0];
  for (const k of new Set(nu.U)) if (k > t0 && k < t1 && mult(nu.U, k) >= nu.p) breaks.push(k);
  breaks.push(t1);
  let out = null;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const piece = offsetPiece(nu, breaks[i], breaks[i + 1], d, tol);
    out = out ? bridge(out, piece, tol) : piece;
  }
  return out;
}
function bridge(A, B, tol) {
  const a = A.P[A.P.length - 1], b = B.P[0];
  if (Math.hypot(a.x - b.x, a.y - b.y) <= tol) { B.P[0] = { ...a }; return joinCurves(A, B); }
  const e = A.U[A.U.length - 1];
  return joinCurves(joinCurves(A, lineNurbs(a, b, 3, e, Math.hypot(a.x - b.x, a.y - b.y) || 1)), B);
}
function offsetPiece(nu, a, b, d, tol) {
  const Qp = (t, left) => {
    const { p, d1 } = derivsAt(nu, t, left), l = hyp(d1);
    if (!(l > 0)) throw Object.assign(new Error('Not supported yet: offset of a spline with a zero-length tangent'), { code: 'UNSUPPORTED' });
    return { x: p.x - (d * d1.y) / l, y: p.y + (d * d1.x) / l };
  };
  const Qd = (t, left) => { // d/dt of the offset point: C' (1 - d kappa)
    const { d1, d2 } = derivsAt(nu, t, left), l = hyp(d1), k = (d1.x * d2.y - d1.y * d2.x) / (l * l * l);
    return { x: d1.x * (1 - d * k), y: d1.y * (1 - d * k) };
  };
  let ts = [a];
  const knots = [...new Set(nu.U)].filter((k) => k > a && k < b);
  for (const k of [...knots, b]) { const s = ts[ts.length - 1]; for (let j = 1; j <= 4; j++) ts.push(s + ((k - s) * j) / 4); ts[ts.length - 1] = k; }
  const D0 = Qd(a, false), Dn = Qd(b, true);
  let fit = null;
  for (let iter = 0; iter < 16; iter++) {
    fit = interpolateCubic(ts.map((t, i) => Qp(t, i === ts.length - 1)), ts, D0, Dn);
    const next = [ts[0]];
    let bad = false;
    for (let i = 0; i + 1 < ts.length; i++) {
      let err = 0;
      for (const f of [0.25, 0.5, 0.75]) {
        const t = ts[i] + (ts[i + 1] - ts[i]) * f, q = Qp(t, false), c = pointAt(fit, t);
        err = Math.max(err, Math.hypot(q.x - c.x, q.y - c.y));
      }
      if (err > tol && ts.length < 4000) { next.push((ts[i] + ts[i + 1]) / 2); bad = true; }
      next.push(ts[i + 1]);
    }
    if (!bad) return fit;
    ts = next;
  }
  return fit;
}
