// ASH Draw Studio - PDF export (pure ES module, vector output through pdf-lib content-stream operators).
//
//   const { bytes, warnings } = await exportPdf(doc, { pageSize: 'A3', orientation: 'auto' });
import {
  PDFDocument, StandardFonts, PageSizes, rgb, PDFOperator, PDFOperatorNames,
  pushGraphicsState, popGraphicsState, setLineWidth, setDashPattern, setLineCap, setLineJoin,
  setStrokingRgbColor, setFillingRgbColor, moveTo, lineTo, appendBezierCurve, closePath, stroke,
  clip, clipEvenOdd, endPath, concatTransformationMatrix,
} from 'pdf-lib';
import { buildScene, docWithFrozen } from './render.js';
import { layoutPage, viewportScale } from './layouts.js';
import {
  walkOps, colorRgb, lineweightMm, dashUnits, hatchFamilies, layoutText, markerSize, arrowTriangle, runRgb, mtextItemLayout,
} from './exportSvg.js';

const PT_PER_MM = 72 / 25.4;
const MAX_PAGE_PT = 14400;          // PDF 1.x user-unit page size limit (200 inch)
const MIN_LW_PT = 0.25;
const fillEvenOdd = () => PDFOperator.of(PDFOperatorNames.FillEvenOdd);
const SIZES = { A4: PageSizes.A4, A3: PageSizes.A3, A2: PageSizes.A2, A1: PageSizes.A1, A0: PageSizes.A0, Letter: PageSizes.Letter };

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
 * units, clipped; default the drawing extents), monochrome, lineweights, unicodeFont (TTF/OTF bytes for text outside
 * WinAnsi), scene (prebuilt).
 */
export async function exportPdf(doc, opts = {}) {
  const { monochrome = false, lineweights = true, unicodeFont = null, layout = null } = opts;
  const region = layout ? null : opts.region ?? null;
  // a layout plots at 1:1 on its own paper: its entities, then each viewport's model view clipped to the viewport
  const paperDoc = layout ? Object.create(doc, { entities: { value: layout.entities } }) : doc;
  const scene = (layout ? opts.paperScene : opts.scene) || buildScene(paperDoc);
  const bb = region || scene.bbox || { minx: 0, miny: 0, maxx: 100, maxy: 100 };
  let pw, ph, k, ox, oy, warnings;
  if (layout) {
    const lp = layoutPage(layout);
    ({ pw, ph, k } = lp); ox = -lp.sheet.minx * k; oy = -lp.sheet.miny * k; warnings = [];
  } else ({ pw, ph, k, ox, oy, warnings } = plotLayout(bb, opts));
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;

  const pdf = await PDFDocument.create();
  pdf.setTitle('ASH Draw Studio drawing');
  pdf.setCreator('ASH Draw Studio');
  const page = pdf.addPage([pw, ph]);
  // a window or view plots only what lies inside it
  if (region) page.pushOperators(pushGraphicsState(), moveTo(X(bb.minx), Y(bb.miny)), lineTo(X(bb.maxx), Y(bb.miny)), lineTo(X(bb.maxx), Y(bb.maxy)), lineTo(X(bb.minx), Y(bb.maxy)), closePath(), clip(), endPath());
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvChars = new Set(helv.getCharacterSet());
  let uniFont = null, missing = 0;

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
  const strokeState = (style, dashes) => {
    const [r, g, b] = colOf(style);
    ops.push(setStrokingRgbColor(r, g, b), setLineWidth(lwPt(style)), setLineCap(1), setLineJoin(1));
    // a pattern too fine to see on paper is drawn continuous
    if (dashes && dashes.reduce((s, d) => s + d, 0) >= 1) ops.push(setDashPattern(dashes, 0));
  };
  const fillState = (style) => { const [r, g, b] = colOf(style); ops.push(setFillingRgbColor(r, g, b)); };
  let msize;

  /** one font per text item: Helvetica when every character is WinAnsi, else the Unicode font, else '?' substitutes */
  const fontFor = async (lines) => {
    if (lines.every((l) => [...l].every((ch) => helvChars.has(ch.codePointAt(0))))) return { font: helv, lines };
    if (unicodeFont) {
      if (!uniFont) {
        const fontkit = (await import('@pdf-lib/fontkit')).default;
        pdf.registerFontkit(fontkit);
        uniFont = await pdf.embedFont(unicodeFont, { subset: true });
      }
      return { font: uniFont, lines };
    }
    return {
      font: helv,
      lines: lines.map((l) => [...l].map((ch) => (helvChars.has(ch.codePointAt(0)) ? ch : (missing++, '?'))).join('')),
    };
  };

  // MTEXT runs: Helvetica in its bold / oblique variants (embedded on first use), the Unicode font for other scripts
  const HELV = { '00': helv };
  const HELV_NAME = { '10': StandardFonts.HelveticaBold, '01': StandardFonts.HelveticaOblique, '11': StandardFonts.HelveticaBoldOblique };
  const variant = (p) => `${p.bold ? 1 : 0}${p.italic ? 1 : 0}`;
  const prepareMText = async (mt) => {
    for (const para of mt.paras) {
      for (const r of para.runs) {
        if (!r.props) continue;
        const key = variant(r.props);
        if (!HELV[key]) HELV[key] = await pdf.embedFont(HELV_NAME[key]);
        const t = r.stack ? r.stack.a + r.stack.b : r.text;
        if (unicodeFont && [...t].some((ch) => !helvChars.has(ch.codePointAt(0)))) await fontFor([t]);
      }
    }
  };
  const runFont = (t, p, count = false) => {
    if ([...t].every((ch) => helvChars.has(ch.codePointAt(0)))) return { font: HELV[variant(p)], text: t };
    if (uniFont) return { font: uniFont, text: t };
    return { font: HELV[variant(p)], text: [...t].map((ch) => (helvChars.has(ch.codePointAt(0)) ? ch : (count && missing++, '?'))).join('') };
  };

  const drawItems = async (scn) => {
  msize = markerSize(scn.bbox);
  for (const it of scn.items) {
    if (it.kind === 'path') {
      ops.push(pushGraphicsState()); strokeState(it.style, dashPt(dashUnits(doc, it.style)));
      pathOps(it.ops); ops.push(stroke(), popGraphicsState());
      if (it.arrow) {
        const t = arrowTriangle(it.arrow, msize);
        ops.push(pushGraphicsState()); fillState(it.style);
        ops.push(moveTo(X(t[0].x), Y(t[0].y)), lineTo(X(t[1].x), Y(t[1].y)), lineTo(X(t[2].x), Y(t[2].y)), closePath(), fillEvenOdd(), popGraphicsState());
      }
    } else if (it.kind === 'fill' || (it.kind === 'hatch' && it.solid)) {
      ops.push(pushGraphicsState()); fillState(it.style); pathOps(it.ops); ops.push(fillEvenOdd(), popGraphicsState());
    } else if (it.kind === 'hatch') {
      const fams = hatchFamilies(it);
      ops.push(pushGraphicsState());
      if (fams === null) {
        // too dense to draw line by line: a light tint of the hatch colour
        const [r, g, b] = colOf(it.style).map((v) => 1 - (1 - v) * 0.3);
        ops.push(setFillingRgbColor(r, g, b)); pathOps(it.ops); ops.push(fillEvenOdd(), popGraphicsState());
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
      const lay = mtextItemLayout(it, (t, p) => { const f = runFont(t, p); return f.font.widthOfTextAtSize(f.text, p.h); });
      const c = Math.cos(it.rot), s = Math.sin(it.rot);
      const rc = (col) => runRgb(col, it.style, { monochrome }).map((v) => v / 255);
      page.pushOperators(...ops.splice(0), pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, X(it.p.x), Y(it.p.y)));
      // layout is in drawing units, y down; the text frame is in page points, y up
      for (const g of lay.glyphs) {
        const f = runFont(g.text, g, true);
        if (!f.text) continue;
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(g.wf || 1, 0, Math.tan((g.oblique || 0) * Math.PI / 180), 1, g.x * k, -g.y * k));
        page.drawText(f.text, { x: 0, y: 0, size: g.h * k, font: f.font, color: rgb(...rc(g.color)) });
        page.pushOperators(popGraphicsState());
      }
      for (const r of lay.rules) {
        const [cr, cg, cb] = rc(r.color);
        page.pushOperators(setStrokingRgbColor(cr, cg, cb), setLineWidth(r.h * k * 0.06), moveTo(r.x1 * k, -r.y * k), lineTo(r.x2 * k, -r.y * k), stroke());
      }
      page.pushOperators(popGraphicsState());
    } else if (it.kind === 'text') {
      const { font, lines } = await fontFor(it.lines.map((l) => l.replace(/\t/g, ' ')));
      const lay = layoutText({ ...it, lines }, (t) => font.widthOfTextAtSize(t, it.h));
      const [r, g, b] = colOf(it.style);
      const c = Math.cos(it.rot), s = Math.sin(it.rot), wf = it.wf || 1;
      page.pushOperators(...ops.splice(0));
      for (const l of lay.lines) {
        if (!l.text) continue;
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(wf * c, wf * s, -s, c, X(it.p.x), Y(it.p.y)));
        // layout is in drawing units, y down; the text frame is in page points, y up
        page.drawText(l.text, { x: l.x * k, y: -l.y * k, size: it.h * k, font, color: rgb(r, g, b) });
        page.pushOperators(popGraphicsState());
      }
    }
    if (ops.length > 5000) page.pushOperators(...ops.splice(0));
  }
  };
  if (layout) {
    const modelScene = opts.modelScene ?? ((fr) => buildScene(docWithFrozen(doc, fr)));
    const paper = { ox, oy, k };
    for (const v of layout.entities) {
      if (v.type !== 'VIEWPORT' || v.vpId === 1 || v.on === false || !(v.width > 0 && v.height > 0)) continue;
      const s = viewportScale(v), cx = X(v.c.x), cy = Y(v.c.y), hw = (v.width / 2) * k, hh = (v.height / 2) * k;
      ops.push(pushGraphicsState(), moveTo(cx - hw, cy - hh), lineTo(cx + hw, cy - hh), lineTo(cx + hw, cy + hh), lineTo(cx - hw, cy + hh), closePath(), clip(), endPath());
      const t = v.twist || 0, c = Math.cos(t), sn = Math.sin(t);
      if (t) ops.push(concatTransformationMatrix(c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy)); // turn about the viewport centre
      k = paper.k / s; ox = cx - v.viewCenter.x * k; oy = cy - v.viewCenter.y * k;
      await drawItems(modelScene(v.frozen ?? []));
      ({ ox, oy, k } = paper);
      ops.push(popGraphicsState());
    }
  }
  await drawItems(scene);
  if (ops.length) page.pushOperators(...ops.splice(0));
  if (region) page.pushOperators(popGraphicsState());
  if (missing) warnings.push(`${missing} text characters could not be drawn (no Unicode font)`);
  const bytes = await pdf.save();
  return { bytes, warnings };
}
