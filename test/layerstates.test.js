import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf, parseDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { Session } from '../src/core/edit.js';
import {
  LS, saveLayerState, restoreLayerState, deleteLayerState, renameLayerState, getLayerState, stateMatches,
  exportLas, parseLas, importLayerStates,
} from '../src/core/layerstates.js';

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
    [8, '0'], [90, 9], [62, 3], [370, 25], [6, 'Continuous'], [1, 'Color_3'], [440, 33554687], [1070, 42],
    [0, 'ENDSEC'], [0, 'EOF'],
  ];
  const doc = parseDxf(pairs.map(([c, v]) => `${c}\n${v}`).join('\n'));
  const st = getLayerState(doc, 'walls off');
  assert.equal(st.name, 'Walls off'); assert.equal(st.description, 'Test');
  const e = st.layers.get('0');
  assert.deepEqual([e.on, e.plot, e.color, e.lineweight, e.transparency], [false, true, 3, 0.25, 255]);
  assert.deepEqual(e.extra.map(([c, v]) => [c, String(v)]), [[1070, '42']]);
  const back = getLayerState(roundTrip(doc), 'Walls off');
  assert.deepEqual(back.layers.get('0').extra.map(([c, v]) => [c, String(v)]), [[1070, '42']]);
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
