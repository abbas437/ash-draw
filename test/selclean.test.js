import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addEntity, addLayer, addLinetype, addTextStyle, addBlock, makeLine, makeCircle, makeText, makeInsert, makeDimension, makeRect } from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import { quickSelect, selectSimilar, matches, wildcard, typesPresent } from '../src/core/select-filter.js';
import { purgeable, planPurge, applyPurge, zeroLengthCleanup, isZeroOrEmpty } from '../src/core/purge.js';

function drawing() {
  const doc = newDocument();
  addLayer(doc, { name: 'WALLS', color: 1 });
  addLayer(doc, { name: 'DOORS', color: 3 });
  const a = addEntity(doc, makeCircle({ x: 0, y: 0 }, 5, { layer: 'WALLS' }));             // ByLayer on a red layer
  const b = addEntity(doc, makeCircle({ x: 9, y: 0 }, 2, { layer: 'WALLS', color: 1 }));   // red by value
  const c = addEntity(doc, makeCircle({ x: 9, y: 9 }, 2, { layer: 'DOORS' }));
  const d = addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 3, y: 4 }, { layer: 'WALLS' }));
  const t = addEntity(doc, makeText({ x: 0, y: 0 }, 2.5, 'ROOM 101', { layer: 'DOORS' }));
  const r = addEntity(doc, makeRect({ x: 0, y: 0 }, { x: 2, y: 3 }, { layer: 'DOORS' }));
  return { doc, a, b, c, d, t, r };
}

test('QSELECT: layer, type, operators and wildcard', () => {
  const { doc, a, b, c, d, t } = drawing();
  assert.deepEqual(quickSelect(doc.entities, [], { applyTo: 'all', type: '*', prop: 'Layer', op: '=', value: 'walls' }), [a.id, b.id, d.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'CIRCLE', prop: 'Radius', op: '>', value: '3' }), [a.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'CIRCLE', prop: 'Radius', op: '<', value: '3' }), [b.id, c.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'CIRCLE', prop: 'Layer', op: '<>', value: 'WALLS' }), [c.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'TEXT', prop: 'Contents', op: '*', value: 'room*' }), [t.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'LINE', prop: 'Length', op: '=', value: '5' }), [d.id]);
  assert.ok(wildcard('A#?', 'a1x') && !wildcard('~A*', 'abc') && wildcard('@1', 'Q1'));
  assert.deepEqual(typesPresent(doc.entities), ['CIRCLE', 'LINE', 'LWPOLYLINE', 'TEXT']);
});

test('QSELECT: polyline Closed / Area', () => {
  const { doc, r } = drawing();
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'LWPOLYLINE', prop: 'Closed', op: '=', value: 'Yes' }), [r.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'LWPOLYLINE', prop: 'Area', op: '=', value: '6' }), [r.id]);
});

test('QSELECT: colour compares the stored value (ByLayer is a value of its own)', () => {
  const { doc, a, b, c, d } = drawing();
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'CIRCLE', prop: 'Color', op: '=', value: 'Red' }), [b.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'CIRCLE', prop: 'Color', op: '=', value: 'ByLayer' }), [a.id, c.id]);
  assert.ok(!matches(a, 'Color', '=', '1'));
  assert.ok(matches(d, 'Color', '=', 'bylayer'));
});

test('QSELECT: apply to selection, exclude, append', () => {
  const { doc, a, b, c, d, t } = drawing();
  assert.deepEqual(quickSelect(doc.entities, [a.id, c.id], { applyTo: 'selection', type: '*', prop: 'Layer', op: '=', value: 'WALLS' }), [a.id]);
  assert.deepEqual(quickSelect(doc.entities, [], { type: 'CIRCLE', prop: 'Layer', op: '=', value: 'WALLS', exclude: true }), [c.id]);
  assert.deepEqual(quickSelect(doc.entities, [t.id], { type: 'CIRCLE', prop: 'Color', op: '=', value: 'red', append: true }), [t.id, b.id]);
  assert.deepEqual(quickSelect(doc.entities, [d.id], { type: 'LINE', append: true }), [d.id]);
});

test('QSELECT and SELECTSIMILAR work on the current space only', () => {
  const { doc, a, b } = drawing();
  const paper = [makeCircle({ x: 0, y: 0 }, 1, { layer: 'WALLS' })]; paper[0].id = 999;
  doc.layouts = [{ name: 'Layout1', entities: paper }];
  assert.ok(!quickSelect(doc.entities, [], { type: 'CIRCLE', prop: 'Layer', op: '=', value: 'WALLS' }).includes(999));
  assert.deepEqual(selectSimilar(doc.entities, [a.id]), [a.id, b.id]);
  assert.deepEqual(selectSimilar(paper, [999]), [999]);
});

test('SELECTSIMILAR: blocks by name, text by style', () => {
  const doc = newDocument();
  addBlock(doc, 'A', { x: 0, y: 0 }, []); addBlock(doc, 'B', { x: 0, y: 0 }, []); addTextStyle(doc, { name: 'ROMANS' });
  const i1 = addEntity(doc, makeInsert('A', { x: 0, y: 0 })), i2 = addEntity(doc, makeInsert('A', { x: 5, y: 0 }));
  addEntity(doc, makeInsert('B', { x: 0, y: 0 }));
  const t1 = addEntity(doc, makeText({ x: 0, y: 0 }, 1, 'x')), t2 = addEntity(doc, makeText({ x: 0, y: 0 }, 1, 'y', { style: 'STANDARD' }));
  addEntity(doc, makeText({ x: 0, y: 0 }, 1, 'z', { style: 'ROMANS' }));
  assert.deepEqual(selectSimilar(doc.entities, [i1.id]), [i1.id, i2.id]);
  assert.deepEqual(selectSimilar(doc.entities, [t1.id]), [t1.id, t2.id]);
});

function purgeDoc() {
  const doc = newDocument();
  addLayer(doc, { name: 'EMPTY' }); addLayer(doc, { name: 'INBLOCK' }); addLayer(doc, { name: 'DEFPOINTS' }); addLayer(doc, { name: 'CUR' });
  addLayer(doc, { name: 'VPFROZEN' }); addLayer(doc, { name: 'XR|WALLS', xrefDep: 'XR' });
  addLinetype(doc, { name: 'DASHED', pattern: [1, -1] }); addLinetype(doc, { name: 'HIDDEN', pattern: [0.5, -0.5] });
  addLayer(doc, { name: 'DASHLAYER', linetype: 'HIDDEN' });
  addTextStyle(doc, { name: 'UNUSEDST' }); addTextStyle(doc, { name: 'DIMTXT' });
  addBlock(doc, 'INNER', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 })]);
  addBlock(doc, 'OUTER', { x: 0, y: 0 }, [makeInsert('INNER', { x: 0, y: 0 })]);                  // unused, holds INNER
  addBlock(doc, 'USED', { x: 0, y: 0 }, [makeLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { layer: 'INBLOCK' })]);
  addBlock(doc, '*D1', { x: 0, y: 0 }, []);
  addEntity(doc, makeInsert('USED', { x: 0, y: 0 }));
  addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }, { layer: 'DASHLAYER' }));
  const dim = addEntity(doc, makeDimension('*D1')); dim.style = 'ARCH';
  doc.dimStyles = new Map([['ARCH', { name: 'ARCH', DIMTXSTY: 'DIMTXT' }], ['SPARE', { name: 'SPARE' }], ['Standard', { name: 'Standard' }]]);
  doc.header.dimStyles = ['Standard', 'ARCH', 'SPARE'];
  doc.layouts = [{ name: 'Layout1', entities: [{ type: 'VIEWPORT', id: 500, layer: '0', frozen: ['VPFROZEN'] }] }];
  return doc;
}

test('PURGE analysis: what is unused and what is protected', () => {
  const doc = purgeDoc();
  const p = purgeable(doc, { currentLayer: 'CUR' });
  assert.deepEqual(p.Blocks, ['OUTER']);                  // INNER is used by OUTER; USED and *D1 are referenced
  assert.deepEqual(p.Layers, ['EMPTY']);                  // INBLOCK used in a block, VPFROZEN in a viewport freeze list
  assert.deepEqual(p.Linetypes, ['DASHED']);              // HIDDEN used by a layer
  assert.deepEqual(p['Text styles'], ['UNUSEDST']);       // DIMTXT used by a dimension style
  assert.deepEqual(p['Dimension styles'], ['SPARE']);     // ARCH used by a dimension, Standard protected
});

test('PURGE: a block nested only in an unused block goes only with "nested"', () => {
  const doc = purgeDoc();
  const flat = planPurge(doc, { currentLayer: 'CUR' }).filter((i) => i.kind === 'Blocks').map((i) => i.name);
  assert.deepEqual(flat, ['OUTER']);
  const nested = planPurge(doc, { currentLayer: 'CUR', nested: true }).filter((i) => i.kind === 'Blocks').map((i) => i.name);
  assert.deepEqual(nested, ['OUTER', 'INNER']);
  const picked = planPurge(doc, { pick: { Blocks: ['OUTER'] }, nested: true, currentLayer: 'CUR' });
  assert.deepEqual(picked.map((i) => i.name), ['OUTER', 'INNER']);  // only what OUTER freed, not the other unused items
});

test('PURGE: one undo step; undo restores everything', () => {
  const doc = purgeDoc(), s = new Session(doc);
  addEntity(doc, makeLine({ x: 2, y: 2 }, { x: 2, y: 2 }));
  addEntity(doc, makeText({ x: 0, y: 0 }, 1, '  '));
  const n = doc.entities.length;
  const plan = planPurge(doc, { nested: true, currentLayer: 'CUR' });
  const r = applyPurge(s, doc, plan, { zeroLength: true });
  assert.equal(r.geometry, 2);
  assert.equal(s.undoStack.length, 1);
  for (const n2 of ['OUTER', 'INNER']) assert.ok(!doc.blocks.has(n2));
  assert.ok(!doc.layers.has('EMPTY') && !doc.linetypes.has('DASHED') && !doc.textStyles.has('UNUSEDST'));
  assert.ok(!doc.dimStyles.has('SPARE') && !doc.header.dimStyles.includes('SPARE'));
  assert.equal(doc.entities.length, n - 2);
  assert.deepEqual(zeroLengthCleanup(doc), []);
  s.undo();
  assert.ok(doc.blocks.has('OUTER') && doc.blocks.has('INNER') && doc.layers.has('EMPTY') && doc.linetypes.has('DASHED'));
  assert.ok(doc.textStyles.has('UNUSEDST') && doc.dimStyles.has('SPARE') && doc.header.dimStyles.includes('SPARE'));
  assert.equal(doc.entities.length, n);
  s.redo();
  assert.ok(!doc.blocks.has('OUTER'));
});

test('PURGE: undo restores the table order (DXF tables are written in Map order)', () => {
  const doc = purgeDoc(), s = new Session(doc);
  const tables = { layers: doc.layers, blocks: doc.blocks, linetypes: doc.linetypes, textStyles: doc.textStyles, dimStyles: doc.dimStyles };
  const gone = { layers: 'EMPTY', blocks: 'OUTER', linetypes: 'DASHED', textStyles: 'UNUSEDST', dimStyles: 'SPARE' };
  const before = {}, objs = {};
  for (const [t, m] of Object.entries(tables)) {
    before[t] = [...m.keys()]; objs[t] = [...m.values()];
    const i = before[t].indexOf(gone[t]);
    assert.ok(i >= 0 && i < before[t].length - 1, t + ': the purged entry is not the last one');
  }
  applyPurge(s, doc, planPurge(doc, { nested: true, currentLayer: 'CUR' }), {});
  for (const [t, m] of Object.entries(tables)) assert.ok(!m.has(gone[t]), t + ' purged');
  s.undo();
  for (const [t, m] of Object.entries(tables)) {
    assert.deepEqual([...m.keys()], before[t], t + ' key order after undo');
    assert.ok([...m.values()].every((v, i) => v === objs[t][i]), t + ' entry objects kept');
  }
  s.redo();
  for (const [t, m] of Object.entries(tables)) assert.ok(!m.has(gone[t]), t + ' purged again on redo');
  s.undo();
  for (const [t, m] of Object.entries(tables)) assert.deepEqual([...m.keys()], before[t], t + ' key order after redo+undo');
});

test('PURGE: stacked-fraction / tolerance MTEXT is not empty; code-only MTEXT is', () => {
  for (const text of ['\\S1/2;', '\\A1;\\S+0.1^-0.2;']) assert.equal(isZeroOrEmpty({ type: 'MTEXT', text }), false, text);
  for (const text of ['', '\\A1;', '{\\fArial|b0;}', '\\P']) assert.equal(isZeroOrEmpty({ type: 'MTEXT', text }), true, text);
});

test('PURGE: the current linetype is never purgeable', () => {
  const doc = newDocument();
  addLinetype(doc, { name: 'DASHED', pattern: [1, -1] });
  assert.deepEqual(purgeable(doc, { currentLinetype: 'DASHED' }).Linetypes, []);
  assert.deepEqual(purgeable(doc, { currentLinetype: 'ByLayer' }).Linetypes, ['DASHED']);
  assert.deepEqual(planPurge(doc, { currentLinetype: 'dashed' }).filter((i) => i.kind === 'Linetypes'), []);
});
