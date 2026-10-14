import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addLayer, addLinetype, addTextStyle, addBlock, addEntity, makeLine, makeText, makeInsert, makeCircle } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { buildFragment, fragmentDxf, readFragment, pasteFragment, unitScale } from '../src/core/clipboard.js';

function source() {
  const d = newDocument();
  d.units = 4; // mm
  addLinetype(d, { name: 'DASHED', pattern: [5, -2] });
  addLinetype(d, { name: 'UNUSED_LT', pattern: [1, -1] });
  addLayer(d, { name: 'WALLS', color: 1, linetype: 'DASHED' });
  addLayer(d, { name: 'UNUSED_LAYER' });
  addTextStyle(d, { name: 'NOTES', font: 'Arial' });
  addTextStyle(d, { name: 'UNUSED_STYLE' });
  addBlock(d, 'INNER', { x: 0, y: 0 }, [makeCircle({ x: 0, y: 0 }, 1, { layer: 'WALLS' })]);
  addBlock(d, 'DOOR', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }), makeInsert('INNER', { x: 0, y: 0 })]);
  addBlock(d, 'UNUSED_BLOCK', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 1 })]);
  const a = addEntity(d, makeLine({ x: 10, y: 10 }, { x: 20, y: 10 }, { layer: 'WALLS' }));
  const b = addEntity(d, makeText({ x: 10, y: 20 }, 2.5, 'hi', { style: 'NOTES' }));
  const c = addEntity(d, makeInsert('DOOR', { x: 30, y: 10 }));
  return { d, ids: [a.id, b.id, c.id] };
}

test('fragment: referenced tables and nested blocks included, unused ones excluded', () => {
  const { d, ids } = source();
  const f = buildFragment(d, ids);
  assert.equal(f.entities.length, 3);
  assert.deepEqual([...f.layers.keys()].sort(), ['0', 'WALLS']);
  assert.ok(f.linetypes.has('DASHED') && !f.linetypes.has('UNUSED_LT'));
  assert.ok(f.textStyles.has('NOTES') && !f.textStyles.has('UNUSED_STYLE'));
  assert.deepEqual([...f.blocks.keys()].sort(), ['DOOR', 'INNER']);
  // round trip through the DXF writer and reader, with the COPYBASE base point and units
  const back = readFragment(fragmentDxf(d, ids, { x: 10, y: 10 }));
  assert.equal(back.entities.length, 3);
  assert.equal(back.units, 4);
  assert.deepEqual(back.header.insbase, { x: 10, y: 10 });
  assert.ok(back.blocks.has('DOOR') && back.blocks.has('INNER') && !back.blocks.has('UNUSED_BLOCK'));
  assert.ok(back.layers.has('WALLS') && !back.layers.has('UNUSED_LAYER'));
  assert.equal(readFragment('hello world'), null);
});

test('paste: placed at the insertion point relative to the base point; PASTEORIG keeps coordinates', () => {
  const { d, ids } = source();
  const frag = readFragment(fragmentDxf(d, ids, { x: 10, y: 10 }));
  const t = newDocument(); t.units = 4;
  const s = new Session(t);
  const r = pasteFragment(s, frag, { at: { x: 100, y: 0 } });
  const line = r.entities.find((e) => e.type === 'LINE');
  assert.deepEqual([line.p1, line.p2], [{ x: 100, y: 0 }, { x: 110, y: 0 }]);
  const r2 = pasteFragment(s, frag, { orig: true });
  const l2 = r2.entities.find((e) => e.type === 'LINE');
  assert.deepEqual(l2.p1, { x: 10, y: 10 });
});

test('paste: existing layers keep the target definition; clashing block names renamed $0, $1', () => {
  const { d, ids } = source();
  const frag = readFragment(fragmentDxf(d, ids));
  const t = newDocument();
  addLayer(t, { name: 'WALLS', color: 5 });
  addBlock(t, 'DOOR', { x: 0, y: 0 }, [makeCircle({ x: 0, y: 0 }, 9)]);
  addBlock(t, 'DOOR$0', { x: 0, y: 0 }, []);
  const s = new Session(t);
  const r = pasteFragment(s, frag, { orig: true });
  assert.equal(t.layers.get('WALLS').color, 5);
  assert.deepEqual(r.renamed, [['DOOR', 'DOOR$1']]);
  assert.equal(t.blocks.get('DOOR').entities[0].r, 9, 'the target block is untouched');
  assert.ok(t.blocks.has('DOOR$1') && t.blocks.has('INNER'));
  assert.equal(r.entities.find((e) => e.type === 'INSERT').block, 'DOOR$1');
  // a second paste renames INNER too, and the nested reference follows
  const r2 = pasteFragment(s, frag, { orig: true });
  assert.deepEqual(r2.renamed, [['DOOR', 'DOOR$2'], ['INNER', 'INNER$0']]);
  assert.equal(t.blocks.get('DOOR$2').entities.find((e) => e.type === 'INSERT').block, 'INNER$0');
});

test('paste: units scaled to the target, one undo step removes everything', () => {
  const { d, ids } = source();
  const frag = readFragment(fragmentDxf(d, ids, { x: 10, y: 10 }));
  const t = newDocument(); t.units = 6; // metres
  const s = new Session(t);
  assert.equal(unitScale(4, 6), 0.001);
  const r = pasteFragment(s, frag, { at: { x: 1, y: 1 } });
  assert.equal(r.scale, 0.001);
  const line = r.entities.find((e) => e.type === 'LINE');
  assert.ok(Math.abs(line.p2.x - 1.01) < 1e-12 && Math.abs(line.p2.y - 1) < 1e-12);
  assert.ok(Math.abs(r.entities.find((e) => e.type === 'INSERT').sx - 0.001) < 1e-12);
  assert.equal(s.undoStack.length, 1);
  assert.ok(t.layers.has('WALLS') && t.blocks.has('DOOR'));
  s.undo();
  assert.equal(t.entities.length, 0);
  assert.ok(!t.layers.has('WALLS') && !t.blocks.has('DOOR') && !t.linetypes.has('DASHED') && !t.textStyles.has('NOTES'));
});

test('PASTEBLOCK: everything inserted as one new block', () => {
  const { d, ids } = source();
  const frag = readFragment(fragmentDxf(d, ids, { x: 10, y: 10 }));
  const t = newDocument();
  const s = new Session(t);
  const r = pasteFragment(s, frag, { at: { x: 0, y: 0 }, asBlock: true });
  assert.equal(t.entities.length, 1);
  assert.equal(r.entities[0].type, 'INSERT');
  assert.equal(t.blocks.get(r.block).entities.length, 3);
  s.undo();
  assert.ok(!t.blocks.has(r.block) && t.entities.length === 0);
});
