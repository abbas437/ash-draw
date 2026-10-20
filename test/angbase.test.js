import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinate, angleFromWorld } from '../src/core/coords.js';
import { newDocument } from '../src/core/model.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { parseDxf } from '../src/core/dxfRead.js';

const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const O = { x: 0, y: 0 };
const NORTH_CW = { angbase: Math.PI / 2, angdir: 1 };

test('polar entry follows $ANGBASE / $ANGDIR (as AutoCAD): base north, clockwise', () => {
  let p = parseCoordinate('@10<90', O, null, NORTH_CW); // 90 deg clockwise from north = east
  near(p.x, 10, 'x'); near(p.y, 0, 'y');
  p = parseCoordinate('@10<0', O, null, NORTH_CW); near(p.x, 0, 'x'); near(p.y, 10, 'north');
  p = parseCoordinate('@10<90', O, null, { angbase: Math.PI / 2 }); // counter-clockwise from north = west
  near(p.x, -10, 'x'); near(p.y, 0, 'y');
  p = parseCoordinate('@10<90', { x: 1, y: 1 }, null, { angdir: 1 }); // clockwise from east = south
  near(p.x, 1, 'x'); near(p.y, -9, 'y');
});

test('defaults: polar entry and angle readout unchanged', () => {
  for (const h of [undefined, null, {}, { angbase: 0, angdir: 0 }]) {
    const p = parseCoordinate('@10<90', O, null, h);
    near(p.x, 0, 'x'); near(p.y, 10, 'y');
    near(angleFromWorld(90, h), 90, 'readout');
  }
  near(angleFromWorld(-30, null), 330, 'readout in [0, 360)');
});

test('angle readout: a line 0,0 -> 0,10 reads 0 deg with base north clockwise; 0,0 -> 10,0 reads 90', () => {
  near(angleFromWorld(Math.atan2(10, 0) * 180 / Math.PI, NORTH_CW), 0, 'north');
  near(angleFromWorld(0, NORTH_CW), 90, 'east');
  near(angleFromWorld(180, { angbase: Math.PI / 2 }), 90, 'west, counter-clockwise from north');
});

test('$ANGBASE (radians) / $ANGDIR are read and written back', () => {
  const raw = '0\nSECTION\n2\nHEADER\n9\n$ANGBASE\n50\n1.5707963267948966\n9\n$ANGDIR\n70\n1\n0\nENDSEC\n0\nEOF\n';
  const d = parseDxf(raw);
  near(d.header.angbase, Math.PI / 2, 'angbase'); assert.equal(d.header.angdir, 1);
  const out = writeDxf(d), back = parseDxf(typeof out === 'string' ? out : out.text);
  near(back.header.angbase, Math.PI / 2, 'angbase kept'); assert.equal(back.header.angdir, 1, 'angdir kept');
  const def = parseDxf((() => { const o = writeDxf(newDocument()); return typeof o === 'string' ? o : o.text; })());
  assert.equal(def.header.angbase, undefined); assert.equal(def.header.angdir, undefined);
});
