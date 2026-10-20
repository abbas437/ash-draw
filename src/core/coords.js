// ASH Draw Studio - command-line coordinate parser (AutoCAD-style input).
//   "10,20"     absolute point
//   "@5,3"      relative to the last point
//   "10<45"     polar (distance < angle in degrees) from the origin
//   "@10<45"    polar relative to the last point
//   "25"        a bare number: distance along `direction` (the current rubber-band direction), if given
// parseCoordinate(text, last, direction, header) -> {x,y} | {distance} | null
// Typed and shown angles follow the drawing's $ANGBASE (radians, direction of angle 0) and $ANGDIR (1: clockwise).
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const RE_CART = new RegExp(`^(@)?\\s*(${NUM})\\s*[,;]\\s*(${NUM})\\s*$`);
const RE_POLAR = new RegExp(`^(@)?\\s*(${NUM})\\s*<\\s*(${NUM})\\s*$`);
const RE_NUM = new RegExp(`^\\s*(${NUM})\\s*$`);

/** world angle (radians, counter-clockwise from +X) of an angle typed in degrees under the header's ANGBASE / ANGDIR */
export const angleToWorld = (deg, h) => (h?.angbase || 0) + (h?.angdir === 1 ? -1 : 1) * deg * Math.PI / 180;
/** the angle shown for a world angle in degrees: from ANGBASE, clockwise when ANGDIR = 1, in [0, 360) */
export const angleFromWorld = (deg, h) => {
  const a = (h?.angdir === 1 ? -1 : 1) * (deg - (h?.angbase || 0) * 180 / Math.PI);
  return ((a % 360) + 360) % 360;
};

export function parseCoordinate(text, last = { x: 0, y: 0 }, direction = null, header = null) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let m = RE_CART.exec(s);
  if (m) {
    const x = parseFloat(m[2]), y = parseFloat(m[3]);
    return m[1] ? { x: last.x + x, y: last.y + y } : { x, y };
  }
  m = RE_POLAR.exec(s);
  if (m) {
    const d = parseFloat(m[2]), a = angleToWorld(parseFloat(m[3]), header);
    const dx = d * Math.cos(a), dy = d * Math.sin(a);
    return m[1] ? { x: last.x + dx, y: last.y + dy } : { x: dx, y: dy };
  }
  m = RE_NUM.exec(s);
  if (m) {
    const d = parseFloat(m[1]);
    if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.y)) {
      const l = Math.hypot(direction.x, direction.y) || 1;
      return { x: last.x + (direction.x / l) * d, y: last.y + (direction.y / l) * d, distance: d };
    }
    return { distance: d };
  }
  return null;
}
