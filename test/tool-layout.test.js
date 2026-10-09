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

test('tool panel placement: Left unless a saved placement is top or hidden', async () => {
  const { placementFrom } = await import('../renderer/tool-panel.js');
  assert.equal(placementFrom(undefined), 'left');
  assert.equal(placementFrom('bogus'), 'left');
  assert.equal(placementFrom('top'), 'top');
  assert.equal(placementFrom('hidden'), 'hidden');
});

test('Pan sits right next to Select in the side panel and in the Quick Access row', () => {
  const sel = TOOL_BUTTONS.find(([, key]) => key === 'select')[2].map(([id]) => id);
  assert.deepEqual(sel.slice(0, 2), ['select', 'pan']);
  const qa = QUICK_ACCESS.flatMap(([, list]) => list);
  assert.equal(qa[qa.indexOf('select') + 1], 'pan');
});

// ---- View > Customize tools (tool-layout.js) ------------------------------------------------------
const TL = await import('../renderer/tool-layout.js');
const flatPanel = (l) => TL.panelGroups(l).map(([, key, items]) => [key, items.map(([id]) => id)]);

test('customize: the default layout builds the panel and Quick Access row exactly as before', () => {
  const l = TL.defaultLayout();
  assert.deepEqual(flatPanel(l), TOOL_BUTTONS.map(([, key, items]) => [key, items.map(([id]) => id)]));
  assert.deepEqual(TL.panelGroups(l).map(([label]) => label), TOOL_BUTTONS.map(([label]) => label));
  const row = TL.quickRow(l);
  const want = QUICK_ACCESS.flatMap(([key, ids], i) => [...(i ? [TL.SEP] : []), ...ids.map((id) => [Object.hasOwn(APP_COMMANDS, id) ? 'file' : key, id])]);
  // app commands take the 'file' colour; zoomfit sat in the grey Select segment, which has the same colour
  assert.deepEqual(row.map((x) => (x === TL.SEP ? x : x[1])), want.map((x) => (x === TL.SEP ? x : x[1])));
  assert.equal(l.quickRow, true);
});

test('customize: bad stored data gives the default layout; JSON text is read', () => {
  for (const bad of [undefined, null, 3, 'nope', '[1]', [], true]) assert.deepEqual(TL.cleanLayout(bad), TL.defaultLayout(), String(bad));
  const l = TL.setHidden(TL.defaultLayout(), 'trim', true);
  assert.deepEqual(TL.cleanLayout(JSON.stringify(l)), l);
  assert.deepEqual(TL.cleanLayout(l), l);
});

test('customize: unknown ids are dropped, duplicates removed, Select cannot be hidden, missing tools return to their default place', () => {
  const l = TL.cleanLayout({
    groupOrder: ['markup', 'bogus', 'markup', 'select'],
    order: { draw: ['circle', 'line', 'nope', 'circle', 'measure', 7], inquiry: ['measure', 'area'], markup: ['mkt'] },
    hidden: ['select', 'trim', 'trim', 'zzz', 42],
    quick: ['undo', 'undo', '|', '|', 'offset', 'nope', 'layers', 'constructor'],
    quickRow: false,
  });
  // listed groups first in their order, the others after the group before them by default
  assert.deepEqual(l.groupOrder, ['markup', 'select', 'draw', 'modify', 'block', 'annotate', 'inquiry']);
  assert.deepEqual(l.order.draw.filter((id) => ['circle', 'line', 'measure'].includes(id)), ['circle', 'line', 'measure'], 'stored order kept, measure moved to Draw once');
  assert.equal(l.order.draw.indexOf('arc'), l.order.draw.indexOf('circle') + 1, 'arc back after circle');
  assert.deepEqual(l.order.inquiry, ['area']);
  assert.ok(l.order.draw.includes('pline') && l.order.draw.indexOf('pline') === l.order.draw.indexOf('line') + 1, 'pline back after line');
  assert.deepEqual(l.order.markup, ['mkc', 'mkr', 'mkt']);
  assert.deepEqual(l.order.select, ['select', 'pan']);
  assert.deepEqual(l.hidden, ['trim']);
  assert.deepEqual(l.quick, ['undo', '|', 'offset', 'layers']);
  assert.equal(l.quickRow, false);
  const all = Object.values(l.order).flat();
  assert.equal(all.length, new Set(all).size, 'each tool once');
  assert.equal(all.length, TOOL_BUTTONS.flatMap(([, , i]) => i).length, 'every tool placed');
});

test('customize: a tool that a future version adds appears in its default group, after its default neighbour', () => {
  const stored = TL.defaultLayout();
  stored.order.modify = stored.order.modify.filter((id) => id !== 'offset').reverse(); // as saved by a version without Offset
  const l = TL.cleanLayout(stored);
  const m = l.order.modify;
  assert.equal(m.indexOf('offset'), m.indexOf('mirror') + 1);
});

test('customize: prototype keys and huge arrays are harmless', () => {
  const raw = JSON.parse('{"__proto__":{"polluted":1},"order":{"__proto__":["line"],"constructor":["line"],"toString":["x"]},"hidden":["__proto__","hasOwnProperty"],"quick":["__proto__","toString","new"]}');
  const l = TL.cleanLayout(raw);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(l.order), TL.GROUP_KEYS);
  assert.deepEqual(l.hidden, []);
  assert.deepEqual(l.quick, ['new']);
  const big = TL.cleanLayout({ hidden: Array(1e6).fill('trim'), quick: Array(1e6).fill('|'), groupOrder: Array(1e6).fill('draw'), order: { draw: Array(1e6).fill('line') } });
  assert.deepEqual(big.hidden, ['trim']);
  assert.deepEqual(big.quick, ['|']);
  assert.deepEqual(TL.quickRow(big), []);
  assert.equal(big.groupOrder.length, TL.GROUP_KEYS.length);
});

test('customize: hide and show tools; a group with every tool hidden leaves the panel', () => {
  let l = TL.setHidden(TL.defaultLayout(), 'trim', true);
  assert.ok(!flatPanel(l).find(([k]) => k === 'modify')[1].includes('trim'));
  assert.deepEqual(TL.setHidden(l, 'trim', false).hidden, []);
  assert.deepEqual(TL.setHidden(l, 'select', true).hidden, ['trim'], 'Select stays');
  l = TL.setGroupShown(l, 'inquiry', false);
  assert.ok(!flatPanel(l).some(([k]) => k === 'inquiry'), 'empty group gone');
  l = TL.setGroupShown(l, 'select', false);
  assert.deepEqual(flatPanel(l).find(([k]) => k === 'select')[1], ['select']);
  assert.deepEqual(flatPanel(TL.setGroupShown(l, 'inquiry', true)).find(([k]) => k === 'inquiry')[1], ['measure', 'area']);
});

test('customize: move tools within and between groups, move groups; edits never change their input', () => {
  const d = TL.defaultLayout(), snap = JSON.stringify(d);
  let l = TL.moveToGroup(d, 'measure', 'draw');
  assert.equal(l.order.draw.at(-1), 'measure');
  assert.deepEqual(l.order.inquiry, ['area']);
  assert.equal(TL.groupOf(l, 'measure'), 'draw');
  assert.deepEqual(TL.quickRow(l).find((x) => x[1] === 'measure'), ['draw', 'measure'], 'Quick Access colour follows the group');
  assert.deepEqual(TL.moveToGroup(l, 'measure', 'nope'), l);
  l = TL.moveItem(l, 'measure', -1);
  assert.deepEqual(l.order.draw.slice(-2), ['measure', 'hatch']);
  assert.deepEqual(TL.moveItem(d, 'select', -1), d, 'first stays first');
  l = TL.moveGroup(l, 'markup', -1);
  assert.deepEqual(l.groupOrder.slice(-2), ['markup', 'inquiry']);
  assert.deepEqual(TL.moveGroup(d, 'select', -1), d);
  assert.equal(JSON.stringify(d), snap);
});

test('customize: Quick Access add, remove, reorder and separators', () => {
  const d = TL.defaultLayout();
  let l = TL.quickAdd(d, 'offset');
  assert.equal(l.quick.at(-1), 'offset');
  assert.deepEqual(TL.quickAdd(l, 'offset'), l, 'not twice');
  assert.deepEqual(TL.quickAdd(l, 'bogus'), l);
  l = TL.quickRemove(l, 'undo');
  assert.ok(!l.quick.includes('undo'));
  const i = l.quick.indexOf('offset');
  l = TL.quickMove(l, i, -1);
  assert.equal(l.quick.indexOf('offset'), i - 1);
  l = TL.quickAdd(l, TL.SEP);
  assert.equal(l.quick.at(-1), TL.SEP);
  assert.notEqual(TL.quickRow(l).at(-1), TL.SEP, 'no separator at the end of the row');
  l = TL.quickRemove(l, l.quick.length - 1);
  assert.equal(l.quick.at(-1), 'layers');
  assert.equal(TL.setQuickRow(l, false).quickRow, false);
  assert.equal(l.quickRow, true);
});

test('customize: View > Tools: Compact folds all but Select; the menu knows compact, expanded and custom', () => {
  assert.deepEqual(TL.compactKeys(), TL.GROUP_KEYS.filter((k) => k !== 'select'));
  assert.equal(TL.foldMode([]), 'expanded');
  assert.equal(TL.foldMode(TL.compactKeys()), 'compact');
  assert.equal(TL.foldMode(['draw']), 'custom');
  assert.equal(TL.foldMode([...TL.compactKeys(), 'select']), 'custom');
  assert.equal(TL.foldMode(['gone']), 'expanded');
});

test('customize: a stored list longer than MAX_LIST is cut before it is read (an entry past the cap is ignored)', () => {
  const junk = Array.from({ length: TL.MAX_LIST }, (_, i) => `junk${i}`);
  const l = TL.cleanLayout({ hidden: [...junk, 'trim'], quick: [...junk, 'undo'] });
  assert.deepEqual(l.hidden, [], 'hidden: Trim sits past the cap');
  assert.deepEqual(l.quick, [], 'quick: Undo sits past the cap');
  assert.ok(l.hidden.length <= TL.MAX_LIST && l.quick.length <= TL.MAX_LIST);
  assert.deepEqual(TL.cleanLayout({ hidden: [...junk.slice(1), 'trim'] }).hidden, ['trim'], 'one entry inside the cap still counts');
});

test('customize: the Dimension group stays in the panel (its style list lives there) with every dimension tool hidden or moved', () => {
  let l = TL.defaultLayout();
  for (const id of l.order.annotate) if (TL.canHide(id)) l = TL.setHidden(l, id, true);
  const g = TL.panelGroups(l).find(([, key]) => key === 'annotate');
  assert.ok(g, 'Dimension group kept');
  assert.equal(g[0], 'Dimension');
});

test('customize: samePanel ignores Quick Access edits and sees panel edits', () => {
  const d = TL.defaultLayout();
  assert.equal(TL.samePanel(d, TL.quickRemove(d, 'undo')), true);
  assert.equal(TL.samePanel(d, TL.setQuickRow(d, false)), true);
  assert.equal(TL.samePanel(d, TL.setHidden(d, 'trim', true)), false);
});
