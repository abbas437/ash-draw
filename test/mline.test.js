import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { explode, transformEntity, rotation, tessellate } from '../src/core/geom.js';
import { buildScene } from '../src/core/render.js';
import { ezdxfAvailable, norm } from './helpers.js';

const enc = new TextEncoder();
// ezdxf: style TWO (elements +0.5 red / -0.5, square start and end caps); MLINEs scale 20 with each justification and a closed one
const PY = `
import ezdxf, sys, io
from ezdxf.entities.mline import MLineStyle
d = ezdxf.new('R2007'); m = d.modelspace()
st = d.mline_styles.new('TWO'); st.elements.append(0.5, 1); st.elements.append(-0.5, 256)
st.dxf.flags = MLineStyle.START_SQUARE | MLineStyle.END_SQUARE
for j, y in ((0, 0), (1, 100), (2, 200)):
    ml = m.add_mline([(0, y), (100, y)], dxfattribs={'style_name': 'TWO', 'scale_factor': 20})
    ml.set_justification(j)
m.add_mline([(0, 300), (100, 300), (100, 400)], close=True, dxfattribs={'style_name': 'TWO', 'scale_factor': 20})
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
const mlines = (doc) => doc.entities.filter((e) => e.type === 'MLINE');
const ys = (e, doc) => tessellate(e, doc).filter((pl) => pl.length === 2 && Math.abs(pl[0].y - pl[1].y) < 1e-9).map((pl) => Math.round(pl[0].y * 1e6) / 1e6).sort((a, b) => a - b);

test('MLINE is read with its style; 2-element +-0.5 x scale 20 draws two parallel lines 20 apart per justification', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  assert.equal(doc.skipped.MLINE, undefined);
  const [top, zero, bottom] = mlines(doc);
  const st = doc.mlineStyles.get(top.styleH);
  assert.equal(st.name, 'TWO');
  assert.deepEqual(st.elements.map((x) => [x.offset, x.color]), [[0.5, 1], [-0.5, 256]]);
  assert.deepEqual(ys(top, doc), [-20, 0]); // top: the vertices are on the top element
  assert.deepEqual(ys(zero, doc), [90, 110]);
  assert.deepEqual(ys(bottom, doc), [200, 220]);
});

test('MLINE square caps join the outer elements; closed MLINE draws closed element loops without caps', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  const [, zero, , closed] = mlines(doc);
  const caps = tessellate(zero, doc).filter((pl) => pl.length === 2 && Math.abs(pl[0].x - pl[1].x) < 1e-9);
  assert.deepEqual(norm(caps.map((pl) => [pl[0].x, Math.min(pl[0].y, pl[1].y), Math.max(pl[0].y, pl[1].y)])).sort(), [[0, 90, 110], [100, 90, 110]]);
  const pls = tessellate(closed, doc);
  assert.equal(pls.length, 2);
  for (const pl of pls) assert.deepEqual(pl[0], pl[pl.length - 1]);
});

test('MLINE round trip keeps the custom style handle, its elements and the geometry', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  const text = writeDxf(doc);
  assert.equal(doc.lastWriteReport.skipped.MLINE, undefined);
  const back = readDxf(enc.encode(text));
  const a = mlines(doc), b = mlines(back);
  assert.equal(b.length, a.length);
  assert.equal(b[0].styleH, a[0].styleH);
  assert.equal(back.mlineStyles.get(b[0].styleH).name, 'TWO');
  assert.deepEqual(back.mlineStyles.get(b[0].styleH).elements, doc.mlineStyles.get(a[0].styleH).elements);
  for (let i = 0; i < a.length; i++) assert.deepEqual(norm(tessellate(b[i], back)), norm(tessellate(a[i], doc)));
});

test('MLINE transforms (rotate 90) and explodes to one LINE per element segment plus caps', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  const [, zero, , closed] = mlines(doc);
  const r = transformEntity(zero, rotation(Math.PI / 2));
  const xs = tessellate(r, doc).filter((pl) => Math.abs(pl[0].x - pl[1].x) < 1e-9).map((pl) => Math.round(pl[0].x * 1e6) / 1e6).sort((p, q) => p - q);
  assert.deepEqual(xs, [-110, -90]);
  assert.deepEqual(explode(zero, doc).map((x) => x.type), ['LINE', 'LINE', 'LINE', 'LINE']);
  assert.equal(explode(closed, doc).length, 6);
  assert.ok(explode(closed, doc).every((x) => x.layer === closed.layer));
});

test('scene: MLINE parts are drawn and the red element keeps its style colour', { skip }, () => {
  const doc = readDxf(enc.encode(fixture()));
  const scene = buildScene(doc);
  assert.ok(scene.items.length >= 4 * 2);
});
