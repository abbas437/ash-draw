import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fixture, FIX } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf, writeDxfAsync } from '../src/core/dxfWrite.js';
import { dxfBytesOf, dxfBytesAsync, encodeSteps } from '../renderer/files.js';
import { drain } from '../src/core/slice.js';
import { newDocument, addEntity, addBlock, makeLine, makeInsert } from '../src/core/model.js';

const docs = () => readdirSync(FIX).filter((f) => f.endsWith('.dxf') && f !== 'binary_sentinel.dxf').map((f) => [f, readDxf(fixture(f))]);

test('writeDxfAsync writes the same text and report as writeDxf (every fixture, a slice end after every step)', async () => {
  const names = [];
  for (const [name, doc] of docs()) {
    for (const opts of [{}, { dimensionsAsGeometry: true }, { mleadersAsGeometry: true }]) {
      const a = writeDxf(doc, opts), ra = doc.lastWriteReport;
      doc.lastWriteReport = null;
      const b = await writeDxfAsync(doc, opts, { sliceMs: 0 });
      assert.equal(b, a, `${name} ${JSON.stringify(opts)}`);
      assert.deepEqual(doc.lastWriteReport, ra, `${name}: the async writer sets doc.lastWriteReport too`);
    }
    assert.deepEqual(await dxfBytesAsync(doc, undefined, { sliceMs: 0 }), dxfBytesOf(doc), name);
    names.push(name);
  }
  assert.ok(names.includes('layouts_r2000.dxf') && names.includes('dims_r2000.dxf'), names.join());
});

test('encodeSteps: pieces never split a surrogate pair; same bytes as one TextEncoder pass', () => {
  const s = 'ab\u{1F600}c\u{1F600}\u{1F600}d\uD800e'; // emoji pairs on piece boundaries, and a lone surrogate
  for (const piece of [1, 2, 3, 4, 100]) assert.deepEqual(drain(encodeSteps(s, piece)), new TextEncoder().encode(s), `piece ${piece}`);
});

test('writeDxfAsync / dxfBytesAsync: an aborted signal rejects with code CANCELLED', async () => {
  const doc = newDocument();
  for (let i = 0; i < 5000; i++) addEntity(doc, makeLine({ x: i, y: 0 }, { x: i, y: 1 }));
  const ac = new AbortController();
  const p = writeDxfAsync(doc, {}, { signal: ac.signal, sliceMs: 0 });
  ac.abort();
  await assert.rejects(p, (err) => err.code === 'CANCELLED' && /cancelled/.test(err.message));
  await assert.rejects(dxfBytesAsync(doc, undefined, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
});

test('large drawing: dxfBytesAsync never holds the event loop for 150 ms, and gives the dxfBytesOf bytes', async () => {
  // like test/e2e/run.mjs's large DXF: a block of 200 LINEs inserted 1,000 times and 50,000 plain LINEs
  const doc = newDocument();
  const blk = [];
  for (let i = 0; i < 200; i++) blk.push(makeLine({ x: i % 20, y: i }, { x: (i % 20) + 3, y: i + 1 }));
  addBlock(doc, 'B200', { x: 0, y: 0 }, blk);
  for (let i = 0; i < 1000; i++) addEntity(doc, makeInsert('B200', { x: (i % 50) * 30, y: 300 + Math.floor(i / 50) * 210 }));
  for (let i = 0; i < 50000; i++) addEntity(doc, makeLine({ x: i % 1000, y: -10 - Math.floor(i / 1000) }, { x: (i % 1000) + 0.8, y: -10.5 - Math.floor(i / 1000) }));
  // probe: a 0 ms timer; the largest gap between its ticks is the longest the loop was held
  let last = performance.now(), maxGap = 0, ticks = 0, stop = false;
  const tick = () => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; if (!stop) setTimeout(tick, 0); };
  setTimeout(tick, 0);
  await new Promise((r) => setTimeout(r, 5));
  last = performance.now(); maxGap = 0;
  const bytes = await dxfBytesAsync(doc);
  stop = true;
  const gap = Math.max(maxGap, performance.now() - last); // up to the end too
  console.log(`  large drawing: ${(bytes.length / 1e6).toFixed(1)} MB, ${ticks} probe ticks, max gap ${gap.toFixed(1)} ms`);
  assert.ok(gap < 150, `the event loop was held for ${Math.round(gap)} ms`);
  assert.ok(ticks > 5, `probe ticks: ${ticks}`); // it yields repeatedly; the count falls as the writer gets faster (19 on a fast CI runner), the gap above is the requirement
  assert.ok(bytes.length > (1 << 22), 'encoded in more than one piece');
  assert.deepEqual(bytes, dxfBytesOf(doc));
});
