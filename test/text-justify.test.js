import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { newDocument, makeText, addEntity, addTextStyle } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { strokeLayout, STROKE_DESCENT } from '../src/core/shx.js';
import { bboxOf, transformEntity } from '../src/core/geom.js';
import { setTextMeasure } from '../src/core/textMetrics.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { parseDxf } from '../src/core/dxfRead.js';
import { ezdxfAvailable } from './helpers.js';

const H = 2.5;
function doc(fontFile = 'romans.shx') {
  const d = newDocument();
  const st = addTextStyle(d, { name: 'S', font: fontFile.replace(/\.\w+$/, '') });
  st.fontFile = fontFile;
  return d;
}
const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const textOf = (out) => (typeof out === 'string' ? out : out.text);

test('each 72/73 justification places the TEXT box on its alignment point, with the real stroke width', () => {
  const W = strokeLayout('ABC', H).width, D = STROKE_DESCENT * H;
  assert.ok(Math.abs(W - 3 * 0.6 * H) > 0.1, 'stroke width differs from the 0.6 h estimate');
  const combos = [[4, 0]];
  for (const ha of [0, 1, 2]) for (const va of [0, 1, 2, 3]) combos.push([ha, va]);
  for (const [ha, va] of combos) {
    const d = doc(), p = { x: 10, y: 20 };
    const e = addEntity(d, makeText(p, H, 'ABC', { style: 'S', hAlign: ha, vAlign: va }));
    const b = bboxOf(e, d), tag = `72=${ha} 73=${va}`;
    near(b.maxx - b.minx, W, `${tag} width`);
    near(ha === 0 ? b.minx : ha === 2 ? b.maxx : (b.minx + b.maxx) / 2, p.x, `${tag} x`);
    const base = b.miny + D; // baseline
    const want = va === 0 && ha !== 4 ? base : va === 1 ? b.miny : va === 3 ? b.maxy : base + H / 2;
    near(want, p.y, `${tag} y`);
    // the drawn strokes sit in the same frame
    const it = buildScene(d).items[0];
    assert.equal(it.kind, 'path', tag);
    near(it.strokeText.p.x, b.minx, `${tag} stroke start`); near(it.strokeText.p.y, base, `${tag} stroke baseline`);
  }
  // rotated top-right: the box corner is still the alignment point
  const d = doc();
  const e = addEntity(d, makeText({ x: 0, y: 0 }, H, 'ABC', { style: 'S', hAlign: 2, vAlign: 3, rot: 90 }));
  const b = bboxOf(e, d);
  near(b.maxy, 0, 'TR rot 90: right end on the point'); near(b.minx, 0, 'TR rot 90: cap top on the point'); near(b.maxy - b.miny, W, 'TR rot 90 length');
});

test('Aligned scales the height to fit between 10 and 11; Fit keeps the height and computes the width factor', () => {
  const w1 = strokeLayout('ABC', 1).width;
  for (const [ha, wf] of [[3, 0.8], [5, 0.8]]) {
    const d = doc();
    const e = addEntity(d, makeText({ x: 1, y: 1 }, H, 'ABC', { style: 'S', hAlign: ha, vAlign: 2, widthFactor: wf, p2: { x: 1, y: 11 } }));
    const st = buildScene(d).items[0].strokeText;
    near(st.w, 10, `72=${ha} width`); near(st.rot, Math.PI / 2, `72=${ha} rotation from 10->11`);
    near(st.p.x, 1, 'starts at 10'); near(st.p.y, 1, 'starts at 10 (73 ignored)');
    if (ha === 3) near(st.h, 10 / (w1 * wf), 'Aligned height (width factor kept)');
    else near(st.h, H, 'Fit height kept');
    const b = bboxOf(e, d);
    near(b.miny, 1, `72=${ha} box start`); near(b.maxy, 11, `72=${ha} box end`);
  }
  // canvas (TrueType) Aligned / Fit: drawn from 10 with the fitted height / width factor
  const d = doc('arial.ttf');
  addEntity(d, makeText({ x: 0, y: 0 }, H, 'ABCD', { style: 'S', hAlign: 3, p2: { x: 12, y: 0 } }));
  addEntity(d, makeText({ x: 0, y: 5 }, H, 'ABCD', { style: 'S', hAlign: 5, p2: { x: 12, y: 5 } }));
  const [a, f] = buildScene(d).items;
  assert.equal(a.kind, 'text');
  assert.deepEqual([a.p, a.hAlign, a.vAlign], [{ x: 0, y: 0 }, 0, 0]);
  near(a.h * a.wf * 4 * 0.6, 12, 'aligned canvas width'); near(a.wf, 1, 'aligned keeps wf');
  near(f.h, H, 'fit keeps h'); near(f.h * f.wf * 4 * 0.6, 12, 'fit canvas width');
});

test('pick box uses the registered canvas measure (cached) for TrueType text', () => {
  const d = doc('arial.ttf');
  const e = addEntity(d, makeText({ x: 0, y: 0 }, 2, 'WWW', { style: 'S', hAlign: 2 }));
  let calls = 0;
  setTextMeasure((t, font) => { calls++; assert.equal(font, 'arial'); return t.length * 0.9; });
  try {
    const b = bboxOf(e, d);
    near(b.maxx, 0, 'right aligned'); near(b.minx, -3 * 0.9 * 2, 'measured width');
    bboxOf(e, d);
    assert.equal(calls, 1, 'measure cached');
  } finally { setTextMeasure(null); }
});

test('TEXT DXF round trip keeps 10 / 11 / 72 / 73 for all 15 justifications (and ezdxf reads them)', (t) => {
  const d = doc();
  const combos = [[0, 0], [3, 0], [4, 0], [5, 0]];
  for (const ha of [0, 1, 2]) for (const va of [1, 2, 3]) combos.push([ha, va]);
  combos.push([1, 0], [2, 0]);
  assert.equal(combos.length, 15);
  combos.forEach(([ha, va], i) => {
    const p2 = ha === 3 || ha === 5 ? { x: 30, y: i * 5 + 2 } : undefined;
    addEntity(d, makeText({ x: 5, y: i * 5 }, H, 'ABC', { style: 'S', hAlign: ha, vAlign: va, p2, rot: p2 ? Math.atan2(2, 25) * 180 / Math.PI : 0 }));
  });
  const out = textOf(writeDxf(d));
  const back = parseDxf(out).entities.filter((e) => e.type === 'TEXT');
  assert.equal(back.length, 15);
  back.forEach((e, i) => {
    const [ha, va] = combos[i];
    assert.equal(e.hAlign, ha); assert.equal(e.vAlign, va);
    near(e.p.x, 5, `p.x ${ha}/${va}`); near(e.p.y, i * 5, `p.y ${ha}/${va}`);
    if (ha === 3 || ha === 5) assert.deepEqual(e.p2, { x: 30, y: i * 5 + 2 }, `p2 ${ha}`);
    else assert.equal(e.p2, undefined);
  });
  // group 10 of a right-aligned TEXT is the baseline start (AutoCAD's first alignment point), 11 the alignment point
  const W = strokeLayout('ABC', H).width;
  const right = out.split(/\r?\nTEXT\r?\n/).at(-1);
  const g = (c) => Number(right.match(new RegExp(`\\n *${c}\\r?\n([^\\r\\n]+)`))[1]);
  assert.equal(g(72), 2); near(g(10), 5 - W, 'group 10 = baseline start', 1e-6); near(g(11), 5, 'group 11');

  const py = ezdxfAvailable();
  if (!py) return t.skip('ezdxf not installed');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ash-text-'));
  try {
    const f = path.join(dir, 't.dxf');
    writeFileSync(f, out);
    const r = spawnSync(py, ['-c', `import ezdxf, sys, json
d = ezdxf.readfile(sys.argv[1])
print(json.dumps([[e.dxf.halign, e.dxf.valign, list(e.dxf.insert)[:2], list(e.dxf.get('align_point', (0, 0)))[:2]] for e in d.modelspace().query('TEXT')]))`, f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ez = JSON.parse(r.stdout.trim().split('\n').pop());
    ez.forEach(([ha, va, ins, al], i) => {
      assert.deepEqual([ha, va], combos[i]);
      if (combos[i][0] === 3 || combos[i][0] === 5) { near(ins[0], 5, 'ezdxf insert', 1e-6); near(al[0], 30, 'ezdxf align_point', 1e-6); }
      else if (ha || va) near(al[0], 5, 'ezdxf align_point', 1e-6);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mirroring Aligned text moves both points and keeps it reading left to right', () => {
  const e = makeText({ x: 0, y: 0 }, H, 'ABC', { hAlign: 3, p2: { x: 10, y: 0 } });
  const m = transformEntity(e, [-1, 0, 0, 1, 0, 0]); // mirror about the y axis
  assert.deepEqual([m.p, m.p2, m.rot], [{ x: -10, y: 0 }, { x: 0, y: 0 }, 0]);
});
