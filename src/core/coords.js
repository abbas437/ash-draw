// ASH Draw Studio - command-line coordinate parser (AutoCAD-style input).
//   "10,20"     absolute point
//   "@5,3"      relative to the last point
//   "10<45"     polar (distance < angle in degrees) from the origin
//   "@10<45"    polar relative to the last point
//   "25"        a bare number: distance along `direction` (the current rubber-band direction), if given
//   "1,5;2"     with a ';' the pair separator is ';' and a ',' in a number is a decimal comma (1.5, 2); without one, ',' separates
//   12' 12'6" 12'-6" 12'6-1/2" 6" 6-1/2" 1/2"   feet and inches for any length, when `units` ($INSUNITS) is 1 (inches) or 2 (feet)
// parseCoordinate(text, last, direction, header, units) -> {x,y} | {distance} | null
// Typed and shown angles follow the drawing's $ANGBASE (radians, direction of angle 0) and $ANGDIR (1: clockwise).
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const RE_NUM = new RegExp(`^${NUM}$`);
const U = '\\d+(?:\\.\\d*)?|\\.\\d+';
// [sign] [feet'] [-] [inches [-num/den] | num/den]"  (feet, inches or both)
const RE_FTIN = new RegExp(`^([-+])?(?:(${U})')?(?:-?(?:(${U})(?:-(\\d+)/(\\d+))?|(\\d+)/(\\d+))")?$`);

/** a typed length in drawing units: a number, or with `units` 1 (inches) or 2 (feet) also feet and inches; NaN if neither */
function length(tok, units) {
  const t = tok.trim();
  if (RE_NUM.test(t)) return parseFloat(t);
  if (units !== 1 && units !== 2) return NaN;
  const m = RE_FTIN.exec(t);
  if (!m || (m[2] === undefined && m[3] === undefined && m[6] === undefined)) return NaN;
  const f = (v) => (v === undefined ? 0 : parseFloat(v)), frac = (n, d) => (n === undefined ? 0 : n / d);
  const inches = f(m[2]) * 12 + f(m[3]) + frac(m[4], m[5]) + frac(m[6], m[7]);
  return (m[1] === '-' ? -1 : 1) * (units === 2 ? inches / 12 : inches);
}

/** world angle (radians, counter-clockwise from +X) of an angle typed in degrees under the header's ANGBASE / ANGDIR */
export const angleToWorld = (deg, h) => (h?.angbase || 0) + (h?.angdir === 1 ? -1 : 1) * deg * Math.PI / 180;
/** the angle shown for a world angle in degrees: from ANGBASE, clockwise when ANGDIR = 1, in [0, 360) */
export const angleFromWorld = (deg, h) => {
  const a = (h?.angdir === 1 ? -1 : 1) * (deg - (h?.angbase || 0) * 180 / Math.PI);
  return ((a % 360) + 360) % 360;
};

export function parseCoordinate(text, last = { x: 0, y: 0 }, direction = null, header = null, units = 0) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  const rel = s[0] === '@';
  if (rel) s = s.slice(1);
  const at = (dx, dy) => (rel ? { x: last.x + dx, y: last.y + dy } : { x: dx, y: dy });
  const semi = s.includes(';'); // ';' separates the pair, so a ',' is a decimal comma
  const len = (tok) => length(semi ? tok.replace(',', '.') : tok, units);
  const pair = s.split(semi ? ';' : ',');
  if (pair.length > 2) return null;
  if (pair.length === 2) {
    const x = len(pair[0]), y = len(pair[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? at(x, y) : null;
  }
  const pol = s.split('<');
  if (pol.length === 2) {
    const d = len(pol[0]), deg = pol[1].trim();
    if (!Number.isFinite(d) || !RE_NUM.test(deg)) return null;
    const a = angleToWorld(parseFloat(deg), header);
    return at(d * Math.cos(a), d * Math.sin(a));
  }
  if (rel || pol.length > 2) return null;
  const d = len(s);
  if (!Number.isFinite(d)) return null;
  if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.y)) {
    const l = Math.hypot(direction.x, direction.y) || 1;
    return { x: last.x + (direction.x / l) * d, y: last.y + (direction.y / l) * d, distance: d };
  }
  return { distance: d };
}
