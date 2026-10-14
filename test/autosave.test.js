import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, makeLine } from '../src/core/model.js';
import { createDocState, withoutRecovered } from '../renderer/tabs.js';
import { dueTabs, sessionSignature, recoveredName, recoveryFile, shouldDiscardAutosave, newAutosaveId, autosaveMinutesFrom, AUTOSAVE_CHOICES } from '../src/core/autosave.js';
import { loadDrawing, dxfBytesOf } from '../renderer/files.js';
import { initAutosave } from '../renderer/autosave.js';

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
  // the copy is DXF: a drawing opened from DWG is recovered under a .dxf name (the original name stays in recoveredFrom)
  assert.equal(recoveredName('C:\\w\\Plan.v2.dwg'), 'Plan.v2 (recovered).dxf');
  assert.equal(recoveredName('PLAN.DWG'), 'PLAN (recovered).dxf');
  assert.equal(recoveredName('noext'), 'noext (recovered).dxf');
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

test('a dwg-format autosave entry is recovered through the loading path as DXF (no DWG conversion)', async () => {
  const doc = newDocument();
  doc.entities.push(makeLine({ x: 0, y: 0 }, { x: 5, y: 7 }, { layer: '0' }));
  const bytes = dxfBytesOf(doc); // what the autosave store holds: DXF, also for a drawing opened from DWG
  const entry = { id: 'tab-abc', name: 'Plan.dwg', originalPath: 'C:\\w\\Plan.dwg', format: 'dwg' };
  const f = recoveryFile(entry, bytes);
  assert.deepEqual([f.path, f.name], [null, 'Plan (recovered).dxf']);
  const converted = [];
  const api = {
    isElectron: true,
    dwgAvailable: async () => ({ available: true }),
    dwgOpen: async (src) => { converted.push(src); throw new Error('This DWG file could not be converted'); },
    dwgToDxf: async (src) => { converted.push(src); throw new Error('This DWG file could not be converted'); },
  };
  const r = await loadDrawing(api, f.name, f.bytes, { path: f.path });
  assert.equal(r.format, 'dxf');
  assert.equal(converted.length, 0, 'the DXF bytes are not sent to the DWG converter');
  assert.equal(r.doc.entities.length, 1);
});

test('shouldDiscardAutosave: the copy goes after "Don\'t save" or a save that left the drawing saved, never while it is unsaved', () => {
  assert.equal(shouldDiscardAutosave({ choice: 'dont-save', dirtyAfter: true }), true);
  assert.equal(shouldDiscardAutosave({ choice: 'save', dirtyAfter: false }), true);
  assert.equal(shouldDiscardAutosave({ choice: 'clean', dirtyAfter: false }), true);
  // Save -> a DWG that differs from the drawing ("DWG saved - please check"): the tab stays unsaved, the copy stays
  assert.equal(shouldDiscardAutosave({ choice: 'save', dirtyAfter: true }), false);
});

// a fake main-process store whose writes land only when the test lets them (an autosave in flight)
function fakeStore() {
  const entries = new Map();
  const pending = [];
  const api = {
    autosaveWrite: (id, bytes) => new Promise((resolve) => pending.push(() => { entries.set(id, bytes); resolve({ id }); })),
    autosaveDiscard: async (id) => { entries.delete(id); return true; },
    settingsGet: () => new Promise(() => {}), // never loads: the default interval stays
    settingsSet: async () => {},
  };
  return { api, entries, pending };
}
const until = async (cond) => { for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1)); assert.ok(cond(), 'timed out'); };

test('autosave: a copy being written when the drawing is closed with "Don\'t save" is removed after the write lands', async () => {
  const { api, entries, pending } = fakeStore();
  globalThis.window = { api };
  try {
    const t = tab('a.dxf');
    t.session.transact('line', (tx) => tx.add(makeLine({ x: 0, y: 0 }, { x: 1, y: 2 }, { layer: '0' }))); // a writable edit
    const app = { tabs: [t] };
    const as = initAutosave(app);
    assert.equal(as.minutes, 10, 'the default interval until the saved setting has loaded');
    const run = as.now();
    await until(() => pending.length === 1); // the write is in flight in main
    // closeAll: "Don't save" leaves the tab open and dirty until the window closes; its copy is discarded
    as.stop();
    const gone = as.discard(t);
    pending.shift()(); // the write lands after the discard was asked for
    await Promise.all([run, gone]);
    assert.equal(entries.size, 0, 'no stale copy is offered at the next start');
    assert.equal(await as.now(), 0, 'stopped: nothing more is written');
  } finally { delete globalThis.window; }
});
