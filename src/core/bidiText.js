// ASH Draw Studio - bidirectional ordering shared by the screen renderer and the PDF export (UAX #9 through bidi-js).
// Pure: no canvas, no PDF library. Paragraph direction is left-to-right, as the drawing canvas lays text out: an
// Arabic run reads right to left inside the line and numbers inside it stay left to right ("غرفة 123" shows "123"
// to the left of the Arabic word).
import bidiFactory from 'bidi-js';

let bidi = null;
export const BIDI = () => (bidi ??= bidiFactory());
/** right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms) */
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
export const hasRtl = (t) => RTL.test(t);

/** the bidi embedding levels (per UTF-16 unit) of a left-to-right paragraph line */
export const bidiLevels = (text) => BIDI().getEmbeddingLevels(text, 'ltr').levels;

/** UAX #9 L2: items ({level}) in logical order -> visual order (reverse every run at or above each level, highest first) */
export function visualOrder(items) {
  const out = items.slice();
  const maxL = Math.max(0, ...out.map((s) => s.level));
  for (let L = maxL; L >= 1; L--) {
    for (let i = 0; i < out.length;) {
      if (out[i].level < L) { i++; continue; }
      let j = i;
      while (j < out.length && out[j].level >= L) j++;
      out.splice(i, j - i, ...out.slice(i, j).reverse());
      i = j;
    }
  }
  return out;
}

/**
 * MTEXT layout glyphs ({li, text, x, w, ...}, logical order) -> the same with every line that holds right-to-left text
 * in visual order: the line's words / spaces split at bidi level changes (pieces carry `level`) and laid from the
 * line's left end. width(text, level, glyph) -> the piece's advance in drawing units. Lines with stacked fractions
 * (glyphs without a width) or stroke text keep their place.
 */
export function reorderLines(glyphs, width) {
  const byLine = new Map();
  for (const g of glyphs) if (g.li != null) (byLine.get(g.li) ?? byLine.set(g.li, []).get(g.li)).push(g);
  const moved = new Map();
  for (const group of byLine.values()) {
    if (!group.some((g) => hasRtl(g.text)) || group.some((g) => g.w == null || g.stroke)) continue;
    const levels = bidiLevels(group.map((g) => g.text).join(''));
    const pieces = [];
    let i = 0;
    for (const g of group) {
      for (let a = 0; a < g.text.length;) {
        let b = a + 1;
        while (b < g.text.length && levels[i + b] === levels[i + a]) b++;
        const text = g.text.slice(a, b), level = levels[i + a];
        pieces.push({ ...g, text, level, w: width(text, level, g) });
        a = b;
      }
      i += g.text.length;
    }
    let x = Math.min(...group.map((g) => g.x));
    for (const p of visualOrder(pieces)) { p.x = x; x += p.w; }
    moved.set(group[0], pieces);
    for (const g of group.slice(1)) moved.set(g, []);
  }
  return moved.size ? glyphs.flatMap((g) => moved.get(g) ?? [g]) : glyphs;
}
