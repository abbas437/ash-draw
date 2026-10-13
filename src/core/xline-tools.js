// ASH Draw Studio - pure geometry for the XLINE command options (Bisect, Offset). No DOM; used by renderer/tools-xline.js.

const unit = (v) => { const l = Math.hypot(v.x, v.y); return l > 1e-12 && Number.isFinite(l) ? { x: v.x / l, y: v.y / l } : null; };

/** Unit direction of the bisector of the angle start-vertex-end; null when either leg has zero length.
 *  For a straight angle (legs opposite) the bisector is perpendicular to the legs. */
export function bisectorDir(vertex, start, end) {
  const a = unit({ x: start.x - vertex.x, y: start.y - vertex.y }), b = unit({ x: end.x - vertex.x, y: end.y - vertex.y });
  if (!a || !b) return null;
  return unit({ x: a.x + b.x, y: a.y + b.y }) ?? { x: -a.y, y: a.x };
}

/** The straight line an XLINE Offset can start from: {p, dir} of a LINE, XLINE, RAY or the straight LWPOLYLINE segment
 *  nearest `at`. null for anything else (or an arc segment / zero-length line). */
export function lineOf(e, at) {
  if (!e) return null;
  if (e.type === 'LINE') { const d = unit({ x: e.p2.x - e.p1.x, y: e.p2.y - e.p1.y }); return d && { p: { ...e.p1 }, dir: d }; }
  if (e.type === 'XLINE' || e.type === 'RAY') { const d = unit(e.dir); return d && { p: { ...e.p }, dir: d }; }
  if (e.type !== 'LWPOLYLINE' || !at) return null;
  const v = e.vertices, n = e.closed ? v.length : v.length - 1;
  let best = null, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const a = v[i], b = v[(i + 1) % v.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (!(l2 > 1e-24)) continue;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / l2));
    const d = Math.hypot(a.x + t * dx - at.x, a.y + t * dy - at.y);
    if (d < bd) { bd = d; best = { a, b }; }
  }
  if (!best || Math.abs(best.a.bulge ?? 0) > 1e-12) return null;
  return { p: { x: best.a.x, y: best.a.y }, dir: unit({ x: best.b.x - best.a.x, y: best.b.y - best.a.y }) };
}

/** XLINE parallel to `line` ({p, dir}) at `distance` on the side of point `side`; null when `side` is on the line. */
export function offsetXline(line, distance, side) {
  const { p, dir } = line;
  const cross = dir.x * (side.y - p.y) - dir.y * (side.x - p.x);
  if (Math.abs(cross) <= 1e-12) return null;
  const s = Math.sign(cross) * distance; // left normal of dir is (-dir.y, dir.x)
  return { p: { x: p.x - dir.y * s, y: p.y + dir.x * s }, dir: { ...dir } };
}
