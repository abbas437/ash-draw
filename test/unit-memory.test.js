import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUnitAnswers, recallUnit, rememberUnit, unitKey, UNIT_ANSWERS_MAX } from '../renderer/unit-memory.js';

test('unitKey: full path, else name + size, else null', () => {
  assert.equal(unitKey({ path: '/a/b/Plan.dxf', name: 'Plan.dxf', size: 5 }), 'p:/a/b/Plan.dxf');
  assert.notEqual(unitKey({ path: '/a/Plan.dxf', name: 'Plan.dxf' }), unitKey({ path: '/b/Plan.dxf', name: 'Plan.dxf' }));
  assert.equal(unitKey({ path: 'C:\\X\\Plan.dxf' }), unitKey({ path: 'c:/x/plan.DXF' }), 'Windows paths compare case-insensitively');
  assert.equal(unitKey({ path: null, name: 'Plan.dxf', size: 120 }), 'n:plan.dxf:120');
  assert.notEqual(unitKey({ path: null, name: 'Plan.dxf', size: 120 }), unitKey({ path: null, name: 'Plan.dxf', size: 121 }));
  assert.equal(unitKey({ path: null, name: 'Plan.dxf' }), null);
  assert.equal(unitKey(null), null);
});

test('rememberUnit / recallUnit: latest answer per key; unknown key gives 0', () => {
  let l = [];
  l = rememberUnit(l, 'p:/a', 6);
  l = rememberUnit(l, 'p:/b', 1);
  assert.equal(recallUnit(l, 'p:/a'), 6);
  assert.equal(recallUnit(l, 'p:/b'), 1);
  assert.equal(recallUnit(l, 'p:/c'), 0);
  assert.equal(recallUnit(l, null), 0);
  l = rememberUnit(l, 'p:/a', 2);
  assert.equal(recallUnit(l, 'p:/a'), 2);
  assert.equal(l.length, 2);
  assert.deepEqual(rememberUnit(l, null, 4), l);
  assert.deepEqual(rememberUnit(l, 'p:/z', 99), l, 'only the four offered units are stored');
});

test('rememberUnit caps at 200 entries and drops the oldest', () => {
  let l = [];
  for (let i = 0; i < UNIT_ANSWERS_MAX + 5; i++) l = rememberUnit(l, `p:/f${i}`, 4);
  assert.equal(l.length, UNIT_ANSWERS_MAX);
  assert.equal(recallUnit(l, 'p:/f0'), 0);
  assert.equal(recallUnit(l, 'p:/f4'), 0);
  assert.equal(recallUnit(l, 'p:/f5'), 4);
  l = rememberUnit(l, 'p:/f5', 6); // re-answering makes it the newest, so it outlives the next drop
  l = rememberUnit(l, 'p:/new', 1);
  assert.equal(recallUnit(l, 'p:/f5'), 6);
  assert.equal(recallUnit(l, 'p:/f6'), 0);
});

test('cleanUnitAnswers: bad stored values are dropped', () => {
  assert.deepEqual(cleanUnitAnswers(undefined), []);
  assert.deepEqual(cleanUnitAnswers({}), []);
  assert.deepEqual(cleanUnitAnswers([['a', 6], ['b', 77], [3, 4], 'x', ['a', 1]]), [['a', 1]]);
});
