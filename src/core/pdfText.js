// ASH Draw Studio - Unicode text for the PDF export: bidirectional ordering (UAX #9 through bidi-js), per-character
// font fallback (Helvetica for WinAnsi, then the embedded Unicode fonts in order) and OpenType shaping through fontkit's
// shaper (the one pdf-lib embeds fonts with): Arabic joining forms, lam-alef ligatures and GPOS mark positions. Shaped
// glyphs are written by glyph id into the font's subset, so pdf-lib's own per-code-point encoding is bypassed.
//
// Paragraph direction is left-to-right, as the drawing canvas lays text out: an Arabic run reads right to left inside
// the line and numbers inside it stay left to right ("غرفة 123" plots as "123" to the left of the Arabic word).
import bidiFactory from 'bidi-js';
import {
  PDFOperator, PDFOperatorNames, PDFHexString, beginText, endText, setFontAndSize, setTextMatrix,
} from 'pdf-lib';

let bidi = null;
const BIDI = () => (bidi ??= bidiFactory());
/** right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms) */
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
export const hasRtl = (t) => RTL.test(t);
/** marks, format characters and spaces stay in the font of the character before them (keeps a shaping run whole) */
const STICKY = /^[\p{M}\p{Cf}\s]$/u;

/**
 * textShaper(helv, uniFonts) -> shape(text, level?) => {width, runs, miss}: `text` laid out at size 1 in visual
 * (left-to-right) order. helv: the standard Helvetica PDFFont; uniFonts: embedded subset PDFFonts, fallback order.
 * level: the bidi embedding level of every character (a piece of an already ordered line), else the line's own levels.
 * runs: {font, width, text} (Helvetica) or {font, width, glyphs: [{glyph, x, dx, dy}]} (font units, pen x before the glyph).
 * miss: characters no font has (drawn as '?').
 */
export function textShaper(helv, uniFonts) {
  const helvChars = new Set(helv.getCharacterSet());
  const has = (f, cp) => (f === helv ? helvChars.has(cp) : f.embedder.font.hasGlyphForCodePoint(cp));
  const chain = [helv, ...uniFonts];
  const cache = new Map();
  return function shape(text, level = null) {
    const key = `${level}\u0000${text}`;
    if (cache.has(key)) return cache.get(key);
    const levels = level == null ? bidiLevels(text) : null;
    const lv = (i) => (levels ? levels[i] : level);
    // logical segments of one level and one font; characters at an odd level are mirrored ("(" -> ")")
    const segs = [];
    let miss = 0, prev = null;
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i), n = cp > 0xffff ? 2 : 1, l = lv(i);
      let ch = text.slice(i, i + n);
      if (l & 1) ch = BIDI().getMirroredCharacter(ch) ?? ch;
      const c = ch.codePointAt(0);
      let f = prev && STICKY.test(ch) && has(prev, c) ? prev : chain.find((x) => has(x, c));
      if (!f) { f = helv; ch = '?'; miss++; }
      const last = segs.at(-1);
      if (last && last.font === f && last.level === l) last.text += ch;
      else segs.push({ font: f, level: l, text: ch });
      prev = f; i += n;
    }
    const order = visualOrder(segs);
    let width = 0;
    const runs = order.map((s) => {
      const rtl = (s.level & 1) === 1;
      if (s.font === helv) {
        const t = rtl ? [...s.text].reverse().join('') : s.text, w = helv.widthOfTextAtSize(t, 1);
        width += w;
        return { font: helv, text: t, width: w };
      }
      // fontkit shapes in logical order and returns the glyphs in visual order for 'rtl'
      const fk = s.font.embedder.font, run = fk.layout(s.text, [], undefined, undefined, rtl ? 'rtl' : 'ltr');
      let x = 0;
      const glyphs = run.glyphs.map((glyph, i) => {
        const p = run.positions[i], g = { glyph, x, dx: p.xOffset, dy: p.yOffset };
        x += p.xAdvance;
        return g;
      });
      const w = x / fk.unitsPerEm;
      width += w;
      return { font: s.font, glyphs, width: w };
    });
    const out = { width, runs, miss };
    cache.set(key, out);
    return out;
  };
}

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

const hex = (id) => id.toString(16).toUpperCase().padStart(4, '0');
/** the glyph's id in the font's subset (adds it, as pdf-lib's encodeText does for a code point) */
function subsetId(font, glyph) {
  const e = font.embedder;
  const id = e.subset.includeGlyph(glyph);
  e.glyphs[id - 1] = glyph;
  e.glyphIdMap.set(glyph.id, id);
  e.glyphCache.invalidate();
  return id;
}

const KEYS = new WeakMap();
/** the page's resource name for `font` */
function fontKey(page, font) {
  if (!KEYS.has(page)) KEYS.set(page, new Map());
  const m = KEYS.get(page);
  if (!m.has(font)) m.set(font, page.node.newFontDictionary(font.name, font.ref));
  return m.get(font);
}

/**
 * textOps(page, shaped, size, x, y) -> PDF operators drawing a shape() result with its left end at (x, y) (current
 * user space, fill colour and graphics state as set by the caller).
 */
export function textOps(page, shaped, size, x, y) {
  const ops = [beginText()];
  let pen = x;
  for (const r of shaped.runs) {
    ops.push(setFontAndSize(fontKey(page, r.font), size));
    if (r.text != null) {
      ops.push(setTextMatrix(1, 0, 0, 1, pen, y), PDFOperator.of(PDFOperatorNames.ShowText, [r.font.encodeText(r.text)]));
    } else {
      // glyphs at their shaped advance: one TJ per stretch of unshifted glyphs (kerning as TJ adjustments), a shifted
      // glyph (a positioned mark) on its own
      const fk = r.font.embedder.font, s = size / fk.unitsPerEm, scale = 1000 / fk.unitsPerEm;
      let arr = null;
      const flush = () => { if (arr) ops.push(PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [page.doc.context.obj(arr)])); arr = null; };
      r.glyphs.forEach((g, i) => {
        const id = PDFHexString.of(hex(subsetId(r.font, g.glyph)));
        const next = i + 1 < r.glyphs.length ? r.glyphs[i + 1].x : r.width * fk.unitsPerEm;
        if (g.dx || g.dy) {
          flush();
          ops.push(setTextMatrix(1, 0, 0, 1, pen + (g.x + g.dx) * s, y + g.dy * s), PDFOperator.of(PDFOperatorNames.ShowText, [id]));
          return;
        }
        if (!arr) { arr = []; ops.push(setTextMatrix(1, 0, 0, 1, pen + g.x * s, y)); }
        arr.push(id);
        const adj = (g.glyph.advanceWidth - (next - g.x)) * scale;
        if (Math.abs(adj) > 1e-3) arr.push(+adj.toFixed(3));
      });
      flush();
    }
    pen += r.width * size;
  }
  ops.push(endText());
  return ops;
}
