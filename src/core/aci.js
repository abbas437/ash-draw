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
 * Resolve an entity's drawing colour.
 *  entity.color: ACI int, 256 BYLAYER, 0 BYBLOCK, or {r,g,b}.
 *  layer: the entity's layer object (or null). insertColor: resolved colour of the enclosing INSERT
 *  (used for BYBLOCK), same return shape.
 * Returns { rgb:[r,g,b], auto:boolean } where auto=true means "ACI 7: swap white/black by background".
 */
export function resolveColor(entity, layer, insertColor = null) {
  let c = entity.color;
  if (c && typeof c === 'object') return { rgb: [c.r, c.g, c.b], auto: false };
  if (c === 256 || c === undefined || c === null) c = layer ? layer.color : 7;
  if (c === 0) return insertColor ?? { rgb: [255, 255, 255], auto: true };
  if (c && typeof c === 'object') return { rgb: [c.r, c.g, c.b], auto: false };
  c = Math.abs(c); // negative layer colour = layer is off; the colour itself is still |c|
  if (c === 7) return { rgb: [255, 255, 255], auto: true };
  return { rgb: aciToRgb(c), auto: false };
}
