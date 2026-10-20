import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { newDocument, makeText, addEntity, addTextStyle } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { apply, bboxOf } from '../src/core/geom.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { parseDxf } from '../src/core/dxfRead.js';
import { exportPdf } from '../src/core/exportPdf.js';
import { exportSvg } from '../src/core/exportSvg.js';

const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const textOf = (out) => (typeof out === 'string' ? out : out.text);
const P = { x: 10, y: 20 };
function docWith(genFlags, o = {}) {
  const d = newDocument();
  addEntity(d, makeText(P, 2.5, 'MIRRORED', { genFlags, ...o }));
  return d;
}
const textItem = (d) => buildScene(d).items.find((it) => it.kind === 'text');

test('TEXT 71 = 2 (backward): the scene item is mirrored in x about its alignment point', () => {
  for (const rot of [0, 30]) {
    const it = textItem(docWith(2, { rot })), r = rot * Math.PI / 180;
    assert.ok(it.xf, `rot ${rot}: mirror on the item`);
    const q0 = apply(it.xf, P), q1 = apply(it.xf, { x: P.x + Math.cos(r), y: P.y + Math.sin(r) });
    const q2 = apply(it.xf, { x: P.x - Math.sin(r), y: P.y + Math.cos(r) });
    near(q0.x, P.x, 'fixed x'); near(q0.y, P.y, 'fixed y');
    near(q1.x, P.x - Math.cos(r), 'along the baseline: reversed x'); near(q1.y, P.y - Math.sin(r), 'reversed y');
    near(q2.x, P.x - Math.sin(r), 'up stays up x'); near(q2.y, P.y + Math.cos(r), 'up stays up y');
  }
  // left-justified backward text runs to the left of its insertion point (box and pick extents too)
  const d = docWith(2), it = textItem(d), b = bboxOf(d.entities[0], d);
  near(it.bbox.maxx, P.x, 'item box ends at the point'); near(b.maxx, P.x, 'entity box ends at the point');
});

test('TEXT 71 = 4 (upside down): mirrored in y about the baseline; 6 both; 0 unchanged', () => {
  const it = textItem(docWith(4)), q = apply(it.xf, { x: P.x + 1, y: P.y + 1 });
  near(q.x, P.x + 1, 'x kept'); near(q.y, P.y - 1, 'y mirrored');
  assert.ok(it.bbox.maxy < P.y + 1, 'the text hangs below the baseline');
  const both = apply(textItem(docWith(6)).xf, { x: P.x + 1, y: P.y + 1 });
  near(both.x, P.x - 1, 'both x'); near(both.y, P.y - 1, 'both y');
  assert.equal(textItem(docWith(0)).xf, undefined, 'flag 0: no mirror');
  assert.equal(makeText(P, 1, 'A').genFlags, undefined, 'default TEXT carries no flags');
});

test('TEXT 71 on an SHX style: the stroke glyphs are mirrored about the alignment point', () => {
  const d = docWith(2, { style: 'S' });
  const st = addTextStyle(d, { name: 'S', font: 'romans' }); st.fontFile = 'romans.shx';
  const path = buildScene(d).items.find((it) => it.kind === 'path' && it.strokeText);
  const xs = path.ops.filter((v, i) => typeof v === 'number' && i % 3 === 1);
  assert.ok(Math.max(...xs) <= P.x + 1e-9 && Math.min(...xs) < P.x - 5, 'strokes left of the point');
  near(Math.cos(path.strokeText.rot), -1, 'LOD bar runs backward');
});

test('TEXT / ATTDEF 71: read -> write -> read keeps the flags; an embedded MTEXT 71 is not taken for them', () => {
  const d = newDocument();
  for (const g of [2, 4, 6]) addEntity(d, makeText({ x: g, y: 0 }, 1, `T${g}`, { genFlags: g }));
  addEntity(d, makeText({ x: 0, y: 5 }, 1, 'plain'));
  const back = parseDxf(textOf(writeDxf(d))).entities.filter((e) => e.type === 'TEXT');
  assert.deepEqual(back.map((e) => e.genFlags ?? 0), [2, 4, 6, 0]);
  const again = parseDxf(textOf(writeDxf({ ...d, entities: back }))).entities.filter((e) => e.type === 'TEXT');
  assert.deepEqual(again.map((e) => e.genFlags ?? 0), [2, 4, 6, 0]);
  const raw = (rows) => `0\nSECTION\n2\nENTITIES\n${rows.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
  const t = parseDxf(raw(['0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '1', '1', 'X', '71', '2'])).entities[0];
  assert.equal(t.genFlags, 2, 'TEXT 71 read');
  const a = parseDxf(raw(['0', 'ATTDEF', '8', '0', '10', '0', '20', '0', '40', '1', '1', 'V', '2', 'TAG', '70', '0', '101', 'Embedded Object', '10', '0', '20', '0', '71', '6'])).entities[0];
  assert.equal(a.genFlags ?? 0, 0, 'the 71 after 101 is the MTEXT attachment');
});

const pageText = async (bytes) => {
  const pdf = await PDFDocument.load(bytes), c = pdf.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
  return streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join('\n');
};
const textCm = (s) => [...s.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s+q\s+(?:\/\S+ gs\s+)?BT/g)].map((m) => m.slice(1, 5).map(Number));
const svgTextMatrix = (s) => { const m = /<text transform="matrix\(([^)]*)\)/.exec(s); return m && m[1].split(/\s+/).map(Number); };

test('PDF and SVG draw TEXT 71 mirrored: sign of the text matrix', async () => {
  const cases = { 0: [1, 1], 2: [-1, 1], 4: [1, -1] };
  for (const [g, [sa, sd]] of Object.entries(cases)) {
    const d = docWith(Number(g));
    const cms = textCm(await pageText((await exportPdf(d)).bytes));
    assert.equal(cms.length, 1, `flag ${g}: one text frame`);
    assert.equal(Math.sign(cms[0][0]), sa, `flag ${g}: PDF a`); assert.equal(Math.sign(cms[0][3]), sd, `flag ${g}: PDF d`);
    const m = svgTextMatrix(exportSvg(d));
    if (g === '0') { assert.equal(m, null, 'SVG: no mirror'); continue; }
    assert.equal(Math.sign(m[0]), sa, `flag ${g}: SVG a`); assert.equal(Math.sign(m[3]), sd, `flag ${g}: SVG d`);
  }
});
