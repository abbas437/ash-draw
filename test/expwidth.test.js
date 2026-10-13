// Plotted output of polylines with constant width (PLINE Width, DONUT): filled bands, as on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { newDocument, addEntity, makePolyline } from '../src/core/model.js';
import { donutPolyline } from '../src/core/draw2.js';
import { buildScene } from '../src/core/render.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { exportPdf, plotLayout } from '../src/core/exportPdf.js';

const wide = (vertices, closed, width, color = 1) => {
  const doc = newDocument(), e = makePolyline(vertices, closed, {});
  e.width = width; e.color = color;
  addEntity(doc, e);
  return doc;
};
const band = (w) => wide([{ x: 0, y: 0 }, { x: 100, y: 0 }], false, w);
const donut = () => { const g = donutPolyline({ x: 0, y: 0 }, 2, 6); return wide(g.vertices, true, g.width); };

const svgPaths = (svg) => [...svg.matchAll(/<path d="([^"]*)"([^>]*)\/>/g)].map((m) => ({ d: m[1], attrs: m[2] }));
const attr = (a, name) => (a.match(new RegExp(` ${name}="([^"]*)"`)) || [])[1];
const nums = (d) => (d.match(/-?[\d.]+(e-?\d+)?/g) || []).map(Number);

async function pdfText(doc) {
  const pdf = await PDFDocument.load((await exportPdf(doc)).bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
}

test('SVG: a width-2 polyline plots as a band filled in its colour, covering y -1..1', () => {
  const fills = svgPaths(exportSvg(band(2))).filter((p) => attr(p.attrs, 'fill') === 'rgb(255,0,0)');
  assert.equal(fills.length, 1, 'one filled band');
  const v = nums(fills[0].d), xs = v.filter((_, i) => i % 2 === 0), ys = v.filter((_, i) => i % 2 === 1);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 100]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [-1, 1]);
});

test('PDF: a width-2 polyline plots as a filled path (f*) with the band corners on the page', async () => {
  const doc = band(2), { k, ox, oy } = plotLayout(buildScene(doc).bbox, {});
  const text = await pdfText(doc);
  const m = text.match(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l\s+([-\d.]+) ([-\d.]+) l\s+([-\d.]+) ([-\d.]+) l\s+h\s+f\*?\s/);
  assert.ok(m, `no filled quadrilateral in\n${text}`);
  const got = m.slice(1).map(Number), want = [[0, 1], [100, 1], [100, -1], [0, -1]].flatMap(([x, y]) => [ox + x * k, oy + y * k]);
  got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 0.01, `corner coordinate ${i}: ${g} vs ${want[i]}`));
});

test('a band thinner than the minimum line weight still plots, outlined at the minimum weight', async () => {
  const p = svgPaths(exportSvg(band(0.0001))).find((q) => attr(q.attrs, 'fill') === 'rgb(255,0,0)');
  assert.ok(p, 'band drawn');
  assert.equal(attr(p.attrs, 'stroke'), 'rgb(255,0,0)');
  assert.ok(Number(attr(p.attrs, 'stroke-width')) >= 0.18, `stroke-width ${attr(p.attrs, 'stroke-width')}`);
  // a band wider than the minimum keeps its exact edges: no outline
  assert.equal(attr(svgPaths(exportSvg(band(2))).find((q) => attr(q.attrs, 'fill') === 'rgb(255,0,0)').attrs, 'stroke'), 'none');

  const text = await pdfText(band(0.0001));
  const m = text.match(/([\d.]+) w[\s\S]*?\bh\s+B\*/);
  assert.ok(m, `no fill-and-stroke band in\n${text}`);
  assert.ok(Number(m[1]) >= 0.25, `line width ${m[1]} pt`);
});

test('DONUT plots as a filled ring (outer radius 3, inner 1) in SVG and PDF', async () => {
  const fills = svgPaths(exportSvg(donut())).filter((p) => attr(p.attrs, 'fill') === 'rgb(255,0,0)');
  assert.equal(fills.length, 2, 'two half-ring sectors');
  for (const f of fills) {
    const radii = [...f.d.matchAll(/A([\d.]+) /g)].map((a) => Number(a[1])).sort();
    assert.deepEqual(radii, [1, 3], `sector arcs ${f.d}`);
    assert.match(f.d, /Z$/);
  }
  const text = await pdfText(donut());
  assert.equal((text.match(/\bf\*/g) || []).length, 2, 'two filled sectors');
  assert.ok((text.match(/ c\b/g) || []).length >= 4, 'curved edges');
});
