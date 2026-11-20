// Twisted model view, part 2: arc previews (screenAngle), window / crossing selection by the screen rectangle,
// named views keeping their twist, and the twist surviving Save (VPORT *Active 51 / 12 / 22)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/model.js';
import { SpatialIndex, selectInBox, selectInTurnedBox } from '../src/core/pick.js';
import { screenToWorld, worldToScreen, screenAngle } from '../src/core/render.js';
import { viewFromScreen, screenFromView } from '../src/core/views.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { readDxf } from '../src/core/dxfRead.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const P = (x, y) => ({ x, y });
const R45 = Math.PI / 4;

test('screenAngle: a world direction drawn on a twisted screen points where worldToScreen puts it', () => {
  for (const rot of [0, Math.PI / 2, 0.7, -2]) {
    const view = { cx: 3, cy: -1, zoom: 2, width: 300, height: 200, rot }, c = P(5, 4), r = 7;
    for (const a of [0, 1, 2.5, -1]) {
      const s0 = worldToScreen(view, c), s = worldToScreen(view, P(c.x + r * Math.cos(a), c.y + r * Math.sin(a))), sa = screenAngle(view, a);
      near(s.x, s0.x + r * view.zoom * Math.cos(sa)); near(s.y, s0.y + r * view.zoom * Math.sin(sa));
    }
  }
});

test('window / crossing on a twisted view select by the true screen rectangle', () => {
  const doc = M.newDocument();
  const [e1, e2, e3, e4] = [
    M.makeLine(P(0, 0), P(1.3, 0)),     // inside the turned square
    M.makeLine(P(0, 0.5), P(0, 1.2)),   // inside (outside the square's world corners' axis box)
    M.makeLine(P(1.2, 1.2), P(1.3, 1.3)), // outside
    M.makeLine(P(0, 0), P(0, 3)),       // crosses the edge
  ].map((e) => M.addEntity(doc, e));
  const index = new SpatialIndex(doc);
  // the screen square (100,100)-(300,300) of a 45-degree view: in the turned frame it is the box [-1, 1]^2
  const view = { cx: 0, cy: 0, zoom: 100, width: 400, height: 400, rot: R45 }, c = Math.cos(R45), s = Math.sin(R45);
  const T = (p) => P(c * p.x - s * p.y, s * p.x + c * p.y), a = T(screenToWorld(view, 100, 300)), b = T(screenToWorld(view, 300, 100));
  near(a.x, -1); near(a.y, -1); near(b.x, 1); near(b.y, 1);
  const box = { minx: a.x, miny: a.y, maxx: b.x, maxy: b.y }, ids = (l) => [...l].sort();
  assert.deepEqual(ids(selectInTurnedBox(index, box, R45, false)), ids([e1.id, e2.id]));
  assert.deepEqual(ids(selectInTurnedBox(index, box, R45, true)), ids([e1.id, e2.id, e4.id]));
  assert.ok(!selectInTurnedBox(index, box, R45, true).includes(e3.id));
  // no twist: the plain world box, as before
  const wb = { minx: -1, miny: -1, maxx: 1.5, maxy: 1.25 };
  for (const cr of [false, true]) assert.deepEqual(ids(selectInTurnedBox(index, wb, 0, cr)), ids(selectInBox(index, wb, cr)));
});

test('named views: a model view keeps the display twist; restoring turns the view by its own', () => {
  const v = viewFromScreen('A', { cx: 1, cy: 2, zoom: 2, width: 200, height: 100, rot: Math.PI / 2 });
  near(v.twist, 90);
  near(screenFromView(v, 200, 100).rot, Math.PI / 2);
  assert.equal(viewFromScreen('B', { cx: 1, cy: 2, zoom: 2, width: 200, height: 100, rot: 1 }, 'Layout1').twist, 0);
  assert.equal(screenFromView({ ...v, space: 'Layout1' }, 200, 100).rot, 0);
});

test('Save keeps the model view twist: VPORT *Active reads back with the same twist and centre', () => {
  const roundTrip = (setup) => {
    const doc = M.newDocument();
    M.addEntity(doc, M.makeLine(P(10, 20), P(110, 60)));
    setup(doc);
    return readDxf(new TextEncoder().encode(writeDxf(doc))).activeView;
  };
  for (const deg of [30, 90, -135]) {
    const av = roundTrip((d) => { d.viewTwist = deg * Math.PI / 180; });
    near(av.twist, deg * Math.PI / 180); near(av.cx, 60); near(av.cy, 40);
  }
  // the twist the drawing was opened with, when the user did not turn the view
  near(roundTrip((d) => { d.activeView = { cx: 0, cy: 0, height: 10, aspect: 1, twist: 0.5 }; }).twist, 0.5);
  // Plan view (no twist) is saved as no twist
  const plan = roundTrip((d) => { d.activeView = { cx: 0, cy: 0, height: 10, aspect: 1, twist: 0.5 }; d.viewTwist = 0; });
  near(plan.twist, 0); near(plan.cx, 60); near(plan.cy, 40);
});
