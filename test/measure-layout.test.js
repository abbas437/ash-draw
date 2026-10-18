// MEASUREGEOM on a layout: points picked on the sheet inside one model viewport report the model value first and the
// sheet value second; elsewhere (outside viewports, across two, Model, MSPACE) the plain value as before. No DOM: the
// tool runs on a stub viewport and its results are read from result() instead of the docked panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, makeCircle } from '../src/core/model.js';
import { makeViewport, paperToModel } from '../src/core/layouts.js';
import { MeasureGeomTool } from '../renderer/tools-measure.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

/** a layout (mm paper) with the overall paper viewport and two model viewports: A at 1:50 (twist optional), B at 1:10 */
function rig({ twist = 0, mspace = false, model = false } = {}) {
  const doc = newDocument();
  doc.units = 4; doc.header = { ...doc.header, luprec: 2 };
  const paper = { ...makeViewport({ x: 0, y: 0 }, { x: 420, y: 297 }, null, 1), paper: true };
  const A = { ...makeViewport({ x: 10, y: 10 }, { x: 210, y: 210 }, null, 2), viewCenter: { x: 5000, y: 3000 }, viewHeight: 200 * 50, twist };
  const B = { ...makeViewport({ x: 250, y: 10 }, { x: 400, y: 160 }, null, 3), viewCenter: { x: 0, y: 0 }, viewHeight: 150 * 10 };
  doc.entities.push(paper, A, B);
  const layout = { name: 'Layout1', entities: doc.entities, plot: { units: 1, scaleNum: 1, scaleDen: 1 } };
  const vp = { doc, layout: model ? null : layout, mspace: mspace ? { vp: A } : null, lastPoint: null, cursor: { x: 0, y: 0 }, requestRender() {}, pick: () => null };
  const out = [];
  const t = new MeasureGeomTool({ vp, fileDoc: doc, setTool() {} });
  t.result = (title, lines, label) => out.push({ title, lines: lines(), label: label?.() });
  t.activate();
  return { t, vp, A, B, out };
}
const measure = (t, a, b) => { t.click(a); t.click(b); };

test('distance inside one 1:50 viewport: model distance first, sheet second, model deltas', () => {
  const { t, out } = rig();
  measure(t, { x: 50, y: 50 }, { x: 66.2144, y: 50 });
  const [r] = out;
  assert.equal(r.lines[0], 'Distance = 810.72 mm  (sheet 16.21 mm, viewport 1:50)');
  assert.equal(r.lines[1], 'Delta X = 810.72 mm, Delta Y = 0 mm');
  assert.equal(r.label, '810.72 mm');
});

test('distance through a twisted viewport uses paperToModel of each point (model deltas and angle follow the twist)', () => {
  const { t, A, out } = rig({ twist: Math.PI / 2 });
  const a = { x: 60, y: 60 }, b = { x: 70, y: 60 };
  measure(t, a, b);
  const pa = paperToModel(A, a), pb = paperToModel(A, b);
  close(Math.hypot(pb.x - pa.x, pb.y - pa.y), 500, 'model distance');
  assert.equal(out[0].lines[0], 'Distance = 500 mm  (sheet 10 mm, viewport 1:50)');
  assert.equal(out[0].lines[1], 'Delta X = 0 mm, Delta Y = -500 mm');
  assert.equal(out[0].lines[2], 'Angle in XY plane = 270°');
});

test('points in two viewports, or outside any model viewport: the sheet value only, as before', () => {
  const { t, out } = rig();
  measure(t, { x: 50, y: 50 }, { x: 300, y: 50 }); // A to B
  measure(t, { x: 50, y: 250 }, { x: 60, y: 250 }); // both on the paper viewport only
  assert.equal(out[0].lines[0], 'Distance = 250 mm');
  assert.equal(out[1].lines[0], 'Distance = 10 mm');
  assert.equal(out[1].label, '10 mm');
});

test('the other viewport converts by its own scale (1:10)', () => {
  const { t, out } = rig();
  measure(t, { x: 300, y: 50 }, { x: 300, y: 53 });
  assert.equal(out[0].lines[0], 'Distance = 30 mm  (sheet 3 mm, viewport 1:10)');
});

test('Model and MSPACE: points are model coordinates, no conversion', () => {
  for (const o of [{ model: true }, { mspace: true }]) {
    const { t, out } = rig(o);
    measure(t, { x: 50, y: 50 }, { x: 60, y: 50 });
    assert.equal(out[0].lines[0], 'Distance = 10 mm', JSON.stringify(o));
  }
});

test('area by points inside a 1:50 viewport: area x scale², perimeter x scale; a running total stays model', () => {
  const { t, out } = rig();
  t.setMode('area');
  t.text('a');
  for (const p of [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }]) t.click(p);
  t.text('c');
  assert.deepEqual(out.at(-1).lines, ['Area = 250000 mm²  (sheet 100 mm², viewport 1:50)', 'Perimeter = 2618.03 mm  (sheet 52.36 mm, viewport 1:50)',
    'Total area = 250000 mm²  (sheet 100 mm², viewport 1:50)']);
  // a second area outside the viewport: the total mixes bases, so it falls back to the sheet total
  for (const p of [{ x: 20, y: 250 }, { x: 30, y: 250 }, { x: 30, y: 260 }]) t.click(p);
  t.text('c');
  assert.deepEqual(out.at(-1).lines, ['Area = 50 mm², Perimeter = 34.14 mm', 'Total area = 150 mm²']);
});

test('radius of a sheet circle inside a 1:50 viewport: model radius / diameter first', () => {
  const { t, vp, out } = rig();
  const c = makeCircle({ x: 100, y: 100 }, 4);
  vp.pick = () => c;
  t.setMode('radius');
  t.click({ x: 104, y: 100 });
  assert.deepEqual(out[0].lines, ['Radius = 200 mm  (sheet 4 mm, viewport 1:50)', 'Diameter = 400 mm  (sheet 8 mm, viewport 1:50)']);
});
