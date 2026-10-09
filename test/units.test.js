import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, makeLine, addEntity } from '../src/core/model.js';
import { Session, setDrawingUnits } from '../src/core/edit.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { readDxf } from '../src/core/dxfRead.js';
import { INSUNITS, unitLabel, formatNumber, formatLength, lengthPrecision, looksLikeMapMetres, showLegsFrom } from '../src/core/measure.js';

test('unit labels follow $INSUNITS; unitless and unknown codes have none', () => {
  assert.equal(unitLabel(4), 'mm'); assert.equal(unitLabel(6), 'm'); assert.equal(unitLabel(10), 'yd');
  assert.equal(unitLabel(0), ''); assert.equal(unitLabel(99), '');
  assert.deepEqual(INSUNITS.map(([c]) => c), Array.from({ length: 21 }, (_, i) => i), 'every INSUNITS code 0..20 is offered');
});

test('lengths use the drawing precision and unit: 6.98364 at 4 / 2 / 0 decimals', () => {
  assert.equal(formatLength(6.98364, 4, 4), '6.9836 mm');
  assert.equal(formatLength(6.98364, 2, 6), '6.98 m');
  assert.equal(formatLength(6.98364, 0, 6), '7 m');
  assert.equal(formatLength(12.5, 2, 6, 2), '12.5 m²', 'area label; trailing zeros dropped');
  assert.equal(formatLength(3, 4, 0), '3', 'unitless: no label');
  assert.equal(formatNumber(-0.00001, 4), '0', 'no negative zero');
  assert.equal(formatNumber(100, 4), '100');
});

test('precision: $LUPREC 0..8, anything else falls back to 4', () => {
  assert.equal(lengthPrecision(2), 2); assert.equal(lengthPrecision(8), 8); assert.equal(lengthPrecision(0), 0);
  assert.equal(lengthPrecision(undefined), 4); assert.equal(lengthPrecision(9), 4); assert.equal(lengthPrecision(-1), 4);
});

test('map-grid hint: millimetre drawing at UTM metre coordinates', () => {
  const utm = { minx: 512300, miny: 2712400, maxx: 514800, maxy: 2714100 }; // a site 2.5 km wide, Saudi UTM northing
  assert.equal(looksLikeMapMetres(4, utm), true);
  assert.equal(looksLikeMapMetres(6, utm), false, 'already metres');
  assert.equal(looksLikeMapMetres(0, utm), false, 'only when it says millimetres');
  assert.equal(looksLikeMapMetres(4, { minx: 0, miny: 0, maxx: 150000, maxy: 80000 }), false, 'a large plant in mm at the origin');
  assert.equal(looksLikeMapMetres(4, { minx: 512300e3, miny: 2712400e3, maxx: 514800e3, maxy: 2714100e3 }), false, 'grid coordinates in millimetres');
  assert.equal(looksLikeMapMetres(4, { minx: 0, miny: 0, maxx: 400, maxy: 300 }), false, 'small drawing');
  assert.equal(looksLikeMapMetres(4, null), false, 'empty drawing');
});

test('measure overlay: ΔX / ΔY legs are off unless the setting is saved as true', () => {
  assert.equal(showLegsFrom(undefined), false); assert.equal(showLegsFrom(false), false); assert.equal(showLegsFrom('yes'), false);
  assert.equal(showLegsFrom(true), true);
});

test('setDrawingUnits: one undoable step, marks the drawing modified, written to $INSUNITS / $LUPREC', () => {
  const doc = newDocument(); doc.units = 4; addEntity(doc, makeLine({ x: 0, y: 0 }, { x: 7, y: 0 }));
  const s = new Session(doc);
  assert.equal(s.dirty, false);
  assert.equal(setDrawingUnits(s, { units: 6, luprec: 2 }), true);
  assert.equal(doc.units, 6); assert.equal(doc.header.luprec, 2); assert.equal(s.dirty, true);
  assert.equal(doc.entities[0].p2.x, 7, 'geometry is not scaled');
  const back = readDxf(new TextEncoder().encode(writeDxf(doc)));
  assert.equal(back.units, 6); assert.equal(back.header.luprec, 2);
  assert.equal(setDrawingUnits(s, { units: 6, luprec: 2 }), false, 'no step when nothing changes');
  s.undo();
  assert.equal(doc.units, 4); assert.equal(doc.header.luprec, 4); assert.equal(s.dirty, false);
  s.redo();
  assert.equal(doc.units, 6);
});
