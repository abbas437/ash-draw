// ASH Draw Studio - measuring maths for MEASUREGEOM / AREA (pure: no DOM, no Node built-ins).
// Areas are unsigned; perimeters follow arcs exactly (bulges, circles) or Ramanujan's formula (ellipses).

/** area and perimeter of a closed loop of {x, y, bulge} vertices (bulge = tan(sweep/4) of the segment
 *  that starts at the vertex; positive = counter-clockwise arc, as in LWPOLYLINE) */
export function loopMeasure(verts) {
  const n = verts.length;
  let a2 = 0, per = 0;
  for (let i = 0; i < n; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    a2 += p.x * q.y - q.x * p.y;                    // shoelace on the chords
    const c = Math.hypot(q.x - p.x, q.y - p.y), b = p.bulge || 0;
    if (!b || c === 0) { per += c; continue; }
    const th = 4 * Math.atan(Math.abs(b)), r = c / (2 * Math.sin(th / 2));
    per += th * r;
    a2 += Math.sign(b) * r * r * (th - Math.sin(th)); // circular segment between chord and arc (x2)
  }
  return { area: Math.abs(a2) / 2, perimeter: per };
}

/** measure a closed object: LWPOLYLINE (closed), CIRCLE, full ELLIPSE, HATCH (outer minus islands) or a
 *  closed SPLINE given its tessellation `pts`. Returns null for objects that do not enclose an area. */
export function entityMeasure(e, pts = null) {
  switch (e.type) {
    case 'CIRCLE': return { area: Math.PI * e.r * e.r, perimeter: 2 * Math.PI * e.r };
    case 'LWPOLYLINE': return e.closed ? loopMeasure(e.vertices) : null;
    case 'ELLIPSE': {
      if (Math.abs(Math.abs(e.a1 - e.a0) - 2 * Math.PI) > 1e-9) return null;
      const a = Math.hypot(e.major.x, e.major.y), b = a * e.ratio, h = ((a - b) / (a + b)) ** 2;
      return { area: Math.PI * a * b, perimeter: Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))) };
    }
    case 'HATCH': {
      const loops = e.loops.filter((l) => l.pts).map((l) => loopMeasure(l.pts));
      if (!loops.length) return null;
      loops.sort((x, y) => y.area - x.area); // largest = outer boundary, the rest are islands
      return { area: loops[0].area - loops.slice(1).reduce((s, l) => s + l.area, 0), perimeter: loops.reduce((s, l) => s + l.perimeter, 0) };
    }
    case 'SPLINE': return e.closed && pts?.length > 2 ? loopMeasure(pts) : null;
    default: return null;
  }
}

/** AutoCAD AREA "Add / Subtract" running total */
export class AreaTotal {
  constructor() { this.total = 0; this.mode = 'add'; }
  push(area) { this.total += this.mode === 'subtract' ? -area : area; return this.total; }
}

/** angle in degrees (0..180) at `vertex` between the rays to p1 and p2 */
export function angleAt(vertex, p1, p2) {
  const a = Math.atan2(p1.y - vertex.y, p1.x - vertex.x) - Math.atan2(p2.y - vertex.y, p2.x - vertex.x);
  let d = Math.abs(a * 180 / Math.PI) % 360;
  return d > 180 ? 360 - d : d;
}

/** $INSUNITS -> short unit label for results ('' when unitless) */
const UNIT_LABEL = { 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin', 9: 'mil', 10: 'yd', 13: 'µm', 14: 'dm' };
export const unitLabel = (insunits) => UNIT_LABEL[insunits] ?? '';
