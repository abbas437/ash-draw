import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fixture, FIX } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { buildScene, buildSceneSteps, updateScene } from '../src/core/render.js';
import { newDocument, addEntity, makeLine, makeInsert, makeCircle, makeText } from '../src/core/model.js';
import { bboxOf } from '../src/core/geom.js';
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

// one top-level INSERT (rotated, scaled, on layer 0 content) of a block of 10,000 entities with a nested INSERT
function bigInsertDoc() {
  const doc = newDocument();
  doc.blocks.set('SMALL', { name: 'SMALL', base: { x: 0, y: 0 }, entities: [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }), makeCircle({ x: 0, y: 0 }, 0.5)] });
  const ents = [];
  for (let i = 0; i < 10000; i++) {
    const k = i % 4, x = i % 100, y = Math.floor(i / 100);
    ents.push(k === 0 ? makeLine({ x, y }, { x: x + 0.7, y: y + 0.3 }, { color: 1 + (i % 7) })
      : k === 1 ? makeCircle({ x, y }, 0.2) : k === 2 ? makeText({ x, y }, 0.25, `T${i}`) : makeInsert('SMALL', { x, y }, { sx: 0.3, sy: 0.3, rot: 0 }));
  }
  for (const e of ents) e.id = 0;
  doc.blocks.set('BIG', { name: 'BIG', base: { x: 5, y: 5 }, entities: ents });
  addEntity(doc, makeLine({ x: -10, y: -10 }, { x: -5, y: -5 }));
  addEntity(doc, makeInsert('BIG', { x: 1000, y: 500 }, { sx: 2, sy: 2, rot: 30 }));
  addEntity(doc, makeCircle({ x: 0, y: 0 }, 3));
  return doc;
}

test('one INSERT of a 10k-entity block: its expansion yields many times, the scene is the one the synchronous emit builds', async () => {
  const doc = bigInsertDoc();
  let slices = 0;
  const sliced = await runSliced(buildSceneSteps(doc), { budgetMs: 0, onProgress: () => slices++ });
  assert.ok(slices >= 3 + 4, `the INSERT is expanded over several slices (${slices} slices for 3 entities)`);
  // the synchronous path: updateScene emits each entity in one go (Builder.emit)
  const ref = buildScene({ ...doc, entities: [] });
  ref.doc = doc;
  updateScene(ref, doc.entities.map((e) => e.id));
  assert.ok(sliced.items.length > 10000);
  assert.deepEqual(sliced.items, ref.items);
  assert.deepEqual(sliced.bbox, ref.bbox);
  assert.deepEqual(buildScene(doc).items, ref.items);
});

test('SpatialIndex rebuild: the box of an INSERT of a big block is bounded in chunks (yields), equal to bboxOf', async () => {
  const doc = bigInsertDoc(), ins = doc.entities[1];
  const a = new SpatialIndex(doc), b = new SpatialIndex(doc, { deferred: true });
  let steps = 0;
  const g = b.rebuildSteps();
  while (!g.next().done) steps++;
  assert.ok(steps >= 3 + 5, `the big INSERT's box takes several steps (${steps})`);
  assert.deepEqual(indexShape(b), indexShape(a));
  assert.deepEqual(b.bboxOf(ins), bboxOf(ins, doc));
});
