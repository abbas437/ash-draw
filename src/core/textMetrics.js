// TEXT geometry shared by render, pick/bbox and DXF write: the real text width (stroke font metrics for SHX
// styles, a canvas measure registered by the app otherwise) and the 15 AutoCAD TEXT justifications.
//
//   setTextMeasure(fn)        fn(text, font) -> advance width at font size 1 (canvas); null: 0.6 h per character
//   textFrame(e, doc)         -> { o, rot, h, wf, w, top, desc, t, stroke }
//       o: start of the baseline (DXF group 10 for every justification), rot in radians, h / wf the drawn height
//       and width factor (Aligned scales h, Fit scales wf), w the drawn width, top / desc the extents above / below
//       the baseline, t = tan(oblique), stroke = drawn with the SHX stroke font.
//   textCorners(f)            -> the four world corners of the frame's text box
// Justification (DXF 72 / 73): 72 = 0 left, 1 center, 2 right, 3 aligned, 4 middle, 5 fit; 73 = 0 baseline,
// 1 bottom, 2 middle, 3 top. e.p is the alignment point (group 11) except for Left/baseline (group 10) and for
// Aligned / Fit, where e.p is group 10 and e.p2 group 11 (the text runs from p to p2; 73 is ignored).
import { isGdtFont, gdtText } from './gdt.js';
import { shxSubstitute, strokeLayout, STROKE_DESCENT } from './shx.js';
import { mtextPlain } from './mtext.js';

let measureFn = null;
const cache = new Map();
/** Register the canvas text measure (renderer); fn(text, font) -> width at font size 1. */
export function setTextMeasure(fn) { measureFn = fn; cache.clear(); }

function canvasWidth(text, font) {
  if (!measureFn) return [...text].length * 0.6;
  const key = `${font}\u0000${text}`;
  let w = cache.get(key);
  if (w === undefined) {
    if (cache.size > 50000) cache.clear();
    w = measureFn(text, font);
    cache.set(key, w);
  }
  return w;
}

// vertical metrics as fractions of the height: SHX height is the cap height (descenders 7/21 below);
// canvas text keeps the offsets drawText has always used
const SHX_M = { top: 1, mid: 0.5, desc: STROKE_DESCENT };
const CANVAS_M = { top: 0.8, mid: 0.35, desc: 0.2 };

export function textFrame(e, doc = null) {
  const st = doc?.textStyles?.get(String(e.style || 'STANDARD').toUpperCase());
  const lines = (isGdtFont(st?.fontFile || st?.font) ? gdtText(mtextPlain(e.text)) : mtextPlain(e.text)).split('\n');
  const sl = !e.ui && lines.length === 1 && shxSubstitute(st?.fontFile || st?.font) ? strokeLayout(lines[0], 1) : null;
  const w1 = sl ? sl.width : Math.max(0, ...lines.map((l) => canvasWidth(l, st?.font || 'Arial')));
  const m = sl ? SHX_M : CANVAS_M;
  const t = Math.tan((e.oblique || 0) * Math.PI / 180);
  let h = e.height || 1, wf = e.widthFactor || 1, rot = (e.rot || 0) * Math.PI / 180;
  const ha = e.hAlign || 0, va = e.vAlign || 0;
  let o;
  if ((ha === 3 || ha === 5) && e.p2) {
    const L = Math.hypot(e.p2.x - e.p.x, e.p2.y - e.p.y);
    if (L > 1e-12) rot = Math.atan2(e.p2.y - e.p.y, e.p2.x - e.p.x);
    if (L > 1e-12 && w1 > 0) { if (ha === 3) h = L / (w1 * wf); else wf = L / (w1 * h); }
    o = { x: e.p.x, y: e.p.y };
  }
  const w = w1 * h * wf;
  if (!o) {
    const dx = ha === 1 || ha === 4 ? -w / 2 : ha === 2 ? -w : 0;
    const dy = va === 1 ? m.desc * h : va === 2 || (ha === 4 && !va) ? -m.mid * h : va === 3 ? -m.top * h : 0;
    const c = Math.cos(rot), s = Math.sin(rot), x = dx + dy * t;
    o = { x: e.p.x + x * c - dy * s, y: e.p.y + x * s + dy * c };
  }
  return { o, rot, h, wf, w, top: m.top * h, desc: m.desc * h, t, stroke: !!sl };
}

export function textCorners(f) {
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  return [[0, -f.desc], [f.w, -f.desc], [f.w, f.top], [0, f.top]].map(([x0, y]) => {
    const x = x0 + y * f.t;
    return { x: f.o.x + x * c - y * s, y: f.o.y + x * s + y * c };
  });
}
