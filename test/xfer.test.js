// The worker -> window hand-off of a read drawing in compact batches (src/core/entXfer.js, docBatches.js): what the
// window rebuilds must be exactly what a structured clone of the entities gives - the same keys in the same order,
// the same values (-0 and NaN too), the same kinds of objects - on every DXF fixture and a synthetic drawing with
// every entity type and every kind of value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { FIX, fixture } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { encodeEnts, decodeEnts } from '../src/core/entXfer.js';
import { postDocInBatches, docAssembler } from '../src/core/docBatches.js';
import { newDocument, addEntity, addBlock, makeLine, makeCircle, makeText, makeHatch, makeInsert, SUPPORTED_TYPES } from '../src/core/model.js';

/** a and b are the same: kinds, keys in order, numbers by Object.is; objects referenced twice in the same places */
function assertSame(a, b, where, seenA = new Map(), seenB = new Map()) {
  assert.equal(typeof a, typeof b, `${where}: type`);
  if (typeof a === 'number') { assert.ok(Object.is(a, b), `${where}: ${a} vs ${b}`); return; }
  if (a === null || typeof a !== 'object') { assert.equal(a, b, where); return; }
  assert.ok(b !== null, `${where}: null`);
  assert.equal(seenA.get(a), seenB.get(b), `${where}: shared objects`);
  if (seenA.has(a)) return;
  seenA.set(a, where); seenB.set(b, where);
  assert.equal(Object.getPrototypeOf(a), Object.getPrototypeOf(b), `${where}: kind`);
  if (a instanceof Map) { assertSame([...a], [...b], `${where}<map>`, seenA, seenB); return; }
  assert.deepEqual(Object.keys(b), Object.keys(a), `${where}: keys`);
  if (Array.isArray(a)) assert.equal(b.length, a.length, `${where}: length`);
  for (const k of Object.keys(a)) assertSame(a[k], b[k], `${where}.${k}`, seenA, seenB);
}

/** JSON text (a BigInt as text) */
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));

/** ents through encode -> structured clone (the numbers transferred) -> decode, against a structured clone of them */
function roundTrip(ents, name) {
  const { packet, transfer } = encodeEnts(ents);
  assert.ok(packet.nums instanceof Float64Array && transfer[0] === packet.nums.buffer, `${name}: numbers transferred`);
  const got = decodeEnts(structuredClone(packet, { transfer }));
  const want = structuredClone(ents);
  assert.equal(got.length, want.length, name);
  for (let i = 0; i < want.length; i++) {
    assert.equal(json(got[i]), json(want[i]), `${name} #${i} ${want[i]?.type}`);
    assertSame(want[i], got[i], `${name} #${i} ${want[i]?.type}`);
  }
  return packet;
}

const allEntities = (doc) => [...[...doc.blocks.values()].flatMap((b) => b.entities), ...doc.entities];

function syntheticEntities() {
  const doc = newDocument();
  const p = (x, y) => ({ x, y });
  const common = { layer: 'WALLS', color: 3, linetype: 'DASHED', lineweight: 0.35, ltscale: 2 };
  const ents = [
    makeLine(p(0, 0), p(10, 3)), makeLine(p(-0, NaN), p(Infinity, -Infinity), { ...common, alpha: 128 }),
    makeLine(p(1, 2), p(3, 4), { color: { r: 1, g: 2, b: 3 }, alpha: -2 }),
    makeCircle(p(4, 4), 2.5), makeText(p(1, 1), 'héllo', 2.5),
    { type: 'ARC', layer: '0', color: 256, c: p(1, 2), r: 3, a0: 30, a1: 290 },
    { type: 'ELLIPSE', layer: '0', color: 1, c: p(2, -1), major: p(3, 1), ratio: 0.4, a0: 0.3, a1: 5.1 },
    { type: 'LWPOLYLINE', ...common, vertices: [{ x: 0, y: 0, bulge: 0.4 }, { x: 5, y: 0, bulge: 0 }], closed: true, width: 0 },
    { type: 'LWPOLYLINE', layer: '0', vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 5, y: 0 }], closed: false }, // vertices of two shapes
    { type: 'LWPOLYLINE', layer: '0', vertices: [{ y: 0, x: 0 }, { x: 5, y: 0 }], closed: false }, // keys in another order
    { type: 'LWPOLYLINE', layer: '0', vertices: [], closed: false },
    { type: 'SPLINE', layer: '0', degree: 3, ctrl: [p(0, 0), p(2, 5), p(6, -3), p(9, 4)], knots: [0, 0, 0, 0, 1, 1, 1, 1], weights: null, fit: [], closed: false },
    { type: 'SPLINE', layer: '0', degree: 2, ctrl: [], knots: [], weights: [1, -0, NaN], fit: [p(0, 0), p(1, 1)], closed: true },
    { type: 'MTEXT', layer: '0', p: p(0, 0), height: 2, text: 'A\\PB', width: 0, rot: 0, attach: 1, style: 'STANDARD', lineSpacing: 1 },
    { type: 'POINT', layer: '0', p: p(-0, 0) },
    { type: 'SOLID', layer: '0', pts: [p(0, 0), p(1, 0), p(0, 1), p(1, 1)] },
    { layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, id: 7, type: '3DFACE', pts: [p(0, 0), p(1, 0), p(1, 1)], inv: 0 },
    { type: 'OLE2FRAME', layer: '0', p1: p(0, 0), p2: p(4, 3), data: new Uint8Array([1, 2, 3]) },
    makeHatch([[p(0, 0), p(4, 0), p(4, 4)]], { solid: false, pattern: 'ANSI31', angle: 45, scale: 2 }),
    { type: 'HATCH', layer: '0', loops: [{ segs: [{ kind: 'line', a: p(0, 0), b: p(1, 0) }, { kind: 'arc', c: p(0, 0), r: 1, a0: 0, a1: 90, ccw: true }], closed: true }], solid: true, pattern: 'SOLID', angle: 0, scale: 1 },
    makeInsert('B1', p(5, 5), { sx: -1, sy: 1, rot: 90 }),
    { type: 'DIMENSION', layer: '0', block: '*D1', dimType: 0, p: p(0, 0), text: '', raw: [[10, 1.5], [70, 0]], style: 'STANDARD', def: { kind: 'linear', p1: p(0, 0), p2: p(5, 0), at: p(2, 1), angle: 0, text: '<>' } },
    { type: 'LEADER', layer: '0', pts: [p(0, 0), p(2, 2)], arrow: true },
    { type: 'MLEADER', layer: '0', leaders: [[p(0, 0), p(1, 1)]], text: 'note', p: p(1, 1), height: 2.5, style: undefined },
    { type: 'MLINE', layer: '0', style: 'STANDARD', scale: 1, justify: 0, closed: false, vertices: [{ p: p(0, 0), dir: p(1, 0), miter: p(0, 1), elems: [[0], [0.5]] }] },
    { type: 'IMAGE', layer: '0', p: p(0, 0), u: p(1, 0), v: p(0, 1), size: p(100, 50), flags: 7, clip: { on: false, type: 1, pts: [] }, brightness: 50, contrast: 50, fade: 0, def: { path: 'a.png', size: p(100, 50) }, path: 'a.png' },
    { type: 'WIPEOUT', layer: '0', p: p(0, 0), u: p(1, 0), v: p(0, 1), size: p(1, 1), flags: 7, clip: { on: true, type: 2, pts: [p(-0.5, -0.5), p(0.5, -0.5), p(0, 0.5)], mode: 0 }, brightness: 50, contrast: 50, fade: 0, def: null, path: '' },
    { type: 'RAY', layer: '0', p: p(0, 0), dir: p(1, 0) }, { type: 'XLINE', layer: '0', p: p(0, 0), dir: p(0, 1) },
    // values of every other kind go through as they are
    { type: 'LINE', layer: '0', p1: { x: 0, y: 0, z: 1 }, p2: Object.assign(Object.create(null), { x: 1, y: 2 }), extra: new Map([['k', 1]]), when: new Date(0), list: [1, 'a', null], holes: [1, , 3], tagged: Object.assign([1, 2], { note: 'x' }), nested: [[1, 2], [3]], strs: ['a', 'b'], big: 10n },
    { type: 'LINE', layer: 5, color: '256', linetype: null, lineweight: undefined, ltscale: true }, // common keys with odd values
    {}, { type: 'POINT' },
  ];
  for (const e of ents) addEntity(doc, e);
  // every type the model supports is in the drawing
  for (const t of SUPPORTED_TYPES) assert.ok(ents.some((e) => e.type === t), `synthetic drawing has a ${t}`);
  return ents;
}

test('hand-off: every DXF fixture rebuilds exactly (keys in order, -0/NaN)', () => {
  let files = 0;
  for (const name of readdirSync(FIX).filter((f) => f.endsWith('.dxf'))) {
    let doc;
    try { doc = readDxf(new Uint8Array(fixture(name))); } catch (err) { if (err.code === 'BINARY_DXF') continue; throw err; }
    const ents = allEntities(doc);
    roundTrip(ents, name);
    for (let i = 0; i < ents.length; i += 7) roundTrip(ents.slice(i, i + 7), `${name}@${i}`); // small batches too
    files++;
  }
  assert.ok(files >= 15, `fixtures read: ${files}`);
});

test('hand-off: a synthetic drawing with every entity type and kind of value rebuilds exactly', () => {
  const ents = syntheticEntities();
  const packet = roundTrip(ents, 'synthetic');
  // defaults and repeated strings are not sent per entity
  assert.ok(!packet.strs.includes('BYLAYER') && packet.strs.filter((s) => s === 'WALLS').length === 1, 'string table');
  for (const e of ents) roundTrip([e], `alone ${e.type}`);
});

test('hand-off: the batches of a document are posted compact with their numbers transferred, and reassemble exactly', () => {
  const doc = newDocument();
  addBlock(doc, 'B1', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }), makeCircle({ x: 0, y: 0 }, 1)]);
  for (const e of syntheticEntities()) addEntity(doc, e);
  for (let i = 0; i < 2000; i++) addEntity(doc, makeLine({ x: i, y: -0 }, { x: i + 1, y: i % 3 ? i : NaN }, { layer: `L${i % 9}` }));
  const asm = docAssembler();
  let batches = 0;
  postDocInBatches(doc, (m, transfer) => {
    if (m.ents) { batches++; assert.ok(m.ents.nums instanceof Float64Array && transfer?.[0] === m.ents.nums.buffer, 'batch numbers transferred'); }
    if (!m.done) assert.ok(asm.accept(structuredClone(m, { transfer })));
  }, { first: 50, targetMs: 0 });
  assert.ok(batches > 3, `batches: ${batches}`);
  const want = structuredClone(doc);
  assert.equal(json(allEntities(asm.doc)), json(allEntities(want)));
  assertSame(want.entities, asm.doc.entities, 'entities');
  assertSame(want.blocks.get('B1').entities, asm.doc.blocks.get('B1').entities, 'block B1');
});
