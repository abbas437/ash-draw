import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/model.js';
import { SpatialIndex, findSnap } from '../src/core/pick.js';
import { cleanModes } from '../src/core/osnap.js';
import { extensionEnds, extensionPoint, trackAngles, projectOnTrack, trackIntersection, trackingSnap, resolveTracking, toggleAcquired, trackLabel, MAX_ACQUIRED } from '../src/core/otrack.js';

const P = (x, y) => ({ x, y });
const nearPt = (p, x, y, tol = 1e-9) => assert.ok(p && Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol, `${JSON.stringify(p)} !~ ${x},${y}`);

test('extension of a line: beyond either end only, projected, within tol', () => {
  const [a, b] = extensionEnds(M.makeLine(P(0, 0), P(10, 0)));
  nearPt(a.at, 0, 0); nearPt(b.at, 10, 0);
  nearPt(extensionPoint(b.path, P(15, 0.3), 0.5), 15, 0);
  nearPt(extensionPoint(a.path, P(-4, -0.2), 0.5), -4, 0);
  assert.equal(extensionPoint(b.path, P(15, 0.6), 0.5), null, 'outside the tolerance');
  assert.equal(extensionPoint(b.path, P(5, 0.1), 0.5), null, 'on the line itself, not its extension');
  assert.equal(extensionPoint(a.path, P(5, 0.1), 0.5), null);
  const [, d] = extensionEnds(M.makeLine(P(0, 0), P(3, 4)));
  nearPt(extensionPoint(d.path, P(6.1, 8), 0.5), 6 + 0.1 * 0.36, 8 + 0.1 * 0.48); // projected onto the 3-4-5 direction
  assert.deepEqual(extensionEnds(M.makeLine(P(1, 1), P(1, 1))), []);
});

test('extension of an arc: on its circle outside the sweep, from both ends', () => {
  const arc = M.makeArc(P(0, 0), 10, 0, 90);
  const [s, e] = extensionEnds(arc);
  nearPt(s.at, 10, 0); nearPt(e.at, 0, 10);
  assert.equal(e.path.ccw, true); assert.equal(s.path.ccw, false);
  const q = extensionPoint(e.path, P(-10.3 * Math.SQRT1_2, 10.3 * Math.SQRT1_2), 0.5); // 135 deg, just outside the circle
  nearPt(q, -10 * Math.SQRT1_2, 10 * Math.SQRT1_2);
  nearPt(extensionPoint(s.path, P(9.9, -1), 0.5), (9.9 / Math.hypot(9.9, 1)) * 10, (-1 / Math.hypot(9.9, 1)) * 10);
  assert.equal(extensionPoint(e.path, P(10 * Math.SQRT1_2, 10 * Math.SQRT1_2), 0.5), null, 'on the arc itself');
  assert.equal(extensionPoint(e.path, P(-8, 8), 0.5), null, 'off the circle');
  assert.deepEqual(extensionEnds(M.makeCircle(P(0, 0), 5)), []);
});

test('tracking angles: horizontal and vertical; every polar angle when polar is on', () => {
  assert.deepEqual(trackAngles(false, 45), [0, 90]);
  assert.deepEqual(trackAngles(true, 45), [0, 45, 90, 135]);
  assert.deepEqual(trackAngles(true, 90, [30, 210]), [0, 30, 90]);
});

test('tracking-line projection and the crossing of two tracking lines', () => {
  const h = projectOnTrack(P(2, 3), 0, P(7, 3.4));
  nearPt(h, 7, 3); assert.ok(Math.abs(h.d - 0.4) < 1e-12 && Math.abs(h.t - 5) < 1e-12);
  const v = projectOnTrack(P(2, 3), 90, P(1.8, -6));
  nearPt(v, 2, -6); assert.ok(Math.abs(v.t + 9) < 1e-12);
  nearPt(trackIntersection(P(0, 5), 0, P(8, 0), 90), 8, 5);
  nearPt(trackIntersection(P(0, 0), 45, P(10, 0), 135), 5, 5);
  assert.equal(trackIntersection(P(0, 0), 0, P(0, 5), 0), null, 'parallel');
});

test('trackingSnap: a crossing beats a nearer single line; tolerance; extension; direct-distance direction', () => {
  const acq = [{ at: P(0, 5) }, { at: P(8, 0) }];
  const o = { otrack: true, angles: [0, 90] };
  const x = trackingSnap(acq, P(8.3, 5.05), 0.5, o); // nearer the horizontal through 0,5 than the crossing
  assert.equal(x.kind, 'trackint'); nearPt(x, 8, 5);
  const one = trackingSnap(acq, P(3, 5.2), 0.5, o);
  assert.equal(one.kind, 'track'); nearPt(one, 3, 5); nearPt(one.from, 0, 5); nearPt(one.track.dir, 1, 0);
  assert.ok(Math.abs(one.dist - 3) < 1e-12 && one.angle === 0);
  assert.equal(trackLabel(one), 'Tracking: 3 < 0°');
  const down = trackingSnap(acq, P(8.1, -4), 0.5, o);
  nearPt(down, 8, -4); nearPt(down.track.dir, 0, -1); assert.ok(Math.abs(down.angle - 270) < 1e-9);
  assert.equal(trackingSnap(acq, P(3, 5.6), 0.5, o), null, 'beyond tol');
  assert.equal(trackingSnap(acq, P(3, 5.2), 0.5, { otrack: false }), null, 'OTRACK off');
  const ln = extensionEnds(M.makeLine(P(0, 0), P(10, 0)))[1];
  const ex = trackingSnap([ln], P(1234.5 + 10, 0.2), 0.5, { ext: true });
  assert.equal(ex.kind, 'ext'); nearPt(ex, 1244.5, 0); assert.equal(trackLabel(ex), 'Extension: 1234.5 < 0°');
  assert.equal(trackingSnap([ln], P(1244.5, 0.2), 0.5, { ext: false }), null, 'EXT off');
});

test('resolveTracking: an object snap under the cursor beats a tracking line', () => {
  const doc = M.newDocument();
  M.addEntity(doc, M.makeLine(P(0, 0), P(10, 0)));
  const index = new SpatialIndex(doc), p = P(10.1, 0.1), tol = 0.5;
  const acq = [{ at: P(10, 20) }]; // its vertical tracking line passes through 10,0 too
  const osnap = findSnap(index, p, tol, { kinds: new Set(['end']) });
  assert.equal(resolveTracking(osnap, acq, p, tol, { otrack: true, angles: [0, 90] }).kind, 'end');
  const off = resolveTracking(null, acq, P(10.1, 5), tol, { otrack: true, angles: [0, 90] });
  assert.equal(off.kind, 'track'); nearPt(off, 10, 5);
  assert.equal(resolveTracking(null, [], P(10.1, 5), tol, { otrack: true }), null);
});

test('toggleAcquired: acquire up to 7 (oldest dropped); acquiring a point again releases it', () => {
  let l = [];
  for (let i = 0; i < 9; i++) l = toggleAcquired(l, { at: P(i, 0) });
  assert.equal(l.length, MAX_ACQUIRED); nearPt(l[0].at, 2, 0);
  l = toggleAcquired(l, { at: P(5, 0) });
  assert.equal(l.length, 6); assert.ok(!l.some((a) => a.at.x === 5));
});

test('Extension is an implemented running snap mode (kept by cleanModes)', () => {
  assert.deepEqual(cleanModes(['end', 'ext', 'app']), ['end', 'ext']);
});
