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

// patterns loaded from .pat files (app settings): name -> { name, description, units, type, lines }. Looked up before
// the built-in ones, so a loaded acadiso.pat gives AutoCAD's own definitions.
let LOADED = new Map();

/** replace the loaded patterns (definitions as parsePat returns them) */
export function setLoadedPatterns(list) {
  LOADED = new Map();
  for (const p of list ?? []) if (p && p.name && Array.isArray(p.lines) && p.lines.length) LOADED.set(String(p.name).toUpperCase(), p);
}
export const loadedPatterns = () => [...LOADED.values()];
export const isLoadedPattern = (name) => LOADED.has(String(name).toUpperCase());

const defOf = (name) => { const k = String(name).toUpperCase(); return LOADED.get(k)?.lines ?? (Object.prototype.hasOwnProperty.call(DEFS, k) ? DEFS[k] : null); };

export function hasPattern(name) { return defOf(name) !== null; }

export function patternLines(name, scale = 1, angleDeg = 0) {
  const def = defOf(name);
  return def ? linesOfDef(def, scale, angleDeg) : null;
}

/** a .pat-style definition as HATCH pattern lines (the form of DXF group codes 53/43/44/45/46/49) */
export function linesOfDef(def, scale = 1, angleDeg = 0) {
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

/** names of the pattern hatches (model space and blocks) that have no definition of their own and none by name */
export function unknownPatterns(doc) {
  const out = new Set();
  const look = (list) => { for (const e of list) if (e.type === 'HATCH' && !e.solid && e.pattern !== 'SOLID' && !e.patLines?.length && !hasPattern(e.pattern)) out.add(e.pattern); };
  look(doc.entities);
  for (const b of doc.blocks?.values?.() ?? []) look(b.entities ?? []);
  return [...out];
}
