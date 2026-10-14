import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf, parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import {
  LS, saveLayerState, restoreLayerState, deleteLayerState, renameLayerState, getLayerState, stateMatches,
  exportLas, parseLas, importLayerStates, layerStateTags, layerStateFromTags, frozenCurrent, listLayerStates,
} from '../src/core/layerstates.js';
import { spaceDoc } from '../renderer/layouts-ui.js';
import { newLayout } from '../src/core/layouts.js';

const roundTrip = (doc) => readDxf(new TextEncoder().encode(writeDxf(doc)));
function sample() {
  const doc = M.newDocument();
  M.addLinetype(doc, { name: 'DASHED', description: '', pattern: [0.5, -0.25] });
  M.addLayer(doc, { name: 'HVAC', color: 4 });
  M.addLayer(doc, { name: 'ARCH', color: 1, linetype: 'DASHED', lineweight: 0.35 });
  M.addLayer(doc, { name: 'ELEC', color: { r: 10, g: 20, b: 30 }, alpha: 128 });
  return new Session(doc);
}
const L = (s, n) => s.doc.layers.get(n);

test('save snapshots every layer; restore applies them back as one undo step', () => {
  const s = sample();
  saveLayerState(s, 'Coordination', 'all on');
  assert.equal(s.undoStack.length, 1);
  const st = getLayerState(s.doc, 'coordination');
  assert.equal(st.layers.size, 4);
  assert.deepEqual(st.layers.get('ELEC').color, { r: 10, g: 20, b: 30 });
  s.transact('change', (tx) => { tx.layer('HVAC', { visible: false, color: 2 }); tx.layer('ARCH', { frozen: true, locked: true }); });
  assert.equal(stateMatches(s.doc, st), false);
  assert.equal(restoreLayerState(s, 'Coordination'), 2);
  assert.equal(s.undoStack.length, 3);
  assert.equal(L(s, 'HVAC').visible, true); assert.equal(L(s, 'HVAC').color, 4);
  assert.equal(L(s, 'ARCH').frozen, false); assert.equal(L(s, 'ARCH').locked, false);
  assert.equal(stateMatches(s.doc, st), true);
  s.undo(); // one step takes back the whole restore
  assert.equal(L(s, 'HVAC').visible, false); assert.equal(L(s, 'ARCH').frozen, true);
  s.undo(); s.undo();
  assert.equal(getLayerState(s.doc, 'Coordination'), null, 'undoing the save removes the state');
});

test('restore mask applies only the chosen properties', () => {
  const s = sample();
  saveLayerState(s, 'A');
  s.transact('change', (tx) => tx.layer('HVAC', { visible: false, color: 2 }));
  restoreLayerState(s, 'A', { mask: LS.color });
  assert.equal(L(s, 'HVAC').color, 4);
  assert.equal(L(s, 'HVAC').visible, false, 'on/off not in the mask');
});

test('turn off layers not found in the state', () => {
  const s = sample();
  saveLayerState(s, 'A');
  s.transact('new', (tx) => tx.layer('NEW', { color: 5 }));
  restoreLayerState(s, 'A');
  assert.equal(L(s, 'NEW').visible, true);
  restoreLayerState(s, 'A', { offMissing: true });
  assert.equal(L(s, 'NEW').visible, false);
});

test('update, rename and delete are undoable', () => {
  const s = sample();
  saveLayerState(s, 'HVAC only', 'desc');
  s.transact('c', (tx) => tx.layer('HVAC', { color: 6 }));
  saveLayerState(s, 'hvac ONLY');
  const st = getLayerState(s.doc, 'HVAC only');
  assert.equal(st.name, 'HVAC only'); assert.equal(st.description, 'desc'); assert.equal(st.layers.get('HVAC').color, 6);
  assert.equal(renameLayerState(s, 'HVAC only', 'Mech'), true);
  assert.equal(getLayerState(s.doc, 'HVAC only'), null); assert.equal(getLayerState(s.doc, 'MECH').name, 'Mech');
  s.undo();
  assert.ok(getLayerState(s.doc, 'HVAC only'));
  assert.equal(deleteLayerState(s, 'HVAC only'), true);
  assert.equal(s.doc.layerStates.size, 0);
  s.undo();
  assert.equal(s.doc.layerStates.size, 1);
});

test('DXF write -> read -> write keeps the states (ACAD_LAYERSTATES in the LAYER table extension dictionary)', () => {
  const s = sample();
  s.transact('c', (tx) => { tx.layer('ARCH', { visible: false, plot: false }); tx.layer('HVAC', { frozen: true, locked: true }); });
  saveLayerState(s, 'Coordination', 'For the MEP meeting');
  saveLayerState(s, 'HVAC only');
  const text = writeDxf(s.doc);
  assert.match(text, /ACAD_XDICTIONARY/); assert.match(text, /ACAD_LAYERSTATES/);
  const d2 = readDxf(new TextEncoder().encode(text));
  assert.equal(d2.layerStates.size, 2);
  const a = getLayerState(s.doc, 'Coordination'), b = getLayerState(d2, 'Coordination');
  assert.equal(b.description, 'For the MEP meeting');
  assert.deepEqual([...b.layers.keys()].sort(), [...a.layers.keys()].sort());
  for (const [n, e] of a.layers) for (const k of ['on', 'frozen', 'locked', 'plot', 'color', 'lineweight', 'transparency']) assert.deepEqual(b.layers.get(n)[k], e[k], `${n}.${k}`);
  assert.equal(b.layers.get('ARCH').linetype.toUpperCase(), 'DASHED');
  const d3 = roundTrip(d2);
  assert.deepEqual(getLayerState(d3, 'Coordination'), b);
});

test('reads a synthetic AutoCAD-style DXF and keeps unknown codes', () => {
  const pairs = [
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [5, '2'], [102, '{ACAD_XDICTIONARY'], [360, '2C0'], [102, '}'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 1],
    [0, 'LAYER'], [5, '10'], [330, '2'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbLayerTableRecord'], [2, '0'], [70, 0], [62, 7], [6, 'Continuous'], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'OBJECTS'],
    [0, 'DICTIONARY'], [5, '2C0'], [330, '2'], [100, 'AcDbDictionary'], [280, 1], [281, 1], [3, 'ACAD_LAYERSTATES'], [360, '2C1'],
    [0, 'DICTIONARY'], [5, '2C1'], [330, '2C0'], [100, 'AcDbDictionary'], [281, 1], [3, 'Walls off'], [350, '2C2'],
    [0, 'XRECORD'], [5, '2C2'], [330, '2C1'], [100, 'AcDbXrecord'], [280, 1], [91, 2047], [301, 'Test'], [290, 0], [302, '0'], [999, 'x'],
    [8, '0'], [90, 9], [62, 3], [370, 25], [6, 'Continuous'], [2, 'Color_3'], [440, 0], [1070, 42],
    [0, 'ENDSEC'], [0, 'EOF'],
  ];
  const doc = parseDxf(pairs.map(([c, v]) => `${c}\n${v}`).join('\n'));
  const st = getLayerState(doc, 'walls off');
  assert.equal(st.name, 'Walls off'); assert.equal(st.description, 'Test');
  const e = st.layers.get('0');
  assert.deepEqual([e.on, e.plot, e.color, e.lineweight, e.transparency, e.plotStyle], [false, true, 3, 0.25, 255, 'Color_3']);
  assert.deepEqual(e.extra.map(([c, v]) => [c, String(v)]), [[1070, '42']]);
  const back = getLayerState(roundTrip(doc), 'Walls off');
  assert.deepEqual(back.layers.get('0').extra.map(([c, v]) => [c, String(v)]), [[1070, '42']]);
  const layerTags = layerStateTags(back).slice(layerStateTags(back).findIndex(([c]) => c === 8));
  assert.deepEqual(layerTags.filter(([c]) => c === 1 || c === 2 || c === 440), [[2, 'Color_3'], [440, 0]], 'one plot style (code 2), opaque 440 = 0');
  assert.deepEqual(back.extra.map(([c, v]) => [c, String(v)]), [[999, 'x']]);
});

test('.las export -> import merges by name and asks before overwriting', () => {
  const s = sample();
  saveLayerState(s, 'One', 'first');
  saveLayerState(s, 'Two');
  const las = exportLas([...s.doc.layerStates.values()]);
  assert.ok(las.startsWith('﻿  0\r\nLAYERSTATEDICTIONARY\r\n  0\r\nLAYERSTATE\r\n  1\r\nOne'));
  const states = parseLas(las);
  assert.deepEqual(states.map((x) => x.name), ['One', 'Two']);
  assert.equal(states[0].description, 'first');
  assert.deepEqual(states[0].layers.get('ELEC').color, { r: 10, g: 20, b: 30 });
  const t = sample();
  saveLayerState(t, 'Two', 'mine');
  const asked = [];
  assert.deepEqual(importLayerStates(t, states, (n) => { asked.push(n); return false; }), ['One']);
  assert.deepEqual(asked, ['Two']);
  assert.equal(getLayerState(t.doc, 'Two').description, 'mine');
  importLayerStates(t, states, () => true);
  assert.equal(getLayerState(t.doc, 'Two').description, '');
  assert.throws(() => parseLas('hello\nworld'), /not a layer states/);
});

// the layout of a real AutoCAD .las (Autodesk forum sample "Deciphering the Layer State File (.las)"): plot style is
// code 2, an opaque layer has 440 = 0, code 1 is the state's name
test('.las per-layer codes: plot style 2, opaque 440 = 0; a legacy code 1 is read only when unambiguous', () => {
  const s = sample();
  saveLayerState(s, 'A');
  const t = layerStateTags(getLayerState(s.doc, 'A'));
  const block = (n) => { const i = t.findIndex(([c, v]) => c === 8 && v === n); const j = t.findIndex(([c], k) => k > i && c === 8); return t.slice(i, j < 0 ? undefined : j); };
  assert.deepEqual(block('HVAC').filter(([c]) => c === 1 || c === 2 || c === 440), [[2, 'Color_4'], [440, 0]]);
  assert.deepEqual(block('ELEC').find(([c]) => c === 440), [440, 0x02000000 | 128]);
  const las = ['LAYERSTATEDICTIONARY', 'LAYERSTATE'].map((x) => `  0\r\n${x}`).join('\r\n') +
    '\r\n  1\r\nSample\r\n 91\r\n2047\r\n301\r\n\r\n290\r\n0\r\n302\r\n0\r\n  8\r\n0\r\n 90\r\n8\r\n 62\r\n2\r\n370\r\n-3\r\n  6\r\nContinuous\r\n  2\r\nColor_2\r\n440\r\n0\r\n';
  const [st] = parseLas(las);
  assert.equal(st.name, 'Sample');
  assert.deepEqual([st.layers.get('0').plotStyle, st.layers.get('0').transparency, st.layers.get('0').extra], ['Color_2', 255, undefined]);
  const ps = (tags) => { const e = layerStateFromTags('x', [[8, 'L'], ...tags]).layers.get('L'); return [e.plotStyle, e.extra]; };
  assert.deepEqual(ps([[1, 'Old']]), ['Old', undefined], 'a single legacy code 1 is the plot style');
  assert.deepEqual(ps([[1, 'Old'], [2, 'New']]), ['New', undefined], 'code 2 wins, the legacy code 1 is dropped');
  assert.deepEqual(ps([[2, 'New'], [1, 'Old']]), ['New', undefined]);
  assert.deepEqual(ps([[1, 'A'], [1, 'B']]), [undefined, undefined], 'ambiguous code 1s are dropped');
});

test('a state saved on a layout tab (space doc) is stored on the drawing and written to DXF', () => {
  const s = sample();
  const lay = newLayout('Layout1', 1);
  s.doc.layouts = [lay];
  const root = s.doc;
  s.doc = spaceDoc(root, lay); // as setSpace does for a layout tab
  saveLayerState(s, 'On sheet', 'from the layout');
  assert.deepEqual(listLayerStates(s.doc).map((x) => x.name), ['On sheet']);
  assert.ok(Object.hasOwn(root, 'layerStates'), 'the state is on the drawing, not on the space doc');
  importLayerStates(s, parseLas(exportLas([getLayerState(s.doc, 'On sheet')])).map((x) => ({ ...x, name: 'Imported' })));
  const back = roundTrip(root);
  assert.equal(getLayerState(back, 'On sheet').description, 'from the layout');
  assert.ok(getLayerState(back, 'Imported'));
  s.transact('c', (tx) => tx.layer('HVAC', { visible: false }));
  assert.equal(restoreLayerState(s, 'On sheet'), 1);
  assert.equal(renameLayerState(s, 'On sheet', 'Sheet'), true);
  assert.equal(deleteLayerState(s, 'Sheet'), true);
  assert.deepEqual(listLayerStates(root).map((x) => x.name), ['Imported']);
});

test('restore never freezes the current layer; the state records the current layer it was saved with', () => {
  const s = sample();
  s.transact('c', (tx) => tx.layer('HVAC', { frozen: true }));
  saveLayerState(s, 'HVAC frozen', '', { currentLayer: 'ARCH' });
  assert.equal(getLayerState(s.doc, 'HVAC frozen').currentLayer, 'ARCH');
  assert.equal(getLayerState(roundTrip(s.doc), 'HVAC frozen').currentLayer, 'ARCH');
  s.transact('c', (tx) => tx.layer('HVAC', { frozen: false, color: 2 }));
  assert.equal(frozenCurrent(s.doc, 'HVAC frozen', { currentLayer: 'HVAC' }), 'HVAC');
  assert.equal(frozenCurrent(s.doc, 'HVAC frozen', { currentLayer: 'HVAC', mask: LS.color }), null);
  assert.equal(frozenCurrent(s.doc, 'HVAC frozen', { currentLayer: 'ARCH' }), null);
  assert.equal(restoreLayerState(s, 'HVAC frozen', { currentLayer: 'HVAC' }), 1);
  assert.equal(L(s, 'HVAC').frozen, false, 'the current layer stays thawed');
  assert.equal(L(s, 'HVAC').color, 4, 'its other properties are restored');
  restoreLayerState(s, 'HVAC frozen', { currentLayer: '0' });
  assert.equal(L(s, 'HVAC').frozen, true);
});

test('the LAYER table extension dictionary lists the LAYER table as its reactor', () => {
  const s = sample();
  saveLayerState(s, 'A');
  const l = writeDxf(s.doc).split(/\r?\n/), pairs = [];
  for (let i = 0; i + 1 < l.length; i += 2) pairs.push([+l[i], l[i + 1].trim()]);
  const t = pairs.findIndex(([c, v], i) => c === 0 && v === 'TABLE' && pairs[i + 1]?.[1] === 'LAYER');
  const tableH = pairs[t + 2][1], xd = pairs.slice(t).find(([c]) => c === 360)[1];
  const d = pairs.findIndex(([c, v], i) => c === 0 && v === 'DICTIONARY' && pairs[i + 1]?.[1] === xd);
  assert.deepEqual(pairs.slice(d + 2, d + 6), [[102, '{ACAD_REACTORS'], [330, tableH], [102, '}'], [330, tableH]]);
});
