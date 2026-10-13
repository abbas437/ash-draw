import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { bboxOf, transformEntity, rotation, translation, clipInfinite, intersections, nearestPoint, snapPoints } from '../src/core/geom.js';
import { buildScene, infiniteItem } from '../src/core/render.js';
import { SpatialIndex, pickEntity, findSnap, selectInBox } from '../src/core/pick.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearPt = (p, q, eps = 1e-9) => { near(p.x, q.x, eps); near(p.y, q.y, eps); };

function sample() {
  const doc = M.newDocument();
  M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 10, y: 5 }));
  M.addEntity(doc, M.makeXline('XLINE', { x: 2, y: 3 }, { x: 3, y: 4 }, { layer: '0', color: 1 }));
  M.addEntity(doc, M.makeXline('RAY', { x: -1, y: 1 }, { x: 0, y: -2 }));
  return doc;
}

test('XLINE / RAY: DXF read -> write -> read keeps type, base point and unit direction', () => {
  const back = parseDxf(writeDxf(parseDxf(writeDxf(sample()))));
  const xl = back.entities.find((e) => e.type === 'XLINE'), ray = back.entities.find((e) => e.type === 'RAY');
  assert.ok(xl && ray, 'both kept');
  nearPt(xl.p, { x: 2, y: 3 }); nearPt(xl.dir, { x: 0.6, y: 0.8 });
  nearPt(ray.p, { x: -1, y: 1 }); nearPt(ray.dir, { x: 0, y: -1 });
  assert.equal(xl.color, 1);
  const text = writeDxf(sample());
  assert.match(text, /\nAcDbXline\r?\n/); assert.match(text, /\nAcDbRay\r?\n/);
});

test('XLINE / RAY stay out of the extents: scene bbox (zoom extents) and bboxOf equal the line\'s', () => {
  const doc = sample();
  assert.equal(bboxOf(doc.entities[1]), null);
  assert.equal(bboxOf(doc.entities[2]), null);
  assert.deepEqual(buildScene(doc).bbox, { minx: 0, miny: 0, maxx: 10, maxy: 5 });
});

test('transform: rotate 90 degrees turns the direction, moves the base point', () => {
  const xl = sample().entities[1];
  const r = transformEntity(xl, rotation(Math.PI / 2));
  nearPt(r.p, { x: -3, y: 2 }); nearPt(r.dir, { x: -0.8, y: 0.6 });
  const t = transformEntity(xl, translation(5, 0));
  nearPt(t.p, { x: 7, y: 3 }); nearPt(t.dir, xl.dir);
});

test('clipping: a ray starts at its base point, an xline spans the box edge to edge', () => {
  const box = { minx: -10, miny: -10, maxx: 10, maxy: 10 };
  const [a, b] = clipInfinite({ x: 1, y: 2 }, { x: 1, y: 0 }, true, box);
  nearPt(a, { x: 1, y: 2 }); nearPt(b, { x: 10, y: 2 });
  const [c, d] = clipInfinite({ x: 1, y: 2 }, { x: 1, y: 0 }, false, box);
  nearPt(c, { x: -10, y: 2 }); nearPt(d, { x: 10, y: 2 });
  assert.equal(clipInfinite({ x: 20, y: 0 }, { x: 1, y: 0 }, true, box), null, 'a ray pointing away misses');
  // far from the origin (UTM): the clipped ends are as precise as the box
  const utm = { minx: 512000, miny: 2700000, maxx: 512100, maxy: 2700100 };
  const [e, f] = clipInfinite({ x: 512050.123456, y: 2700050.654321 }, { x: 0, y: 1 }, false, utm);
  nearPt(e, { x: 512050.123456, y: 2700000 }, 1e-9); nearPt(f, { x: 512050.123456, y: 2700100 }, 1e-9);
  // the scene item: a per-view copy, the shared item unchanged
  const it = buildScene(sample()).items.find((i) => i.inf && i.inf.ray);
  const v = infiniteItem(it, box);
  assert.deepEqual(v.ops.slice(1, 3), [-1, 1]);
  assert.deepEqual(it.ops, []);
});

test('pick and snap: near / int / end on the visible part', () => {
  const doc = sample();
  const index = new SpatialIndex(doc, { isVisible: () => true });
  const xl = doc.entities[1], ray = doc.entities[2];
  assert.equal(pickEntity(index, { x: 2 + 300 * 0.6 + 0.01, y: 3 + 300 * 0.8 }, 0.1), xl, 'far along the xline');
  assert.equal(pickEntity(index, { x: -1, y: 1.5 }, 0.1), null, 'behind the ray');
  nearPt(nearestPoint(ray, { x: -1, y: 5 }), { x: -1, y: 1 });
  assert.deepEqual(snapPoints(ray).map((q) => q.kind), ['end']);
  const hits = intersections(xl, ray); // (2,3)+t(0.6,0.8) at t=-5: (-1,-1), forward of the ray
  assert.equal(hits.length, 1); nearPt(hits[0], { x: -1, y: -1 });
  assert.equal(intersections(ray, M.makeLine({ x: -2, y: 2 }, { x: 0, y: 2 })).length, 0, 'behind the ray');
  const s = findSnap(index, { x: -1.02, y: 0.98 }, 0.1, { kinds: new Set(['end']) });
  nearPt(s, { x: -1, y: 1 });
  // ray x=-1 downwards meets the xline (2,3)+t(0.6,0.8) at t=-5: (-1,-1)
  const i = findSnap(index, { x: -1.01, y: -1.02 }, 0.1, { kinds: new Set(['int']) });
  nearPt(i, { x: -1, y: -1 }, 1e-9);
  assert.deepEqual(selectInBox(index, { minx: -2, miny: -20, maxx: 0, maxy: -10 }, true), [ray.id]);
});
