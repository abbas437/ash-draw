// Fixes after review of beta41: PROXY inside a block, mesh parse cost, non-finite parts, a throwing window-side decode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyGraphics } from '../src/core/proxygfx.js';
import { newDocument } from '../src/core/model.js';
import { tessellate, bboxOf, docExtents, explode } from '../src/core/geom.js';

const D = (...v) => new Uint8Array(new Float64Array(v).buffer);
const DA = (a) => new Uint8Array(Float64Array.from(a).buffer);
const L = (...v) => new Uint8Array(new Int32Array(v).buffer);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
function stream(recs) {
  const body = recs.map(([t, b]) => { const n = 8 + Math.ceil(b.length / 4) * 4; const r = new Uint8Array(n); const dv = new DataView(r.buffer); dv.setUint32(0, n, true); dv.setUint32(4, t, true); r.set(b, 8); return r; });
  const total = 8 + body.reduce((a, r) => a + r.length, 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, total, true); dv.setUint32(4, recs.length, true);
  let at = 8; for (const r of body) { out.set(r, at); at += r.length; }
  return out;
}
const opts = { layers: ['0'], linetypes: [], layer: '0', color: 256, linetype: 'BYLAYER' };

test('an INSERT of a block holding a PROXY: bbox, tessellate, docExtents and explode work on the proxy parts', () => {
  const doc = newDocument();
  const parts = parseProxyGraphics(stream([[2, cat(D(5, 5, 0, 2, 0, 0, 1))]]), opts);
  assert.equal(parts.length, 1);
  doc.blocks.set('B', { name: 'B', base: { x: 0, y: 0 }, entities: [{ id: 0, type: 'PROXY', layer: '0', name: 'X', parts }] });
  const ins = { id: doc.nextId++, type: 'INSERT', layer: '0', block: 'B', p: { x: 100, y: 0 }, sx: 1, sy: 1, rot: 0 };
  doc.entities.push(ins);
  const b = bboxOf(ins, doc);
  assert.ok(Math.abs(b.minx - 103) < 1e-6 && Math.abs(b.maxx - 107) < 1e-6, JSON.stringify(b));
  assert.ok(tessellate(ins, doc, 0.1).length > 0);
  assert.ok(Number.isFinite(docExtents(doc).maxx));
  const ex = explode(ins, doc);
  assert.deepEqual(ex.map((x) => x.type), ['CIRCLE']); // EXPLODE gives the proxy's parts, moved into place
  assert.ok(Math.abs(ex[0].c.x - 105) < 1e-9);
});

test('a 1 x 20000 mesh parses fast (no column work for a single row)', () => {
  const n = 20000, pts = [];
  for (let i = 0; i < n; i++) pts.push(i, 0, 0);
  const t = performance.now();
  const out = parseProxyGraphics(stream([[8, cat(L(1, n), DA(pts))]]), opts);
  assert.ok(performance.now() - t < 200, `${performance.now() - t} ms`);
  assert.equal(out.length, 1);
});

test('the parts of one proxy are capped (marked truncated)', () => {
  const n = 1000, rows = 300, pts = [];
  for (let i = 0; i < n * rows; i++) pts.push(i % n, Math.floor(i / n), 0);
  const out = parseProxyGraphics(stream([[8, cat(L(rows, n), DA(pts))]]), opts);
  assert.equal(out.truncated, true);
  assert.ok(out.reduce((a, p) => a + p.vertices.length, 0) <= 200000);
});

test('non-finite values give no part', () => {
  const out = parseProxyGraphics(stream([
    [4, cat(D(0, 0, 0, 5, 0, 0, 1, 1, 0, 0, NaN))],       // arc, NaN sweep
    [2, cat(D(0, 0, 0, Infinity, 0, 0, 1))],              // circle, infinite radius
    [6, cat(L(3), D(0, 0, 0, NaN, 1, 0, 5, 5, 0))],                // polyline with a NaN vertex
  ]), opts);
  assert.equal(out.length, 0);
  const good = parseProxyGraphics(stream([[6, cat(L(2), D(0, 0, 0, 5, 5, 0))]]), opts);
  assert.equal(good.length, 1);
  const doc = newDocument();
  assert.ok(Number.isFinite(bboxOf({ id: 1, type: 'PROXY', layer: '0', parts: [...out, ...good] }, doc).maxx));
});

test('readDxfAsync: a throwing window-side decode rejects the open and stops the worker', async () => {
  const made = [];
  globalThis.Worker = class { constructor() { made.push(this); this.terminated = false; } postMessage() {} terminate() { this.terminated = true; } };
  try {
    const { readDxfAsync } = await import('../renderer/files.js');
    const p = readDxfAsync(new Uint8Array(8));
    const w = made[0];
    w.onmessage({ data: { head: { entities: [], blocks: new Map() }, total: 1 } });
    w.onmessage({ data: { ents: { garbage: true } } });
    await assert.rejects(p, /The drawing could not be read/);
    assert.equal(w.terminated, true);
  } finally { delete globalThis.Worker; }
});
