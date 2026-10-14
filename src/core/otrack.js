// Object snap tracking (OTRACK) and the Extension object snap: the extension paths of LINE / ARC ends, the tracking
// lines through acquired points, and the snap point on them. Pure module: world coordinates (Y up).
import { ccwSweep, DEG } from './geom.js';

const TAU = Math.PI * 2;
/** at most this many acquired points; acquiring one more drops the oldest */
export const MAX_ACQUIRED = 7;
/** snap kinds whose point can be acquired for tracking (not the moving / path ones) */
export const ACQUIRE_KINDS = new Set(['end', 'mid', 'cen', 'gcen', 'node', 'quad', 'int', 'ins', 'per', 'tan']);

const unit = (x, y) => { const l = Math.hypot(x, y); return l > 0 ? { x: x / l, y: y / l } : null; };
const deg360 = (d) => ((Math.atan2(d.y, d.x) / DEG) % 360 + 360) % 360;

/** The ends of a LINE / ARC with their extension paths: [{at, path}]. A line path is {from, dir} (dir: outward unit);
 *  an arc path is {from, c, r, a0, sweep, ccw} (the circle beyond the arc; ccw: the end the path leaves from). */
export function extensionEnds(e) {
  if (e.type === 'LINE') {
    const out = [], u = unit(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
    if (!u) return out;
    out.push({ at: { ...e.p1 }, path: { from: { ...e.p1 }, dir: { x: -u.x, y: -u.y } } });
    out.push({ at: { ...e.p2 }, path: { from: { ...e.p2 }, dir: u } });
    return out;
  }
  if (e.type !== 'ARC' || !(e.r > 0)) return [];
  const a0 = e.a0 * DEG, sweep = ccwSweep(a0, e.a1 * DEG), a1 = a0 + sweep;
  if (!(sweep < TAU - 1e-12)) return [];
  const pt = (a) => ({ x: e.c.x + e.r * Math.cos(a), y: e.c.y + e.r * Math.sin(a) });
  return [
    { at: pt(a0), path: { from: pt(a0), c: { ...e.c }, r: e.r, a0, sweep, ccw: false } },
    { at: pt(a1), path: { from: pt(a1), c: { ...e.c }, r: e.r, a0, sweep, ccw: true } },
  ];
}

/** p projected onto an extension path (beyond the end only: past a line's end, on an arc's circle outside its sweep),
 *  when within tol of it; else null. */
export function extensionPoint(path, p, tol) {
  if (path.dir) {
    const { from: f, dir: u } = path, t = (p.x - f.x) * u.x + (p.y - f.y) * u.y;
    if (!(t > 0)) return null;
    const q = { x: f.x + t * u.x, y: f.y + t * u.y };
    return Math.hypot(p.x - q.x, p.y - q.y) <= tol ? q : null;
  }
  const dx = p.x - path.c.x, dy = p.y - path.c.y, d = Math.hypot(dx, dy);
  if (!(d > 0) || Math.abs(d - path.r) > tol) return null;
  let t = (Math.atan2(dy, dx) - path.a0) % TAU;
  if (t < 0) t += TAU;
  if (t <= path.sweep + 1e-9 || t >= TAU - 1e-9) return null; // on the arc itself
  return { x: path.c.x + (dx / d) * path.r, y: path.c.y + (dy / d) * path.r };
}

/** Tracking line angles in degrees within [0,180): horizontal and vertical, or every polar angle when polar is on. */
export function trackAngles(polar, step, extra = []) {
  const s = new Set([0, 90]);
  if (polar && step > 0) for (let a = 0; a < 180 - 1e-9; a += step) s.add(Math.round(a * 1e9) / 1e9);
  if (polar) for (const x of extra) s.add(Math.round(((((x % 180) + 180) % 180)) * 1e9) / 1e9);
  return [...s].sort((a, b) => a - b);
}

/** p projected onto the tracking line through `from` at `deg`: {x, y, d (off the line), t (along it), dir} */
export function projectOnTrack(from, deg, p) {
  const dir = { x: Math.cos(deg * DEG), y: Math.sin(deg * DEG) };
  const t = (p.x - from.x) * dir.x + (p.y - from.y) * dir.y;
  const x = from.x + t * dir.x, y = from.y + t * dir.y;
  return { x, y, d: Math.hypot(p.x - x, p.y - y), t, dir };
}

/** Crossing of the tracking lines (a at da°) and (b at db°), or null when they are parallel. */
export function trackIntersection(a, da, b, db) {
  const u = { x: Math.cos(da * DEG), y: Math.sin(da * DEG) }, v = { x: Math.cos(db * DEG), y: Math.sin(db * DEG) };
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 1e-12) return null;
  const s = ((b.x - a.x) * v.y - (b.y - a.y) * v.x) / den;
  return { x: a.x + s * u.x, y: a.y + s * u.y };
}

/** the snap result on one straight path from `from` through q: carries the direction for direct distance entry */
function along(kind, from, q, extra) {
  const dir = unit(q.x - from.x, q.y - from.y);
  return { x: q.x, y: q.y, kind, from: { ...from }, dist: Math.hypot(q.x - from.x, q.y - from.y), angle: dir ? deg360(dir) : 0, ...(dir && { track: { from: { ...from }, dir } }), ...extra };
}

/** Tracking / extension snap near p, or null. acq: acquired points [{at, path?}]; opts: {otrack, ext, angles}.
 *  Order: the crossing of two tracking lines from different acquired points, then the nearest tracking line or
 *  extension path; each only within tol of p. */
export function trackingSnap(acq, p, tol, { otrack = false, ext = false, angles = [0, 90] } = {}) {
  let best = null;
  const offer = (r, d) => { if (!best || d < best.d) best = { r, d }; };
  if (otrack) {
    const lines = [];
    for (const a of acq) for (const g of angles) { const q = projectOnTrack(a.at, g, p); if (q.d <= tol) lines.push({ a, g, q }); }
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const l = lines[i], m = lines[j];
      if (l.a === m.a) continue;
      const x = trackIntersection(l.a.at, l.g, m.a.at, m.g);
      const d = x ? Math.hypot(x.x - p.x, x.y - p.y) : Infinity;
      if (d <= tol && (!best || d < best.d)) best = { r: { x: x.x, y: x.y, kind: 'trackint', lines: [{ from: { ...l.a.at }, deg: l.g }, { from: { ...m.a.at }, deg: m.g }] }, d };
    }
    if (best) return best.r;
    for (const { a, g, q } of lines) if (Math.abs(q.t) > 1e-12) offer(along('track', a.at, q, { deg: g }), q.d);
  }
  if (ext) for (const a of acq) {
    if (!a.path) continue;
    const q = extensionPoint(a.path, p, tol);
    if (q) offer(a.path.dir ? along('ext', a.at, q, { path: a.path }) : { ...along('ext', a.at, q, { path: a.path }), track: undefined }, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return best?.r ?? null;
}

/** AutoCAD's order: an object snap marker under the cursor beats any tracking or extension path. */
export function resolveTracking(osnap, acq, p, tol, opts) {
  return osnap || (acq.length ? trackingSnap(acq, p, tol, opts) : null);
}

/** Add `cand` ({at, path?}) to the acquired list, or remove it when that point is already acquired (hovering it again);
 *  at most MAX_ACQUIRED, the oldest dropped. Returns the new list. */
export function toggleAcquired(list, cand, eps = 1e-9) {
  const i = list.findIndex((a) => Math.hypot(a.at.x - cand.at.x, a.at.y - cand.at.y) <= eps);
  if (i >= 0) return list.filter((_, k) => k !== i);
  return [...list, cand].slice(-MAX_ACQUIRED);
}

/** the acquired points whose source entity (`id`, when known) still exists — an extension path of a line whose
 *  creation was undone, or which was erased, is dropped */
export const pruneAcquired = (list, exists) => (list.some((a) => a.id != null && !exists(a.id)) ? list.filter((a) => a.id == null || exists(a.id)) : list);

/** the tooltip of a tracking / extension snap: "Extension: 1234.5 < 0°" */
export function trackLabel(m, fmt = (v) => String(+v.toFixed(4))) {
  if (m.kind === 'trackint') return `Tracking: <${fmt(m.lines[0].deg)}°, <${fmt(m.lines[1].deg)}°`;
  return `${m.kind === 'ext' ? 'Extension' : 'Tracking'}: ${fmt(m.dist)} < ${fmt(m.angle)}°`;
}
