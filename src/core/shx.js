// SHX font substitution: AutoCAD compiled shape fonts (romans.shx, simplex.shx, txt.shx, isocp.shx ...) are not
// shipped (they are Autodesk files), so text in such a style is drawn with a bundled single-stroke font instead:
// the public-domain Hershey "Roman Simplex" (hersheyFutural.js), the font AutoCAD's own simplex/romans derive from.
//
//   shxSubstitute(fontFile)        -> 'simplex' | null   (null: draw with canvas TrueType fonts as before)
//   strokeLayout(text, h)          -> { strokes: [[x0,y0,x1,y1,...], ...], width } | null
//       local frame: origin at the baseline start, y UP, cap height = h (AutoCAD: SHX text height is the
//       cap height); width = sum of the glyph advances. null when a character has no stroke glyph.
//   STROKE_DESCENT                 -> descender depth as a fraction of the height (bottom alignment)
// See docs/FONTS.md for the substitution table.
import { FUTURAL } from './hersheyFutural.js';

// AutoCAD's standard SHX text fonts (all Hershey-derived). Any other *.shx also gets the stroke font, as AutoCAD
// itself does for a missing SHX (FONTALT = simplex.shx), except symbol fonts whose letters stand for symbols.
const TEXT_SHX = new Set(['romans', 'romand', 'romanc', 'romant', 'simplex', 'complex', 'italic', 'italicc', 'italict',
  'txt', 'monotxt', 'isocp', 'isocp2', 'isocp3', 'isoct', 'isoct2', 'isoct3', 'isocteur', 'isocpeur', 'scripts', 'scriptc']);
const SYMBOL_SHX = /^(gdt|amgdt|sy[a-z]*|greeks|greekc|gothic[egi]|cyrillic|cyriltlc)$/;

/** Stroke substitute for a text style font ('romans.shx', 'ROMANS', 'arial.ttf' ...); null keeps the TrueType path. */
export function shxSubstitute(fontFile) {
  const f = String(fontFile ?? '').trim().toLowerCase().replace(/^.*[\\/]/, '');
  const isShx = /\.shx$/.test(f);
  const base = f.replace(/\.(shx|ttf|otf|ttc)$/, '');
  if (SYMBOL_SHX.test(base)) return null;
  if (isShx || (!/\./.test(f) && TEXT_SHX.has(base))) return 'simplex';
  return null;
}

// .jhf: per glyph "nnnnnVVVLR" + pairs of chars, each coordinate = char - 'R'; " R" lifts the pen.
// Roman Simplex: cap top y = -12, baseline y = 9 (y down), so the cap height is 21 units; descenders reach y = 16.
const CAP = 21, BASE = 9;
export const STROKE_DESCENT = 7 / CAP;
function parseJhf(lines, first = 32) {
  const glyphs = new Map();
  lines.forEach((line, i) => {
    const d = line.slice(8);
    const c = (k) => d.charCodeAt(k) - 82;
    const strokes = [];
    let cur = null;
    for (let k = 2; k + 1 < d.length; k += 2) {
      if (d[k] === ' ' && d[k + 1] === 'R') { cur = null; continue; }
      if (!cur) strokes.push((cur = []));
      cur.push(c(k), BASE - c(k + 1));
    }
    glyphs.set(first + i, { l: c(0), r: c(1), strokes: strokes.filter((s) => s.length >= 4) });
  });
  return glyphs;
}

let SIMPLEX = null;
function simplex() {
  if (SIMPLEX) return SIMPLEX;
  const g = parseJhf(FUTURAL);
  // AutoCAD %%d / %%p / %%c (degree, plus-minus, diameter) are not in the ASCII set: drawn from simple strokes
  // in the same units (y up from the baseline).
  const ring = (cx, cy, r, n = 16) => { const s = []; for (let i = 0; i <= n; i++) s.push(cx + r * Math.cos(i * 2 * Math.PI / n), cy + r * Math.sin(i * 2 * Math.PI / n)); return s; };
  g.set(0xb0, { l: -5, r: 5, strokes: [ring(0, 18, 3)] });                                         // degree
  g.set(0xb1, { l: -13, r: 13, strokes: [[0, 18, 0, 6], [-8, 12, 8, 12], [-8, 0, 8, 0]] });        // plus-minus
  const o = g.get(79);                                                                             // 'O' + slash
  const dia = { l: o.l, r: o.r, strokes: [...o.strokes, [-9, -2, 9, 23]] };
  for (const cp of [0xd8, 0xf8, 0x2205, 0x2300]) g.set(cp, dia);
  g.set(0xa0, g.get(32)); g.set(9, g.get(32));                                                     // nbsp, tab
  SIMPLEX = g;
  return g;
}

/** Stroke layout of one line of text at cap height h (see the header). */
export function strokeLayout(text, h) {
  const glyphs = simplex();
  const k = h / CAP;
  const strokes = [];
  let x = 0;
  for (const ch of String(text)) {
    const g = glyphs.get(ch.codePointAt(0));
    if (!g) return null;
    for (const s of g.strokes) strokes.push(s.map((v, i) => (i % 2 ? v * k : (v - g.l) * k + x)));
    x += (g.r - g.l) * k;
  }
  return { strokes, width: x };
}
