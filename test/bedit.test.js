import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, addBlock, makeLine, makeCircle } from '../src/core/model.js';
import { makeAttdef, instantiate, insertMatrix } from '../src/core/blocks.js';
import { Session, addEntities, moveEntities } from '../src/core/edit.js';
import { apply as applyMatrix } from '../src/core/geom.js';
import { blockEditError, editableBlocks, findBlockName, openBlockEdit, setBlockBase, blockEditDirty, saveBlockEdit } from '../src/core/bedit.js';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';

/** drawing with block BOX (one line, base 0,0) inserted twice */
function setup() {
  const doc = newDocument();
  const box = addBlock(doc, 'BOX', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 10, y: 0 })]);
  const a = addEntity(doc, instantiate(box, { x: 100, y: 0 }));
  const b = addEntity(doc, instantiate(box, { x: 200, y: 50 }, { rot: 90 }));
  return { doc, s: new Session(doc), a, b };
}

test('edit a copy, save: the definition is replaced in one undo step', () => {
  const { doc, s } = setup();
  const before = doc.blocks.get('BOX');
  const ed = openBlockEdit(doc, 'BOX');
  assert.equal(ed.doc.entities.length, 1);
  assert.notEqual(ed.doc.entities[0], before.entities[0], 'a copy');
  addEntities(ed.session, [makeCircle({ x: 5, y: 5 }, 2)]);
  moveEntities(ed.session, [ed.doc.entities[0].id], 0, 1);
  assert.equal(blockEditDirty(ed), true);
  assert.equal(doc.blocks.get('BOX'), before, 'the drawing is untouched while editing');
  assert.equal(before.entities.length, 1);
  assert.equal(before.entities[0].p1.y, 0);
  assert.equal(s.undoStack.length, 0);
  const r = saveBlockEdit(s, ed);
  assert.equal(r.synced, 0);
  assert.equal(s.undoStack.length, 1, 'one undo step');
  assert.equal(s.undoLabel, 'BEDIT BOX');
  const now = doc.blocks.get('BOX');
  assert.deepEqual(now.entities.map((e) => e.type), ['LINE', 'CIRCLE']);
  assert.equal(now.entities[0].p1.y, 1);
  assert.ok(now.entities.every((e) => e.id === 0), 'definition entities carry no ids, as BLOCK makes them');
  assert.equal(blockEditDirty(ed), false, 'saved');
  assert.deepEqual([...doc.blocks.keys()], ['BOX'], 'block order kept');
});

test('undo inside the editor works on the copy; undo / redo after saving restore the definitions', () => {
  const { doc, s } = setup();
  const before = doc.blocks.get('BOX');
  const ed = openBlockEdit(doc, 'BOX');
  addEntities(ed.session, [makeCircle({ x: 5, y: 5 }, 2)]);
  addEntities(ed.session, [makeCircle({ x: 9, y: 5 }, 1)]);
  ed.session.undo();
  assert.equal(ed.doc.entities.length, 2);
  assert.equal(s.undoStack.length, 0, 'the editor has its own undo');
  saveBlockEdit(s, ed);
  const after = doc.blocks.get('BOX');
  assert.equal(after.entities.length, 2);
  s.undo();
  assert.equal(doc.blocks.get('BOX'), before, 'undo restores the old definition');
  s.redo();
  assert.equal(doc.blocks.get('BOX'), after);
});

test('closing without saving (Discard) leaves the drawing unchanged', () => {
  const { doc, s } = setup();
  const snap = JSON.stringify(doc.blocks.get('BOX'));
  const ed = openBlockEdit(doc, 'BOX');
  addEntities(ed.session, [makeLine({ x: 0, y: 0 }, { x: 0, y: 9 })]);
  ed.session.transact('erase', (tx) => tx.remove([1]));
  assert.equal(JSON.stringify(doc.blocks.get('BOX')), snap);
  assert.equal(s.undoStack.length, 0);
});

test('xref, xref-dependent, anonymous and layout blocks are refused', () => {
  const { doc } = setup();
  addBlock(doc, 'XR', { x: 0, y: 0 }, []).xref = { path: 'a.dxf' };
  addBlock(doc, 'XR|DOOR', { x: 0, y: 0 }, []).xrefDep = 'XR';
  addBlock(doc, 'DEP', { x: 0, y: 0 }, []).xrefDep = 'XR';
  addBlock(doc, '*D1', { x: 0, y: 0 }, []);
  addBlock(doc, '*U2', { x: 0, y: 0 }, []);
  addBlock(doc, '*Model_Space', { x: 0, y: 0 }, []);
  addBlock(doc, '*Paper_Space0', { x: 0, y: 0 }, []);
  addBlock(doc, 'Aa', { x: 0, y: 0 }, []);
  assert.deepEqual(editableBlocks(doc), ['Aa', 'BOX']);
  assert.match(blockEditError(doc, 'XR'), /external reference/);
  assert.match(blockEditError(doc, 'XR|DOOR'), /external reference/);
  assert.match(blockEditError(doc, 'DEP'), /external reference/);
  assert.match(blockEditError(doc, '*D1'), /anonymous/);
  assert.match(blockEditError(doc, '*Model_Space'), /drawing space/);
  assert.match(blockEditError(doc, '*Paper_Space0'), /drawing space/);
  assert.match(blockEditError(doc, 'NOPE'), /no block/);
  assert.equal(blockEditError(doc, 'BOX'), null);
  assert.throws(() => openBlockEdit(doc, '*U2'), { code: 'NOT_EDITABLE' });
  assert.equal(findBlockName(doc, 'box'), 'BOX');
  assert.equal(findBlockName(doc, 'zz'), null);
});

test('adding an ATTDEF syncs every reference in the same undo step', () => {
  const { doc, s, a, b } = setup();
  const ed = openBlockEdit(doc, 'BOX');
  addEntities(ed.session, [makeAttdef({ x: 1, y: 2 }, 2, 'TAG', { default: 'T-1' })]);
  const r = saveBlockEdit(s, ed);
  assert.equal(r.synced, 2);
  assert.equal(s.undoStack.length, 1);
  for (const id of [a.id, b.id]) {
    const ins = doc.entities.find((e) => e.id === id);
    assert.deepEqual(ins.attribs.map((x) => [x.attrib.tag, x.text]), [['TAG', 'T-1']]);
  }
  const ins = doc.entities.find((e) => e.id === a.id);
  assert.deepEqual(ins.attribs[0].p, { x: 101, y: 2 }, 'placed through the insert transform');
  s.undo();
  assert.ok(doc.entities.every((e) => !e.attribs), 'undo removes the synced attributes');
  assert.equal(doc.blocks.get('BOX').entities.length, 1);
});

test('a save without attribute changes leaves the references alone', () => {
  const { doc, s, a } = setup();
  const ins0 = doc.entities.find((e) => e.id === a.id);
  const ed = openBlockEdit(doc, 'BOX');
  addEntities(ed.session, [makeCircle({ x: 5, y: 5 }, 2)]);
  saveBlockEdit(s, ed);
  assert.equal(doc.entities.find((e) => e.id === a.id), ins0);
});

test('BASE keeps the geometry in block space, stores the new base and shifts the references', () => {
  const { doc, s, a } = setup();
  const ed = openBlockEdit(doc, 'BOX');
  setBlockBase(ed, { x: 10, y: 0 });
  assert.deepEqual(ed.state.base, { x: 10, y: 0 });
  assert.equal(blockEditDirty(ed), true);
  ed.session.undo();
  assert.deepEqual(ed.state.base, { x: 0, y: 0 }, 'undo in the editor restores the base');
  ed.session.redo();
  saveBlockEdit(s, ed);
  const blk = doc.blocks.get('BOX');
  assert.deepEqual(blk.base, { x: 10, y: 0 });
  assert.deepEqual(blk.entities[0].p2, { x: 10, y: 0 }, 'geometry unchanged in block space');
  const ins = doc.entities.find((e) => e.id === a.id);
  assert.deepEqual(applyMatrix(insertMatrix(ins, blk), blk.entities[0].p2), { x: 100, y: 0 }, 'the reference now shows the line ending at its insertion point');
  s.undo();
  assert.deepEqual(doc.blocks.get('BOX').base, { x: 0, y: 0 });
});

test('a block cannot contain a reference to itself', () => {
  const { doc, s } = setup();
  const ed = openBlockEdit(doc, 'BOX');
  addEntities(ed.session, [instantiate(doc.blocks.get('BOX'), { x: 0, y: 0 })]);
  assert.throws(() => saveBlockEdit(s, ed), { code: 'SELF_REF' });
  assert.equal(s.undoStack.length, 0);
});

test('a nested cycle (BOX contains C, C contains B, B contains BOX) is refused at any depth, case-insensitively', () => {
  const { doc, s } = setup();
  const b = addBlock(doc, 'B', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 })]);
  const c = addBlock(doc, 'C', { x: 0, y: 0 }, [instantiate(b, { x: 0, y: 0 })]);
  b.entities.push({ ...instantiate(doc.blocks.get('BOX'), { x: 0, y: 0 }), block: 'box' });
  const ed = openBlockEdit(doc, 'BOX');
  addEntities(ed.session, [instantiate(c, { x: 0, y: 0 })]);
  assert.throws(() => saveBlockEdit(s, ed), { code: 'SELF_REF' });
  assert.equal(s.undoStack.length, 0);
});

test('a saved definition is written to DXF and reads back', () => {
  const { doc, s } = setup();
  const ed = openBlockEdit(doc, 'BOX');
  addEntities(ed.session, [makeCircle({ x: 5, y: 5 }, 2), makeAttdef({ x: 1, y: 2 }, 2, 'TAG', { default: 'T-1' })]);
  setBlockBase(ed, { x: 2, y: 3 });
  saveBlockEdit(s, ed);
  const back = readDxf(new TextEncoder().encode(writeDxf(doc)));
  const blk = back.blocks.get('BOX');
  assert.deepEqual(blk.base, { x: 2, y: 3 });
  assert.deepEqual(blk.entities.map((e) => e.type), ['LINE', 'CIRCLE', 'TEXT']);
  assert.equal(blk.entities[2].attdef.tag, 'TAG');
  assert.deepEqual(blk.entities[1].c, { x: 5, y: 5 });
  assert.ok(back.entities.filter((e) => e.type === 'INSERT').every((e) => e.attribs?.[0]?.text === 'T-1'));
});
