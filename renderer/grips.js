// ASH Draw Studio - grips (AutoCAD-style editing handles) and property edits. Pure: no DOM, runs in Node.
//
//   gripsOf(e)                 -> [{x, y, kind}]   kind: end | mid | vtx | seg | cen | quad | axis | ins | def | text
//   applyGrip(e, i, p)         -> edited COPY of e with grip i dragged to p (null when the edit is impossible)
//   gripEdit(session, id, i, p)-> one undo step; DIMENSIONs are regenerated into a fresh *D block
//   editEntity(session, id, fn, label) -> one undo step replacing the entity by fn(copy)
//   matchProps(src, dst)       -> copy of dst carrying src's layer/colour/linetype/ltscale/lineweight (+ text height/style, dim style)
import { getEntity } from '../src/core/model.js';
import { regenerateDimension } from '../src/core/dims.js';
import { bulgeToArc, ccwSweep, DEG } from '../src/core/geom.js';

const P = (p) => ({ x: p.x, y: p.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const midOf = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (v) => Math.hypot(v.x, v.y);
const polar = (c, r, rad) => ({ x: c.x + r * Math.cos(rad), y: c.y + r * Math.sin(rad) });

function arcMid(e) { const a0 = e.a0 * DEG; return polar(e.c, e.r, a0 + ccwSweep(a0, e.a1 * DEG) / 2); }
/** ARC (degrees, CCW) through start a, point m on the arc, end b; null when collinear */
export function arcThrough(a, m, b) {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, m2 = m.x * m.x + m.y * m.y, b2 = b.x * b.x + b.y * b.y;
  const c = { x: (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d, y: (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d };
  const ang = (q) => Math.atan2(q.y - c.y, q.x - c.x) / DEG;
  const ccw = (m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x) > 0; // a->m->b turns left
  return { c, r: len(sub(a, c)), a0: ccw ? ang(a) : ang(b), a1: ccw ? ang(b) : ang(a) };
}
/** bulge of the polyline segment a->b passing through p */
export function bulgeThrough(a, b, p) {
  const u = sub(a, p), v = sub(b, p);
  const inner = Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (len(u) * len(v) || 1))));
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return (cross < 0 ? 1 : -1) * Math.tan((2 * (Math.PI - inner)) / 4);
}
function segMid(a, b) {
  if (!a.bulge) return midOf(a, b);
  const k = bulgeToArc(a, b, a.bulge);
  return polar(k.c, k.r, k.a0 + k.sweep / 2);
}

const DIM_KEYS = { linear: ['p1', 'p2', 'at'], aligned: ['p1', 'p2', 'at'], angular3: ['vertex', 'p1', 'p2', 'at'], radius: ['center', 'p'], diameter: ['center', 'p'] };
function dimRefs(def) {
  if (def.kind === 'angular') return [[def.l1, 0], [def.l1, 1], [def.l2, 0], [def.l2, 1], [def, 'at']];
  return (DIM_KEYS[def.kind] ?? []).filter((k) => def[k]).map((k) => [def, k]);
}

export function gripsOf(e) {
  const g = (p, kind) => ({ x: p.x, y: p.y, kind });
  switch (e.type) {
    case 'LINE': return [g(e.p1, 'end'), g(e.p2, 'end'), g(midOf(e.p1, e.p2), 'mid')];
    case 'LWPOLYLINE': {
      const v = e.vertices, n = v.length, segs = e.closed ? n : n - 1;
      const out = v.map((q) => g(q, 'vtx'));
      for (let i = 0; i < segs; i++) out.push(g(segMid(v[i], v[(i + 1) % n]), 'seg'));
      return out;
    }
    case 'CIRCLE': return [g(e.c, 'cen'), ...[0, 1, 2, 3].map((k) => g(polar(e.c, e.r, (k * Math.PI) / 2), 'quad'))];
    case 'ARC': return [g(polar(e.c, e.r, e.a0 * DEG), 'end'), g(polar(e.c, e.r, e.a1 * DEG), 'end'), g(arcMid(e), 'mid'), g(e.c, 'cen')];
    case 'ELLIPSE': {
      const mn = { x: -e.major.y * e.ratio, y: e.major.x * e.ratio };
      return [g(e.c, 'cen'), g(add(e.c, e.major), 'axis'), g(sub(e.c, e.major), 'axis'), g(add(e.c, mn), 'axis'), g(sub(e.c, mn), 'axis')];
    }
    case 'TEXT': case 'MTEXT': case 'INSERT': case 'POINT': return [g(e.p, 'ins')];
    case 'LEADER': return e.pts.map((q) => g(q, 'vtx'));
    case 'DIMENSION': {
      if (!e.def) return [];
      const out = dimRefs(e.def).map(([o, k]) => g(o[k], 'def'));
      if (e.p) out.push(g(e.p, 'text'));
      return out;
    }
    default: return []; // HATCH, SPLINE, SOLID: no grips yet
  }
}

/** edited copy of e with grip i moved to p */
export function applyGrip(e, i, p) {
  const c = structuredClone(e);
  delete c.parent;
  const grips = gripsOf(e);
  if (!grips[i]) return null;
  const d = sub(p, grips[i]);
  const shift = (q) => add(q, d);
  switch (e.type) {
    case 'LINE':
      if (i === 0) c.p1 = P(p); else if (i === 1) c.p2 = P(p); else { c.p1 = shift(e.p1); c.p2 = shift(e.p2); }
      return c;
    case 'LWPOLYLINE': {
      const n = e.vertices.length;
      if (i < n) { Object.assign(c.vertices[i], P(p)); return c; }
      const s = i - n, a = c.vertices[s], b = c.vertices[(s + 1) % n];
      if (a.bulge) { a.bulge = bulgeThrough(a, b, p); return c; }
      Object.assign(a, shift(a)); Object.assign(b, shift(b));
      return c;
    }
    case 'CIRCLE':
      if (i === 0) c.c = P(p); else { c.r = len(sub(p, e.c)); if (c.r < 1e-12) return null; }
      return c;
    case 'ARC': {
      if (i === 3) { c.c = P(p); return c; }
      const [s, en, m] = grips;
      let k = null;
      if (i === 0) k = arcThrough(p, m, en);
      else if (i === 1) k = arcThrough(s, m, p);
      else if (i === 2) k = arcThrough(s, p, en); // midpoint: keep both ends, change the radius
      return k ? Object.assign(c, k) : null;
    }
    case 'ELLIPSE': {
      if (i === 0) { c.c = P(p); return c; }
      const R = len(e.major), minor = R * e.ratio;
      if (i <= 2) {
        const v = sub(p, e.c), L = len(v);
        if (L < 1e-12) return null;
        c.major = i === 1 ? v : { x: -v.x, y: -v.y };
        c.ratio = minor / L;
      } else c.ratio = len(sub(p, e.c)) / R;
      if (c.ratio > 1 || c.ratio < 1e-9) return null;
      return c;
    }
    case 'TEXT': case 'MTEXT': case 'INSERT': case 'POINT':
      c.p = P(p); return c;
    case 'LEADER':
      c.pts[i] = P(p); return c;
    case 'DIMENSION': {
      const refs = dimRefs(c.def);
      if (i < refs.length) { const [o, k] = refs[i]; o[k] = P(p); } else c.def.at = shift(e.def.at); // text grip moves the dimension line
      return c;
    }
    default: return null;
  }
}

function freshDimBlock(doc) {
  const used = new Set([...doc.blocks.keys()].map((k) => k.toUpperCase()));
  let n = 1; while (used.has(`*D${n}`)) n++;
  return `*D${n}`;
}

/** replace entity `id` by fn(copy) as one undo step; returns true when something changed */
export function editEntity(s, id, fn, label = 'Properties') {
  const e = getEntity(s.doc, id);
  if (!e) return false;
  const c = fn(structuredClone(e));
  if (!c) return false;
  c.id = e.id;
  if (c.type === 'DIMENSION' && c.def) { c.block = freshDimBlock(s.doc); regenerateDimension(s.doc, c); } // old block stays for undo
  s.transact(label, (tx) => { tx.replace(c); });
  return true;
}

export const gripEdit = (s, id, i, p) => editEntity(s, id, (c) => applyGrip(c, i, p), 'Grip edit');

export const MATCH_KEYS = ['layer', 'color', 'linetype', 'ltscale', 'lineweight'];
export function matchProps(src, dst) {
  const c = structuredClone(dst);
  for (const k of MATCH_KEYS) if (k in src) c[k] = structuredClone(src[k]);
  const isText = (x) => x.type === 'TEXT' || x.type === 'MTEXT';
  if (isText(src) && isText(dst)) { c.height = src.height; if (src.style) c.style = src.style; }
  if (src.type === 'DIMENSION' && dst.type === 'DIMENSION' && src.style) c.style = src.style;
  return c;
}
