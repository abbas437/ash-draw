// ARC_DIMENSION (arc length): read as a dimension of kind 'arc', regenerated from its definition points, written back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { buildDimension } from '../src/core/dims.js';
import { defaultDimStyle } from '../src/core/dimsStyle.js';

const S = 15 * Math.SQRT1_2;
const pairs = (...a) => a.map((x) => String(x)).join('\n');
const DXF = pairs(
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 8, '0', 2, '*D1', 70, 1, 10, 0, 20, 0, 30, 0, 3, '*D1',
  0, 'LINE', 8, '0', 10, 10, 20, 0, 30, 0, 11, 15, 21, 0, 31, 0,
  0, 'ENDBLK', 8, '0',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'ARC_DIMENSION', 5, '2A', 100, 'AcDbEntity', 8, 'DIMS',
  100, 'AcDbDimension', 2, '*D1', 10, S, 20, S, 30, 0, 11, S, 21, S + 1, 31, 0, 70, 37, 71, 5, 42, 15.7079632679, 1, '', 3, 'Standard',
  100, 'AcDbArcDimension', 13, 10, 23, 0, 33, 0, 14, 0, 24, 10, 34, 0, 15, 0, 25, 0, 35, 0, 70, 0, 71, 0,
  16, 0, 26, 0, 36, 0, 17, 0, 27, 0, 37, 0, 40, 0, 41, Math.PI / 2,
  0, 'ENDSEC', 0, 'EOF', '');

const near = (p, x, y) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;

test('ARC_DIMENSION reads as one dimension of kind arc with its points and block', () => {
  const doc = readDxf(Buffer.from(DXF));
  const dims = doc.entities.filter((e) => e.type === 'DIMENSION');
  assert.equal(dims.length, 1);
  const e = dims[0];
  assert.equal(e.block, '*D1');
  assert.equal(e.layer, 'DIMS');
  assert.equal(e.def.kind, 'arc');
  assert.ok(near(e.def.center, 0, 0) && near(e.def.p1, 10, 0) && near(e.def.p2, 0, 10) && near(e.def.at, S, S), JSON.stringify(e.def));
  assert.equal(e.def.partial, false);
});

test('arc length regeneration: 90 degree R10 arc gives ⌒15.71 and a concentric dimension arc through the def point', () => {
  const st = { ...defaultDimStyle('ISO-25'), DIMDSEP: 46 };
  const r = buildDimension({ kind: 'arc', center: { x: 0, y: 0 }, p1: { x: 10, y: 0 }, p2: { x: 0, y: 10 }, at: { x: S, y: S } }, st);
  assert.equal(r.text, '⌒15.71');
  assert.ok(Math.abs(r.measurement - 5 * Math.PI) < 1e-9);
  const arcs = r.entities.filter((g) => g.type === 'ARC');
  assert.equal(arcs.length, 1);
  assert.ok(Math.abs(arcs[0].r - 15) < 1e-9 && near(arcs[0].c, 0, 0));
  assert.ok(Math.abs(arcs[0].a0 - 0) < 1e-9 && Math.abs(arcs[0].a1 - 90) < 1e-9, `${arcs[0].a0}..${arcs[0].a1}`);
  // radial extension lines from the arc ends out to the dimension arc
  const lines = r.entities.filter((g) => g.type === 'LINE');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => Math.abs(l.p1.x * l.p2.y - l.p1.y * l.p2.x) < 1e-9), 'extension lines are radial');
  assert.equal(r.entities.filter((g) => g.type === 'SOLID').length, 2, 'two arrows');
  assert.equal(r.text, r.entities.find((g) => g.type === 'MTEXT').text);
});

test('ARC_DIMENSION survives write -> read, as read and when built by this program', () => {
  const doc = readDxf(Buffer.from(DXF));
  const out = writeDxf(doc);
  assert.match(out, /\n\s*0\r?\nARC_DIMENSION\r?\n/);
  assert.match(out, /\n\s*1\r?\nARC_DIMENSION\r?\n\s*2\r?\nAcDbArcDimension/);
  const back = readDxf(Buffer.from(out)).entities.filter((e) => e.type === 'DIMENSION');
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].def, doc.entities.find((e) => e.type === 'DIMENSION').def);
  // without the raw tags the writer rebuilds them from the def
  const e = doc.entities.find((x) => x.type === 'DIMENSION');
  Object.assign(e, { raw: null, defPoint: { ...e.def.at }, measurement: 5 * Math.PI });
  const again = readDxf(Buffer.from(writeDxf(doc))).entities.filter((x) => x.type === 'DIMENSION');
  assert.equal(again.length, 1);
  assert.equal(again[0].def.kind, 'arc');
  assert.ok(near(again[0].def.p1, 10, 0) && near(again[0].def.p2, 0, 10) && near(again[0].def.center, 0, 0) && near(again[0].def.at, S, S));
});
