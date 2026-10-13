// ASH Draw Studio - center marks and centerlines (AutoCAD LT DIMCENTER / CENTERMARK / CENTERLINE), as plain line
// segments. Pure ES module: no DOM, no document mutation; the tools in renderer/tools-center.js add the LINEs.
//   dimCenOf(style)                    -> DIMCEN of a dimension style, times DIMSCALE (sign kept)
//   centerMarkSegs(c, r, size, ext)    -> [[p1, p2]]: a cross of half-size `size` at c, plus (ext) the four extension lines
//   dimCenterSegs(e, dimcen)           -> the DIMCENTER segments for a CIRCLE / ARC (DIMCEN < 0 adds extension lines)
//   centerlineSeg(l1, l2, ext)         -> [p1, p2]: the mid / bisecting axis of two LINEs, `ext` beyond their projections
import { defaultDimStyle } from './dimsStyle.js';

const EPS = 1e-9;
const err = (message, code) => Object.assign(new Error(message), { code });

/** DIMCEN of a style (the style's own default when the variable is missing), scaled by DIMSCALE as AutoCAD does */
export function dimCenOf(style) {
  const v = Number.isFinite(style?.DIMCEN) ? style.DIMCEN : defaultDimStyle(style?.name).DIMCEN;
  const k = style?.DIMSCALE > 0 ? style.DIMSCALE : 1;
  return v * k;
}

/** AutoCAD's center mark: a cross reaching `size` from c on each axis; with ext, extension lines on each axis starting
 *  a gap of `size` past the cross and ending `size` beyond the circle (none when the circle is too small for them). */
export function centerMarkSegs(c, r, size, ext) {
  const s = Math.abs(size);
  if (!(s > 0)) return [];
  const at = (dx, dy) => ({ x: c.x + dx, y: c.y + dy });
  const out = [[at(-s, 0), at(s, 0)], [at(0, -s), at(0, s)]];
  const a = 2 * s, b = r + s;
  if (ext && b > a + EPS) {
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push([at(ux * a, uy * a), at(ux * b, uy * b)]);
  }
  return out;
}

export function dimCenterSegs(e, dimcen) {
  if (e?.type !== 'CIRCLE' && e?.type !== 'ARC') throw err('select an arc or a circle', 'NOTARC');
  return centerMarkSegs(e.c, e.r, dimcen, dimcen < 0);
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const unit = (v) => { const l = Math.hypot(v.x, v.y); return { x: v.x / l, y: v.y / l }; };

/** The centerline of two LINEs: parallel lines -> the midline; otherwise the bisector of the angle between them (the
 *  one between the two lines' extents). It spans the projections of all four endpoints, plus `ext` at each end. */
export function centerlineSeg(l1, l2, ext) {
  const d1 = sub(l1.p2, l1.p1), d2 = sub(l2.p2, l2.p1);
  if (!(Math.hypot(d1.x, d1.y) > EPS) || !(Math.hypot(d2.x, d2.y) > EPS)) throw err('the lines must have length', 'ZERO');
  let u1 = unit(d1), u2 = unit(d2);
  const cr = u1.x * u2.y - u1.y * u2.x;
  let o, u;
  if (Math.abs(cr) < EPS) {
    // parallel: the axis runs halfway between l1.p1 and its foot on l2
    const t = dot(sub(l1.p1, l2.p1), u2);
    const foot = { x: l2.p1.x + u2.x * t, y: l2.p1.y + u2.y * t };
    o = { x: (l1.p1.x + foot.x) / 2, y: (l1.p1.y + foot.y) / 2 };
    u = u1;
  } else {
    // the lines (extended) meet at o; each direction points from o towards that line's midpoint
    const s = (sub(l2.p1, l1.p1).x * u2.y - sub(l2.p1, l1.p1).y * u2.x) / cr;
    o = { x: l1.p1.x + u1.x * s, y: l1.p1.y + u1.y * s };
    const away = (l, v) => (dot(sub({ x: (l.p1.x + l.p2.x) / 2, y: (l.p1.y + l.p2.y) / 2 }, o), v) < 0 ? { x: -v.x, y: -v.y } : v);
    u1 = away(l1, u1); u2 = away(l2, u2);
    u = unit({ x: u1.x + u2.x, y: u1.y + u2.y });
  }
  const ts = [l1.p1, l1.p2, l2.p1, l2.p2].map((p) => dot(sub(p, o), u));
  const t0 = Math.min(...ts) - ext, t1 = Math.max(...ts) + ext;
  return [{ x: o.x + u.x * t0, y: o.y + u.y * t0 }, { x: o.x + u.x * t1, y: o.y + u.y * t1 }];
}
