// Pure logic of the command-line view and inquiry commands (ZOOM options and its Previous stack, ID, LIST).
import { formatNumber, formatLength, loopMeasure, entityMeasure } from './measure.js';
import { bboxOf } from './geom.js';

/** views kept per drawing space for ZOOM Previous (AutoCAD keeps 10) */
export const VIEW_HISTORY_LIMIT = 10;
/** view changes closer together than this are one gesture (one wheel roll, one pan drag) = one Previous entry */
export const VIEW_GESTURE_MS = 400;

const sameView = (a, b) => !!a && !!b && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
const plain = (v) => ({ cx: v.cx, cy: v.cy, zoom: v.zoom });

/** ZOOM Previous: a stack of earlier views per space key (tab + model / layout / viewport). Feed it every view
 *  change with observe(); the view a change starts from is pushed once per gesture. */
export class ViewHistory {
  constructor({ limit = VIEW_HISTORY_LIMIT, gestureMs = VIEW_GESTURE_MS } = {}) { this.limit = limit; this.gestureMs = gestureMs; this.spaces = new Map(); }
  _s(key) { let s = this.spaces.get(key); if (!s) this.spaces.set(key, (s = { stack: [], cur: null, t: -Infinity })); return s; }
  /** the view of space `key` is now `view` (time `now` in ms) */
  observe(key, view, now) {
    const s = this._s(key);
    if (s.cur && !sameView(s.cur, view) && now - s.t > this.gestureMs) {
      s.stack.push(s.cur);
      if (s.stack.length > this.limit) s.stack.shift();
    }
    if (!sameView(s.cur, view)) s.t = now;
    s.cur = plain(view);
  }
  /** a zoom command follows: its change is a new entry even right after a wheel gesture */
  breakGesture(key) { this._s(key).t = -Infinity; }
  /** the earlier view to go back to (taken off the stack), or null; the caller then shows it */
  previous(key, now = 0) {
    const s = this._s(key);
    let v;
    while ((v = s.stack.pop()) && sameView(v, s.cur));
    if (!v) return null;
    s.cur = v; s.t = now;
    return { ...v };
  }
  size(key) { return this._s(key).stack.length; }
}

/** a ZOOM option typed at the prompt -> { opt } | { scale, paper } | null */
export function parseZoomInput(str) {
  const s = String(str).trim().toLowerCase();
  const opts = { a: 'all', all: 'all', e: 'extents', extents: 'extents', w: 'window', window: 'window', p: 'previous', previous: 'previous', o: 'object', object: 'object' };
  if (opts[s]) return { opt: opts[s] };
  const m = /^([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(xp|x)$/.exec(s.replace(',', '.'));
  if (!m) return null;
  const k = Number(m[1]);
  return k > 0 && Number.isFinite(k) ? { scale: k, paper: m[2] === 'xp' } : null;
}

/** union of the bounding boxes of entities -> {minx, miny, maxx, maxy} or null */
export function entitiesBox(entities, doc) {
  let b = null;
  for (const e of entities) {
    const eb = bboxOf(e, doc);
    if (!eb) continue;
    b = b ? { minx: Math.min(b.minx, eb.minx), miny: Math.min(b.miny, eb.miny), maxx: Math.max(b.maxx, eb.maxx), maxy: Math.max(b.maxy, eb.maxy) } : { ...eb };
  }
  return b;
}

/** ID: the point as the drawing labels lengths ($LUPREC) */
export const formatId = (p, prec) => `X = ${formatNumber(p.x, prec)}   Y = ${formatNumber(p.y, prec)}`;

const COLOR_NAMES = { 0: 'ByBlock', 256: 'ByLayer', 1: 'red', 2: 'yellow', 3: 'green', 4: 'cyan', 5: 'blue', 6: 'magenta', 7: 'white' };
function colorText(c) {
  if (c == null) return 'ByLayer';
  if (typeof c === 'object') return c.rgb != null ? `RGB ${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}` : JSON.stringify(c);
  return COLOR_NAMES[c] ? (c > 0 && c < 256 ? `${c} (${COLOR_NAMES[c]})` : COLOR_NAMES[c]) : String(c);
}
const DEG = 180 / Math.PI;
const ang = (rad) => `${formatNumber((((rad * DEG) % 360) + 360) % 360, 4)}°`;
const angDeg = (d) => `${formatNumber(((d % 360) + 360) % 360, 4)}°`;

/** polyline length (bulges as arcs) */
function plineLength(vs, closed) {
  let len = 0;
  for (let i = 0; i < (closed ? vs.length : vs.length - 1); i++) {
    const p = vs[i], q = vs[(i + 1) % vs.length], c = Math.hypot(q.x - p.x, q.y - p.y), b = p.bulge || 0;
    if (!b || !c) { len += c; continue; }
    const th = 4 * Math.atan(Math.abs(b));
    len += (th * c) / (2 * Math.sin(th / 2));
  }
  return len;
}

/** LIST: the text block for one entity. `u` = { prec, units } of the drawing (as the Measure tool labels values). */
export function listEntity(e, doc, { prec = 4, units = 0 } = {}) {
  const L = (v) => formatLength(v, prec, units), N = (v) => formatNumber(v, prec), A = (v) => formatLength(v, prec, units, 2);
  const P = (p) => `X = ${N(p.x)}  Y = ${N(p.y)}`;
  const out = [`${e.type}   Layer: "${e.layer ?? '0'}"`, `    Handle = ${String(e.handle ?? (e.id ?? 0).toString(16)).toUpperCase()}`,
    `    Color = ${colorText(e.color)}   Linetype = ${e.linetype ?? 'BYLAYER'}`];
  switch (e.type) {
    case 'LINE': {
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      out.push(`    from point, ${P(e.p1)}`, `    to point,   ${P(e.p2)}`, `    Length = ${L(Math.hypot(dx, dy))},  Angle in XY plane = ${ang(Math.atan2(dy, dx))}`, `    Delta X = ${N(dx)},  Delta Y = ${N(dy)}`);
      break;
    }
    case 'CIRCLE':
      out.push(`    center point, ${P(e.c)}`, `    radius ${L(e.r)}`, `    circumference ${L(2 * Math.PI * e.r)}`, `    area ${A(Math.PI * e.r * e.r)}`);
      break;
    case 'ARC': {
      const sweep = ((((e.a1 - e.a0) % 360) + 360) % 360) || 360;
      out.push(`    center point, ${P(e.c)}`, `    radius ${L(e.r)}`, `    start angle ${angDeg(e.a0)}`, `    end angle ${angDeg(e.a1)}`, `    length ${L((sweep / DEG) * e.r)}`);
      break;
    }
    case 'LWPOLYLINE': {
      const vs = e.vertices ?? [];
      out.push(`    ${e.closed ? 'Closed' : 'Open'},  ${vs.length} vertices`, `    length ${L(vs.length > 1 ? plineLength(vs, e.closed) : 0)}`);
      if (e.closed && vs.length > 2) out.push(`    area ${A(loopMeasure(vs).area)}`);
      vs.slice(0, 50).forEach((v) => out.push(`    at point ${P(v)}${v.bulge ? `  bulge ${N(v.bulge)}` : ''}`));
      if (vs.length > 50) out.push(`    … ${vs.length - 50} more vertices`);
      break;
    }
    case 'TEXT': case 'MTEXT':
      out.push(`    ${e.type === 'TEXT' ? 'start point' : 'location'}, ${P(e.p)}`, `    height ${L(e.height)}`, `    text "${e.text}"`, `    rotation angle ${angDeg(e.rot ?? 0)}`);
      break;
    case 'INSERT':
      out.push(`    block name "${e.block}"`, `    at point ${P(e.p)}`, `    X scale factor ${N(e.sx ?? 1)}`, `    Y scale factor ${N(e.sy ?? 1)}`, `    rotation angle ${angDeg(e.rot ?? 0)}`);
      break;
    default: {
      const m = entityMeasure(e);
      if (m) out.push(`    area ${A(m.area)}`, `    perimeter ${L(m.perimeter)}`);
    }
  }
  if (!['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'TEXT', 'MTEXT', 'INSERT'].includes(e.type)) {
    const b = bboxOf(e, doc);
    if (b) out.push(`    extents min ${P({ x: b.minx, y: b.miny })}`, `    extents max ${P({ x: b.maxx, y: b.maxy })}`);
  }
  return out.join('\n');
}

/** LTSCALE: set $LTSCALE of `target` (the whole drawing) as one undo step; false when unchanged or invalid */
export function setLinetypeScale(s, ltscale, target = s.doc) {
  if (!(ltscale > 0) || !Number.isFinite(ltscale) || (target.header?.ltscale || 1) === ltscale) return false;
  s.transact('LTSCALE', (tx) => tx.header({ ltscale }, target));
  return true;
}

/** LIST of several entities */
export const listEntities = (entities, doc, u) => entities.map((e) => listEntity(e, doc, u)).join('\n\n');
