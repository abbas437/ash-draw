import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { drawOrder, textToFront, hatchToBack } from '../src/core/draworder.js';

const solid = (h, x, color) => ['0', 'SOLID', '5', h, '330', '1F', '100', 'AcDbEntity', '8', '0', '62', String(color), '100', 'AcDbTrace',
  '10', x, '20', '0', '30', '0', '11', x + 10, '21', '0', '31', '0', '12', x, '22', '10', '32', '0', '13', x + 10, '23', '10', '33', '0'];
const sortents = (h, owner, pairs) => ['0', 'SORTENTSTABLE', '5', h, '330', 'D0', '100', 'AcDbSortentsTable', '330', owner,
  ...pairs.flatMap(([e, s]) => ['331', e, '5', s])];
function dxf({ model = [], block = [], objects = [] }) {
  const t = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'BLOCK_RECORD', '5', '1', '70', '2',
    '0', 'BLOCK_RECORD', '5', '1F', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', '*Model_Space',
    '0', 'BLOCK_RECORD', '5', '2A', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', 'B1',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '5', '2B', '8', '0', '2', 'B1', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'B1',
    ...block, '0', 'ENDBLK', '5', '2C', '8', '0', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...model, '0', 'ENDSEC',
    '0', 'SECTION', '2', 'OBJECTS', ...objects, '0', 'ENDSEC', '0', 'EOF'];
  return t.join('\n') + '\n';
}
const colors = (list) => list.map((e) => e.color);

test('SORTENTSTABLE puts the later solid under the earlier one', () => {
  const text = dxf({ model: [...solid('A0', 0, 1), ...solid('A1', 5, 2)], objects: sortents('D1', '1F', [['A1', '9F']]) });
  assert.deepEqual(colors(parseDxf(text).entities), [2, 1]);
  assert.deepEqual(colors(parseDxf(dxf({ model: [...solid('A0', 0, 1), ...solid('A1', 5, 2)] })).entities), [1, 2]);
});

test('entities not in the table keep handle order; sort handles interleave', () => {
  // file order A0 A1 A2 A3; A3 sorts as 9 (before A0), A0 sorts as A2 + (tie with A2's own handle: file order)
  const model = [...solid('A0', 0, 1), ...solid('A1', 1, 2), ...solid('A2', 2, 3), ...solid('A3', 3, 4)];
  const doc = parseDxf(dxf({ model, objects: sortents('D1', '1F', [['A3', '9'], ['A0', 'A2']]) }));
  assert.deepEqual(colors(doc.entities), [4, 2, 1, 3]);
});

test("a block definition's table applies to that block only", () => {
  const block = [...solid('B0', 0, 1), ...solid('B1', 5, 2)];
  const model = [...solid('A0', 0, 3), ...solid('A1', 5, 4)];
  const doc = parseDxf(dxf({ model, block, objects: sortents('D2', '2A', [['B1', '1']]) }));
  assert.deepEqual(colors(doc.blocks.get('B1').entities), [2, 1]);
  assert.deepEqual(colors(doc.entities), [3, 4]);
});

function session() {
  const doc = M.newDocument();
  for (let i = 1; i <= 5; i++) M.addEntity(doc, M.makeSolid([{ x: i, y: 0 }, { x: i + 1, y: 0 }, { x: i, y: 1 }, { x: i + 1, y: 1 }], { color: i }));
  return new Session(doc);
}
const ids = (s) => s.doc.entities.map((e) => e.id);

test('DRAWORDER Front / Back / Above / Under, and undo restores the exact order', () => {
  const s = session();
  const start = ids(s);
  assert.equal(drawOrder(s, [1, 3], 'front'), 2); assert.deepEqual(ids(s), [2, 4, 5, 1, 3]);
  assert.equal(drawOrder(s, [5, 3], 'back'), 2); assert.deepEqual(ids(s), [5, 3, 2, 4, 1]);
  assert.equal(drawOrder(s, [5], 'above', [2, 4]), 1); assert.deepEqual(ids(s), [3, 2, 4, 5, 1]);
  assert.equal(drawOrder(s, [1], 'under', [2, 4]), 1); assert.deepEqual(ids(s), [3, 1, 2, 4, 5]);
  assert.equal(drawOrder(s, [3], 'back'), 0, 'no change, no undo step');
  for (let i = 0; i < 4; i++) assert.ok(s.undo());
  assert.deepEqual(ids(s), start);
  s.redo(); assert.deepEqual(ids(s), [2, 4, 5, 1, 3]);
});

test('TEXTTOFRONT and HATCHTOBACK', () => {
  const doc = M.newDocument();
  const t = M.addEntity(doc, M.makeText({ x: 0, y: 0 }, 1, 'A'));
  const l = M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }));
  const s = new Session(doc);
  textToFront(s);
  assert.deepEqual(ids(s), [l.id, t.id]);
  const hatch = { ...M.makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }), type: 'HATCH' };
  M.addEntity(doc, hatch);
  hatchToBack(s);
  assert.deepEqual(ids(s), [hatch.id, l.id, t.id]);
});

test('write -> read keeps the draw order', () => {
  const text = dxf({ model: [...solid('A0', 0, 1), ...solid('A1', 5, 2)], objects: sortents('D1', '1F', [['A1', '9F']]) });
  const doc = parseDxf(text);
  const out = writeDxf(doc);
  const s = typeof out === 'string' ? out : out.text ?? new TextDecoder().decode(out);
  assert.ok(!/\nSORTENTSTABLE\r?\n/.test(s), 'no stale SORTENTSTABLE');
  assert.deepEqual(colors(parseDxf(s).entities), [2, 1]);
});



test('table handles match regardless of case and leading zeros (owner, entity and sort handles)', () => {
  const text = dxf({ model: [...solid('A0', 0, 1), ...solid('A1', 5, 2)], objects: sortents('D1', '001f', [['00a1', '09f']]) });
  assert.deepEqual(colors(parseDxf(text).entities), [2, 1]);
});
