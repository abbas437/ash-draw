// PDF export of text outside WinAnsi: bundled Noto fonts, per-character fallback, Arabic shaping and bidi order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { newDocument, addEntity, makeText, makeMText } from '../src/core/model.js';
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

// ---- helpers reading a plotted PDF back --------------------------------------------------------------------------
import { PDFArray, PDFName, PDFDict, PDFRawStream, PDFHexString, decodePDFRawStream } from 'pdf-lib';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const streamText = (pdf, ref) => new TextDecoder('latin1').decode(decodePDFRawStream(pdf.context.lookup(ref)).decode());
const pageContent = (pdf) => {
  const c = pdf.getPage(0).node.Contents();
  return (c instanceof PDFArray ? c.asArray().map((x) => pdf.context.lookup(x)) : [c])
    .map((s) => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode())).join('\n');
};
/** page font resources: name -> {base, dict} */
const pageFonts = (pdf) => {
  const fd = pdf.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict), out = {};
  for (const [k, v] of fd.entries()) { const d = pdf.context.lookup(v, PDFDict); out[k.decodeText()] = { base: d.get(PDFName.of('BaseFont')).decodeText(), dict: d }; }
  return out;
};
/** the shown strings in drawing order: {font base name, x, y (summed cm and Tm translations), hex, ids (2-byte codes)} */
function shownText(pdf) {
  const fonts = pageFonts(pdf), shown = [], stack = [[0, 0]];
  let cm = [0, 0], font = null, tm = [0, 0];
  for (const line of pageContent(pdf).split('\n')) {
    let m;
    if (line === 'q') stack.push(cm);
    else if (line === 'Q') cm = stack.pop();
    else if ((m = line.match(/^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm$/))) cm = [cm[0] + +m[5], cm[1] + +m[6]];
    else if ((m = line.match(/^\/(\S+) \S+ Tf$/))) font = m[1];
    else if ((m = line.match(/^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) Tm$/))) tm = [+m[5], +m[6]];
    else if ((m = line.match(/^(.*) (Tj|TJ)$/)) && font) {
      const hex = [...m[1].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]).join('');
      shown.push({ font, base: fonts[font].base, x: cm[0] + tm[0], y: cm[1] + tm[1], hex });
    }
  }
  return { shown, fonts };
}
/** the embedded TrueType program (FontFile2) of an embedded font resource */
function fontProgram(pdf, fontDict) {
  const cid = pdf.context.lookup(pdf.context.lookup(fontDict.get(PDFName.of('DescendantFonts')), PDFArray).get(0), PDFDict);
  const desc = pdf.context.lookup(cid.get(PDFName.of('FontDescriptor')), PDFDict);
  return decodePDFRawStream(pdf.context.lookup(desc.get(PDFName.of('FontFile2')))).decode();
}

test('PDF: every glyph drawn from each bundled font has an outline in the embedded subset', async () => {
  const strings = [
    'ПриветмирΩμέγααβγδΔЖщ№ℓ',           // Noto Sans: Cyrillic, Greek (tonos), symbols
    '≤≥⌀→∑√∞≈≠∅',                          // Noto Sans Math
    'التكييفمدخلغرفةإله',                  // Noto Sans Arabic (joining forms and mark glyphs)
  ];
  const seenFonts = new Set();
  for (const str of strings) {
    const r = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, str)), { unicodeFonts: fontBytes });
    assert.deepEqual(r.warnings, [], str);
    const pdf = await PDFDocument.load(r.bytes);
    const { shown, fonts } = shownText(pdf);
    const used = new Map(); // font resource -> Set of subset glyph ids
    for (const s of shown) {
      assert.match(s.base, /Noto/, 'drawn with an embedded Noto subset');
      if (!used.has(s.font)) used.set(s.font, new Set());
      for (let i = 0; i < s.hex.length; i += 4) used.get(s.font).add(parseInt(s.hex.slice(i, i + 4), 16));
    }
    assert.ok(used.size > 0);
    for (const [name, ids] of used) {
      seenFonts.add(fonts[name].base.replace(/-\d+$/, ''));
      const ttf = fontkit.create(Buffer.from(fontProgram(pdf, fonts[name].dict)));
      for (const id of ids) {
        const cmds = ttf.getGlyph(id).path.commands.length;
        assert.ok(cmds > 0, `${fonts[name].base}: glyph ${id} of "${str}" has no outline`);
      }
    }
  }
  assert.deepEqual([...seenFonts].sort(), ['NotoSans-Regular', 'NotoSansArabic-Regular', 'NotoSansMath-Regular']);
});

test('PDF: the bundled fonts keep every glyph record 2-byte aligned (fontkit subsets with a short loca)', () => {
  for (const b of fontBytes) {
    const f = fontkit.create(Buffer.from(b));
    const o = f.loca.offsets;
    assert.ok(o.every((x) => x % 2 === 0), 'glyph offsets and lengths are even');
  }
});

const decodeActual = (h) => { const b = Buffer.from(h, 'hex'); assert.equal(b.readUInt16BE(0), 0xfeff); return b.subarray(2).swap16().toString('utf16le'); };

test('PDF: shaped runs carry /ActualText with the logical text, and the ToUnicode maps have no empty entries', async () => {
  const text = 'التكييف مدخل غرفة إله';
  const r = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, text)), { unicodeFonts: fontBytes });
  assert.deepEqual(r.warnings, []);
  const pdf = await PDFDocument.load(r.bytes);
  const content = pageContent(pdf);
  const spans = [...content.matchAll(/\/Span <<\s*\/ActualText <(FEFF[0-9A-F]+)>\s*>>\s*BDC/g)].map((m) => decodeActual(m[1]));
  assert.deepEqual(spans, [text]);
  assert.equal((content.match(/\bEMC\b/g) ?? []).length, spans.length);
  for (const [, o] of pdf.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    const t = new TextDecoder('latin1').decode(decodePDFRawStream(o).decode());
    if (t.includes('beginbfchar')) assert.ok(!/<>/.test(t), 'no empty bfchar target');
  }
  const probe = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  // only poppler's pdftotext (the Windows runner ships an older xpdf one that extracts nothing from CID fonts)
  if (probe.error || !/poppler/i.test(`${probe.stdout}${probe.stderr}`)) return;
  const dir = mkdtempSync(join(tmpdir(), 'ash-pdftotext-'));
  try {
    writeFileSync(join(dir, 'a.pdf'), r.bytes);
    const out = spawnSync('pdftotext', ['-enc', 'UTF-8', join(dir, 'a.pdf'), '-'], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    // poppler lays right-to-left text out in visual order itself, so a word comes out as written or character-reversed;
    // either way it is whole (a shared glyph id no longer turns letters into other letters)
    for (const w of text.split(' ')) assert.ok(out.stdout.includes(w) || out.stdout.includes([...w].reverse().join('')), `"${w}" in ${JSON.stringify(out.stdout)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PDF: Latin pieces of an MTEXT line with Arabic keep their bold / italic', async () => {
  const mt = makeMText({ x: 0, y: 0 }, 2.5, 'مخطط {\\fArial|b1|i0;AHU-1} رقم 12');
  const r = await exportPdf(docWith(mt), { unicodeFonts: fontBytes });
  assert.deepEqual(r.warnings, []);
  const { shown } = shownText(await PDFDocument.load(r.bytes));
  const hexOf = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
  const bold = shown.find((s) => s.hex.includes(hexOf('AHU-1')) || s.hex === hexOf('AHU-1'));
  assert.ok(bold, JSON.stringify(shown.map((s) => [s.base, s.hex])));
  assert.equal(bold.base, 'Helvetica-Bold');
  const plain = shown.find((s) => s.hex === hexOf('12'));
  assert.equal(plain?.base, 'Helvetica');
});

test('PDF: MTEXT lines with Arabic are put in visual order per line (number left of the Arabic word)', async () => {
  const mt = makeMText({ x: 0, y: 0 }, 2.5, 'غرفة 12\\Pمطبخ 345');
  const r = await exportPdf(docWith(mt), { unicodeFonts: fontBytes });
  assert.deepEqual(r.warnings, []);
  const { shown } = shownText(await PDFDocument.load(r.bytes));
  const hexOf = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
  for (const num of ['12', '345']) {
    const d = shown.find((s) => s.hex === hexOf(num));
    assert.ok(d, `digits ${num}`);
    const arabic = shown.filter((s) => /Arabic/.test(s.base) && Math.abs(s.y - d.y) < 1);
    assert.ok(arabic.length, `Arabic word on the line of ${num}`);
    assert.ok(arabic.every((a) => a.x > d.x), `${num} lies left of the Arabic word on its line`);
  }
  const y = (n) => shown.find((s) => s.hex === hexOf(n)).y;
  assert.ok(y('12') !== y('345'), 'two lines');
});

test('PDF: a Unicode font that fails to load does not abort the export', async () => {
  const bad = [new Uint8Array([1, 2, 3, 4]), fontBytes[1], fontBytes[2]];
  const r = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'Ωμέγα'), makeText({ x: 0, y: 10 }, 2.5, 'مخطط')), { unicodeFonts: bad });
  assert.deepEqual(r.warnings, ['5 text characters could not be drawn (the Unicode font could not be loaded)']);
  const rejected = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'Ωμέγα')), { unicodeFonts: async () => { throw new Error('x'); } });
  assert.deepEqual(rejected.warnings, ['5 text characters could not be drawn (the Unicode font could not be loaded)']);
  const failedList = Object.assign([fontBytes[1], fontBytes[2]], { failed: ['NotoSans-Regular.ttf'] });
  const partial = await exportPdf(docWith(makeText({ x: 0, y: 0 }, 2.5, 'Ωμέγα')), { unicodeFonts: failedList });
  assert.deepEqual(partial.warnings, ['5 text characters could not be drawn (the Unicode font could not be loaded)']);
});
