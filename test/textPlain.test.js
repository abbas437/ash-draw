// Single-line TEXT / ATTRIB / ATTDEF values are not MTEXT: backslashes are characters (file paths), only \U+XXXX /
// \M+nXXXX and the %% codes are resolved. MTEXT keeps its formatting codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, makeText, addEntity, addBlock, makeInsert } from '../src/core/model.js';
import { buildScene } from '../src/core/render.js';
import { textFrame, textAdvance } from '../src/core/textMetrics.js';
import { textPlain, mtextPlain } from '../src/core/mtext.js';

const PATH = 'C:\\Proj\\Level 1\\PAVA.dwg';
const textItems = (doc) => buildScene(doc).items.filter((it) => it.kind === 'text');

test('textPlain: backslashes kept, \\U+ / \\M+ decoded, %% codes as in MTEXT', () => {
  assert.equal(textPlain(PATH), PATH);
  assert.equal(textPlain('..\\..\\Model\\PAVA\\Level 100 Model.dwg'), '..\\..\\Model\\PAVA\\Level 100 Model.dwg');
  assert.equal(textPlain('\\U+0627\\U+0628'), 'اب');
  assert.equal(textPlain('\\M+182A0'), 'あ', 'Shift-JIS 0x82A0');
  assert.equal(textPlain('\\M+182A0X'), 'あX', 'the code is 8 characters: the next one is kept');
  assert.equal(textPlain('90%%d %%p0.5 %%c20 %%u%%oA%%u%%o %%065'), '90° ±0.5 Ø20 A A');
  assert.equal(textPlain('{x}\\P\\L'), '{x}\\P\\L');
  for (const s of ['90%%d', '%%p1', '%%c5', '%%uA%%u', '%%065', '%%%', 'plain']) assert.equal(textPlain(s), mtextPlain(s), s);
  assert.equal(mtextPlain('A\\PB'), 'A\nB', 'MTEXT still reads its codes');
});

test('a TEXT holding a file path renders and measures as written; MTEXT A\\PB is two lines', () => {
  const doc = newDocument();
  const t = addEntity(doc, makeText({ x: 0, y: 0 }, 2, PATH));
  assert.deepEqual(textItems(doc)[0].lines, [PATH]);
  const f = textFrame(t, doc);
  assert.ok(Math.abs(f.w - textAdvance(PATH, 'Arial', false, false) * 2) < 1e-9, `width ${f.w}`);

  const deg = newDocument();
  addEntity(deg, makeText({ x: 0, y: 0 }, 2, '45%%d'));
  assert.deepEqual(textItems(deg)[0].lines, ['45°']);

  const mt = newDocument();
  addEntity(mt, { type: 'MTEXT', layer: '0', p: { x: 0, y: 0 }, height: 2, width: 0, attach: 1, text: 'A\\PB' });
  assert.deepEqual(textItems(mt)[0].lines, ['A', 'B']);
});

test('the placeholder of an unloaded xref shows its relative path as written', () => {
  const doc = newDocument();
  const ref = '..\\..\\..\\..\\Model\\PAVA\\Level 100 Model.dwg';
  addBlock(doc, 'L100', { x: 0, y: 0 }).xref = { path: ref, status: 'notfound', flags: 4 };
  addEntity(doc, makeInsert('L100', { x: 0, y: 0 }));
  const ph = textItems(doc).filter((it) => it.ui || it.lines);
  assert.deepEqual(ph[0].lines, [ref]);
});

test('Properties text box: MTEXT \\P <-> line breaks; TEXT / ATTRIB / ATTDEF shown and saved as written', async () => {
  const { editableText, storedText } = await import('../src/core/mtext.js');
  const path = 'C:\\Proj\\PAVA.dwg';
  for (const type of ['TEXT', 'ATTRIB', 'ATTDEF']) {
    assert.equal(editableText(type, path), path, type);
    assert.equal(storedText(type, editableText(type, path)), path, `${type}: saved unchanged`);
    assert.equal(storedText(type, 'a\nb'), 'a b', `${type}: one line`);
  }
  assert.equal(editableText('MTEXT', 'A\\PB'), 'A\nB');
  assert.equal(storedText('MTEXT', 'A\nB'), 'A\\PB');
});
