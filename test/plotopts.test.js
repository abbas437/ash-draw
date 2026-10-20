import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { newDocument, addEntity, makeLine } from '../src/core/model.js';
import { aciToRgb } from '../src/core/aci.js';
import { exportSvg, colorRgb } from '../src/core/exportSvg.js';
import { exportPdf, plotLayout, pageFit } from '../src/core/exportPdf.js';
import { plotSettingsFrom, plotSettingsToStore, PLOT_DEFAULTS, LAYOUT_PAPERS } from '../src/core/plotSettings.js';

const MM = 72 / 25.4;
// one line per colour: ACI 8 (grey), ACI 1 (red), true colour 200,200,200, true colour 200,10,10
const COLOURS = [8, 1, { r: 200, g: 200, b: 200 }, { r: 200, g: 10, b: 10 }];
const doc = () => { const d = newDocument(); COLOURS.forEach((color, i) => addEntity(d, makeLine({ x: 0, y: i * 100 }, { x: 1000, y: i * 100 }, { color }))); return d; };
const grey8 = aciToRgb(8);

async function pdfStrokes(opts) {
  const pdf = await PDFDocument.load((await exportPdf(doc(), opts)).bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  const text = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
  return [...text.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) RG/g)].map((m) => [+m[1], +m[2], +m[3]].map((v) => Math.round(v * 255)).join(','));
}
const svgStrokes = (opts) => [...new Set([...exportSvg(doc(), opts).matchAll(/stroke="rgb\((\d+),(\d+),(\d+)\)"/g)].map((m) => `${m[1]},${m[2]},${m[3]}`))];

test('PDF monochrome + keepGreys: ACI 8 and the grey true colour stay grey, ACI 1 and coloured true colour print black', async () => {
  const set = new Set(await pdfStrokes({ monochrome: true, keepGreys: true }));
  assert.deepEqual([...set].sort(), ['0,0,0', '200,200,200', grey8.join(',')].sort());
});
test('PDF monochrome without keepGreys: every stroke black; keepGreys without monochrome changes nothing', async () => {
  assert.deepEqual([...new Set(await pdfStrokes({ monochrome: true }))], ['0,0,0']);
  assert.deepEqual([...new Set(await pdfStrokes({ monochrome: true, keepGreys: false }))], ['0,0,0']);
  assert.ok((await pdfStrokes({ keepGreys: true })).includes('255,0,0'), 'colour plot is untouched');
});
test('SVG monochrome + keepGreys: greys stay, other colours black; off = all black', () => {
  assert.deepEqual(svgStrokes({ monochrome: true, keepGreys: true }).sort(), ['0,0,0', '200,200,200', grey8.join(',')].sort());
  assert.deepEqual(svgStrokes({ monochrome: true }), ['0,0,0']);
});
test('colorRgb keepGreys: black, white and automatic colours are not greys; amber maps to grey only for a compare', () => {
  const o = { monochrome: true, keepGreys: true };
  for (const rgb of [[0, 0, 0], [255, 255, 255], [200, 100, 100]]) assert.deepEqual(colorRgb({ color: { rgb } }, o), [0, 0, 0]);
  assert.deepEqual(colorRgb({ color: { auto: true } }, o), [0, 0, 0]);
  const amber = aciToRgb(40);
  assert.deepEqual(colorRgb({ color: { rgb: amber } }, o), [0, 0, 0]);
  assert.notDeepEqual(colorRgb({ color: { rgb: amber } }, { monochrome: true, compare: true }), [0, 0, 0]);
});

test('paper sizes: ARCH D is 24 x 36 in and Custom is its own width x height', () => {
  const R = { minx: 0, miny: 0, maxx: 100, maxy: 200 };
  const d = plotLayout(R, { pageSize: 'ARCH D', orientation: 'portrait' });
  assert.ok(Math.abs(d.pw - 609.6 * MM) < 1e-6 && Math.abs(d.ph - 914.4 * MM) < 1e-6, `${d.pw} x ${d.ph}`);
  assert.ok(Math.abs(d.pw - 1728) < 1e-6 && Math.abs(d.ph - 2592) < 1e-6);
  const c = plotLayout(R, { pageSize: 'Custom', custom: { w: 500, h: 300 }, orientation: 'landscape' });
  assert.ok(Math.abs(c.pw - 500 * MM) < 1e-6 && Math.abs(c.ph - 300 * MM) < 1e-6);
  const f = pageFit(900 * MM, 400 * MM, 'Custom', { custom: { w: 500, h: 300 } });
  assert.ok(Math.abs(f.pw - 500 * MM) < 1e-6 && Math.abs(f.ph - 300 * MM) < 1e-6 && f.orientation === 'landscape');
  const e1 = plotLayout(R, { pageSize: 'ARCH E1', orientation: 'landscape' });
  assert.ok(Math.abs(e1.pw - 42 * 72) < 1e-6 && Math.abs(e1.ph - 30 * 72) < 1e-6);
  assert.throws(() => plotLayout(R, { pageSize: 'Custom', custom: { w: 5, h: 300 } }), /Unknown page size/);
  assert.throws(() => plotLayout(R, { pageSize: 'Custom' }), /Unknown page size/);
  assert.throws(() => pageFit(1, 1, 'Custom', { custom: { w: 6000, h: 300 } }), /Unknown page size/);
});
test('paper list: the existing sizes stay first, then ANSI/ARCH, then Custom', () => {
  assert.deepEqual(LAYOUT_PAPERS.slice(0, 8), ['layout', 'A4', 'A3', 'A2', 'A1', 'A0', 'Letter', 'Tabloid']);
  for (const n of ['ANSI C', 'ANSI D', 'ANSI E', 'ARCH A', 'ARCH B', 'ARCH C', 'ARCH D', 'ARCH E', 'ARCH E1']) assert.ok(LAYOUT_PAPERS.includes(n), n);
  assert.equal(LAYOUT_PAPERS.at(-1), 'Custom');
});
test('plot settings: custom size and keepGreys round-trip; keepGreys defaults off; bad custom sizes fall back', () => {
  assert.equal(PLOT_DEFAULTS.keepGreys, false);
  const s = plotSettingsFrom({ pageSize: 'Custom', layoutPaper: 'ARCH D', customW: 500, customH: 300, keepGreys: true, monochrome: true });
  assert.deepEqual([s.pageSize, s.layoutPaper, s.customW, s.customH, s.keepGreys], ['Custom', 'ARCH D', 500, 300, true]);
  const back = plotSettingsFrom(JSON.parse(JSON.stringify(plotSettingsToStore(s))));
  assert.deepEqual([back.customW, back.customH, back.keepGreys, back.pageSize], [500, 300, true, 'Custom']);
  const bad = plotSettingsFrom({ customW: 5, customH: 6000 });
  assert.deepEqual([bad.customW, bad.customH], [PLOT_DEFAULTS.customW, PLOT_DEFAULTS.customH]);
});
