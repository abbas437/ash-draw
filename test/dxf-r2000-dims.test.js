import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { r2000DimensionTags } from '../src/core/dims.js';

// a rotated dimension as LibreDWG converts it from an AutoCAD 2013 drawing (the reviewer's SEC-HVC-30001): 280 version
// and 73-75 are R2010+ codes, and the zero dimension type 70 is left out
const LIBREDWG_DIM = [[100, 'AcDbDimension'], [280, '0'], [2, '*D102'], [10, '-0.0113'], [20, '0.12446'], [30, '0.0'],
  [11, '-0.0151'], [21, '0.0838'], [31, '0.0'], [1, ''], [71, '5'], [42, '-1.0'], [73, '0'], [74, '0'], [75, '0'],
  [12, '-0.04445'], [22, '0.34671'], [3, 'DIM-50'], [100, 'AcDbAlignedDimension'], [13, '-0.0113'], [23, '0.0432'],
  [33, '0.0'], [14, '-0.0113'], [24, '0.12446'], [34, '0.0'], [52, '0.0'], [50, '90.0'], [100, 'AcDbRotatedDimension']];

test('DIMENSION tags from a newer file are reduced to the DXF R2000 set', () => {
  const t = r2000DimensionTags(LIBREDWG_DIM, { kind: 'linear' });
  const codes = t.map(([c]) => c);
  for (const c of [280, 73, 74, 75]) assert.ok(!codes.includes(c), `code ${c} written`);
  assert.deepEqual(t.find(([c]) => c === 70), [70, 0]);
  assert.ok(codes.indexOf(70) < codes.indexOf(100, 1), '70 sits in AcDbDimension');
  assert.deepEqual(t.filter(([c]) => c === 100).map(([, v]) => v), ['AcDbDimension', 'AcDbAlignedDimension', 'AcDbRotatedDimension']);
  assert.deepEqual(t.find(([c]) => c === 50), [50, '90.0']);
  // TrueView 2026: "Unexpected DXF group code: 52 in AcDbRotatedDimension" when 52 sits in AcDbAlignedDimension
  const sub = (i) => t.slice(0, i).filter(([c]) => c === 100).pop()[1];
  assert.equal(sub(codes.indexOf(52)), 'AcDbDimension');
  assert.ok(codes.indexOf(13) < codes.indexOf(14) && codes.indexOf(14) < codes.indexOf(50), 'AutoCAD order 13, 14, 50');
});

test('a saved DXF (R2000) holds no R2010+ DIMENSION codes', () => {
  const tags = LIBREDWG_DIM.map(([c, v]) => `${c}\n${v}`).join('\n');
  const src = `0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\n*D102\n70\n1\n10\n0\n20\n0\n30\n0\n3\n*D102\n1\n\n0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n1\n31\n0\n0\nENDBLK\n8\n0\n0\nENDSEC\n` +
    `0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n5\n1312\n100\nAcDbEntity\n8\n0\n${tags}\n0\nENDSEC\n0\nEOF\n`;
  const doc = readDxf(new TextEncoder().encode(src));
  assert.equal(doc.entities.filter((e) => e.type === 'DIMENSION').length, 1);
  const text = writeDxf(doc);
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  const at = lines.findIndex((l, i) => l === 'DIMENSION' && lines[i - 1] === '0');
  const body = []; for (let i = at + 1; lines[i] !== '0'; i += 2) body.push(+lines[i]);
  assert.ok(body.includes(100) && body.includes(2), 'DIMENSION written with its tags');
  for (const c of [280, 73, 74, 75]) assert.ok(!body.includes(c), `code ${c} in the saved DIMENSION`);
});
