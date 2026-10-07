// ASH Draw Studio - a few built-in hatch patterns (own definitions, simple line families).
// Definitions are in .pat style: angle (deg), base point, delta-x (shift along line), delta-y (spacing), dashes.
// patternLines() returns lines in the form stored in a HATCH: offsets already rotated, scale and angle applied.

const DEFS = {
  LINE: [{ angle: 0, base: [0, 0], delta: [0, 3.175], dashes: [] }],
  ANSI31: [{ angle: 45, base: [0, 0], delta: [0, 3.175], dashes: [] }],
  ANSI32: [
    { angle: 45, base: [0, 0], delta: [0, 9.525], dashes: [] },
    { angle: 45, base: [4.49, 0], delta: [0, 9.525], dashes: [] },
  ],
  ANSI37: [
    { angle: 45, base: [0, 0], delta: [0, 3.175], dashes: [] },
    { angle: 135, base: [0, 0], delta: [0, 3.175], dashes: [] },
  ],
  NET: [
    { angle: 0, base: [0, 0], delta: [0, 3.175], dashes: [] },
    { angle: 90, base: [0, 0], delta: [0, 3.175], dashes: [] },
  ],
  DASH: [{ angle: 0, base: [0, 0], delta: [0, 3.175], dashes: [3.175, -1.5875] }],
};

export const PATTERN_NAMES = ['SOLID', ...Object.keys(DEFS)];

export function hasPattern(name) { return Object.prototype.hasOwnProperty.call(DEFS, String(name).toUpperCase()); }

export function patternLines(name, scale = 1, angleDeg = 0) {
  const def = DEFS[String(name).toUpperCase()];
  if (!def) return null;
  const out = [];
  for (const d of def) {
    const a = ((d.angle + angleDeg) * Math.PI) / 180;
    const ra = (angleDeg * Math.PI) / 180;
    const rot = (x, y, r) => ({ x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) });
    // delta is expressed in the line's own frame: rotate by the line angle (+ extra hatch angle)
    const off = rot(d.delta[0] * scale, d.delta[1] * scale, a);
    const base = rot(d.base[0] * scale, d.base[1] * scale, ra);
    out.push({ angle: d.angle + angleDeg, base, offset: off, dashes: d.dashes.map((v) => v * scale) });
  }
  return out;
}
