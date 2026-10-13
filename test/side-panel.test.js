import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideShownFrom, sideFoldedFrom, windowTitle, SIDE_SECTIONS } from '../renderer/side-panel.js';

test('side panel settings: never-set means shown with nothing folded; only an explicit false hides it', () => {
  assert.equal(sideShownFrom(undefined), true);
  assert.equal(sideShownFrom(null), true);
  assert.equal(sideShownFrom('no'), true);
  assert.equal(sideShownFrom(false), false);
  assert.deepEqual(sideFoldedFrom(undefined), []);
  assert.deepEqual(sideFoldedFrom('layers'), []);
  assert.deepEqual(sideFoldedFrom(['props', 'bogus', 3, 'layers', 'layers']), ['layers', 'props']);
  assert.deepEqual(SIDE_SECTIONS, ['layers', 'markups', 'props']);
});

test('window title carries the build version so two test builds can be told apart', () => {
  assert.equal(windowTitle('plan.dxf', false, '0.2.0-beta.22'), 'plan.dxf — ASH Draw Studio 0.2.0-beta.22');
  assert.notEqual(windowTitle('plan.dxf', false, '0.2.0-beta.21'), windowTitle('plan.dxf', false, '0.2.0-beta.22'));
  assert.equal(windowTitle('plan.dxf', true, '0.2.0'), '• plan.dxf — ASH Draw Studio 0.2.0');
  assert.equal(windowTitle('Drawing1.dxf', false, undefined), 'Drawing1.dxf — ASH Draw Studio'); // before api.version answers
});
