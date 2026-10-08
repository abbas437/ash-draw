import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createCanvas, loadImage, Path2D } from '@napi-rs/canvas';
import { fixture } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { newDocument, addEntity, makeLine, makeCircle, makeArc, makeText } from '../src/core/model.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { exportPdf, plotLayout, plotScale } from '../src/core/exportPdf.js';

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
