import test from 'node:test';
import assert from 'node:assert/strict';
import { layerColsFrom, layerLinetypeText, lineweightText, layerTransparencyText } from '../src/core/layercols.js';

test('lineweight text: codes -3/-2/-1 and millimetres', () => {
  assert.equal(lineweightText(-3), 'Default');
  assert.equal(lineweightText(-2), 'ByBlock');
  assert.equal(lineweightText(-1), 'ByLayer');
  assert.equal(lineweightText(undefined), 'Default');
  assert.equal(lineweightText(0), '0.00 mm');
  assert.equal(lineweightText(0.35), '0.35 mm');
  assert.equal(lineweightText(2.11), '2.11 mm');
});
test('linetype text: name, CONTINUOUS when none', () => {
  assert.equal(layerLinetypeText({ linetype: 'DASHED' }), 'DASHED');
  assert.equal(layerLinetypeText({}), 'CONTINUOUS');
});
test('transparency text: percent of alpha, 0% when opaque or unset', () => {
  assert.equal(layerTransparencyText(102), '60%'); // alpha 102 of 255 = 60 % transparent
  assert.equal(layerTransparencyText(255), '0%');
  assert.equal(layerTransparencyText(undefined), '0%');
  assert.equal(layerTransparencyText(-1), '0%');
});
test('saved choice: compact unless exactly true', () => {
  for (const v of [undefined, null, false, 1, 'true']) assert.equal(layerColsFrom(v), false, String(v));
  assert.equal(layerColsFrom(true), true);
});
