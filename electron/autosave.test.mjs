// Unit tests for the autosave store. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkId, createAutosaveStore } from './autosave.js';

async function withStore(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-autosave-'));
  const dir = path.join(root, 'autosave');
  let t = Date.parse('2026-10-14T10:00:00Z');
  const store = createAutosaveStore({ dir: () => dir, appVersion: '0.2.0', now: () => (t += 1000) });
  try { await fn(store, dir, root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('write / list / read / discard', async () => withStore(async (store, dir) => {
  assert.deepEqual(await store.list(), [], 'no folder yet: nothing to recover');
  await store.write('tab-a1', new Uint8Array([1, 2, 3]), { originalPath: '/w/Plan A.dxf', name: 'Plan A.dxf', format: 'dxf' });
  await store.write('b2', new Uint8Array([9]), { originalPath: null, name: 'Drawing2.dxf', format: 'dwg' });
  const l = await store.list();
  assert.deepEqual(l.map((e) => e.id), ['b2', 'tab-a1'], 'newest first');
  assert.deepEqual(l[1], { id: 'tab-a1', originalPath: '/w/Plan A.dxf', name: 'Plan A.dxf', format: 'dxf', savedAt: '2026-10-14T10:00:01.000Z', appVersion: '0.2.0', size: 3 });
  assert.equal(l[0].originalPath, null);
  assert.equal(l[0].format, 'dwg');
  assert.deepEqual([...await store.read('tab-a1')], [1, 2, 3]);
  // a later write replaces the entry
  await store.write('tab-a1', new Uint8Array([4]), { name: 'Plan A.dxf' });
  assert.deepEqual([...await store.read('tab-a1')], [4]);
  assert.equal(await store.discard('tab-a1'), true);
  assert.equal(await store.discard('tab-a1'), true, 'discarding a missing entry is not an error');
  assert.deepEqual((await store.list()).map((e) => e.id), ['b2']);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['b2.dxf', 'b2.json']);
}));

test('ids: only 1-64 of [a-z0-9-]; paths and anything else are rejected by every method', async () => withStore(async (store, _dir, root) => {
  const bad = ['../x', 'A', '', 'x'.repeat(65), 'a/b', 'a\\b', '..', 'a.b', null, 5, 'tab\0'];
  for (const id of bad) {
    assert.throws(() => checkId(id), TypeError, String(id));
    await assert.rejects(store.write(id, new Uint8Array([1]), {}), TypeError, String(id));
    await assert.rejects(store.read(id), TypeError, String(id));
    await assert.rejects(store.discard(id), TypeError, String(id));
  }
  assert.equal(checkId('x'.repeat(64)), 'x'.repeat(64));
  assert.equal(checkId('0-a'), '0-a');
  assert.deepEqual(await fs.readdir(root), [], 'nothing was written anywhere');
}));

test('atomic: no temp files left; an entry without its .json (interrupted write) or with a bad one is not listed', async () => withStore(async (store, dir) => {
  await store.write('ok', new Uint8Array([1]), { name: 'a.dxf' });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['ok.dxf', 'ok.json']);
  await fs.writeFile(path.join(dir, 'half.dxf'), 'x'); // the .dxf landed, the .json never did
  await fs.writeFile(path.join(dir, 'broken.json'), '{'); await fs.writeFile(path.join(dir, 'broken.dxf'), 'x');
  await fs.writeFile(path.join(dir, 'nodxf.json'), '{}');
  await fs.writeFile(path.join(dir, 'Bad Name.json'), '{}'); await fs.writeFile(path.join(dir, 'Bad Name.dxf'), 'x');
  assert.deepEqual((await store.list()).map((e) => e.id), ['ok']);
  // a write that fails (a folder sits at the .dxf path) leaves the older complete entry and no temp file
  await fs.mkdir(path.join(dir, 'busy.dxf'));
  await assert.rejects(store.write('busy', new Uint8Array([1]), {}));
  assert.ok(!(await fs.readdir(dir)).some((n) => n.endsWith('.tmp')), 'no temp file left');
  assert.ok(!(await fs.readdir(dir)).includes('busy.json'));
}));

test('bytes must be a Uint8Array; meta strings are bounded', async () => withStore(async (store) => {
  await assert.rejects(store.write('a', 'text', {}), TypeError);
  const r = await store.write('a', new Uint8Array(0), { originalPath: 'x'.repeat(2000), name: 7, format: 'svg' });
  assert.equal(r.originalPath, null);
  assert.equal(r.name, 'Drawing.dxf');
  assert.equal(r.format, 'dxf');
}));
