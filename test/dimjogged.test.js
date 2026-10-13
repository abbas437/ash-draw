// LARGE_RADIAL_DIMENSION (jogged radius): read as a dimension of kind 'jogged', regenerated from its points, written back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { buildDimension } from '../src/core/dims.js';
import { defaultDimStyle } from '../src/core/dimsStyle.js';

const pairs = (...a) => a.map((x) => String(x)).join('\n');
// R50 arc about (0,0); chord point (50,0); override centre (30,-10); jog at (40,-3); text at (60,0); jog angle 45 deg
const DXF = pairs(
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 8, '0', 2, '*D1', 70, 1, 10, 0, 20, 0, 30, 0, 3, '*D1',
  0, 'LINE', 8, '0', 10, 50, 20, 0, 30, 0, 11, 30, 21, 0, 31, 0,
  0, 'ENDBLK', 8, '0',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LARGE_RADIAL_DIMENSION', 5, '2B', 100, 'AcDbEntity', 8, 'DIMS',
  100, 'AcDbDimension', 2, '*D1', 10, 0, 20, 0, 30, 0, 11, 60, 21, 0, 31, 0, 70, 36, 71, 5, 42, 50, 1, '', 3, 'Standard',
  100, 'AcDbRadialDimensionLarge', 13, 50, 23, 0, 33, 0, 14, 30, 24, -10, 34, 0, 15, 40, 25, -3, 35, 0, 40, Math.PI / 4,
  0, 'ENDSEC', 0, 'EOF', '');

const near = (p, x, y) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;

test('LARGE_RADIAL_DIMENSION reads as one dimension of kind jogged with its points', () => {
  const doc = readDxf(Buffer.from(DXF));
  const dims = doc.entities.filter((e) => e.type === 'DIMENSION');
  assert.equal(dims.length, 1);
  const e = dims[0];
  assert.equal(e.block, '*D1');
  assert.equal(e.layer, 'DIMS');
  assert.equal(e.def.kind, 'jogged');
  const d = e.def;
  assert.ok(near(d.center, 0, 0) && near(d.chord, 50, 0) && near(d.override, 30, -10) && near(d.jog, 40, -3) && near(d.at, 60, 0), JSON.stringify(d));
  assert.ok(Math.abs(d.jogAngle - Math.PI / 4) < 1e-9);
});

test('jogged regeneration: R50 arc gives R50, an arrow at the arc and a leader with a 45 degree jog to the override centre', () => {
  const st = { ...defaultDimStyle('ISO-25'), DIMDSEP: 46 };
  const def = { kind: 'jogged', center: { x: 0, y: 0 }, chord: { x: 50, y: 0 }, override: { x: 30, y: -10 }, jog: { x: 40, y: -3 }, at: { x: 40, y: 0 }, jogAngle: Math.PI / 4 };
  const r = buildDimension(def, st);
  assert.equal(r.text, 'R50');
  assert.ok(Math.abs(r.measurement - 50) < 1e-9);
  assert.equal(r.text, r.entities.find((g) => g.type === 'MTEXT').text);
  assert.ok(r.entities.some((g) => g.type === 'SOLID'), 'arrow');
  const lines = r.entities.filter((g) => g.type === 'LINE');
  assert.equal(lines.length, 3, 'radial segment, jog, segment to the override centre');
  const [l1, jog, l2] = lines;
  assert.ok(near(l1.p1, 50, 0) && Math.abs(l1.p2.y) < 1e-9, 'first segment on the radial line from the chord point');
  assert.ok(near(l2.p2, 30, -10) && Math.abs(l2.p1.y + 10) < 1e-9, 'last segment parallel to it, ending at the override centre');
  const dx = jog.p2.x - jog.p1.x, dy = jog.p2.y - jog.p1.y;
  assert.ok(Math.abs(Math.abs(Math.atan2(dy, dx)) - 3 * Math.PI / 4) < 1e-9, `jog at 45 degrees to the line: ${dx},${dy}`);
  assert.ok(Math.abs((jog.p1.x + jog.p2.x) / 2 - 40) < 1e-9, 'jog centred on the jog point');
});

test('LARGE_RADIAL_DIMENSION survives write -> read, as read and when built by this program', () => {
  const doc = readDxf(Buffer.from(DXF));
  const out = writeDxf(doc);
  assert.match(out, /\n\s*0\r?\nLARGE_RADIAL_DIMENSION\r?\n/);
  assert.match(out, /\n\s*1\r?\nLARGE_RADIAL_DIMENSION\r?\n\s*2\r?\nAcDbRadialDimensionLarge/);
  const back = readDxf(Buffer.from(out)).entities.filter((e) => e.type === 'DIMENSION');
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].def, doc.entities.find((e) => e.type === 'DIMENSION').def);
  // without the raw tags the writer rebuilds them from the def
  const e = doc.entities.find((x) => x.type === 'DIMENSION');
  Object.assign(e, { raw: null, defPoint: { ...e.def.center }, measurement: 50 });
  const again = readDxf(Buffer.from(writeDxf(doc))).entities.filter((x) => x.type === 'DIMENSION');
  assert.equal(again.length, 1);
  const { jogAngle, ...pts } = again[0].def, { jogAngle: ja0, ...pts0 } = e.def;
  assert.deepEqual(pts, pts0);
  assert.ok(Math.abs(jogAngle - ja0) < 1e-12, 'jog angle as written (15 significant digits)');
});

test('AcDbRadialDimensionLarge fields are written in the order 13, 14, 15, 40', () => {
  const doc = readDxf(Buffer.from(DXF));
  const e = doc.entities.find((x) => x.type === 'DIMENSION');
  Object.assign(e, { raw: null, defPoint: { ...e.def.center }, measurement: 50 }); // rebuilt by the writer
  const lines = writeDxf(doc).split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l, i) => l === 'AcDbRadialDimensionLarge' && lines[i - 1] === '100'); // entity subclass, not CLASSES
  assert.ok(at > 0);
  const codes = [];
  for (let i = at + 1; i < lines.length - 1 && lines[i] !== '0' && lines[i] !== '100'; i += 2) codes.push(+lines[i]);
  assert.deepEqual(codes.filter((c) => [13, 14, 15, 40].includes(c)), [13, 14, 15, 40]);
});
