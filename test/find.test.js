import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, makeText, makeMText, makeLine, makeDimension } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { plainText } from '../src/core/dxfRead.js';
import { displayText, findInText, replaceInRaw, findInDocument, replaceInDocument } from '../src/core/find.js';

test('displayed text agrees with the renderer (plainText)', () => {
  for (const raw of ['PUMP P-101', '%%c200 %%d %%p0.5 %%uUNDER%%u', '\\U+00C9TAGE', '{\\fArial|b1;PUMP} P-101\\PSTANDBY',
    '\\C1;RED\\~TEXT', '\\S1/2; INCH', 'a \\\\ b', '{\\H2.5x;\\LTitle\\l}', '%%065BC']) {
    assert.equal(displayText(raw), plainText(raw), raw);
  }
  // escaped braces are literal (plainText currently drops them to \u0001 - see report)
  assert.equal(displayText('\\{c\\}'), '{c}');
});

test('match case', () => {
  assert.deepEqual(findInText('Pump pump PUMP', 'pump'), [[0, 4], [5, 9], [10, 14]]);
  assert.deepEqual(findInText('Pump pump PUMP', 'pump', { matchCase: true }), [[5, 9]]);
  assert.deepEqual(findInText('abc', ''), []);
  assert.deepEqual(findInText('a.b axb', 'a.b'), [[0, 3]], 'query is literal, not a regex');
});

test('whole words', () => {
  const s = 'PUMP PUMPS SUBPUMP PUMP_1 (PUMP) PUMP-2 ÉPUMP';
  assert.deepEqual(findInText(s, 'pump', { wholeWord: true }), [[0, 4], [27, 31], [33, 37]]);
  assert.equal(findInText(s, 'pump').length, 7);
});

test('MTEXT formatting codes are ignored when matching', () => {
  const raw = '{\\fArial|b1;PU\\C1;MP} ST\\PANDBY %%c50';
  const plain = displayText(raw);
  assert.equal(plain, 'PUMP ST\nANDBY Ø50');
  assert.deepEqual(findInText(plain, 'PUMP'), [[0, 4]]);
  assert.deepEqual(findInText(plain, 'Ø50'), [[14, 17]]);
});

test('replace keeps formatting codes around the match', () => {
  const raw = '{\\fArial|b1;PUMP} P-101\\PPUMP';
  assert.deepEqual(replaceInRaw(raw, 'pump', 'FAN', {}, { mtext: true }), { text: '{\\fArial|b1;FAN} P-101\\PFAN', count: 2 });
  assert.deepEqual(replaceInRaw(raw, 'pump', 'FAN', {}, { mtext: true, only: new Set([1]) }).text, '{\\fArial|b1;PUMP} P-101\\PFAN');
});

test('replace across a code keeps the code after the replacement (documented limitation)', () => {
  // the colour code covered only "MP"; it stays, braces stay balanced, and the replacement is unformatted
  assert.equal(replaceInRaw('PU{\\C1;MP} 1', 'PUMP', 'FAN', {}, { mtext: true }).text, 'FAN{\\C1;} 1');
  assert.equal(displayText('FAN{\\C1;} 1'), 'FAN 1');
});

test('replacement text is escaped for MTEXT and flattened for TEXT', () => {
  assert.equal(replaceInRaw('X', 'X', 'a{b}\\c\nd', {}, { mtext: true }).text, 'a\\{b\\}\\\\c\\Pd');
  assert.equal(displayText('a\\{b\\}\\\\c\\Pd'), 'a{b}\\c\nd');
  assert.equal(replaceInRaw('X', 'X', 'a\nb', {}, { mtext: false }).text, 'a b');
});

function sampleDoc() {
  const doc = newDocument();
  const t1 = addEntity(doc, makeText({ x: 0, y: 0 }, 1, 'PUMP P-101', { layer: 'TAGS' }));
  const t2 = addEntity(doc, makeMText({ x: 0, y: 5 }, 1, '{\\C1;Pump} room\\Pspare pump', {}));
  addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }));
  const d = addEntity(doc, makeDimension('*D1', { text: 'PUMP <>' }));
  return { doc, t1, t2, d };
}

test('findInDocument searches TEXT, MTEXT and dimension overrides', () => {
  const { doc, t1, t2, d } = sampleDoc();
  const r = findInDocument(doc, 'pump', { wholeWord: true });
  assert.deepEqual(r.map((x) => [x.id, x.index, x.editable]), [[t1.id, 0, true], [t2.id, 0, true], [t2.id, 1, true], [d.id, 0, false]]);
  assert.equal(r[0].layer, 'TAGS');
  assert.equal(r[1].text, 'Pump room\nspare pump');
  assert.equal(findInDocument(doc, 'pump', { matchCase: true }).length, 1);
});

test('replace all is one undo step and skips dimensions', () => {
  const { doc, t1, t2, d } = sampleDoc();
  const s = new Session(doc);
  assert.equal(replaceInDocument(s, 'pump', 'FAN'), 3);
  assert.equal(doc.entities.find((e) => e.id === t1.id).text, 'FAN P-101');
  assert.equal(doc.entities.find((e) => e.id === t2.id).text, '{\\C1;FAN} room\\Pspare FAN');
  assert.equal(doc.entities.find((e) => e.id === d.id).text, 'PUMP <>');
  assert.equal(s.undoStack.length, 1);
  s.undo();
  assert.equal(doc.entities.find((e) => e.id === t1.id).text, 'PUMP P-101');
  assert.equal(doc.entities.find((e) => e.id === t2.id).text, '{\\C1;Pump} room\\Pspare pump');
});

test('replace one match', () => {
  const { doc, t2, d } = sampleDoc();
  const s = new Session(doc);
  assert.equal(replaceInDocument(s, 'pump', 'FAN', {}, [{ id: t2.id, index: 1 }, { id: d.id, index: 0 }]), 1);
  assert.equal(doc.entities.find((e) => e.id === t2.id).text, '{\\C1;Pump} room\\Pspare FAN');
  assert.equal(replaceInDocument(s, 'nothing', 'x'), 0);
  assert.equal(s.undoStack.length, 1, 'no-op replace is not recorded');
});
