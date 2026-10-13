import test from 'node:test';
import assert from 'node:assert/strict';
import { wheelScale, parseZoomFactor, ZOOMFACTOR_DEFAULT, ZOOMFACTOR_MIN, ZOOMFACTOR_MAX } from '../src/core/cmdline.js';

test('ZOOMFACTOR 60: a standard notch is a 1.25-1.3x step, in and out are inverse', () => {
  assert.equal(ZOOMFACTOR_DEFAULT, 60);
  const inn = wheelScale(60, -100), out = wheelScale(60, 100);
  assert.ok(inn >= 1.25 && inn <= 1.3, String(inn));
  assert.ok(Math.abs(inn * out - 1) < 1e-12);
});
test('the step grows with ZOOMFACTOR and a trackpad delta is proportional', () => {
  assert.ok(wheelScale(100, -100) > wheelScale(60, -100));
  assert.ok(wheelScale(3, -100) > 1 && wheelScale(3, -100) < 1.02);
  const small = wheelScale(60, -10);
  assert.ok(small > 1 && small < 1.03);
  assert.ok(Math.abs(wheelScale(60, -10) ** 10 - wheelScale(60, -100)) < 1e-9);
  assert.equal(wheelScale(60, 0), 1);
  assert.ok(Math.abs(wheelScale(60, -3, 1) - wheelScale(60, -99)) < 1e-12, 'line-mode deltas count 33 px a line');
  assert.equal(wheelScale(60, -5000), wheelScale(60, -400), 'one event is capped');
});
test('parseZoomFactor accepts whole numbers 3..100 only; a bad stored value falls back to the default', () => {
  assert.equal(parseZoomFactor('3'), ZOOMFACTOR_MIN);
  assert.equal(parseZoomFactor(' 100 '), ZOOMFACTOR_MAX);
  for (const bad of ['2', '101', '60.5', 'abc', '', null, undefined, true, NaN]) assert.equal(parseZoomFactor(bad), null, String(bad));
  assert.equal(wheelScale('junk', -100), wheelScale(60, -100));
});
