import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { gripsOf, applyGrip, gripEdit, editEntity, matchProps, bulgeThrough } from '../renderer/grips.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol); near(p.y, y, tol); };

test('line grips: ends stretch, midpoint moves the line', () => {
  const l = M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  assert.deepEqual(gripsOf(l).map((g) => g.kind), ['end', 'end', 'mid']);
  nearPt(applyGrip(l, 1, { x: 10, y: 5 }).p2, 10, 5);
  const m = applyGrip(l, 2, { x: 5, y: 3 });
  nearPt(m.p1, 0, 3); nearPt(m.p2, 10, 3);
  nearPt(l.p2, 10, 0); // original untouched
});

test('circle grips: centre moves, quadrant sets the radius', () => {
  const c = M.makeCircle({ x: 1, y: 1 }, 2);
  const g = gripsOf(c);
  assert.equal(g.length, 5); nearPt(g[1], 3, 1); nearPt(g[2], 1, 3);
  near(applyGrip(c, 2, { x: 1, y: 6 }).r, 5);
  nearPt(applyGrip(c, 0, { x: 4, y: 4 }).c, 4, 4);
});

test('arc grips: midpoint changes the radius and keeps the ends; end grip stretches', () => {
  const a = M.makeArc({ x: 0, y: 0 }, 10, 0, 180);
  const g = gripsOf(a);
  nearPt(g[0], 10, 0); nearPt(g[1], -10, 0); nearPt(g[2], 0, 10); nearPt(g[3], 0, 0);
  const b = applyGrip(a, 2, { x: 0, y: 5 });
  const gb = gripsOf(b);
  nearPt(gb[0], 10, 0, 1e-9); nearPt(gb[1], -10, 0, 1e-9); nearPt(gb[2], 0, 5, 1e-9);
  near(b.r, 12.5);
  const e = applyGrip(a, 1, { x: 0, y: -10 }); // end dragged round through the old midpoint
  nearPt(gripsOf(e)[1], 0, -10, 1e-9); nearPt(gripsOf(e)[0], 10, 0, 1e-9);
});

test('polyline grips: vertex stretch, straight segment moves, bulged segment changes bulge', () => {
  const p = M.makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.deepEqual(gripsOf(p).map((g) => g.kind), ['vtx', 'vtx', 'vtx', 'seg', 'seg']);
  nearPt(applyGrip(p, 1, { x: 12, y: 1 }).vertices[1], 12, 1);
  const s = applyGrip(p, 3, { x: 5, y: 2 });
  nearPt(s.vertices[0], 0, 2); nearPt(s.vertices[1], 10, 2); nearPt(s.vertices[2], 10, 10);
  const q = M.makePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }]);
  nearPt(gripsOf(q)[2], 1, -1); // bulge 1 = CCW half circle below the chord
  near(bulgeThrough({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: -1 }), 1);
  const r = applyGrip(q, 2, { x: 1, y: 1 });
  near(r.vertices[0].bulge, -1); nearPt(gripsOf(r)[2], 1, 1);
});

test('ellipse and text grips', () => {
  const e = M.makeEllipse({ x: 0, y: 0 }, { x: 4, y: 0 }, 0.5);
  const g = gripsOf(e);
  nearPt(g[1], 4, 0); nearPt(g[3], 0, 2);
  near(applyGrip(e, 3, { x: 0, y: 3 }).ratio, 0.75);
  const m = applyGrip(e, 1, { x: 8, y: 0 }); near(m.major.x, 8); near(m.ratio, 0.25);
  const t = M.makeText({ x: 1, y: 1 }, 2.5, 'A');
  nearPt(applyGrip(t, 0, { x: 3, y: 4 }).p, 3, 4);
  assert.deepEqual(gripsOf(M.makeHatch([])), []);
});

test('gripEdit / editEntity are one undo step each', () => {
  const doc = M.newDocument(); const s = new Session(doc);
  const l = M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
  assert.ok(gripEdit(s, l.id, 0, { x: -5, y: 0 }));
  nearPt(doc.entities[0].p1, -5, 0);
  assert.ok(editEntity(s, l.id, (c) => { c.p2.y = 7; return c; }));
  assert.equal(s.undoStack.length, 2);
  s.undo(); nearPt(doc.entities[0].p2, 10, 0);
  s.undo(); nearPt(doc.entities[0].p1, 0, 0);
});

test('matchProps copies layer/colour/linetype/ltscale/lineweight and text height/style', () => {
  const src = M.makeText({ x: 0, y: 0 }, 5, 'S', { layer: 'A', color: 1, linetype: 'DASHED', lineweight: 0.5, ltscale: 2, style: 'ROMANS' });
  const dst = M.makeText({ x: 9, y: 9 }, 2, 'D', { layer: 'B', color: 5 });
  const r = matchProps(src, dst);
  assert.deepEqual([r.layer, r.color, r.linetype, r.lineweight, r.ltscale, r.height, r.style, r.text], ['A', 1, 'DASHED', 0.5, 2, 5, 'ROMANS', 'D']);
  const line = matchProps(src, M.makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }));
  assert.equal(line.height, undefined); assert.equal(line.layer, 'A');
});

test('INSERT placement edits (properties, grips) carry the attributes with them', async () => {
  const { makeAttdef, makeBlock, instantiate } = await import('../src/core/blocks.js');
  const doc = M.newDocument();
  const s = new Session(doc);
  const { block } = makeBlock(doc, 'TB', [M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), makeAttdef({ x: 2, y: 1 }, 1, 'TAG1', { default: 'X' })], { x: 0, y: 0 });
  s.transact('Block', (tx) => { tx.block('TB', block); });
  const ins = instantiate(block, { x: 100, y: 0 }, { values: { TAG1: 'A' } });
  s.transact('Insert', (tx) => { tx.add(ins); });
  const id = doc.entities.at(-1).id;
  nearPt(doc.entities.at(-1).attribs[0].p, 102, 1);
  editEntity(s, id, (c) => { c.rot = 90; return c; });
  const a = M.getEntity(doc, id).attribs[0];
  nearPt(a.p, 99, 2); near(a.rot, 90); assert.equal(a.text, 'A'); assert.equal(a.attrib.tag, 'TAG1');
  editEntity(s, id, (c) => { c.sx = 2; c.sy = 2; return c; });
  nearPt(M.getEntity(doc, id).attribs[0].p, 98, 4); near(M.getEntity(doc, id).attribs[0].height, 2);
  gripEdit(s, id, 0, { x: 0, y: 0 });
  nearPt(M.getEntity(doc, id).attribs[0].p, -2, 4);
  s.undo();
  nearPt(M.getEntity(doc, id).attribs[0].p, 98, 4);
});

test('ordinate dimension grips: feature point and leader end are editable, the text grip moves the leader end', async () => {
  const { createDimension } = await import('../src/core/dims.js');
  const { newDocument } = await import('../src/core/model.js');
  const doc = newDocument();
  const e = createDimension(doc, { kind: 'ordinate', feature: { x: 10, y: 5 }, end: { x: 10, y: 25 }, xType: true });
  const g = gripsOf(e);
  assert.deepEqual(g.slice(0, 2).map((q) => [q.x, q.y]), [[10, 5], [10, 25]]);
  assert.deepEqual(applyGrip(e, 0, { x: 12, y: 5 }).def.feature, { x: 12, y: 5 });
  assert.deepEqual(applyGrip(e, 1, { x: 12, y: 30 }).def.end, { x: 12, y: 30 });
  assert.deepEqual(applyGrip(e, g.length - 1, { x: e.p.x + 3, y: e.p.y }).def.end, { x: 13, y: 25 });
});
