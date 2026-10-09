import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_BUTTONS, QUICK_ACCESS, APP_COMMANDS, quickCommand, canvasDarkFrom, labelsFrom, collapsedFrom } from '../renderer/tool-panel.js';
import { ICONS } from '../renderer/icons.js';

test('settings migration: a never-set model background is dark; only an explicit "light" keeps it light', () => {
  assert.equal(canvasDarkFrom(undefined), true);
  assert.equal(canvasDarkFrom(null), true);
  assert.equal(canvasDarkFrom('dark'), true);
  assert.equal(canvasDarkFrom('light'), false);
});

test('settings migration: tool labels are off unless explicitly switched on; collapsed groups are a list of keys', () => {
  assert.equal(labelsFrom(undefined), false);
  assert.equal(labelsFrom(false), false);
  assert.equal(labelsFrom(true), true);
  assert.deepEqual(collapsedFrom(undefined), []);
  assert.deepEqual(collapsedFrom(['draw', 3, 'markup']), ['draw', 'markup']);
});

test('every Quick Access command is in the panel definition (or is a named app command) and has an icon', () => {
  const panel = new Set(TOOL_BUTTONS.flatMap(([, , items]) => items.map(([id]) => id)));
  const ids = QUICK_ACCESS.flatMap(([, list]) => list);
  assert.ok(ids.length >= 18, `${ids.length} Quick Access commands`);
  for (const id of ids) {
    assert.ok(panel.has(id) || Object.hasOwn(APP_COMMANDS, id), `${id} is a panel tool or an app command`);
    assert.ok(quickCommand(id)?.[0], `${id} has a label`);
    assert.ok(Object.hasOwn(ICONS, id), `${id} has an icon`);
  }
  for (const id of ['select', 'line', 'pline', 'circle', 'text', 'move', 'copy', 'trim', 'erase', 'dimlinear', 'measure', 'mkc', 'mkr']) assert.ok(ids.includes(id) && panel.has(id), id);
  assert.equal(quickCommand('nope'), null);
});
