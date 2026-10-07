// ASH Draw Studio - PDF export (pure ES module, vector output through pdf-lib content-stream operators).
//
//   const { bytes, warnings } = await exportPdf(doc, { pageSize: 'A3', orientation: 'auto' });
import {
  PDFDocument, StandardFonts, PageSizes, rgb, PDFOperator, PDFOperatorNames,
  pushGraphicsState, popGraphicsState, setLineWidth, setDashPattern, setLineCap, setLineJoin,
  setStrokingRgbColor, setFillingRgbColor, moveTo, lineTo, appendBezierCurve, closePath, stroke,
  clipEvenOdd, endPath, concatTransformationMatrix,
} from 'pdf-lib';
import { buildScene } from './render.js';
import {
  walkOps, colorRgb, lineweightMm, dashUnits, hatchFamilies, layoutText, markerSize, arrowTriangle,
} from './exportSvg.js';

const PT_PER_MM = 72 / 25.4;
const MAX_PAGE_PT = 14400;          // PDF 1.x user-unit page size limit (200 inch)
const MIN_LW_PT = 0.25;
const fillEvenOdd = () => PDFOperator.of(PDFOperatorNames.FillEvenOdd);
const SIZES = { A4: PageSizes.A4, A3: PageSizes.A3, A2: PageSizes.A2, A1: PageSizes.A1, A0: PageSizes.A0, Letter: PageSizes.Letter };

/**
 * exportPdf(doc, opts) -> Promise<{bytes:Uint8Array, warnings:string[]}> (one page, vector).
 * opts: pageSize 'fit'|'A4'|'A3'|'A2'|'A1'|'A0'|'Letter' ('fit'), orientation 'auto'|'landscape'|'portrait',
 * margin (mm, 10), scale (null = fit to page | page mm per drawing unit), monochrome, lineweights,
 * unicodeFont (TTF/OTF bytes for text outside WinAnsi), scene (prebuilt).
 */
export async function exportPdf(doc, opts = {}) {
  const {
    pageSize = 'fit', orientation = 'auto', margin = 10, scale = null, monochrome = false, lineweights = true, unicodeFont = null,
  } = opts;
  if (pageSize !== 'fit' && !SIZES[pageSize]) throw new Error(`Unknown page size: ${pageSize}`);
  const scene = opts.scene || buildScene(doc);
  const warnings = [];
  const bb = scene.bbox || { minx: 0, miny: 0, maxx: 100, maxy: 100 };
  const w = Math.max(bb.maxx - bb.minx, 1e-9), h = Math.max(bb.maxy - bb.miny, 1e-9);
  const mPt = margin * PT_PER_MM;

  // k = page points per drawing unit
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
  const ox = (pw - w * k) / 2 - bb.minx * k, oy = (ph - h * k) / 2 - bb.miny * k;
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;

  const pdf = await PDFDocument.create();
  pdf.setTitle('ASH Draw Studio drawing');
  pdf.setCreator('ASH Draw Studio');
  const page = pdf.addPage([pw, ph]);
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
  const msize = markerSize(scene.bbox);

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

  for (const it of scene.items) {
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
  if (ops.length) page.pushOperators(...ops.splice(0));
  if (missing) warnings.push(`${missing} text characters could not be drawn (no Unicode font)`);
  const bytes = await pdf.save();
  return { bytes, warnings };
}
