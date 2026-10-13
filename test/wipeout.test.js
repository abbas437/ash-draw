import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { bboxOf, rotation, transformEntity } from '../src/core/geom.js';
import { buildScene } from '../src/core/render.js';

const enc = new TextEncoder();
// hand-written: a LINE, then a WIPEOUT (4 x 2 at 10,20; polygon clip in -0.5..0.5 pixel space, clip mode 0), frame setting 0
const HAND = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '5', '30', '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine', '10', '0', '20', '21', '30', '0', '11', '20', '21', '21', '31', '0',
  '0', 'WIPEOUT', '5', '40', '100', 'AcDbEntity', '8', 'MASK', '100', 'AcDbWipeout', '90', '0',
  '10', '10', '20', '20', '30', '0', '11', '4', '21', '0', '31', '0', '12', '0', '22', '2', '32', '0', '13', '1', '23', '1',
  '340', '0', '70', '7', '280', '1', '281', '50', '282', '50', '283', '0', '71', '2', '91', '4',
  '14', '-0.5', '24', '0.5', '14', '0.5', '24', '0.5', '14', '0.5', '24', '-0.5', '14', '-0.5', '24', '-0.5', '290', '0',
  '0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS',
  '0', 'WIPEOUTVARIABLES', '5', '50', '330', 'C', '100', 'AcDbWipeoutVariables', '70', '0',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');
const wipeOf = (doc) => doc.entities.find((e) => e.type === 'WIPEOUT');

test('WIPEOUT is read (vectors, size, clip boundary, clip mode, frame setting) and its boundary drives the bbox', () => {
  const doc = readDxf(enc.encode(HAND));
  assert.equal(doc.skipped.WIPEOUT, undefined);
  const w = wipeOf(doc);
  assert.deepEqual([w.layer, w.p, w.u, w.v, w.size, w.flags], ['MASK', { x: 10, y: 20 }, { x: 4, y: 0 }, { x: 0, y: 2 }, { x: 1, y: 1 }, 7]);
  assert.deepEqual(w.clip, { on: true, type: 2, mode: 0, pts: [{ x: -0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: -0.5 }, { x: -0.5, y: -0.5 }] });
  assert.equal(doc.header.wipeoutFrame, 0);
  assert.deepEqual(bboxOf(w), { minx: 10, miny: 20, maxx: 14, maxy: 22 });
});

test('WIPEOUT transforms through its U/V vectors (rotate 90 deg)', () => {
  const r = transformEntity(wipeOf(readDxf(enc.encode(HAND))), rotation(Math.PI / 2));
  const b = bboxOf(r);
  assert.deepEqual([b.minx, b.miny, b.maxx, b.maxy].map((v) => Math.round(v * 1e9) / 1e9), [-22, 10, -20, 14]);
});

test('WIPEOUT round trip keeps geometry, clip boundary and WIPEOUTFRAME (clip mode 290 is R2010+, not written in R2000)', () => {
  const doc = readDxf(enc.encode(HAND));
  const text = writeDxf(doc);
  assert.equal(doc.lastWriteReport.skipped.WIPEOUT, undefined);
  assert.match(text, /ACAD_WIPEOUT_VARS/);
  const back = readDxf(enc.encode(text));
  const a = wipeOf(doc), b = wipeOf(back);
  for (const k of ['p', 'u', 'v', 'size', 'flags', 'layer']) assert.deepEqual(b[k], a[k], k);
  const { mode, ...clipA } = a.clip; const { mode: modeB, ...clipB } = b.clip;
  assert.deepEqual(clipB, clipA, 'clip');
  assert.equal(back.header.wipeoutFrame, 0);
});

test('scene: the wipeout is a fill item one draw level above the line before it; hidden frame adds no path', () => {
  const doc = readDxf(enc.encode(HAND));
  doc.entities.push({ ...structuredClone(doc.entities[0]), id: 99 }); // a line after the wipeout
  const scene = buildScene(doc);
  assert.deepEqual(scene.items.map((it) => it.kind), ['path', 'wipeout', 'path']);
  doc.header.wipeoutFrame = 1;
  assert.deepEqual(buildScene(doc).items.map((it) => it.kind), ['path', 'wipeout', 'path', 'path']);
});

test('saved WIPEOUT / IMAGE carry no R2010+ clip mode (290): TrueView discards the R2000 file otherwise', async () => {
  const { imageTags } = await import('../src/core/image.js');
  const e = { p: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 1, y: 1 }, clip: { on: true, type: 2, mode: 0, pts: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }] } };
  assert.ok(!imageTags(e, '0').some(([c]) => c === 290));
});

test('a polygonal WIPEOUT boundary is written closed (TrueView discards an open one) and read back open', async () => {
  const { imageTags, imageFromTags } = await import('../src/core/image.js');
  const pts = [{ x: -0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: -0.5 }, { x: -0.5, y: -0.5 }];
  const e = { p: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 1, y: 1 }, clip: { on: true, type: 2, pts } };
  const t = imageTags(e, '0'), v14 = t.filter(([c]) => c === 14);
  assert.equal(t.find(([c]) => c === 91)[1], 5); assert.equal(v14.length, 5);
  assert.equal(v14[4][1], -0.5); assert.equal(t.filter(([c]) => c === 24)[4][1], 0.5);
  assert.deepEqual(imageFromTags(t, null).clip.pts, pts);
});
