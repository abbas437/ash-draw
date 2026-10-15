import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, FALLBACK_ICON, iconMarkup } from '../renderer/icons.js';
import { TOOL_BUTTONS, toolTitle } from '../renderer/tool-panel.js';
import { TOOL_ALIASES } from '../renderer/tools.js';

// buttons outside the command groups: Dim styles…, zoom bar
const TOOLBAR_ICONS = ['dimstyle', 'zoomin', 'zoomout', 'zoomfit'];

test('every command in the tool panel has its own icon', () => {
  const ids = TOOL_BUTTONS.flatMap(([, , items]) => items.map(([id]) => id));
  assert.ok(ids.length >= 40, `panel definition read (${ids.length} commands)`);
  const missing = [...ids, ...TOOLBAR_ICONS].filter((id) => !Object.hasOwn(ICONS, id));
  assert.deepEqual(missing, [], `commands without an icon: ${missing.join(', ')}`);
});

test('every panel command is a real tool and every group has a colour key', () => {
  const tools = new Set(Object.values(TOOL_ALIASES));
  for (const [group, key, items] of TOOL_BUTTONS) {
    assert.match(key, /^(select|draw|modify|block|annotate|inquiry|markup)$/, `${group} colour key`);
    for (const [id] of items) assert.ok(tools.has(id), `${id} is a command`);
  }
});

test('icons are plain stroke shapes on the 24x24 grid; unknown commands get the fallback', () => {
  for (const [id, svg] of Object.entries(ICONS)) {
    assert.ok(svg.length > 10, id);
    const tags = [...svg.matchAll(/<(\w+)/g)].map((m) => m[1]);
    assert.ok(tags.every((t) => ['path', 'circle', 'ellipse'].includes(t)), `${id}: ${tags}`);
    assert.doesNotMatch(svg, /stroke="(?!none)|stroke-width|<svg|on\w+=/, `${id} keeps the shared stroke and has no handlers`);
    for (const n of svg.match(/-?\d*\.?\d+/g)) assert.ok(Math.abs(Number(n)) <= 24, `${id}: ${n} outside the grid`);
  }
  assert.equal(iconMarkup('no-such-command'), FALLBACK_ICON);
  assert.equal(iconMarkup('line'), ICONS.line);
});

test('tooltips name the command and its alias', () => {
  assert.equal(toolTitle('Line', 'L'), 'Line (L)');
  assert.equal(toolTitle('Select'), 'Select');
});

test('panel and toolbar icons exist and draw in currentColor (no colour of their own)', async () => {
  const { QUICK_ACCESS } = await import('../renderer/tool-panel.js');
  const ids = [...TOOL_BUTTONS.flatMap(([, , items]) => items.map(([id]) => id)), ...QUICK_ACCESS.flatMap(([, list]) => list), ...TOOLBAR_ICONS];
  for (const id of new Set(ids)) {
    assert.ok(Object.hasOwn(ICONS, id), `${id} has an icon`);
    for (const [, attr, v] of ICONS[id].matchAll(/\b(fill|stroke|color|style)="([^"]*)"/g)) assert.match(v, /^(currentColor|none)$/, `${id}: ${attr}="${v}"`);
    assert.doesNotMatch(ICONS[id], /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${id} has a hard-coded colour`);
  }
});
