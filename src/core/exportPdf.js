// ASH Draw Studio - PDF export (pure ES module, vector output through pdf-lib content-stream operators).
//
//   const { bytes, warnings } = await exportPdf(doc, { pageSize: 'A3', orientation: 'auto' });
import {
  PDFDocument, StandardFonts, PageSizes, rgb, PDFOperator, PDFOperatorNames,
  pushGraphicsState, popGraphicsState, setLineWidth, setDashPattern, setLineCap, setLineJoin,
  setStrokingRgbColor, setFillingRgbColor, moveTo, lineTo, appendBezierCurve, closePath, stroke,
  clip, clipEvenOdd, endPath, concatTransformationMatrix, setGraphicsState,
} from 'pdf-lib';
import { buildScene, docWithFrozen, infiniteItem } from './render.js';
import { layoutPage, viewportScale, isPaperViewport } from './layouts.js';
import {
  walkOps, colorRgb, lineweightMm, dashUnits, hatchFamilies, layoutText, markerSize, arrowTriangle, runRgb, mtextItemLayout,
} from './exportSvg.js';
import { textShaper, textOps, hasRtl, bidiLevels, visualOrder } from './pdfText.js';

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
  const m = margin * PT_PER_MM, w = Math.max(sheetW, 1e-9), h = Math.max(sheetH, 1e-9);
  const scale = fit ? Math.min((pw - 2 * m) / w, (ph - 2 * m) / h) : 1;
  const fits = w * scale <= pw - 2 * m + 1e-6 && h * scale <= ph - 2 * m + 1e-6;
  return { pw, ph, scale, ox: (pw - w * scale) / 2, oy: (ph - h * scale) / 2, orientation: land ? 'landscape' : 'portrait', fits };
}

/**
 * plotLayout(region, opts) -> {pw, ph, k, ox, oy, warnings}: page size (points) and the drawing -> page transform
 * (page = o + k * drawing; k = points per drawing unit) for plotting `region` {minx,miny,maxx,maxy} (drawing units).
 * opts: pageSize, orientation, margin (mm), scale (null = fit | paper mm per drawing unit), centre (true = centred on the
 * page, false = region's lower-left corner at the lower-left margin).
 */
export function plotLayout(region, { pageSize = 'fit', orientation = 'auto', margin = 10, scale = null, centre = true } = {}) {
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
      warnings.push(`Drawing too large for one PDF page at the requested scale; scaled down to 1:${+(PT_PER_MM / k).toPrecision(4)}`);
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
 * unicodeFont: a single font), scene (prebuilt). A layout sheet (opts.layout): paper 'layout' (its own paper at 1:1, default) or a page size
 * name, with fit (true: scaled into the paper's margins, see pageFit; false: 1:1, centred).
 */
export async function exportPdf(doc, opts = {}) {
  const pdf = await newPdf();
  const warnings = await addPdfPage(pdf, doc, opts);
  return { bytes: await pdf.save(), warnings };
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
    const w = await addPdfPage(pdf, doc, { ...opts, layout, modelScene: opts.modelScene ?? modelScene, scene: layout ? opts.scene : opts.scene ?? modelScene([]), region: layout ? null : sheet.region ?? opts.region });
    warnings.push(...w.map((m) => (label ? `${label}: ${m}` : m)));
  }
  return { bytes: await pdf.save(), warnings };
}

async function newPdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('ASH Draw Studio drawing');
  pdf.setCreator('ASH Draw Studio');
  return pdf;
}

/** (frozen layers) -> model scene, built once per layer set */
function memoModelScene(doc) {
  const m = new Map();
  return (fr) => { const key = fr.join('\u0001'); if (!m.has(key)) m.set(key, buildScene(docWithFrozen(doc, fr))); return m.get(key); };
}

/** fonts embedded in a PDF, shared by its pages */
const FONTS = new WeakMap();

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
    // 1:1 on the layout's own paper, or the sheet put on another paper (fitted or 1:1, centred): one scale + offset
    // applied to every layout coordinate; line weights stay their plotted width (AutoCAD: lineweights not scaled)
    const lp = layoutPage(layout);
    let s = 1, dx = 0, dy = 0;
    ({ pw, ph, k } = lp); warnings = [];
    if (opts.paper && opts.paper !== 'layout') {
      const f = pageFit(lp.pw, lp.ph, opts.paper, { fit: opts.fit !== false });
      ({ pw, ph } = f); s = f.scale; dx = f.ox; dy = f.oy; clipBox = lp.sheet;
      if (!f.fits) warnings.push(`${layout.name}: the sheet is larger than ${opts.paper} at 1:1; its edges are cut off`);
    }
    k *= s; ox = dx - lp.sheet.minx * k; oy = dy - lp.sheet.miny * k;
  } else ({ pw, ph, k, ox, oy, warnings } = plotLayout(bb, opts));
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;

  const page = pdf.addPage([pw, ph]);
  // a window or view plots only what lies inside it; a sheet on other paper only the sheet
  const cb = clipBox;
  if (cb) page.pushOperators(pushGraphicsState(), moveTo(X(cb.minx), Y(cb.miny)), lineTo(X(cb.maxx), Y(cb.miny)), lineTo(X(cb.maxx), Y(cb.maxy)), lineTo(X(cb.minx), Y(cb.maxy)), closePath(), clip(), endPath());
  if (!FONTS.has(pdf)) FONTS.set(pdf, { HELV: { '00': await pdf.embedFont(StandardFonts.Helvetica) }, uni: null, shape: null });
  const fonts = FONTS.get(pdf), helv = fonts.HELV['00'];
  const helvChars = new Set(helv.getCharacterSet());
  let missing = 0;

  const colOf = (style) => colorRgb(style, { monochrome }).map((v) => v / 255);
  const lwPt = (style) => Math.max(lineweightMm(style, lineweights) * PT_PER_MM, MIN_LW_PT);
  const ops = [];
  const pathOps = (pathData) => walkOps(pathData, {
    moveTo: (x, y) => ops.push(moveTo(X(x), Y(y))),
    lineTo: (x, y) => ops.push(lineTo(X(x), Y(y))),
    close: () => ops.push(closePath()),
    arc: (cx, cy, rx, ry, rot, t0, sw) => {
      // cubic Bezier per <= 90 degree piece: control arms = 4/3 tan(dt/4) times the tangent P'(t)
      const n = Math.max(1, Math.ceil(Math.abs(sw) / (Math.PI / 2) - 1e-9)), dt = sw / n, a = (4 / 3) * Math.tan(dt / 4);
      const c = Math.cos(rot), s = Math.sin(rot);
      const P = (t) => [cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c];
      const D = (t) => [-rx * Math.sin(t) * c - ry * Math.cos(t) * s, -rx * Math.sin(t) * s + ry * Math.cos(t) * c];
      for (let i = 0; i < n; i++) {
        const ta = t0 + i * dt, tb = ta + dt, pa = P(ta), pb = P(tb), da = D(ta), db = D(tb);
        ops.push(appendBezierCurve(
          X(pa[0] + a * da[0]), Y(pa[1] + a * da[1]), X(pb[0] - a * db[0]), Y(pb[1] - a * db[1]), X(pb[0]), Y(pb[1]),
        ));
      }
    },
  });
  const dashPt = (arr) => (arr ? arr.map((d) => d * k) : null);
  // transparency: one ExtGState (CA / ca) per opacity, set inside the item's graphics state
  const gsNames = new Map();
  const opacity = (style) => (opts.transparency === false ? 1 : style.alpha ?? 1);
  const alphaState = (style) => {
    const a = opacity(style);
    if (a >= 1) return;
    let name = gsNames.get(a);
    if (!name) gsNames.set(a, (name = page.node.newExtGState('GSa', pdf.context.obj({ Type: 'ExtGState', CA: a, ca: a }))));
    ops.push(setGraphicsState(name));
  };
  const strokeState = (style, dashes) => {
    alphaState(style);
    const [r, g, b] = colOf(style);
    ops.push(setStrokingRgbColor(r, g, b), setLineWidth(lwPt(style)), setLineCap(1), setLineJoin(1));
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
      const src = typeof uniSource === 'function' ? await uniSource() : uniSource;
      if (src?.length) pdf.registerFontkit((await import('@pdf-lib/fontkit')).default);
      fonts.uni = [];
      for (const b of src ?? []) fonts.uni.push(await pdf.embedFont(b, { subset: true }));
      fonts.shape = textShaper(helv, fonts.uni);
    }
    return fonts.shape;
  };
  /** draw shaped text (a shape() result) at (x, y) of a frame (cm a b c d e f) in the given fill colour */
  const shapedText = (sh, frame, size, x, y, rgbCol, style) => {
    missing += sh.miss;
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
  /**
   * an MTEXT line holding right-to-left text: its words / spaces (laid out in logical order) split at bidi level changes
   * and put in visual order from the line's left end; each piece then shapes at its level
   */
  const reorderLines = (glyphs) => {
    const byLine = new Map();
    for (const g of glyphs) if (g.li != null) (byLine.get(g.li) ?? byLine.set(g.li, []).get(g.li)).push(g);
    const moved = new Map();
    for (const group of byLine.values()) {
      if (!group.some((g) => hasRtl(g.text)) || group.some((g) => g.w == null)) continue; // stacks keep their place
      const levels = bidiLevels(group.map((g) => g.text).join(''));
      const pieces = [];
      let i = 0;
      for (const g of group) {
        for (let a = 0; a < g.text.length;) {
          let b = a + 1;
          while (b < g.text.length && levels[i + b] === levels[i + a]) b++;
          const text = g.text.slice(a, b), level = levels[i + a];
          pieces.push({ ...g, text, level, w: loadedShape(text, level).width * g.h * (g.wf || 1) * (g.track || 1) });
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
  };
  const loadedShape = (t, level) => fonts.shape(t, level);

  // box: the world window plotted, to which XLINE / RAY items are clipped (AutoCAD plots their visible part)
  const drawItems = async (scn, box, cull = null) => {
  msize = markerSize(scn.bbox);
  for (let it of scn.items) {
    // an item wholly outside the plot area is not written at all (the clip would hide it, but its points would stay in the file)
    if (cull && it.bbox && (it.bbox.maxx < cull.minx || it.bbox.minx > cull.maxx || it.bbox.maxy < cull.miny || it.bbox.miny > cull.maxy)) continue;
    if (doc.layers.get(it.style?.layerName)?.plot === false) continue; // a non-plotting layer is shown, never plotted
    if (it.inf && !(it = infiniteItem(it, box))) continue;
    if (it.kind === 'path') {
      ops.push(pushGraphicsState()); strokeState(it.style, dashPt(dashUnits(doc, it.style)));
      pathOps(it.ops); ops.push(stroke(), popGraphicsState());
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
        const [r, g, b] = colOf(it.style).map((v) => 1 - (1 - v) * 0.3);
        alphaState(it.style); ops.push(setFillingRgbColor(r, g, b)); pathOps(it.ops); ops.push(fillEvenOdd(), popGraphicsState());
        continue;
      }
      pathOps(it.ops); ops.push(clipEvenOdd(), endPath());
      for (const f of fams) {
        ops.push(pushGraphicsState()); strokeState(it.style, dashPt(f.dashes));
        for (const s of f.segs) ops.push(moveTo(X(s[0]), Y(s[1])), lineTo(X(s[2]), Y(s[3])));
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
      const glyphs = fonts.shape ? reorderLines(lay.glyphs) : lay.glyphs;
      const c = Math.cos(it.rot), s = Math.sin(it.rot);
      const rc = (col) => runRgb(col, it.style, { monochrome }).map((v) => v / 255);
      page.pushOperators(...ops.splice(0), pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, X(it.p.x), Y(it.p.y)));
      // layout is in drawing units, y down; the text frame is in page points, y up
      for (const g of glyphs) {
        if (!g.text) continue;
        const frame = [g.wf || 1, 0, Math.tan((g.oblique || 0) * Math.PI / 180), 1, g.x * k, -g.y * k];
        if (g.level != null || needsUni(g.text)) {
          shapedText(fonts.shape(g.text, g.level ?? null), frame, g.h * k, 0, 0, rc(g.color), it.style);
          page.pushOperators(...ops.splice(0));
          continue;
        }
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frame));
        page.drawText(g.text, { x: 0, y: 0, size: g.h * k, font: HELV[variant(g)], color: rgb(...rc(g.color)), opacity: opacity(it.style) });
        page.pushOperators(popGraphicsState());
      }
      for (const r of lay.rules) {
        const [cr, cg, cb] = rc(r.color);
        alphaState(it.style); page.pushOperators(...ops.splice(0));
        page.pushOperators(setStrokingRgbColor(cr, cg, cb), setLineWidth(r.h * k * 0.06), moveTo(r.x1 * k, -r.y * k), lineTo(r.x2 * k, -r.y * k), stroke());
      }
      page.pushOperators(popGraphicsState());
    } else if (it.kind === 'text') {
      const lines = it.lines.map((l) => l.replace(/\t/g, ' '));
      const [r, g, b] = colOf(it.style);
      const c = Math.cos(it.rot), s = Math.sin(it.rot), wf = it.wf || 1;
      if (lines.some(needsUni)) {
        // shaped: aligned (left / centre / right / fit) by the shaped width
        const shape = await loadUni();
        const lay = layoutText({ ...it, lines }, (t) => shape(t).width * it.h);
        for (const l of lay.lines) if (l.text) shapedText(shape(l.text), [wf * c, wf * s, -s, c, X(it.p.x), Y(it.p.y)], it.h * k, l.x * k, -l.y * k, [r, g, b], it.style);
        continue;
      }
      const font = helv, lay = layoutText({ ...it, lines }, (t) => font.widthOfTextAtSize(t, it.h));
      page.pushOperators(...ops.splice(0));
      for (const l of lay.lines) {
        if (!l.text) continue;
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(wf * c, wf * s, -s, c, X(it.p.x), Y(it.p.y)));
        // layout is in drawing units, y down; the text frame is in page points, y up
        page.drawText(l.text, { x: l.x * k, y: -l.y * k, size: it.h * k, font, color: rgb(r, g, b), opacity: opacity(it.style) });
        page.pushOperators(popGraphicsState());
      }
    }
    if (ops.length > 5000) page.pushOperators(...ops.splice(0));
  }
  };
  if (layout) {
    const modelScene = opts.modelScene ?? memoModelScene(doc);
    const paper = { ox, oy, k };
    for (const v of layout.entities) {
      if (v.type !== 'VIEWPORT' || isPaperViewport(v) || v.on === false || !(v.width > 0 && v.height > 0)) continue;
      const s = viewportScale(v), cx = X(v.c.x), cy = Y(v.c.y), hw = (v.width / 2) * k, hh = (v.height / 2) * k;
      ops.push(pushGraphicsState(), moveTo(cx - hw, cy - hh), lineTo(cx + hw, cy - hh), lineTo(cx + hw, cy + hh), lineTo(cx - hw, cy + hh), closePath(), clip(), endPath());
      const t = v.twist || 0, c = Math.cos(t), sn = Math.sin(t);
      if (t) ops.push(concatTransformationMatrix(c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy)); // turn about the viewport centre
      k = paper.k / s; ox = cx - v.viewCenter.x * k; oy = cy - v.viewCenter.y * k;
      const R = Math.hypot(v.width, v.height) / 2 * s; // the viewport's model window (any twist), clipped above
      await drawItems(modelScene(v.frozen ?? []), { minx: v.viewCenter.x - R, miny: v.viewCenter.y - R, maxx: v.viewCenter.x + R, maxy: v.viewCenter.y + R });
      ({ ox, oy, k } = paper);
      ops.push(popGraphicsState());
    }
  }
  await drawItems(scene, bb, layout ? null : region);
  if (ops.length) page.pushOperators(...ops.splice(0));
  if (cb) page.pushOperators(popGraphicsState());
  if (missing) warnings.push(`${missing} text characters could not be drawn (no Unicode font)`);
  return warnings;
}
