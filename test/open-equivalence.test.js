// The open pipeline's speed-ups (geom.js copyEntity in transformEntity, the de Boor span walk, the LINE box) must not
// change what a drawing shows or what picking finds: scene items, index boxes and query results, and explode output of
// every INSERT are pinned by digests taken before those changes, on every DXF fixture and a synthetic drawing with
// nested, rotated, mirrored, scaled and arrayed inserts of splines, arcs, ellipses, polylines, text and hatches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { FIX, fixture } from './helpers.js';
import { readDxf } from '../src/core/dxfRead.js';
import { buildScene } from '../src/core/render.js';
import { SpatialIndex } from '../src/core/pick.js';
import * as geom from '../src/core/geom.js';

const { explode, tessellate, bboxOf } = geom;
import { newDocument, makeLine, makeCircle, makeText, makeHatch, makeInsert, addEntity, addBlock } from '../src/core/model.js';

/** canonical JSON: typed arrays as arrays, an object met again (parent INSERTs, the doc) by a marker, -0 kept */
function digest(value) {
  const seen = new Set();
  const json = JSON.stringify(value, function (k, v) {
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : Number.isFinite(v) ? v : String(v);
    if (ArrayBuffer.isView(v)) return ['ta', ...Array.from(v, (x) => (Object.is(x, -0) ? '-0' : x))];
    if (v instanceof Map) return ['map', ...v.keys()];
    if (v && typeof v === 'object') { if (seen.has(v)) return `#${v.id ?? v.type ?? 'obj'}`; seen.add(v); }
    if (v === undefined && k) return '~undef';
    return v;
  });
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function syntheticDoc() {
  const doc = newDocument();
  const spl = (pts, o = {}) => ({ type: 'SPLINE', layer: '0', color: 256, degree: o.degree ?? 3, ctrl: pts.map(([x, y]) => ({ x, y })), knots: o.knots ?? [], weights: o.weights ?? [], fit: [], closed: false });
  const leaf = [
    makeLine({ x: 0, y: 0 }, { x: 10, y: 3 }), makeCircle({ x: 4, y: 4 }, 2.5),
    { type: 'ARC', layer: '0', color: 256, c: { x: 1, y: 2 }, r: 3, a0: 30, a1: 290 },
    { type: 'ELLIPSE', layer: '0', color: 1, c: { x: 2, y: -1 }, major: { x: 3, y: 1 }, ratio: 0.4, a0: 0.3, a1: 5.1 },
    { type: 'LWPOLYLINE', layer: '0', color: 256, closed: true, vertices: [{ x: 0, y: 0, bulge: 0.4 }, { x: 5, y: 0 }, { x: 5, y: 4, bulge: -1 }, { x: 0, y: 4 }] },
    spl([[0, 0], [2, 5], [6, -3], [9, 4], [12, 0], [14, 7], [17, 1]]),
    spl([[0, 0], [1, 3], [4, 3], [5, 0]], { degree: 2, knots: [0, 0, 0, 0.5, 1, 1, 1], weights: [1, 0.5, 2, 1] }),
    spl([[0, 0], [3, 1], [3, 1], [6, 0], [8, 2]], { knots: [0, 0, 0, 0, 1, 1, 3, 3, 3] }), // repeated knots, zero-length span
    makeText({ x: 1, y: 1 }, 2, 'Ab', { rot: 20 }),
    makeHatch([{ pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], closed: true }]),
  ];
  addBlock(doc, 'LEAF', { x: 1, y: 1 }, leaf.map((e, i) => ({ ...e, id: 1000 + i })));
  addBlock(doc, 'MID', { x: 0, y: 0 }, [
    { ...makeInsert('LEAF', { x: 20, y: 0 }, { rot: 33, sx: 2, sy: -1.5 }), id: 2000 },
    { ...makeInsert('LEAF', { x: 0, y: 30 }, { cols: 3, rows: 2, colSp: 25, rowSp: 18 }), id: 2001 },
    { ...makeLine({ x: -5, y: -5 }, { x: 60, y: 70 }), id: 2002 },
  ]);
  const big = [];
  for (let i = 0; i < 2600; i++) big.push({ ...(i % 3 ? makeLine({ x: i, y: (i * 7) % 50 }, { x: i + 3, y: (i * 11) % 40 }) : spl([[i, 0], [i + 1, 4], [i + 3, -2], [i + 5, 3]])), id: 3000 + i });
  addBlock(doc, 'BIG', { x: 100, y: 0 }, big); // over pick.js BOX_CHUNK: boxed in steps
  addEntity(doc, makeInsert('MID', { x: 0, y: 0 }));
  addEntity(doc, makeInsert('MID', { x: 500, y: 200 }, { rot: 145, sx: 0.5, sy: 0.5 }));
  addEntity(doc, makeInsert('LEAF', { x: -300, y: 50 }, { sx: -1, sy: 1, rot: 90 }));
  addEntity(doc, makeInsert('BIG', { x: 0, y: -400 }, { rot: 12 }));
  addEntity(doc, makeInsert('BIG', { x: -2000, y: 900 }, { sx: 1.5, sy: 1.5 }));
  for (const e of leaf) addEntity(doc, { ...structuredClone(e), id: 0 });
  addEntity(doc, makeLine({ x: 3, y: -0 }, { x: -0, y: 9 }));
  return doc;
}

/** what a drawing shows and what picking finds */
function snapshot(doc) {
  const scene = buildScene(doc);
  const ix = new SpatialIndex(doc);
  const boxes = doc.entities.map((e) => ix.bboxOf(e));
  const ext = scene.bbox ?? { minx: 0, miny: 0, maxx: 1, maxy: 1 };
  const queries = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const w = (ext.maxx - ext.minx) / 6, h = (ext.maxy - ext.miny) / 6;
    queries.push(ix.query({ minx: ext.minx + i * w, miny: ext.miny + j * h, maxx: ext.minx + (i + 1.3) * w, maxy: ext.miny + (j + 1.3) * h }).map((e) => e.id));
  }
  const exploded = doc.entities.filter((e) => e.type === 'INSERT').map((e) => explode(e, doc).map((s) => ({ ...s, parent: s.parent?.id })));
  return { scene: digest(scene.items), boxes: digest(boxes), queries: digest(queries), explode: digest(exploded), tess: digest(doc.entities.map((e) => tessellate(e, doc, 0))) };
}

// taken on the code before the speed-ups (commit 6e3fbc1)
const EXPECTED = {
  "synthetic": {scene: '9448c7a41a3d7242', boxes: '284d9a8ab0497cac', queries: '9863c83906c2f89f', explode: '688aae6cd619d5ff', tess: '13db1a65db2c817d'},
  "basic_r2000.dxf": {scene: 'c4ee620a663ed1ef', boxes: '232f3db85924368c', queries: '2c85f6196799e681', explode: '4f53cda18c2baa0c', tess: '0f545bb7e1ccb2f8'},
  "big_grid_r2000.dxf": {scene: 'a63416ccd580ac1e', boxes: '12755ae330c4b36a', queries: 'cda740d09035bfc9', explode: '4f53cda18c2baa0c', tess: '61d813c3910c2830'},
  "blocks_r2000.dxf": {scene: '03ec33a7a15d691e', boxes: '54bb61f889c53970', queries: 'b16374b603b20c14', explode: '074eb2890c8d3e24', tess: '5f020b0679ee9ac8'},
  "cmcolor_dimstyle.dxf": {scene: '2a4d23e6730296e6', boxes: 'a7c51de7b06d20cc', queries: '8003826707a298b8', explode: '4f53cda18c2baa0c', tess: '4b1894f74938c054'},
  "colors_r2000.dxf": {scene: 'c4a2334119f8a01d', boxes: '84169ea2227a5010', queries: 'ed25b34cd6b934d7', explode: '0d1cd03700d5c4d4', tess: '41d7aa4f519a2ffd'},
  "dims_r2000.dxf": {scene: '38ab9cc3dd8a5cca', boxes: '13500a457d8720dc', queries: '55783130cce67b0b', explode: '4f53cda18c2baa0c', tess: '84e58bd52ba23673'},
  "extrusion_r2000.dxf": {scene: '63194f8900fc7f7e', boxes: '0db8a2b821c28d47', queries: '6e221e2cb435c2ea', explode: '4f53cda18c2baa0c', tess: 'dd631c12ada21fd7'},
  "hatch_r2000.dxf": {scene: 'f17f5461caae3e03', boxes: 'c417ff912a5d0e71', queries: '7bede2fb848bf8b8', explode: '4f53cda18c2baa0c', tess: '335f084a4b055076'},
  "image_missing.dxf": {scene: 'f7b0c7a35b532bcc', boxes: '65b3975b6f0626ae', queries: '36086dc408c425b1', explode: '4f53cda18c2baa0c', tess: 'b92b8708b62fbbf2'},
  "layouts_r2000.dxf": {scene: 'e2b87b291921e289', boxes: '8a8643e854d786de', queries: '6197a3e579443378', explode: '4f53cda18c2baa0c', tess: 'ef431ed33c870a77'},
  "polylines_r2000.dxf": {scene: '367eb7378b5ae891', boxes: '67d509586755d83b', queries: 'd692b18f20681014', explode: '4f53cda18c2baa0c', tess: '7cff6fa7d90bad85'},
  "r12_ac1009.dxf": {scene: 'b8d6329feb876f3b', boxes: '1b42026e324a1c08', queries: 'cecc924767d86eea', explode: '4f53cda18c2baa0c', tess: '2e0a5a9eb0d56fb0'},
  "r2007_ac1021.dxf": {scene: '0de087a3e860fc75', boxes: 'e5f7021d37159444', queries: 'cffe0260a583d92a', explode: '4f53cda18c2baa0c', tess: '2e0a5a9eb0d56fb0'},
  "r2018_ac1032.dxf": {scene: '0de087a3e860fc75', boxes: 'e5f7021d37159444', queries: 'cffe0260a583d92a', explode: '4f53cda18c2baa0c', tess: '2e0a5a9eb0d56fb0'},
  "splines_r2000.dxf": {scene: '457ae11f612cdc03', boxes: '779a0246e2436828', queries: 'd599a6ec88706309', explode: '4f53cda18c2baa0c', tess: 'a195641f62a640e2'},
  "text_r2000.dxf": {scene: 'ad178817833612b2', boxes: 'e09a81f6974e129f', queries: '95c15edabdb3a0cd', explode: '4f53cda18c2baa0c', tess: '210e130878aabaf4'},
  "unsupported_r2000.dxf": {scene: 'd946cd7fe14278e0', boxes: 'bb922b3e6f428178', queries: 'cc22b62f686fa87a', explode: '4f53cda18c2baa0c', tess: '040eb132e611a816'},
  "utm_metres_insunits_mm.dxf": {scene: '0d2caec27fc07cfa', boxes: '24b8d43cc59cdc92', queries: 'e6fdbd1fc61f953f', explode: '4f53cda18c2baa0c', tess: '3a5b20e15621b7de'},
  "xref_host_r2000.dxf": {scene: '0485e80772e34393', boxes: 'c1b2989d8a515389', queries: 'e6fdbd1fc61f953f', explode: '643d5437104296e2', tess: 'd260bcf49b6607a7'},
};

test('open pipeline speed-ups: scene, index boxes, queries and explode are unchanged', () => {
  const docs = [['synthetic', syntheticDoc()], ...readdirSync(FIX).filter((f) => f.endsWith('.dxf') && f !== 'binary_sentinel.dxf').sort().map((f) => [f, readDxf(fixture(f))])];
  const got = Object.fromEntries(docs.map(([name, doc]) => [name, snapshot(doc)]));
  if (process.env.PRINT_EQUIV) { console.log(JSON.stringify(got, null, 1)); return; }
  assert.deepEqual(got, EXPECTED);
});

test('copyEntity copies as structuredClone does', () => {
  const shared = { x: 1, y: 2 };
  const holes = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const extra = Object.assign([1, 2], { tag: 'x' });
  const bare = Object.assign(Object.create(null), { a: 1 });
  const e = { id: 7, type: 'HATCH', p1: shared, p2: shared, loops: [{ pts: [{ x: -0, y: NaN, bulge: undefined }], closed: true }], holes, extra, bare,
    bytes: new Uint8Array([1, 2, 3]), at: new Date(5), m: new Map([['k', { v: 1 }]]), s: new Set([1]), nil: null, flag: false, big: 10n, parent: { id: 9 } };
  e.self = e;
  const c = geom.copyEntity(e), ref = structuredClone(e);
  assert.deepEqual(c, ref);
  assert.equal(c.p1, c.p2, 'shared objects stay shared');
  assert.equal(c.self, c, 'a cycle stays a cycle');
  assert.notEqual(c.p1, shared); assert.notEqual(c.loops[0].pts[0], e.loops[0].pts[0]);
  assert.ok(Object.is(c.loops[0].pts[0].x, -0)); assert.ok('bulge' in c.loops[0].pts[0]);
  assert.equal(1 in c.holes, false); assert.equal(c.extra.tag, 'x'); assert.equal(Object.getPrototypeOf(c.bare), Object.prototype);
  assert.ok(c.bytes instanceof Uint8Array && c.bytes !== e.bytes);
  assert.deepEqual(Object.keys(c), Object.keys(ref), 'same key order');
  const noParent = geom.copyEntity(e, 'parent');
  assert.equal('parent' in noParent, false);
  const { parent, ...rest } = ref; // eslint-disable-line no-unused-vars
  assert.deepEqual({ ...noParent, self: null }, { ...rest, self: null });
});

test('LINE box is the box of its tessellation', () => {
  for (const [a, b] of [[[0, 0], [1, 1]], [[5, -2], [-3, 7]], [[-0, 0], [0, -0]], [[NaN, 1], [2, 3]], [[1, 1], [1, 1]]]) {
    const e = makeLine({ x: a[0], y: a[1] }, { x: b[0], y: b[1] });
    const ref = tessellate(e)[0].reduce((r, p) => (r ? { minx: p.x < r.minx ? p.x : r.minx, miny: p.y < r.miny ? p.y : r.miny, maxx: p.x > r.maxx ? p.x : r.maxx, maxy: p.y > r.maxy ? p.y : r.maxy } : { minx: p.x, miny: p.y, maxx: p.x, maxy: p.y }), null);
    assert.deepEqual(bboxOf(e), ref);
  }
});
