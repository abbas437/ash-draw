import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { buildScene, drawScene } from '../src/core/render.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { alphaFromPercent, percentFromAlpha } from '../src/core/model.js';
import { ezdxfAvailable } from './helpers.js';

const enc = new TextEncoder();
// ezdxf: layer T70 (70 % transparent), a LINE at 50 %, a block whose LINE is ByBlock inserted at 30 %,
// a ByLayer LINE on T70 and a red solid HATCH on T70
const PY = `
import ezdxf, sys, io
d = ezdxf.new('R2018'); m = d.modelspace()
d.layers.add('T70', color=1).transparency = 0.7
m.add_line((0, 0), (10, 0)).transparency = 0.5
m.add_line((0, 10), (10, 10), dxfattribs={'layer': 'T70'})
b = d.blocks.new('B')
b.add_line((0, 0), (5, 0), dxfattribs={'transparency': 0x01000000})
m.add_blockref('B', (0, 20)).transparency = 0.3
h = m.add_hatch(color=256, dxfattribs={'layer': 'T70'}); h.paths.add_polyline_path([(0, 30), (10, 30), (10, 40), (0, 40)])
s = io.StringIO(); d.write(s); sys.stdout.write(s.getvalue())
`;
let cached;
const fixture = () => {
  if (cached === undefined) {
    const r = spawnSync(ezdxfAvailable(), ['-c', PY], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stderr);
    cached = r.stdout;
  }
  return cached;
};
const skip = !ezdxfAvailable() && 'ezdxf not installed';
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const itemAt = (scene, y) => scene.items.find((it) => it.bbox && Math.abs(it.bbox.miny - y) < 1e-6);

test('transparency percent <-> alpha byte (AutoCAD encoding)', () => {
  assert.equal(alphaFromPercent(0), 255);
  assert.equal(alphaFromPercent(60), 102);
  assert.equal(alphaFromPercent(50), 127);
  assert.equal(percentFromAlpha(102), 60);
  assert.equal(percentFromAlpha(127), 50);
});

test('entity transparency 50 % -> scene item alpha 0.5', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  assert.equal(doc.entities[0].alpha, 127);
  near(itemAt(buildScene(doc), 0).style.alpha, 0.5);
});

test('ByLayer transparency from a 70 % layer (LAYER xdata AcCmTransparency)', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  assert.equal(doc.layers.get('T70').alpha, alphaFromPercent(70));
  const sc = buildScene(doc);
  near(itemAt(sc, 10).style.alpha, 0.3);
  near(itemAt(sc, 30).style.alpha, 0.3);
});

test('ByBlock transparency inside an INSERT takes the INSERT\'s', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  assert.equal(doc.blocks.get('B').entities[0].alpha, -2);
  near(itemAt(buildScene(doc), 20).style.alpha, 0.7);
});

test('round trip keeps entity 440 and the layer transparency xdata (ezdxf reads them back)', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  const out = writeDxf(doc);
  assert.match(out, /\n1001\r?\nAcCmTransparency\r?\n1071\r?\n33554508\r?\n/); // 0x02000000 | 76
  const again = readDxf(enc.encode(out));
  assert.deepEqual([again.entities[0].alpha, again.blocks.get('B').entities[0].alpha, again.layers.get('T70').alpha], [127, -2, 76]);
  const dir = mkdtempSync(path.join(tmpdir(), 'ash-tpy-'));
  try {
    const f = path.join(dir, 'rt.dxf');
    writeFileSync(f, out);
    const py = `import ezdxf, json, sys
d = ezdxf.readfile(sys.argv[1]); m = d.modelspace()
print(json.dumps([round(d.layers.get('T70').transparency, 2), [e.dxf.get('transparency') for e in m], [e.dxf.get('transparency') for e in d.blocks.get('B')], d.audit().has_errors]))`;
    const r = spawnSync(ezdxfAvailable(), ['-c', py, f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [lt, ms, blk, err] = JSON.parse(r.stdout);
    assert.equal(lt, 0.7);
    assert.equal(ms[0], 0x02000000 | 127);
    assert.equal(ms[2], 0x02000000 | 178); // INSERT 30 %
    assert.equal(blk[0], 0x01000000);
    assert.equal(err, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a red solid hatch at 70 % over white draws light red; transparency off draws full red', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  const sc = buildScene(doc);
  const cv = createCanvas(100, 100), ctx = cv.getContext('2d');
  const view = { cx: 5, cy: 35, zoom: 20, width: 100, height: 100 };
  drawScene(ctx, sc, view, { background: '#ffffff' });
  const px = () => [...ctx.getImageData(50, 50, 1, 1).data.slice(0, 3)];
  const [r, g, b] = px();
  near(r, 255, 10); near(g, 178, 10); near(b, 178, 10);
  drawScene(ctx, sc, view, { background: '#ffffff', transparency: false });
  assert.deepEqual(px(), [255, 0, 0]);
  assert.match(exportSvg(doc, { scene: sc }), /opacity="0\.298/);
});

// ---- UI helpers and edit paths (no ezdxf needed) ----
import * as M from '../src/core/model.js';
import { Session, setEntityProps, setLayerProps } from '../src/core/edit.js';

test('Transparency field text <-> alpha', () => {
  assert.deepEqual(M.parseTransparency('ByLayer'), { alpha: undefined });
  assert.deepEqual(M.parseTransparency(' byblock '), { alpha: -2 });
  assert.equal(M.parseTransparency('70').alpha, 76);
  assert.equal(M.parseTransparency('30%').alpha, 178);
  assert.equal(M.parseTransparency('0').alpha, 255);
  for (const bad of ['', 'abc', '91', '-1', '100']) assert.equal(M.parseTransparency(bad), null, bad);
  assert.equal(M.transparencyText(undefined), 'ByLayer');
  assert.equal(M.transparencyText(-2), 'ByBlock');
  assert.equal(M.transparencyText(76), '70');
  assert.equal(M.transparencyText(255), '0');
});

test('setEntityProps sets, clears (ByLayer) and undoes alpha in one step; setLayerProps sets layer alpha', () => {
  const doc = M.newDocument();
  const a = M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })), b = M.addEntity(doc, M.makeLine({ x: 0, y: 1 }, { x: 1, y: 1 }, { alpha: 100 }));
  const s = new Session(doc);
  const get = (id) => s.doc.entities.find((e) => e.id === id);
  setEntityProps(s, [a.id, b.id], { alpha: 76 });
  assert.deepEqual([get(a.id).alpha, get(b.id).alpha], [76, 76]);
  setEntityProps(s, [a.id, b.id], { alpha: -2 });
  assert.deepEqual([get(a.id).alpha, get(b.id).alpha], [-2, -2]);
  setEntityProps(s, [a.id, b.id], { alpha: undefined });
  assert.ok(!('alpha' in get(a.id)) && !('alpha' in get(b.id)), 'ByLayer = no alpha key');
  s.undo();
  assert.deepEqual([get(a.id).alpha, get(b.id).alpha], [-2, -2], 'one undo step restores both');
  setLayerProps(s, '0', { alpha: M.alphaFromPercent(50) });
  assert.equal(s.doc.layers.get('0').alpha, 127);
  s.undo();
  assert.equal(s.doc.layers.get('0').alpha, undefined);
});
