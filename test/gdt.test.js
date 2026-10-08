import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, makeText, makeMText, addEntity, addTextStyle } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { GDT_MAP, isGdtFont, gdtText } from '../src/core/gdt.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { textFrame } from '../src/core/textMetrics.js';

function docWith(fontFile, make) {
  const doc = newDocument();
  const st = addTextStyle(doc, { name: 'S', font: fontFile.replace(/\.\w+$/, '') });
  st.fontFile = fontFile;
  addEntity(doc, make());
  return doc;
}
const textItem = (doc) => buildScene(doc).items.find((i) => i.kind === 'text');

test('GDT mapping: the confirmed letters', () => {
  const want = { a: 0x2220, b: 0x27C2, c: 0x25B1, d: 0x2313, e: 0x25CB, f: 0x2225, g: 0x232D, h: 0x2197, i: 0x232F, j: 0x2316,
    k: 0x2312, l: 0x24C1, m: 0x24C2, n: 0x2300, p: 0x24C5, r: 0x25CE, s: 0x24C8, t: 0x2330, u: 0x23E4 };
  assert.deepEqual(Object.keys(GDT_MAP).sort(), Object.keys(want).sort());
  for (const [k, cp] of Object.entries(want)) assert.equal(GDT_MAP[k].codePointAt(0), cp, k);
  assert.equal(gdtText('A1 q x'), 'A1 q x');                 // unconfirmed / uppercase / digits stay
  for (const f of ['gdt', 'GDT.SHX', 'amgdt.shx', 'C:\\x\\AMGDT.shx']) assert.ok(isGdtFont(f), f);
  for (const f of ['romans.shx', 'arial.ttf', 'gdt_iv25.shx', '']) assert.ok(!isGdtFont(f), f);
});

test('TEXT in a GDT style displays the mapped symbols, stored text unchanged', () => {
  const doc = docWith('gdt.shx', () => makeText({ x: 0, y: 0 }, 2.5, 'ejn', { style: 'S' }));
  assert.deepEqual(textItem(doc).lines, ['\u25CB\u2316\u2300']);
  assert.equal([...doc.entities.values()].find((e) => e.type === 'TEXT').text, 'ejn');
  const dxf = writeDxf(doc);
  assert.ok(/\n1\nejn\n/.test(dxf.replace(/\r/g, '')), 'DXF keeps the letters');
  assert.ok(!dxf.includes('\u2300'));
  assert.ok(textFrame({ p: { x: 0, y: 0 }, height: 1, text: 'ejn', style: 'S' }, doc).w > 0);
});

test('same TEXT in a non-GDT style is unchanged', () => {
  const doc = docWith('arial.ttf', () => makeText({ x: 0, y: 0 }, 2.5, 'ejn', { style: 'S' }));
  assert.deepEqual(textItem(doc).lines, ['ejn']);
});

test('MTEXT: GDT style and \\fgdt run map; other runs do not', () => {
  const a = docWith('amgdt.shx', () => makeMText({ x: 0, y: 0 }, 2.5, 'nj', { style: 'S' }));
  assert.equal(textItem(a).mt.paras[0].runs[0].text, '\u2300\u2316');
  const b = docWith('arial.ttf', () => makeMText({ x: 0, y: 0 }, 2.5, 'ab{\\fgdt;ab}', { style: 'S' }));
  assert.deepEqual(textItem(b).mt.paras[0].runs.map((r) => r.text), ['ab', '\u2220\u27C2']);
});

