import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { transformEntity, translation } from '../src/core/geom.js';
import { buildScene, drawScene, fitView } from '../src/core/render.js';
import { readCfb } from '../src/core/cfb.js';
import { olePreview } from '../src/core/ole.js';

import { makeCfb, loopCfb, dib, bmpFile, wmf, oleData, oleDxf, enc } from './oleFixtures.js';

const RED = [220, 30, 40];

test('cfb: streams are read back by name from regular sectors', () => {
  const a = new Uint8Array(5000).map((_, i) => i & 255);
  const cf = readCfb(makeCfb({ CONTENTS: a, '\u0001Ole': new Uint8Array([1, 2, 3]) }));
  assert.deepEqual(cf.entries.map((e) => e.path).sort(), ['\u0001Ole', 'CONTENTS']);
  assert.deepEqual(cf.read('CONTENTS'), a);
  assert.equal(cf.read('missing'), null);
});

test('olePreview: a DIB picture (BMP in CONTENTS) fills the frame', () => {
  const pv = olePreview(oleData({ x: 0, y: 10 }, { x: 20, y: 0 }, makeCfb({ CONTENTS: bmpFile(dib(40, 40, RED)) })));
  assert.equal(pv.error, undefined);
  assert.deepEqual([pv.width, pv.height, pv.box], [40, 40, [0, 0, 1, 1]]);
  assert.deepEqual([...pv.rgba.subarray(0, 8)], [0, 0, 0, 255, ...RED, 255], 'top row first, top-left pixel black');
});

test('olePreview: a metafile picture places its stretch-blit bitmap where the window puts it', () => {
  const pv = olePreview(oleData({ x: 0, y: 10 }, { x: 20, y: 0 }, makeCfb({ CONTENTS: wmf(dib(4, 4, RED)) })));
  assert.equal(pv.error, undefined);
  assert.deepEqual([pv.width, pv.height, pv.box], [4, 4, [0.5, 0, 1, 1]]);
  assert.ok(olePreview(oleData({ x: 0, y: 10 }, { x: 20, y: 0 }, makeCfb({ Other: new Uint8Array(10) }))).error);
});

test('OLE2FRAME: frame corners from the data header; drawn from its preview on screen; moves round-trip', () => {
  const chunks = oleData({ x: 100, y: 60 }, { x: 140, y: 20 }, makeCfb({ CONTENTS: bmpFile(dib(40, 40, RED)) }));
  const doc = readDxf(oleDxf(chunks));
  const e = doc.entities[0];
  assert.deepEqual([e.p1, e.p2], [{ x: 100, y: 60 }, { x: 140, y: 20 }]);
  assert.equal(doc.report?.skipped?.OLE2FRAME, undefined);

  const sc = buildScene(doc);
  assert.equal(sc.items.filter((it) => it.kind === 'image').length, 1);
  assert.equal(sc.items.filter((it) => it.kind === 'text').length, 0, 'no "OLE object" placeholder label');
  const cv = createCanvas(200, 200), ctx = cv.getContext('2d');
  drawScene(ctx, sc, fitView({ minx: 90, miny: 10, maxx: 150, maxy: 70 }, 200, 200), { background: '#ffffff' });
  const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data.subarray(0, 3)];
  assert.deepEqual(px(100, 100), RED, 'the frame centre shows the picture');
  assert.deepEqual(px(5, 100), [255, 255, 255], 'outside the frame is background');

  // unchanged: the binary data is written exactly as read; moved: the header corners follow the frame
  const back = readDxf(enc.encode(writeDxf(doc))).entities[0];
  assert.deepEqual(back.data, chunks);
  const mv = transformEntity(e, translation(5, -5));
  doc.entities[0] = mv;
  const moved = readDxf(enc.encode(writeDxf(doc))).entities[0];
  assert.deepEqual([moved.p1, moved.p2], [{ x: 105, y: 55 }, { x: 145, y: 15 }]);
  assert.deepEqual(moved.data.slice(2), chunks.slice(2), 'only the header changes');
});

// ---- hostile input: every size read from the file is clamped ----
const ms = (f) => { const t0 = performance.now(); const r = f(); return [r, performance.now() - t0]; };
const bmpWith = (patch) => { const d = dib(8, 8, RED), dv = new DataView(d.buffer); patch(dv); return bmpFile(d); };

test('olePreview: a BMP claiming a huge colour table is read in a blink (palette capped at 1 << bpp)', () => {
  for (const used of [40e6, 0xffffffff]) {
    const bmp = bmpWith((dv) => { dv.setUint16(14, 8, true); dv.setUint32(32, used, true); });
    const chunks = oleData({ x: 0, y: 10 }, { x: 20, y: 0 }, makeCfb({ CONTENTS: bmp }));
    const [pv, t] = ms(() => olePreview(chunks));
    assert.ok(t < 100, `${used}: ${t.toFixed(0)} ms`);
    assert.ok(pv.error || pv.rgba);
  }
  // an 8-bit picture with a 256-entry table still decodes
  const d = new Uint8Array(40 + 1024 + 8 * 8), dv = new DataView(d.buffer);
  dv.setUint32(0, 40, true); dv.setInt32(4, 8, true); dv.setInt32(8, 8, true); dv.setUint16(12, 1, true); dv.setUint16(14, 8, true); dv.setUint32(32, 0xffffffff, true);
  d.set([10, 20, 200, 0], 40 + 4); d.fill(1, 40 + 1024);
  const bmp8 = bmpFile(d); new DataView(bmp8.buffer).setUint32(10, 14 + 40 + 1024, true);
  const pv = olePreview(oleData({ x: 0, y: 10 }, { x: 20, y: 0 }, makeCfb({ CONTENTS: bmp8 })));
  assert.deepEqual([...pv.rgba.subarray(0, 4)], [200, 20, 10, 255]);
});

test('readCfb: a 12 KB file with a looping directory chain and 109 identical FAT slots ends fast', () => {
  const [, t] = ms(() => { try { readCfb(loopCfb()); } catch (e) { assert.equal(e.code, 'CFB'); } });
  assert.ok(t < 100, `${t.toFixed(0)} ms`);
});

test('readCfb: a stream declaring more bytes than its sectors hold is refused before allocating', () => {
  const b = makeCfb({ CONTENTS: new Uint8Array(5000) });
  new DataView(b.buffer).setUint32(512 * 2 + 128 + 120, 0xfffffff0, true); // the stream's size field
  const cf = readCfb(b);
  assert.throws(() => cf.read('CONTENTS'), { code: 'CFB' });
});

test('readCfb: streams under 4096 bytes are read from the mini stream', () => {
  const a = new Uint8Array(100).map((_, i) => i + 1), c = new Uint8Array(300).map((_, i) => (i * 7) & 255);
  for (const v4 of [false, true]) {
    const cf = readCfb(makeCfb({ A: a, C: c, Big: new Uint8Array(5000).fill(9) }, { mini: true, v4 }));
    assert.deepEqual(cf.read('A'), a);
    assert.deepEqual(cf.read('C'), c);
    assert.equal(cf.read('Big').length, 5000);
  }
});

test('readCfb: a version-4 file (4096-byte sectors)', () => {
  const a = new Uint8Array(9000).map((_, i) => i & 255);
  assert.deepEqual(readCfb(makeCfb({ CONTENTS: a }, { v4: true })).read('CONTENTS'), a);
  const pv = olePreview(oleData({ x: 0, y: 10 }, { x: 20, y: 0 }, makeCfb({ CONTENTS: bmpFile(dib(40, 40, RED)) }, { v4: true })));
  assert.deepEqual([pv.width, pv.height], [40, 40]);
});

test('OLE2FRAME corners: the header wins over LibreDWG\'s fixed 10 / 11, but real 10 / 11 win over the header', () => {
  const chunks = oleData({ x: 100, y: 60 }, { x: 140, y: 20 }, makeCfb({ CONTENTS: bmpFile(dib(8, 8, RED)) }));
  const fixed = readDxf(oleDxf(chunks)).entities[0];
  assert.deepEqual([fixed.p1, fixed.p2], [{ x: 100, y: 60 }, { x: 140, y: 20 }]);
  const withPts = (a, b) => readDxf(enc.encode(new TextDecoder().decode(oleDxf(chunks))
    .replace('30.13602472538446', String(a.x)).replace('-18.98882829402869', String(a.y))
    .replace('35.27188116753285', String(b.x)).replace('-22.39344715050545', String(b.y)))).entities[0];
  const real = withPts({ x: 5, y: 9 }, { x: 8, y: 2 });
  assert.deepEqual([real.p1, real.p2], [{ x: 5, y: 9 }, { x: 8, y: 2 }]);
  const flat = withPts({ x: 5, y: 9 }, { x: 5, y: 2 }); // degenerate: the header is used
  assert.deepEqual([flat.p1, flat.p2], [{ x: 100, y: 60 }, { x: 140, y: 20 }]);
});
