// Editing existing dimensions: text override (DDEDIT / TEXTEDIT) and grips on the definition points, for dimensions
// built here and for dimensions read from a file (raw tags + their own *D block).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, getEntity } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { createDimension } from '../src/core/dims.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { gripsOf, gripEdit, dimTextEdit } from '../renderer/grips.js';

const P = (x, y) => ({ x, y });
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} !~ ${b}`);
const nearP = (p, q) => { near(p.x, q.x); near(p.y, q.y); };
const reread = (doc) => readDxf(new TextEncoder().encode(writeDxf(doc)));
const dimOf = (doc) => doc.entities.find((e) => e.type === 'DIMENSION');

function withDim(def, style = 'ISO-25') {
  const s = new Session(newDocument());
  const e = createDimension(s.doc, def, style);
  return { s, id: e.id };
}
/** drag grip i of dimension id to p; one undo step restores the definition and the measurement */
function drag(s, id, i, p) {
  const before = structuredClone(getEntity(s.doc, id));
  const n = s.undoStack.length;
  assert.ok(gripEdit(s, id, i, p), 'grip edit applied');
  assert.equal(s.undoStack.length, n + 1, 'one undo step');
  const after = getEntity(s.doc, id);
  assert.notEqual(after.block, before.block, 'regenerated into a new *D block');
  assert.ok(s.doc.blocks.get(after.block).entities.length > 0);
  return { after, undo: () => { s.undo(); const u = getEntity(s.doc, id); assert.deepEqual(u.def, before.def); assert.equal(u.measurement, before.measurement); assert.equal(u.block, before.block); } };
}

test('linear: dragging the second extension-line grip changes p2 and the measured value; undo restores', () => {
  const { s, id } = withDim({ kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 });
  assert.deepEqual(gripsOf(getEntity(s.doc, id)).map((g) => g.kind), ['def', 'def', 'def', 'text']);
  const { after, undo } = drag(s, id, 1, P(150, 7));
  nearP(after.def.p2, P(150, 7));
  near(after.measurement, 150);
  assert.equal(after.dimText, '150');
  undo();
});

test('aligned: moving the first point changes the aligned length', () => {
  const { s, id } = withDim({ kind: 'aligned', p1: P(0, 0), p2: P(30, 40), at: P(-10, 10) });
  near(getEntity(s.doc, id).measurement, 50);
  const { after, undo } = drag(s, id, 0, P(30, 0));
  nearP(after.def.p1, P(30, 0));
  near(after.measurement, 40);
  undo();
});

test('linear: the text grip moves the dimension line, not the measured points', () => {
  const { s, id } = withDim({ kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 });
  const g = gripsOf(getEntity(s.doc, id))[3];
  const { after } = drag(s, id, 3, P(g.x, g.y + 15));
  nearP(after.def.at, P(50, 35));
  near(after.measurement, 100);
});

test('radius and diameter: the curve grip changes the radius', () => {
  for (const [kind, k, text] of [['radius', 1, 'R40'], ['diameter', 1, 'Ø80']]) {
    const { s, id } = withDim({ kind, center: P(0, 0), p: P(25, 0) });
    const { after, undo } = drag(s, id, k, P(0, 40));
    nearP(after.def.p, P(0, 40));
    near(after.measurement, kind === 'radius' ? 40 : 80);
    assert.equal(after.dimText, text);
    undo();
  }
});

test('angular (two lines): moving an end of the second line changes the angle', () => {
  const { s, id } = withDim({ kind: 'angular', l1: [P(0, 0), P(10, 0)], l2: [P(0, 0), P(0, 10)], at: P(5, 5) });
  near(getEntity(s.doc, id).measurement, Math.PI / 2);
  const { after, undo } = drag(s, id, 3, P(-10, 10)); // l2 end -> 135 degrees
  nearP(after.def.l2[1], P(-10, 10));
  near(after.measurement, 3 * Math.PI / 4);
  undo();
});

test('angular (three points): moving the vertex or a point changes the angle', () => {
  const { s, id } = withDim({ kind: 'angular3', vertex: P(0, 0), p1: P(10, 0), p2: P(10, 10), at: P(8, 3) });
  near(getEntity(s.doc, id).measurement, Math.PI / 4);
  const { after, undo } = drag(s, id, 2, P(0, 10));
  nearP(after.def.p2, P(0, 10));
  near(after.measurement, Math.PI / 2);
  undo();
});

test('ordinate: moving the feature point changes the datum value', () => {
  const { s, id } = withDim({ kind: 'ordinate', feature: P(12, 5), end: P(12, 30), xType: true });
  const { after, undo } = drag(s, id, 0, P(20, 5));
  nearP(after.def.feature, P(20, 5));
  near(after.measurement, 20);
  undo();
});

test('text override: "<>" keeps the measured value, empty goes back to it; one undo step each', () => {
  const { s, id } = withDim({ kind: 'linear', p1: P(0, 0), p2: P(100, 0), at: P(50, 20), angle: 0 });
  assert.ok(dimTextEdit(s, id, 'L=<> TYP'));
  let d = getEntity(s.doc, id);
  assert.equal(d.text, 'L=<> TYP');
  assert.equal(d.dimText, 'L=100 TYP');
  const mt = s.doc.blocks.get(d.block).entities.find((x) => x.type === 'MTEXT');
  assert.equal(mt.text, 'L=100 TYP', 'the block text is rebuilt');
  assert.equal(dimTextEdit(s, id, 'L=<> TYP'), false, 'no change, no undo step');
  assert.ok(dimTextEdit(s, id, ''));
  assert.equal(getEntity(s.doc, id).dimText, '100');
  s.undo();
  assert.equal(getEntity(s.doc, id).dimText, 'L=100 TYP');
  s.undo();
  d = getEntity(s.doc, id);
  assert.equal(d.text, '');
  assert.equal(d.dimText, '100');
});

test('text override survives DXF write / read', () => {
  const { s, id } = withDim({ kind: 'aligned', p1: P(0, 0), p2: P(30, 40), at: P(-10, 10) });
  dimTextEdit(s, id, 'C/C <>');
  const r = dimOf(reread(s.doc));
  assert.equal(r.text, 'C/C <>');
  assert.equal(r.def.text, 'C/C <>');
  nearP(r.def.p2, P(30, 40));
});

// a rotated dimension as LibreDWG converts it from a DWG (R2010+ codes 280, 73-75 present; type 70 left out)
const LIBREDWG_DIM = [[100, 'AcDbDimension'], [280, '0'], [2, '*D102'], [10, '0'], [20, '20'], [30, '0.0'],
  [11, '50'], [21, '22'], [31, '0.0'], [1, ''], [71, '5'], [42, '100.0'], [73, '0'], [74, '0'], [75, '0'],
  [3, 'ISO-25'], [100, 'AcDbAlignedDimension'], [13, '0'], [23, '0'], [33, '0.0'], [14, '100'], [24, '0'], [34, '0.0'],
  [52, '0.0'], [50, '0.0'], [100, 'AcDbRotatedDimension']];
const fileDoc = () => readDxf(new TextEncoder().encode(
  '0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\n*D102\n70\n1\n10\n0\n20\n0\n30\n0\n3\n*D102\n1\n\n0\nLINE\n8\n0\n10\n0\n20\n20\n30\n0\n11\n100\n21\n20\n31\n0\n0\nENDBLK\n8\n0\n0\nENDSEC\n' +
  `0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n5\n1312\n100\nAcDbEntity\n8\n0\n${LIBREDWG_DIM.map(([c, v]) => `${c}\n${v}`).join('\n')}\n0\nENDSEC\n0\nEOF\n`));
/** group codes of the (first) DIMENSION entity in a DXF text */
function savedDimCodes(text) {
  const lines = text.split(/\r?\n/).map((x) => x.trim());
  const at = lines.findIndex((l, i) => l === 'DIMENSION' && lines[i - 1] === '0');
  const out = []; for (let i = at + 1; lines[i] !== '0'; i += 2) out.push([+lines[i], lines[i + 1]]);
  return out;
}

test('a dimension read from a file: grips edit it, it is regenerated and saved with its new points (R2000 codes)', () => {
  const s = new Session(fileDoc());
  const e = dimOf(s.doc);
  assert.ok(e.raw && e.def, 'read with raw tags and a definition');
  assert.equal(gripsOf(e).length, 4);
  assert.ok(gripEdit(s, e.id, 1, P(140, 0)));
  const d = getEntity(s.doc, e.id);
  assert.equal(d.raw, null, 'the file tags are dropped once the dimension is rebuilt');
  near(d.measurement, 140);
  assert.ok(s.doc.blocks.has('*D102'), 'the original block stays for undo');
  const codes = savedDimCodes(writeDxf(s.doc));
  for (const c of [280, 73, 74, 75]) assert.ok(!codes.some(([k]) => k === c), `code ${c} in the saved DIMENSION`);
  const r = dimOf(reread(s.doc));
  nearP(r.def.p2, P(140, 0));
  near(parseFloat(r.raw.find(([c]) => c === 42)[1]), 140); // group 42 as saved
  s.undo();
  assert.equal(getEntity(s.doc, e.id).block, '*D102');
  assert.ok(getEntity(s.doc, e.id).raw, 'undo brings back the file tags');
});

test('a dimension read from a file: text edit regenerates it and the override round-trips', () => {
  const s = new Session(fileDoc());
  const e = dimOf(s.doc);
  assert.ok(dimTextEdit(s, e.id, '<> MAX'));
  assert.equal(getEntity(s.doc, e.id).dimText, '100 MAX');
  const r = dimOf(reread(s.doc));
  assert.equal(r.text, '<> MAX');
  near(parseFloat(r.raw.find(([c]) => c === 42)[1]), 100); // group 42 as saved
});
