import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, makeText, addEntity, addTextStyle } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { shxSubstitute, strokeLayout } from '../src/core/shx.js';
import { exportSvg } from '../src/core/exportSvg.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { parseDxf } from '../src/core/dxfRead.js';

function docWith(fontFile, text, o = {}) {
  const doc = newDocument();
  const st = addTextStyle(doc, { name: 'S', font: fontFile.replace(/\.\w+$/, '') });
  st.fontFile = fontFile;
  const e = makeText({ x: 0, y: 0 }, 2.5, text, { style: 'S', ...o });
  addEntity(doc, e);
  return doc;
}
const itemsOf = (doc) => buildScene(doc).items;
const W = (b) => b.maxx - b.minx, H = (b) => b.maxy - b.miny;
/** extents of the drawn strokes (item.bbox also holds the estimated box that pick and zoom extents use) */
function ink(it) {
  const b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  for (let i = 0; i < it.ops.length; i += 3) {
    const [x, y] = [it.ops[i + 1], it.ops[i + 2]];
    b.minx = Math.min(b.minx, x); b.maxx = Math.max(b.maxx, x); b.miny = Math.min(b.miny, y); b.maxy = Math.max(b.maxy, y);
  }
  return b;
}
// Hershey Roman Simplex units (cap height 21): "ABC" ink runs from A's left stem (1 unit in) to C's right end (3 units
// short of its advance) over advances 18 + 21 + 21
const ABC_INK = (60 - 1 - 3) * 2.5 / 21;

test('SHX mapping: romans / simplex / txt / isocp get the stroke font, TrueType and symbol fonts do not', () => {
  for (const f of ['romans.shx', 'simplex.shx', 'txt.shx', 'isocp.shx', 'ROMANS.SHX', 'C:\\fonts\\romand.shx', 'company.shx', 'romans']) {
    assert.equal(shxSubstitute(f), 'simplex', f);
  }
  for (const f of ['arial.ttf', 'Arial', 'isocpeur.ttf', 'gdt.shx', 'symath.shx', '', null]) assert.equal(shxSubstitute(f), null, String(f));
});

test('"ABC" at height 2.5 in a romans.shx style: stroke paths, cap height 2.5, width from the glyph data', () => {
  const its = itemsOf(docWith('romans.shx', 'ABC'));
  assert.equal(its.length, 1);
  assert.equal(its[0].kind, 'path');
  assert.ok(its[0].ops.length > 20);
  const b = ink(its[0]);
  assert.ok(Math.abs(H(b) - 2.5) <= 0.05, `bbox height ${H(b)}`);
  assert.ok(Math.abs(W(b) - ABC_INK) <= ABC_INK * 0.1, `bbox width ${W(b)} vs ${ABC_INK}`);
  assert.ok(Math.abs(b.miny) < 1e-9 && Math.abs(b.minx - 2.5 / 21) < 1e-9, 'baseline start at the insertion point');
});

test('width factor 0.8 shrinks the stroke text width by 0.8; oblique slants it', () => {
  const w1 = W(ink(itemsOf(docWith('romans.shx', 'ABC'))[0]));
  const w8 = W(ink(itemsOf(docWith('romans.shx', 'ABC', { widthFactor: 0.8 }))[0]));
  assert.ok(Math.abs(w8 / w1 - 0.8) < 1e-9, `${w8 / w1}`);
  const ob = ink(itemsOf(docWith('romans.shx', 'I', { oblique: 15 }))[0]); // "I" is one vertical stroke
  assert.ok(Math.abs(W(ob) - 2.5 * Math.tan(15 * Math.PI / 180)) < 1e-9, `${W(ob)}`);
});

test('justification: centre and right ends sit on the alignment point; middle-centre is half the cap height', () => {
  const adv = strokeLayout('ABC', 2.5).width;
  const c = itemsOf(docWith('romans.shx', 'ABC', { hAlign: 1 }))[0].strokeText.p;
  const r = itemsOf(docWith('romans.shx', 'ABC', { hAlign: 2 }))[0].strokeText.p;
  const mc = ink(itemsOf(docWith('romans.shx', 'ABC', { hAlign: 1, vAlign: 2 }))[0]);
  assert.ok(Math.abs(c.x + adv / 2) < 1e-9 && Math.abs(r.x + adv) < 1e-9);
  assert.ok(Math.abs(mc.miny + 1.25) < 1e-9 && Math.abs(mc.maxy - 1.25) < 1e-9);
});

test('%%c / %%d / %%p map to Ø / ° / ± and are drawn with stroke glyphs', () => {
  const its = itemsOf(docWith('simplex.shx', '%%c50 %%p0.1 45%%d'));
  assert.equal(its[0].kind, 'path');
  for (const ch of ['Ø', '°', '±']) assert.ok(strokeLayout(ch, 1).strokes.length > 0, ch);
});

test('TrueType styles, and text with characters outside the stroke font, keep the canvas text path', () => {
  assert.equal(itemsOf(docWith('arial.ttf', 'ABC'))[0].kind, 'text');
  assert.equal(itemsOf(docWith('romans.shx', 'مرحبا'))[0].kind, 'text');
  assert.equal(itemsOf(docWith('gdt.shx', 'n10'))[0].kind, 'text');
});

test('SVG export draws SHX text as stroked paths; DXF save keeps the .shx file name', () => {
  const doc = docWith('romans.shx', 'ABC');
  const svg = exportSvg(doc);
  assert.ok(!svg.includes('<text'), 'no <text> element');
  assert.match(svg, /<path d="M[^"]+" stroke=/);
  const out = writeDxf(doc);
  const back = parseDxf(typeof out === 'string' ? out : out.text);
  assert.equal(back.textStyles.get('S').fontFile, 'romans.shx');
  const ob = writeDxf(docWith('romans.shx', 'I', { oblique: 15 }));
  assert.equal(parseDxf(typeof ob === 'string' ? ob : ob.text).entities[0].oblique, 15, 'TEXT oblique survives save and reopen');
});
