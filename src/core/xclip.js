// ASH Draw Studio - XCLIP: clipping a block reference / xref to a boundary.
//
// An INSERT may carry `clip = { pts, enabled, inverted, showFrame }`: the boundary in the block definition's own
// coordinates (two points = a rectangle given by opposite corners), so it moves, rotates and scales with the insert.
// The scene builder (render.js) cuts every item an enabled clip's insert emits against the boundary in world
// coordinates, so screen, PDF and SVG output, pick and the highlight all see the clipped geometry.
//
// What is cut and how:
//   - paths (lines, polylines, arcs, ellipses, circles): exactly, at their crossings with the boundary (arcs stay arcs)
//   - fills (solids, wide polylines, hatches, wipeouts): flattened, then Sutherland-Hodgman against the boundary, or,
//     when the boundary is not convex, against each triangle of it (the pieces are disjoint, so the even-odd fill of
//     all of them is the exact intersection). Inverted: the fill plus its inside part, under even-odd = the outside part
//   - text, points: kept whole when the insertion point is kept, otherwise dropped
//   - on the boundary (within a tolerance scaled to its size) counts as kept, for an inside clip and an inverted one
//   - images: an inside clip becomes (or narrows) the image's clip polygon; an inverted clip drops an image wholly
//     inside the boundary and keeps any other whole
//   - XLINE / RAY: cut to the boundary for an inside clip; kept whole by an inverted one

import { compose, translation, rotation, scaling, invert, DEG } from './geom.js';

const OP_M = 0, OP_L = 1, OP_A = 2, OP_E = 3, OP_Z = 4;
const TAU = Math.PI * 2;
const EPS = 1e-9;

/** the boundary polygon of a clip in block coordinates (a 2-point clip is the rectangle of its corners) */
export function clipPolygon(clip) {
  const p = clip.pts;
  if (p.length === 2) {
    const [a, b] = p;
    return [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
  }
  return p.map((q) => ({ x: q.x, y: q.y }));
}

/** even-odd point-in-polygon */
export function insidePoly(x, y, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)) ins = !ins;
  }
  return ins;
}

const area2 = (poly) => { let s = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y; return s; };

export function isConvex(poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < EPS) continue;
    if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

/** ear-clipping triangulation of a simple polygon (CCW triangles) */
export function triangulate(poly) {
  const v = area2(poly) < 0 ? poly.slice().reverse() : poly.slice();
  const out = [];
  let guard = v.length * v.length;
  while (v.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length], b = v[i], c = v[(i + 1) % v.length];
      if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= EPS) continue; // reflex or flat
      const tri = [a, b, c];
      if (v.some((q) => q !== a && q !== b && q !== c && insidePoly(q.x, q.y, tri))) continue;
      out.push(tri); v.splice(i, 1); cut = true; break;
    }
    if (!cut) break; // degenerate (self-touching) boundary: what is left is taken as is
  }
  if (v.length >= 3) out.push(v);
  return out;
}

/** Sutherland-Hodgman: ring (points) clipped to a convex polygon (any winding); [] when nothing is left */
export function clipRingConvex(ring, conv) {
  const s = area2(conv) >= 0 ? 1 : -1;
  let pts = ring;
  for (let i = 0; i < conv.length && pts.length; i++) {
    const a = conv[i], b = conv[(i + 1) % conv.length];
    const side = (p) => s * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const res = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length], sp = side(p), sq = side(q);
      if (sp >= 0) res.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); res.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
    }
    pts = res;
  }
  return pts.length >= 3 ? pts : [];
}

/** distance from (x, y) to the polygon's outline is at most tol */
function onOutline(x, y, poly, tol) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    if (Math.hypot(x - a.x - dx * t, y - a.y - dy * t) <= tol) return true;
  }
  return false;
}

/** a clip prepared for the scene builder: world polygon, convex parts, inverted flag, on-boundary tolerance */
export function worldClip(clip, P) {
  const poly = clipPolygon(clip).map(P);
  let size = 0;
  for (const p of poly) size = Math.max(size, Math.abs(p.x - poly[0].x), Math.abs(p.y - poly[0].y));
  return { poly, inverted: !!clip.inverted, convex: isConvex(poly), tol: EPS * Math.max(size, 1e-300), _parts: null };
}
const partsOf = (c) => (c._parts ??= c.convex ? [c.poly] : triangulate(c.poly));
/** the point is kept by the clip: inside an inside clip, outside an inverted one; on the boundary, kept by both */
export const keepsPoint = (c, x, y) => onOutline(x, y, c.poly, c.tol) || insidePoly(x, y, c.poly) !== c.inverted;
/** the point is within the boundary (inside or on it) */
const within = (c, x, y) => insidePoly(x, y, c.poly) || onOutline(x, y, c.poly, c.tol);

/** the insert's clip is on (XCLIP boundary set and not turned off) */
export const clipOn = (e) => !!e.clip && e.clip.enabled !== false && e.clip.pts?.length >= 2;

/** an INSERT with a clip as one single-cell view per MINSERT cell with that cell's world clip ({ view, clip }); the
 *  attributes go with the first cell (the scene builder cuts them to that one) */
export function insertCellClips(e, base = { x: 0, y: 0 }) {
  const cols = Math.max(1, e.cols || 1), rows = Math.max(1, e.rows || 1), rot = (e.rot || 0) * DEG;
  const co = Math.cos(rot), si = Math.sin(rot), out = [];
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const ox = k * (e.colSp || 0), oy = r * (e.rowSp || 0);
    const { clip, attribs, ...rest } = e;
    const view = { ...rest, p: { x: e.p.x + ox * co - oy * si, y: e.p.y + ox * si + oy * co }, cols: 1, rows: 1 };
    if (!r && !k && attribs) view.attribs = attribs;
    const m = insertMatrix(view, base);
    out.push({ view, clip: worldClip(clip, (p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] })) });
  }
  return out;
}

/** a polyline (points; one point = a point) cut to a world clip: the kept polylines */
export function clipPolyline(pl, c) {
  if (pl.length === 1) return keepsPoint(c, pl[0].x, pl[0].y) ? [pl] : [];
  const ops = [];
  pl.forEach((p, i) => ops.push(i ? OP_L : OP_M, p.x, p.y));
  const r = clipPathOps(ops, c);
  if (!r.cut) return [pl];
  const out = [];
  for (let i = 0; i < r.ops.length; i += 3) {
    const p = { x: r.ops[i + 1], y: r.ops[i + 2] };
    if (r.ops[i] === OP_M) out.push([p]); else out[out.length - 1].push(p);
  }
  return out.filter((q) => q.length > 1);
}

// --- path ops ------------------------------------------------------------------------------------------------------

/** parameters u in (0,1) where segment a-b crosses the polygon's edges */
function segCuts(ax, ay, bx, by, poly) {
  const us = [];
  const dx = bx - ax, dy = by - ay;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j], q = poly[i], ex = q.x - p.x, ey = q.y - p.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < EPS) continue;
    const u = ((p.x - ax) * ey - (p.y - ay) * ex) / den, v = ((p.x - ax) * dy - (p.y - ay) * dx) / den;
    if (u > EPS && u < 1 - EPS && v >= -EPS && v <= 1 + EPS) us.push(u);
  }
  return us;
}

/** parameters u in (0,1) where the elliptical arc (c, rx, ry, rot, t0, sw) crosses the polygon's edges */
function arcCuts(cx, cy, rx, ry, rot, t0, sw, poly) {
  const us = [], co = Math.cos(rot), si = Math.sin(rot);
  const loc = (p) => { const x = p.x - cx, y = p.y - cy; return { x: (x * co + y * si) / rx, y: (-x * si + y * co) / ry }; };
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = loc(poly[j]), q = loc(poly[i]), dx = q.x - p.x, dy = q.y - p.y;
    const A = dx * dx + dy * dy, B = 2 * (p.x * dx + p.y * dy), C = p.x * p.x + p.y * p.y - 1, D = B * B - 4 * A * C;
    if (A < EPS || D < 0) continue;
    for (const s of [(-B - Math.sqrt(D)) / (2 * A), (-B + Math.sqrt(D)) / (2 * A)]) {
      if (s < -EPS || s > 1 + EPS) continue;
      const t = Math.atan2(p.y + s * dy, p.x + s * dx);
      let d = ((t - t0) * Math.sign(sw)) % TAU; if (d < 0) d += TAU;
      const u = d / Math.abs(sw);
      if (u > EPS && u < 1 - EPS) us.push(u);
    }
  }
  return us;
}

const arcPt = (cx, cy, rx, ry, rot, t) => {
  const x = rx * Math.cos(t), y = ry * Math.sin(t), co = Math.cos(rot), si = Math.sin(rot);
  return { x: cx + x * co - y * si, y: cy + x * si + y * co };
};

/** path ops cut to the clip: { ops, cut } (cut false = nothing crossed); ops empty when nothing is kept */
export function clipPathOps(ops, c) {
  const keep = (x, y) => keepsPoint(c, x, y);
  const out = [];
  let cut = false, px = 0, py = 0, sx = 0, sy = 0, lx = NaN, ly = NaN, anyOut = false;
  const moveIfNeeded = (x, y) => { if (!(Math.abs(x - lx) <= EPS && Math.abs(y - ly) <= EPS)) out.push(OP_M, x, y); };
  // one curve piece: us sorted cut parameters; at(u) its point; emit(u0, u1) writes the kept piece
  const pieces = (us, at, emit) => {
    if (us.length) cut = true;
    const bounds = [0, ...us.sort((a, b) => a - b), 1];
    for (let k = 0; k < bounds.length - 1; k++) {
      const u0 = bounds[k], u1 = bounds[k + 1];
      if (u1 - u0 < EPS) continue;
      const m = at((u0 + u1) / 2);
      if (!keep(m.x, m.y)) { anyOut = true; continue; }
      const a = at(u0); moveIfNeeded(a.x, a.y); emit(u0, u1);
      const b = at(u1); lx = b.x; ly = b.y;
    }
  };
  const seg = (bx, by) => {
    const ax = px, ay = py;
    pieces(segCuts(ax, ay, bx, by, c.poly), (u) => ({ x: ax + (bx - ax) * u, y: ay + (by - ay) * u }),
      (u0, u1) => out.push(OP_L, ax + (bx - ax) * u1, ay + (by - ay) * u1));
    px = bx; py = by;
  };
  for (let i = 0; i < ops.length;) {
    const op = ops[i];
    if (op === OP_M) { px = sx = ops[i + 1]; py = sy = ops[i + 2]; i += 3; }
    else if (op === OP_L) { seg(ops[i + 1], ops[i + 2]); i += 3; }
    else if (op === OP_A || op === OP_E) {
      const e = op === OP_E;
      const cx = ops[i + 1], cy = ops[i + 2], rx = ops[i + 3], ry = e ? ops[i + 4] : rx, rot = e ? ops[i + 5] : 0;
      const t0 = e ? ops[i + 6] : ops[i + 4], sw = e ? ops[i + 7] : ops[i + 5];
      i += e ? 8 : 6;
      if (!(rx > 0) || !(Math.abs(sw) > 0)) continue;
      const at = (u) => arcPt(cx, cy, rx, ry, rot, t0 + sw * u);
      pieces(arcCuts(cx, cy, rx, ry, rot, t0, sw, c.poly), at, (u0, u1) => {
        if (e) out.push(OP_E, cx, cy, rx, ry, rot, t0 + sw * u0, sw * (u1 - u0));
        else out.push(OP_A, cx, cy, rx, t0 + sw * u0, sw * (u1 - u0));
      });
      const end = at(1); px = end.x; py = end.y;
    } else if (op === OP_Z) { seg(sx, sy); i += 1; } else break;
  }
  if (!cut && !anyOut) return { ops, cut: false }; // wholly kept: the original ops (closed shapes keep their join)
  return { ops: out, cut: true };
}

/** fill ops (M/L/A/E/Z) flattened to rings of points */
function rings(ops) {
  const res = [];
  let cur = null;
  for (let i = 0; i < ops.length;) {
    const op = ops[i];
    if (op === OP_M) { cur = [{ x: ops[i + 1], y: ops[i + 2] }]; res.push(cur); i += 3; }
    else if (op === OP_L) { cur?.push({ x: ops[i + 1], y: ops[i + 2] }); i += 3; }
    else if (op === OP_A || op === OP_E) {
      const e = op === OP_E;
      const cx = ops[i + 1], cy = ops[i + 2], rx = ops[i + 3], ry = e ? ops[i + 4] : rx, rot = e ? ops[i + 5] : 0;
      const t0 = e ? ops[i + 6] : ops[i + 4], sw = e ? ops[i + 7] : ops[i + 5];
      i += e ? 8 : 6;
      if (!cur) { cur = []; res.push(cur); }
      const n = Math.max(2, Math.ceil(Math.abs(sw) / TAU * 64));
      for (let k = 1; k <= n; k++) cur.push(arcPt(cx, cy, rx, ry, rot, t0 + sw * k / n));
    } else { i += 1; cur = null; }
  }
  return res.filter((r) => r.length >= 3);
}

const ringOps = (rs) => { const o = []; for (const r of rs) { r.forEach((p, k) => o.push(k ? OP_L : OP_M, p.x, p.y)); o.push(OP_Z); } return o; };

/** fill ops cut to the clip (even-odd fill rule); empty when nothing is left */
export function clipFillOps(ops, c) {
  const rs = rings(ops), inside = [];
  for (const r of rs) for (const part of partsOf(c)) { const q = clipRingConvex(r, part); if (q.length) inside.push(q); }
  return ringOps(c.inverted ? (inside.length ? [...rs, ...inside] : rs) : inside);
}

function opsBox(ops) {
  let b = null;
  const g = (x, y) => { if (!b) b = { minx: x, miny: y, maxx: x, maxy: y }; else { if (x < b.minx) b.minx = x; if (x > b.maxx) b.maxx = x; if (y < b.miny) b.miny = y; if (y > b.maxy) b.maxy = y; } };
  for (let i = 0; i < ops.length;) {
    const op = ops[i];
    if (op === OP_M || op === OP_L) { g(ops[i + 1], ops[i + 2]); i += 3; }
    else if (op === OP_A) { const r = ops[i + 3]; g(ops[i + 1] - r, ops[i + 2] - r); g(ops[i + 1] + r, ops[i + 2] + r); i += 6; }
    else if (op === OP_E) { const r = Math.max(ops[i + 3], ops[i + 4]); g(ops[i + 1] - r, ops[i + 2] - r); g(ops[i + 1] + r, ops[i + 2] + r); i += 8; }
    else i += 1;
  }
  return b;
}

const polyBox = (poly) => opsBox(poly.flatMap((p) => [OP_L, p.x, p.y]));

/** a scene item cut to a world clip: the item, a cut copy, or null when nothing of it is left */
export function clipItem(it, c, clipInfinite) {
  const keepPt = (p) => keepsPoint(c, p.x, p.y);
  if (it.kind === 'text' || it.kind === 'point') return keepPt(it.p) ? it : null;
  if (it.strokeText) return keepPt(it.strokeText.p) ? it : null;
  if (it.kind === 'clipFrame') return it;
  if (it.kind === 'image') {
    const q = it.ops.length >= 12 ? [1, 4, 7, 10].map((k) => ({ x: it.ops[k], y: it.ops[k + 1] })) : [];
    if (c.inverted) return q.length && q.every((p) => within(c, p.x, p.y)) ? null : it;
    const own = it.image.clipPts;
    let pts = c.poly;
    if (own?.length >= 3 && c.convex) pts = clipRingConvex(own, c.poly);
    if (!pts.length) return null;
    return { ...it, image: { ...it.image, clipPts: pts } };
  }
  if (it.inf) {
    if (c.inverted) return it;
    const b = polyBox(c.poly), s = clipInfinite(it.inf.p, it.inf.dir, it.inf.ray, b);
    if (!s) return null;
    const { inf, ...rest } = it;
    return clipItem({ ...rest, ops: [OP_M, s[0].x, s[0].y, OP_L, s[1].x, s[1].y] }, c, clipInfinite);
  }
  if (it.kind === 'fill' || it.kind === 'hatch' || it.kind === 'wipeout') {
    const b = it.bbox;
    // wholly inside a convex boundary: unchanged (inside clip) or gone (inverted)
    if (b && c.convex && [[b.minx, b.miny], [b.maxx, b.miny], [b.maxx, b.maxy], [b.minx, b.maxy]].every(([x, y]) => within(c, x, y))) return c.inverted ? null : it;
    const ops = clipFillOps(it.ops, c);
    if (!ops.length) return null;
    const { _loops, _ccw, ...rest } = it;
    return { ...rest, ops, bbox: opsBox(ops) };
  }
  // path
  const r = clipPathOps(it.ops, c);
  if (!r.cut) return it;
  if (!r.ops.length) return null;
  const nu = { ...it, ops: r.ops, bbox: opsBox(r.ops) };
  if (nu.arrow && !keepPt(nu.arrow[1])) delete nu.arrow;
  return nu;
}

// --- DXF: SPATIAL_FILTER ------------------------------------------------------------------------------------------
// INSERT 102 {ACAD_XDICTIONARY 360 -> DICTIONARY "ACAD_FILTER" -> DICTIONARY "SPATIAL" -> SPATIAL_FILTER:
//   100 AcDbFilter, 100 AcDbSpatialFilter, 70 count, 10/20 per point (2 = rectangle corners), 210/220/230 normal,
//   11/21/31 origin, 71 clipping enabled, 72 front clip (40 distance), 73 back clip (41 distance), 290 inverted
//   (newer AutoCAD; written only when set), then 12 x 40 inverse block transform and 12 x 40 clip transform (3 x 4,
//   row by row). The points are read and written as block definition coordinates. Frame display is the drawing's
//   $XCLIPFRAME header variable (doc.header.xclipframe), not part of the filter.

/** the insert's block -> world matrix (2D affine), base point included */
const insertMatrix = (e, base = { x: 0, y: 0 }) => compose(translation(e.p.x, e.p.y), compose(rotation((e.rot || 0) * DEG),
  compose(scaling(e.sx ?? 1, e.sy ?? 1), translation(-base.x, -base.y))));
const mat34 = (m) => [m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, 1, 0];

export function spatialFilterTags(e, base) {
  const c = e.clip, t = [[100, 'AcDbFilter'], [100, 'AcDbSpatialFilter'], [70, c.pts.length]];
  for (const p of c.pts) t.push([10, p.x], [20, p.y]);
  t.push([210, 0], [220, 0], [230, 1], [11, 0], [21, 0], [31, 0], [71, c.enabled === false ? 0 : 1], [72, 0], [73, 0]);
  if (c.inverted) t.push([290, 1]);
  let inv;
  try { inv = invert(insertMatrix(e, base)); } catch { inv = [1, 0, 0, 1, 0, 0]; }
  for (const v of mat34(inv)) t.push([40, v]);
  for (const v of mat34([1, 0, 0, 1, 0, 0])) t.push([40, v]);
  return t;
}

/** the clip of a SPATIAL_FILTER's tags ([code, value] strings or numbers); null when it has no usable boundary.
 *  `enabled` is code 71 (XCLIP Off keeps the filter with 71 = 0); showFrame is the in-app default (the frame is the
 *  header's $XCLIPFRAME). */
export function clipFromSpatialFilter(tags) {
  const pts = [];
  let inSF = false, n = 0, x = null, on = 1, inverted = false, mats = [];
  for (const [code, raw] of tags) {
    if (code === 100) { inSF = raw === 'AcDbSpatialFilter'; continue; }
    if (!inSF) continue;
    const v = +raw;
    if (code === 70) n = v;
    else if (code === 10) x = v;
    else if (code === 20 && x !== null) { pts.push({ x, y: v }); x = null; }
    else if (code === 71) on = v;
    else if (code === 290) inverted = v !== 0;
    else if (code === 40) mats.push(v);
  }
  if (pts.length < 2 || (n && pts.length !== n)) return null;
  // the clip transform (the last 12 values): applied to the points when it is not the identity
  const ct = mats.length >= 12 ? mats.slice(-12) : null;
  const m = ct && [ct[0], ct[4], ct[1], ct[5], ct[3], ct[7]];
  const ident = !m || (Math.abs(m[0] - 1) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3] - 1) + Math.abs(m[4]) + Math.abs(m[5]) < 1e-12);
  const P = ident ? pts : pts.map((p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }));
  return { pts: P, enabled: on !== 0, inverted, showFrame: true };
}

// --- editing ------------------------------------------------------------------------------------------------------

/** XCLIP on the INSERTs `ids` of session `s`, one undo step: `change(clip | undefined, insert)` returns the insert's new
 *  clip (null deletes it; undefined leaves the insert alone). New boundary: () => ({ pts, enabled: true, inverted, showFrame: true }); Off / On:
 *  (c) => c && { ...c, enabled }; Delete: () => null. Returns the number of inserts changed. */
export function xclipInserts(s, ids, change, label = 'XCLIP') {
  const want = new Set(ids);
  const targets = s.doc.entities.filter((e) => want.has(e.id) && e.type === 'INSERT');
  let n = 0;
  if (!targets.length) return 0;
  s.transact(label, (tx) => {
    for (const e of targets) {
      const nu = change(e.clip, e);
      if (nu === undefined || (nu === null && !e.clip)) continue;
      const c = structuredClone(e);
      if (nu) c.clip = nu; else delete c.clip;
      tx.replace(c); n++;
    }
  });
  return n;
}

/** a world point list (the boundary picked on screen) in the insert's block coordinates */
export function worldToBlock(e, base, pts) {
  const inv = invert(insertMatrix(e, base));
  return pts.map((p) => ({ x: inv[0] * p.x + inv[2] * p.y + inv[4], y: inv[1] * p.x + inv[3] * p.y + inv[5] }));
}
