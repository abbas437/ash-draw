import test from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/core/dxfRead.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import * as M from '../src/core/model.js';
import { Session, setLayerProps } from '../src/core/edit.js';
import { layIsolate, layUnisolate, layFreeze, layOn, layThaw } from '../src/core/layers.js';

const roundTrip = (doc) => readDxf(new TextEncoder().encode(writeDxf(doc)));
function sample() {
  const doc = M.newDocument();
  for (const [name, visible, frozen] of [['A', true, false], ['OFF', false, false], ['FRZ', true, true], ['BOTH', false, true]]) M.addLayer(doc, { name, color: 3, visible, frozen });
  for (const l of ['A', 'OFF', 'FRZ', 'BOTH']) M.addEntity(doc, M.makeLine({ x: 0, y: 0 }, { x: 1, y: 1 }, { layer: l }));
  return doc;
}

test('layer on/off and frozen flags round-trip independently through DXF', () => {
  const back = roundTrip(sample());
  const flags = (n) => { const l = back.layers.get(n); return [l.visible, l.frozen]; };
  assert.deepEqual(flags('A'), [true, false]);
  assert.deepEqual(flags('OFF'), [false, false]);
  assert.deepEqual(flags('FRZ'), [true, true]);
  assert.deepEqual(flags('BOTH'), [false, true]);
  assert.equal(back.layers.get('OFF').color, 3, 'off is stored as a negative colour, read back as the positive colour');
});

test('LAYISO / LAYUNISO, LAYFRZ, LAYON, LAYTHW are single undo steps', () => {
  const doc = sample(); const s = new Session(doc);
  const idA = doc.entities.find((e) => e.layer === 'A').id;
  const vis = () => [...doc.layers.values()].map((l) => `${l.name}:${l.visible ? 1 : 0}${l.frozen ? 'f' : ''}`).join(' ');
  const start = vis();
  const saved = layIsolate(s, [idA]);
  assert.equal(vis(), '0:0 A:1 OFF:0 FRZ:0f BOTH:0f');
  layUnisolate(s, saved);
  assert.equal(vis(), start);
  layFreeze(s, [idA]);
  assert.ok(doc.layers.get('A').frozen && doc.layers.get('A').visible);
  s.undo(); assert.equal(vis(), start);
  layOn(s); assert.ok([...doc.layers.values()].every((l) => l.visible));
  assert.ok(doc.layers.get('BOTH').frozen, 'LAYON does not thaw');
  layThaw(s); assert.ok([...doc.layers.values()].every((l) => !l.frozen));
  s.undo(); s.undo(); assert.equal(vis(), start);
  setLayerProps(s, 'FRZ', { visible: false });
  assert.ok(doc.layers.get('FRZ').frozen, 'turning a frozen layer off keeps it frozen');
});
