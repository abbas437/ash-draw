import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, makeLine } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { plotLayout, plotScale } from '../src/core/exportPdf.js';
import { unitsPerMm, exportSvgBytes } from '../renderer/files.js';

const PT_PER_MM = 72 / 25.4;

/** a drawing in `units` ($INSUNITS) holding one horizontal line `len` drawing units long */
function lineDoc(units, len) {
  const doc = newDocument();
  doc.units = units;
  addEntity(doc, makeLine({ x: 0, y: 0 }, { x: len, y: 0 }));
  return doc;
}

/** paper width (mm) of a model-space plot of `doc` at 1:n, scaled as the Plot dialog scales it */
const paperWidthMm = (doc, n) => {
  const region = { minx: 0, miny: 0, maxx: doc.entities[0].p2.x, maxy: 1e-9 };
  return plotLayout(region, { pageSize: 'fit', margin: 0, scale: plotScale(n, 1 / unitsPerMm(doc)) }).pw / PT_PER_MM;
};

test('a 1:100 plot of a 10 m object is 100 mm on paper, whatever the drawing units', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  near(paperWidthMm(lineDoc(4, 10000), 100), 100); // millimetres
  near(paperWidthMm(lineDoc(6, 10), 100), 100); // metres
  near(paperWidthMm(lineDoc(5, 1000), 100), 100); // centimetres
  near(paperWidthMm(lineDoc(1, 10000 / 25.4), 100), 100); // inches
  near(paperWidthMm(lineDoc(0, 10000), 100), 100); // unitless: taken as millimetres
});

test('unitsPerMm is drawing units per millimetre', () => {
  assert.equal(unitsPerMm({ units: 6 }), 0.001);
  assert.equal(unitsPerMm({ units: 4 }), 1);
  assert.equal(unitsPerMm({ units: 1 }), 1 / 25.4);
  assert.equal(unitsPerMm({ units: 13 }), 1000); // microns
  assert.equal(unitsPerMm({ units: 0 }), 1);
});

test('SVG export: a 10 m line in a metres drawing is 10000 mm wide (1:1)', async () => {
  const width = async (doc) => {
    const svg = new TextDecoder().decode(await exportSvgBytes(doc, buildScene(doc)));
    return Number(/width="([\d.e+-]+)mm"/.exec(svg)[1]);
  };
  const m = await width(lineDoc(6, 10)), mm = await width(lineDoc(4, 10000));
  assert.ok(Math.abs(m - mm) < 1e-6 * mm, `metres ${m} mm, millimetres ${mm} mm`);
  assert.ok(Math.abs(mm - 10400) < 1e-6, `width ${mm}`); // the line plus the 2 % margin on each side
});
