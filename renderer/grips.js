// ASH Draw Studio - grips (AutoCAD-style editing handles) and property edits. Pure: no DOM, runs in Node.
//
//   gripsOf(e)                 -> [{x, y, kind}]   kind: end | mid | vtx | seg | cen | quad | axis | ins | def | text
//   applyGrip(e, i, p)         -> edited COPY of e with grip i dragged to p (null when the edit is impossible)
//   gripEdit(session, id, i, p)-> one undo step; DIMENSIONs are regenerated into a fresh *D block
//   gripsStretch(session, [{id,i}], d) -> several grips moved by d, one undo step
//   editEntity(session, id, fn, label) -> one undo step replacing the entity by fn(copy)
//   matchPropsEdit(session, src, ids, settings) -> MATCHPROP as one undo step (dimensions get a regenerated block)
//   matchProps(src, dst, settings) -> copy of dst carrying the property groups of src that `settings` (MATCH_SETTINGS keys) leave on
//   GRIP_MODES / nextGripMode(m) / gripMatrix(mode, base, arg) / gripModeEdit(s, ids, mode, base, arg, opts) -> grip MOVE/ROTATE/SCALE/MIRROR
import { getEntity } from '../src/core/model.js';
import { transformEntities } from '../src/core/edit.js';
import { regenerateDimension, rebuildDimension } from '../src/core/dims.js';
import { bulgeToArc, ccwSweep, DEG, compose, translation, rotation, scaling, invert, transformEntity, mirrorLine } from '../src/core/geom.js';

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

const DIM_KEYS = { linear: ['p1', 'p2', 'at'], aligned: ['p1', 'p2', 'at'], angular3: ['vertex', 'p1', 'p2', 'at'], radius: ['center', 'p'], ordinate: ['feature', 'end'], diameter: ['center', 'p'] };
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
    case 'TEXT': case 'MTEXT': case 'INSERT': case 'POINT': return e.p2 ? [g(e.p, 'ins'), g(e.p2, 'ins')] : [g(e.p, 'ins')];
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
      if (i === 1 && c.p2) c.p2 = P(p); else c.p = P(p);
      return c;
    case 'LEADER':
      c.pts[i] = P(p); return c;
    case 'DIMENSION': {
      const refs = dimRefs(c.def);
      if (i < refs.length) { const [o, k] = refs[i]; o[k] = P(p); } else if (c.def.kind === 'ordinate') c.def.end = shift(e.def.end); else c.def.at = shift(e.def.at); // text grip moves the dimension line (ordinate: the leader end)
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

const insertFrame = (i) => compose(translation(i.p.x, i.p.y), compose(rotation((i.rot || 0) * DEG), scaling(i.sx ?? 1, i.sy ?? 1)));
/** An INSERT whose position, scale or rotation was set directly: move its ATTRIBs from the old frame to the new one. */
export function carryAttribs(old, c) {
  const a = insertFrame(old), b = insertFrame(c);
  if (a.every((v, k) => v === b[k]) || !(Math.abs(a[0] * a[3] - a[1] * a[2]) > 1e-12)) return c;
  const m = compose(b, invert(a));
  c.attribs = old.attribs.map((at) => transformEntity(at, m));
  return c;
}

/** replace entity `id` by fn(copy) as one undo step; returns true when something changed */
export function editEntity(s, id, fn, label = 'Properties') {
  const e = getEntity(s.doc, id);
  if (!e) return false;
  const c = fn(structuredClone(e));
  if (!c) return false;
  c.id = e.id;
  if (c.type === 'DIMENSION' && c.def) { c.block = freshDimBlock(s.doc); regenerateDimension(s.doc, c); } // old block stays for undo
  if (c.type === 'INSERT' && e.attribs?.length) carryAttribs(e, c);
  s.transact(label, (tx) => { tx.replace(c); });
  return true;
}

/** STRETCH several hot grips by the same displacement d, as ONE undo step. picks = [{id, i}]; false when any edit is impossible. */
export function gripsStretch(s, picks, d) {
  const byId = new Map();
  for (const { id, i } of picks) { if (!byId.has(id)) byId.set(id, []); byId.get(id).push(i); }
  const out = [];
  for (const [id, idx] of byId) {
    const e = getEntity(s.doc, id);
    if (!e) return false;
    let c = e;
    for (const i of idx) {
      const g = gripsOf(c)[i];
      c = g && applyGrip(c, i, add(g, d));
      if (!c) return false;
    }
    c.id = e.id;
    if (c.type === 'DIMENSION' && c.def) { c.block = freshDimBlock(s.doc); regenerateDimension(s.doc, c); }
    if (c.type === 'INSERT' && e.attribs?.length) carryAttribs(e, c);
    out.push(c);
  }
  if (!out.length) return false;
  s.transact('Grip stretch', (tx) => { for (const c of out) tx.replace(c); });
  return true;
}

export const gripEdit = (s, id, i, p) => editEntity(s, id, (c) => applyGrip(c, i, p), 'Grip edit');

// ---- grip modes (AutoCAD: Space / Enter cycles STRETCH -> MOVE -> ROTATE -> SCALE -> MIRROR) ------------------
export const GRIP_MODES = ['STRETCH', 'MOVE', 'ROTATE', 'SCALE', 'MIRROR'];
export const nextGripMode = (m) => GRIP_MODES[(GRIP_MODES.indexOf(m) + 1) % GRIP_MODES.length];
/** transform of a grip mode about `base`. arg = {p} (picked point) or {value} (typed: degrees for ROTATE, factor for SCALE).
 *  MOVE: base -> p; ROTATE: angle base->p; SCALE: distance base-p is the factor (unit reference, as AutoCAD); MIRROR: line base-p.
 *  null when degenerate. */
export function gripMatrix(mode, base, arg) {
  const p = arg.p, v = arg.value;
  switch (mode) {
    case 'MOVE': return p ? translation(p.x - base.x, p.y - base.y) : null;
    case 'ROTATE': {
      const rad = v != null ? v * DEG : p && Math.hypot(p.x - base.x, p.y - base.y) > 1e-12 ? Math.atan2(p.y - base.y, p.x - base.x) : null;
      return rad == null ? null : rotation(rad, base.x, base.y);
    }
    case 'SCALE': {
      const k = v != null ? v : p ? Math.hypot(p.x - base.x, p.y - base.y) : 0;
      return k > 1e-12 && Number.isFinite(k) ? scaling(k, k, base.x, base.y) : null;
    }
    case 'MIRROR': return p && Math.hypot(p.x - base.x, p.y - base.y) > 1e-12 ? mirrorLine(base, p) : null;
    default: return null;
  }
}
const MODE_LABEL = { MOVE: 'Grip move', ROTATE: 'Grip rotate', SCALE: 'Grip scale', MIRROR: 'Grip mirror' };
/** apply a grip mode to `ids`. copy keeps the originals. join = step id returned by an earlier call of the same grip
 *  command: the new changes are folded into that undo step (so one U removes every copy of the command).
 *  -> { done, failed, created, step } | null when the transform is degenerate */
export function gripModeEdit(s, ids, mode, base, arg, { copy = false, join = null } = {}) {
  const m = gripMatrix(mode, base, arg);
  if (!m) return null;
  const prev = s.undoStack.at(-1);
  const r = transformEntities(s, ids, m, { copy, label: MODE_LABEL[mode] });
  const last = s.undoStack.at(-1);
  if (join != null && prev?.id === join && last !== prev) { s.undoStack.pop(); prev.ops.push(...last.ops); return { ...r, step: prev.id }; }
  return { ...r, step: last === prev ? join : last.id };
}

// ---- MATCHPROP ------------------------------------------------------------------------------------------------
/** MATCHPROP Settings groups: [key, label]. All on by default. The model has no transparency or table entities. */
export const MATCH_SETTINGS = [
  ['color', 'Colour'], ['layer', 'Layer'], ['linetype', 'Linetype'], ['ltscale', 'Linetype scale'], ['lineweight', 'Lineweight'],
  ['thickness', 'Thickness'], ['text', 'Text (style, height, oblique, width)'], ['dim', 'Dimension (dimstyle)'],
  ['hatch', 'Hatch (pattern, scale, angle)'], ['polyline', 'Polyline (width, closed)'], ['mleader', 'Multileader (style, arrow, landing, text height)'],
];
export const defaultMatchSettings = () => Object.fromEntries(MATCH_SETTINGS.map(([k]) => [k, true]));
const BASIC = ['color', 'layer', 'linetype', 'ltscale', 'lineweight', 'thickness'];
const GROUPS = {
  text: { when: (t) => t === 'TEXT' || t === 'MTEXT', keys: ['style', 'height', 'oblique', 'widthFactor'] },
  dim: { when: (t) => t === 'DIMENSION', keys: ['style'] },
  hatch: { when: (t) => t === 'HATCH', keys: ['pattern', 'solid', 'scale', 'angle', 'patLines'], drop: ['patLines'] },
  polyline: { when: (t) => t === 'LWPOLYLINE', keys: ['width', 'closed'], drop: ['width'] },
  mleader: { when: (t) => t === 'MLEADER', keys: ['style', 'arrowSize', 'landingGap', 'textHeight', 'arrow', 'dogleg'] },
};
export const MATCH_KEYS = BASIC;
export function matchProps(src, dst, settings = defaultMatchSettings()) {
  const c = structuredClone(dst);
  for (const k of BASIC) if (settings[k] && k in src) c[k] = structuredClone(src[k]);
  for (const [g, d] of Object.entries(GROUPS)) {
    if (!settings[g] || !d.when(src.type) || !d.when(dst.type)) continue;
    for (const k of d.keys) {
      if (k in src) c[k] = structuredClone(src[k]);
      else if (d.drop?.includes(k)) delete c[k]; // e.g. a hatch pattern's own line table belongs to the old pattern
    }
  }
  return c;
}

/** MATCHPROP on `ids` as one undo step. A dimension whose style changed gets its block rebuilt (into a fresh *D block) so it looks the part. */
export function matchPropsEdit(s, src, ids, settings = defaultMatchSettings()) {
  return s.transact('Match properties', (tx) => {
    for (const id of ids) {
      const e = getEntity(s.doc, id);
      if (!e) continue;
      let c = matchProps(src, e, settings);
      if (c.type === 'DIMENSION' && c.def && c.style !== e.style) c = rebuildDimension(s.doc, c);
      tx.replace(c);
    }
  });
}
