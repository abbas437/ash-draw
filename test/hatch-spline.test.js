import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/core/dxfRead.js';
import { buildScene } from '../src/core/render.js';

// A HATCH whose boundary is a rational quadratic spline edge (a half circle, R 10 around (100,0)) closed by a line.
// LibreDWG writes each weight as code 40 right after its control point (the DXF spec says 42); both must read.
function hatchDxf(wcode) {
  const w = Math.SQRT1_2;
  const ctrl = [[110, 0, 1], [110, 10, w], [100, 10, 1], [90, 10, w], [90, 0, 1]];
  const t = ['0', 'SECTION', '2', 'ENTITIES', '0', 'HATCH', '5', 'A1', '8', '0', '62', '3', '100', 'AcDbEntity', '100', 'AcDbHatch',
    '10', '0', '20', '0', '30', '0', '210', '0', '220', '0', '230', '1', '2', 'SOLID', '70', '1', '71', '0', '91', '1',
    '92', '1', '93', '2',
    '72', '4', '94', '2', '73', '1', '74', '0', '95', '8', '96', '5',
    ...['0', '0', '0', '0.5', '0.5', '1', '1', '1'].flatMap((k) => ['40', k]),
    ...ctrl.flatMap(([x, y, wt]) => ['10', String(x), '20', String(y), wcode, String(wt)]),
    '97', '0',
    '72', '1', '10', '90', '20', '0', '11', '110', '21', '0',
    '97', '0', '75', '1', '76', '1', '98', '0',
    '0', 'ENDSEC', '0', 'EOF'];
  return t.join('\n') + '\n';
}

for (const wcode of ['42', '40']) {
  test(`hatch spline edge with weights as code ${wcode}: control points read, boundary stays on the half circle`, () => {
    const doc = parseDxf(hatchDxf(wcode));
    const h = doc.entities.find((e) => e.type === 'HATCH');
    const seg = h.loops[0].segs[0];
    assert.equal(seg.type, 'spline');
    assert.deepEqual(seg.ctrl.map((p) => [p.x, p.y]), [[110, 0], [110, 10], [100, 10], [90, 10], [90, 0]]);
    assert.equal(seg.weights.length, 5);
    assert.equal(h.loops[0].segs[1].type, 'line', 'the line edge after the spline is still read');
    const b = buildScene(doc).bbox;
    assert.ok(b.minx >= 90 - 1e-6 && b.maxx <= 110 + 1e-6 && b.miny >= -1e-6 && b.maxy <= 10 + 1e-6, JSON.stringify(b));
  });
}

const lineDxf = (codes) => ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '5', 'B1', '8', '0', ...codes, '100', 'AcDbLine',
  '10', '0', '20', '0', '11', '1', '21', '1', '0', 'ENDSEC', '0', 'EOF'].join('\n') + '\n';
test('a 420 that is LibreDWG\'s transparency word (0..255 beside a grey index) gives the index colour', () => {
  assert.equal(parseDxf(lineDxf(['62', '9', '420', '255'])).entities[0].color, 9);
  assert.equal(parseDxf(lineDxf(['62', '8', '420', '127'])).entities[0].color, 8);
});
test('genuine true colours are kept: pure blues beside a blue index, and any colour above 255', () => {
  assert.deepEqual(parseDxf(lineDxf(['62', '5', '420', '255'])).entities[0].color, { r: 0, g: 0, b: 255 });
  assert.deepEqual(parseDxf(lineDxf(['62', '9', '420', String(0xc8caca)])).entities[0].color, { r: 200, g: 202, b: 202 });
  assert.deepEqual(parseDxf(lineDxf(['420', '255'])).entities[0].color, { r: 0, g: 0, b: 255 });
});
