import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, getEntity } from '../src/core/model.js';
import { Session, moveEntities, scaleEntities, rotateEntities, mirrorEntities, setDimStyle } from '../src/core/edit.js';
import { createDimension } from '../src/core/dims.js';
import { resolveDimStyle } from '../src/core/dimsStyle.js';

const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) < t, `${a} !~ ${b}`);
const P = (x, y) => ({ x, y });

function withDim(def = { kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 }) {
  const s = new Session(newDocument());
  const e = createDimension(s.doc, def);
  return { s, e };
}
const lineYs = (doc, e) => doc.blocks.get(e.block).entities.filter((x) => x.type === 'LINE').flatMap((l) => [l.p1.x, l.p2.x]);

test('moving a dimension moves its definition and regenerates the block', () => {
  const { s, e } = withDim();
  moveEntities(s, [e.id], 10, 0);
  const d = getEntity(s.doc, e.id);
  assert.equal(d.type, 'DIMENSION');
  assert.deepEqual([d.def.p1, d.def.p2, d.def.at], [P(10, 0), P(110, 0), P(60, 20)]);
  assert.equal(d.def.angle, 0);
  assert.equal(d.measurement, 100);
  assert.equal(d.dimText, '100');
  assert.notEqual(d.block, e.block, 'a new block, so undo keeps the old one intact');
  const xs = lineYs(s.doc, d);
  near(Math.min(...xs), 10); near(Math.max(...xs), 110);
  s.undo();
  const u = getEntity(s.doc, e.id);
  assert.deepEqual(u.def.p1, P(0, 0));
  near(Math.min(...lineYs(s.doc, u)), 0);
});

test('scaling ×2 doubles the measurement; rotate and mirror keep it', () => {
  const { s, e } = withDim();
  scaleEntities(s, [e.id], P(0, 0), 2);
  assert.equal(getEntity(s.doc, e.id).measurement, 200);
  assert.equal(getEntity(s.doc, e.id).dimText, '200');
  rotateEntities(s, [e.id], P(0, 0), Math.PI / 2);
  const r = getEntity(s.doc, e.id);
  near(r.def.angle, 90); near(r.measurement, 200);
  const m = mirrorEntities(s, [e.id], P(0, 0), P(0, 10));
  assert.equal(m.created[0].type, 'DIMENSION');
  near(m.created[0].measurement, 200);
});

test('radius dimension follows a move', () => {
  const { s, e } = withDim({ kind: 'radius', center: P(0, 0), p: P(25, 0) });
  moveEntities(s, [e.id], 5, 5);
  const d = getEntity(s.doc, e.id);
  assert.deepEqual([d.def.center, d.def.p], [P(5, 5), P(30, 5)]);
  assert.equal(d.dimText, 'R25');
});

test('setDimStyle changes the style and regenerates its dimensions in one undo step', () => {
  const { s, e } = withDim();
  const st = resolveDimStyle(s.doc, 'ISO-25');
  setDimStyle(s, st.name, { ...st, DIMDEC: 2, DIMZIN: 0, DIMDSEP: 46 });
  assert.equal(getEntity(s.doc, e.id).dimText, '100.00');
  assert.equal(resolveDimStyle(s.doc, 'ISO-25').DIMDEC, 2);
  s.undo();
  assert.equal(getEntity(s.doc, e.id).dimText, '100');
  assert.equal(resolveDimStyle(s.doc, 'ISO-25').DIMDEC, st.DIMDEC);
});
