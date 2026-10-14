import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { newDocument, addEntity, makeLine, makeInsert } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { worldClip, clipPathOps, clipFillOps, xclipInserts, worldToBlock } from '../src/core/xclip.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { Session } from '../src/core/edit.js';

const P = (p) => p;
const rect = (inverted = false) => worldClip({ pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }], inverted }, P);
const lShape = worldClip({ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }] }, P);
const pts = (ops) => { const o = []; for (let i = 0; i < ops.length;) { if (ops[i] <= 1) { o.push([ops[i + 1], ops[i + 2]]); i += 3; } else i += ops[i] === 2 ? 6 : ops[i] === 3 ? 8 : 1; } return o; };
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a line crossing a rectangular boundary is cut at the boundary', () => {
  const r = clipPathOps([0, -5, 5, 1, 15, 5], rect());
  assert.deepEqual(pts(r.ops).map((p) => p.map((v) => +v.toFixed(9))), [[0, 5], [10, 5]]);
});

test('inverted: only the parts outside are kept', () => {
  const r = clipPathOps([0, -5, 5, 1, 15, 5], rect(true));
  assert.deepEqual(pts(r.ops).map((p) => p.map((v) => +v.toFixed(9))), [[-5, 5], [0, 5], [10, 5], [15, 5]]);
  assert.equal(r.ops.filter((v, i) => i % 3 === 0 && v === 0).length >= 2, true);
});

test('polygonal (non-convex) boundary: a line through the notch is cut in two', () => {
  const r = clipPathOps([0, -1, 7, 1, 11, 7], lShape); // y = 7 crosses the L at x 0..4 only
  assert.deepEqual(pts(r.ops).map((p) => p.map((v) => +v.toFixed(9))), [[0, 7], [4, 7]]);
  const r2 = clipPathOps([0, -1, 2, 1, 11, 2], lShape);
  assert.deepEqual(pts(r2.ops).map((p) => p.map((v) => +v.toFixed(9))), [[0, 2], [10, 2]]);
});

test('arcs stay arcs and are cut at the boundary; fills are cut to the boundary, convex or not', () => {
  // a circle of radius 5 around (10, 5): the part inside x <= 10 is the left half
  const r = clipPathOps([0, 15, 5, 2, 10, 5, 5, 0, Math.PI * 2], rect());
  assert.ok(r.ops.includes(2));
  for (const [x, y] of pts(r.ops)) assert.ok(x <= 10 + 1e-9 && y >= -1e-9 && y <= 10 + 1e-9);
  const sq = [0, -5, -5, 1, 15, -5, 1, 15, 15, 1, -5, 15, 4];
  for (const c of [rect(), lShape]) {
    const f = clipFillOps(sq, c);
    for (const [x, y] of pts(f)) assert.ok(x >= -1e-9 && x <= 10 + 1e-9 && y >= -1e-9 && y <= 10 + 1e-9);
    assert.ok(f.length > 0);
  }
  // non-convex: nothing of the fill lands in the notch (6..10, 6..10)
  for (const [x, y] of pts(clipFillOps(sq, lShape))) assert.ok(!(x > 4 + 1e-9 && y > 4 + 1e-9));
});

/** block B: a horizontal line 0..100 at y 0 and a vertical one at x 50; one insert at (1000, 0) scaled 2 */
function clippedDoc(clip) {
  const doc = newDocument();
  doc.blocks.set('B', { name: 'B', base: { x: 0, y: 0 }, entities: [makeLine({ x: 0, y: 0 }, { x: 100, y: 0 }), makeLine({ x: 50, y: -50 }, { x: 50, y: 50 })] });
  const ins = addEntity(doc, makeInsert('B', { x: 1000, y: 0 }, { sx: 2, sy: 2 }));
  if (clip) ins.clip = clip;
  return { doc, ins };
}
const CLIP = { pts: [{ x: 20, y: -10 }, { x: 60, y: 10 }], enabled: true, inverted: false, showFrame: true };
const drawn = (scene) => scene.items.filter((it) => it.kind !== 'clipFrame');

test('the scene of a clipped insert has no geometry outside the boundary (block coordinates, scaled)', () => {
  const { doc } = clippedDoc(CLIP);
  const sc = buildScene(doc);
  for (const it of drawn(sc)) for (const [x, y] of pts(it.ops)) assert.ok(x >= 1040 - 1e-6 && x <= 1120 + 1e-6 && y >= -20 - 1e-6 && y <= 20 + 1e-6, `${x},${y}`);
  assert.equal(drawn(sc).length, 2);
  assert.equal(sc.items.filter((it) => it.kind === 'clipFrame').length, 1);
  // off: drawn whole, no frame
  const off = buildScene(clippedDoc({ ...CLIP, enabled: false }).doc);
  assert.ok(off.bbox.maxx >= 1200 - 1e-6);
  assert.equal(off.items.filter((it) => it.kind === 'clipFrame').length, 0);
  // inverted: nothing inside the boundary
  const inv = buildScene(clippedDoc({ ...CLIP, inverted: true }).doc);
  for (const it of drawn(inv)) for (let i = 3, o = it.ops; i < o.length; i += 3) {
    if (o[i] !== 1) continue; // the midpoint of each drawn segment (L after M / L)
    const mx = (o[i - 2] + o[i + 1]) / 2, my = (o[i - 1] + o[i + 2]) / 2;
    assert.ok(!(mx > 1040 && mx < 1120 && my > -20 && my < 20), `${mx},${my}`);
  }
});

test('XCLIP new boundary, off and delete are one undo step each', () => {
  const { doc, ins } = clippedDoc(null);
  const s = new Session(doc);
  const block = worldToBlock(ins, { x: 0, y: 0 }, [{ x: 1040, y: -20 }, { x: 1120, y: 20 }]);
  assert.ok(near(block[0].x, 20) && near(block[1].y, 10));
  assert.equal(xclipInserts(s, [ins.id], () => ({ pts: block, enabled: true, inverted: false, showFrame: true })), 1);
  const cur = () => s.doc.entities.find((e) => e.id === ins.id);
  assert.ok(cur().clip);
  xclipInserts(s, [ins.id], (c) => c && { ...c, enabled: false });
  assert.equal(cur().clip.enabled, false);
  xclipInserts(s, [ins.id], () => null);
  assert.equal(cur().clip, undefined);
  s.undo(); assert.equal(cur().clip.enabled, false);
  s.undo(); assert.equal(cur().clip.enabled, true);
  s.undo(); assert.equal(cur().clip, undefined);
});

/** a synthetic AutoCAD-style DXF: INSERT -> xdictionary -> ACAD_FILTER -> SPATIAL -> SPATIAL_FILTER */
function syntheticDxf() {
  const L = [];
  const p = (c, v) => L.push(String(c), String(v));
  p(0, 'SECTION'); p(2, 'BLOCKS');
  p(0, 'BLOCK'); p(8, '0'); p(2, 'B'); p(70, 0); p(10, 0); p(20, 0); p(30, 0); p(3, 'B');
  p(0, 'LINE'); p(8, '0'); p(10, 0); p(20, 0); p(30, 0); p(11, 100); p(21, 0); p(31, 0);
  p(0, 'ENDBLK'); p(8, '0');
  p(0, 'ENDSEC');
  p(0, 'SECTION'); p(2, 'ENTITIES');
  p(0, 'INSERT'); p(5, 'A0'); p(102, '{ACAD_XDICTIONARY'); p(360, 'A1'); p(102, '}'); p(100, 'AcDbEntity'); p(8, '0'); p(100, 'AcDbBlockReference'); p(2, 'B'); p(10, 0); p(20, 0); p(30, 0);
  p(0, 'ENDSEC');
  p(0, 'SECTION'); p(2, 'OBJECTS');
  p(0, 'DICTIONARY'); p(5, 'A1'); p(330, 'A0'); p(100, 'AcDbDictionary'); p(280, 1); p(281, 1); p(3, 'ACAD_FILTER'); p(360, 'A2');
  p(0, 'DICTIONARY'); p(5, 'A2'); p(330, 'A1'); p(100, 'AcDbDictionary'); p(280, 1); p(281, 1); p(3, 'SPATIAL'); p(360, 'A3');
  p(0, 'SPATIAL_FILTER'); p(5, 'A3'); p(330, 'A2'); p(100, 'AcDbFilter'); p(100, 'AcDbSpatialFilter'); p(70, 2); p(10, 20); p(20, -10); p(10, 60); p(20, 10);
  p(210, 0); p(220, 0); p(230, 1); p(11, 0); p(21, 0); p(31, 0); p(71, 1); p(72, 0); p(73, 0);
  for (const v of [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) p(40, v);
  p(0, 'ENDSEC'); p(0, 'EOF');
  return new TextEncoder().encode(L.join('\n') + '\n');
}

test('DXF: a SPATIAL_FILTER is read, drawn clipped, written back with its dictionaries and read again', () => {
  const doc = readDxf(syntheticDxf());
  const ins = doc.entities.find((e) => e.type === 'INSERT');
  assert.deepEqual(ins.clip, { pts: [{ x: 20, y: -10 }, { x: 60, y: 10 }], enabled: true, inverted: false, showFrame: true });
  const sc = buildScene(doc);
  for (const it of drawn(sc)) for (const [x] of pts(it.ops)) assert.ok(x >= 20 - 1e-9 && x <= 60 + 1e-9);
  ins.clip.inverted = true;
  const text = writeDxf(doc);
  const out = typeof text === 'string' ? text : new TextDecoder().decode(text);
  for (const s of ['{ACAD_XDICTIONARY', 'ACAD_FILTER', 'SPATIAL_FILTER', 'AcDbSpatialFilter']) assert.ok(out.includes(s), s);
  // owners: the filter's 330 is the SPATIAL dictionary's handle, that one's the xdictionary's, that one's the insert's
  const lines = out.split(/\r?\n/).map((v) => v.trim());
  const rec = (type) => { const i = lines.findIndex((v, k) => k % 2 === 1 && v === type && lines[k - 1] === '0'); const o = {}; for (let k = i + 1; k < lines.length && !(lines[k] === '0' && k % 2 === 0); k += 2) (o[lines[k]] ??= []).push(lines[k + 1]); return o; };
  const sf = rec('SPATIAL_FILTER'), insR = rec('INSERT');
  assert.equal(sf['290']?.[0], '1');
  const xd = insR['360'][0];
  const back = readDxf(new TextEncoder().encode(out));
  const ins2 = back.entities.find((e) => e.type === 'INSERT');
  assert.deepEqual(ins2.clip, { pts: [{ x: 20, y: -10 }, { x: 60, y: 10 }], enabled: true, inverted: true, showFrame: true });
  assert.ok(xd && sf['330'].length >= 1);
  // an insert without a clip writes nothing extra
  delete ins.clip;
  const plain = writeDxf(doc), ptxt = typeof plain === 'string' ? plain : new TextDecoder().decode(plain);
  assert.ok(!ptxt.includes('SPATIAL_FILTER') && !ptxt.includes('ACAD_FILTER'));
});

test('PDF export does not draw the clipped-away geometry', async () => {
  const { doc } = clippedDoc(CLIP);
  addEntity(doc, makeLine({ x: 1000, y: 200 }, { x: 1200, y: 200 })); // an unclipped 200-unit reference
  const pdf = await PDFDocument.load((await exportPdf(doc)).bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  const text = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
  const segs = [...text.matchAll(/(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l/g)].map((m) => m.slice(1).map(Number));
  const horiz = segs.filter((q) => Math.abs(q[1] - q[3]) < 1e-3).map((q) => Math.abs(q[2] - q[0])).sort((a, b) => b - a);
  assert.equal(segs.length, 3); // the reference and the two cut lines; the frame is not plotted
  assert.ok(Math.abs(horiz[1] / horiz[0] - 0.4) < 0.01, String(horiz)); // 80 of the block line's 200 units are kept
});
