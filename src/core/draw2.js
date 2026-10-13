// ASH Draw Studio - geometry of the POLYGON, SPLINE (fit points) and DONUT commands. Pure ES module.
import { interpolateCubic } from './nurbs.js';

const TAU = Math.PI * 2;

/** Vertices of a regular n-gon about centre c. `mid` is the direction (radians) of the midpoint of one edge;
 *  inscribed: the vertices lie on the circle of radius r; circumscribed: the edge midpoints do. */
export function polygonVertices(c, n, r, inscribed, mid = -Math.PI / 2) {
  const R = inscribed ? r : r / Math.cos(Math.PI / n), a0 = mid - Math.PI / n, out = [];
  for (let i = 0; i < n; i++) { const a = a0 + (TAU * i) / n; out.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) }); }
  return out;
}

/** POLYGON radius step: vertices when the radius is given by a picked point q (it also sets the rotation: a vertex at q
 *  when inscribed, an edge midpoint at q when circumscribed) or typed as a number (bottom edge horizontal). */
export function polygonFromRadius(c, n, inscribed, q) {
  if (typeof q === 'number') return polygonVertices(c, n, q, inscribed);
  const r = Math.hypot(q.x - c.x, q.y - c.y), a = Math.atan2(q.y - c.y, q.x - c.x);
  return polygonVertices(c, n, r, inscribed, inscribed ? a + Math.PI / n : a);
}

/** POLYGON Edge: the n-gon with edge a -> b, the polygon on its left (counterclockwise from a to b, as AutoCAD). */
export function polygonFromEdge(a, b, n) {
  const out = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  let dx = b.x - a.x, dy = b.y - a.y;
  const ca = Math.cos(TAU / n), sa = Math.sin(TAU / n);
  for (let i = 2; i < n; i++) {
    [dx, dy] = [dx * ca - dy * sa, dx * sa + dy * ca];
    const p = out[i - 1];
    out.push({ x: p.x + dx, y: p.y + dy });
  }
  return out;
}

/** DONUT: closed polyline of two half circles (bulge 1) on the mid radius, constant width (outside - inside) / 2. */
export function donutPolyline(c, inside, outside) {
  const r = (inside + outside) / 4;
  return { vertices: [{ x: c.x - r, y: c.y, bulge: 1 }, { x: c.x + r, y: c.y, bulge: 1 }], closed: true, width: (outside - inside) / 2 };
}

/** Fit points -> degree-3 SPLINE data { degree, ctrl, knots, fit, closed } interpolating every fit point:
 *  chord-length knots; open: Bessel end tangents; closed: the periodic C2 cubic (seam tangent from the cyclic system). */
export function splineFromFit(fit, closed = false) {
  const Q = [];
  for (const q of fit) if (!Q.length || Math.hypot(q.x - Q.at(-1).x, q.y - Q.at(-1).y) > 1e-12) Q.push({ x: q.x, y: q.y });
  if (closed && Q.length > 2 && Math.hypot(Q[0].x - Q.at(-1).x, Q[0].y - Q.at(-1).y) <= 1e-12) Q.pop();
  if (Q.length < 2) return null;
  closed = closed && Q.length >= 3;
  const pts = closed ? [...Q, { ...Q[0] }] : Q, m = pts.length - 1, u = [0];
  for (let i = 1; i <= m; i++) u.push(u[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const h = (i) => u[i + 1] - u[i];
  const d = (i) => ({ x: (pts[i + 1].x - pts[i].x) / h(i), y: (pts[i + 1].y - pts[i].y) / h(i) });
  let D0, Dn;
  if (m === 1) D0 = Dn = d(0);
  else if (closed) D0 = Dn = periodicTangent(pts, u);
  else {
    const bessel = (d1, d2, h1, h2) => ({ x: ((2 * h1 + h2) * d1.x - h1 * d2.x) / (h1 + h2), y: ((2 * h1 + h2) * d1.y - h1 * d2.y) / (h1 + h2) });
    D0 = bessel(d(0), d(1), h(0), h(1));
    Dn = bessel(d(m - 1), d(m - 2), h(m - 1), h(m - 2));
  }
  const nu = interpolateCubic(pts, u, D0, Dn);
  return { degree: 3, ctrl: nu.P.map((q) => ({ x: q.x, y: q.y })), knots: nu.U, fit: Q, closed };
}

// C2 periodic cubic through pts[0..m] (pts[m] = pts[0]): derivatives D_0..D_m-1 from the cyclic tridiagonal system
// h_i D_i-1 + 2 (h_i-1 + h_i) D_i + h_i-1 D_i+1 = 3 (h_i s_i-1 + h_i-1 s_i) (indices mod m), solved by Sherman-Morrison.
function periodicTangent(pts, u) {
  const m = pts.length - 1, h = (i) => u[((i % m) + m) % m + 1] - u[((i % m) + m) % m];
  const s = (i, k) => { const j = ((i % m) + m) % m; return (pts[j + 1][k] - pts[j][k]) / h(j); };
  const a = [], b = [], c = [];
  for (let i = 0; i < m; i++) { a.push(h(i)); b.push(2 * (h(i - 1) + h(i))); c.push(h(i - 1)); }
  const solve = (k) => cyclic(a, b, c, Array.from({ length: m }, (_, i) => 3 * (h(i) * s(i - 1, k) + h(i - 1) * s(i, k))))[0];
  return { x: solve('x'), y: solve('y') };
}
function cyclic(a, b, c, r) { // row i: a_i x_i-1 + b_i x_i + c_i x_i+1 = r_i, x_-1 = x_n-1, x_n = x_0 (n >= 3)
  const n = r.length, alpha = c[n - 1], beta = a[0], gamma = -b[0];
  const bb = b.slice(); bb[0] = b[0] - gamma; bb[n - 1] = b[n - 1] - (alpha * beta) / gamma;
  const tri = (rhs) => { // Thomas on (a, bb, c) without the corners
    const cp = new Array(n), dp = new Array(n), x = new Array(n);
    cp[0] = c[0] / bb[0]; dp[0] = rhs[0] / bb[0];
    for (let i = 1; i < n; i++) { const den = bb[i] - a[i] * cp[i - 1]; cp[i] = c[i] / den; dp[i] = (rhs[i] - a[i] * dp[i - 1]) / den; }
    x[n - 1] = dp[n - 1];
    for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
    return x;
  };
  const x = tri(r), uu = new Array(n).fill(0); uu[0] = gamma; uu[n - 1] = alpha;
  const z = tri(uu), f = (x[0] + (beta * x[n - 1]) / gamma) / (1 + z[0] + (beta * z[n - 1]) / gamma);
  return x.map((v, i) => v - f * z[i]);
}
