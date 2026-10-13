import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, recordViewportView, viewportView } from '../src/core/edit.js';
import { newDocument } from '../src/core/model.js';
import { newLayout } from '../src/core/layouts.js';

// a layout viewport whose view a zoom/pan in MSPACE changes in place, then the view session ends
function setup() {
  const doc = newDocument(), lay = newLayout('Layout1', 1);
  const v = { type: 'VIEWPORT', id: 7, vpId: 2, on: true, c: { x: 200, y: 150 }, width: 200, height: 100, viewCenter: { x: 1000, y: 500 }, viewHeight: 5000, twist: 0 };
  lay.entities.push(v);
  doc.layouts = [lay];
  const paper = Object.create(doc, { entities: { get: () => lay.entities } });
  return { s: new Session(doc), v, paper };
}
const viewOf = (v) => [v.viewCenter.x, v.viewCenter.y, v.viewHeight];

test('viewport view change in MSPACE: one undo step; undo restores the first view, redo the last; same entity object', () => {
  const { s, v, paper } = setup();
  const start = viewportView(v);
  Object.assign(v, { viewCenter: { x: 1200, y: 450 }, viewHeight: 2500 }); // zoom
  Object.assign(v, { viewCenter: { x: 1300, y: 400 }, viewHeight: 2000 }); // and pan/zoom again
  s.viewPending = true;
  assert.equal(s.dirty, true, 'a pending view change marks the drawing changed');
  const events = [];
  s.onChange = (info) => events.push(info);
  assert.equal(recordViewportView(s, v, start, paper), true);
  assert.equal(s.viewPending, false);
  assert.equal(s.undoStack.length, 1, 'one step for the whole view session');
  assert.equal(s.undoLabel, 'Viewport view');
  assert.notEqual(s.doc, paper);
  assert.equal(s.doc.layouts[0].entities[0], v, 'session doc is still the model doc');
  assert.equal(events[0].doc, paper, 'the step belongs to the layout space');
  assert.equal(events[0].structure, false, 'no scene rebuild for a view change');
  assert.deepEqual(viewOf(v), [1300, 400, 2000]);
  assert.ok(s.undo());
  assert.deepEqual(viewOf(v), [1000, 500, 5000], 'undo restores the view at the start of the session');
  assert.equal(paper.entities[0], v, 'viewport entity keeps its identity');
  assert.equal(s.dirty, false, 'undone back to the saved state: clean');
  assert.ok(s.redo());
  assert.deepEqual(viewOf(v), [1300, 400, 2000], 'redo changes it again');
  assert.equal(s.dirty, true);
});

test('viewport view back where it started: no undo step, not dirty', () => {
  const { s, v, paper } = setup();
  const start = viewportView(v);
  Object.assign(v, { viewHeight: 2500 });
  Object.assign(v, { viewHeight: 5000 });
  s.viewPending = true;
  assert.equal(recordViewportView(s, v, start, paper), false);
  assert.equal(s.undoStack.length, 0);
  assert.equal(s.dirty, false);
});

test('save after a recorded view step, then undo: dirty; redo back to the saved step: clean', () => {
  const { s, v, paper } = setup();
  const start = viewportView(v);
  Object.assign(v, { viewHeight: 1000 });
  recordViewportView(s, v, start, paper);
  s.markSaved();
  assert.equal(s.dirty, false);
  s.undo();
  assert.equal(v.viewHeight, 5000);
  assert.equal(s.dirty, true);
  s.redo();
  assert.equal(v.viewHeight, 1000);
  assert.equal(s.dirty, false);
});
