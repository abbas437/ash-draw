// ASH Draw Studio - PDF export (pure ES module, vector output through pdf-lib content-stream operators).
//
//   const { bytes, warnings } = await exportPdf(doc, { pageSize: 'A3', orientation: 'auto' });
import {
  PDFDocument, StandardFonts, PageSizes, rgb, PDFOperator, PDFOperatorNames, PDFName, numberToString,
  pushGraphicsState, popGraphicsState, setLineWidth, setDashPattern, setLineCap, setLineJoin,
  setStrokingRgbColor, setFillingRgbColor, moveTo, lineTo, closePath, stroke,
  clip, endPath, concatTransformationMatrix, setGraphicsState,
} from 'pdf-lib';
import { buildScene, docWithFrozen, infiniteItem } from './render.js';
import { layoutPage, layoutPlotRegion, paperMmPerUnit, viewportScale, isPaperViewport, viewportClipRing } from './layouts.js';
import {
  walkOps, finiteAnchor, finiteSeg, exportNotes, colorRgb, lineweightMm, dashUnits, hatchFamilies, layoutText, markerSize, arrowTriangle, runRgb, mtextItemLayout,
} from './exportSvg.js';
import { textShaper, textOps } from './pdfText.js';
import { reorderLines, reorderRules } from './bidiText.js';

/** the PDF warning for `count` text characters drawn as '?': `chars`, the distinct ones, listed (up to `max`) as the
 *  character and its code, e.g. "2 text characters could not be drawn (no font has them): ⌀ (U+2300), ◊ (U+25CA)" */
export function missingCharsWarning(count, chars, reason, max = 10) {
  const code = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  const list = chars.slice(0, max).map((c) => `${c} (${code(c)})`).join(', ');
  const more = chars.length > max ? `, and ${chars.length - max} more` : '';
  return `${count} text character${count === 1 ? '' : 's'} could not be drawn (${reason})${list ? `: ${list}${more}` : ''}`;
}

const PT_PER_MM = 72 / 25.4;
const MAX_PAGE_PT = 14400;          // PDF 1.x user-unit page size limit (200 inch)
const MIN_LW_PT = 0.25;
const fillEvenOdd = () => PDFOperator.of(PDFOperatorNames.FillEvenOdd);
const fillEvenOddAndStroke = () => PDFOperator.of(PDFOperatorNames.FillEvenOddAndStroke);
const SIZES = { A4: PageSizes.A4, A3: PageSizes.A3, A2: PageSizes.A2, A1: PageSizes.A1, A0: PageSizes.A0, Letter: PageSizes.Letter, Tabloid: PageSizes.Tabloid };
/** printable margin (mm) round a layout sheet fitted to another paper */
export const LAYOUT_FIT_MARGIN_MM = 5;

/**
 * pageFit(sheetW, sheetH, paper, {fit, margin}) -> {pw, ph, scale, ox, oy, orientation, fits}: a layout sheet of
 * sheetW x sheetH points put on `paper` (a page size name; landscape when the sheet is wider than tall, else portrait).
 * fit: scaled to the paper inside `margin` mm (larger or smaller), else 1:1. Centred: page = (ox, oy) + scale * sheet,
 * with the sheet's lower-left corner at sheet (0, 0). fits: the whole sheet lies inside the margins.
 */
export function pageFit(sheetW, sheetH, paper, { fit = true, margin = LAYOUT_FIT_MARGIN_MM } = {}) {
  if (!SIZES[paper]) throw new Error(`Unknown page size: ${paper}`);
  const [a, b] = SIZES[paper], land = sheetW > sheetH;
  const [pw, ph] = land ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
  return { ...placeOnPage(sheetW, sheetH, pw, ph, { fit, margin }), orientation: land ? 'landscape' : 'portrait' };
}

/** placeOnPage(w, h, pw, ph, {fit, margin}) -> {pw, ph, scale, ox, oy, fits}: pageFit's placement of a w x h point box
 *  on a pw x ph point page of a given orientation (e.g. a layout's own paper) */
export function placeOnPage(sheetW, sheetH, pw, ph, { fit = true, margin = LAYOUT_FIT_MARGIN_MM } = {}) {
  const m = margin * PT_PER_MM, w = Math.max(sheetW, 1e-9), h = Math.max(sheetH, 1e-9);
  const scale = fit ? Math.min((pw - 2 * m) / w, (ph - 2 * m) / h) : 1;
  const fits = w * scale <= pw - 2 * m + 1e-6 && h * scale <= ph - 2 * m + 1e-6;
  return { pw, ph, scale, ox: (pw - w * scale) / 2, oy: (ph - h * scale) / 2, fits };
}

/**
 * plotLayout(region, opts) -> {pw, ph, k, ox, oy, warnings}: page size (points) and the drawing -> page transform
 * (page = o + k * drawing; k = points per drawing unit) for plotting `region` {minx,miny,maxx,maxy} (drawing units).
 * opts: pageSize, orientation, margin (mm), scale (null = fit | paper mm per drawing unit), centre (true = centred on the
 * page, false = region's lower-left corner at the lower-left margin).
 */
export function plotLayout(region, { pageSize = 'fit', orientation = 'auto', margin = 10, scale = null, centre = true, mmPerUnit = 1 } = {}) {
  if (pageSize !== 'fit' && !SIZES[pageSize]) throw new Error(`Unknown page size: ${pageSize}`);
  const bb = region;
  const warnings = [];
  const w = Math.max(bb.maxx - bb.minx, 1e-9), h = Math.max(bb.maxy - bb.miny, 1e-9);
  const mPt = margin * PT_PER_MM;
  let pw, ph, k;
  if (pageSize === 'fit') {
    k = (scale > 0 ? scale : 1) * PT_PER_MM;
    const kMax = Math.min((MAX_PAGE_PT - 2 * mPt) / w, (MAX_PAGE_PT - 2 * mPt) / h);
    if (k > kMax) {
      k = kMax;
      warnings.push(`Drawing too large for one PDF page at the requested scale; scaled down to 1:${+(mmPerUnit * PT_PER_MM / k).toPrecision(4)}`); // real mm per paper mm
    }
    pw = w * k + 2 * mPt; ph = h * k + 2 * mPt;
  } else {
    const [a, b] = SIZES[pageSize];
    const land = orientation === 'landscape' || (orientation === 'auto' && w > h);
    [pw, ph] = land ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
    k = scale > 0 ? scale * PT_PER_MM : Math.min((pw - 2 * mPt) / w, (ph - 2 * mPt) / h);
    if (scale > 0 && (w * k > pw - 2 * mPt + 1e-6 || h * k > ph - 2 * mPt + 1e-6)) warnings.push('Drawing does not fit inside the page margins at the requested scale');
  }
  const ox = (centre ? (pw - w * k) / 2 : mPt) - bb.minx * k, oy = (centre ? (ph - h * k) / 2 : mPt) - bb.miny * k;
  return { pw, ph, k, ox, oy, warnings };
}

/** Paper mm per drawing unit for a 1:n plot of a drawing whose unit is `mmPerUnit` millimetres. */
export const plotScale = (n, mmPerUnit = 1) => mmPerUnit / n;

/**
 * exportPdf(doc, opts) -> Promise<{bytes:Uint8Array, warnings:string[]}> (one page, vector).
 * opts: pageSize 'fit'|'A4'|'A3'|'A2'|'A1'|'A0'|'Letter' ('fit'), orientation 'auto'|'landscape'|'portrait',
 * margin (mm, 10), scale (null = fit to page | page mm per drawing unit), centre (true), region (area to plot in drawing
 * units, clipped; default the drawing extents), monochrome, lineweights, unicodeFonts (TTF/OTF bytes for text outside
 * WinAnsi, in fallback order: an array, or an async function returning one, called only when such text is plotted;
 * unicodeFont: a single font), scene (prebuilt). A layout sheet (opts.layout): paper 'layout' (its own paper, default) or a page size
 * name; area 'layout' (the sheet, default) | 'extents' | 'window' (the page setup's plot window), see layoutPlotRegion;
 * fit (true: the area scaled into the paper's margins, see pageFit; false: at layoutScale, centred); layoutScale
 * (paper mm per layout unit; null = paperMmPerUnit, the page setup's scale). The sheet on its own paper always plots 1:1.
 * Raster pictures (OLE2FRAME previews, IMAGE entities) are embedded in colour (also when monochrome: AutoCAD plots
 * raster images in colour); imageRgba(bitmap) -> {width, height, rgba} turns a loaded IMAGE bitmap (a browser
 * ImageBitmap) into pixels - a bitmap that already is {width, height, rgba} needs no provider.
 */
export async function exportPdf(doc, opts = {}) {
  const pdf = await newPdf();
  const warnings = await addPdfPage(pdf, doc, opts);
  const bytes = await pdf.save();
  opts.onProgress?.(1);
  return { bytes, warnings };
}

/** opts.signal aborted -> throws Error code 'CANCELLED' (the export then returns nothing) */
function checkAbort(opts) {
  if (opts.signal?.aborted) { const e = new Error('PDF export cancelled'); e.code = 'CANCELLED'; throw e; }
}

/**
 * exportPdfPages(sheets, opts) -> Promise<{bytes, warnings}>: one PDF, one page per sheet in order (PUBLISH).
 * sheets: [{doc, layout (null = model space), label, region (model sheet: area to plot, default opts.region, else the extents)}]; opts as exportPdf, applied to every sheet (a layout sheet uses
 * paper / fit, a model sheet pageSize / orientation / scale). Viewport scenes are built once per drawing and layer set.
 */
export async function exportPdfPages(sheets, opts = {}) {
  const pdf = await newPdf(), warnings = [];
  let cur = null, modelScene = null; // scene cache of the current drawing only: dropped when the next sheet is from another
  for (const sheet of sheets) {
    const { doc, layout = null, label = '' } = sheet;
    if (doc !== cur) { cur = doc; modelScene = memoModelScene(doc); }
    const i = sheets.indexOf(sheet), onProgress = opts.onProgress && ((f) => opts.onProgress((i + f) / sheets.length));
    const w = await addPdfPage(pdf, doc, { ...opts, onProgress, layout, modelScene: opts.modelScene ?? modelScene, scene: layout ? opts.scene : opts.scene ?? modelScene([]), region: layout ? null : sheet.region ?? opts.region });
    warnings.push(...w.map((m) => (label ? `${label}: ${m}` : m)));
  }
  const bytes = await pdf.save();
  opts.onProgress?.(1);
  return { bytes, warnings };
}

async function newPdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('ASH Draw Studio drawing');
  pdf.setCreator('ASH Draw Studio');
  return pdf;
}

const layerSet = (fr) => new Set((fr ?? []).map((n) => String(n).toUpperCase()));
const setKey = (s) => [...s].sort().join('\u0001');

/**
 * (frozen layers) -> model scene. A drawing's scene can take a gigabyte, so one full scene is kept: the base, built
 * for prepare(sets)'s common frozen layers (those frozen in every viewport of the sheet). A viewport that freezes more
 * gets a scene derived from the base (deriveScene: only the entities on those layers rebuilt), the last one kept.
 * A set that is not a superset of the base's rebuilds the base.
 */
function memoModelScene(doc) {
  let base = null, baseKey = null, baseSet = null, der = null, derKey = null;
  const full = (s) => { base = der = null; derKey = null; base = buildScene(docWithFrozen(doc, [...s])); baseKey = setKey(s); baseSet = s; return base; };
  const get = (fr) => {
    const s = layerSet(fr), k = setKey(s);
    if (k === baseKey) return base;
    if (k === derKey) return der;
    if (!base || [...baseSet].some((n) => !s.has(n))) return full(s);
    der = null; derKey = null;
    der = deriveScene(doc, base, baseSet, s); derKey = k;
    return der;
  };
  get.prepare = (sets) => {
    const all = sets.map(layerSet), common = new Set([...(all[0] ?? [])].filter((n) => all.every((s) => s.has(n))));
    if (setKey(common) !== baseKey) full(common);
  };
  return get;
}

/**
 * the model scene with the layers in `s` frozen, from `base` (built with `baseSet` frozen, baseSet within s): items of
 * the entities that may draw on a layer of s outside baseSet are rebuilt, the others' base items are reused (same
 * order and extents as buildScene). An entity may draw on its own layer, its block's (nested) entity and attribute
 * layers; a DIMENSION, MLINE, MLEADER or a block holding one is always rebuilt.
 */
export function deriveScene(doc, base, baseSet, s) {
  const extra = new Set([...s].filter((n) => !baseSet.has(n)));
  const ents = doc.entities;
  for (let i = 1; i < ents.length; i++) if (ents[i].id === ents[i - 1].id) return buildScene(docWithFrozen(doc, [...s])); // items not attributable
  const on = (l) => extra.has(String(l ?? '0').toUpperCase());
  const blockHit = new Map();
  const hits = (e) => {
    if (on(e.layer) || e.type === 'DIMENSION' || e.type === 'MLINE' || e.type === 'MLEADER') return true;
    if ((e.attribs ?? []).some((a) => on(a.layer))) return true;
    if (e.type !== 'INSERT') return false;
    if (blockHit.has(e.block)) return blockHit.get(e.block);
    blockHit.set(e.block, true); // a block that (wrongly) holds itself: rebuilt
    const hit = (doc.blocks.get(e.block)?.entities ?? []).some(hits);
    blockHit.set(e.block, hit);
    return hit;
  };
  const redo = ents.filter(hits);
  const delta = buildScene({ ...docWithFrozen(doc, [...s]), entities: redo });
  const items = [], bi = base.items, di = delta.items;
  let p = 0, q = 0, r = 0, bbox = null, uiBox = null;
  const grow = (b, x) => (b ? { minx: Math.min(b.minx, x.minx), miny: Math.min(b.miny, x.miny), maxx: Math.max(b.maxx, x.maxx), maxy: Math.max(b.maxy, x.maxy) } : { ...x });
  const take = (arr, i, id) => { for (; i < arr.length && arr[i].id === id; i++) { const it = arr[i]; items.push(it); if (it.bbox) { if (it.ui) uiBox = grow(uiBox, it.bbox); else bbox = grow(bbox, it.bbox); } } return i; };
  for (const e of ents) {
    if (r < redo.length && redo[r] === e) { r++; q = take(di, q, e.id); for (; p < bi.length && bi[p].id === e.id; p++); } else p = take(bi, p, e.id);
  }
  return { items, bbox: bbox ?? uiBox };
}

/** a number as pdf-lib writes an operand (PDFNumber: no exponent notation) */
const num = (v) => { const t = String(v); return t.includes('e') ? numberToString(v) : t; };
const CHUNK = 1 << 16;
const PROGRESS_STEP = 2048;
/**
 * contentWriter() -> the page's content stream, written as text and deflated as it is produced (a large drawing's
 * millions of path operators are never held as pdf-lib PDFOperator objects): push(...operators) serialises pdf-lib
 * operators as pdf-lib does (one per line); w(text) appends operator text; flush() hands a full chunk to the
 * compressor; finish() -> the FlateDecode bytes.
 */
export function contentWriter() {
  const cs = new CompressionStream('deflate'), wr = cs.writable.getWriter(), parts = [], enc = new TextEncoder();
  const read = (async () => { for await (const c of cs.readable) parts.push(c); })();
  const bytes = (t) => { // the text's char codes as bytes (copyStringIntoBuffer), ASCII in practice
    if (!/[^\x00-\x7f]/.test(t)) return enc.encode(t);
    const b = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
    return b;
  };
  const out = {
    s: '',
    push(...ops) { for (const op of ops) out.s += `${op}\n`; },
    w(t) { out.s += t; },
    async flush(all = false) { if (!out.s.length || (!all && out.s.length < CHUNK)) return; const t = out.s; out.s = ''; await wr.write(bytes(t)); },
    async finish() {
      await out.flush(true); await wr.close(); await read;
      const r = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { r.set(p, o); o += p.length; }
      return r;
    },
  };
  return out;
}

/** fonts embedded in a PDF, shared by its pages */
const FONTS = new WeakMap();
/** raster pictures embedded in a PDF (pixel source object -> image XObject ref), shared by its pages */
const PICTURES = new WeakMap();

/** an RGBA picture as a PDF image XObject (Flate RGB, with a soft mask when any pixel is not opaque) */
function embedRgba(pdf, { width, height, rgba }) {
  const n = width * height, rgb = new Uint8Array(n * 3), a = new Uint8Array(n);
  let alpha = false;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2];
    if ((a[i] = rgba[i * 4 + 3]) !== 255) alpha = true;
  }
  const dict = (cs) => ({ Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: cs, BitsPerComponent: 8 });
  const d = dict('DeviceRGB');
  if (alpha) d.SMask = pdf.context.register(pdf.context.flateStream(a, dict('DeviceGray')));
  return pdf.context.register(pdf.context.flateStream(rgb, d));
}

/** draw one sheet (exportPdf options) on a new page of `pdf`; returns the warnings */
async function addPdfPage(pdf, doc, opts) {
  const { monochrome = false, lineweights = true, unicodeFont = null, layout = null } = opts;
  const uniSource = opts.unicodeFonts ?? (unicodeFont ? [unicodeFont] : null);
  const region = layout ? null : opts.region ?? null;
  // a layout plots at 1:1 on its own paper: its entities, then each viewport's model view clipped to the viewport
  const paperDoc = layout ? Object.create(doc, { entities: { value: layout.entities } }) : doc;
  const scene = (layout ? opts.paperScene : opts.scene) || buildScene(paperDoc);
  const bb = region || scene.bbox || { minx: 0, miny: 0, maxx: 100, maxy: 100 };
  let pw, ph, k, ox, oy, warnings, clipBox = region;
  if (layout) {
    // the sheet at 1:1 on the layout's own paper; or the plot area (sheet, extents or window) at a scale or fitted,
    // centred on the layout's paper or another: one scale + offset applied to every layout coordinate; line weights
    // stay their plotted width (AutoCAD: lineweights not scaled)
    const lp = layoutPage(layout), area = opts.area ?? 'layout', own = !opts.paper || opts.paper === 'layout';
    let s = 1, dx = 0, dy = 0, reg = lp.sheet;
    ({ pw, ph, k } = lp); warnings = [];
    if (area !== 'layout' || !own) {
      reg = layoutPlotRegion(layout, area, scene.bbox);
      k = (opts.layoutScale ?? paperMmPerUnit(layout.plot)) * PT_PER_MM;
      const w = (reg.maxx - reg.minx) * k, h = (reg.maxy - reg.miny) * k, fit = opts.fit !== false;
      const f = own ? placeOnPage(w, h, lp.pw, lp.ph, { fit }) : pageFit(w, h, opts.paper, { fit });
      ({ pw, ph } = f); s = f.scale; dx = f.ox; dy = f.oy; clipBox = reg;
      const paperName = own ? "the layout's paper" : opts.paper;
      if (!f.fits) warnings.push(area === 'layout' && opts.layoutScale == null ? `${layout.name}: the sheet is larger than ${opts.paper} at 1:1; its edges are cut off`
        : `${layout.name}: the plot area (${area}) is larger than ${paperName} at this scale; its edges are cut off`);
    }
    k *= s; ox = dx - reg.minx * k; oy = dy - reg.miny * k;
  } else ({ pw, ph, k, ox, oy, warnings } = plotLayout(bb, opts));
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;

  const page = pdf.addPage([pw, ph]);
  // everything the page draws (pushOperators, drawText) goes into the streamed writer, set as the page's content stream
  const ops = contentWriter();
  page.contentStream = ops;
  // a window or view plots only what lies inside it; a sheet on other paper only the sheet
  const cb = clipBox;
  if (cb) page.pushOperators(pushGraphicsState(), moveTo(X(cb.minx), Y(cb.miny)), lineTo(X(cb.maxx), Y(cb.miny)), lineTo(X(cb.maxx), Y(cb.maxy)), lineTo(X(cb.minx), Y(cb.maxy)), closePath(), clip(), endPath());
  if (!FONTS.has(pdf)) FONTS.set(pdf, { HELV: { '00': await pdf.embedFont(StandardFonts.Helvetica) }, uni: null, shape: null });
  const fonts = FONTS.get(pdf), helv = fonts.HELV['00'];
  const helvChars = new Set(helv.getCharacterSet());
  let missing = 0;
  const missedChars = new Set(); // the distinct characters behind `missing`, for the warning

  const keepGreys = !!doc.isCompare; // a comparison keeps its unchanged-grey in monochrome, so it still stands back from the changes
  const colOf = (style) => colorRgb(style, { monochrome, keepGreys }).map((v) => v / 255);
  const lwPt = (style) => Math.max(lineweightMm(style, lineweights) * PT_PER_MM, MIN_LW_PT);
  // objects left out for non-finite coordinates (a bad op skipped, the rest drawn) and hatches too dense to draw
  let bad = 0, tints = 0, itemBad = false;
  const pathOps = (pathData) => { if (walkOps(pathData, {
    moveTo: (x, y) => ops.w(`${num(X(x))} ${num(Y(y))} m\n`),
    lineTo: (x, y) => ops.w(`${num(X(x))} ${num(Y(y))} l\n`),
    close: () => ops.w('h\n'),
    arc: (cx, cy, rx, ry, rot, t0, sw) => {
      // cubic Bezier per <= 90 degree piece: control arms = 4/3 tan(dt/4) times the tangent P'(t)
      const n = Math.max(1, Math.ceil(Math.abs(sw) / (Math.PI / 2) - 1e-9)), dt = sw / n, a = (4 / 3) * Math.tan(dt / 4);
      const c = Math.cos(rot), s = Math.sin(rot);
      const P = (t) => [cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c];
      const D = (t) => [-rx * Math.sin(t) * c - ry * Math.cos(t) * s, -rx * Math.sin(t) * s + ry * Math.cos(t) * c];
      for (let i = 0; i < n; i++) {
        const ta = t0 + i * dt, tb = ta + dt, pa = P(ta), pb = P(tb), da = D(ta), db = D(tb);
        ops.w(`${num(X(pa[0] + a * da[0]))} ${num(Y(pa[1] + a * da[1]))} ${num(X(pb[0] - a * db[0]))} ${num(Y(pb[1] - a * db[1]))} ${num(X(pb[0]))} ${num(Y(pb[1]))} c\n`);
      }
    },
  })) itemBad = true; };
  const dashPt = (arr) => (arr ? arr.map((d) => d * k) : null);
  // linetype dashes: points per drawing unit of their pattern - inside a viewport with PSLTSCALE 1 the paper's (ltk)
  let ltk = null;
  const ltDashPt = (arr) => (arr ? arr.map((d) => d * (ltk ?? k)) : null);
  // transparency: one ExtGState (CA / ca) per opacity, set inside the item's graphics state
  const gsNames = new Map();
  const opacity = (style) => (opts.transparency === false ? 1 : style.alpha ?? 1);
  const alphaState = (style, a = opacity(style)) => {
    if (a >= 1) return;
    let name = gsNames.get(a);
    if (!name) gsNames.set(a, (name = page.node.newExtGState('GSa', pdf.context.obj({ Type: 'ExtGState', CA: a, ca: a }))));
    ops.push(setGraphicsState(name));
  };
  const strokeState = (style, dashes) => {
    alphaState(style);
    const [r, g, b] = colOf(style);
    ops.w(`${num(r)} ${num(g)} ${num(b)} RG\n${num(lwPt(style))} w\n1 J\n1 j\n`);
    // a pattern too fine to see on paper is drawn continuous
    if (dashes && dashes.reduce((s, d) => s + d, 0) >= 1) ops.push(setDashPattern(dashes, 0));
  };
  const fillState = (style) => { alphaState(style); const [r, g, b] = colOf(style); ops.push(setFillingRgbColor(r, g, b)); };
  let msize;

  // text outside WinAnsi: the Unicode fonts are loaded and embedded (subset) the first time a sheet needs one, then
  // every such line is bidi-ordered, split by font coverage and shaped (pdfText.js); no font for a character -> '?'
  const needsUni = (t) => [...t].some((ch) => !helvChars.has(ch.codePointAt(0)));
  const loadUni = async () => {
    if (!fonts.shape) {
      // a font that cannot be loaded or embedded is left out: its characters plot as '?' and a warning says so
      let src = null;
      try { src = typeof uniSource === 'function' ? await uniSource() : uniSource; } catch { fonts.loadFailed = true; }
      if (src?.failed?.length) fonts.loadFailed = true;
      if (src?.length) pdf.registerFontkit((await import('@pdf-lib/fontkit')).default);
      fonts.uni = [];
      for (const b of src ?? []) {
        try {
          const f = await pdf.embedFont(b, { subset: true });
          // the ToUnicode map gets no entry for a glyph without a code point (a mark: it would be an empty <>)
          const e = f.embedder, make = e.embedUnicodeCmap;
          e.embedUnicodeCmap = function (ctx) {
            const gc = this.glyphCache;
            this.glyphCache = { access: () => gc.access().filter((g) => g?.codePoints.length) };
            try { return make.call(this, ctx); } finally { this.glyphCache = gc; }
          };
          fonts.uni.push(f);
        } catch { fonts.loadFailed = true; }
      }
      fonts.shape = textShaper(helv, fonts.uni);
    }
    return fonts.shape;
  };
  /** draw shaped text (a shape() result) at (x, y) of a frame (cm a b c d e f) in the given fill colour */
  const shapedText = (sh, frame, size, x, y, rgbCol, style) => {
    missing += sh.miss;
    for (const c of sh.missed ?? []) missedChars.add(c);
    ops.push(pushGraphicsState(), concatTransformationMatrix(...frame));
    alphaState(style); ops.push(setFillingRgbColor(...rgbCol), ...textOps(page, sh, size, x, y), popGraphicsState());
  };

  // MTEXT runs: Helvetica in its bold / oblique variants (embedded on first use), shaped Unicode text for other scripts
  const HELV = fonts.HELV;
  const HELV_NAME = { '10': StandardFonts.HelveticaBold, '01': StandardFonts.HelveticaOblique, '11': StandardFonts.HelveticaBoldOblique };
  const variant = (p) => `${p.bold ? 1 : 0}${p.italic ? 1 : 0}`;
  const prepareMText = async (mt) => {
    for (const para of mt.paras) {
      for (const r of para.runs) {
        if (!r.props) continue;
        const key = variant(r.props);
        if (!HELV[key]) HELV[key] = await pdf.embedFont(HELV_NAME[key]);
        if (needsUni(r.stack ? r.stack.a + r.stack.b : r.text)) await loadUni();
      }
    }
  };
  const runWidth = (t, p) => (needsUni(t) ? fonts.shape(t).width * p.h : HELV[variant(p)].widthOfTextAtSize(t, p.h));
  // lines holding right-to-left text go in visual order (shared with the screen: bidiText.js); each piece shapes at its level
  const reorderPdfLines = (glyphs) => reorderLines(glyphs, (text, level, g) => loadedShape(text, level, g).width * g.h * (g.wf || 1) * (g.track || 1));
  const loadedShape = (t, level, p) => fonts.shape(t, level, HELV[variant(p)]);

  // box: the world window plotted, to which XLINE / RAY items are clipped (AutoCAD plots their visible part)
  // progress: part `part` of `parts` (each viewport, then the sheet's own items) by items drawn; every PROGRESS_STEP
  // items the abort signal is checked and, at most every 50 ms, the event loop gets a turn (a Cancel click)
  let parts = 1, lastYield = performance.now();
  const step = async (part, f) => {
    checkAbort(opts);
    opts.onProgress?.((part + f) / parts);
    if ((opts.signal || opts.onProgress) && performance.now() - lastYield > 50) { await new Promise((r) => setTimeout(r, 0)); lastYield = performance.now(); }
  };
  const drawItems = async (scn, box, cull = null, part = 0) => {
  msize = markerSize(scn.bbox);
  const all = scn.items, n = all.length;
  for (let i = 0; i < n; i++) {
    if (i % PROGRESS_STEP === 0) await step(part, i / n);
    let it = all[i];
    if (itemBad) { bad++; itemBad = false; }
    // an item wholly outside the plot area is not written at all (the clip would hide it, but its points would stay in the file)
    if (cull && it.bbox && (it.bbox.maxx < cull.minx || it.bbox.minx > cull.maxx || it.bbox.maxy < cull.miny || it.bbox.miny > cull.maxy)) continue;
    if (it.oleFrame) continue; // an OLE object's border is shown on screen but not plotted (AutoCAD OLEFRAME=2)
    if (doc.layers.get(it.style?.layerName)?.plot === false) continue; // a non-plotting layer is shown, never plotted
    if (it.inf && !(it = infiniteItem(it, box))) continue;
    if (!finiteAnchor(it)) { bad++; continue; }
    if (it.kind === 'image') {
      // a raster picture (OLE preview or IMAGE): pixel (x, y from the top row) sits at p + u x + v (rows - y)
      const im = it.image, bmp = im.ole ? im.ole : doc.images?.get(im.path)?.bitmap;
      if (!PICTURES.has(pdf)) PICTURES.set(pdf, new WeakMap());
      const cache = PICTURES.get(pdf);
      let ref = cache.get(bmp);
      if (!ref) {
        const src = im.ole ?? (bmp && (opts.imageRgba ? opts.imageRgba(bmp) : bmp));
        if (!src?.rgba) continue;
        cache.set(bmp, (ref = embedRgba(pdf, src)));
      }
      ops.push(pushGraphicsState());
      if (im.clipPts?.length >= 3) {
        im.clipPts.forEach((q, i) => ops.push(i ? lineTo(X(q.x), Y(q.y)) : moveTo(X(q.x), Y(q.y))));
        ops.push(closePath(), clip(), endPath());
      }
      alphaState(it.style, 1 - (im.fade || 0) / 100);
      ops.push(concatTransformationMatrix(im.u.x * k * im.size.x, im.u.y * k * im.size.x, im.v.x * k * im.size.y, im.v.y * k * im.size.y, X(im.p.x), Y(im.p.y)));
      ops.push(PDFOperator.of(PDFOperatorNames.DrawObject, [page.node.newXObject('Img', ref)]), popGraphicsState());
    } else if (it.kind === 'path') {
      ops.w('q\n'); strokeState(it.style, ltDashPt(dashUnits(doc, it.style)));
      pathOps(it.ops); ops.w('S\nQ\n');
      if (it.arrow) {
        const t = arrowTriangle(it.arrow, msize);
        ops.push(pushGraphicsState()); fillState(it.style);
        ops.push(moveTo(X(t[0].x), Y(t[0].y)), lineTo(X(t[1].x), Y(t[1].y)), lineTo(X(t[2].x), Y(t[2].y)), closePath(), fillEvenOdd(), popGraphicsState());
      }
    } else if (it.kind === 'fill' || (it.kind === 'hatch' && it.solid)) {
      // a wide polyline band thinner than the minimum plotted line weight is outlined at that weight, so it still prints
      const thin = it.wide && !(it.w * k >= MIN_LW_PT);
      ops.push(pushGraphicsState()); fillState(it.style);
      if (thin) { const [r, g, b] = colOf(it.style); ops.push(setStrokingRgbColor(r, g, b), setLineWidth(MIN_LW_PT), setLineCap(1), setLineJoin(1)); }
      pathOps(it.ops); ops.push(thin ? fillEvenOddAndStroke() : fillEvenOdd(), popGraphicsState());
    } else if (it.kind === 'hatch') {
      const fams = hatchFamilies(it);
      ops.push(pushGraphicsState());
      if (fams === null) {
        // too dense to draw line by line: a light tint of the hatch colour
        tints++;
        const [r, g, b] = colOf(it.style).map((v) => 1 - (1 - v) * 0.3);
        alphaState(it.style); ops.push(setFillingRgbColor(r, g, b)); pathOps(it.ops); ops.push(fillEvenOdd(), popGraphicsState());
        continue;
      }
      pathOps(it.ops); ops.w('W*\nn\n');
      for (const f of fams) {
        ops.push(pushGraphicsState()); strokeState(it.style, dashPt(f.dashes));
        for (const s of f.segs) if (!finiteSeg(s)) itemBad = true; else ops.w(`${num(X(s[0]))} ${num(Y(s[1]))} m\n${num(X(s[2]))} ${num(Y(s[3]))} l\n`);
        ops.push(stroke(), popGraphicsState());
      }
      ops.push(popGraphicsState());
    } else if (it.kind === 'point') {
      const s = msize / 3;
      ops.push(pushGraphicsState()); strokeState(it.style, null);
      ops.push(moveTo(X(it.p.x - s), Y(it.p.y)), lineTo(X(it.p.x + s), Y(it.p.y)), moveTo(X(it.p.x), Y(it.p.y - s)), lineTo(X(it.p.x), Y(it.p.y + s)), stroke(), popGraphicsState());
    } else if (it.kind === 'text' && it.mt) {
      await prepareMText(it.mt);
      const lay = mtextItemLayout(it, runWidth);
      const glyphs = fonts.shape ? reorderPdfLines(lay.glyphs) : lay.glyphs;
      const c = Math.cos(it.rot), s = Math.sin(it.rot);
      const rc = (col) => runRgb(col, it.style, { monochrome, keepGreys }).map((v) => v / 255);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, X(it.p.x), Y(it.p.y)));
      // layout is in drawing units, y down; the text frame is in page points, y up
      for (const g of glyphs) {
        if (!g.text) continue;
        const frame = [g.wf || 1, 0, Math.tan((g.oblique || 0) * Math.PI / 180), 1, g.x * k, -g.y * k];
        if (g.level != null || needsUni(g.text)) {
          shapedText(fonts.shape(g.text, g.level ?? null, HELV[variant(g)]), frame, g.h * k, 0, 0, rc(g.color), it.style);
          continue;
        }
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frame));
        page.drawText(g.text, { x: 0, y: 0, size: g.h * k, font: HELV[variant(g)], color: rgb(...rc(g.color)), opacity: opacity(it.style) });
        page.pushOperators(popGraphicsState());
      }
      for (const r of reorderRules(lay.rules, glyphs)) {
        const [cr, cg, cb] = rc(r.color);
        alphaState(it.style);
        page.pushOperators(setStrokingRgbColor(cr, cg, cb), setLineWidth(r.h * k * 0.06), moveTo(r.x1 * k, -r.y * k), lineTo(r.x2 * k, -r.y * k), stroke());
      }
      page.pushOperators(popGraphicsState());
    } else if (it.kind === 'text') {
      const lines = it.lines.map((l) => l.replace(/\t/g, ' '));
      const [r, g, b] = colOf(it.style);
      const c = Math.cos(it.rot), s = Math.sin(it.rot), wf = it.wf || 1;
      let frame = [wf * c, wf * s, -s, c, X(it.p.x), Y(it.p.y)];
      if (it.xf) { // backward / upside down (DXF 71): the drawing-unit mirror carried to page points, then the text frame
        const [a, b, cc, d, e, f] = it.xf;
        frame = [a * frame[0] + cc * frame[1], b * frame[0] + d * frame[1], a * frame[2] + cc * frame[3], b * frame[2] + d * frame[3],
          a * frame[4] + cc * frame[5] + X(e) - a * X(0) - cc * Y(0), b * frame[4] + d * frame[5] + Y(f) - b * X(0) - d * Y(0)];
      }
      if (lines.some(needsUni)) {
        // shaped: aligned (left / centre / right / fit) by the shaped width
        const shape = await loadUni();
        const lay = layoutText({ ...it, lines }, (t) => shape(t).width * it.h);
        for (const l of lay.lines) if (l.text) shapedText(shape(l.text), frame, it.h * k, l.x * k, -l.y * k, [r, g, b], it.style);
        continue;
      }
      const font = helv, lay = layoutText({ ...it, lines }, (t) => font.widthOfTextAtSize(t, it.h));
      for (const l of lay.lines) {
        if (!l.text) continue;
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frame));
        // layout is in drawing units, y down; the text frame is in page points, y up
        page.drawText(l.text, { x: l.x * k, y: -l.y * k, size: it.h * k, font, color: rgb(r, g, b), opacity: opacity(it.style) });
        page.pushOperators(popGraphicsState());
      }
    }
    await ops.flush();
  }
  if (itemBad) { bad++; itemBad = false; }
  };
  if (layout) {
    const modelScene = opts.modelScene ?? memoModelScene(doc);
    const paper = { ox, oy, k }, psl = doc.header?.psltscale !== 0; // PSLTSCALE 1: viewport linetypes at paper scale
    const vps = layout.entities.filter((v) => v.type === 'VIEWPORT' && !isPaperViewport(v) && v.on !== false && v.width > 0 && v.height > 0);
    parts = vps.length + 1;
    await step(0, 0);
    if (vps.length) modelScene.prepare?.(vps.map((v) => v.frozen ?? []));
    for (const [part, v] of vps.entries()) {
      const s = viewportScale(v), cx = X(v.c.x), cy = Y(v.c.y), hw = (v.width / 2) * k, hh = (v.height / 2) * k;
      ops.push(pushGraphicsState(), moveTo(cx - hw, cy - hh), lineTo(cx + hw, cy - hh), lineTo(cx + hw, cy + hh), lineTo(cx - hw, cy + hh), closePath(), clip(), endPath());
      const ring = viewportClipRing(v, layout.entities); // a polygon-clipped viewport: and to its boundary
      if (ring) { ring.forEach((p, i) => ops.push(i ? lineTo(X(p.x), Y(p.y)) : moveTo(X(p.x), Y(p.y)))); ops.push(closePath(), clip(), endPath()); }
      ltk = psl ? paper.k : null;
      const t = v.twist || 0, c = Math.cos(t), sn = Math.sin(t);
      if (t) ops.push(concatTransformationMatrix(c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy)); // turn about the viewport centre
      k = paper.k / s; ox = cx - v.viewCenter.x * k; oy = cy - v.viewCenter.y * k;
      const R = Math.hypot(v.width, v.height) / 2 * s; // the viewport's model window (any twist), clipped above
      const win = { minx: v.viewCenter.x - R, miny: v.viewCenter.y - R, maxx: v.viewCenter.x + R, maxy: v.viewCenter.y + R };
      await drawItems(modelScene(v.frozen ?? []), win, win, part); // what lies outside the viewport's window is not written
      ({ ox, oy, k } = paper); ltk = null;
      ops.push(popGraphicsState());
    }
  }
  await drawItems(scene, bb, layout ? null : region, parts - 1);
  await step(parts - 1, 1);
  if (cb) page.pushOperators(popGraphicsState());
  page.contentStream = undefined;
  page.node.addContentStream(pdf.context.register(pdf.context.stream(await ops.finish(), { Filter: PDFName.of('FlateDecode') })));
  warnings.push(...exportNotes(bad, tints));
  if (missing) warnings.push(missingCharsWarning(missing, [...missedChars], fonts.loadFailed ? 'the Unicode font could not be loaded' : fonts.uni?.length ? 'no font has them' : 'no Unicode font'));
  return warnings;
}
