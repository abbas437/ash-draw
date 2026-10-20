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

// Spec change (beta.55 recheck #9): DXF stores $ANGBASE in DEGREES, like every group-50 angle (LibreDWG's
// out_dxf.c writes header group-50 values through rad2deg). The earlier test read it as radians; that was wrong.
test('$ANGBASE (degrees in the DXF) / $ANGDIR are read, used for polar entry and written back', () => {
  const raw = '0\nSECTION\n2\nHEADER\n9\n$ANGBASE\n50\n90.0\n9\n$ANGDIR\n70\n1\n0\nENDSEC\n0\nEOF\n';
  const d = parseDxf(raw);
  near(d.header.angbase, Math.PI / 2, 'angbase (radians in the document)'); assert.equal(d.header.angdir, 1);
  // as AutoCAD: angle 0 points north and angles run clockwise
  let p = parseCoordinate('@10<0', O, null, d.header); near(p.x, 0, '@10<0 x'); near(p.y, 10, '@10<0 is north');
  p = parseCoordinate('@10<90', O, null, d.header); near(p.x, 10, '@10<90 is east'); near(p.y, 0, '@10<90 y');
  const out = writeDxf(d), text = typeof out === 'string' ? out : out.text;
  const m = /\$ANGBASE\r?\n\s*50\r?\n\s*([^\r\n]+)/.exec(text);
  assert.ok(m, '$ANGBASE written'); near(parseFloat(m[1]), 90, 'written in degrees');
  const back = parseDxf(text);
  near(back.header.angbase, Math.PI / 2, 'angbase kept'); assert.equal(back.header.angdir, 1, 'angdir kept');
  const def = parseDxf((() => { const o = writeDxf(newDocument()); return typeof o === 'string' ? o : o.text; })());
  assert.equal(def.header.angbase, undefined); assert.equal(def.header.angdir, undefined);
});
