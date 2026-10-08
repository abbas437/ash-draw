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
  assert.equal(on('changed').length, 4); // both versions of each changed object
  assert.equal(on('marks').length, r.clusters.length);
  assert.ok(on('marks').every((e) => e.type === 'LWPOLYLINE' && e.linetype === 'COMPARE_DOT'));
  assert.equal(d.layers.get(COMPARE_LAYERS.added.name).color, 3);
  assert.equal(d.layers.get(COMPARE_LAYERS.removed.name).color, 1);
});
