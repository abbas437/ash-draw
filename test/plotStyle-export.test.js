// Plot style tables (.ctb) applied in the SVG and PDF exports: pen colour, screening, greyscale, lineweight, linetype.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { fixture, FIX } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { newDocument, addEntity, addLayer, addLinetype, addBlock, makeLine, makeInsert, makeMText } from '../src/core/model.js';
import { newLayout } from '../src/core/layouts.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { exportPdf, exportPdfPages } from '../src/core/exportPdf.js';
import { BUILTIN_TABLES, parsePlotStyleTable, writePlotStyleTable } from '../src/core/plotStyle.js';

/** acad.ctb (all "use object") with the given pens changed: { aci: {color, lineweight, ...} } */
const table = (pens = {}) => {
  const t = BUILTIN_TABLES['acad.ctb'];
  return { ...t, styles: t.styles.map((s, i) => ({ ...s, ...(pens[i + 1] ?? {}) })) };
};
const docWith = (...ents) => { const d = newDocument(); for (const e of ents) addEntity(d, e); return d; };
const line = (y, o = {}) => makeLine({ x: 0, y }, { x: 1, y }, o);
/** stroke colour, width and dash attribute of the SVG path of the line at y (x 0..1) */
const svgLine = (svg, y) => {
  const m = svg.match(new RegExp(`<path d="M0 ${-y}L1 ${-y}" stroke="rgb\\(([^)]*)\\)" stroke-width="([^"]*)"([^>]*)/>`));
  assert.ok(m, `no path at y=${y}`);
  return { rgb: m[1], w: Number(m[2]), dash: /stroke-dasharray/.test(m[3]) };
};
const pdfText = async (bytes) => {
  const pdf = await PDFDocument.load(bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
};

test('SVG: ACI 1 through a pen "black, 0.35 mm" (a written and read back .ctb) plots black at 0.35 mm', () => {
  const ctb = parsePlotStyleTable(writePlotStyleTable(table({ 1: { color: [0, 0, 0], lineweight: 0.35 } })));
  const doc = docWith(line(1, { color: 1, lineweight: 0.13 }));
  assert.deepEqual(svgLine(exportSvg(doc), 1), { rgb: '255,0,0', w: 0.18, dash: false }, 'without a table: red, its own weight');
  assert.deepEqual(svgLine(exportSvg(doc, { plotStyle: ctb }), 1), { rgb: '0,0,0', w: 0.35, dash: false });
  // the pen lineweight also plots with lineweights off; a "use object" pen then gets the default
  const off = exportSvg(docWith(line(1, { color: 1 }), line(2, { color: 2, lineweight: 0.5 })), { plotStyle: ctb, lineweights: false });
  assert.equal(svgLine(off, 1).w, 0.35);
  assert.equal(svgLine(off, 2).w, 0.25);
});

test('SVG: screening, greyscale, use-object passthrough and a true colour', () => {
  const ps = table({ 1: { screening: 50 }, 3: { grayscale: true }, 5: { color: [0, 0, 0], grayscale: true, screening: 20 } });
  const doc = docWith(line(1, { color: 1 }), line(2, { color: 3 }), line(3, { color: 4, lineweight: 0.5 }), line(4, { color: { r: 10, g: 200, b: 30 } }), line(5, { color: 5 }));
  const svg = exportSvg(doc, { plotStyle: ps, monochrome: true });
  assert.equal(svgLine(svg, 1).rgb, '255,128,128', '50 % of red');
  assert.equal(svgLine(svg, 2).rgb, '150,150,150', 'green as its Rec. 601 grey');
  assert.deepEqual(svgLine(svg, 3), { rgb: '0,255,255', w: 0.5, dash: false }, 'use object: its colour and weight (monochrome ignored)');
  assert.equal(svgLine(svg, 4).rgb, '10,200,30', 'a true colour is not in the table');
  assert.equal(svgLine(svg, 5).rgb, '204,204,204', 'greyscale, then 20 % screening');
});

test('SVG: BYLAYER maps through the layer colour pen, BYBLOCK in an INSERT through the insert colour pen', () => {
  const doc = newDocument();
  addLayer(doc, { name: 'G', color: 3 });
  addBlock(doc, 'B', { x: 0, y: 0 }, [line(0, { color: 0, layer: '0' })]);
  addEntity(doc, line(1, { color: 256, layer: 'G' }));
  addEntity(doc, makeInsert('B', { x: 0, y: 2 }, { color: 4 }));
  const svg = exportSvg(doc, { plotStyle: table({ 3: { color: [1, 2, 3] }, 4: { color: [4, 5, 6], lineweight: 0.7 } }) });
  assert.equal(svgLine(svg, 1).rgb, '1,2,3');
  assert.deepEqual(svgLine(svg, 2), { rgb: '4,5,6', w: 0.7, dash: false });
});

test('SVG: pen linetype 0 plots a dashed line solid, 1 a continuous one DASHED; use object keeps it', () => {
  const doc = docWith(line(1, { color: 1, linetype: 'DASHED' }), line(2, { color: 2 }), line(3, { color: 3, linetype: 'DASHED' }), line(4, { color: 4 }));
  addLinetype(doc, { name: 'DASHED', pattern: [0.5, -0.25] });
  const svg = exportSvg(doc, { plotStyle: table({ 1: { linetype: 0 }, 2: { linetype: 1 }, 4: { linetype: 7 } }) });
  assert.deepEqual([1, 2, 3, 4].map((y) => svgLine(svg, y).dash), [false, true, true, false]);
});

test('SVG: MTEXT colour runs use the run ACI pen', () => {
  const doc = docWith(makeMText({ x: 0, y: 0 }, 1, '{\\C1;red} blue', { color: 5 }));
  const svg = exportSvg(doc, { plotStyle: table({ 1: { color: [0, 0, 0] }, 5: { color: [0, 128, 0] } }) });
  const fill = (t) => svg.match(new RegExp(`fill="rgb\\(([^)]*)\\)"[^>]*>${t}</text>`))?.[1];
  assert.equal(fill('red'), '0,0,0');
  assert.equal(fill(' ?blue'), '0,128,0');
});

test('PDF: the pen colour and lineweight operators (RG / w) of one line, model and through a layout viewport', async () => {
  const ps = table({ 1: { color: [0, 0, 255], lineweight: 1 } });
  const doc = docWith(line(1, { color: 1 }));
  const wPt = (t) => { const m = t.match(/(\S+) (\S+) (\S+) RG\n(\S+) w\n/); assert.ok(m, 'no stroke state'); return [m[1], m[2], m[3], Number(m[4])]; };
  const close = (got, want) => { assert.deepEqual(got.slice(0, 3), want.slice(0, 3)); assert.ok(Math.abs(got[3] - want[3]) < 1e-9, `${got[3]} w`); };
  close(wPt(await pdfText((await exportPdf(doc, {})).bytes)), ['1', '0', '0', 0.25 * 72 / 25.4]);
  close(wPt(await pdfText((await exportPdf(doc, { plotStyle: ps, monochrome: true })).bytes)), ['0', '0', '1', 72 / 25.4]);
  const lay = newLayout('Layout1', 1);
  lay.entities.push({ type: 'VIEWPORT', id: 99, layer: '0', color: 256, vpId: 2, on: true, c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 0.5, y: 1 }, viewHeight: 10, twist: 0 });
  doc.layouts = [lay];
  close(wPt(await pdfText((await exportPdf(doc, { layout: lay, plotStyle: ps })).bytes)), ['0', '0', '1', 72 / 25.4]);
});

test('monochrome.ctb: ordinary colours black as the monochrome option; greys are not kept, true colours plot in colour', () => {
  const doc = docWith(line(1, { color: 1 }), line(2, { color: 5 }), line(3, { color: 7 }), line(4, { color: 8 }), line(5, { color: 252 }), line(6, { color: { r: 10, g: 200, b: 30 } }));
  const cols = (o) => { const svg = exportSvg(doc, o); return [1, 2, 3, 4, 5, 6].map((y) => svgLine(svg, y).rgb); };
  const ctb = cols({ plotStyle: BUILTIN_TABLES['monochrome.ctb'], monochrome: true, keepGreys: true });
  assert.deepEqual(cols({ monochrome: true }).slice(0, 5), ctb.slice(0, 5));
  assert.deepEqual(ctb, ['0,0,0', '0,0,0', '0,0,0', '0,0,0', '0,0,0', '10,200,30']);
  assert.deepEqual(cols({ monochrome: true, keepGreys: true }).slice(3), ['128,128,128', '132,132,132', '0,0,0'], 'the option keeps greys, the table does not');
});

// golden files: the output of the code before plot style tables (541b820), PDFs with their creation date fixed
const GOLD = path.join(FIX, 'plotstyle-golden');
const fixedDate = async (fn) => {
  const RD = Date, T = RD.UTC(2026, 0, 1);
  globalThis.Date = class extends RD { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } };
  try { return await fn(); } finally { globalThis.Date = RD; }
};
test('without plotStyle the SVG and PDF bytes are those of the code before it (golden files)', async () => {
  const same = (name, got) => assert.ok(Buffer.from(readFileSync(path.join(GOLD, name))).equals(Buffer.from(got)), name);
  for (const n of ['colors_r2000', 'blocks_r2000', 'text_r2000', 'hatch_r2000']) {
    const d = readDxf(fixture(`${n}.dxf`));
    same(`${n}.svg`, exportSvg(d, { unitsPerMm: 1, plotStyle: null }));
    same(`${n}.mono.svg`, exportSvg(d, { monochrome: true, keepGreys: true }));
    same(`${n}.pdf`, await fixedDate(async () => (await exportPdf(d, { pageSize: 'A3', plotStyle: null })).bytes));
  }
  const L = readDxf(fixture('layouts_r2000.dxf'));
  same('layouts_r2000.pdf', await fixedDate(async () => (await exportPdf(L, { layout: L.layouts[0], monochrome: true })).bytes));
});

test('PDF publish: a sheet\'s own plotStyle wins over the option; a sheet without one uses the option', async () => {
  const doc = docWith(line(1, { color: 1 }));
  const blue = table({ 1: { color: [0, 0, 255] } }), green = table({ 1: { color: [0, 255, 0] } });
  const out = await exportPdfPages([{ doc, label: 'a', plotStyle: blue }, { doc, label: 'b' }, { doc, label: 'c', plotStyle: null }], { plotStyle: green });
  const pdf = await PDFDocument.load(out.bytes);
  const rg = [];
  for (const pg of pdf.getPages()) {
    const c = pg.node.Contents(), streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
    rg.push(streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n').match(/(\S+ \S+ \S+) RG\n/)[1]);
  }
  assert.deepEqual(rg, ['0 0 1', '0 1 0', '1 0 0']);
});
