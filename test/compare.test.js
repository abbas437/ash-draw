import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, makeLine, makeCircle, makeText } from '../src/core/model.js';
import { compareDocs, buildCompareDoc, COMPARE_LAYERS } from '../src/core/compare.js';

/** n identical entities (lines, circles, texts) laid out on a grid */
function common(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 100) * 10, y = Math.floor(i / 100) * 10;
    out.push(i % 3 === 0 ? makeLine({ x, y }, { x: x + 4, y: y + 3 }) : i % 3 === 1 ? makeCircle({ x, y }, 2) : makeText({ x, y }, 1, `T${i}`));
  }
  return out;
}
function docOf(ents) { const d = newDocument(); for (const e of ents) addEntity(d, structuredClone(e)); return d; }
const shuffle = (arr) => { let s = 7; const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function pair() {
  const base = common(1000);
  const A = [...base, makeCircle({ x: 2000, y: 0 }, 5), makeText({ x: 2000, y: 100 }, 2, 'NOTE'), makeLine({ x: 2000, y: 200 }, { x: 2050, y: 200 }, { color: 1 })];
  const B = [...shuffle(base), makeLine({ x: 2000, y: 300 }, { x: 2040, y: 330 }), makeText({ x: 2005, y: 103 }, 2, 'NOTE'), makeLine({ x: 2050, y: 200 }, { x: 2000, y: 200 }, { color: 5 })];
  return [docOf(A), docOf(shuffle(B))];
}

test('compare: one added, one removed, moved text and recoloured line changed, 1000 reordered identical', () => {
  const [a, b] = pair();
  const r = compareDocs(a, b);
  assert.equal(r.same.length, 1000);
  assert.equal(r.added.length, 1); assert.equal(r.added[0].type, 'LINE'); assert.equal(r.added[0].p1.y, 300);
  assert.equal(r.removed.length, 1); assert.equal(r.removed[0].type, 'CIRCLE');
  assert.equal(r.changed.length, 2);
  assert.deepEqual(r.changed.map((p) => p.a.type).sort(), ['LINE', 'TEXT']);
  assert.equal(r.clusters.reduce((n, c) => n + c.added + c.removed + c.changed, 0), 4);
});

test('compare: tolerance is respected', () => {
  const a = docOf([makeLine({ x: 0, y: 0 }, { x: 10, y: 0 })]);
  const b = docOf([makeLine({ x: 0, y: 0 }, { x: 10, y: 0.0004 })]);
  assert.equal(compareDocs(a, b, { tol: 1e-3 }).same.length, 1);
  const tight = compareDocs(a, b, { tol: 1e-6 });
  assert.equal(tight.same.length, 0);
  assert.equal(tight.changed.length, 1); // one end moved: an edit in place, not removed + added
});

test('compare: distant same-type objects are removed + added, not changed', () => {
  const a = docOf([makeCircle({ x: 0, y: 0 }, 1), makeCircle({ x: 1000, y: 1000 }, 3)]);
  const b = docOf([makeCircle({ x: 0, y: 0 }, 1), makeCircle({ x: 0, y: 900 }, 7)]);
  const r = compareDocs(a, b);
  assert.deepEqual([r.same.length, r.added.length, r.removed.length, r.changed.length], [1, 1, 1, 0]);
});

test('compare: 20k entities in under 2 s', () => {
  const base = common(20000);
  const a = docOf(base), b = docOf(shuffle(base));
  const t0 = performance.now();
  const r = compareDocs(a, b);
  const ms = performance.now() - t0;
  assert.equal(r.same.length, 20000);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

test('compare doc: colours by status and a dotted rectangle per cluster', () => {
  const [a, b] = pair();
  const r = compareDocs(a, b);
  const d = buildCompareDoc(a, b, r);
  const on = (k) => d.entities.filter((e) => e.layer === COMPARE_LAYERS[k].name);
  assert.equal(on('same').length, 1000);
  assert.equal(on('added').length, 1);
  assert.equal(on('removed').length, 1);
  assert.equal(on('changed').length, 2); // B's version of each changed object
  assert.equal(on('changedA').length, 2); // and A's, on its own layer (for the Overlay / A only / B only views)
  assert.equal(on('marks').length, r.clusters.length);
  assert.ok(on('marks').every((e) => e.type === 'LWPOLYLINE' && e.linetype === 'COMPARE_DOT'));
  assert.equal(d.layers.get(COMPARE_LAYERS.added.name).color, 3);
  assert.equal(d.layers.get(COMPARE_LAYERS.removed.name).color, 1);
});

// ---- alignment, block expansion, views ------------------------------------------------------------
import { addBlock, makeInsert } from '../src/core/model.js';
import { estimateOffset, expandEntities, setCompareView } from '../src/core/compare.js';
import { transformEntity, translation } from '../src/core/geom.js';
import { buildScene } from '../src/core/render.js';

/** a non-periodic plan: grid lines, bubbles, walls and texts at pseudo-random places (mm) */
function plan() {
  let s = 12345; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let i = 0; i < 12; i++) { const x = 220000 + i * 6000 + Math.round(rnd() * 900); out.push(makeLine({ x, y: 20000 }, { x, y: 80000 }), makeCircle({ x, y: 81000 }, 500)); }
  for (let i = 0; i < 400; i++) {
    const x = 220000 + rnd() * 70000, y = 20000 + rnd() * 60000, L = 200 + rnd() * 5000;
    out.push(i % 4 === 3 ? makeText({ x, y }, 250, `R${i}`) : makeLine({ x, y }, { x: x + L * (i % 2), y: y + L * ((i + 1) % 2) }));
  }
  return out;
}

test('estimateOffset: B = A moved by (-30000, -8481) plus edits -> offset within 0.5 mm, compare reports just the edits', () => {
  const base = plan(), mv = translation(-30000, -8481);
  const A = [...base, makeCircle({ x: 250000, y: 50000 }, 300), makeText({ x: 260000, y: 60000 }, 250, 'NOTE')];
  const B = [...shuffle(base.map((e) => transformEntity(e, mv))), makeLine({ x: 200000, y: 30000 }, { x: 201000, y: 30000 }),
    transformEntity(makeText({ x: 260003, y: 60002 }, 250, 'NOTE'), mv)];
  const a = docOf(A), b = docOf(B);
  const o = estimateOffset(a, b, { tol: 1 });
  assert.ok(Math.abs(o.dx + 30000) < 0.5 && Math.abs(o.dy + 8481) < 0.5, JSON.stringify(o));
  assert.ok(o.votes >= base.length * 0.9 && o.confidence > 0.9, JSON.stringify(o));
  const r = compareDocs(a, b, { align: 'auto', tol: 1 });
  assert.ok(Math.abs(r.offset.dx + 30000) < 0.5 && Math.abs(r.offset.dy + 8481) < 0.5);
  assert.deepEqual([r.same.length, r.added.length, r.removed.length, r.changed.length], [base.length, 1, 1, 1]);
  assert.equal(r.removed[0].type, 'CIRCLE'); assert.ok(Math.abs(r.removed[0].c.x - 220000) < 1, 'removed piece drawn moved onto B');
  assert.equal(r.changed[0].a.text, 'NOTE');
  // without alignment nothing lines up
  assert.equal(compareDocs(a, b, { tol: 1 }).same.length, 0);
});

test('compare: a block in A exploded (or renamed) in B is the same drawing', () => {
  const blockEnts = [makeLine({ x: 0, y: 0 }, { x: 100, y: 0 }, { layer: 'M-DUCT', color: 1 }), makeCircle({ x: 50, y: 20 }, 10, { layer: 'M-DUCT', color: 1 }), makeLine({ x: 0, y: 0 }, { x: 0, y: 40 })];
  const a = newDocument(), b = newDocument();
  addBlock(a, 'INNER', { x: 0, y: 0 }, structuredClone(blockEnts));
  addBlock(a, 'FAN', { x: 0, y: 0 }, [...structuredClone(blockEnts), makeInsert('INNER', { x: 200, y: 0 }, { rot: 90 })]);
  addEntity(a, makeInsert('FAN', { x: 1000, y: 500 }, { layer: 'M-EQPT', sx: 2, sy: 2, rot: 30 }));
  addEntity(a, makeInsert('INNER', { x: 3000, y: 500 }, { layer: 'M-EQPT' }));
  addEntity(a, makeLine({ x: 0, y: 0 }, { x: 5000, y: 0 }));
  // B: the FAN insert exploded all the way (resolved geometry), INNER re-inserted under another name
  addBlock(b, 'INNER-2', { x: 0, y: 0 }, structuredClone(blockEnts));
  const fan = expandEntities(a, [a.entities[0]]).map((p) => p.e);
  assert.equal(fan.length, 6);
  for (const e of shuffle([...fan, makeInsert('INNER-2', { x: 3000, y: 500 }, { layer: 'M-EQPT' }), makeLine({ x: 5000, y: 0 }, { x: 0, y: 0 })])) addEntity(b, structuredClone(e));
  const r = compareDocs(a, b, { tol: 1e-6 });
  assert.deepEqual([r.same.length, r.added.length, r.removed.length, r.changed.length], [10, 0, 0, 0]);
  assert.equal(r.clusters.length, 0);
  // the exploded pieces kept the INSERT's layer for the children on layer 0
  assert.ok(fan.some((e) => e.type === 'LINE' && e.layer === 'M-EQPT') && fan.some((e) => e.layer === 'M-DUCT'));
});

test('compare views: Overlay / A only / B only change which entities are drawn and their colours', () => {
  const [a, b] = pair();
  const d = buildCompareDoc(a, b, compareDocs(a, b));
  const layerOf = new Map(d.entities.map((e) => [e.id, e.layer]));
  const drawn = () => { const n = {}; for (const it of buildScene(d).items) { const L = layerOf.get(it.id); n[L] = (n[L] ?? 0) + 1; } return n; };
  const has = (n, k) => (n[COMPARE_LAYERS[k].name] ?? 0) > 0;
  setCompareView(d, 'differences');
  let n = drawn();
  for (const k of ['same', 'added', 'removed', 'changed', 'changedA']) assert.ok(has(n, k), k);
  assert.equal(d.layers.get(COMPARE_LAYERS.changedA.name).color, 40);
  setCompareView(d, 'overlay');
  n = drawn();
  for (const k of ['same', 'added', 'removed', 'changed', 'changedA']) assert.ok(has(n, k), k);
  assert.deepEqual(['same', 'changedA', 'removed', 'changed', 'added'].map((k) => d.layers.get(COMPARE_LAYERS[k].name).color), [7, 1, 1, 3, 3]);
  setCompareView(d, 'a');
  n = drawn();
  assert.ok(has(n, 'same') && has(n, 'removed') && has(n, 'changedA') && !has(n, 'added') && !has(n, 'changed'));
  setCompareView(d, 'b');
  n = drawn();
  assert.ok(has(n, 'same') && has(n, 'added') && has(n, 'changed') && !has(n, 'removed') && !has(n, 'changedA'));
});
