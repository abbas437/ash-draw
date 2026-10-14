import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument } from '../src/core/model.js';
import { createDocState, withoutRecovered } from '../renderer/tabs.js';
import { dueTabs, sessionSignature, recoveredName, newAutosaveId, autosaveMinutesFrom, AUTOSAVE_CHOICES } from '../src/core/autosave.js';

const tab = (name, path = null) => createDocState(newDocument(), { path, name, format: 'dxf' });
const edit = (t) => t.session.transact('line', (tx) => tx.add({ type: 'LINE', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, layer: '0' }));

test('dueTabs: dirty tabs that are not saving, not autosaving and changed since their last autosave', () => {
  const [a, b, c, d] = [tab('a.dxf'), tab('b.dxf'), tab('c.dxf'), tab('d.dxf')];
  edit(a); edit(b); edit(c);
  b.saving = { step: 1 };
  const busy = new Set([c]);
  assert.deepEqual(dueTabs([a, b, c, d], busy), [a], 'b saving, c autosaving, d clean');
  a.autosavedSig = sessionSignature(a.session);
  assert.deepEqual(dueTabs([a]), [], 'unchanged since its autosave');
  edit(a);
  assert.deepEqual(dueTabs([a]), [a], 'a new edit makes it due again');
  a.autosavedSig = sessionSignature(a.session);
  a.session.undo();
  assert.deepEqual(dueTabs([a]), [a], 'undo changes the signature (still dirty: one edit left)');
  a.session.undo();
  assert.deepEqual(dueTabs([a]), [], 'back to the saved state: not dirty, nothing to autosave');
});

test('sessionSignature changes on edit, undo and redo', () => {
  const t = tab('a.dxf');
  const s0 = sessionSignature(t.session);
  edit(t); const s1 = sessionSignature(t.session);
  t.session.undo(); const s2 = sessionSignature(t.session);
  t.session.redo(); const s3 = sessionSignature(t.session);
  assert.equal(new Set([s0, s1, s2]).size, 3);
  assert.equal(s3, s1);
  assert.equal(s2, '0:1');
});

test('recoveredName and the recovered tab stays dirty after undoing everything (markSaved(-1))', () => {
  assert.equal(recoveredName('Plan A.dxf'), 'Plan A (recovered).dxf');
  assert.equal(recoveredName('C:\\w\\Plan.v2.dwg'), 'Plan.v2 (recovered).dwg');
  assert.equal(recoveredName('noext'), 'noext (recovered)');
  assert.equal(recoveredName(''), 'Drawing (recovered).dxf');
  const t = tab('x.dxf');
  t.session.markSaved(-1);
  assert.equal(t.session.dirty, true);
  edit(t); t.session.undo();
  assert.equal(t.session.dirty, true);
});

test('newAutosaveId matches the store id rule; autosaveMinutesFrom defaults to 10', () => {
  for (let i = 0; i < 50; i++) assert.match(newAutosaveId(), /^tab-[a-z0-9]{12}$/);
  assert.equal(newAutosaveId(() => 0.9999999), 'tab-999999999999');
  assert.notEqual(newAutosaveId(), newAutosaveId());
  assert.deepEqual(AUTOSAVE_CHOICES, [0, 5, 10, 20, 30]);
  assert.equal(autosaveMinutesFrom(undefined), 10);
  assert.equal(autosaveMinutesFrom(7), 10);
  assert.equal(autosaveMinutesFrom('5'), 10);
  assert.equal(autosaveMinutesFrom(0), 0);
  assert.equal(autosaveMinutesFrom(30), 30);
});

test('withoutRecovered: session files already open as recovered drawings are skipped (Windows paths case-insensitive)', () => {
  const r = tab('Plan (recovered).dxf');
  r.recoveredFrom = { path: 'C:\\Work\\Plan.dxf', name: 'Plan.dxf' };
  const u = tab('Drawing2 (recovered).dxf'); u.recoveredFrom = { path: null, name: 'Drawing2.dxf' };
  const files = [{ path: 'c:/work/PLAN.dxf', name: 'PLAN.dxf' }, { path: 'C:\\Work\\Other.dxf', name: 'Other.dxf' }];
  assert.deepEqual(withoutRecovered(files, [r, u, tab('x.dxf', '/x.dxf')]).map((f) => f.name), ['Other.dxf']);
  assert.deepEqual(withoutRecovered(files, []), files);
});
