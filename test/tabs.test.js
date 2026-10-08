import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity } from '../src/core/model.js';
import { createDocState, findTabByPath, indexAfterClose, cycleIndex, isBlankTab } from '../renderer/tabs.js';

test('each drawing state has its own document, session and undo stacks', () => {
  const a = createDocState(newDocument(), { path: null, name: 'A.dxf', format: 'dxf' });
  const b = createDocState(newDocument(), { path: null, name: 'B.dxf', format: 'dxf' });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.session, b.session);
  assert.equal(a.session.doc, a.doc);
  b.session.transact('line', (tx) => tx.add({ type: 'LINE', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, layer: '0' }));
  assert.equal(b.session.dirty, true);
  assert.equal(a.session.dirty, false);
  assert.equal(a.session.undo(), false, 'undo in A must not reach B');
  assert.equal(b.doc.entities.length, 1);
  assert.equal(a.state.layer, '0');
  assert.equal(a.view, null);
  assert.deepEqual(a.selection, []);
});

test('findTabByPath matches Windows paths case-insensitively, POSIX exactly', () => {
  const tabs = [createDocState(newDocument(), { path: 'C:\\Work\\Plan.dxf', name: 'Plan.dxf' }), createDocState(newDocument(), { path: '/home/a/B.dxf', name: 'B.dxf' })];
  assert.equal(findTabByPath(tabs, 'c:/work/plan.DXF'), tabs[0]);
  assert.equal(findTabByPath(tabs, '/home/a/B.dxf'), tabs[1]);
  assert.equal(findTabByPath(tabs, '/home/a/b.dxf'), null);
  assert.equal(findTabByPath(tabs, null), null);
});

test('indexAfterClose and cycleIndex', () => {
  assert.equal(indexAfterClose(1, 0, 0), -1);
  assert.equal(indexAfterClose(3, 2, 2), 1); // closing the last, shown tab shows its left neighbour
  assert.equal(indexAfterClose(3, 0, 0), 0); // closing the first, shown tab shows the next one
  assert.equal(indexAfterClose(3, 0, 2), 1); // closing a tab left of the shown one shifts the index
  assert.equal(indexAfterClose(3, 2, 0), 0);
  assert.equal(cycleIndex(3, 2, 1), 0);
  assert.equal(cycleIndex(3, 0, -1), 2);
  assert.equal(cycleIndex(0, 0, 1), -1);
});

test('isBlankTab: only an unchanged, unsaved, empty drawing', () => {
  const t = createDocState(newDocument(), { path: null, name: 'Untitled.dxf' });
  assert.equal(isBlankTab(t), true);
  addEntity(t.doc, { type: 'POINT', p: { x: 0, y: 0 }, layer: '0' });
  assert.equal(isBlankTab(t), false);
  assert.equal(isBlankTab(createDocState(newDocument(), { path: '/x.dxf', name: 'x.dxf' })), false);
});
