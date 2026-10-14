import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { transformEntity, translation } from '../src/core/geom.js';
import { buildScene, drawScene, fitView } from '../src/core/render.js';
import { readCfb } from '../src/core/cfb.js';
import { olePreview } from '../src/core/ole.js';

import { makeCfb, dib, bmpFile, wmf, oleData, oleDxf, enc } from './oleFixtures.js';

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
