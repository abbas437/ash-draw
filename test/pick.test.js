import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as M from '../src/core/model.js';
import { SpatialIndex, pickEntity, selectInBox, findSnap, orthoPoint, polarPoint } from '../src/core/pick.js';

const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol, `x ${p.x} !~ ${x}`); near(p.y, y, tol, `y ${p.y} !~ ${y}`); };
const P = (x, y) => ({ x, y });
const B = (minx, miny, maxx, maxy) => ({ minx, miny, maxx, maxy });
function docWith(...ents) {
  const doc = M.newDocument();
  const out = ents.map((e) => M.addEntity(doc, e));
  return { doc, ents: out, index: new SpatialIndex(doc) };
}
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

test('pickEntity: line, circle, arc, polyline, text', () => {
  const { index, ents: [ln, ci, ar, pl, tx] } = docWith(
    M.makeLine(P(0, 0), P(10, 0)),
    M.makeCircle(P(50, 0), 5),
    M.makeArc(P(100, 0), 5, 0, 90),
    M.makePolyline([P(200, 0), P(210, 0), P(210, 10)]),
    M.makeText(P(300, 0), 2, 'HELLO'),
  );
  assert.equal(pickEntity(index, P(5, 0.3), 0.5), ln);
  assert.equal(pickEntity(index, P(55.2, 0), 0.5), ci);
  assert.equal(pickEntity(index, P(50, 0), 0.5), null, 'circle centre is not on its outline');
  assert.equal(pickEntity(index, P(100, 5.2), 0.5), ar);
  assert.equal(pickEntity(index, P(100, -5), 0.5), null, 'arc does not cover 270 deg');
  assert.equal(pickEntity(index, P(210.3, 5), 0.5), pl);
  assert.equal(pickEntity(index, P(301, 1), 0.5), tx);
  assert.equal(pickEntity(index, P(5, 3), 0.5), null);
});

test('pickEntity: nearest wins, tie goes to topmost, exclude', () => {
  const { index, ents: [a, b, c] } = docWith(
    M.makeLine(P(0, 0), P(10, 0)), M.makeLine(P(0, 0), P(10, 0)), M.makeLine(P(0, 1), P(10, 1)));
  assert.equal(pickEntity(index, P(5, 0.1), 1), b, 'tie -> later entity');
  assert.equal(pickEntity(index, P(5, 0.9), 1), c, 'nearest');
  assert.equal(pickEntity(index, P(5, 0.1), 1, { exclude: new Set([b.id]) }), a);
});

test('pickEntity: hidden / frozen layers and invisible entities are not picked; locked + skipLocked', () => {
  const doc = M.newDocument();
  M.addLayer(doc, { name: 'H', visible: false });
  M.addLayer(doc, { name: 'F', frozen: true });
  M.addLayer(doc, { name: 'L', locked: true });
  M.addEntity(doc, M.makeLine(P(0, 0), P(10, 0), { layer: 'H' }));
  M.addEntity(doc, M.makeLine(P(0, 10), P(10, 10), { layer: 'F' }));
  const inv = M.addEntity(doc, M.makeLine(P(0, 20), P(10, 20))); inv.invisible = true;
  const lk = M.addEntity(doc, M.makeLine(P(0, 30), P(10, 30), { layer: 'L' }));
  const index = new SpatialIndex(doc);
  assert.equal(pickEntity(index, P(5, 0), 1), null);
  assert.equal(pickEntity(index, P(5, 10), 1), null);
  assert.equal(pickEntity(index, P(5, 20), 1), null);
  assert.equal(pickEntity(index, P(5, 30), 1), lk);
  assert.equal(pickEntity(index, P(5, 30), 1, { skipLocked: true }), null);
  assert.deepEqual(selectInBox(index, B(-1, 25, 11, 35), false), [lk.id]);
  assert.deepEqual(selectInBox(index, B(-1, 25, 11, 35), false, { skipLocked: true }), []);
  // custom visibility predicate
  const all = new SpatialIndex(doc, { isVisible: () => true });
  assert.equal(pickEntity(all, P(5, 0), 1).layer, 'H');
});

test('selectInBox: window vs crossing', () => {
  const { index, ents: [small, long, circ, far] } = docWith(
    M.makeLine(P(1, 1), P(2, 2)),
    M.makeLine(P(-100, 5), P(100, 5)),
    M.makeCircle(P(5, 5), 50),
    M.makeLine(P(500, 500), P(600, 600)),
  );
  const box = B(0, 0, 10, 10);
  assert.deepEqual(selectInBox(index, box, false), [small.id]);
  const cr = selectInBox(index, box, true);
  assert.ok(cr.includes(small.id) && cr.includes(long.id), 'long line crossing the box is crossing-selected');
  assert.ok(!cr.includes(circ.id), 'circle containing the box without touching is not selected');
  assert.ok(!cr.includes(far.id));
  // reversed corners (right-to-left drag) are normalised; a box that cuts the circle selects it
  assert.ok(selectInBox(index, B(60, 10, 40, 0), true).includes(circ.id));
  // bbox overlaps but geometry misses: diagonal line whose bbox covers the box corner
  const d = docWith(M.makeLine(P(0, 20), P(20, 0)));
  assert.deepEqual(selectInBox(d.index, B(0, 0, 5, 5), true), []);
  assert.deepEqual(selectInBox(d.index, B(0, 0, 11, 11), true), [d.ents[0].id]);
});

test('findSnap: end, mid, cen, quad, int, per, near, ins, node', () => {
  const { index, ents: [l1, l2, c, pt, tx] } = docWith(
    M.makeLine(P(0, 0), P(10, 10)),
    M.makeLine(P(0, 10), P(10, 0)),
    M.makeCircle(P(50, 0), 5),
    M.makePoint(P(80, 0)),
    M.makeText(P(100, 0), 2, 'T'),
  );
  const s = (p, o) => findSnap(index, p, 0.5, o);
  assert.deepEqual(s(P(10.2, 10.1)), { x: 10, y: 10, kind: 'end', id: l1.id });
  assert.equal(s(P(2.6, 2.4), { kinds: new Set(['mid']) }), null, 'kinds filter: no midpoint near (2.6,2.4)');
  const i = s(P(5.2, 5.1)); assert.equal(i.kind, 'int'); nearPt(i, 5, 5, 1e-9);
  const mid = s(P(5.2, 5.1), { kinds: new Set(['mid']) }); assert.equal(mid.kind, 'mid'); nearPt(mid, 5, 5);
  assert.deepEqual(s(P(50.1, 0.2)), { x: 50, y: 0, kind: 'cen', id: c.id });
  const q = s(P(55.2, 0.1)); assert.equal(q.kind, 'quad'); nearPt(q, 55, 0);
  assert.deepEqual(s(P(80.1, 0)), { x: 80, y: 0, kind: 'node', id: pt.id });
  assert.deepEqual(s(P(100.1, 0.1)), { x: 100, y: 0, kind: 'ins', id: tx.id });
  // perpendicular from (0,5) onto l1 (y=x): foot (2.5,2.5)
  const per = s(P(2.6, 2.6), { from: P(0, 5), kinds: new Set(['per', 'near']) });
  assert.equal(per.kind, 'per'); nearPt(per, 2.5, 2.5);
  // perpendicular onto circle from outside: foot on the circle towards `from`
  const pc = s(P(45.1, 0), { from: P(0, 0) }); // quad (45,0) is also there and outranks per
  assert.equal(pc.kind, 'quad');
  const pc2 = s(P(45.1, 0), { from: P(0, 0), kinds: new Set(['per']) }); nearPt(pc2, 45, 0);
  const nr = s(P(3, 3.2)); assert.equal(nr.kind, 'near'); nearPt(nr, 3.1, 3.1);
});

test('findSnap: priority end beats near; exclude; nothing in range', () => {
  const { index, ents: [a, b] } = docWith(M.makeLine(P(0, 0), P(10, 0)), M.makeLine(P(0.3, -5), P(0.3, 7)));
  // at (0.2,0.1): end of a (0,0) at d=.22, near on b (0.3,0.1) at d=.1, int (0.3,0) at d=.14 -> end wins
  assert.deepEqual(findSnap(index, P(0.2, 0.1), 0.5), { x: 0, y: 0, kind: 'end', id: a.id });
  const ex = findSnap(index, P(0.2, 0.1), 0.5, { exclude: new Set([a.id]) });
  assert.equal(ex.kind, 'near'); assert.equal(ex.id, b.id);
  assert.equal(findSnap(index, P(50, 50), 0.5), null);
});

test('findSnap: INSERT snaps to its insertion point and to exploded block geometry', () => {
  const doc = M.newDocument();
  M.addBlock(doc, 'B', P(0, 0), [M.makeLine(P(1, 0), P(4, 0))]);
  const ins = M.addEntity(doc, M.makeInsert('B', P(100, 100), { rot: 90 }));
  const index = new SpatialIndex(doc);
  assert.deepEqual(findSnap(index, P(100.1, 100), 0.5), { x: 100, y: 100, kind: 'ins', id: ins.id });
  const e = findSnap(index, P(100.1, 104.1), 0.5); assert.equal(e.kind, 'end'); assert.equal(e.id, ins.id); nearPt(e, 100, 104, 1e-9);
  assert.equal(pickEntity(index, P(100.2, 102), 0.5), ins);
});

test('orthoPoint and polarPoint', () => {
  assert.deepEqual(orthoPoint(P(1, 1), P(5, 2)), { x: 5, y: 1 });
  assert.deepEqual(orthoPoint(P(1, 1), P(2, -6)), { x: 1, y: -6 });
  const a = polarPoint(P(0, 0), P(10, 0.5), 15);
  assert.equal(a.snapped, true); assert.equal(a.angle, 0); nearPt(a, Math.hypot(10, 0.5), 0);
  const b = polarPoint(P(1, 1), P(1 + 10 * Math.cos(47 * Math.PI / 180), 1 + 10 * Math.sin(47 * Math.PI / 180)), 45);
  assert.equal(b.snapped, true); near(b.angle, 45); nearPt(b, 1 + 10 * Math.SQRT1_2, 1 + 10 * Math.SQRT1_2, 1e-9);
  const c = polarPoint(P(0, 0), P(10, 3), 45); // 16.7 deg: 16.7 from 0, not within 5
  assert.equal(c.snapped, false); assert.deepEqual([c.x, c.y], [10, 3]); near(c.angle, Math.atan2(3, 10) * 180 / Math.PI);
  const d = polarPoint(P(0, 0), P(10, -0.5), 90); // -2.86 deg -> snaps to 0 (=360)
  assert.equal(d.snapped, true); assert.equal(d.angle, 0); nearPt(d, Math.hypot(10, 0.5), 0, 1e-9);
  const e = polarPoint(P(0, 0), P(-0.5, -10), 90); // ~267.1 -> 270
  assert.equal(e.snapped, true); assert.equal(e.angle, 270); nearPt(e, 0, -Math.hypot(0.5, 10), 1e-9);
  assert.equal(polarPoint(P(0, 0), P(0, 0), 15).snapped, false);
});

test('SpatialIndex.update after Session-like object replacement, removal and addition', () => {
  const { doc, index, ents: [ln, other] } = docWith(M.makeLine(P(0, 0), P(10, 0)), M.makeLine(P(0, 50), P(10, 50)));
  const i = doc.entities.indexOf(ln);
  doc.entities[i] = { ...ln, p1: P(5000, 5000), p2: P(5010, 5000) }; // new object, same id, same position
  index.update([ln.id]);
  assert.deepEqual(index.query(B(-1, -1, 11, 1)), []);
  assert.deepEqual(index.query(B(4999, 4999, 5011, 5001)).map((e) => e.id), [ln.id]);
  assert.equal(pickEntity(index, P(5005, 5000), 1), doc.entities[i]);
  // removal
  doc.entities = doc.entities.filter((e) => e.id !== other.id);
  index.update([other.id]);
  assert.deepEqual(index.query(B(-1, 49, 11, 51)), []);
  // addition far outside the original extents
  const n = M.addEntity(doc, M.makeLine(P(-9000, -9000), P(-8990, -9000)));
  index.update([n.id]);
  assert.equal(pickEntity(index, P(-8995, -9000), 1), n);
  assert.deepEqual(index.query(B(-1e6, -1e6, 1e6, 1e6)).map((e) => e.id).sort(), [ln.id, n.id].sort());
});

test('SpatialIndex: oversize entities, cached bbox, empty doc, NaN coordinates', () => {
  const doc = M.newDocument();
  const r = rng(7);
  for (let k = 0; k < 2000; k++) M.addEntity(doc, M.makeLine(P(r() * 100, r() * 100), P(r() * 100 + 1, r() * 100)));
  const huge = M.addEntity(doc, M.makeLine(P(-1e6, -1e6), P(1e6, 1e6)));
  const bad = M.addEntity(doc, M.makeLine(P(NaN, 0), P(1, 1)));
  const index = new SpatialIndex(doc);
  assert.ok(index._oversize.some((en) => en.e === huge), 'huge entity is in the oversize list');
  assert.ok(index.query(B(500, 500, 501, 501)).includes(huge));
  assert.equal(pickEntity(index, P(500, 500), 0.1), huge);
  assert.equal(index.bboxOf(huge), index.bboxOf(huge), 'cached object');
  assert.equal(index.bboxOf(bad), null);
  assert.doesNotThrow(() => { pickEntity(index, P(0.5, 0.5), 1); findSnap(index, P(0.5, 0.5), 1); selectInBox(index, B(-1, -1, 2, 2), true); });

  const empty = new SpatialIndex(M.newDocument());
  assert.equal(pickEntity(empty, P(0, 0), 1), null);
  assert.equal(findSnap(empty, P(0, 0), 1), null);
  assert.deepEqual(selectInBox(empty, B(-1, -1, 1, 1), true), []);
  assert.deepEqual(empty.query(B(-1, -1, 1, 1)), []);
  empty.update([42]);
  const nanOnly = M.newDocument(); M.addEntity(nanOnly, M.makeCircle(P(NaN, NaN), 1));
  const ni = new SpatialIndex(nanOnly);
  assert.equal(pickEntity(ni, P(0, 0), 1), null);
  assert.equal(findSnap(ni, P(0, 0), 1), null);
});

test('performance: 20,000 lines, findSnap and pickEntity', () => {
  const doc = M.newDocument();
  const r = rng(12345);
  for (let k = 0; k < 20000; k++) {
    const x = r() * 2000, y = r() * 2000, a = r() * Math.PI * 2, l = 1 + r() * 20;
    M.addEntity(doc, M.makeLine(P(x, y), P(x + l * Math.cos(a), y + l * Math.sin(a))));
  }
  let t = performance.now();
  const index = new SpatialIndex(doc);
  const build = performance.now() - t;
  const pts = Array.from({ length: 200 }, () => P(r() * 2000, r() * 2000));
  const tol = 3; // e.g. 6 px at zoom 2
  t = performance.now();
  let hits = 0;
  for (const p of pts) if (findSnap(index, p, tol)) hits++;
  const snapMs = (performance.now() - t) / pts.length;
  t = performance.now();
  for (const p of pts) pickEntity(index, p, tol);
  const pickMs = (performance.now() - t) / pts.length;
  console.log(`# index build ${build.toFixed(1)} ms; findSnap ${snapMs.toFixed(3)} ms/call (${hits} hits); pickEntity ${pickMs.toFixed(3)} ms/call`);
  assert.ok(hits > 0);
  assert.ok(snapMs < 25, `findSnap ${snapMs} ms`);
  assert.ok(pickMs < 10, `pickEntity ${pickMs} ms`);
});
