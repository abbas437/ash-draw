// Object snap modes beyond the entity snap points: the running-snap mode list (OSNAP dialog), tangent points,
// parallel tracking, geometric centre of closed polylines and the per-mode marker glyphs.
// Pure module: world coordinates (Y up).
import { bulgeToArc, ccwSweep, DEG } from './geom.js';

const TAU = Math.PI * 2;

/** the running object snap modes in dialog order: [kind, label, implemented] */
export const OSNAP_MODES = [
  ['end', 'Endpoint', true], ['mid', 'Midpoint', true], ['cen', 'Center', true], ['gcen', 'Geometric center', true],
  ['node', 'Node', true], ['quad', 'Quadrant', true], ['int', 'Intersection', true], ['ext', 'Extension', false],
  ['ins', 'Insertion', true], ['per', 'Perpendicular', true], ['tan', 'Tangent', true], ['near', 'Nearest', true],
  ['app', 'Apparent intersection', false], ['par', 'Parallel', true],
];
export const OSNAP_LABEL = Object.fromEntries(OSNAP_MODES.map(([k, l]) => [k, l]));
/** the kinds a saved 'osnap.modes' value may hold: implemented modes only */
export function cleanModes(v) {
  const ok = new Set(OSNAP_MODES.filter((m) => m[2]).map((m) => m[0]));
  return Array.isArray(v) ? [...new Set(v.filter((k) => ok.has(k)))] : null;
}

/** polar tracking increments offered (degrees) */
export const POLAR_STEPS = [90, 45, 30, 22.5, 18, 15, 10, 5];
/** additional polar angles typed as "12.5, 80" -> [12.5, 80] (normalised to [0,360)); bad items are dropped */
export function parseAngles(s) {
  return [...new Set(String(s ?? '').split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite).map((a) => ((a % 360) + 360) % 360))];
}

/** Points on a CIRCLE / ARC where a line from `from` touches it (0, 1 or 2; an ARC only within its sweep). */
export function tangentPoints(e, from) {
  if (e.type !== 'CIRCLE' && e.type !== 'ARC') return [];
  const dx = from.x - e.c.x, dy = from.y - e.c.y, d = Math.hypot(dx, dy);
  if (!(d > e.r)) return [];
  const base = Math.atan2(dy, dx), off = Math.acos(e.r / d);
  const out = [];
  for (const a of [base + off, base - off]) {
    if (e.type === 'ARC') {
      const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
      let t = (a - a0) % TAU;
      if (t < 0) t += TAU;
      if (t > sw + 1e-12) continue;
    }
    out.push({ x: e.c.x + e.r * Math.cos(a), y: e.c.y + e.r * Math.sin(a) });
  }
  return out;
}

/** Parallel snap: p projected onto the line through `from` with direction `dir` (unit or not), when within tol of it. */
export function parallelPoint(from, p, dir, tol) {
  const l = Math.hypot(dir.x, dir.y);
  if (!(l > 0)) return null;
  const ux = dir.x / l, uy = dir.y / l;
  const t = (p.x - from.x) * ux + (p.y - from.y) * uy;
  const q = { x: from.x + t * ux, y: from.y + t * uy };
  return Math.hypot(p.x - q.x, p.y - q.y) <= tol && Math.abs(t) > 0 ? q : null;
}

/** Unit direction of the straight piece of `e` nearest p (LINE, XLINE, RAY, a straight LWPOLYLINE segment), or null. */
export function directionAt(e, p) {
  const unit = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy); return l > 0 ? { x: dx / l, y: dy / l } : null; };
  if (e.type === 'LINE') return unit(e.p1, e.p2);
  if (e.type === 'XLINE' || e.type === 'RAY') return unit({ x: 0, y: 0 }, e.dir);
  if (e.type !== 'LWPOLYLINE') return null;
  const v = e.vertices, m = e.closed ? v.length : v.length - 1;
  let best = null, bd = Infinity;
  for (let i = 0; i < m; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    if (d < bd) { bd = d; best = a.bulge && Math.abs(a.bulge) > 1e-12 ? null : unit(a, b); }
  }
  return best;
}

/** Area centroid of a closed LWPOLYLINE (bulged segments included, exact), or null (open, or no area).
 *  Green's theorem: A = ∮x dy, Cx = ∮x² dy / 2A, Cy = -∮y² dx / 2A. */
export function geometricCenter(e) {
  if (e.type !== 'LWPOLYLINE' || !e.closed || e.vertices.length < 2) return null;
  if (gcenCache.has(e)) return gcenCache.get(e);
  const r = computeGeometricCenter(e);
  gcenCache.set(e, r);
  return r;
}

/** entity object -> centre|null; edits replace the entity object (as for the bbox cache in pick.js), so a changed entity misses */
const gcenCache = new WeakMap();
const SELF_X_MAX = 500; // above this many segments the self-intersection check is skipped

/** true when two non-adjacent segments of the closed outline (bulges taken as chords) properly cross */
function selfIntersects(v) {
  const n = v.length;
  if (n < 4 || n > SELF_X_MAX) return false;
  const o = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < n; i++) {
    const a = v[i], b = v[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing segment
      const c = v[j], d = v[(j + 1) % n];
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true;
    }
  }
  return false;
}

function computeGeometricCenter(e) {
  const v = e.vertices;
  if (selfIntersects(v)) return null;
  let A = 0, X = 0, Y = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i], q = v[(i + 1) % v.length];
    if (p.bulge && Math.abs(p.bulge) > 1e-12 && (p.x !== q.x || p.y !== q.y)) {
      const { c, r, a0, sweep } = bulgeToArc(p, q, p.bulge), a1 = a0 + sweep;
      const S = (f) => f(a1) - f(a0);
      const sin = S(Math.sin), cos = S(Math.cos), cos2 = S((t) => t / 2 + Math.sin(2 * t) / 4), sin2 = S((t) => t / 2 - Math.sin(2 * t) / 4);
      const cos3 = S((t) => Math.sin(t) - Math.sin(t) ** 3 / 3), sin3 = S((t) => -Math.cos(t) + Math.cos(t) ** 3 / 3);
      A += c.x * r * sin + r * r * cos2;
      X += c.x * c.x * r * sin + 2 * c.x * r * r * cos2 + r ** 3 * cos3;
      Y -= c.y * c.y * r * -cos + 2 * c.y * r * r * sin2 + r ** 3 * sin3;
    } else {
      A += ((p.x + q.x) / 2) * (q.y - p.y);
      X += ((q.y - p.y) * (p.x * p.x + p.x * q.x + q.x * q.x)) / 3;
      Y += ((q.x - p.x) * (p.y * p.y + p.y * q.y + q.y * q.y)) / 3;
    }
  }
  if (!(Math.abs(A) > 1e-12)) return null;
  return { x: X / (2 * A), y: -Y / (2 * A) };
}

/** Marker glyph of a snap kind, centred at 0,0 with half-size 1 (screen units, Y down): a list of
 *  ['poly', [[x,y]...], closed] and ['circle', r] items. Each mode has its own shape. */
export function snapGlyph(kind) {
  const P = (pts, closed = false) => ['poly', pts, closed];
  switch (kind) {
    case 'end': return [P([[-1, -1], [1, -1], [1, 1], [-1, 1]], true)];
    case 'mid': return [P([[-1, 1], [1, 1], [0, -1]], true)];
    case 'cen': return [['circle', 1]];
    case 'gcen': return [['circle', 1], P([[-0.6, 0], [0.6, 0]]), P([[0, -0.6], [0, 0.6]])];
    case 'node': return [['circle', 1], P([[-0.7, -0.7], [0.7, 0.7]]), P([[0.7, -0.7], [-0.7, 0.7]])];
    case 'quad': return [P([[0, -1], [1, 0], [0, 1], [-1, 0]], true)];
    case 'int': return [P([[-1, -1], [1, 1]]), P([[1, -1], [-1, 1]])];
    case 'ins': return [P([[-1, -1], [0.2, -1], [0.2, -0.2], [1, -0.2], [1, 1], [-0.2, 1], [-0.2, 0.2], [-1, 0.2]], true)];
    case 'per': return [P([[-1, -1], [-1, 1], [1, 1]]), P([[-1, 0], [0, 0], [0, 1]])];
    case 'tan': return [['circle', 0.75], P([[-1, -0.75], [1, -0.75]])];
    case 'near': return [P([[-1, -1], [1, -1], [-1, 1], [1, 1]], true)];
    case 'par': return [P([[-1, 0.4], [0, -1]]), P([[0, 1], [1, -0.4]])];
    case 'ext': return [P([[-1, 0], [1, 0]]), P([[0, -1], [0, 1]])];
    default: return [P([[-1, -1], [1, -1], [1, 1], [-1, 1]], true), P([[-1, -1], [1, 1]])];
  }
}
