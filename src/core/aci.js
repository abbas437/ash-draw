// ASH Draw Studio - 256-colour index (ACI) palette.
// The table is generated algorithmically (hue / brightness / saturation rule) rather than pasted
// from any source file; index 7 is "auto" (white on dark backgrounds, black on light ones).

const FIXED = {
  1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255],
  7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192],
  250: [51, 51, 51], 251: [91, 91, 91], 252: [132, 132, 132], 253: [173, 173, 173], 254: [214, 214, 214], 255: [255, 255, 255],
};
const LEVELS = [255, 204, 153, 127, 76];

function hsvToRgb(hDeg, s, v) {
  const h = (hDeg % 360) / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.floor(r + 1e-9), Math.floor(g + 1e-9), Math.floor(b + 1e-9)];
}

const TABLE = new Array(256);
for (let i = 1; i < 256; i++) {
  if (FIXED[i]) { TABLE[i] = FIXED[i]; continue; }
  const k = i - 10;
  const hue = Math.floor(k / 10) * 15;
  const d = k % 10;
  const v = LEVELS[Math.floor(d / 2)];
  const s = d % 2 === 0 ? 1 : 0.5;
  TABLE[i] = hsvToRgb(hue, s, v);
}

/** ACI index (1..255) -> [r,g,b]. Index 7 returns white (callers treat it as 'auto'). */
export function aciToRgb(index) {
  return TABLE[index] ?? [255, 255, 255];
}

export function rgbToCss([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

/**
 * A colour value as read from a file -> ACI 0..256 (negative = layer off, kept), { r, g, b } true colour, or undefined
 * (unresolvable). Converters such as LibreDWG pass the raw 32-bit CmColor of a DWG through (DIMSTYLE DIMCLRD/E/T,
 * sometimes group 62): high byte 0xC0 ByLayer, 0xC1 ByBlock, 0xC2 true colour (low 24 bits), 0xC3 ACI (low byte),
 * 0xC8 none (treated as ByBlock).
 */
export function decodeColor(v) {
  if (v && typeof v === 'object') return v;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (!Number.isInteger(n)) return undefined;
  if (n >= -256 && n <= 256) return n;
  const u = n >>> 0;
  switch (u >>> 24) {
    case 0xc0: return 256;
    case 0xc1: case 0xc8: return 0;
    case 0xc2: return { r: (u >> 16) & 255, g: (u >> 8) & 255, b: u & 255 };
    case 0xc3: return u & 255;
    default: return undefined;
  }
}

/** nearest ACI 1..255 to an [r,g,b] (for file fields that hold an ACI only) */
export function rgbToAci([r, g, b]) {
  let best = 7, bd = Infinity;
  for (let i = 1; i < 256; i++) {
    const [x, y, z] = TABLE[i], d = (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** a colour for a file field that holds an ACI 0..256 only (DIMCLRD/E/T): raw values decoded, true colour -> nearest
 *  ACI, unresolvable -> `fallback` */
export function aciField(v, fallback = 0) {
  const c = decodeColor(v);
  if (c && typeof c === 'object') return rgbToAci([c.r, c.g, c.b]);
  return c === undefined ? fallback : Math.abs(c);
}

const AUTO = Object.freeze({ rgb: [255, 255, 255], auto: true });

/**
 * Resolve an entity's drawing colour.
 *  entity.color: ACI int, 256 BYLAYER, 0 BYBLOCK, or {r,g,b} (raw CmColor values are decoded).
 *  layer: the entity's layer object (or null). insertColor: resolved colour of the enclosing INSERT
 *  (used for BYBLOCK), same return shape.
 * Returns { rgb:[r,g,b], auto:boolean } where auto=true means "ACI 7: swap white/black by background".
 * Anything unresolvable is `auto` (the foreground), never a fixed white.
 */
export function resolveColor(entity, layer, insertColor = null) {
  let c = decodeColor(entity.color);
  if (c && typeof c === 'object') return { rgb: [c.r, c.g, c.b], auto: false };
  if (c === 256 || c === undefined || c === null) c = layer ? decodeColor(layer.color) : 7;
  if (c === 0) return insertColor ?? { ...AUTO };
  if (c && typeof c === 'object') return { rgb: [c.r, c.g, c.b], auto: false };
  c = Math.abs(c ?? 7); // negative layer colour = layer is off; the colour itself is still |c|
  if (c === 7 || !(c >= 1 && c <= 255)) return { ...AUTO };
  return { rgb: aciToRgb(c), auto: false };
}

/**
 * Colour of an MTEXT run (\C / \c) as { rgb, auto }; null = the MTEXT's own colour (no code, or \C0 ByBlock).
 * \C256 (ByLayer) is the MTEXT's layer colour: style.byLayer, set by the scene for MTEXT items.
 */
export function runColor(c, style) {
  if (!c) return null;
  if (c.rgb) return { rgb: c.rgb, auto: false };
  if (c.aci === 256) return style?.byLayer ?? null;
  if (c.aci === 0) return null;
  return resolveColor({ color: c.aci }, null);
}
