import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { bboxOf, tessellate, transformEntity, translation } from '../src/core/geom.js';

import { buildScene } from '../src/core/render.js';

const enc = new TextEncoder();
const dxf = (...ents) => enc.encode(['0', 'SECTION', '2', 'ENTITIES', ...ents.flat(), '0', 'ENDSEC', '0', 'EOF', ''].join('\n'));

const OLE = ['0', 'OLE2FRAME', '5', '30', '100', 'AcDbEntity', '8', '0', '100', 'AcDbOle2Frame', '70', '2', '3', 'OLE',
  '10', '10', '20', '50', '30', '0', '11', '30', '21', '20', '31', '0', '71', '2', '72', '0', '90', '8',
  '310', '0123456789ABCDEF', '1', 'OLE'];
const face = (flags) => ['0', '3DFACE', '5', '31', '100', 'AcDbEntity', '8', '0', '100', 'AcDbFace',
  '10', '0', '20', '0', '30', '5', '11', '10', '21', '0', '31', '6', '12', '10', '22', '10', '32', '7', '13', '0', '23', '10', '33', '8', '70', String(flags)];

test('OLE2FRAME: frame bbox from the corners, round trip keeps the 310 data', () => {
  const doc = readDxf(dxf(OLE));
  assert.equal(doc.skipped.OLE2FRAME, undefined);
  const e = doc.entities[0];
  assert.equal(e.type, 'OLE2FRAME');
  assert.deepEqual(bboxOf(e), { minx: 10, miny: 20, maxx: 30, maxy: 50 });
  assert.deepEqual(e.data, ['0123456789ABCDEF']);
  const back = readDxf(enc.encode(writeDxf(doc))).entities.find((x) => x.type === 'OLE2FRAME');
  assert.deepEqual(back.data, ['0123456789ABCDEF']);
  assert.deepEqual([back.p1, back.p2], [e.p1, e.p2]);
  assert.equal(back.kind, 2);
  // a move keeps it a frame; a 30-degree turn is refused
  const mv = transformEntity(e, translation(5, -5));
  assert.deepEqual(bboxOf(mv), { minx: 15, miny: 15, maxx: 35, maxy: 45 });
  const c = Math.cos(0.5), s = Math.sin(0.5);
  assert.throws(() => transformEntity(e, [c, s, -s, c, 0, 0]), { code: 'SHEAR' });
  // drawn: frame + cross + "OLE object" label
  const items = buildScene(doc).items;
  assert.equal(items.filter((it) => it.kind === 'path').length, 2);
  const label = items.find((it) => it.kind === 'text');
  assert.ok(label && label.h <= 2 + 1e-9 && label.h > 0, `label height ${label?.h}`);
});

test('3DFACE: invisible edge 2 draws 3 edges; flags and transform survive', () => {
  const doc = readDxf(dxf(face(2)));
  assert.equal(doc.skipped['3DFACE'], undefined);
  const e = doc.entities[0];
  assert.equal(tessellate(e).length, 3);
  assert.equal(tessellate(readDxf(dxf(face(0))).entities[0]).length, 4);
  assert.equal(tessellate(readDxf(dxf(face(15))).entities[0]).length, 0);
  assert.equal(buildScene(doc).items.length, 1);
  assert.deepEqual(bboxOf(e), { minx: 0, miny: 0, maxx: 10, maxy: 10 });
  const back = readDxf(enc.encode(writeDxf(doc))).entities.find((x) => x.type === '3DFACE');
  assert.equal(back.inv, 2);
  assert.equal(tessellate(transformEntity(e, translation(1, 1))).length, 3);
});

test('missing IMAGE label: bounded to 2% of the frame shorter side, inside the frame top-left', () => {
  const img = ['0', 'IMAGE', '5', '40', '100', 'AcDbEntity', '8', '0', '100', 'AcDbRasterImage', '10', '0', '20', '0', '30', '0',
    '11', '1', '21', '0', '31', '0', '12', '0', '22', '1', '32', '0', '13', '5000', '23', '3000', '340', '0', '70', '7'];
  const label = buildScene(readDxf(dxf(img))).items.find((it) => it.kind === 'text');
  assert.ok(label);
  assert.ok(label.h <= 3000 * 0.02 + 1e-9, `label height ${label.h}`);
  assert.ok(label.p.y < 3000 && label.p.y > 2900, `label y ${label.p.y}`);
  assert.ok(label.p.x >= 0 && label.p.x < 100);
});
