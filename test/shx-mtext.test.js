// MTEXT in SHX styles / with SHX run fonts: stroke-font runs as path items on one layout with the canvas runs
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, makeMText, addEntity, addTextStyle } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { strokeLayout } from '../src/core/shx.js';
import { exportSvg } from '../src/core/exportSvg.js';

function docWith(fontFile, text, o = {}) {
  const doc = newDocument();
  const st = addTextStyle(doc, { name: 'S', font: fontFile.replace(/\.\w+$/, '') });
  st.fontFile = fontFile;
  addEntity(doc, makeMText({ x: 0, y: 0 }, 2.5, text, { style: 'S', ...o }));
  return doc;
}
const items = (doc) => buildScene(doc).items;
const paths = (doc) => items(doc).filter((it) => it.kind === 'path');
function ink(list) {
  const b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  for (const it of [list].flat()) {
    for (let i = 0; i < it.ops.length; i += 3) {
      const [x, y] = [it.ops[i + 1], it.ops[i + 2]];
      b.minx = Math.min(b.minx, x); b.maxx = Math.max(b.maxx, x); b.miny = Math.min(b.miny, y); b.maxy = Math.max(b.maxy, y);
    }
  }
  return b;
}
const ABC_INK = (60 - 1 - 3) * 2.5 / 21;   // see shx.test.js
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('MTEXT in a romans.shx style: stroke path ops, cap height = text height, top attachment at the cap top', () => {
  const its = items(docWith('romans.shx', 'ABC'));
  assert.equal(its.filter((it) => it.kind === 'text').length, 0, 'no canvas text item');
  const ps = its.filter((it) => it.kind === 'path');
  assert.equal(ps.length, 1);
  assert.ok(ps[0].strokeText, 'LOD bar data');
  const b = ink(ps);
  near(b.maxx - b.minx, ABC_INK, 1e-9, 'ink width');
  near(b.maxy, 0, 1e-9, 'cap top at the insertion point (attach top-left)');
  near(b.miny, -2.5, 1e-9, 'baseline one cap height below');
});

test('MTEXT SHX line height and wrap width use the stroke measure', () => {
  const two = paths(docWith('romans.shx', 'A\\PA'));
  assert.equal(two.length, 2, 'one path item per line');
  near(ink(two[0]).miny - ink(two[1]).miny, 1.25 * 2.5, 1e-9, 'baseline pitch');
  // "ABC ABC": stroke width 2 x 7.14 + space 1.9 = 16.2 (0.6 h per character would be 10.5)
  const one = strokeLayout('ABC ABC', 2.5).width;
  assert.equal(paths(docWith('romans.shx', 'ABC ABC', { width: one + 0.1 })).length, 1, 'fits on one line');
  const wrapped = paths(docWith('romans.shx', 'ABC ABC', { width: 12 }));
  assert.equal(wrapped.length, 2, 'wraps at the stroke width');
  near(ink(wrapped[0]).minx, ink(wrapped[1]).minx, 1e-9, 'second line starts at the left edge');
});

test('mixed MTEXT: the TrueType run starts where the SHX run ends, on one fixed layout', () => {
  const its = items(docWith('romans.shx', 'ABC{\\fArial|b0|i0;DEF}'));
  const txt = its.find((it) => it.kind === 'text');
  assert.ok(txt?.lay, 'text item with a fixed layout');
  assert.deepEqual(txt.lay.glyphs.map((g) => g.text), ['DEF']);
  const end = strokeLayout('ABC', 2.5).width;
  near(txt.lay.glyphs[0].x, end, end * 0.01, 'DEF starts at the end of ABC');
  assert.ok(ink(its.filter((it) => it.kind === 'path')).maxx < txt.p.x + txt.lay.glyphs[0].x);
  // same baseline
  near(txt.lay.glyphs[0].y, 2.5, 1e-9, 'baseline (cap height of the SHX run, the taller ascent)');
});

test('MTEXT \\F run font: only the SHX run is stroked in a TrueType style', () => {
  const doc = docWith('arial.ttf', 'xx{\\Fromans.shx;AB}yy');
  const its = items(doc);
  assert.equal(its.filter((it) => it.kind === 'path').length, 1);
  assert.deepEqual(its.find((it) => it.kind === 'text').lay.glyphs.map((g) => g.text), ['xx', 'yy']);
  // pure TrueType MTEXT keeps the lazy canvas layout
  const plain = items(docWith('arial.ttf', 'xx yy'));
  assert.equal(plain.length, 1); assert.equal(plain[0].lay, undefined);
});

test('MTEXT SHX: width factor, oblique, colour, underline and stacks drawn with strokes; missing glyph run on canvas', () => {
  const wide = ink(paths(docWith('romans.shx', '{\\W2;ABC}')));
  near(wide.maxx - wide.minx, 2 * ABC_INK, 1e-9, 'width factor');
  const obl = ink(paths(docWith('romans.shx', '{\\Q15;I}'))), up = ink(paths(docWith('romans.shx', 'I')));
  near(obl.maxx - obl.minx, (up.maxx - up.minx) + 2.5 * Math.tan(15 * Math.PI / 180), 1e-9, 'oblique slant');
  const red = paths(docWith('romans.shx', 'A{\\C1;B}'));
  assert.equal(red.length, 2);
  assert.deepEqual(red.map((it) => it.style.color.rgb).filter((c) => c[0] === 255 && c[1] === 0).length, 1, 'one red item');
  const ul = ink(paths(docWith('romans.shx', '\\LA')));
  near(ul.miny, -2.5 - 0.15 * 2.5, 1e-9, 'underline stroke below the baseline');
  const st = items(docWith('romans.shx', '\\S1/2;'));
  assert.equal(st.filter((it) => it.kind === 'text').length, 0, 'stack fully stroked (digits and bar)');
  const fb = items(docWith('romans.shx', 'AB {\\fromans|b0;\u0645x}'));
  const t = fb.find((it) => it.kind === 'text');
  assert.deepEqual(t.lay.glyphs.map((g) => g.text), ['\u0645x'], 'the run with an Arabic letter stays on canvas');
  assert.equal(fb.filter((it) => it.kind === 'path').length, 1);
});

test('SVG export: SHX MTEXT runs are paths, TrueType runs text', () => {
  const svg = exportSvg(docWith('romans.shx', 'ABC{\\fArial|b0|i0;DEF}'));
  assert.match(svg, /<path d="M[^"]+" stroke="rgb\(0,0,0\)"/);
  assert.match(svg, />DEF<\/text>/);
  assert.doesNotMatch(svg, />ABC/);
});
