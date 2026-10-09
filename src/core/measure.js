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

/** $INSUNITS codes with their names (Units dialog) and short labels (results, status bar) */
export const INSUNITS = [
  [0, 'Unitless', ''], [1, 'Inches', 'in'], [2, 'Feet', 'ft'], [3, 'Miles', 'mi'], [4, 'Millimetres', 'mm'],
  [5, 'Centimetres', 'cm'], [6, 'Metres', 'm'], [7, 'Kilometres', 'km'], [8, 'Microinches', 'µin'], [9, 'Mils', 'mil'],
  [10, 'Yards', 'yd'], [11, 'Angstroms', 'Å'], [12, 'Nanometres', 'nm'], [13, 'Microns', 'µm'], [14, 'Decimetres', 'dm'],
  [15, 'Decametres', 'dam'], [16, 'Hectometres', 'hm'], [17, 'Gigametres', 'Gm'], [18, 'Astronomical units', 'AU'],
  [19, 'Light years', 'ly'], [20, 'Parsecs', 'pc'],
];
const UNIT_LABEL = Object.fromEntries(INSUNITS.map(([c, , l]) => [c, l]));
/** $INSUNITS -> short unit label for results ('' when unitless or unknown) */
export const unitLabel = (insunits) => UNIT_LABEL[insunits] ?? '';

/** $LUPREC (0..8, default 4 when absent or out of range) */
export const lengthPrecision = (luprec) => (Number.isInteger(luprec) && luprec >= 0 && luprec <= 8 ? luprec : 4);
/** a measured number to `prec` decimals with trailing zeros dropped (-0 shown as 0) */
export function formatNumber(v, prec = 4) {
  const p = lengthPrecision(prec), t = v.toFixed(p);
  const r = p ? t.replace(/\.?0+$/, '') : t;
  return r === '-0' ? '0' : r;
}
/** a length with its unit label: formatLength(6.98364, 2, 6) = '6.98 m'; `power` 2 labels an area (m²) */
export function formatLength(v, prec, insunits, power = 1) {
  const u = unitLabel(insunits);
  return `${formatNumber(v, prec)}${u ? ` ${u}${power === 2 ? '²' : ''}` : ''}`;
}

/** true when a drawing that says millimetres ($INSUNITS 4) has extents that look like map / survey grid coordinates
 *  in metres (UTM: eastings 100 000-900 000, northings up to 10 000 000): far from the origin (beyond 100 000)
 *  compared with its own size (at least 10 times its span), and not beyond 10 000 000 (a millimetre drawing placed
 *  at grid coordinates in millimetres lies 1000 times further out). ext = {minx, miny, maxx, maxy} or null. */
export function looksLikeMapMetres(insunits, ext) {
  if (insunits !== 4 || !ext || ![ext.minx, ext.miny, ext.maxx, ext.maxy].every(Number.isFinite)) return false;
  const far = Math.max(Math.abs(ext.minx), Math.abs(ext.maxx), Math.abs(ext.miny), Math.abs(ext.maxy));
  const near = Math.max(Math.min(Math.abs(ext.minx), Math.abs(ext.maxx)), Math.min(Math.abs(ext.miny), Math.abs(ext.maxy)));
  const span = Math.max(ext.maxx - ext.minx, ext.maxy - ext.miny);
  return near > 1e5 && far <= 1e7 && span > 0 && near >= 10 * span;
}

/** Measure overlay option "Show ΔX / ΔY" (setting 'measure.showLegs'): off unless saved as true */
export const showLegsFrom = (v) => v === true;
