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
  assert.deepEqual(sideFoldedFrom(['symbols']), ['symbols']);
  assert.deepEqual(SIDE_SECTIONS, ['layers', 'markups', 'symbols', 'props']);
});

test('window title carries the build version so two test builds can be told apart', () => {
  assert.equal(windowTitle('plan.dxf', false, '0.2.0-beta.22'), 'plan.dxf — ASH Draw Studio 0.2.0-beta.22');
  assert.notEqual(windowTitle('plan.dxf', false, '0.2.0-beta.21'), windowTitle('plan.dxf', false, '0.2.0-beta.22'));
  assert.equal(windowTitle('plan.dxf', true, '0.2.0'), '• plan.dxf — ASH Draw Studio 0.2.0');
  assert.equal(windowTitle('Drawing1.dxf', false, undefined), 'Drawing1.dxf — ASH Draw Studio'); // before api.version answers
});

test('side panel mode: saved side.mode wins; never set falls back to the older side.shown (false = the rail)', async () => {
  const { sideModeFrom, SIDE_MODES } = await import('../renderer/side-panel.js');
  assert.deepEqual(SIDE_MODES, ['expanded', 'collapsed', 'hidden']);
  assert.equal(sideModeFrom('hidden', true), 'hidden');
  assert.equal(sideModeFrom('collapsed', undefined), 'collapsed');
  assert.equal(sideModeFrom(undefined, undefined), 'expanded');
  assert.equal(sideModeFrom('bogus', false), 'collapsed');
  assert.equal(sideModeFrom(null, true), 'expanded');
});

test('symbols layout: unknown view is grid; the floating window is sized then kept inside the app window', async () => {
  const { symbolViewFrom, floatRectClamp } = await import('../renderer/symbols-ui.js');
  assert.equal(symbolViewFrom('list'), 'list'); assert.equal(symbolViewFrom('bogus'), 'grid');
  assert.deepEqual(floatRectClamp({ x: 1300, y: -20, w: 320, h: 460 }, 1000, 700), { x: 680, y: 0, w: 320, h: 460 });
  assert.deepEqual(floatRectClamp({ x: 10, y: 10, w: 5000, h: 100 }, 1000, 700), { x: 0, y: 10, w: 1000, h: 160 });
});
