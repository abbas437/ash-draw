// PDF export of text outside WinAnsi: bundled Noto fonts, per-character fallback, Arabic shaping and bidi order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { newDocument, addEntity, makeText } from '../src/core/model.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { textShaper } from '../src/core/pdfText.js';

const FONT_DIR = new URL('../renderer/assets/fonts/', import.meta.url);
const FILES = ['NotoSans-Regular.ttf', 'NotoSansArabic-Regular.ttf', 'NotoSansMath-Regular.ttf'];
const fontBytes = FILES.map((f) => readFileSync(new URL(f, FONT_DIR)));
const docWith = (...ents) => { const d = newDocument(); for (const e of ents) addEntity(d, e); return d; };

async function shaper() {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const uni = [];
  for (const b of fontBytes) uni.push(await pdf.embedFont(b, { subset: true }));
  return { shape: textShaper(helv, uni), helv, uni };
}

test('PDF: technical symbols (±, Ø, °, ≤, ⌀) export with no missing-glyph warning', async () => {
  let loads = 0;
  const unicodeFonts = async () => { loads++; return fontBytes; };
  const a = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, '±0.00 Ø150 25°C')), { unicodeFonts });
  assert.deepEqual(a.warnings, []);
  assert.equal(loads, 0, 'WinAnsi text does not load the Unicode fonts');
  const b = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, '±0.00 ⌀150 ≤ 25°C')), { unicodeFonts });
  assert.deepEqual(b.warnings, []);
  assert.equal(loads, 1);
});

test('PDF: Arabic text is shaped (joining forms) with the Arabic font, right to left', async () => {
  const r = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'مخطط التكييف')), { unicodeFonts: fontBytes });
  assert.deepEqual(r.warnings, []);
  const pdf = await PDFDocument.load(r.bytes);
  const fonts = pdf.context.enumerateIndirectObjects().map(([, o]) => o.get?.(pdf.context.obj('BaseFont').constructor.of('BaseFont'))?.toString()).filter(Boolean);
  assert.ok(fonts.some((f) => /NotoSansArabic/.test(f)), fonts.join(','));
  const { shape, uni } = await shaper();
  const sh = shape('مخطط التكييف');
  assert.ok(sh.runs.every((x) => x.font === uni[1]), 'one Arabic-font run');
  const all = sh.runs.flatMap((x) => x.glyphs), g = all.filter((x) => x.glyph.codePoints.length), fk = uni[1].embedder.font;
  const iso = (cp) => fk.glyphForCodePoint(cp).id;
  // visual left-to-right order: the last letter of the second word (feh, final form) first, the first letter of the
  // first word (meem, initial form) last; neither is its isolated (unshaped) glyph
  assert.deepEqual([g[0].glyph.codePoints, g.at(-1).glyph.codePoints], [[0x641], [0x645]]);
  assert.notEqual(g[0].glyph.id, iso(0x641));
  assert.notEqual(g.at(-1).glyph.id, iso(0x645));
  // the dot of khah is a mark positioned by GPOS over its base (Noto decomposes dotted letters)
  assert.ok(all.some((x) => x.dx || x.dy), 'a positioned mark');
});

test('PDF: mixed Arabic and numbers keep the number left to right', async () => {
  const { shape } = await shaper();
  const sh = shape('غرفة 123');
  assert.equal(sh.runs[0].text, '123');
  const g = sh.runs.at(-1).glyphs;
  assert.deepEqual(g.at(-1).glyph.codePoints, [0x63A], 'ghain (first letter) is drawn rightmost');
  const r = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'غرفة 101')), { unicodeFonts: fontBytes });
  assert.deepEqual(r.warnings, []);
});

test('PDF: centred Arabic text is centred on its shaped width', async () => {
  const { shape } = await shaper();
  const t = 'مخطط التكييف', w = shape(t).width * 10;
  const unshaped = [...t].reduce((s, ch) => s + shape(ch).width * 10, 0);
  assert.ok(Math.abs(w - unshaped) > 0.5, `shaped ${w} vs isolated ${unshaped}`);
  const e = makeText({ x: 100, y: 50 }, 10, t);
  e.hAlign = 1; e.align2 = { x: 100, y: 50 };
  const r = await exportPdf(docWith(e, makeText({ x: 0, y: 0 }, 1, '.'), makeText({ x: 200, y: 100 }, 1, '.')), { unicodeFonts: fontBytes, pageSize: 'fit', margin: 0 });
  assert.deepEqual(r.warnings, []);
  const pdf = await PDFDocument.load(r.bytes);
  const { decodePDFRawStream, PDFArray } = await import('pdf-lib');
  const c = pdf.getPage(0).node.Contents();
  const st = c instanceof PDFArray ? c.asArray().map((x) => pdf.context.lookup(x)) : [c];
  const text = st.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join('\n');
  // first Tm of the Arabic line: its left end, in the text frame whose origin is the insertion point
  const m = text.match(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s*\[/);
  assert.ok(m, text.slice(0, 400));
  const k = 72 / 25.4;
  assert.ok(Math.abs(+m[1] + (w / 2) * k) < 0.05, `left end ${m[1]} vs -${(w / 2) * k}`);
});
