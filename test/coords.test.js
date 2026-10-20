import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinate } from '../src/core/coords.js';

test('absolute, relative and polar input', () => {
  assert.deepEqual(parseCoordinate('10,20'), { x: 10, y: 20 });
  assert.deepEqual(parseCoordinate(' -1.5 , 2e1 '), { x: -1.5, y: 20 });
  assert.deepEqual(parseCoordinate('@5,3', { x: 10, y: 10 }), { x: 15, y: 13 });
  const p = parseCoordinate('@10<90', { x: 1, y: 1 });
  assert.ok(Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y - 11) < 1e-9);
  const q = parseCoordinate('10<180');
  assert.ok(Math.abs(q.x + 10) < 1e-9 && Math.abs(q.y) < 1e-9);
});

test('bare number is a distance along the current direction', () => {
  const r = parseCoordinate('25', { x: 0, y: 0 }, { x: 0, y: 3 });
  assert.equal(r.distance, 25);
  assert.ok(Math.abs(r.x) < 1e-9 && Math.abs(r.y - 25) < 1e-9);
  assert.deepEqual(parseCoordinate('25'), { distance: 25 });
});

test('garbage returns null', () => {
  for (const s of ['', 'abc', '1,2,x', '1,2,3,4', '@', '10<', ',', '1 2', '1;2;3;4', '@5', '1<2<3']) assert.equal(parseCoordinate(s), null, s);
});

const near = (p, x, y) => { assert.ok(p && Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9, `${JSON.stringify(p)} != (${x}, ${y})`); };

test('feet and inches when INSUNITS is inches (1): converted to inches', () => {
  const cases = { "12'": 144, "12'6\"": 150, "12'-6\"": 150, "12'6-1/2\"": 150.5, '6"': 6, '6-1/2"': 6.5, '1/2"': 0.5, "-12'6\"": -150, '7.5': 7.5 };
  for (const [t, v] of Object.entries(cases)) near(parseCoordinate(`${t},0`, undefined, null, null, 1), v, 0);
  near(parseCoordinate("12'6\",0", undefined, null, null, 1), 150, 0);
  near(parseCoordinate("@1',6\"", { x: 10, y: 10 }, null, null, 1), 22, 16);
  near(parseCoordinate("@10'<90", { x: 1, y: 1 }, null, null, 1), 1, 121);
  near(parseCoordinate("6-1/2\"<180", undefined, null, null, 1), -6.5, 0);
  assert.equal(parseCoordinate("2'", { x: 0, y: 0 }, null, null, 1).distance, 24);
});

test('feet and inches when INSUNITS is feet (2): converted to feet', () => {
  near(parseCoordinate("12'6\",0", undefined, null, null, 2), 12.5, 0);
  near(parseCoordinate("12'-6\";6\"", undefined, null, null, 2), 12.5, 0.5);
  near(parseCoordinate('1/2",3', undefined, null, null, 2), 1 / 24, 3);
  near(parseCoordinate("@12'6-1/2\"<90", { x: 0, y: 0 }, null, null, 2), 0, 12 + 6.5 / 12);
  near(parseCoordinate('@6",0', { x: 1, y: 1 }, null, null, 2), 1.5, 1);
});

test('feet and inch text is rejected in other units (mm, unitless) as before', () => {
  for (const u of [0, 4, 6]) for (const s of ["12'6\",0", "12',0", '6",0', "@10'<90", "2'"]) assert.equal(parseCoordinate(s, undefined, null, null, u), null, `${s} units ${u}`);
  for (const s of ["12''", "'6\"", '6', "12'6", '1/2', '6-1/2', "12'6\"\"", '1/0x"']) {
    const r = parseCoordinate(`${s},0`, undefined, null, null, 1);
    if (s === '6') near(r, 6, 0); else assert.equal(r, null, s);
  }
});

test("decimal comma: with a ';' the pair separator is ';' and ',' is a decimal comma", () => {
  near(parseCoordinate('1,5;2'), 1.5, 2);
  near(parseCoordinate(' -1,5 ; 2,25 '), -1.5, 2.25);
  near(parseCoordinate('@1,5;2,25', { x: 10, y: 10 }), 11.5, 12.25);
  near(parseCoordinate('1;2'), 1, 2);
  near(parseCoordinate('1.5;2'), 1.5, 2);
  near(parseCoordinate('1,5'), 1, 5); // no ';': unchanged, ',' separates x and y
  near(parseCoordinate('@1,5', { x: 1, y: 1 }), 2, 6);
  near(parseCoordinate("12'6,5\";0", undefined, null, null, 1), 150.5, 0);
  for (const s of ['1,5,5;2', '1,5;2;x', '1,,5;2']) assert.equal(parseCoordinate(s), null, s);
});

test('x,y,z input is accepted and z ignored (2D tool)', () => {
  near(parseCoordinate('1,2,3'), 1, 2);
  near(parseCoordinate(' -1.5 , 2e1 , 0 '), -1.5, 20);
  near(parseCoordinate('@1,2,3', { x: 10, y: 10 }), 11, 12);
  near(parseCoordinate('1;2;3'), 1, 2);
  near(parseCoordinate('1,5;2,25;7,5'), 1.5, 2.25); // decimal-comma form
  near(parseCoordinate('@1,5;2;3', { x: 10, y: 10 }), 11.5, 12);
  assert.equal(parseCoordinate('1,2,3').z, undefined);
  for (const s of ['1,2,', '1,2,abc', '1,2,3,4', '1;2;x']) assert.equal(parseCoordinate(s), null, s);
});
