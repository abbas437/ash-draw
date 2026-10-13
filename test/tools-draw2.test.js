// POLYGON / SPLINE / DONUT tool state machines driven as the command line drives them (no DOM: a stub viewport).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { Tool, TOOL_ALIASES } from '../renderer/tools.js';
import { createDraw2Tools } from '../renderer/tools-draw2.js';

function rig() {
  const toasts = [];
  const h = { session: new Session(newDocument()), vp: { cursor: { x: 0, y: 0 }, lastPoint: null }, newProps: () => ({ layer: '0' }), toast: (m) => toasts.push(m), setTool: (id) => { h.tool = id; } };
  const tools = createDraw2Tools(h, { Tool });
  const ents = () => h.session.doc.entities;
  // as app.js submit(): empty = Enter, else text() first, else a typed point "x,y"
  const type = (t, s) => {
    if (!s) return t.key({ key: 'Enter' });
    if (t.text(s)) return true;
    const [x, y] = s.split(',').map(Number);
    t.click({ x, y });
  };
  return { h, tools, ents, type, toasts };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('aliases', () => {
  for (const [a, id] of [['pol', 'polygon'], ['polygon', 'polygon'], ['spl', 'spline'], ['spline', 'spline'], ['do', 'donut'], ['donut', 'donut']]) assert.equal(TOOL_ALIASES[a], id);
});

test('POLYGON: sides, centre, I/C, typed or picked radius; defaults remembered; Edge', () => {
  const { tools: { polygon: t }, ents, type, toasts } = rig();
  t.activate();
  assert.match(t.prompt, /number of sides <4>/);
  type(t, '7'); type(t, '0,0');
  assert.match(t.prompt, /Inscribed.*<I>/);
  type(t, 'c'); type(t, '2');
  let e = ents().at(-1);
  assert.equal(e.type, 'LWPOLYLINE'); assert.ok(e.closed); assert.equal(e.vertices.length, 7);
  // circumscribed: edge midpoints at r = 2
  const m = { x: (e.vertices[0].x + e.vertices[1].x) / 2, y: (e.vertices[0].y + e.vertices[1].y) / 2 };
  close(Math.hypot(m.x, m.y), 2);
  // remembered: Enter keeps 7 sides and Circumscribed; a picked radius point
  assert.match(t.prompt, /<7>/);
  type(t, ''); type(t, '10,0'); assert.match(t.prompt, /<C>/); type(t, ''); type(t, '13,0');
  e = ents().at(-1); assert.equal(e.vertices.length, 7);
  close(Math.hypot((e.vertices[0].x + e.vertices[1].x) / 2 - 10, (e.vertices[0].y + e.vertices[1].y) / 2), 3);
  // a typed coordinate is not a number of sides
  assert.equal(t.text('5,0'), false);
  // out of range: refused, still asking
  type(t, '2'); assert.equal(toasts.length, 1); assert.match(t.prompt, /number of sides/);
  // Edge
  type(t, '4'); type(t, 'e'); type(t, '0,0'); type(t, '2,0');
  e = ents().at(-1); assert.equal(e.vertices.length, 4);
  assert.deepEqual(e.vertices.map((v) => [Math.round(v.x), Math.round(v.y)]), [[0, 0], [2, 0], [2, 2], [0, 2]]);
  assert.equal(ents().length, 3);
});

test('SPLINE: fit points, U removes, Enter finishes, C closes, Esc cancels', () => {
  const { h, tools: { spline: t }, ents, type } = rig();
  t.activate();
  type(t, ''); assert.equal(ents().length, 0, 'Enter with no points adds nothing');
  type(t, '0,0'); type(t, '5,5'); type(t, '9,9'); type(t, 'u'); type(t, '10,0'); type(t, '');
  let e = ents().at(-1);
  assert.equal(e.type, 'SPLINE'); assert.equal(e.degree, 3); assert.equal(e.closed, false);
  assert.deepEqual(e.fit.map((p) => [p.x, p.y]), [[0, 0], [5, 5], [10, 0]]);
  assert.ok(e.ctrl.length >= 4 && e.knots.length === e.ctrl.length + 4);
  assert.equal(t.text('c'), false, 'C needs a point first'); // falls through to the CIRCLE alias
  type(t, '0,0'); type(t, '4,0'); assert.equal(t.text('c'), false, 'C needs three points');
  type(t, '2,3'); type(t, 'c');
  e = ents().at(-1); assert.equal(e.closed, true); assert.equal(e.fit.length, 3);
  type(t, '0,0'); type(t, '1,1'); t.key({ key: 'Escape' }); assert.equal(ents().length, 2);
  t.key({ key: 'Escape' }); assert.equal(h.tool, 'select');
});

test('DONUT: diameters remembered, one undo step per centre, Enter exits', () => {
  const { h, tools: { donut: t }, ents, type } = rig();
  t.activate();
  assert.match(t.prompt, /inside diameter <0.5>/);
  type(t, '2'); assert.match(t.prompt, /outside diameter <1>/);
  assert.equal(t.text('5,0'), false);
  type(t, '4');
  type(t, '0,0'); type(t, '10,0');
  assert.equal(ents().length, 2);
  const e = ents()[1];
  assert.equal(e.type, 'LWPOLYLINE'); assert.ok(e.closed); assert.equal(e.width, 1);
  close(e.vertices[0].x, 8.5); close(e.vertices[1].x, 11.5);
  h.session.undo(); assert.equal(ents().length, 1, 'each donut is its own undo step');
  type(t, ''); assert.equal(h.tool, 'select');
  t.activate(); assert.match(t.prompt, /<2>/); type(t, ''); assert.match(t.prompt, /<4>/);
});
