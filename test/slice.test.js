import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fixture, FIX } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { buildScene, buildSceneSteps } from '../src/core/render.js';
import { SpatialIndex } from '../src/core/pick.js';
import { runSliced, drain } from '../src/core/slice.js';
import { mixedDoc } from './ref/mixedDoc.js';
import { postDocInBatches, docAssembler } from '../src/core/docBatches.js';

const docs = () => [
  ...readdirSync(FIX).filter((f) => f.endsWith('.dxf') && f !== 'binary_sentinel.dxf').map((f) => [f, readDxf(fixture(f))]),
  ['mixedDoc', mixedDoc()],
];
const indexShape = (ix) => ({
  grid: [ix._ox, ix._oy, ix._cell, ix._cols, ix._rows],
  entries: [...ix._entries].map(([id, en]) => [id, en.box, en.reach, en.order, en.cells]),
  cells: Array.from(ix._grid, (l) => (l ? l.map((en) => en.e.id) : null)),
  oversize: ix._oversize.map((en) => en.e.id),
});

test('time-sliced buildScene gives the same scene as buildScene (every fixture, a yield after each entity)', async () => {
  for (const [name, doc] of docs()) {
    let slices = 0;
    const a = buildScene(doc), b = await runSliced(buildSceneSteps(doc), { budgetMs: 0, onProgress: () => slices++ });
    assert.deepEqual(b.items, a.items, name);
    assert.deepEqual([...b.byId.keys()], [...a.byId.keys()], name);
    for (const [id, list] of b.byId) assert.deepEqual(list.map((it) => it.pos), a.byId.get(id).map((it) => it.pos), name);
    assert.deepEqual(b.items.map((it) => it.pos), a.items.map((_, i) => i), name);
    assert.deepEqual([...b.entIndex], [...a.entIndex], name);
    assert.deepEqual(b.bbox, a.bbox, name);
    assert.equal(slices, doc.entities.length, `${name}: one slice per entity`);
  }
});

test('time-sliced SpatialIndex rebuild gives the same index as the synchronous one', async () => {
  for (const [name, doc] of docs()) {
    const a = new SpatialIndex(doc), b = new SpatialIndex(doc, { deferred: true });
    await runSliced(b.rebuildSteps(), { budgetMs: 0 });
    assert.deepEqual(indexShape(b), indexShape(a), name);
    const c = new SpatialIndex(doc, { deferred: true }); drain(c.rebuildSteps());
    assert.deepEqual(indexShape(c), indexShape(a), name);
  }
});

test('runSliced: progress rises to the end, an aborted signal rejects with CANCELLED and stops the steps', async () => {
  const doc = readDxf(fixture('big_grid_r2000.dxf'));
  const seen = [];
  await runSliced(buildSceneSteps(doc), { budgetMs: 0, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length > 10 && seen.every((f, i) => f > 0 && f <= 1 && (i === 0 || f > seen[i - 1])));
  const ac = new AbortController();
  let n = 0;
  const run = runSliced(buildSceneSteps(doc), { budgetMs: 0, signal: ac.signal, onProgress: () => { if (++n === 3) ac.abort(); } });
  await assert.rejects(run, (e) => e.code === 'CANCELLED');
  assert.equal(n, 3, 'no slice runs after the abort');
});

test('batched doc hand-off: the pieces, each structured-cloned on its own, reassemble into the same document', () => {
  for (const [name, doc] of docs()) {
    const asm = docAssembler();
    let n = 0;
    postDocInBatches(doc, (m) => { n++; if (!m.done) assert.ok(asm.accept(structuredClone(m)), name); }, { first: 3, targetMs: 0 });
    assert.equal(asm.fraction, 1, name);
    assert.deepEqual(asm.doc, structuredClone(doc), name);
    if (doc.entities.length > 3) assert.ok(n > 3, `${name}: sent in several batches`);
  }
});
