import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewHistory, parseZoomInput, listEntity, formatId, setLinetypeScale, entitiesBox } from '../src/core/cmdline.js';
import { newDocument, makeLine, makeCircle, makePolyline } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';

const v = (cx, cy, zoom) => ({ cx, cy, zoom });

test('ViewHistory: one entry per gesture, Previous returns the exact earlier views in order', () => {
  const h = new ViewHistory();
  h.observe('m', v(0, 0, 1), 0);
  h.observe('m', v(1, 0, 1.25), 1000); // wheel gesture: three steps 30 ms apart
  h.observe('m', v(2, 0, 1.5), 1030);
  h.observe('m', v(3, 0, 2), 1060);
  assert.equal(h.size('m'), 1);
  h.breakGesture('m'); h.observe('m', v(9, 9, 4), 1100); // a zoom command right after: its own entry
  assert.equal(h.size('m'), 2);
  assert.deepEqual(h.previous('m'), v(3, 0, 2));
  assert.deepEqual(h.previous('m'), v(0, 0, 1));
  assert.equal(h.previous('m'), null);
});

test('ViewHistory: per-space stacks, a limit of 10, restore does not push', () => {
  const h = new ViewHistory();
  for (let i = 0; i < 15; i++) h.observe('a', v(i, 0, 1), i * 1000);
  h.observe('b', v(0, 0, 1), 0);
  assert.equal(h.size('a'), 10); assert.equal(h.size('b'), 0);
  const p = h.previous('a', 20000);
  h.observe('a', p, 20000); // the shown view echoes back
  assert.equal(h.size('a'), 9);
});

test('parseZoomInput: options and nX / nXP', () => {
  assert.deepEqual(parseZoomInput('E'), { opt: 'extents' });
  assert.deepEqual(parseZoomInput('all'), { opt: 'all' });
  assert.deepEqual(parseZoomInput('p'), { opt: 'previous' });
  assert.deepEqual(parseZoomInput('2x'), { scale: 2, paper: false });
  assert.deepEqual(parseZoomInput('0,5X'), { scale: 0.5, paper: false });
  assert.deepEqual(parseZoomInput('2xp'), { scale: 2, paper: true });
  assert.equal(parseZoomInput('2'), null);
  assert.equal(parseZoomInput('0x'), null);
});

test('listEntity: line, circle and polyline geometry in drawing units and precision', () => {
  const doc = newDocument();
  const l = listEntity({ ...makeLine({ x: 0, y: 0 }, { x: 30, y: 40 }), id: 42 }, doc, { prec: 2, units: 4 });
  assert.match(l, /^LINE/); assert.match(l, /Length = 50 mm/); assert.match(l, /Handle = 2A/); assert.match(l, /Angle in XY plane = 53\.1301°/);
  const c = listEntity(makeCircle({ x: 1, y: 2 }, 2.5), doc, { prec: 2, units: 6 });
  assert.match(c, /radius 2\.5 m/); assert.match(c, /circumference 15\.71 m/); assert.match(c, /area 19\.63 m²/);
  const p = listEntity(makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }], false), doc, { prec: 4, units: 0 });
  assert.match(p, /Open,  3 vertices/); assert.match(p, /length 15\n/);
  const q = listEntity(makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }], true), doc, {});
  assert.match(q, /length 30/); assert.match(q, /area 50/);
  assert.equal(formatId({ x: 1.23456, y: -2 }, 2), 'X = 1.23   Y = -2');
  assert.deepEqual(entitiesBox([makeLine({ x: 0, y: 0 }, { x: 3, y: 1 }), makeCircle({ x: 5, y: 5 }, 1)], doc), { minx: 0, miny: 0, maxx: 6, maxy: 6 });
});

test('setLinetypeScale: one undo step that rebuilds the scene', () => {
  const doc = newDocument();
  const s = new Session(doc);
  const seen = [];
  s.onChange = (i) => seen.push(i.structure);
  assert.equal(setLinetypeScale(s, 2.5), true);
  assert.equal(doc.header.ltscale, 2.5);
  assert.equal(setLinetypeScale(s, 2.5), false);
  s.undo();
  assert.equal(doc.header.ltscale || 1, 1);
  assert.deepEqual(seen, [true, true]);
});
