import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/model.js';
import { Session, trimCommand, extendCommand } from '../src/core/edit.js';
import { gripsOf, applyGrip, XLINE_GRIP_DIST } from '../renderer/grips.js';
import { stretch } from '../src/core/modify.js';
import { trimEntity, extendEntity, offsetEntity } from '../src/core/geom.js';

const H = Math.SQRT1_2;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol); near(p.y, y, tol); };
const xl = (p, d) => M.makeXline('XLINE', p, d);
const ray = (p, d) => M.makeXline('RAY', p, d);
const vline = (x) => M.makeLine({ x, y: -5 }, { x, y: 5 });

test('XLINE grips: base, then +/- the grip distance along the line; RAY: base and one forward grip', () => {
  const D = XLINE_GRIP_DIST;
  const g = gripsOf(xl({ x: 1, y: 2 }, { x: 1, y: 0 }));
  assert.equal(g.length, 3);
  nearPt(g[0], 1, 2); nearPt(g[1], 1 + D, 2); nearPt(g[2], 1 - D, 2);
  const r = gripsOf(ray({ x: 0, y: 0 }, { x: 0, y: 1 }));
  assert.equal(r.length, 2);
  nearPt(r[0], 0, 0); nearPt(r[1], 0, D);
});

test('XLINE / RAY grips: the base grip moves the line; a direction grip turns it about the base', () => {
  const e = xl({ x: 1, y: 2 }, { x: 1, y: 0 });
  const m = applyGrip(e, 0, { x: 5, y: 5 });
  nearPt(m.p, 5, 5); nearPt(m.dir, 1, 0);
  const f = applyGrip(e, 1, { x: 4, y: 5 }); // forward grip to (4,5): dir from the base towards it
  nearPt(f.p, 1, 2); nearPt(f.dir, H, H);
  const b = applyGrip(e, 2, { x: 4, y: 5 }); // backward grip to (4,5): the line now runs from (4,5) through the base
  nearPt(b.p, 1, 2); nearPt(b.dir, -H, -H);
  const r = applyGrip(ray({ x: 0, y: 0 }, { x: 0, y: 1 }), 1, { x: -3, y: 0 });
  nearPt(r.p, 0, 0); nearPt(r.dir, -1, 0);
  assert.equal(applyGrip(e, 1, { x: 1, y: 2 }), null, 'grip dropped on the base: no direction');
  nearPt(e.dir, 1, 0); // original untouched
});

test('STRETCH moves an XLINE / RAY base point only when it is inside the window; direction kept', () => {
  const e = { ...xl({ x: 1, y: 1 }, { x: H, y: H }), id: 7 };
  const r = stretch([e], { minx: 0, miny: 0, maxx: 2, maxy: 2 }, 3, -1);
  assert.equal(r.change.length, 1);
  assert.equal(r.change[0].id, 7);
  nearPt(r.change[0].p, 4, 0); nearPt(r.change[0].dir, H, H);
  assert.equal(stretch([e], { minx: 5, miny: 5, maxx: 9, maxy: 9 }, 3, -1).change.length, 0, 'line crosses the window but base outside');
  const s = stretch([{ ...ray({ x: 1, y: 1 }, { x: 1, y: 0 }), id: 8 }], { minx: 0, miny: 0, maxx: 2, maxy: 2 }, 0, 2).change[0];
  assert.equal(s.type, 'RAY'); nearPt(s.p, 1, 3); nearPt(s.dir, 1, 0);
});

test('TRIM an XLINE at one cutting edge: the picked side goes, a RAY from the cut remains', () => {
  const e = { ...xl({ x: 0, y: 0 }, { x: 1, y: 0 }), id: 5, layer: 'A' };
  const r = trimEntity(e, [vline(5)], { x: 9, y: 0 });
  assert.equal(r.replace.length, 1);
  const [k] = r.replace;
  assert.equal(k.type, 'RAY'); assert.equal(k.id, 5); assert.equal(k.layer, 'A');
  nearPt(k.p, 5, 0); nearPt(k.dir, -1, 0);
  const l = trimEntity(e, [vline(5)], { x: -9, y: 0 }).replace[0];
  assert.equal(l.type, 'RAY'); nearPt(l.p, 5, 0); nearPt(l.dir, 1, 0);
});

test('TRIM an XLINE between two edges -> two RAYs; then the far side of a RAY -> LINE, the near side moves its base', () => {
  const e = { ...xl({ x: 0, y: 0 }, { x: 1, y: 0 }), id: 5 };
  const cut = [vline(2), vline(8)];
  const mid = trimEntity(e, cut, { x: 5, y: 0 }).replace;
  assert.deepEqual(mid.map((o) => o.type), ['RAY', 'RAY']);
  nearPt(mid[0].p, 2, 0); nearPt(mid[0].dir, -1, 0); nearPt(mid[1].p, 8, 0); nearPt(mid[1].dir, 1, 0);
  // XLINE cut at both edges in turn: right of 8 first (RAY from 8 running left), then left of 2 -> LINE 8..2
  const r1 = trimEntity(e, cut, { x: 12, y: 0 }).replace[0];
  assert.equal(r1.type, 'RAY'); nearPt(r1.p, 8, 0); nearPt(r1.dir, -1, 0);
  const l = trimEntity(r1, cut, { x: -5, y: 0 }).replace;
  assert.equal(l.length, 1); assert.equal(l[0].type, 'LINE'); assert.equal(l[0].id, 5);
  nearPt(l[0].p1, 8, 0); nearPt(l[0].p2, 2, 0);
  assert.ok(!('p' in l[0]) && !('dir' in l[0]), 'no ray fields left on the LINE');
  const near1 = trimEntity(r1, cut, { x: 6, y: 0 }).replace; // between the base and the first cut: base moves
  assert.equal(near1.length, 1); assert.equal(near1[0].type, 'RAY'); nearPt(near1[0].p, 2, 0); nearPt(near1[0].dir, -1, 0);
});

test('TRIM through a session: the XLINE is replaced by a RAY in place (one undo step)', () => {
  const doc = M.newDocument(); const s = new Session(doc);
  const x = M.addEntity(doc, M.makeXline('XLINE', { x: 0, y: 0 }, { x: 1, y: 0 }));
  const c = M.addEntity(doc, vline(5));
  assert.equal(trimCommand(s, x.id, [c.id], { x: 9, y: 0 }).done, 1);
  const now = M.getEntity(doc, x.id);
  assert.equal(now.type, 'RAY'); nearPt(now.p, 5, 0); nearPt(now.dir, -1, 0);
  s.undo();
  assert.equal(M.getEntity(doc, x.id).type, 'XLINE');
});

test('XLINE / RAY as cutting edges and boundaries for a LINE', () => {
  const line = M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const t = trimEntity(line, [xl({ x: 4, y: 3 }, { x: 0, y: 1 })], { x: 8, y: 0 }).replace;
  assert.equal(t.length, 1); nearPt(t[0].p1, 0, 0); nearPt(t[0].p2, 4, 0);
  const t2 = trimEntity(line, [ray({ x: 6, y: 5 }, { x: 0, y: -1 })], { x: 1, y: 0 }).replace;
  nearPt(t2[0].p1, 6, 0); nearPt(t2[0].p2, 10, 0);
  assert.equal(trimEntity(line, [ray({ x: 6, y: 5 }, { x: 0, y: 1 })], { x: 1, y: 0 }), null, 'a RAY pointing away does not cut');
  const x = extendEntity(line, [xl({ x: 15, y: -40 }, { x: 0, y: 1 })], { x: 9, y: 0 });
  nearPt(x.p1, 0, 0); nearPt(x.p2, 15, 0);
  const doc = M.newDocument(); const s = new Session(doc);
  const l = M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
  const b = M.addEntity(doc, M.makeXline('RAY', { x: -3, y: 9 }, { x: 0, y: -1 }));
  assert.equal(extendCommand(s, l.id, [b.id], { x: 1, y: 0 }).done, 1);
  nearPt(M.getEntity(doc, l.id).p1, -3, 0);
});

test('OFFSET an XLINE / RAY: a parallel one at the distance on the picked side', () => {
  const e = { ...xl({ x: 1, y: 1 }, { x: H, y: H }), id: 4 };
  const o = offsetEntity(e, 2, { x: 0, y: 5 });
  assert.equal(o.type, 'XLINE'); assert.equal(o.id, 0);
  nearPt(o.dir, H, H); nearPt(o.p, 1 - 2 * H, 1 + 2 * H);
  const r = offsetEntity(ray({ x: 0, y: 0 }, { x: 1, y: 0 }), 3, { x: 4, y: -1 });
  assert.equal(r.type, 'RAY'); nearPt(r.p, 0, -3); nearPt(r.dir, 1, 0);
});
