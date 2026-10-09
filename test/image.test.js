import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { bboxOf, docExtents, rotation, transformEntity } from '../src/core/geom.js';
import { imageCorners, imageClipWorld } from '../src/core/image.js';
import { buildScene, drawScene } from '../src/core/render.js';
import { ezdxfAvailable } from './helpers.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const enc = new TextEncoder();

// hand-written R2000 DXF: one IMAGE (rotated 30 deg, 2 x 1 units per pixel, polygonal clip) and its IMAGEDEF
const HAND = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'IMAGE', '5', '40', '330', '1F', '100', 'AcDbEntity', '8', 'PHOTOS', '100', 'AcDbRasterImage', '90', '0',
  '10', '100', '20', '50', '30', '0', '11', '1.7320508075688772', '21', '1', '31', '0', '12', '-0.5', '22', '0.8660254037844386', '32', '0',
  '13', '64', '23', '32', '340', '41', '70', '7', '280', '1', '281', '60', '282', '40', '283', '25',
  '71', '2', '91', '3', '14', '-0.5', '24', '-0.5', '14', '63.5', '24', '-0.5', '14', '31.5', '24', '31.5',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'OBJECTS',
  '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '3', 'ACAD_IMAGE_DICT', '350', '42',
  '0', 'DICTIONARY', '5', '42', '330', 'C', '100', 'AcDbDictionary', '3', 'logo', '350', '41',
  '0', 'IMAGEDEF', '5', '41', '330', '42', '100', 'AcDbRasterImageDef', '90', '0', '1', '.\\img\\logo.png',
  '10', '64', '20', '32', '11', '1', '21', '1', '280', '1', '281', '0',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

const imageOf = (doc) => doc.entities.find((e) => e.type === 'IMAGE');

test('IMAGE + IMAGEDEF are read (vectors, size, clip, display values, file path)', () => {
  const doc = readDxf(enc.encode(HAND));
  assert.equal(doc.skipped.IMAGE, undefined);
  const e = imageOf(doc);
  assert.ok(e);
  assert.equal(e.layer, 'PHOTOS');
  assert.deepEqual([e.p, e.size], [{ x: 100, y: 50 }, { x: 64, y: 32 }]);
  near(e.u.x, Math.sqrt(3)); near(e.u.y, 1); near(e.v.x, -0.5); near(e.v.y, Math.sqrt(3) / 2);
  assert.equal(e.path, '.\\img\\logo.png');
  assert.deepEqual(e.def.size, { x: 64, y: 32 });
  assert.deepEqual(e.clip, { on: true, type: 2, pts: [{ x: -0.5, y: -0.5 }, { x: 63.5, y: -0.5 }, { x: 31.5, y: 31.5 }] });
  assert.deepEqual([e.brightness, e.contrast, e.fade, e.flags], [60, 40, 25, 7]);
});

test('IMAGE round trip through writeDxf -> readDxf keeps path, vectors, clip and display values', () => {
  const doc = readDxf(enc.encode(HAND));
  const text = writeDxf(doc);
  assert.equal(doc.lastWriteReport.skipped.IMAGE, undefined);
  assert.match(text, /ACAD_IMAGE_DICT/);
  const back = imageOf(readDxf(enc.encode(text)));
  const a = imageOf(doc);
  for (const k of ['p', 'u', 'v']) { near(back[k].x, a[k].x, 1e-12); near(back[k].y, a[k].y, 1e-12); } // writer keeps 15 digits
  for (const k of ['size', 'clip', 'path', 'brightness', 'contrast', 'fade', 'flags', 'layer']) assert.deepEqual(back[k], a[k], k);
  assert.deepEqual(back.def.size, a.def.size);
  assert.deepEqual(back.def.pixel, a.def.pixel);
});

test('two images of one file share one IMAGEDEF on write', () => {
  const doc = readDxf(enc.encode(HAND));
  doc.entities.push({ ...structuredClone(imageOf(doc)), id: 0, p: { x: 0, y: 0 } });
  const text = writeDxf(doc);
  assert.equal(text.match(/\r\n0\r\nIMAGEDEF\r\n/g).length, 1);
  const back = readDxf(enc.encode(text)).entities.filter((e) => e.type === 'IMAGE');
  assert.equal(back.length, 2);
  assert.ok(back.every((e) => e.path === '.\\img\\logo.png'));
});

test('image transforms: rotating 90 deg rotates U and V; the frame drives bbox and extents', () => {
  const img = { id: 1, type: 'IMAGE', layer: '0', p: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 10, y: 5 }, clip: { on: false, type: 1, pts: [] }, def: null, path: 'a.png' };
  const r = transformEntity(img, rotation(Math.PI / 2));
  near(r.u.x, 0); near(r.u.y, 1); near(r.v.x, -1); near(r.v.y, 0);
  assert.deepEqual(img.u, { x: 1, y: 0 }); // original untouched
  const b = bboxOf(r);
  near(b.minx, -5); near(b.maxx, 0); near(b.miny, 0); near(b.maxy, 10);
  const c = imageCorners(img);
  assert.deepEqual(c[2], { x: 10, y: 5 });
  const doc = readDxf(enc.encode(HAND));
  const ext = docExtents(doc);
  // frame corners: p, p + 64u, p + 64u + 32v, p + 32v
  near(ext.minx, 100 - 16, 1e-9); near(ext.maxx, 100 + 64 * Math.sqrt(3), 1e-9);
  near(ext.miny, 50); near(ext.maxy, 50 + 64 + 16 * Math.sqrt(3), 1e-9);
});

test('ezdxf: an IMAGE built by ezdxf is read, and our written IMAGE is read back by ezdxf', { skip: !ezdxfAvailable() && 'ezdxf not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-image-'));
  try {
    const src = path.join(dir, 'ez.dxf'), ours = path.join(dir, 'ours.dxf');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const py = `
import sys, ezdxf, math
mode, f = sys.argv[1], sys.argv[2]
if mode == 'make':
    doc = ezdxf.new('R2000'); msp = doc.modelspace()
    d = doc.add_image_def(filename='img/site.jpg', size_in_pixel=(200, 100))
    msp.add_image(d, insert=(10, 20), size_in_units=(40, 20), rotation=90)
    doc.saveas(f)
else:
    doc = ezdxf.readfile(f); im = doc.modelspace().query('IMAGE')[0]
    print(im.image_def.dxf.filename, round(im.dxf.u_pixel.x, 6), round(im.dxf.u_pixel.y, 6), int(im.dxf.image_size.x))
`;
    const run = (...a) => spawnSync(ezdxfAvailable(), ['-c', py, ...a], { encoding: 'utf8', env });
    assert.equal(run('make', src).status, 0);
    const doc = readDxf(readFileSync(src));
    const e = imageOf(doc);
    assert.equal(e.path, 'img/site.jpg');
    assert.deepEqual(e.size, { x: 200, y: 100 });
    near(e.u.x, 0, 1e-9); near(e.u.y, 0.2, 1e-9); near(e.v.x, -0.2, 1e-9);
    writeFileSync(ours, writeDxf(doc));
    const r = run('read', ours);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'img/site.jpg 0.0 0.2 200');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('render: a missing image file is a red frame plus its file name; a loaded one is drawn through U/V, clipped and faded', () => {
  const doc = readDxf(enc.encode(HAND));
  const miss = buildScene(doc).items;
  const frame = miss.find((it) => it.missingImage);
  assert.equal(frame?.kind, 'path');
  assert.deepEqual(frame.style.color.rgb, [255, 0, 0]);
  const label = miss.find((it) => it.kind === 'text' || it.strokeText);
  assert.ok(label, 'file name item');
  assert.deepEqual(label.style.color.rgb, [255, 0, 0]);
  if (label.lines) assert.equal(label.lines.map((l) => l.text ?? l).join(''), 'logo.png');

  const bmp = { tag: 'bitmap' };
  doc.images = new Map([['.\\img\\logo.png', { status: 'loaded', bitmap: bmp }]]);
  const scene = buildScene(doc);
  assert.deepEqual(scene.items.map((it) => it.kind), ['image']);
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls.push([k, ...a]); }), set: (t, k, v) => { t[k] = v; calls.push(['set ' + String(k), v]); return true; } });
  const view = { cx: 100, cy: 50, zoom: 2, width: 400, height: 300 };
  drawScene(ctx, scene, view, { background: '#ffffff' });
  const draw = calls.find((c) => c[0] === 'drawImage');
  assert.deepEqual(draw, ['drawImage', bmp, 0, 0, 64, 32]);
  const tr = calls.find((c) => c[0] === 'transform');
  const e = imageOf(doc), z = 2, sx = (x) => (x - 100) * z + 200, sy = (y) => 150 - (y - 50) * z;
  const top = imageCorners(e)[3];
  [e.u.x * z, -e.u.y * z, -e.v.x * z, e.v.y * z, sx(top.x), sy(top.y)].forEach((v, i) => near(tr[i + 1], v));
  assert.ok(calls.some((c) => c[0] === 'clip'), 'clipped');
  assert.ok(calls.some((c) => c[0] === 'set globalAlpha' && Math.abs(c[1] - 0.75) < 1e-12), 'fade 25 -> 75 % opacity');
  // the polygon clip starts at the image's top-left corner (pixel (-0.5, -0.5))
  const cw = imageClipWorld(e);
  near(cw[0].x, top.x); near(cw[0].y, top.y);
});
