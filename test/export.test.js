import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFArray, PDFName, decodePDFRawStream } from 'pdf-lib';
import { createCanvas, loadImage, Path2D } from '@napi-rs/canvas';
import { fixture } from './helpers.js';
import { makeCfb, dib, bmpFile, oleData, oleDxf } from './oleFixtures.js';
import { readDxf } from '../src/core/dxfRead.js';
import { newLayout } from '../src/core/layouts.js';
import { newDocument, addEntity, addLayer, makeXline, makeLine, makeCircle, makeArc, makeText } from '../src/core/model.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { buildScene } from '../src/core/render.js';
import { exportPdf, exportPdfPages, plotLayout, plotScale, pageFit } from '../src/core/exportPdf.js';
import { plotSettingsFrom, plotSettingsToStore, PLOT_DEFAULTS } from '../src/core/plotSettings.js';

const FIXTURES = ['basic', 'blocks', 'colors', 'dims', 'extrusion', 'hatch', 'polylines', 'splines', 'text', 'unsupported'];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ash-export-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const docWith = (...ents) => { const d = newDocument(); for (const e of ents) addEntity(d, e); return d; };
const pathDs = (svg) => [...svg.matchAll(/<path d="([^"]*)" stroke=/g)].map((m) => m[1]);

for (const name of FIXTURES) {
  test(`SVG of ${name}_r2000.dxf is well-formed XML`, () => {
    const svg = exportSvg(readDxf(fixture(`${name}_r2000.dxf`)));
    const file = path.join(tmp, `${name}.svg`);
    writeFileSync(file, svg);
    const r = spawnSync('python3', ['-c', 'import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1])', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(svg, /<svg [^>]*viewBox="[^"]+"/);
  });
}

test('SVG: LINE (0,0)-(10,5) has its y negated', () => {
  const svg = exportSvg(docWith(makeLine({ x: 0, y: 0 }, { x: 10, y: 5 })));
  assert.deepEqual(pathDs(svg), ['M0 0L10 -5']);
});

test('SVG: CIRCLE r=3 is two arcs', () => {
  const [d] = pathDs(exportSvg(docWith(makeCircle({ x: 0, y: 0 }, 3))));
  assert.equal(d, 'M3 0A3 3 0 0 0 -3 0A3 3 0 0 0 3 0');
});

test('SVG: ARC 0..90 deg r=10 runs (10,0) -> (0,-10) through the upper right quadrant', () => {
  const [d] = pathDs(exportSvg(docWith(makeArc({ x: 0, y: 0 }, 10, 0, 90))));
  // World CCW with Y up becomes, after y -> -y, a sweep towards negative SVG angles: sweep-flag 0.
  // (sweep-flag 1 would pick the other circle through both endpoints, centred at (10,-10).)
  assert.equal(d, 'M10 0A10 10 0 0 0 0 -10');
  // independent check with a real SVG path parser: the segment between chord and arc contains a point
  // just inside the true arc and not a point near the wrong circle's bulge
  const ctx = createCanvas(40, 40).getContext('2d');
  ctx.translate(20, 20);
  const p = new Path2D(`${d}Z`);
  assert.equal(ctx.isPointInPath(p, 20 + 6.5, 20 - 6.5), true);
  assert.equal(ctx.isPointInPath(p, 20 + 4, 20 - 4), false);
});

test('SVG: width/height in mm only with unitsPerMm; text is escaped', () => {
  const doc = docWith(makeLine({ x: 0, y: 0 }, { x: 100, y: 50 }), makeText({ x: 0, y: 0 }, 2.5, 'a<b & "c"'));
  assert.match(exportSvg(doc, { unitsPerMm: 1 }), /width="[\d.]+mm" height="[\d.]+mm"/);
  const svg = exportSvg(doc);
  assert.doesNotMatch(svg, /mm"/);
  assert.match(svg, />a&lt;b &amp; &quot;c&quot;</);
});

test('PDF: valid one-page document', async () => {
  const { bytes, warnings } = await exportPdf(readDxf(fixture('basic_r2000.dxf')));
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString('latin1'), '%PDF-');
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(warnings, []);
});

test('PDF: A4 landscape page size', async () => {
  const { bytes } = await exportPdf(readDxf(fixture('blocks_r2000.dxf')), { pageSize: 'A4', orientation: 'landscape' });
  const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
  assert.ok(Math.abs(width - 841.89) < 0.01 && Math.abs(height - 595.28) < 0.01, `${width} x ${height}`);
});

test('PDF: fit page = drawing at 1 unit = 1 mm plus margins', async () => {
  const { bytes } = await exportPdf(docWith(makeLine({ x: 0, y: 0 }, { x: 100, y: 50 })), { margin: 10 });
  const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
  assert.ok(Math.abs(width - 120 * 72 / 25.4) < 0.01 && Math.abs(height - 70 * 72 / 25.4) < 0.01, `${width} x ${height}`);
});

test('PDF: text outside WinAnsi warns once without a Unicode font, Latin text does not', async () => {
  const ar = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'مرحبا'), makeText({ x: 0, y: 5 }, 2.5, 'مرحبا')));
  assert.deepEqual(ar.warnings, ['10 text characters could not be drawn (no Unicode font)']);
  const latin = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'Hello Ø25 ±0.5')));
  assert.deepEqual(latin.warnings, []);
});

const UNI_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
test('PDF: Arabic text with a Unicode font draws without warnings', { skip: !existsSync(UNI_FONT) && 'no DejaVuSans.ttf' }, async () => {
  const r = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'مرحبا')), { unicodeFont: readFileSync(UNI_FONT) });
  assert.deepEqual(r.warnings, []);
  assert.equal((await PDFDocument.load(r.bytes)).getPageCount(), 1);
});

const PDFTOPPM = '/usr/bin/pdftoppm';
for (const name of ['hatch', 'blocks']) {
  test(`PDF of ${name}_r2000.dxf renders non-blank`, { skip: !existsSync(PDFTOPPM) && 'pdftoppm not installed' }, async () => {
    const { bytes } = await exportPdf(readDxf(fixture(`${name}_r2000.dxf`)), { pageSize: 'A4' });
    const pdfFile = path.join(tmp, `${name}.pdf`), prefix = path.join(tmp, `${name}-render`);
    writeFileSync(pdfFile, bytes);
    const r = spawnSync(PDFTOPPM, ['-png', '-r', '50', pdfFile, prefix], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const png = `${prefix}-1.png`;
    assert.ok(existsSync(png));
    const img = await loadImage(readFileSync(png));
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) ink++;
    assert.ok(ink > 100, `only ${ink} non-background pixels`);
  });
}

const MM = 72 / 25.4;
test('plot: 1:50 of a 10000 mm line on A3 is 200 mm on paper, page A3 landscape, centred', () => {
  const L = plotLayout({ minx: 0, miny: 0, maxx: 10000, maxy: 100 }, { pageSize: 'A3', scale: plotScale(50, 1) });
  assert.ok(Math.abs((10000 * L.k) / MM - 200) < 1e-9, `${(10000 * L.k) / MM} mm`);
  assert.ok(Math.abs(L.pw / MM - 420) < 0.1 && Math.abs(L.ph / MM - 297) < 0.1);
  assert.ok(Math.abs(L.ox / MM - 110) < 0.1, 'centred: (420 - 200) / 2');
  assert.deepEqual(L.warnings, []);
  assert.ok(Math.abs(plotLayout({ minx: 0, miny: 0, maxx: 10000, maxy: 100 }, { pageSize: 'A3', scale: plotScale(50, 1), centre: false }).ox / MM - 10) < 1e-6, 'not centred: at the margin');
  assert.equal(plotScale(50, 1000), 20, 'metres: 1:50 = 20 paper mm per metre');
  assert.match(plotLayout({ minx: 0, miny: 0, maxx: 10000, maxy: 100 }, { pageSize: 'A4', scale: plotScale(20, 1) }).warnings[0], /does not fit/);
});

test('PDF: a plot window at 1:50 gives the chosen paper size', async () => {
  const doc = docWith(makeLine({ x: 0, y: 0 }, { x: 10000, y: 0 }), makeLine({ x: 50000, y: 0 }, { x: 60000, y: 0 }));
  const { bytes, warnings } = await exportPdf(doc, { pageSize: 'A3', orientation: 'portrait', scale: plotScale(50, 1), region: { minx: 0, miny: -100, maxx: 10000, maxy: 100 } });
  const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
  assert.ok(Math.abs(width / MM - 297) < 0.1 && Math.abs(height / MM - 420) < 0.1, `${width} x ${height}`);
  assert.deepEqual(warnings, []);
});

test('PDF: only what lies inside the plot window is drawn', { skip: !existsSync(PDFTOPPM) && 'pdftoppm not installed' }, async () => {
  // window x 0..100 fitted on A4 landscape spans page x 53.5..243.5 mm; the second line (x 150..200) would reach the page edge
  const doc = docWith(makeLine({ x: 0, y: 0 }, { x: 100, y: 0 }), makeLine({ x: 150, y: 0 }, { x: 200, y: 0 }));
  const inkCols = async (region, name) => {
    const { bytes } = await exportPdf(doc, { pageSize: 'A4', orientation: 'landscape', region });
    const pdfFile = path.join(tmp, `${name}.pdf`), prefix = path.join(tmp, `${name}-render`);
    writeFileSync(pdfFile, bytes);
    assert.equal(spawnSync(PDFTOPPM, ['-png', '-r', '50', pdfFile, prefix]).status, 0);
    const img = await loadImage(readFileSync(`${prefix}-1.png`));
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    let right = 0;
    const x0 = Math.round((250 / 297) * img.width);
    for (let y = 0; y < img.height; y++) for (let x = x0; x < img.width; x++) if (px[(y * img.width + x) * 4] < 200) right++;
    return right;
  };
  assert.equal(await inkCols({ minx: 0, miny: -50, maxx: 100, maxy: 50 }, 'win'), 0);
  assert.ok(await inkCols(null, 'ext') > 0, 'extents plot draws to the right');
});

test('layout PDF: an XLINE through a 1:100 viewport is plotted across the whole viewport window', async () => {
  const doc = newDocument();
  addEntity(doc, makeXline('XLINE', { x: 0, y: 0 }, { x: 1, y: 1 }));
  const lay = newLayout('Layout1', 1);
  lay.entities.push({ type: 'VIEWPORT', id: 99, layer: '0', color: 256, vpId: 2, on: true, c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 0, y: 0 }, viewHeight: 10000, twist: 0 });
  doc.layouts = [lay];
  const pdf = await PDFDocument.load((await exportPdf(doc, { layout: lay })).bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  const text = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
  const segs = [...text.matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l/g)].map((m) => Math.hypot(m[3] - m[1], m[4] - m[2]));
  // window = the viewport diagonal 223.6 mm; the 45 degree line crosses its square bounding box corner to corner: 223.6 * sqrt(2) mm
  const want = Math.hypot(200, 100) * Math.SQRT2 * 72 / 25.4;
  assert.ok(segs.some((l) => Math.abs(l - want) < 0.5), `no segment of ${want.toFixed(1)} pt in ${segs.map((l) => l.toFixed(1))}`);
});

// ---- layout sheets on other paper (fit to paper), PUBLISH --------------------------------------------------------
const PT = 72 / 25.4, near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test('pageFit: an A0 sheet fitted to A3 landscape inside 5 mm margins, centred', () => {
  const f = pageFit(1189 * PT, 841 * PT, 'A3');
  assert.equal(f.orientation, 'landscape');
  assert.ok(near(f.pw, 1190.55) && near(f.ph, 841.89), `${f.pw} x ${f.ph}`);
  // the binding side: (420 - 2*5) / 1189 across, (297 - 10) / 841 = 0.3413 up
  assert.ok(near(f.scale, Math.min(410 / 1189, 287 / 841), 1e-6), String(f.scale)); // pdf-lib's A3 is rounded to 0.01 pt
  assert.ok(near(f.ox, (f.pw - 1189 * PT * f.scale) / 2, 1e-9) && near(f.oy, (f.ph - 841 * PT * f.scale) / 2, 1e-9));
  assert.ok(near(f.oy, 5 * PT, 1e-3), 'the height binds: 5 mm margin top and bottom');
  assert.ok(f.fits);
});

test('pageFit: portrait sheet -> portrait paper; small sheet enlarged; no fit = 1:1 centred and may not fit', () => {
  const p = pageFit(210 * PT, 297 * PT, 'A1');
  assert.equal(p.orientation, 'portrait');
  assert.ok(p.pw < p.ph && p.scale > 1, `${p.pw} x ${p.ph} at ${p.scale}`);
  const one = pageFit(1189 * PT, 841 * PT, 'A3', { fit: false });
  assert.equal(one.scale, 1);
  assert.equal(one.fits, false);
  assert.ok(near(one.ox, (1190.55 - 1189 * PT) / 2, 0.01));
  const t = pageFit(1189 * PT, 841 * PT, 'Tabloid');
  assert.deepEqual([t.pw, t.ph], [1224, 792]);
  assert.throws(() => pageFit(1, 1, 'B5'), /Unknown page size/);
});

test('PUBLISH: the 2 layouts of layouts_r2000.dxf on A3 (fit) give a 2-page A3 landscape PDF; own paper keeps 420 x 297', async () => {
  const doc = readDxf(fixture('layouts_r2000.dxf'));
  assert.equal(doc.layouts.length, 2);
  const sheets = doc.layouts.map((layout) => ({ doc, layout, label: layout.name }));
  const a3 = await PDFDocument.load((await exportPdfPages(sheets, { paper: 'A3', fit: true, monochrome: true })).bytes);
  assert.equal(a3.getPageCount(), 2);
  for (const pg of a3.getPages()) { const { width, height } = pg.getSize(); assert.ok(near(width, 1190.55) && near(height, 841.89), `${width} x ${height}`); }
  const a4 = await PDFDocument.load((await exportPdfPages([...sheets, { doc, layout: null, label: 'Model' }], { paper: 'A4', fit: true, pageSize: 'A4' })).bytes);
  assert.equal(a4.getPageCount(), 3);
  assert.deepEqual(a4.getPages().map((pg) => pg.getSize()).map(({ width, height }) => [+width.toFixed(2), +height.toFixed(2)]), [[841.89, 595.28], [841.89, 595.28], [841.89, 595.28]]);
  const own = await PDFDocument.load((await exportPdf(doc, { layout: doc.layouts[0] })).bytes);
  const { width, height } = own.getPage(0).getSize();
  assert.ok(near(width, 420 * PT) && near(height, 297 * PT), `${width} x ${height}`);
});

test('layout on A1 (fit): paper geometry is enlarged by the fit scale', async () => {
  const doc = readDxf(fixture('layouts_r2000.dxf')), layout = doc.layouts[0];
  const segs = async (opts) => {
    const pdf = await PDFDocument.load((await exportPdf(doc, { layout, ...opts })).bytes), c = pdf.getPage(0).node.Contents();
    const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
    const text = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
    return [...text.matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l/g)].map((m) => Math.hypot(m[3] - m[1], m[4] - m[2]));
  };
  // the model line (0,0)-(1000,0) through the 1:50 viewport: 20 mm of paper
  const f = pageFit(420 * PT, 297 * PT, 'A1'), one = 20 * PT, big = one * f.scale;
  assert.ok((await segs({})).some((l) => near(l, one, 0.05)), 'own paper: 20 mm');
  const fitted = await segs({ paper: 'A1', fit: true });
  assert.ok(fitted.some((l) => near(l, big, 0.05)), `A1 fit: ${big.toFixed(2)} pt in ${fitted.map((l) => l.toFixed(2))}`);
});

test('plot settings: stored values are validated, defaults fill the rest, the picked window is not stored', () => {
  assert.deepEqual(plotSettingsFrom(undefined), { ...PLOT_DEFAULTS, window: null });
  const s = plotSettingsFrom({ layoutPaper: 'A3', layoutFit: false, monochrome: true, pageSize: 'B9', n: -3, what: 'window', publishModel: 'yes' });
  assert.equal(s.layoutPaper, 'A3'); assert.equal(s.layoutFit, false); assert.equal(s.monochrome, true);
  assert.equal(s.pageSize, 'A3'); assert.equal(s.n, 100); assert.equal(s.what, 'extents'); assert.equal(s.publishModel, false);
  const stored = plotSettingsToStore({ ...s, window: { minx: 0 } });
  assert.equal('window' in stored, false);
  assert.deepEqual(plotSettingsFrom(stored), s);
});

const pageText = async (bytes) => {
  const pdf = await PDFDocument.load(bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
};

test('layout on A3 (fit): the sheet is clipped first and every path point lies inside the 5 mm margins', async () => {
  const doc = readDxf(fixture('layouts_r2000.dxf')), layout = doc.layouts[0];
  const text = await pageText((await exportPdf(doc, { layout, paper: 'A3', fit: true })).bytes);
  const pw = 1190.55, ph = 841.89, m = 5 * PT;
  // page content opens with the sheet rectangle as a clip (q, path, W n) before anything is drawn
  const clip = text.match(/^\s*q\s+([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l\s+([-\d.]+) ([-\d.]+) l\s+([-\d.]+) ([-\d.]+) l\s+h\s+W\s+n\b/);
  assert.ok(clip, `no leading sheet clip in: ${text.slice(0, 200)}`);
  const xs = [clip[1], clip[3], clip[5], clip[7]].map(Number), ys = [clip[2], clip[4], clip[6], clip[8]].map(Number);
  // the clip is the whole sheet (420 x 297 mm) at the fit scale, centred: the very first clip, not a viewport's
  const f = pageFit(420 * PT, 297 * PT, 'A3');
  assert.ok(near(Math.min(...xs), f.ox, 0.05) && near(Math.max(...xs), f.ox + 420 * PT * f.scale, 0.05), `clip x ${xs} vs ${f.ox}`);
  assert.ok(near(Math.min(...ys), f.oy, 0.05) && near(Math.max(...ys), f.oy + 297 * PT * f.scale, 0.05), `clip y ${ys} vs ${f.oy}`);
  assert.ok(Math.min(...xs) >= m - 0.05 && Math.max(...xs) <= pw - m + 0.05 && Math.min(...ys) >= m - 0.05 && Math.max(...ys) <= ph - m + 0.05, 'clip inside the margins');
  const pts = [...text.matchAll(/([-\d.]+) ([-\d.]+) [ml]\s/g)].map((q) => [+q[1], +q[2]]);
  assert.ok(pts.length > 4, 'paths drawn');
  for (const [x, y] of pts) assert.ok(x >= m - 0.05 && x <= pw - m + 0.05 && y >= m - 0.05 && y <= ph - m + 0.05, `point ${x},${y} outside the margins`);
});

test('layout PDF: each viewport draws the model without its own frozen layers (scene cache keyed by the frozen set)', async () => {
  const doc = newDocument();
  addLayer(doc, { name: 'A' }); addLayer(doc, { name: 'B' });
  addEntity(doc, makeLine({ x: -20, y: 0 }, { x: 20, y: 0 }, { layer: 'A' }));
  addEntity(doc, makeLine({ x: -20, y: 10 }, { x: 20, y: 10 }, { layer: 'B' }));
  const lay = newLayout('Layout1', 1);
  const vp = (id, cx, frozen) => ({ type: 'VIEWPORT', id, layer: '0', color: 256, vpId: id, on: true, c: { x: cx, y: 150 }, width: 100, height: 100, viewCenter: { x: 0, y: 0 }, viewHeight: 100, twist: 0, frozen });
  lay.entities.push(vp(2, 100, ['A']), vp(3, 300, ['B']));
  doc.layouts = [lay];
  const text = await pageText((await exportPdf(doc, { layout: lay })).bytes);
  const segs = [...text.matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l\s+S/g)].map((q) => ({ x: +q[1] / PT, y: +q[2] / PT, len: Math.abs(q[3] - q[1]) / PT }))
    .filter((q) => Math.abs(q.len - 40) < 0.1);
  const left = segs.filter((q) => q.x < 200), right = segs.filter((q) => q.x > 200);
  // left viewport freezes A: only B (model y 10); right freezes B: only A (model y 0): 10 mm lower on the sheet
  assert.equal(left.length, 1, JSON.stringify(segs)); assert.equal(right.length, 1, JSON.stringify(segs));
  assert.ok(near(left[0].y - right[0].y, 10, 0.1), `left y ${left[0].y}, right y ${right[0].y}`);
});

test('PUBLISH monochrome: no stroking colour but black in any page of a coloured drawing', async () => {
  const doc = readDxf(fixture('colors_r2000.dxf'));
  const out = await exportPdfPages([{ doc, layout: null, label: 'Model' }], { paper: 'A3', pageSize: 'A3', orientation: 'auto', margin: 10, scale: null, centre: true, monochrome: true });
  const text = await pageText(out.bytes);
  const cols = [...text.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) RG/g)];
  assert.ok(cols.length > 0, 'strokes drawn');
  for (const c of cols) assert.deepEqual([+c[1], +c[2], +c[3]], [0, 0, 0], c[0]);
  const colour = await pageText((await exportPdfPages([{ doc, layout: null, label: 'Model' }], { pageSize: 'A3', orientation: 'auto', margin: 10, scale: null, centre: true })).bytes);
  assert.ok([...colour.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) RG/g)].some((c) => +c[1] || +c[2] || +c[3]), 'the coloured fixture has non-black strokes');
});

test('PUBLISH plot area: a stray far-away entity shrinks an Extents plot; Current view clips and omits it', async () => {
  const main = [makeLine({ x: 0, y: 0 }, { x: 1000, y: 0 }), makeLine({ x: 1000, y: 0 }, { x: 1000, y: 500 }), makeLine({ x: 1000, y: 500 }, { x: 0, y: 500 }), makeLine({ x: 0, y: 500 }, { x: 0, y: 0 })];
  const doc = docWith(...main, makeLine({ x: 99000, y: 90000 }, { x: 100000, y: 90100 }));
  const opts = { paper: 'A3', pageSize: 'A3', orientation: 'landscape', margin: 5, scale: null, centre: true, monochrome: true };
  const plot = async (region) => {
    const out = await exportPdfPages([{ doc, layout: null, label: 'Model', region }], opts);
    const text = await pageText(out.bytes), w = (await PDFDocument.load(out.bytes)).getPage(0).getSize().width / MM;
    const pts = [...text.matchAll(/([-\d.]+) ([-\d.]+) [ml]\n/g)].map((q) => ({ x: +q[1] / MM, y: +q[2] / MM }));
    return { w, pts: region ? pts.slice(4) : pts }; // a region first writes its clip rectangle (m, 3 x l)
  };
  const span = (pts) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
  const ext = await plot(null);
  assert.ok(span(ext.pts.slice(0, 8)) < 0.2 * ext.w, `extents: the plan spans ${span(ext.pts.slice(0, 8))} of ${ext.w} mm`);
  const view = await plot({ minx: -50, miny: -25, maxx: 1050, maxy: 525 });
  assert.ok(view.pts.length >= 4, 'plan lines written');
  assert.ok(span(view.pts) > 0.8 * (view.w - 10), `view: the plan spans ${span(view.pts)} of ${view.w - 10} mm`);
  assert.ok(view.pts.every((p) => p.x >= 0 && p.x <= view.w), 'no path point beyond the page: the stray entity is not drawn');
  assert.equal(view.pts.length, 8, '4 lines only (the stray one is not written)');
});

// ---- raster pictures: OLE2FRAME previews (IMAGE entities go through the same branch) ----
const oleDoc = (...frames) => {
  const d = newDocument();
  for (const [chunks, dx] of frames) {
    const e = { ...readDxf(oleDxf(chunks)).entities[0], data: chunks };
    d.entities.push(dx ? { ...e, p1: { x: e.p1.x + dx, y: e.p1.y }, p2: { x: e.p2.x + dx, y: e.p2.y } } : e);
  }
  return d;
};
const imageXObjects = (pdf) => [...pdf.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o) => o.dict?.get(PDFName.of('Subtype'))?.asString() === '/Image');

test('PDF: an OLE2FRAME preview is embedded as one image XObject placed at the frame; a second identical draw reuses it', async () => {
  const MM = 72 / 25.4, RED = [220, 30, 40];
  const chunks = oleData({ x: 100, y: 60 }, { x: 140, y: 20 }, makeCfb({ CONTENTS: bmpFile(dib(40, 40, RED)) }));
  const doc = oleDoc([chunks, 0], [chunks, 100]); // two frames, one data array: one decoded preview
  const { bytes } = await exportPdf(doc, { pageSize: 'fit', scale: 1, margin: 10, centre: false });
  const imgs = imageXObjects(await PDFDocument.load(bytes));
  assert.equal(imgs.length, 1, 'one image XObject for both frames');
  assert.deepEqual([imgs[0].dict.get(PDFName.of('Width')).asNumber(), imgs[0].dict.get(PDFName.of('Height')).asNumber()], [40, 40]);
  const text = await pageText(bytes);
  const cms = [...text.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s+\/Img[-\w]* Do/g)].map((m) => m.slice(1).map(Number));
  assert.equal(cms.length, 2, 'two cm + Do');
  const [a, b, c, d, e, f] = cms[0];
  // 40 x 20 drawing units at 1 mm each, frame lower-left (100, 20) at the 10 mm margin
  assert.deepEqual([a / MM, b, c, d / MM, e / MM, f / MM].map((v) => Math.round(v * 1000) / 1000), [40, 0, 0, 40, 10, 10]);
  assert.ok(Math.abs(cms[1][4] / MM - 110) < 1e-3, 'the second frame is 100 units to the right');
});

test('layout PDF: a model OLE picture seen through a viewport is clipped by the viewport', async () => {
  const chunks = oleData({ x: 0, y: 10 }, { x: 20, y: 0 }, makeCfb({ CONTENTS: bmpFile(dib(8, 8, [10, 200, 30])) }));
  const doc = oleDoc([chunks, 0]);
  const lay = newLayout('Layout1', 1);
  lay.entities.push({ type: 'VIEWPORT', id: 99, layer: '0', color: 256, vpId: 2, on: true, c: { x: 200, y: 150 }, width: 100, height: 60, viewCenter: { x: 10, y: 5 }, viewHeight: 60, twist: 0 });
  doc.layouts = [lay];
  const text = await pageText((await exportPdf(doc, { layout: lay })).bytes);
  // the viewport's rectangle clip (m l l l h W n) is the one open when the picture is drawn: next operators are q, cm, Do
  assert.match(text, /([-\d.]+ [-\d.]+ l\n){3}h\nW\nn\nq\n([-\d.]+ ){6}cm\n\/Img[-\w]* Do\n/);
});

test('PDF: imageRgba runs once for an IMAGE drawn twice (the cache is looked up first)', async () => {
  const bitmap = {}, d = newDocument();
  d.images = new Map([['pic.png', { status: 'loaded', bitmap }]]);
  const img = (x) => ({ type: 'IMAGE', id: 0, layer: '0', color: 256, path: 'pic.png', p: { x, y: 0 }, u: { x: 0.1, y: 0 }, v: { x: 0, y: 0.1 }, size: { x: 10, y: 10 }, clip: { on: false } });
  d.entities.push(img(0), img(20));
  let calls = 0;
  const imageRgba = () => { calls++; return { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) }; };
  const { bytes } = await exportPdf(d, { pageSize: 'fit', scale: 1, margin: 10, centre: false, imageRgba });
  assert.equal(imageXObjects(await PDFDocument.load(bytes)).length, 1);
  assert.equal(calls, 1);
});

test('PDF: the border of an OLE2FRAME with a preview is shown on screen but not plotted; SVG keeps a frame', async () => {
  const chunks = oleData({ x: 100, y: 60 }, { x: 140, y: 20 }, makeCfb({ CONTENTS: bmpFile(dib(40, 40, [220, 30, 40])) }));
  const doc = oleDoc([chunks, 0]);
  const sc = buildScene(doc);
  assert.ok(sc.items.some((it) => it.kind === 'path' && it.oleFrame), 'the frame is in the scene (screen)');
  const text = await pageText((await exportPdf(doc, { pageSize: 'fit', scale: 1, margin: 10, centre: false })).bytes);
  assert.doesNotMatch(text, /\sl\n/, 'no line segment: only the picture');
  assert.match(text, /\/Img[-\w]* Do/);
  assert.match(exportSvg(doc), /<path/, 'SVG has no image path: the frame stays');
});
