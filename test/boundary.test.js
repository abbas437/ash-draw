import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, addBlock, makeLine, makeArc, makeRect, makePolyline, makeText, makeInsert } from '../src/core/model.js';
import { findBoundary } from '../src/core/boundary.js';
import { entityMeasure } from '../src/core/measure.js';

const area = (loops) => entityMeasure({ type: 'HATCH', loops }).area;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${msg}: ${a} != ${b}`);
const box4 = (x0, y0, x1, y1, o) => [
  makeLine({ x: x0, y: y0 }, { x: x1, y: y0 }, o), makeLine({ x: x1, y: y0 }, { x: x1, y: y1 }, o),
  makeLine({ x: x1, y: y1 }, { x: x0, y: y1 }, o), makeLine({ x: x0, y: y1 }, { x: x0, y: y0 }, o),
];
function sheet() { // title-block frame (closed polyline) with a small box of 4 LINEs and a text inside
  const doc = newDocument();
  addEntity(doc, makeRect({ x: 0, y: 0 }, { x: 420, y: 297 }));
  for (const e of box4(100, 100, 130, 120)) addEntity(doc, e);
  addEntity(doc, makeText({ x: 200, y: 200 }, 5, 'PUMP P-101'));
  return doc;
}

test('boundary: 4 LINEs inside a closed frame -> the small box, not the sheet', () => {
  const loops = findBoundary(sheet(), { x: 110, y: 110 });
  assert.equal(loops.length, 1);
  near(area(loops), 600, 'box area');
});

test('boundary: pick outside the box -> frame with the box as island; text is ignored', () => {
  const loops = findBoundary(sheet(), { x: 300, y: 50 });
  assert.equal(loops.length, 2);
  near(area(loops), 420 * 297 - 600, 'frame minus island');
});

test('boundary: T-junction and crossing lines split the region', () => {
  const doc = newDocument();
  for (const e of box4(0, 0, 100, 50)) addEntity(doc, e);
  addEntity(doc, makeLine({ x: 40, y: 0 }, { x: 40, y: 50 }));    // T at both ends
  addEntity(doc, makeLine({ x: -10, y: 20 }, { x: 110, y: 20 })); // crosses everything, overhangs (dangling ends)
  near(area(findBoundary(doc, { x: 10, y: 10 })), 40 * 20, 'lower left cell');
  near(area(findBoundary(doc, { x: 70, y: 40 })), 60 * 30, 'upper right cell');
  assert.equal(findBoundary(doc, { x: 105, y: 25 }), null, 'outside');
});

test('boundary: an ARC closed by a LINE keeps the arc as a bulge', () => {
  const doc = newDocument();
  addEntity(doc, makeArc({ x: 0, y: 0 }, 10, 0, 180));
  addEntity(doc, makeLine({ x: -10, y: 0 }, { x: 10, y: 0 }));
  const loops = findBoundary(doc, { x: 0, y: 5 });
  assert.ok(loops[0].pts.some((v) => Math.abs(v.bulge) > 0.5), 'bulge preserved');
  near(area(loops), Math.PI * 50, 'half disc');
});

test('boundary: open polyline + line, region inside a (nested) INSERT', () => {
  const doc = newDocument();
  addBlock(doc, 'CELL', { x: 0, y: 0 }, [makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), makeLine({ x: 0, y: 10 }, { x: 0, y: 0 })]);
  addBlock(doc, 'OUTER', { x: 0, y: 0 }, [makeInsert('CELL', { x: 0, y: 0 })]);
  addEntity(doc, makeInsert('OUTER', { x: 100, y: 100 }, { sx: 2, sy: 2 }));
  near(area(findBoundary(doc, { x: 110, y: 110 })), 400, 'scaled cell');
});

test('boundary: open shape and hidden layers give no boundary', () => {
  const doc = newDocument();
  for (const e of box4(0, 0, 10, 10).slice(0, 3)) addEntity(doc, e);
  assert.equal(findBoundary(doc, { x: 5, y: 5 }), null, 'three sides only');
  addEntity(doc, makeLine({ x: 0, y: 10 }, { x: 0, y: 0 }, { layer: 'OFF' }));
  doc.layers.set('OFF', { name: 'OFF', visible: false });
  assert.equal(findBoundary(doc, { x: 5, y: 5 }), null, 'closing line is on a hidden layer');
});
