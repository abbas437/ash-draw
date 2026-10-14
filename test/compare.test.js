import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, makeLine, makeCircle, makeText, makeXline } from '../src/core/model.js';
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
  assert.equal(r.changedGeometry.length, 1); assert.equal(r.changedGeometry[0].a.type, 'TEXT');
  assert.deepEqual(r.changedProps.map((p) => [p.a.type, p.why, p.props.join()]), [['LINE', 'props', 'color']]);
  assert.equal(r.clusters.reduce((n, c) => n + c.added + c.removed + c.changed, 0), 3); // the recoloured line is not clustered
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
  assert.equal(on('changed').length, 1); // B's version of each changed object
  assert.equal(on('props').length, 1); // the recoloured line, on its own layer
  assert.equal(on('changedA').length, 1); // and A's, on its own layer (for the Overlay / A only / B only views)
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

// ---- rotation alignment, picked points, piecewise alignment -----------------------------------------
import { estimateTransform, transformFromPoints } from '../src/core/compare.js';
import { apply, compose, rotation } from '../src/core/geom.js';

/** A = plan + edits; B = the plan turned by `rad` about (250000, 50000), moved by (1000, -2000), with edits */
function turnedPair(rad) {
  const base = plan(), M = compose(translation(1000, -2000), rotation(rad, 250000, 50000));
  const A = [...base, makeCircle({ x: 250000, y: 50000 }, 300), makeText({ x: 260000, y: 60000 }, 250, 'NOTE')];
  const B = [...shuffle(base.map((e) => transformEntity(e, M))), makeLine({ x: 200000, y: 30000 }, { x: 201000, y: 30000 }),
    transformEntity(makeText({ x: 260003, y: 60002 }, 250, 'NOTE'), M)];
  return { base, M, a: docOf(A), b: docOf(B) };
}
const near = (m1, m2, pts) => pts.every((p) => { const q1 = apply(m1, p), q2 = apply(m2, p); return Math.hypot(q1.x - q2.x, q1.y - q2.y) < 0.5; });
const probes = [{ x: 220000, y: 20000 }, { x: 290000, y: 80000 }, { x: 0, y: 0 }];

test('estimateTransform: B = A turned 180 deg about a point and moved -> rot 180, points mapped within 0.5 mm, only the edits reported', () => {
  const { base, M, a, b } = turnedPair(Math.PI);
  const t = estimateTransform(a, b, { tol: 1 });
  assert.equal(t.rot, 180, JSON.stringify(t));
  assert.ok(near(t.m, M, probes), JSON.stringify(t));
  assert.ok(Math.abs(t.m[4] - t.dx) < 1e-9 && Math.abs(t.m[5] - t.dy) < 1e-9 && t.confidence > 0.9);
  const r = compareDocs(a, b, { align: 'auto', tol: 1 });
  assert.equal(r.offset.rot, 180);
  assert.ok(near(r.offset.m, M, probes));
  assert.deepEqual([r.same.length, r.added.length, r.removed.length, r.changed.length], [base.length, 1, 1, 1]);
  assert.equal(r.removed[0].type, 'CIRCLE'); assert.equal(r.changed[0].a.text, 'NOTE');
  assert.deepEqual(r.realigned, []);
  // a translation-only estimate cannot line it up
  const o = estimateOffset(a, b, { tol: 1 });
  assert.ok(o.confidence < 0.5, JSON.stringify(o));
});

test('estimateTransform: a 90 deg turn', () => {
  const { base, M, a, b } = turnedPair(Math.PI / 2);
  const t = estimateTransform(a, b, { tol: 1 });
  assert.equal(t.rot, 90, JSON.stringify(t));
  assert.ok(near(t.m, M, probes), JSON.stringify(t));
  const r = compareDocs(a, b, { align: 'auto', tol: 1 });
  assert.deepEqual([r.same.length, r.added.length, r.removed.length, r.changed.length], [base.length, 1, 1, 1]);
});

test('transformFromPoints: two picked pairs give rotation + translation, one pair a translation; compare applies it', () => {
  const M = compose(translation(1000, -2000), rotation(Math.PI / 5, 250000, 50000));
  const a1 = { x: 230000, y: 40000 }, a2 = { x: 260000, y: 70000 };
  const m = transformFromPoints(a1, a2, apply(M, a1), apply(M, a2));
  assert.ok(near(m, M, [...probes, a1, a2]), JSON.stringify(m));
  assert.ok(Math.abs(Math.hypot(m[0], m[1]) - 1) < 1e-12, 'no scale');
  // picked B points a bit off along the direction: still no scale, a1 still lands on b1
  const b1 = apply(M, a1), b2 = apply(M, { x: 290000, y: 100000 });
  const m2 = transformFromPoints(a1, a2, b1, b2), p = apply(m2, a1);
  assert.ok(Math.hypot(p.x - b1.x, p.y - b1.y) < 1e-6 && Math.abs(Math.hypot(m2[0], m2[1]) - 1) < 1e-12);
  assert.deepEqual(transformFromPoints({ x: 10, y: 20 }, null, { x: 15, y: 18 }, null), [1, 0, 0, 1, 5, -2]);
  const { base, a, b } = turnedPair(Math.PI / 5);
  const r = compareDocs(a, b, { transform: m, tol: 1 });
  assert.ok(Math.abs(r.offset.rot - 36) < 1e-9 && r.offset.dx === m[4] && r.offset.dy === m[5]);
  assert.deepEqual([r.same.length, r.added.length, r.removed.length, r.changed.length], [base.length, 1, 1, 1]);
  // dx/dy alone are the translation special case
  const t = compareDocs(a, a, { dx: 5, dy: -2 }).offset;
  assert.deepEqual([t.m, t.rot, t.dx, t.dy], [[1, 0, 0, 1, 5, -2], 0, 5, -2]);
});

test('compare align auto, piecewise: a big background block left in place while the plan is turned is aligned on its own', () => {
  let s = 777; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bg = [];
  for (let i = 0; i < 300; i++) { const x = rnd() * 60000, y = rnd() * 50000, L = 300 + rnd() * 3000; bg.push(makeLine({ x, y }, { x: x + L * (i % 2), y: y + L * ((i + 1) % 2) })); }
  const base = plan(), M = compose(translation(1000, -2000), rotation(Math.PI, 250000, 50000));
  const a = newDocument(), b = newDocument();
  for (const d of [a, b]) addBlock(d, 'BG', { x: 0, y: 0 }, structuredClone(bg));
  addEntity(a, makeInsert('BG', { x: 225000, y: 25000 }));
  for (const e of base) addEntity(a, structuredClone(e));
  addEntity(b, makeInsert('BG', { x: 225000, y: 25000 }));
  for (const e of shuffle(base)) addEntity(b, transformEntity(e, M));
  const r = compareDocs(a, b, { align: 'auto', tol: 1 });
  assert.equal(r.offset.rot, 180);
  assert.equal(r.realigned.length, 1, JSON.stringify(r.realigned));
  const g = r.realigned[0];
  assert.ok(g.name === 'BG' && g.rot === 0 && Math.abs(g.dx) < 0.5 && Math.abs(g.dy) < 0.5, JSON.stringify(g));
  // the block moved relative to the rest: its pieces are paired through its own transform but reported as moved
  assert.deepEqual([r.same.length, r.added.length, r.removed.length, r.changed.length], [base.length, 0, 0, bg.length]);
  assert.ok(r.changed.every((p) => p.why === 'moved with group'));
  assert.ok(g.moved && g.pieces === bg.length && g.rel.rot === 180, JSON.stringify(g));
  assert.deepEqual([r.clusters.length, r.clusters[0].moved, r.clusters[0].changed], [1, 'BG', bg.length]);
  // without the second pass the block's pieces do not line up
  const r1 = compareDocs(a, b, { align: 'auto', tol: 1, piecewise: false });
  assert.equal(r1.same.length, base.length);
});

/** n random axis-parallel lines in x0..x0+w, y0..y0+h (seeded) */
function randomLines(n, seed, x0, y0, w, h) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let i = 0; i < n; i++) { const x = x0 + rnd() * w, y = y0 + rnd() * h, L = 300 + rnd() * 3000; out.push(makeLine({ x, y }, { x: x + L * (i % 2), y: y + L * ((i + 1) % 2) })); }
  return out;
}

test('compare moved group: 400 HVAC lines moved 500 mm relative to a 300-line background block are changed, not "No differences"', () => {
  const bg = randomLines(300, 4242, 0, 0, 60000, 50000), hvac = randomLines(400, 999, 5000, 5000, 50000, 40000);
  const a = newDocument(), b = newDocument();
  for (const d of [a, b]) { addBlock(d, 'ARCH-BG', { x: 0, y: 0 }, structuredClone(bg)); addEntity(d, makeInsert('ARCH-BG', { x: 0, y: 0 })); }
  for (const e of hvac) { addEntity(a, structuredClone(e)); addEntity(b, transformEntity(e, translation(500, 0))); }
  const r = compareDocs(a, b, { align: 'auto', tol: 1 });
  const diffs = r.added.length + r.removed.length + r.changed.length;
  assert.ok(diffs >= 300, `${diffs} differences: ${JSON.stringify([r.same.length, r.changed.length, r.added.length, r.removed.length])}`);
  assert.equal(r.realigned.length, 1, JSON.stringify(r.realigned));
  const g = r.realigned[0];
  assert.ok(g.moved && Math.abs(Math.abs(g.rel.dx) - 500) < 1 && Math.abs(g.rel.dy) < 1 && g.rel.rot === 0, JSON.stringify(g));
  // whichever side the global transform follows, the other side's pieces are all changed, as one moved cluster first
  const n = g.name === '*Model_Space' ? hvac.length : bg.length;
  assert.equal(g.pieces, n);
  assert.equal(r.changed.filter((p) => p.why === 'moved with group').length, n);
  assert.deepEqual([r.same.length, r.changed.length, r.added.length, r.removed.length], [700 - n, n, 0, 0]);
  assert.deepEqual([r.clusters[0].moved, r.clusters[0].changed], [g.name, n]);
  assert.equal(r.clusters.filter((c) => c.moved).length, 1);
});

test('compare moved group: a 300-piece equipment block moved 3 m is changed (moved), not same', () => {
  const eq = randomLines(300, 31337, 0, 0, 4000, 3000), base = plan();
  const a = newDocument(), b = newDocument();
  for (const d of [a, b]) { addBlock(d, 'AHU-01', { x: 0, y: 0 }, structuredClone(eq)); for (const e of base) addEntity(d, structuredClone(e)); }
  addEntity(a, makeInsert('AHU-01', { x: 240000, y: 40000 }));
  addEntity(b, makeInsert('AHU-01', { x: 243000, y: 40000 }));
  const r = compareDocs(a, b, { align: 'auto', tol: 1 });
  assert.deepEqual([r.same.length, r.changed.length, r.added.length, r.removed.length], [base.length, eq.length, 0, 0]);
  assert.ok(r.changed.every((p) => p.why === 'moved with group'));
  const g = r.realigned[0];
  assert.ok(r.realigned.length === 1 && g.name === 'AHU-01' && g.moved && g.pieces === 300, JSON.stringify(r.realigned));
  assert.ok(Math.abs(g.rel.dx - 3000) < 1 && Math.abs(g.rel.dy) < 1, JSON.stringify(g.rel));
  assert.deepEqual([r.clusters.length, r.clusters[0].moved, r.clusters[0].changed], [1, 'AHU-01', 300]);
  // A's version is shown where the global transform puts it (here: where it was)
  const e0 = expandEntities(a, [a.entities.at(-1)])[0].e;
  assert.ok(r.changed.some((p) => p.a.type === 'LINE' && Math.abs(p.a.p1.x - e0.p1.x) < 1e-6 && Math.abs(p.a.p1.y - e0.p1.y) < 1e-6));
});

// ---- change clusters: what a reviewer marks separately ----
import { defaultClusterGap } from '../src/core/compare.js';
/** a mm drawing: a frame w x h metres (unchanged) plus the given entities */
function sheet(w, h, ents = []) {
  const d = newDocument(); d.units = 4;
  const W = w * 1000, H = h * 1000;
  for (const [p, q] of [[[0, 0], [W, 0]], [[W, 0], [W, H]], [[W, H], [0, H]], [[0, H], [0, 0]]]) addEntity(d, makeLine({ x: p[0], y: p[1] }, { x: q[0], y: q[1] }));
  for (const e of ents) addEntity(d, structuredClone(e));
  return d;
}
const edits = (x, y) => [makeLine({ x, y }, { x: x + 800, y }), makeLine({ x, y: y + 300 }, { x: x + 800, y: y + 300 }), makeCircle({ x: x + 400, y: y + 150 }, 100)];

test('clusters: two edit groups 10 m apart on a 600 m sheet are two clusters (gap 1.5 m by default in mm)', () => {
  assert.equal(defaultClusterGap(4), 1500); assert.equal(defaultClusterGap(6), 1.5);
  const r = compareDocs(sheet(600, 300), sheet(600, 300, [...edits(100000, 100000), ...edits(110800, 100000)]), { tol: 1 });
  assert.equal(r.added.length, 6);
  assert.equal(r.clusters.length, 2);
  assert.deepEqual(r.clusters.map((c) => c.added), [3, 3]);
  // a larger group distance joins them
  assert.equal(compareDocs(sheet(600, 300), sheet(600, 300, [...edits(100000, 100000), ...edits(110800, 100000)]), { tol: 1, clusterGap: 12000 }).clusters.length, 1);
});

test('clusters: one long edit along a 60 m duct is cut into boxes of at most 10 group distances (15 m), whatever the sheet', () => {
  const duct = [];
  for (let i = 0; i < 60; i++) duct.push(makeLine({ x: 30000 + i * 1000, y: 50000 }, { x: 31000 + i * 1000, y: 50000 }), makeLine({ x: 30000 + i * 1000, y: 50600 }, { x: 31000 + i * 1000, y: 50600 }));
  for (const [w, h] of [[120, 100], [600, 300]]) {
    const r = compareDocs(sheet(w, h), sheet(w, h, duct), { tol: 1 });
    assert.equal(r.added.length, 120);
    assert.ok(r.clusters.length >= 4 && r.clusters.length <= 5, `${r.clusters.length} clusters on a ${w} m sheet`);
    for (const c of r.clusters) assert.ok(c.box.maxx - c.box.minx <= 15000 + 1e-6, JSON.stringify(c.box));
    assert.equal(r.clusters.reduce((n, c) => n + c.added, 0), 120);
    assert.deepEqual(r.clusters.map((c) => c.box.minx), [...r.clusters.map((c) => c.box.minx)].sort((p, q) => p - q), 'one row: left to right');
  }
  // the limit follows the group distance: at 3 m, boxes of up to 30 m
  const r3 = compareDocs(sheet(120, 100), sheet(120, 100, duct), { tol: 1, clusterGap: 3000 });
  assert.equal(r3.clusters.length, 2);
  for (const c of r3.clusters) assert.ok(c.box.maxx - c.box.minx <= 30000 + 1e-6, JSON.stringify(c.box));
});

test('clusters: a single change longer than the limit is a cluster of its own; the edits it passes stay separate', () => {
  const long = makeLine({ x: 10000, y: 20000 }, { x: 50000, y: 20000 }); // 40 m > 15 m
  const r = compareDocs(sheet(100, 50), sheet(100, 50, [long, ...edits(15000, 20500), ...edits(40000, 20500)]), { tol: 1 });
  assert.equal(r.added.length, 7);
  assert.deepEqual(r.clusters.map((c) => c.added).sort(), [1, 3, 3]);
  assert.ok(r.clusters.some((c) => c.added === 1 && c.box.maxx - c.box.minx === 40000));
  // a group distance large enough for the line to fit (limit 120 m): one cluster
  assert.equal(compareDocs(sheet(100, 50), sheet(100, 50, [long, ...edits(15000, 20500), ...edits(40000, 20500)]), { tol: 1, clusterGap: 12000 }).clusters.length, 1);
});

test('clusters: reading order is rows from the top, left to right in a row', () => {
  // top row: left (10, 50 m) and right (60, 48.5 m); bottom row: left (10, 20 m) and right (60, 21 m: higher than its left)
  const at = [[60, 21], [10, 20], [60, 48.5], [10, 50]];
  const r = compareDocs(sheet(100, 80), sheet(100, 80, at.map(([x, y]) => makeCircle({ x: x * 1000, y: y * 1000 }, 300))), { tol: 1 });
  assert.deepEqual(r.clusters.map((c) => [Math.round((c.box.minx + 300) / 1000), Math.round((c.box.miny + 300) / 1000 * 10) / 10]), [[10, 50], [60, 48.5], [10, 20], [60, 21]]);
});

test('clusters: no cap and no merging: 300 isolated changes stay 300 clusters', () => {
  const dots = [];
  for (let i = 0; i < 300; i++) dots.push(makeCircle({ x: 5000 + (i % 20) * 3000, y: 5000 + Math.floor(i / 20) * 3000 }, 100));
  const r = compareDocs(sheet(100, 100), sheet(100, 100, dots), { tol: 1 });
  assert.equal(r.clusters.length, 300);
  assert.equal(r.clusters.reduce((n, c) => n + c.added, 0), 300);
});

test('clusters: 5000 isolated changes over a 1 km sheet: every box within the size limit (10 group distances), under 1 s', () => {
  const dots = [];
  for (let i = 0; i < 5000; i++) dots.push(makeCircle({ x: 5000 + (i % 100) * 9500, y: 5000 + Math.floor(i / 100) * 19000 }, 100));
  const A = sheet(1000, 1000), B = sheet(1000, 1000, dots);
  const t0 = performance.now();
  const r = compareDocs(A, B, { tol: 1 });
  const ms = performance.now() - t0;
  assert.equal(r.clusters.reduce((n, c) => n + c.added, 0), 5000);
  assert.ok(r.clusters.length > 200);
  for (const c of r.clusters) assert.ok(Math.max(c.box.maxx - c.box.minx, c.box.maxy - c.box.miny) <= 15000 + 1e-6, JSON.stringify(c.box));
  assert.ok(ms < 1000, `${ms} ms`);
});

test('clusters: changes without a finite box (XLINE) form a fallback cluster; they are not "no differences"', () => {
  const r = compareDocs(sheet(50, 50), sheet(50, 50, [makeXline('XLINE', { x: 1000, y: 1000 }, { x: 1, y: 1 })]), { tol: 1 });
  assert.equal(r.added.length, 1);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].unbounded, 1); assert.equal(r.clusters[0].added, 1);
  assert.ok(Number.isFinite(r.clusters[0].box.maxx - r.clusters[0].box.minx) && r.clusters[0].box.maxx > r.clusters[0].box.minx);
  // mixed with a bounded change: the bounded cluster plus the fallback one, last
  const m = compareDocs(sheet(50, 50), sheet(50, 50, [makeCircle({ x: 5000, y: 5000 }, 100), makeXline('XLINE', { x: 1000, y: 1000 }, { x: 1, y: 1 })]), { tol: 1 });
  assert.deepEqual(m.clusters.map((c) => c.unbounded ?? 0), [0, 1]);
});

test('compare ignoreLayers: pieces on an ignored layer (or drawn by an INSERT on it) are left out', () => {
  const mk = (rev) => {
    const d = sheet(50, 50, [makeCircle({ x: 1000, y: 1000 }, 200)]);
    addBlock(d, 'REVTAB', { x: 0, y: 0 }, [makeText({ x: 0, y: 0 }, 250, `REV ${rev}`)]);
    addEntity(d, makeInsert('REVTAB', { x: 40000, y: 2000 }, { layer: 'Rev-Table' }));
    addEntity(d, makeText({ x: 40000, y: 5000 }, 250, `DATE ${rev}`, { layer: 'REV-TABLE' }));
    return d;
  };
  const all = compareDocs(mk('00'), mk('01'), { tol: 1 });
  assert.ok(all.added.length + all.changed.length > 0);
  const r = compareDocs(mk('00'), mk('01'), { tol: 1, ignoreLayers: ['rev-table'] });
  assert.equal(r.added.length + r.removed.length + r.changed.length, 0);
  assert.equal(r.same.length, 5);
  assert.equal(r.clusters.length, 0);
  // the pieces left out are counted: per drawing, the circle-free ones on REV-TABLE (INSERT's text part + DATE text)
  assert.equal(r.ignored, 4);
  assert.equal(all.ignored, 0);
});

// ---- time slicing: compareSteps / buildCompareSteps ----
import { compareSteps, buildCompareSteps } from '../src/core/compare.js';
import { drain, runSliced } from '../src/core/slice.js';

test('compareSteps: a 50k-piece pair yields often, rising progress, the same result as compareDocs; buildCompareSteps too', async () => {
  const base = common(50000), mv = translation(700, -300);
  const extra = [makeCircle({ x: 5000, y: 0 }, 5), makeLine({ x: 5000, y: 100 }, { x: 5100, y: 100 })];
  const a = docOf([...base, extra[0]]), b = docOf([...shuffle(base.map((e) => transformEntity(e, mv))), transformEntity(extra[1], mv)]);
  const opts = { align: 'auto', tol: 1e-3, rotations: [0, 90] };
  const sync = compareDocs(a, b, opts);
  let yields = 0, last = 0, rising = true;
  const gen = compareSteps(a, b, opts);
  let r;
  while (!(r = gen.next()).done) { yields++; if (r.value < last - 1e-12 || r.value > 1) rising = false; last = r.value; }
  assert.ok(yields >= 200, `${yields} yields`);
  assert.ok(rising, 'progress rises within 0..1');
  const sliced = r.value;
  assert.deepEqual([sliced.same.length, sliced.added.length, sliced.removed.length, sliced.changed.length], [50000, 1, 1, 0]);
  const sum = (x) => JSON.stringify({ n: [x.same.length, x.added.length, x.removed.length, x.changed.length], m: x.offset.m, cl: x.clusters });
  assert.equal(sum(sliced), sum(sync));
  let byields = 0;
  const g2 = buildCompareSteps(a, b, sliced);
  while (!(r = g2.next()).done) byields++;
  assert.ok(byields >= 50, `${byields} build yields`);
  assert.equal(r.value.entities.length, buildCompareDoc(a, b, sync).entities.length);
  assert.equal(drain(compareSteps(a, b, opts)).same.length, 50000);
});

test('compareSteps under runSliced: an aborted signal rejects with CANCELLED and stops the steps', async () => {
  const base = common(20000);
  const a = docOf(base), b = docOf(shuffle(base));
  const ac = new AbortController();
  let n = 0, after = 0;
  const gen = compareSteps(a, b, { align: 'auto', tol: 1e-3 });
  const counted = { next: () => { if (ac.signal.aborted) after++; return gen.next(); }, return: (v) => gen.return(v) };
  await assert.rejects(runSliced(counted, { budgetMs: 0, signal: ac.signal, onProgress: () => { if (++n === 5) ac.abort(); }, cancelMessage: 'Compare was cancelled.' }),
    (err) => err.code === 'CANCELLED' && /Compare was cancelled/.test(err.message));
  assert.equal(after, 0, 'no step after the abort');
  assert.equal(gen.next().done, true, 'the generator is closed');
});

// ---- review fixes: numbers compared by meaning, layer table state, identity keys ----
import { makeArc, makeEllipse, makeMText, makePolyline, addLayer } from '../src/core/model.js';
const verdict = (a, b, opts = { tol: 1 }) => { const r = compareDocs(a, b, opts); return [r.same.length, r.changed.length, r.added.length, r.removed.length]; };
const notSame = (ea, eb, msg) => assert.equal(compareDocs(docOf([ea]), docOf([eb]), { tol: 1 }).same.length, 0, msg);

test('compare fix: a bulge, an arc end angle, an ellipse ratio, an insert scale or a text rotation that moves what is drawn is never same', () => {
  notSame(makePolyline([{ x: 0, y: 0 }, { x: 1000, y: 0 }]), makePolyline([{ x: 0, y: 0, bulge: 0.9 }, { x: 1000, y: 0 }]), 'bulge 0 -> 0.9');
  notSame(makeArc({ x: 0, y: 0 }, 5000, 0, 90), makeArc({ x: 0, y: 0 }, 5000, 0, 90.9), 'R5000 arc end 90 -> 90.9 deg');
  notSame(makeEllipse({ x: 0, y: 0 }, { x: 2000, y: 0 }, 0.3), makeEllipse({ x: 0, y: 0 }, { x: 2000, y: 0 }, 1.0), 'ellipse ratio 0.3 -> 1');
  notSame(makeText({ x: 0, y: 0 }, 250, 'SUPPLY AIR DUCT 1'), makeText({ x: 0, y: 0 }, 250, 'SUPPLY AIR DUCT 1', { rot: 2 }), 'text 0 -> 2 deg (about 4 m long)');
  const ins = (sx) => { const d = newDocument(); addBlock(d, 'AHU', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 2000, y: 0 }), makeLine({ x: 0, y: 0 }, { x: 0, y: 1000 })]); addEntity(d, makeInsert('AHU', { x: 500, y: 500 }, { sx, sy: sx })); return d; };
  assert.equal(compareDocs(ins(1), ins(1.05), { tol: 1, expand: false }).same.length, 0, 'insert scale 1 -> 1.05 on a 2 m block');
  assert.equal(compareDocs(ins(1), ins(1.05), { tol: 1 }).same.length, 0, 'expanded too');
  // within tolerance stays same: a 0.01 deg arc end on R5000 (0.9 mm), the same text, the same insert
  assert.deepEqual(verdict(docOf([makeArc({ x: 0, y: 0 }, 5000, 0, 90)]), docOf([makeArc({ x: 0, y: 0 }, 5000, 0, 90.01)])), [1, 0, 0, 0]);
  assert.deepEqual(verdict(ins(1), ins(1)), [2, 0, 0, 0]);
});

test('compare fix: a layer frozen or off in B, or a BYLAYER colour changed in the layer table, is changed; hidden in both is left out', () => {
  const mk = (layer) => { const d = docOf([makeLine({ x: 0, y: 0 }, { x: 1000, y: 0 }, { layer: 'M-DUCT' }), makeCircle({ x: 0, y: 0 }, 50)]); addLayer(d, { name: 'M-DUCT', color: 4, ...layer }); return d; };
  let r = compareDocs(mk({}), mk({ frozen: true }), { tol: 1 });
  assert.deepEqual([r.same.length, r.changed.length], [1, 1]); assert.equal(r.changed[0].why, 'layer hidden');
  assert.deepEqual(verdict(mk({ visible: false }), mk({})), [1, 1, 0, 0]);
  assert.deepEqual(verdict(mk({ color: 4 }), mk({ color: 1 })), [1, 1, 0, 0], 'layer colour 4 -> 1');
  assert.deepEqual(verdict(mk({ frozen: true }), mk({ visible: false })), [1, 0, 0, 0], 'hidden in both: skipped');
  // a block on a frozen layer hides its pieces, even those on visible layers
  const blk = (frozen) => { const d = newDocument(); addLayer(d, { name: 'M-DUCT' }); addLayer(d, { name: 'M-EQPT', frozen }); addBlock(d, 'FAN', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 900, y: 0 }, { layer: 'M-DUCT' })]); addEntity(d, makeInsert('FAN', { x: 0, y: 0 }, { layer: 'M-EQPT' })); return d; };
  assert.deepEqual(verdict(blk(false), blk(true)), [0, 1, 0, 0]);
});

test('compare fix: identity keys do not collide (MTEXT "TAG" on layer "1X" vs "TAG1" on "X")', () => {
  assert.equal(compareDocs(docOf([makeMText({ x: 0, y: 0 }, 250, 'TAG', { layer: '1X', width: 5000 })]), docOf([makeMText({ x: 0, y: 0 }, 250, 'TAG1', { layer: 'X', width: 5000 })]), { tol: 1 }).same.length, 0);
});

// ---- changed (shape/position) vs changed (properties only) ----------------------------------------
import { reclusterCompare } from '../src/core/compare.js';

/** A and B: one moved line, three lines on layer DUCT whose colour is 2 in A and 5 in B (layer table only) */
function propsPair() {
  const mk = (color, dy) => {
    const d = newDocument(); d.units = 4;
    addLayer(d, { name: 'DUCT', color });
    addEntity(d, makeLine({ x: 0, y: dy }, { x: 1000, y: dy }));
    for (const x of [20000, 40000, 60000]) addEntity(d, makeLine({ x, y: 0 }, { x: x + 800, y: 0 }, { layer: 'DUCT' }));
    return d;
  };
  return [mk(2, 0), mk(5, 100)];
}

test('compare: a moved line is changedGeometry, lines whose layer colour changed are changedProps (with the property names)', () => {
  const [a, b] = propsPair();
  const r = compareDocs(a, b);
  assert.equal(r.changedGeometry.length, 1);
  assert.equal(r.changedProps.length, 3);
  assert.equal(r.changed.length, 4); // the union
  assert.equal(r.added.length + r.removed.length, 0);
  assert.ok(r.changedProps.every((p) => p.why === 'props' && p.props.join() === 'color'));
  assert.equal(r.clusters.length, 1); // property-only changes are not clustered by default
  const withProps = compareDocs(a, b, { clusterProps: true });
  assert.ok(withProps.clusters.length >= 2);
  assert.deepEqual(reclusterCompare(a, b, r, true).map((c) => c.changed), withProps.clusters.map((c) => c.changed)); // recluster = same result, no new compare
  assert.equal(reclusterCompare(a, b, r, false).length, 1);
  // the compare drawing: property-only changes on their own layer COMPARE-PROPS, B's version only
  const d = buildCompareDoc(a, b, r);
  assert.equal(d.entities.filter((e) => e.layer === COMPARE_LAYERS.props.name).length, 3);
  assert.equal(d.entities.filter((e) => e.layer === COMPARE_LAYERS.changed.name).length, 1);
  assert.equal(d.layers.get(COMPARE_LAYERS.props.name).color, 4);
});
