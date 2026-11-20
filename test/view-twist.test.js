// Model view twist (VPORT *Active group 51): view rot in screenToWorld / worldToScreen / zoomAt / fitView, the same
// sign as a layout VIEWPORT's twist
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenToWorld, worldToScreen, zoomAt, fitView, viewportToPaper, turnedView } from '../src/core/render.js';
import { framePlan, frameKey } from '../src/core/frameCache.js';
import { readDxf } from '../src/core/dxfRead.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const R90 = Math.PI / 2;
const v90 = { cx: 10, cy: 20, zoom: 2, width: 400, height: 300, rot: R90 };

test('round trip with a twist', () => {
  for (const rot of [0.3, R90, -2]) {
    const v = { ...v90, rot }, p = { x: 13.5, y: -4 }, s = worldToScreen(v, p), q = screenToWorld(v, s.x, s.y);
    near(q.x, p.x); near(q.y, p.y);
  }
});

test('rot 90: world +x points screen-up, +y screen-left (counter-clockwise, as a VIEWPORT twist)', () => {
  const o = worldToScreen(v90, { x: 10, y: 20 }), ex = worldToScreen(v90, { x: 11, y: 20 }), ey = worldToScreen(v90, { x: 10, y: 21 });
  near(o.x, 200); near(o.y, 150);
  near(ex.x - o.x, 0); near(ex.y - o.y, -2); // up (screen y grows downward)
  near(ey.x - o.x, -2); near(ey.y - o.y, 0);
});

test('Model view and a VIEWPORT with the same twist (both group 51 = 90) show the model the same way round', () => {
  const vportTwist = 90 * Math.PI / 180; // VIEWPORT group 51 in radians, as readViewport stores it
  const vp = { c: { x: 0, y: 0 }, height: 10, viewHeight: 10, viewCenter: { x: 0, y: 0 }, twist: vportTwist };
  const tags = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'VPORT', '70', '1', '0', 'VPORT', '2', '*Active', '70', '0',
    '12', '0', '22', '0', '16', '0', '26', '0', '36', '1', '17', '0', '27', '0', '40', '10', '41', '1', '51', '90',
    '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''];
  const av = readDxf(new TextEncoder().encode(tags.join('\n'))).activeView;
  near(av.twist, R90);
  const view = { cx: 0, cy: 0, zoom: 1, width: 100, height: 100, rot: av.twist };
  for (const p of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 3, y: -2 }]) {
    const paper = viewportToPaper(vp, p), s = worldToScreen(view, p);
    near(s.x - 50, paper.x); near(50 - s.y, paper.y); // same direction on screen as on the sheet (paper +y is screen-up)
  }
});

test('zoomAt keeps the world point under the cursor with a twist', () => {
  const before = screenToWorld(v90, 50, 70), z = zoomAt(v90, 50, 70, 1.7), after = screenToWorld(z, 50, 70);
  near(after.x, before.x); near(after.y, before.y);
  assert.equal(z.rot, R90); near(z.zoom, 3.4);
});

test('fitView with rot fits the rotated extents; without stays axis-aligned', () => {
  const b = { minx: 0, miny: 0, maxx: 200, maxy: 100 };
  const up = fitView(b, 400, 300, 0), turned = fitView(b, 400, 300, 0, R90);
  near(up.zoom, 2); assert.equal(up.rot, undefined);
  near(turned.zoom, 1.5); assert.equal(turned.rot, R90); // the 200-wide box stands 200 tall on screen
  for (const [x, y] of [[0, 0], [200, 0], [0, 100], [200, 100]]) {
    const s = worldToScreen(turned, { x, y });
    assert.ok(s.x >= -1e-9 && s.x <= 400 + 1e-9 && s.y >= -1e-9 && s.y <= 300 + 1e-9, `${s.x},${s.y}`);
  }
});

test('the culling square of a turned view holds the whole turned screen', () => {
  const sq = turnedView(v90), hw = sq.width / 2 / sq.zoom, hh = sq.height / 2 / sq.zoom;
  for (const [x, y] of [[0, 0], [400, 0], [0, 300], [400, 300]]) {
    const p = screenToWorld(v90, x, y);
    assert.ok(Math.abs(p.x - sq.cx) <= hw && Math.abs(p.y - sq.cy) <= hh);
  }
});

test('frame cache: another twist re-renders; a pan of a twisted view shifts along the screen', () => {
  const key = frameKey({ scene: {}, selection: new Set(), dpr: 1, pxWidth: 400, pxHeight: 300 });
  const f = { key, view: v90, exact: true };
  assert.equal(framePlan(f, key, { ...v90, rot: 0 }, 'pan').mode, 'full');
  const c = screenToWorld(v90, 200 - 10, 150 - 5); // the view panned by (10, 5) px
  const p = framePlan(f, key, { ...v90, cx: c.x, cy: c.y }, 'pan');
  assert.equal(p.mode, 'shift'); assert.equal(p.dx, 10); assert.equal(p.dy, 5);
  near(p.view.cx, c.x); near(p.view.cy, c.y);
});
