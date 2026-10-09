import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/core/geom.js';
import * as M from '../src/core/model.js';

const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} !~ ${b}`);
const nearPt = (p, x, y, tol = 1e-9) => { near(p.x, x, tol, `x ${p.x} !~ ${x}`); near(p.y, y, tol, `y ${p.y} !~ ${y}`); };

test('matrices: compose, invert, rotation, mirror', () => {
  const m = G.compose(G.translation(5, 1), G.rotation(Math.PI / 2));
  nearPt(G.apply(m, { x: 1, y: 0 }), 5, 2);
  const inv = G.invert(m);
  nearPt(G.apply(inv, G.apply(m, { x: 3, y: -4 })), 3, -4);
  const mir = G.mirrorLine({ x: 0, y: 0 }, { x: 0, y: 1 });
  nearPt(G.apply(mir, { x: 2, y: 3 }), -2, 3);
  const mir45 = G.mirrorLine({ x: 0, y: 0 }, { x: 1, y: 1 });
  nearPt(G.apply(mir45, { x: 2, y: 0 }), 0, 2);
  assert.throws(() => G.invert([1, 2, 2, 4, 0, 0]));
});

test('bulge arcs', () => {
  const a = G.bulgeToArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 1);
  nearPt(a.c, 1, 0); near(a.r, 1); near(a.sweep, Math.PI); near(G.normAngle(a.a0), Math.PI);
  const b = G.bulgeToArc({ x: 0, y: 0 }, { x: 2, y: 0 }, -1);
  nearPt(b.c, 1, 0); near(b.sweep, -Math.PI);
  near(G.arcToBulge(Math.PI), 1);
  // polyline with bulge tessellates through the arc's far point
  const pl = M.makePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }]);
  const pts = G.tessellate(pl)[0];
  const lowest = Math.min(...pts.map((p) => p.y));
  near(lowest, -1, 2e-3, 'bulge arc dips to y=-1');
  nearPt(G.bboxOf(pl) ? { x: G.bboxOf(pl).minx, y: G.bboxOf(pl).miny } : { x: 9, y: 9 }, 0, -1, 1e-9);
});

test('tessellate and bbox of basic shapes', () => {
  const c = M.makeCircle({ x: 5, y: 5 }, 2);
  const b = G.bboxOf(c);
  near(b.minx, 3, 1e-6); near(b.maxx, 7, 1e-6); near(b.miny, 3, 1e-6); near(b.maxy, 7, 1e-6);
  const arc = M.makeArc({ x: 0, y: 0 }, 1, 350, 10); // wraps through 0 deg
  const ab = G.bboxOf(arc);
  assert.ok(ab.maxx > 0.99 && ab.minx > 0.98 && ab.maxy < 0.2);
  const el = M.makeEllipse({ x: 0, y: 0 }, { x: 4, y: 0 }, 0.5);
  const eb = G.bboxOf(el);
  near(eb.maxx, 4, 1e-6); near(eb.maxy, 2, 1e-6);
  const sp = M.makeSpline({ degree: 3, ctrl: [{ x: 0, y: 0 }, { x: 3, y: 6 }, { x: 6, y: -2 }, { x: 9, y: 5 }, { x: 12, y: 0 }], knots: [0, 0, 0, 0, 1, 2, 2, 2, 2] });
  const pts = G.tessellate(sp)[0];
  nearPt(pts[0], 0, 0, 1e-6); nearPt(pts[pts.length - 1], 12, 0, 1e-6);
});

test('transformEntity: mirrored arc keeps its sweep on the same side', () => {
  const arc = M.makeArc({ x: 0, y: 0 }, 5, 0, 90);
  const t = G.transformEntity(arc, G.mirrorLine({ x: 0, y: 0 }, { x: 0, y: 1 }));
  near(t.a0, 90, 1e-9); near(t.a1, 180, 1e-9); near(t.r, 5);
  const rot = G.transformEntity(arc, G.rotation(Math.PI / 2));
  near(rot.a0, 90, 1e-9); near(rot.a1, 180, 1e-9);
});

test('transformEntity: polyline bulge sign flips on mirror, text rotates, insert decomposes', () => {
  const pl = M.makePolyline([{ x: 0, y: 0, bulge: 0.5 }, { x: 4, y: 0 }]);
  const t = G.transformEntity(pl, G.scaling(-1, 1));
  near(t.vertices[0].bulge, -0.5); nearPt(t.vertices[1], -4, 0);
  const txt = M.makeText({ x: 1, y: 1 }, 2, 'hi');
  const rt = G.transformEntity(txt, G.rotation(Math.PI / 2));
  near(rt.rot, 90, 1e-9); near(rt.height, 2);
  const ins = M.makeInsert('B', { x: 1, y: 0 }, { sx: 2, sy: 2 });
  const ti = G.transformEntity(ins, G.compose(G.translation(10, 0), G.rotation(Math.PI / 2)));
  near(ti.rot, 90, 1e-9); near(ti.sx, 2, 1e-9); nearPt(ti.p, 10, 1);
  const shear = M.makeInsert('B', { x: 0, y: 0 }, { rot: 30 });
  assert.throws(() => G.transformEntity(shear, G.scaling(2, 1)), (e) => e.code === 'SHEAR');
});

test('transformEntity: non-uniform scale turns a circle into an ellipse', () => {
  const c = M.makeCircle({ x: 0, y: 0 }, 3);
  const e = G.transformEntity(c, G.scaling(2, 1));
  assert.equal(e.type, 'ELLIPSE');
  near(Math.hypot(e.major.x, e.major.y), 6, 1e-9); near(e.ratio, 0.5, 1e-9);
  const ell = M.makeEllipse({ x: 0, y: 0 }, { x: 4, y: 0 }, 0.5);
  const r = G.transformEntity(ell, G.rotation(Math.PI / 2));
  near(r.major.x, 0, 1e-9); near(r.major.y, 4, 1e-9); near(r.ratio, 0.5, 1e-9);
});

test('intersections', () => {
  const l1 = M.makeLine({ x: 0, y: 0 }, { x: 10, y: 10 });
  const l2 = M.makeLine({ x: 0, y: 10 }, { x: 10, y: 0 });
  const i = G.intersections(l1, l2);
  assert.equal(i.length, 1); nearPt(i[0], 5, 5);
  const c = M.makeCircle({ x: 0, y: 0 }, 5);
  const h = M.makeLine({ x: -10, y: 3 }, { x: 10, y: 3 });
  const ic = G.intersections(c, h);
  assert.equal(ic.length, 2);
  assert.deepEqual(ic.map((p) => Math.round(p.x)).sort((a, b) => a - b), [-4, 4]);
  const c2 = M.makeCircle({ x: 6, y: 0 }, 5);
  assert.equal(G.intersections(c, c2).length, 2);
  assert.equal(G.intersections(M.makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }), M.makeLine({ x: 5, y: -1 }, { x: 5, y: 1 })).length, 0, 'segments that do not reach');
  const arc = M.makeArc({ x: 0, y: 0 }, 5, 0, 90);
  assert.equal(G.intersections(arc, M.makeLine({ x: -10, y: 3 }, { x: 10, y: 3 })).length, 1, 'only the part on the arc');
});

test('trim, extend and offset', () => {
  const line = M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  line.id = 7;
  const cutter = M.makeLine({ x: 4, y: -5 }, { x: 4, y: 5 });
  const r = G.trimEntity(line, [cutter], { x: 8, y: 0 });
  assert.equal(r.replace.length, 1);
  nearPt(r.replace[0].p1, 0, 0); nearPt(r.replace[0].p2, 4, 0); assert.equal(r.replace[0].id, 7);
  const r2 = G.trimEntity(line, [cutter, M.makeLine({ x: 7, y: -5 }, { x: 7, y: 5 })], { x: 5, y: 0 });
  assert.equal(r2.replace.length, 2, 'middle piece removed');
  assert.equal(G.trimEntity(line, [M.makeLine({ x: 20, y: -5 }, { x: 20, y: 5 })], { x: 5, y: 0 }), null);

  const short = M.makeLine({ x: 0, y: 0 }, { x: 3, y: 0 });
  const ext = G.extendEntity(short, [M.makeLine({ x: 5, y: -5 }, { x: 5, y: 5 })], { x: 3, y: 0 });
  nearPt(ext.p2, 5, 0); nearPt(ext.p1, 0, 0);
  assert.equal(G.extendEntity(short, [M.makeLine({ x: -5, y: -5 }, { x: -5, y: 5 })], { x: 3, y: 0 }), null, 'would need extending the other end');

  const off = G.offsetEntity(M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }), 2, { x: 5, y: 9 });
  nearPt(off.p1, 0, 2); nearPt(off.p2, 10, 2);
  const oc = G.offsetEntity(M.makeCircle({ x: 0, y: 0 }, 5), 1, { x: 0, y: 0 });
  near(oc.r, 4);
  const rect = M.makeRect({ x: 0, y: 0 }, { x: 10, y: 10 });
  const inner = G.offsetEntity(rect, 1, { x: 5, y: 5 });
  assert.deepEqual(inner.vertices.map((v) => [v.x, v.y]), [[1, 1], [9, 1], [9, 9], [1, 9]]);
  assert.equal(G.offsetEntity(M.makeSpline({ ctrl: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), 1, { x: 0, y: 1 }).type, 'SPLINE');
});

test('explode: polyline -> lines/arcs, insert -> transformed block content', () => {
  const doc = M.newDocument();
  M.addBlock(doc, 'B', { x: 1, y: 1 }, [M.makeLine({ x: 1, y: 1 }, { x: 3, y: 1 })]);
  const ins = M.makeInsert('B', { x: 10, y: 10 }, { sx: 2, sy: 2, rot: 90 });
  const parts = G.explode(ins, doc);
  assert.equal(parts.length, 1);
  nearPt(parts[0].p1, 10, 10); nearPt(parts[0].p2, 10, 14);
  const arr = M.makeInsert('B', { x: 0, y: 0 }, { cols: 3, rows: 2, colSp: 5, rowSp: 4 });
  assert.equal(G.explode(arr, doc).length, 6);
  const pl = M.makePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }, { x: 2, y: 2 }]);
  const ex = G.explode(pl);
  assert.deepEqual(ex.map((e) => e.type), ['ARC', 'LINE']);
  near(ex[0].r, 1);
});

test('hit testing and snap points', () => {
  const doc = M.newDocument();
  const c = M.makeCircle({ x: 0, y: 0 }, 5);
  near(G.distanceToEntity(c, { x: 8, y: 0 }, doc), 3, 1e-3);
  const line = M.makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  near(G.distanceToEntity(line, { x: 5, y: 2 }, doc), 2);
  const kinds = G.snapPoints(line).map((s) => s.kind);
  assert.deepEqual(kinds.sort(), ['end', 'end', 'mid']);
  const np = G.nearestPoint(line, { x: 4, y: 9 });
  nearPt(np, 4, 0);
  const ck = G.snapPoints(c).map((s) => s.kind);
  assert.equal(ck.filter((k) => k === 'quad').length, 4);
  assert.ok(ck.includes('cen'));
});

test('INSERT array spacing follows scale, rotation and mirror', async () => {
  const { transformEntity: te, scaling: sc, mirrorLine: ml, rotation: ro } = await import('../src/core/geom.js');
  const ins = { id: 1, type: 'INSERT', layer: '0', block: 'B', p: { x: 0, y: 0 }, sx: 1, sy: 1, rot: 0, cols: 3, rows: 2, colSp: 10, rowSp: 4 };
  const a = te(ins, sc(2, 2));
  assert.deepEqual([a.sx, a.sy, a.colSp, a.rowSp], [2, 2, 20, 8]);
  // columns of a mirrored array must still run to the mirrored side: world direction of column k = k*colSp along the new frame x axis
  const worldCol = (e) => { const r = (e.rot * Math.PI) / 180; return { x: Math.cos(r) * e.colSp, y: Math.sin(r) * e.colSp }; };
  const m = te(ins, ml({ x: 0, y: 0 }, { x: 0, y: 1 }));
  const w = worldCol(m);
  assert.ok(Math.abs(w.x + 10) < 1e-9 && Math.abs(w.y) < 1e-9, `mirrored column step ${JSON.stringify(w)}`);
  const r90 = te(ins, ro(Math.PI / 2));
  const w2 = worldCol(r90);
  assert.ok(Math.abs(w2.x) < 1e-9 && Math.abs(w2.y - 10) < 1e-9);
});

test('mirrored TEXT stays readable (MIRRTEXT=0): only the insertion point is mirrored', async () => {
  const { transformEntity: te, mirrorLine: ml } = await import('../src/core/geom.js');
  const t = { id: 1, type: 'TEXT', layer: '0', p: { x: 5, y: 0 }, height: 2, text: 'ABC', rot: 0, widthFactor: 1 };
  const a = te(t, ml({ x: 0, y: 0 }, { x: 0, y: 1 }));
  assert.ok(Math.abs(a.p.x + 5) < 1e-9 && Math.abs(a.p.y) < 1e-9 && Math.abs(a.rot) < 1e-9, JSON.stringify(a));
  const b = te({ ...t, rot: 90 }, ml({ x: 0, y: 0 }, { x: 0, y: 1 }));
  assert.equal(Math.round(b.rot), 90);
  const c = te({ ...t, rot: 30 }, ml({ x: 0, y: 0 }, { x: 1, y: 0 }));
  assert.ok(Math.abs(c.rot - 330) < 1e-9 || Math.abs(c.rot + 30) < 1e-9, `rot ${c.rot}`);
});

// A clockwise hatch arc edge (DXF 73 = 0) stores its mirror image's angles: a0 = 30, a1 = 60 runs clockwise from -30 to
// -60 degrees (a short arc below the x axis), not the long way round (a site plan drew a 20 km disc from such an edge).
test('tessellate: clockwise hatch arc and ellipse edges use negated angles', () => {
  const loop = (seg) => ({ type: 'HATCH', solid: true, pattern: 'SOLID', loops: [{ segs: [seg, { type: 'line', p1: { x: 5 * Math.SQRT2 * 0.7071, y: 0 }, p2: { x: 0, y: 0 } }], closed: true }] });
  for (const seg of [
    { type: 'arc', c: { x: 0, y: 0 }, r: 10, a0: 30, a1: 60, ccw: false },
    { type: 'ellipse', c: { x: 0, y: 0 }, major: { x: 10, y: 0 }, ratio: 1, a0: 30 * Math.PI / 180, a1: 60 * Math.PI / 180, ccw: false },
  ]) {
    const pts = G.tessellate(loop(seg)).flat();
    const arcPts = pts.filter((p) => Math.hypot(p.x, p.y) > 9.9);
    assert.ok(arcPts.length >= 2, seg.type);
    for (const p of arcPts) assert.ok(p.y < 0 && p.x > 0, `${seg.type} point ${JSON.stringify(p)} is not on the short clockwise arc`);
    const first = arcPts[0];
    assert.ok(Math.abs(first.x - 10 * Math.cos(-Math.PI / 6)) < 1e-6 && Math.abs(first.y - 10 * Math.sin(-Math.PI / 6)) < 1e-6, `${seg.type} starts at -30 deg: ${JSON.stringify(first)}`);
  }
});
