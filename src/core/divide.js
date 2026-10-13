// ASH Draw Studio - DIVIDE and MEASURE (point placing): stations along a curve, then POINTs or block INSERTs there.
// Pure (no DOM). A curve is read by arc length s in [0, len]; at(s) gives the point and the unit tangent in the object's
// own direction. Closed curves start where AutoCAD starts: a circle at angle 0 from its centre, a closed polyline at
// its first vertex, a full ellipse at the end of its major axis, a closed spline at its first parameter.
import { DEG, normAngle, ccwSweep, ellipsePoint, ellipseAxes, plSegs, segPoint, dist } from './geom.js';
import { nurbsOf, curveOfNurbs, isClosed } from './nurbs.js';
import { makePoint } from './model.js';
import { instantiate } from './blocks.js';

const TAU = Math.PI * 2;
export const DIVIDE_MAX = 32767;
function fail(code, msg) { const err = new Error(msg); err.code = code; return err; }
const unit = (v) => { const l = Math.hypot(v.x, v.y); return l < 1e-15 ? { x: 1, y: 0 } : { x: v.x / l, y: v.y / l }; };
const ccwTan = (a) => ({ x: -Math.sin(a), y: Math.cos(a) });
const polar = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });

// 5-point Gauss-Legendre on [-1, 1]
const GX = [0, -0.5384693101056831, 0.5384693101056831, -0.9061798459386640, 0.9061798459386640];
const GW = [0.5688888888888889, 0.4786286704993665, 0.4786286704993665, 0.2369268850561891, 0.2369268850561891];
/** Arc-length reading of a parametric curve {at, d1, t0, t1, n}: a length table per interval, inverted by Newton. */
function byLength(cv) {
  const speed = (t) => Math.hypot(cv.d1(t).x, cv.d1(t).y);
  const gl = (a, b) => { const h = (b - a) / 2, m = (a + b) / 2; let s = 0; for (let i = 0; i < 5; i++) s += GW[i] * speed(m + h * GX[i]); return s * h; };
  const n = Math.max(64, cv.n), T = [cv.t0], S = [0];
  for (let i = 1; i <= n; i++) { const t = cv.t0 + ((cv.t1 - cv.t0) * i) / n; S.push(S[i - 1] + gl(T[i - 1], t)); T.push(t); }
  const len = S[n];
  const param = (s) => {
    if (s <= 0) return cv.t0;
    if (s >= len) return cv.t1;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
    const ta = T[lo], tb = T[hi], want = s - S[lo];
    let t = ta + ((tb - ta) * want) / (S[hi] - S[lo] || 1);
    for (let k = 0; k < 20; k++) {
      const v = speed(t), dt = v > 1e-15 ? (gl(ta, t) - want) / v : 0;
      t = Math.min(tb, Math.max(ta, t - dt));
      if (Math.abs(dt) <= 1e-14 * (1 + Math.abs(t))) break;
    }
    return t;
  };
  return { len, at: (s) => { const t = param(s); return { p: cv.at(t), d: unit(cv.d1(t)) }; } };
}

/** {len, closed, at(s) -> {p, d}} for LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE (with arc segments) and SPLINE. */
export function curveOf(e) {
  switch (e.type) {
    case 'LINE': {
      const L = dist(e.p1, e.p2), d = unit({ x: e.p2.x - e.p1.x, y: e.p2.y - e.p1.y });
      return { len: L, closed: false, at: (s) => ({ p: { x: e.p1.x + d.x * s, y: e.p1.y + d.y * s }, d }) };
    }
    case 'ARC': {
      const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
      return { len: e.r * sw, closed: false, at: (s) => { const a = a0 + s / e.r; return { p: polar(e.c, e.r, a), d: ccwTan(a) }; } };
    }
    case 'CIRCLE':
      return { len: TAU * e.r, closed: true, at: (s) => { const a = s / e.r; return { p: polar(e.c, e.r, a), d: ccwTan(a) }; } };
    case 'LWPOLYLINE': {
      const segs = plSegs(e), len = segs.reduce((a, sg) => a + sg.len, 0);
      const at = (s) => {
        let acc = 0;
        for (let i = 0; i < segs.length; i++) {
          const sg = segs[i];
          if (s <= acc + sg.len || i === segs.length - 1) {
            const f = sg.len > 0 ? Math.min(1, Math.max(0, (s - acc) / sg.len)) : 0;
            const d = sg.arc ? (() => { const t = ccwTan(sg.arc.a0 + sg.arc.sweep * f), k = Math.sign(sg.arc.sweep); return { x: t.x * k, y: t.y * k }; })()
              : unit({ x: sg.b.x - sg.a.x, y: sg.b.y - sg.a.y });
            return { p: segPoint(sg, f), d };
          }
          acc += sg.len;
        }
        return null;
      };
      return { len, closed: !!e.closed, at };
    }
    case 'ELLIPSE': {
      const full = Math.abs((e.a1 ?? TAU) - (e.a0 ?? 0)) >= TAU - 1e-9;
      const t0 = full ? 0 : normAngle(e.a0), sw = full ? TAU : ccwSweep(t0, normAngle(e.a1));
      const { u, v } = ellipseAxes(e);
      const cv = byLength({
        at: (t) => ellipsePoint(e, t), d1: (t) => ({ x: -u.x * Math.sin(t) + v.x * Math.cos(t), y: -u.y * Math.sin(t) + v.y * Math.cos(t) }),
        t0, t1: t0 + sw, n: Math.ceil((256 * sw) / TAU),
      });
      return { ...cv, closed: full };
    }
    case 'SPLINE': {
      const nu = nurbsOf(e);
      if (!nu) throw fail('GEOMETRY', 'the spline has no shape');
      return { ...byLength(curveOfNurbs(nu)), closed: isClosed(nu) };
    }
    default: throw fail('UNSUPPORTED', `cannot divide or measure a ${e.type}`);
  }
}

const station = ({ p, d }) => ({ p, angle: Math.atan2(d.y, d.x) });

/** DIVIDE: the N-1 dividing points of an open curve, or N points from the start of a closed one: [{p, angle}]. */
export function divideStations(e, n) {
  if (!Number.isInteger(n) || n < 2 || n > DIVIDE_MAX) throw fail('RANGE', `the number of segments must be 2 to ${DIVIDE_MAX}`);
  const cv = curveOf(e);
  if (!(cv.len > 1e-12)) throw fail('GEOMETRY', 'the object has no length');
  const out = [];
  for (let k = cv.closed ? 0 : 1; k < n; k++) out.push(station(cv.at((cv.len * k) / n)));
  return out;
}

/** MEASURE: points every `seg` from the end nearest `pick` (closed curves: from their start); none at either end. */
export function measureStations(e, seg, pick = null) {
  if (!(seg > 0)) throw fail('RANGE', 'the segment length must be greater than 0');
  const cv = curveOf(e), L = cv.len;
  if (!(L > 1e-12)) throw fail('GEOMETRY', 'the object has no length');
  const n = Math.ceil(L / seg - 1e-9) - 1;
  if (n > DIVIDE_MAX) throw fail('RANGE', `that length would place more than ${DIVIDE_MAX} objects`);
  const back = !cv.closed && pick != null && dist(pick, cv.at(L).p) < dist(pick, cv.at(0).p);
  const out = [];
  for (let k = 1; k <= n; k++) out.push(station(cv.at(back ? L - k * seg : k * seg)));
  return out;
}

/** The new objects at the stations: POINTs, or INSERTs of `block` (rotated to the tangent when `align`). */
export function placeAt(stations, { props = {}, block = null, align = true } = {}) {
  if (!block) return stations.map(({ p }) => makePoint(p, props));
  return stations.map(({ p, angle }) => instantiate(block, p, { ...props, rot: align ? angle / DEG : 0 }));
}
