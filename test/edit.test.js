import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newDocument, makeLine, makeCircle, makeArc, makeRect, makeText, makeInsert, addBlock, addEntity, getEntity,
} from '../src/core/model.js';
import {
  Session, transformEntities, addEntities, eraseEntities, moveEntities, rotateEntities, scaleEntities, mirrorEntities, explodeEntities,
  offsetCommand, trimCommand, extendCommand, setEntityProps, setLayerProps, deleteLayer, setText, copyToClipboard, pasteEntities,
} from '../src/core/edit.js';

const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) < t, `${a} !~ ${b}`);

function session() {
  const doc = newDocument();
  return new Session(doc);
}

test('add / undo / redo keeps ids and order', () => {
  const s = session();
  const [a] = addEntities(s, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  const [b] = addEntities(s, [makeLine({ x: 0, y: 1 }, { x: 1, y: 1 })]);
  assert.deepEqual(s.doc.entities.map((e) => e.id), [a.id, b.id]);
  assert.ok(s.dirty);
  s.undo();
  assert.deepEqual(s.doc.entities.map((e) => e.id), [a.id]);
  s.undo();
  assert.equal(s.doc.entities.length, 0);
  assert.equal(s.dirty, false);
  s.redo(); s.redo();
  assert.deepEqual(s.doc.entities.map((e) => e.id), [a.id, b.id]);
});

test('erase restores at the original position on undo', () => {
  const s = session();
  const es = addEntities(s, [0, 1, 2].map((i) => makeLine({ x: i, y: 0 }, { x: i, y: 1 })));
  eraseEntities(s, [es[1].id]);
  assert.equal(s.doc.entities.length, 2);
  s.undo();
  assert.deepEqual(s.doc.entities.map((e) => e.id), es.map((e) => e.id));
});

test('move, copy, rotate, scale', () => {
  const s = session();
  const [l] = addEntities(s, [makeLine({ x: 0, y: 0 }, { x: 10, y: 0 })]);
  moveEntities(s, [l.id], 5, 5);
  assert.deepEqual(getEntity(s.doc, l.id).p1, { x: 5, y: 5 });
  const r = moveEntities(s, [l.id], 1, 0, { copy: true });
  assert.equal(s.doc.entities.length, 2);
  assert.equal(r.created.length, 1);
  assert.notEqual(r.created[0].id, l.id);
  rotateEntities(s, [l.id], { x: 5, y: 5 }, Math.PI / 2);
  near(getEntity(s.doc, l.id).p2.x, 5); near(getEntity(s.doc, l.id).p2.y, 15);
  scaleEntities(s, [l.id], { x: 5, y: 5 }, 2);
  near(getEntity(s.doc, l.id).p2.y, 25);
  s.undo(); s.undo(); s.undo(); s.undo();
  assert.deepEqual(getEntity(s.doc, l.id).p2, { x: 10, y: 0 });
});

test('mirror about the Y axis, source kept or deleted', () => {
  const s = session();
  const [c] = addEntities(s, [makeArc({ x: 5, y: 0 }, 2, 0, 90)]);
  mirrorEntities(s, [c.id], { x: 0, y: 0 }, { x: 0, y: 1 });
  assert.equal(s.doc.entities.length, 2);
  const m = s.doc.entities[1];
  near(m.c.x, -5);
  // 0..90 deg arc mirrored about the Y axis becomes 90..180 deg
  near(((m.a0 % 360) + 360) % 360, 90); near(((m.a1 % 360) + 360) % 360, 180);
  mirrorEntities(s, [c.id], { x: 0, y: 0 }, { x: 0, y: 1 }, { deleteSource: true });
  assert.equal(s.doc.entities.length, 2);
});

test('a shear that cannot be represented is reported and leaves the entity alone', () => {
  const s = session();
  addBlock(s.doc, 'B', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  const [t] = addEntities(s, [makeInsert('B', { x: 1, y: 1 })]);
  const r = transformEntities(s, [t.id], [1, 0, 0.5, 1, 0, 0]);
  assert.equal(r.done, 0);
  assert.equal(r.failed[0].reason, 'SHEAR');
  assert.deepEqual(getEntity(s.doc, t.id).p, { x: 1, y: 1 });
  assert.equal(s.undoStack.length, 1); // only the add: the failed transform recorded nothing
  // a circle under non-uniform scale becomes an ellipse
  const [c] = addEntities(s, [makeCircle({ x: 0, y: 0 }, 1)]);
  const r2 = transformEntities(s, [c.id], [2, 0, 0, 1, 0, 0]);
  assert.equal(r2.done, 1);
  assert.equal(getEntity(s.doc, c.id).type, 'ELLIPSE');
});
test('explode a polyline and an insert', () => {
  const s = session();
  addBlock(s.doc, 'B1', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }), makeCircle({ x: 0, y: 0 }, 0.5)]);
  const [r] = addEntities(s, [makeRect({ x: 0, y: 0 }, { x: 2, y: 1 })]);
  const [ins] = addEntities(s, [makeInsert('B1', { x: 10, y: 10 }, { layer: 'L1', sx: 2, sy: 2 })]);
  const a = explodeEntities(s, [r.id]);
  assert.equal(a.created.length, 4);
  const b = explodeEntities(s, [ins.id]);
  assert.equal(b.created.length, 2);
  assert.ok(b.created.every((e) => e.layer === 'L1'));
  assert.equal(s.doc.entities.length, 6);
  s.undo();
  assert.equal(s.doc.entities.length, 5);
  assert.equal(explodeEntities(s, [a.created[0].id, 9999]).failed.length, 1);
});

test('offset, trim, extend', () => {
  const s = session();
  const [l] = addEntities(s, [makeLine({ x: 0, y: 0 }, { x: 10, y: 0 })]);
  const o = offsetCommand(s, l.id, 2, { x: 5, y: 5 });
  assert.equal(o.done, 1);
  near(o.created[0].p1.y, 2);
  const [cut] = addEntities(s, [makeLine({ x: 5, y: -5 }, { x: 5, y: 5 })]);
  const t = trimCommand(s, l.id, [cut.id], { x: 8, y: 0 });
  assert.equal(t.done, 1);
  near(getEntity(s.doc, l.id).p2.x, 5);
  const [short] = addEntities(s, [makeLine({ x: 0, y: 3 }, { x: 2, y: 3 })]);
  const e = extendCommand(s, short.id, [cut.id], { x: 2, y: 3 });
  assert.equal(e.done, 1);
  near(getEntity(s.doc, short.id).p2.x, 5);
  const bad = trimCommand(s, l.id, [], { x: 1, y: 0 });
  assert.equal(bad.done, 0);
});

test('properties, layers, text', () => {
  const s = session();
  const [l] = addEntities(s, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 })]);
  setEntityProps(s, [l.id], { layer: 'WALLS', color: 1 });
  assert.equal(getEntity(s.doc, l.id).layer, 'WALLS');
  assert.ok(s.doc.layers.has('WALLS'));
  assert.equal(deleteLayer(s, 'WALLS'), false); // still used
  assert.equal(deleteLayer(s, '0'), false);
  s.undo();
  assert.equal(s.doc.layers.has('WALLS'), false);
  s.redo();
  setLayerProps(s, 'WALLS', { visible: false });
  assert.equal(s.doc.layers.get('WALLS').visible, false);
  s.undo();
  assert.equal(s.doc.layers.get('WALLS').visible, true);
  const [t] = addEntities(s, [makeText({ x: 0, y: 0 }, 2, 'hi')]);
  assert.ok(setText(s, t.id, { text: 'bye', height: 3 }));
  assert.equal(getEntity(s.doc, t.id).text, 'bye');
  assert.equal(setText(s, l.id, { text: 'x' }), false);
});

test('clipboard and onChange', () => {
  const s = session();
  const seen = [];
  s.onChange = (i) => seen.push(i.kind);
  const [l] = addEntities(s, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  const clip = copyToClipboard(s.doc, [l.id]);
  const made = pasteEntities(s, clip, 10, 0);
  assert.equal(made.length, 1);
  assert.equal(made[0].p1.x, 10);
  s.undo();
  assert.deepEqual(seen, ['do', 'do', 'undo']);
});

test('a failing transaction rolls back', () => {
  const s = session();
  assert.throws(() => s.transact('boom', (tx) => { tx.add(makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })); throw new Error('x'); }));
  assert.equal(s.doc.entities.length, 0);
  assert.equal(s.undoStack.length, 0);
});

test('addEntity via model then Session undo does not touch unrelated entities', () => {
  const s = session();
  addEntity(s.doc, makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }));
  addEntities(s, [makeLine({ x: 0, y: 1 }, { x: 1, y: 1 })]);
  s.undo();
  assert.equal(s.doc.entities.length, 1);
});
