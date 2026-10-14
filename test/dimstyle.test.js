// Per-dimension style overrides (XDATA "ACAD" DSTYLE): read into e.dimOverrides, applied when the dimension block is
// regenerated, written back on DXF save; user arrow blocks drawn by inserting the block; a note when a file-read
// dimension cannot be regenerated as it looked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEntity } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { gripEdit, dimTextEdit } from '../renderer/grips.js';

const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} !~ ${b}`);
const dimOf = (doc) => doc.entities.find((e) => e.type === 'DIMENSION');
const reread = (doc) => readDxf(new TextEncoder().encode(writeDxf(doc)));
const lines = (pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join('\n');

/** a rotated dimension 0,0 - 100.4,0 (LibreDWG-style tags) with the given ACAD XDATA, plus a user arrow block MYARROW
 *  (BLOCK_RECORD handle A1) and a text style ROMANS (STYLE handle B1) */
function fileDoc(xdata = [], extra = []) {
  const dim = [[100, 'AcDbDimension'], [2, '*D102'], [10, '0'], [20, '20'], [30, '0.0'], [11, '50'], [21, '22'], [31, '0.0'],
    ...extra, [1, ''], [71, '5'], [42, '100.4'], [3, 'ISO-25'], [100, 'AcDbAlignedDimension'], [13, '0'], [23, '0'], [33, '0.0'],
    [14, '100.4'], [24, '0'], [34, '0.0'], [50, '0.0'], [100, 'AcDbRotatedDimension'], ...xdata];
  return readDxf(new TextEncoder().encode(
    '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nBLOCK_RECORD\n0\nBLOCK_RECORD\n5\nA1\n2\nMYARROW\n0\nENDTAB\n' +
    '0\nTABLE\n2\nSTYLE\n0\nSTYLE\n5\nB1\n2\nROMANS\n3\nromans.shx\n0\nENDTAB\n0\nENDSEC\n' +
    '0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\n*D102\n70\n1\n10\n0\n20\n0\n30\n0\n3\n*D102\n1\n\n0\nLINE\n8\n0\n10\n0\n20\n20\n30\n0\n11\n100.4\n21\n20\n31\n0\n0\nENDBLK\n8\n0\n' +
    '0\nBLOCK\n8\n0\n2\nMYARROW\n70\n0\n10\n0\n20\n0\n30\n0\n3\nMYARROW\n1\n\n0\nLINE\n8\n0\n10\n-1\n20\n0.5\n30\n0\n11\n0\n21\n0\n31\n0\n0\nENDBLK\n8\n0\n0\nENDSEC\n' +
    `0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n5\n1312\n100\nAcDbEntity\n8\n0\n${lines(dim)}\n0\nENDSEC\n0\nEOF\n`));
}
const DSTYLE = (...pairs) => [[1001, 'ACAD'], [1000, 'DSTYLE'], [1002, '{'], ...pairs, [1002, '}']];
const blockOf = (doc, e) => doc.blocks.get(e.block).entities;
/** regenerate (an unchanged text edit away from the file block) and return the new block's entities */
function regen(doc) {
  const s = new Session(doc);
  const e = dimOf(doc);
  assert.ok(dimTextEdit(s, e.id, '<>'), 'regenerated');
  const d = getEntity(s.doc, e.id);
  return { s, d, ents: blockOf(s.doc, d) };
}
const mtextOf = (ents) => ents.find((x) => x.type === 'MTEXT');
/** arrow length of the first SOLID: distance from its tip to the middle of its base */
const arrowLen = (ents) => { const p = ents.find((x) => x.type === 'SOLID').pts; return Math.hypot(p[0].x - (p[1].x + p[2].x) / 2, p[0].y - (p[1].y + p[2].y) / 2); };

test('DSTYLE XDATA is read into dimOverrides by DIMVAR name (handles resolved to names, unknown codes kept)', () => {
  const e = dimOf(fileDoc(DSTYLE([1070, 40], [1040, 50], [1070, 271], [1070, 0], [1070, 173], [1070, 1], [1070, 343], [1005, 'A1'],
    [1070, 340], [1005, 'B1'], [1070, 283], [1070, 1])));
  assert.deepEqual(e.dimOverrides, { DIMSCALE: 50, DIMDEC: 0, DIMSAH: 1, DIMBLK1: 'MYARROW', DIMTXSTY: 'ROMANS', G283: { x: 1070, v: '1' } });
  assert.equal(dimOf(fileDoc()).dimOverrides, undefined);
});

test('DIMSCALE override scales arrows and text of the regenerated block', () => {
  const plain = regen(fileDoc()).ents, scaled = regen(fileDoc(DSTYLE([1070, 40], [1040, 50]))).ents;
  near(mtextOf(plain).height, 2.5);
  near(mtextOf(scaled).height, 125);
  near(arrowLen(plain), 2.5);
  near(arrowLen(scaled), 125);
});

test('DIMDEC override changes the measured text', () => {
  assert.equal(regen(fileDoc()).d.dimText, '100,4');
  const { d, ents } = regen(fileDoc(DSTYLE([1070, 271], [1070, 0])));
  assert.equal(d.dimText, '100');
  assert.equal(mtextOf(ents).text, '100');
});

test('overrides round-trip through DXF save, for a file-read dimension and for a regenerated one', () => {
  const ov = { DIMSCALE: 50, DIMDEC: 0, DIMSAH: 1, DIMBLK1: 'MYARROW', DIMTXSTY: 'ROMANS', G283: { x: 1070, v: '1' } };
  const doc = fileDoc(DSTYLE([1070, 40], [1040, 50], [1070, 271], [1070, 0], [1070, 173], [1070, 1], [1070, 343], [1005, 'A1'],
    [1070, 340], [1005, 'B1'], [1070, 283], [1070, 1]));
  const text = writeDxf(doc);
  assert.match(text, /1001\r?\nACAD\r?\n1000\r?\nDSTYLE\r?\n1002\r?\n\{\r?\n1070\r?\n40\r?\n1040\r?\n50(\.0)?\r?\n/);
  assert.deepEqual(dimOf(reread(doc)).dimOverrides, ov);
  const { s, d } = regen(doc);
  assert.equal(d.raw, null);
  const r = dimOf(reread(s.doc));
  assert.deepEqual(r.dimOverrides, ov);
  assert.equal(r.text, '<>');
});

test('a user arrow block (DIMSAH + DIMBLK1) is drawn by inserting that block at the arrow tip, scaled by the arrow size', () => {
  const { ents } = regen(fileDoc(DSTYLE([1070, 173], [1070, 1], [1070, 343], [1005, 'A1'])));
  const ins = ents.filter((x) => x.type === 'INSERT');
  assert.equal(ins.length, 1, 'one inserted arrow');
  assert.equal(ins[0].block, 'MYARROW');
  near(ins[0].p.x, 0); near(ins[0].p.y, 20);
  near(ins[0].sx, 2.5); near(ins[0].sy, 2.5);
  near(Math.abs(ins[0].rot), 180); // first arrow points left
  assert.equal(ents.filter((x) => x.type === 'SOLID').length, 1, 'the second arrow stays closed filled');
});

test('a file dimension with user-moved text gets a status note when it is regenerated; a plain one does not', () => {
  const s = new Session(fileDoc([], [[70, '128']]));
  assert.ok(gripEdit(s, dimOf(s.doc).id, 1, { x: 140, y: 0 }));
  assert.equal(s.dimNote, "Dimension regenerated with ASH's text placement.");
  const t = new Session(fileDoc());
  assert.ok(gripEdit(t, dimOf(t.doc).id, 1, { x: 140, y: 0 }));
  assert.equal(t.dimNote, undefined);
});
