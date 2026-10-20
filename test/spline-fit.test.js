// Fit-point-only SPLINEs (DXF group 74, no control points): drawn as the cubic interpolating every fit point; PDF / SVG
// never carry a non-finite number (such an object is left out and counted in a warning); dense hatches printed as a
// tint are reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { tessellate } from '../src/core/geom.js';
import { newDocument, addEntity, makeSpline, makeLine } from '../src/core/model.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { exportPdf } from '../src/core/exportPdf.js';

const segDist = (q, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy);
};
const polyDist = (q, pl) => { let d = Infinity; for (let i = 0; i + 1 < pl.length; i++) d = Math.min(d, segDist(q, pl[i], pl[i + 1])); return d; };
const size = (pts) => Math.hypot(Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)));
const CORPUS = [{ x: 100, y: 500 }, { x: 250, y: 560 }, { x: 400, y: 480 }, { x: 550, y: 560 }]; // ezdxf add_spline(fit_points=...)

for (const [name, fit] of [['2 points', CORPUS.slice(0, 2)], ['3 points', CORPUS.slice(0, 3)], ['4 points', CORPUS],
  ['6 points, a repeated one', [...CORPUS, { x: 550, y: 560 }, { x: 700, y: 400 }, { x: 800, y: 420 }]]]) {
  test(`fit-point-only spline (${name}) passes through every fit point, all finite`, () => {
    const pl = tessellate(makeSpline({ fit }))[0];
    assert.ok(pl && pl.length > fit.length, 'tessellated');
    assert.ok(pl.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), 'finite');
    const tol = 1e-6 * size(fit);
    for (const q of fit) assert.ok(polyDist(q, pl) <= tol, `fit point ${q.x},${q.y} off by ${polyDist(q, pl)}`);
  });
}

test('fit-point spline: the stored end tangents (12 / 13) set the end directions, and are written back', () => {
  const e = makeSpline({ fit: CORPUS, startTan: { x: 0, y: 1 }, endTan: { x: 1, y: 0 } });
  const pl = tessellate(e)[0], a = pl[1], b = pl.at(-2);
  assert.ok(Math.abs(a.x - pl[0].x) < 0.15 * Math.abs(a.y - pl[0].y), 'leaves the first point straight up');
  assert.ok(Math.abs(pl.at(-1).y - b.y) < 0.15 * Math.abs(pl.at(-1).x - b.x), 'arrives horizontally');
  for (const q of CORPUS) assert.ok(polyDist(q, pl) <= 1e-6 * size(CORPUS));
  const doc = newDocument(); addEntity(doc, e);
  const back = readDxf(new TextEncoder().encode(writeDxf(doc))).entities.find((x) => x.type === 'SPLINE');
  assert.deepEqual([back.ctrl, back.fit, back.startTan, back.endTan], [[], CORPUS, { x: 0, y: 1 }, { x: 1, y: 0 }]);
});

const pdfContent = async (bytes) => {
  const pdf = await PDFDocument.load(bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
};

test('a fit-point-only spline exports to PDF and SVG with finite numbers only, and the objects after it too', async () => {
  const doc = newDocument();
  addEntity(doc, makeSpline({ fit: CORPUS }));
  addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 1000, y: 0 }));
  const { bytes, warnings } = await exportPdf(doc, { pageSize: 'A3' });
  const text = await pdfContent(bytes);
  assert.doesNotMatch(text, /NaN|Infinity/);
  assert.equal((text.match(/ l\b/g) || []).length > 40, true, 'the spline is drawn as many segments');
  assert.deepEqual(warnings, []);
  const svgWarn = [], svg = exportSvg(doc, { warnings: svgWarn });
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.deepEqual(svgWarn, []);
});

const STYLE = { color: { auto: true }, lw: -3, lt: 'CONTINUOUS', layerName: '0' };
const BOX = { minx: 0, miny: 0, maxx: 100, maxy: 100 };

test('PDF / SVG: an object with a NaN point is skipped (the bad point, not the page) and counted in a warning', async () => {
  const doc = newDocument();
  const scene = {
    bbox: BOX,
    items: [
      { kind: 'path', ops: [0, 0, 0, 1, 10, 10, 1, NaN, NaN, 1, 20, 0, 1, 30, 10], style: STYLE, bbox: BOX },
      { kind: 'path', ops: [0, 0, 100, 1, 100, 100], style: STYLE, bbox: BOX },
    ],
  };
  const { bytes, warnings } = await exportPdf(doc, { scene, pageSize: 'A4' });
  const text = await pdfContent(bytes);
  assert.doesNotMatch(text, /NaN|Infinity/);
  assert.equal((text.match(/ m\b/g) || []).length, 3, 'two pieces of the bad path and the good path');
  assert.deepEqual(warnings, ['1 object could not be drawn (invalid coordinates)']);
  const svgWarn = [], svg = exportSvg(doc, { scene, warnings: svgWarn });
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.match(svg, /M0 0L10 -10M20 0L30 -10/);
  assert.deepEqual(svgWarn, ['1 object could not be drawn (invalid coordinates)']);
});

test('PDF / SVG: a hatch with more than 4000 pattern lines prints as a tint, with a warning', async () => {
  const doc = newDocument();
  const hatch = {
    kind: 'hatch', ops: [0, 0, 0, 1, 100, 0, 1, 100, 100, 1, 0, 100, 4], bbox: BOX, style: STYLE,
    lines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 0.01 }, dashes: [] }],
  };
  const scene = { bbox: BOX, items: [hatch] };
  assert.deepEqual((await exportPdf(doc, { scene, pageSize: 'A4' })).warnings, ['1 dense hatch was printed as a tint']);
  const svgWarn = [];
  exportSvg(doc, { scene, warnings: svgWarn });
  assert.deepEqual(svgWarn, ['1 dense hatch was printed as a tint']);
  // a drawable hatch gives no warning
  const sparse = { bbox: BOX, items: [{ ...hatch, lines: [{ ...hatch.lines[0], offset: { x: 0, y: 5 } }] }] };
  assert.deepEqual((await exportPdf(doc, { scene: sparse, pageSize: 'A4' })).warnings, []);
});
