import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportToPaper, docWithFrozen, buildScene } from '../src/core/render.js';
import { newLayout, paperRects, layoutPage } from '../src/core/layouts.js';
import { newDocument } from '../src/core/model.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { readDxf } from '../src/core/dxfRead.js';

const vp = { c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 1000, y: 500 }, viewHeight: 5000, twist: 0 };
const near = (a, b) => { assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

test('viewportToPaper: 1:50, no twist', () => {
  near(viewportToPaper(vp, { x: 1000, y: 500 }), { x: 200, y: 150 });
  near(viewportToPaper(vp, { x: 1500, y: 500 }), { x: 210, y: 150 }); // 500 model = 10 paper at 1:50
  near(viewportToPaper(vp, { x: 1000, y: 250 }), { x: 200, y: 145 });
});

test('viewportToPaper: 1:50, twist 30 degrees turns the model counter-clockwise', () => {
  const t = Math.PI / 6, v = { ...vp, twist: t };
  near(viewportToPaper(v, { x: 1500, y: 500 }), { x: 200 + 10 * Math.cos(t), y: 150 + 10 * Math.sin(t) });
  near(viewportToPaper(v, { x: 1000, y: 1000 }), { x: 200 - 10 * Math.sin(t), y: 150 + 10 * Math.cos(t) });
});

test('docWithFrozen freezes only the listed layers, case-insensitively, without touching the doc', () => {
  const doc = { layers: new Map([['0', { name: '0' }], ['HIDE', { name: 'HIDE' }]]), entities: [] };
  const d = docWithFrozen(doc, ['hide']);
  assert.equal(d.layers.get('HIDE').frozen, true);
  assert.ok(!d.layers.get('0').frozen);
  assert.ok(!doc.layers.get('HIDE').frozen);
  assert.equal(docWithFrozen(doc, []), doc);
});

test('inch layout plotted extents at 1:25.585, paper rotated 90 deg: the sheet is drawn where the paper-space content is', () => {
  // the structure of a real A0 drawing: paper 841 x 1188.8 mm rotated, plot units inches, custom scale 1:25.585, plot
  // type extents (centred), limits = the sheet in layout units; the title block border is drawn in about mm
  const doc = newDocument(), lay = newLayout('Layout1', 1);
  Object.assign(lay.plot, { paperW: 841, paperH: 1188.800048828125, margins: { l: 0, b: 0, r: 0, t: 0 }, origin: { x: 0, y: 1.9728 },
    units: 0, rotation: 1, plotType: 1, scaleNum: 1, scaleDen: 25.5853509688894, flags: 692 });
  lay.limMin = { x: -0.9669852531353134, y: 3.144846984914011 }; lay.limMax = { x: 1196.508073057905, y: 850.2818613485356 };
  const line = (id, x1, y1, x2, y2) => ({ type: 'LINE', id, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
  lay.entities.push(line(1, 1.0064, 3.1836, 1194.5347, 3.1836), line(2, 1194.5347, 3.1836, 1194.5347, 850.2689),
    line(3, 1194.5347, 850.2689, 1.0064, 850.2689), line(4, 1.0064, 850.2689, 1.0064, 3.1836));
  lay.entities.push({ type: 'VIEWPORT', id: 5, layer: '0', color: 256, vpId: 2, status: 1, on: true, c: { x: 1102.83, y: 616.74 }, width: 93.61, height: 70.34,
    viewCenter: { x: 626161.76, y: 2714458.55 }, viewHeight: 672.79, twist: 0, frozen: [], flags: 32768 });
  doc.layouts = [lay];
  const back = readDxf(new TextEncoder().encode(writeDxf(doc))).layouts[0];
  const { sheet } = paperRects(back), bb = buildScene(Object.create(doc, { entities: { value: back.entities } })).bbox;
  assert.ok(Math.abs(sheet.maxx - sheet.minx - 1197.47) < 0.05 && Math.abs(sheet.maxy - sheet.miny - 847.14) < 0.05, JSON.stringify(sheet));
  assert.ok(bb.minx >= sheet.minx && bb.maxx <= sheet.maxx && bb.miny >= sheet.miny && bb.maxy <= sheet.maxy, `${JSON.stringify(bb)} off ${JSON.stringify(sheet)}`);
  const v = back.entities.find((e) => e.type === 'VIEWPORT' && e.vpId === 2);
  assert.ok(v.c.x - v.width / 2 > sheet.minx && v.c.x + v.width / 2 < sheet.maxx && v.c.y + v.height / 2 < sheet.maxy, 'viewport on the sheet');
  // the PDF page is still the paper (1188.8 x 841 mm landscape)
  const lp = layoutPage(back);
  assert.ok(Math.abs(lp.pw - (1188.8 * 72) / 25.4) < 0.01 && Math.abs(lp.ph - (841 * 72) / 25.4) < 0.01, JSON.stringify(lp));
});

test('plot-layout (type 5) pages keep the printable lower-left at 0,0 whatever the limits say', () => {
  const lay = newLayout('L', 1); // A3, margins 7.5 / 20, limits 0,0 - 420,297
  assert.deepEqual(paperRects(lay).sheet, { minx: -7.5, miny: -20, maxx: 412.5, maxy: 277 });
});
