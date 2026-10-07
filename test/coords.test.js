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
  for (const s of ['', 'abc', '1,2,3', '@', '10<', ',']) assert.equal(parseCoordinate(s), null, s);
});
