// VPORT *Active -> doc.activeView (the view AutoCAD opens model space on)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';

const vport = (tags, name = '*Active') => ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'VPORT', '70', '1',
  '0', 'VPORT', '2', name, '70', '0', ...tags, '0', 'ENDTAB', '0', 'ENDSEC'];
const dxf = (tags, name) => new TextEncoder().encode([...vport(tags, name), '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'));
const view = (o) => ['12', o.x ?? 0, '22', o.y ?? 0, '16', o.d?.[0] ?? 0, '26', o.d?.[1] ?? 0, '36', o.d?.[2] ?? 1,
  '17', o.tx ?? 0, '27', o.ty ?? 0, '40', o.h ?? 10, '41', o.a ?? 1, '51', o.tw ?? 0].map(String);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('plain view', () => {
  assert.deepEqual(readDxf(dxf(view({ x: 100, y: 50, h: 20, a: 2 }))).activeView, { cx: 100, cy: 50, height: 20, aspect: 2 });
});
test('target and twist (same rule as VIEWPORT): target (1000,0), twist 90, DCS centre (0,10) -> (1010,0)', () => {
  const v = readDxf(dxf(view({ tx: 1000, ty: 0, tw: 90, x: 0, y: 10 }))).activeView;
  near(v.cx, 1010); near(v.cy, 0);
});
test('name is case-insensitive; a 3D view direction, a bad height or another name give none', () => {
  assert.ok(readDxf(dxf(view({}), '*ACTIVE')).activeView);
  assert.equal(readDxf(dxf(view({ d: [0, 0, -1] }))).activeView, undefined);
  assert.equal(readDxf(dxf(view({ d: [1, 1, 1] }))).activeView, undefined);
  assert.equal(readDxf(dxf(view({ h: 0 }))).activeView, undefined);
  assert.equal(readDxf(dxf(view({}), 'Other')).activeView, undefined);
});
