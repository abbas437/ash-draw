import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { transformEntity, translation } from '../src/core/geom.js';
import { buildScene, drawScene, fitView } from '../src/core/render.js';
import { readCfb } from '../src/core/cfb.js';
import { olePreview } from '../src/core/ole.js';

// ---- synthetic fixtures built here (no client data) ----

/** a version-3 compound file (512-byte sectors) holding `streams` {name: bytes}, each padded to >= 4096 bytes so it
 *  lives in regular sectors */
function makeCfb(streams) {
  const SS = 512, names = Object.keys(streams);
  const data = names.map((n) => { const b = streams[n]; const p = new Uint8Array(Math.max(4096, b.length)); p.set(b); return { n, b: p, size: Math.max(4096, b.length) }; });
  let next = 2; // sector 0: FAT, sector 1: directory
  for (const d of data) { d.start = next; d.count = Math.ceil(d.size / SS); next += d.count; }
  assert.ok(next <= SS / 4, 'one FAT sector is enough');
  const out = new Uint8Array(SS * (next + 1)), dv = new DataView(out.buffer);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((x, i) => { out[i] = x; });
  dv.setUint16(24, 0x3e, true); dv.setUint16(26, 3, true); dv.setUint16(28, 0xfffe, true); dv.setUint16(30, 9, true); dv.setUint16(32, 6, true);
  dv.setUint32(44, 1, true); dv.setUint32(48, 1, true); dv.setUint32(56, 4096, true);
  dv.setUint32(60, 0xfffffffe, true); dv.setUint32(68, 0xfffffffe, true);
  for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i ? 0xffffffff : 0, true);
  const fat = SS; // sector 0
  for (let i = 0; i < SS / 4; i++) dv.setUint32(fat + i * 4, 0xffffffff, true);
  dv.setUint32(fat, 0xfffffffd, true); dv.setUint32(fat + 4, 0xfffffffe, true);
  for (const d of data) {
    for (let k = 0; k < d.count; k++) dv.setUint32(fat + (d.start + k) * 4, k === d.count - 1 ? 0xfffffffe : d.start + k + 1, true);
    out.set(d.b, SS * (d.start + 1));
  }
  const dir = SS * 2; // sector 1: Root Entry + the streams as a right-leaning chain
  const entry = (i, name, type, child, right, start, size) => {
    const o = dir + i * 128;
    for (let k = 0; k < name.length; k++) dv.setUint16(o + k * 2, name.charCodeAt(k), true);
    dv.setUint16(o + 64, (name.length + 1) * 2, true); out[o + 66] = type; out[o + 67] = 1;
    dv.setUint32(o + 68, 0xffffffff, true); dv.setUint32(o + 72, right, true); dv.setUint32(o + 76, child, true);
    dv.setUint32(o + 116, start, true); dv.setUint32(o + 120, size, true);
  };
  entry(0, 'Root Entry', 5, data.length ? 1 : 0xffffffff, 0xffffffff, 0xfffffffe, 0);
  data.forEach((d, i) => entry(i + 1, d.n, 2, 0xffffffff, i + 2 <= data.length ? i + 2 : 0xffffffff, d.start, d.size));
  return out;
}

/** a packed DIB (BITMAPINFOHEADER + pixels): w x h, 24 bpp, every pixel `rgb` except the top-left one black */
function dib(w, h, rgb) {
  const stride = ((w * 24 + 31) >>> 5) * 4, b = new Uint8Array(40 + stride * h), dv = new DataView(b.buffer);
  dv.setUint32(0, 40, true); dv.setInt32(4, w, true); dv.setInt32(8, h, true); dv.setUint16(12, 1, true); dv.setUint16(14, 24, true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = 40 + y * stride + x * 3, top = y === h - 1 && x === 0; // bottom-up rows: the last row is the top
    b[o] = top ? 0 : rgb[2]; b[o + 1] = top ? 0 : rgb[1]; b[o + 2] = top ? 0 : rgb[0];
  }
  return b;
}
const bmpFile = (d) => { const b = new Uint8Array(14 + d.length), dv = new DataView(b.buffer); b[0] = 0x42; b[1] = 0x4d; dv.setUint32(2, b.length, true); dv.setUint32(10, 54, true); b.set(d, 14); return b; };

/** a placeable WMF: window 0,0 .. 100,50 and one META_DIBSTRETCHBLT of `d` into the right half */
function wmf(d) {
  const recs = [];
  const rec = (fn, words, extra = new Uint8Array(0)) => {
    const b = new Uint8Array(6 + words.length * 2 + extra.length), dv = new DataView(b.buffer);
    dv.setUint32(0, b.length / 2, true); dv.setUint16(4, fn, true); words.forEach((w, i) => dv.setInt16(6 + i * 2, w, true)); b.set(extra, 6 + words.length * 2);
    recs.push(b);
  };
  rec(0x020b, [0, 0]); rec(0x020c, [50, 100]);
  // rasterOp (2 words), srcH, srcW, ySrc, xSrc, destH, destW, yDest, xDest
  rec(0x0b41, [0x0020, 0x00cc, 4, 4, 0, 0, 50, 50, 0, 50], d);
  rec(0x0000, []);
  const body = recs.reduce((n, r) => n + r.length, 0), out = new Uint8Array(22 + 18 + body), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x9ac6cdd7, true); dv.setInt16(10, 100, true); dv.setInt16(12, 50, true); dv.setUint16(14, 1440, true);
  dv.setUint16(22, 1, true); dv.setUint16(24, 9, true); dv.setUint16(26, 0x300, true); dv.setUint32(28, (18 + body) / 2, true);
  let o = 40; for (const r of recs) { out.set(r, o); o += r.length; }
  return out;
}

/** AutoCAD's 128-byte OLE2FRAME header (corners upper-left / upper-right / lower-right / lower-left) + the object */
function oleData(p1, p2, cfb) {
  const h = new Uint8Array(128 + cfb.length), dv = new DataView(h.buffer);
  h[0] = 0x80; h[1] = 0x55;
  [p1.x, p1.y, 0, p2.x, p1.y, 0, p2.x, p2.y, 0, p1.x, p2.y, 0].forEach((v, i) => dv.setFloat64(2 + i * 8, v, true));
  dv.setUint32(124, cfb.length, true); h.set(cfb, 128);
  const hex = Buffer.from(h).toString('hex').toUpperCase(), chunks = [];
  for (let i = 0; i < hex.length; i += 254) chunks.push(hex.slice(i, i + 254));
  return chunks;
}

const enc = new TextEncoder();
// LibreDWG writes these fixed points as 10 / 11; the real corners are in the data header
const oleDxf = (chunks) => enc.encode(['0', 'SECTION', '2', 'ENTITIES', '0', 'OLE2FRAME', '5', '30', '100', 'AcDbEntity', '8', '0',
  '100', 'AcDbOle2Frame', '70', '2', '3', 'OLE', '10', '30.13602472538446', '20', '-18.98882829402869', '30', '0',
  '11', '35.27188116753285', '21', '-22.39344715050545', '31', '0', '71', '2', '72', '0',
  '90', String(chunks.reduce((n, c) => n + c.length / 2, 0)), ...chunks.flatMap((c) => ['310', c]), '1', 'OLE', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'));

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
