// Layers frozen in one viewport only (Layer panel VP column, VPLAYER): one undo step each; DXF 331 round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { makeViewport } from '../src/core/layouts.js';
import { addLayout, layoutsOf } from '../src/core/layoutmgmt.js';
import { vpFrozen, layoutViewports, matchLayerNames, setVpFreeze, resetVpFreeze } from '../src/core/vpfreeze.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';

/** a drawing with layers A, B, WALL-1, WALL-2 and a layout with two viewports; the session works on the layout space */
function drawing() {
  const doc = newDocument();
  const s = new Session(doc);
  for (const n of ['A', 'B', 'WALL-1', 'WALL-2']) s.transact('layer', (tx) => tx.layer(n, { color: 7 }));
  addLayout(s, 'Layout1');
  const lo = layoutsOf(doc)[0], fit = { minx: 0, miny: 0, maxx: 100, maxy: 100 };
  s.transact('paper', (tx) => tx.set(lo, 'entities', [
    { ...makeViewport({ x: 0, y: 0 }, { x: 100, y: 100 }, fit, 1), paper: true, id: doc.nextId++ },
    { ...makeViewport({ x: 10, y: 10 }, { x: 100, y: 100 }, fit, 2), id: doc.nextId++ },
    { ...makeViewport({ x: 110, y: 10 }, { x: 200, y: 100 }, fit, 3), id: doc.nextId++ },
  ]));
  const space = Object.create(doc, { entities: { value: lo.entities }, modelDoc: { value: doc }, layout: { value: lo } });
  const [v1, v2] = layoutViewports(lo.entities);
  return { s, doc, lo, space, v1, v2 };
}

test('toggle VP freeze on and off in one viewport; the other keeps its list', () => {
  const { s, space, v1, v2 } = drawing();
  assert.equal(layoutViewports(space.entities).length, 2, 'the paper viewport is not a model viewport');
  assert.equal(setVpFreeze(s, [v1], ['B'], true, space), 1);
  assert.deepEqual(v1.frozen, ['B']);
  assert.deepEqual(v2.frozen, []);
  assert.ok(vpFrozen(v1, 'b'), 'layer names compare without case');
  assert.equal(setVpFreeze(s, [v1], ['B'], true, space), 0, 'already frozen: no step');
  assert.equal(setVpFreeze(s, [v1], ['b'], false, space), 1);
  assert.deepEqual(v1.frozen, []);
});

test('a VP freeze toggle is ONE undo step, recorded on the layout space; undo/redo restore the list', () => {
  const { s, space, v1 } = drawing();
  const steps = s.undoStack.length, before = v1.frozen;
  let info = null;
  s.onChange = (i) => { info = i; };
  setVpFreeze(s, [v1], ['A', 'B'], true, space);
  assert.equal(s.undoStack.length, steps + 1);
  assert.equal(s.undoLabel, 'Viewport freeze');
  assert.equal(info.doc, space, 'the step belongs to the layout space');
  assert.equal(s.doc, space.modelDoc, 'the session is pointed back at the doc it showed');
  assert.notEqual(v1.frozen, before, 'a new list (a cached scene keyed by the old one is not reused)');
  s.undo();
  assert.deepEqual(v1.frozen, []);
  assert.equal(info.doc, space);
  s.redo();
  assert.deepEqual(v1.frozen, ['A', 'B']);
});

test('VPLAYER layer list: comma names, * and ? wildcards, no case; plain names that match nothing are reported', () => {
  const { doc } = drawing();
  assert.deepEqual(matchLayerNames(doc, 'wall-*').names, ['WALL-1', 'WALL-2']);
  assert.deepEqual(matchLayerNames(doc, 'A, wall-?').names, ['A', 'WALL-1', 'WALL-2']);
  assert.deepEqual(matchLayerNames(doc, 'B,NOPE,Z*'), { names: ['B'], missing: ['NOPE'] });
  assert.equal(matchLayerNames(doc, '*').names.length, 5);
});

test('VPLAYER Freeze on All viewports vs the Current one; Thaw and Reset; one step each', () => {
  const { s, space, v1, v2 } = drawing();
  const { names } = matchLayerNames(space, 'WALL-*');
  const steps = s.undoStack.length;
  assert.equal(setVpFreeze(s, [v1], names, true, space), 1);
  assert.deepEqual([v1.frozen, v2.frozen], [['WALL-1', 'WALL-2'], []]);
  assert.equal(setVpFreeze(s, layoutViewports(space.entities), names, true, space), 1, 'only v2 still needed it');
  assert.deepEqual(v2.frozen, ['WALL-1', 'WALL-2']);
  assert.equal(setVpFreeze(s, layoutViewports(space.entities), ['WALL-1'], false, space), 2);
  assert.deepEqual([v1.frozen, v2.frozen], [['WALL-2'], ['WALL-2']]);
  assert.equal(resetVpFreeze(s, layoutViewports(space.entities), ['WALL-2'], space), 2);
  assert.deepEqual([v1.frozen, v2.frozen], [[], []]);
  assert.equal(s.undoStack.length, steps + 4);
  s.undo(); s.undo();
  assert.deepEqual([v1.frozen, v2.frozen], [['WALL-1', 'WALL-2'], ['WALL-1', 'WALL-2']], 'the All step undoes both viewports at once');
});

test('DXF: a VP freeze list set through setVpFreeze writes (331) and reads back', () => {
  const { s, space, v1, v2 } = drawing();
  setVpFreeze(s, [v1], ['B', 'WALL-2'], true, space);
  const back = readDxf(new TextEncoder().encode(writeDxf(s.doc)));
  const vps = layoutViewports(layoutsOf(back).find((l) => l.name === 'Layout1').entities);
  assert.equal(vps.length, 2);
  const w1 = vps.find((v) => v.c.x === v1.c.x), w2 = vps.find((v) => v.c.x === v2.c.x);
  assert.deepEqual([...w1.frozen].sort(), ['B', 'WALL-2']);
  assert.deepEqual(w2.frozen, []);
});
