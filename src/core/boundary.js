// ASH Draw Studio - pick-point boundary detection (AutoCAD BHATCH / BOUNDARY "pick internal point").
//
// findBoundary(doc, p) collects the boundary geometry (LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE/POLYLINE open or
// closed with bulges, SPLINE, and the same inside INSERTs, nested) on visible/thawed layers, optionally limited to
// the current view, builds the planar arrangement (every piece split at every intersection / T-junction, end points
// within tolerance merged), and returns the smallest face around `p` as hatch loops:
//   [{ pts: [{x, y, bulge}], closed: true }, ...]   outer loop first (CCW), then its islands (CW)
// Lines and arcs keep their exact shape (arc pieces become bulges, each at most a half circle); ellipses and splines
// are tessellated. Text is not boundary geometry (it is ignored, not boxed as an island). Islands are the outer
// boundaries of separate drawings directly inside the face (AutoCAD "Outer" island style: the result is exactly
// the picked region, so the hatch area equals the region's area). Dangling lines and bridges are ignored.
// Returns null when no closed region surrounds the point.
import { toPrims, tessellate, explode, bboxOf, polylinePoints, normAngle } from './geom.js';

const TAU = Math.PI * 2;

const MAX_DEPTH = 16;

// ---- 1. candidate geometry -> primitives {k:'seg', a, b} | {k:'arc', c, r, a0, sweep (>0, radians)} ----------------
function layerVisible(doc, e, parentLayer) {
  if (e.invisible) return { ok: false };
  let name = e.layer;
  if ((name === '0' || name === undefined) && parentLayer) name = parentLayer;
  const l = doc.layers?.get(name ?? '0');
  return { ok: !l || (l.visible !== false && !l.frozen), name: name ?? '0' };
}
const boxHits = (b, v) => !v || (b && b.minx <= v.maxx && b.maxx >= v.minx && b.miny <= v.maxy && b.maxy >= v.miny);

function collect(doc, list, view, out, parentLayer = null, depth = 0) {
  for (const e of list) {
    const vis = layerVisible(doc, e, parentLayer);
    if (!vis.ok) continue;
    let prims;
    switch (e.type) {
      case 'LINE': case 'ARC': case 'CIRCLE': case 'LWPOLYLINE':
        prims = toPrims(e); break;
      case 'POLYLINE':
        prims = e.vertices?.length ? toPrims({ ...e, type: 'LWPOLYLINE' }) : []; break;
      case 'ELLIPSE': case 'SPLINE':
        prims = [];
        for (const pl of tessellate(e, doc, 0)) for (let i = 0; i + 1 < pl.length; i++) prims.push({ k: 'seg', a: pl[i], b: pl[i + 1] });
        break;
      case 'INSERT': {
        if (depth >= MAX_DEPTH) continue;
        if (view) { let b = null; try { b = bboxOf(e, doc); } catch { /* unknown extents: keep it */ } if (b && !boxHits(b, view)) continue; }
        let subs = [];
        try { subs = explode(e, doc).filter((s) => !(s.attrib || s.type === 'TEXT' || s.type === 'MTEXT')); } catch { continue; }
        collect(doc, subs, view, out, vis.name, depth + 1);
        continue;
      }
      default: continue; // TEXT, MTEXT, HATCH, DIMENSION, ... are not boundary objects
    }
    for (const q of prims) {
      if (q.k === 'seg' && Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) === 0) continue;
      if (q.k === 'arc' && !(q.r > 0)) continue;
      q.box = primBox(q);
      if (boxHits(q.box, view)) out.push(q);
    }
  }
  return out;
}

function arcPt(c, r, a) { return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }; }
function primBox(q) {
  if (q.k === 'seg') return { minx: Math.min(q.a.x, q.b.x), maxx: Math.max(q.a.x, q.b.x), miny: Math.min(q.a.y, q.b.y), maxy: Math.max(q.a.y, q.b.y) };
  const pts = [arcPt(q.c, q.r, q.a0), arcPt(q.c, q.r, q.a0 + q.sweep)];
  for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2; if (normAngle(a - q.a0) <= q.sweep) pts.push(arcPt(q.c, q.r, a)); }
  return { minx: Math.min(...pts.map((p) => p.x)), maxx: Math.max(...pts.map((p) => p.x)), miny: Math.min(...pts.map((p) => p.y)), maxy: Math.max(...pts.map((p) => p.y)) };
}
const primLen = (q) => (q.k === 'seg' ? Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) : q.r * q.sweep);

// ---- 2. intersections (tolerant) -> split parameters (arc length along the primitive) -----------------------------
/** parameter of point x on q if x lies on q within eps, else null */
function paramOn(q, x, eps) {
  if (q.k === 'seg') {
    const dx = q.b.x - q.a.x, dy = q.b.y - q.a.y, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    let t = ((x.x - q.a.x) * dx + (x.y - q.a.y) * dy) / L2;
    if (t < -eps / L || t > 1 + eps / L) return null;
    t = Math.min(1, Math.max(0, t));
    return Math.hypot(q.a.x + t * dx - x.x, q.a.y + t * dy - x.y) <= eps ? t * L : null;
  }
  const d = Math.hypot(x.x - q.c.x, x.y - q.c.y);
  if (Math.abs(d - q.r) > eps) return null;
  let off = normAngle(Math.atan2(x.y - q.c.y, x.x - q.c.x) - q.a0);
  const tolA = eps / q.r;
  if (off > q.sweep + tolA) { if (off >= TAU - tolA) off = 0; else return null; }
  return Math.min(off, q.sweep) * q.r;
}
function crossPoints(p, q, eps) {
  if (p.k === 'seg' && q.k === 'seg') {
    const r = { x: p.b.x - p.a.x, y: p.b.y - p.a.y }, s = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) <= 1e-12 * Math.hypot(r.x, r.y) * Math.hypot(s.x, s.y)) return []; // parallel: end points cover overlaps
    const t = ((q.a.x - p.a.x) * s.y - (q.a.y - p.a.y) * s.x) / den;
    return [{ x: p.a.x + t * r.x, y: p.a.y + t * r.y }];
  }
  if (p.k === 'arc' && q.k === 'seg') return crossPoints(q, p, eps);
  if (p.k === 'seg') { // line x circle
    const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
    const t0 = (q.c.x - p.a.x) * ux + (q.c.y - p.a.y) * uy;
    const f = { x: p.a.x + t0 * ux, y: p.a.y + t0 * uy }, d = Math.hypot(f.x - q.c.x, f.y - q.c.y);
    if (d > q.r + eps) return [];
    const h = Math.sqrt(Math.max(0, q.r * q.r - d * d));
    return h <= eps ? [f] : [{ x: f.x - h * ux, y: f.y - h * uy }, { x: f.x + h * ux, y: f.y + h * uy }];
  }
  const d = Math.hypot(q.c.x - p.c.x, q.c.y - p.c.y); // circle x circle
  if (d <= eps || d > p.r + q.r + eps || d < Math.abs(p.r - q.r) - eps) return [];
  const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
  const ux = (q.c.x - p.c.x) / d, uy = (q.c.y - p.c.y) / d, m = { x: p.c.x + a * ux, y: p.c.y + a * uy };
  return h <= eps ? [m] : [{ x: m.x - h * uy, y: m.y + h * ux }, { x: m.x + h * uy, y: m.y - h * ux }];
}
const ends = (q) => (q.k === 'seg' ? [q.a, q.b] : [arcPt(q.c, q.r, q.a0), arcPt(q.c, q.r, q.a0 + q.sweep)]);

function splitParams(prims, eps) {
  const params = prims.map((q) => [0, primLen(q)]);
  const order = prims.map((_, i) => i).sort((i, j) => prims[i].box.minx - prims[j].box.minx);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi], p = prims[i], pb = p.box;
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj], q = prims[j], qb = q.box;
      if (qb.minx > pb.maxx + eps) break;
      if (qb.miny > pb.maxy + eps || qb.maxy < pb.miny - eps) continue;
      const add = (x) => {
        const s = paramOn(p, x, eps), t = paramOn(q, x, eps);
        if (s !== null && t !== null) { params[i].push(s); params[j].push(t); }
      };
      for (const x of crossPoints(p, q, eps)) add(x);
      for (const x of ends(q)) { const s = paramOn(p, x, eps); if (s !== null) params[i].push(s); }
      for (const x of ends(p)) { const t = paramOn(q, x, eps); if (t !== null) params[j].push(t); }
    }
  }
  return params;
}

// ---- 3. arrangement: nodes (merged points), edges (pieces), half-edges sorted around each node -------------------
class NodeSet {
  constructor(tol) { this.tol = tol; this.cell = tol * 2; this.grid = new Map(); this.pts = []; }
  id(p) {
    const gx = Math.floor(p.x / this.cell), gy = Math.floor(p.y / this.cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const k of this.grid.get(`${gx + a},${gy + b}`) ?? []) {
        const q = this.pts[k];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= this.tol) return k;
      }
    }
    const k = this.pts.length;
    this.pts.push({ x: p.x, y: p.y });
    const key = `${gx},${gy}`;
    (this.grid.get(key) ?? this.grid.set(key, []).get(key)).push(k);
    return k;
  }
}

function buildEdges(prims, params, eps, nodes) {
  const edges = [], seen = new Set(), q = nodes.cell * 4;
  const push = (u, v, geo, mid) => {
    if (u === v) return;
    const key = `${Math.min(u, v)},${Math.max(u, v)},${Math.round(mid.x / q)},${Math.round(mid.y / q)}`;
    if (seen.has(key)) return; // duplicate (overlapping) geometry
    seen.add(key);
    edges.push({ u, v, ...geo });
  };
  prims.forEach((pr, i) => {
    const ps = params[i].sort((a, b) => a - b), cuts = [];
    for (const s of ps) if (!cuts.length || s - cuts[cuts.length - 1] > eps) cuts.push(s);
    const L = primLen(pr);
    if (cuts.length && L - cuts[cuts.length - 1] <= eps) cuts[cuts.length - 1] = L; else cuts.push(L);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const s0 = cuts[k], s1 = cuts[k + 1];
      if (pr.k === 'seg') {
        const at = (s) => { const t = s / L; return { x: pr.a.x + (pr.b.x - pr.a.x) * t, y: pr.a.y + (pr.b.y - pr.a.y) * t }; };
        const a = at(s0), b = at(s1);
        push(nodes.id(a), nodes.id(b), { arc: null }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      } else {
        const sw = (s1 - s0) / pr.r, n = Math.max(1, Math.ceil(sw / Math.PI - 1e-9)); // pieces of at most a half circle
        for (let m = 0; m < n; m++) {
          const a0 = pr.a0 + s0 / pr.r + (sw * m) / n, a1 = a0 + sw / n;
          push(nodes.id(arcPt(pr.c, pr.r, a0)), nodes.id(arcPt(pr.c, pr.r, a1)), { arc: { c: pr.c, r: pr.r, a0, sw: sw / n } }, arcPt(pr.c, pr.r, (a0 + a1) / 2));
        }
      }
    }
  });
  return edges;
}

/** half-edge h = 2*edge (u->v) or 2*edge+1 (v->u): origin, destination, signed sweep, start angle */
function half(edges, h) {
  const e = edges[h >> 1], fwd = (h & 1) === 0;
  const o = fwd ? e.u : e.v, d = fwd ? e.v : e.u;
  if (!e.arc) return { o, d, arc: null };
  return { o, d, arc: { c: e.arc.c, r: e.arc.r, a0: fwd ? e.arc.a0 : e.arc.a0 + e.arc.sw, sw: fwd ? e.arc.sw : -e.arc.sw } };
}

function traceFaces(edges, alive, pts) {
  // outgoing half-edges per node, sorted CCW by tangent direction, ties by curvature (left-curving after)
  const out = new Map();
  for (let i = 0; i < edges.length; i++) {
    if (!alive[i]) continue;
    for (const h of [2 * i, 2 * i + 1]) {
      const he = half(edges, h);
      let th, k = 0;
      if (!he.arc) th = Math.atan2(pts[he.d].y - pts[he.o].y, pts[he.d].x - pts[he.o].x);
      else { const sg = Math.sign(he.arc.sw); th = he.arc.a0 + (sg * Math.PI) / 2; k = sg / he.arc.r; }
      th = normAngle(th);
      if (th > TAU - 1e-9) th = 0;
      (out.get(he.o) ?? out.set(he.o, []).get(he.o)).push({ h, th, k });
    }
  }
  const pos = new Map();
  for (const list of out.values()) {
    list.sort((a, b) => (Math.abs(a.th - b.th) > 1e-9 ? a.th - b.th : a.k - b.k));
    list.forEach((x, i) => pos.set(x.h, { list, i }));
  }
  // next(h): at h's destination, the outgoing half-edge just clockwise of h's twin -> the face lies on the left
  const next = (h) => { const { list, i } = pos.get(h ^ 1); return list[(i - 1 + list.length) % list.length].h; };
  const faceOf = new Map(), faces = [];
  for (const h of pos.keys()) {
    if (faceOf.has(h)) continue;
    const cyc = [];
    let x = h, guard = 0;
    while (!faceOf.has(x) && guard++ < 4 * pos.size + 4) { faceOf.set(x, faces.length); cyc.push(x); x = next(x); }
    faces.push(cyc);
  }
  return { faces, faceOf };
}

function cycleLoop(edges, pts, cyc) {
  return cyc.map((h) => {
    const he = half(edges, h), p = pts[he.o];
    return { x: p.x, y: p.y, bulge: he.arc ? Math.tan(he.arc.sw / 4) : 0 };
  });
}
function signedArea(loop) {
  let a2 = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a2 += p.x * q.y - q.x * p.y;
    if (p.bulge) {
      const th = 4 * Math.atan(p.bulge), c = Math.hypot(q.x - p.x, q.y - p.y), r = c / (2 * Math.sin(Math.abs(th) / 2));
      a2 += r * r * (th - Math.sin(th));
    }
  }
  return a2 / 2;
}
function inPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---- 4. public API ----------------------------------------------------------------------------------------------
/**
 * Smallest closed region around `p`.
 * @param doc    drawing (entities, layers, blocks)
 * @param p      pick point {x, y}
 * @param opts   view: {minx, miny, maxx, maxy} - only geometry touching it is considered (AutoCAD evaluates the
 *               objects visible on screen); gapTol: end points this close are joined (HPGAPTOL, default 0);
 *               entities: the entity list to search (default doc.entities)
 * @returns hatch loops (outer first, then islands) or null
 */
export function findBoundary(doc, p, { view = null, gapTol = 0, entities = doc.entities } = {}) {
  const prims = collect(doc, entities, view, []);
  if (!prims.length) return null;
  let size = 0;
  { let b = null; for (const q of prims) b = b ? { minx: Math.min(b.minx, q.box.minx), miny: Math.min(b.miny, q.box.miny), maxx: Math.max(b.maxx, q.box.maxx), maxy: Math.max(b.maxy, q.box.maxy) } : { ...q.box }; size = Math.max(Math.hypot(b.maxx - b.minx, b.maxy - b.miny), Math.abs(b.maxx), Math.abs(b.maxy), Math.abs(b.minx), Math.abs(b.miny)); }
  const eps = Math.max(size * 1e-9, 1e-12);
  const nodes = new NodeSet(Math.max(eps, gapTol || 0));
  const edges = buildEdges(prims, splitParams(prims, Math.max(eps, gapTol || 0)), eps, nodes);
  const pts = nodes.pts;

  // drop bridges and dangling pieces (an edge with the same face on both sides), then trace the faces again
  const alive = edges.map(() => true);
  let tr = traceFaces(edges, alive, pts);
  let dropped = false;
  for (let i = 0; i < edges.length; i++) if (tr.faceOf.get(2 * i) === tr.faceOf.get(2 * i + 1)) { alive[i] = false; dropped = true; }
  if (dropped) tr = traceFaces(edges, alive, pts);

  // connected components (for islands)
  const parent = pts.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let i = 0; i < edges.length; i++) if (alive[i]) parent[find(edges[i].u)] = find(edges[i].v);

  const faces = tr.faces.map((cyc) => {
    const loop = cycleLoop(edges, pts, cyc);
    return { cyc, loop, area: signedArea(loop), comp: find(half(edges, cyc[0]).o) };
  });
  const minArea = eps * eps * 1e6;
  const poly = (f) => (f.poly ??= polylinePoints({ vertices: f.loop, closed: true }, 0));
  // chord box grown by the largest bulged chord (a bulge <= 1 arc stays within half its chord of it)
  const boxOf = (f) => (f.box ??= f.loop.reduce((b, v, i) => {
    const w = v.bulge ? Math.hypot(f.loop[(i + 1) % f.loop.length].x - v.x, f.loop[(i + 1) % f.loop.length].y - v.y) : 0;
    return { minx: Math.min(b.minx, v.x - w), miny: Math.min(b.miny, v.y - w), maxx: Math.max(b.maxx, v.x + w), maxy: Math.max(b.maxy, v.y + w) };
  }, { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }));
  const around = (f, q) => { const b = boxOf(f); return q.x >= b.minx && q.x <= b.maxx && q.y >= b.miny && q.y <= b.maxy && inPoly(q, poly(f)); };

  const outer = faces.filter((f) => f.area > minArea && around(f, p)).sort((a, b) => a.area - b.area)[0];
  if (!outer) return null;
  // islands: outer boundaries (negative cycles) of other components lying inside the face and not around p
  let islands = faces.filter((f) => f.area < -minArea && f.comp !== outer.comp && -f.area < outer.area
    && around(outer, f.loop[0]) && !around(f, p));
  islands = islands.filter((f) => !islands.some((g) => g !== f && -g.area > -f.area && around(g, f.loop[0])));
  return [outer, ...islands].map((f) => ({ pts: f.loop, closed: true }));
}
