// ASH Draw Studio - command-line coordinate parser (AutoCAD-style input).
//   "10,20"     absolute point
//   "@5,3"      relative to the last point
//   "10<45"     polar (distance < angle in degrees) from the origin
//   "@10<45"    polar relative to the last point
//   "25"        a bare number: distance along `direction` (the current rubber-band direction), if given
// parseCoordinate(text, last, direction) -> {x,y} | {distance} | null
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const RE_CART = new RegExp(`^(@)?\\s*(${NUM})\\s*[,;]\\s*(${NUM})\\s*$`);
const RE_POLAR = new RegExp(`^(@)?\\s*(${NUM})\\s*<\\s*(${NUM})\\s*$`);
const RE_NUM = new RegExp(`^\\s*(${NUM})\\s*$`);

export function parseCoordinate(text, last = { x: 0, y: 0 }, direction = null) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let m = RE_CART.exec(s);
  if (m) {
    const x = parseFloat(m[2]), y = parseFloat(m[3]);
    return m[1] ? { x: last.x + x, y: last.y + y } : { x, y };
  }
  m = RE_POLAR.exec(s);
  if (m) {
    const d = parseFloat(m[2]), a = (parseFloat(m[3]) * Math.PI) / 180;
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
