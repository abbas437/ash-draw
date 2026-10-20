import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, addBlock, getEntity, makeText, makeMText, makeLine, makeDimension, makeInsert } from '../src/core/model.js';
import { makeAttdef, instantiate, ATT_INVISIBLE } from '../src/core/blocks.js';
import { Session } from '../src/core/edit.js';
import { plainText } from '../src/core/dxfRead.js';
import * as find from '../src/core/find.js';

const { displayText, findInText, replaceInRaw, findInDocument, replaceInDocument } = find;

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

/** a P&ID-like drawing: VALVE block (tag attribute, a constant label, a nested BODY block with text), two INSERTs
 *  in model space, a paper-space TEXT on layout SHEET-01 */
function pidDoc() {
  const doc = newDocument();
  addBlock(doc, 'BODY', { x: 0, y: 0 }, [makeText({ x: 0, y: 0 }, 1, 'GATE BODY')]);
  addBlock(doc, 'VALVE', { x: 0, y: 0 }, [
    makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }),
    makeAttdef({ x: 0, y: 1 }, 1, 'TAG', { default: 'KV-0000' }),
    makeAttdef({ x: 0, y: 2 }, 1, 'NOTE', { default: 'GATE SECRET', flags: ATT_INVISIBLE }),
    makeMText({ x: 0, y: -1 }, 1, 'GATE VALVE'),
    makeInsert('BODY', { x: 0, y: -3 }),
  ]);
  const v1 = addEntity(doc, instantiate(doc.blocks.get('VALVE'), { x: 10, y: 10 }, { values: { TAG: 'KV-1013', NOTE: 'GATE SECRET' }, layer: 'VALVES' }));
  const v2 = addEntity(doc, instantiate(doc.blocks.get('VALVE'), { x: 30, y: 10 }, { values: { TAG: 'KV-1014' } }));
  const plain = addEntity(doc, makeText({ x: 0, y: 0 }, 1, 'FLOWMETER'));
  const sheet = { name: 'SHEET-01', tab: 1, entities: [] };
  doc.layouts = [sheet];
  const pt = makeText({ x: 5, y: 5 }, 2.5, 'KV-1013 SEE DETAIL'); pt.id = doc.nextId++; sheet.entities.push(pt);
  return { doc, v1, v2, plain, pt, sheet };
}

test('findInDocument: INSERT attributes (shown ones only), block contents via the INSERT, paper space', () => {
  const { doc, v1, v2, plain, pt } = pidDoc();
  const kv = findInDocument(doc, 'KV-1013');
  assert.deepEqual(kv.map((r) => [r.id, r.type, r.space, r.place, r.where, r.editable]), [
    [v1.id, 'ATTRIB', 'Model', 'Model', 'attribute TAG of block VALVE', true],
    [pt.id, 'TEXT', 'SHEET-01', 'Layout SHEET-01', '', true]]);
  assert.equal(kv[0].attrib, 0); assert.equal(kv[0].text, 'KV-1013');
  assert.equal(findInDocument(doc, 'TAG').length, 0, 'attribute tags are not searched');
  const gate = findInDocument(doc, 'gate');
  // invisible attribute value is not found; block text is reported once per INSERT occurrence, nested blocks too
  assert.deepEqual(gate.map((r) => [r.id, r.where, r.editable, !!r.inBlock]), [
    [v1.id, 'in block VALVE', false, true], [v1.id, 'in block BODY in block VALVE', false, true],
    [v2.id, 'in block VALVE', false, true], [v2.id, 'in block BODY in block VALVE', false, true]]);
  assert.equal(gate[1].text, 'GATE BODY');
  assert.deepEqual(findInDocument(doc, 'flowmeter').map((r) => [r.id, r.place]), [[plain.id, 'Model']]);
  // a layout's space doc (what the app searches while a layout is shown) finds the same matches
  const spaceDoc = Object.create(doc, { entities: { value: doc.layouts[0].entities }, modelDoc: { value: doc } });
  assert.deepEqual(findInDocument(spaceDoc, 'KV-1013').map((r) => r.id), [v1.id, pt.id]);
});

test('block-definition hits are capped; a block that contains itself does not loop', () => {
  const doc = newDocument();
  addBlock(doc, 'LOOP', { x: 0, y: 0 }, [makeText({ x: 0, y: 0 }, 1, 'ROOM'), makeInsert('LOOP', { x: 1, y: 0 })]);
  for (let i = 0; i < find.BLOCK_HIT_CAP + 5; i++) addEntity(doc, makeInsert('LOOP', { x: i, y: 0 }));
  const r = findInDocument(doc, 'room');
  assert.equal(r.length, find.BLOCK_HIT_CAP); assert.equal(r.blockHitsCapped, true);
});

test('replace: attributes and paper-space text are replaced, block definitions never; one undo step', () => {
  const { doc, v1, v2, pt, sheet } = pidDoc();
  const s = new Session(doc);
  const all = findInDocument(doc, 'KV-101');
  assert.equal(all.length, 3);
  assert.equal(replaceInDocument(s, 'KV-101', 'XV-201', {}, [all[0]]), 1, 'one attribute');
  assert.equal(getEntity(doc, v1.id).attribs[0].text, 'XV-2013');
  assert.equal(getEntity(doc, v2.id).attribs[0].text, 'KV-1014');
  assert.equal(replaceInDocument(s, 'gate', 'BALL'), 0, 'text inside block definitions is not replaced');
  assert.equal(doc.blocks.get('VALVE').entities[3].text, 'GATE VALVE');
  assert.equal(getEntity(doc, v1.id).attribs[1].text, 'GATE SECRET', 'invisible attribute untouched');
  assert.equal(replaceInDocument(s, 'KV-101', 'XV-201'), 2, 'replace all: the other attribute and the layout text');
  assert.equal(getEntity(doc, v2.id).attribs[0].text, 'XV-2014');
  assert.equal(sheet.entities[0].text, 'XV-2013 SEE DETAIL');
  s.undo();
  assert.equal(sheet.entities[0].text, 'KV-1013 SEE DETAIL');
  assert.equal(getEntity(doc, v2.id).attribs[0].text, 'KV-1014');
  assert.equal(pt.text, 'KV-1013 SEE DETAIL');
});
