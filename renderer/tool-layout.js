// ASH Draw Studio - View > Customize tools: the tool panel and Quick Access layout, without the DOM.
// Saved as setting 'tools.layout':
//   { groupOrder: [group key], order: {group key: [tool ids]}, hidden: [tool ids], quick: [command ids or '|'], quickRow: bool }
// Group keys are the colour keys of TOOL_BUTTONS. Every function returns a new, complete layout; the input is never changed.
import { TOOL_BUTTONS, APP_COMMANDS, QUICK_ACCESS } from './tool-panel.js';

export const SEP = '|';
/** tools that can never be hidden */
export const ALWAYS_SHOWN = Object.freeze(['select']);
/** the group View > Tools: Compact leaves open */
export const COMPACT_KEEPS = 'select';
const MAX_LIST = 1000; // longer stored lists are cut before they are looked at

export const GROUP_KEYS = Object.freeze(TOOL_BUTTONS.map(([, key]) => key));
const LABELS = new Map(TOOL_BUTTONS.map(([label, key]) => [key, label]));
const DEFAULT_ORDER = new Map(TOOL_BUTTONS.map(([, key, items]) => [key, items.map(([id]) => id)]));
/** tool id -> {group (default), label, alias} */
const TOOLS = new Map(TOOL_BUTTONS.flatMap(([, key, items]) => items.map(([id, label, alias]) => [id, { group: key, label, alias }])));
const DEFAULT_QUICK = QUICK_ACCESS.flatMap(([, ids], i) => (i ? [SEP, ...ids] : ids));

export const groupLabel = (key) => LABELS.get(key) ?? key;
export const isTool = (id) => TOOLS.has(id);
export const isCommand = (id) => TOOLS.has(id) || Object.hasOwn(APP_COMMANDS, id);
export const canHide = (id) => TOOLS.has(id) && !ALWAYS_SHOWN.includes(id);
export const isHidden = (layout, id) => layout.hidden.includes(id);
export const inQuick = (layout, id) => layout.quick.includes(id);

export function defaultLayout() {
  return { groupOrder: [...GROUP_KEYS], order: Object.fromEntries([...DEFAULT_ORDER].map(([k, ids]) => [k, [...ids]])), hidden: [], quick: [...DEFAULT_QUICK], quickRow: true };
}

const strings = (a) => (Array.isArray(a) ? a.slice(0, MAX_LIST).filter((x) => typeof x === 'string') : []);
const uniq = (a) => [...new Set(a)];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A stored layout made safe: unknown groups and ids are dropped, each tool is placed once, Select is never hidden,
 * groups and tools missing from it (new in a later version) appear in their default place; anything unreadable gives the default.
 */
export function cleanLayout(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!isObj(v)) return defaultLayout();
  const groupOrder = uniq(strings(v.groupOrder).filter((g) => GROUP_KEYS.includes(g)));
  for (const [i, g] of GROUP_KEYS.entries()) { // a group not listed goes after the group before it by default
    if (groupOrder.includes(g)) continue;
    const prev = GROUP_KEYS.slice(0, i).reverse().find((p) => groupOrder.includes(p));
    groupOrder.splice(prev ? groupOrder.indexOf(prev) + 1 : 0, 0, g);
  }
  const src = isObj(v.order) ? v.order : {};
  const placed = new Set();
  const order = {};
  for (const g of groupOrder) {
    order[g] = [];
    for (const id of strings(Object.hasOwn(src, g) ? src[g] : null)) if (TOOLS.has(id) && !placed.has(id)) { placed.add(id); order[g].push(id); }
  }
  for (const [g, ids] of DEFAULT_ORDER) {
    for (const [rank, id] of ids.entries()) { // a tool not listed goes into its default group, after the tool before it by default
      if (placed.has(id)) continue;
      const list = order[g];
      const prev = ids.slice(0, rank).reverse().find((p) => list.includes(p));
      list.splice(prev ? list.indexOf(prev) + 1 : 0, 0, id);
      placed.add(id);
    }
  }
  let quick = DEFAULT_QUICK;
  if (Array.isArray(v.quick)) {
    const seen = new Set();
    quick = strings(v.quick).filter((id) => (id === SEP ? true : isCommand(id) && !seen.has(id) && seen.add(id)))
      .filter((id, i, a) => id !== SEP || a[i - 1] !== SEP);
  }
  return { groupOrder, order, hidden: uniq(strings(v.hidden).filter(canHide)), quick: [...quick], quickRow: v.quickRow !== false };
}

const copy = (l) => ({ groupOrder: [...l.groupOrder], order: Object.fromEntries(Object.entries(l.order).map(([g, a]) => [g, [...a]])), hidden: [...l.hidden], quick: [...l.quick], quickRow: l.quickRow });

/** the group a tool is in, or null */
export const groupOf = (layout, id) => layout.groupOrder.find((g) => layout.order[g].includes(id)) ?? null;

/** the panel as built: [[group label, key, [[id, label, alias] ...shown tools]]], groups without a shown tool left out */
export function panelGroups(layout) {
  return layout.groupOrder.map((g) => [groupLabel(g), g, layout.order[g].filter((id) => !layout.hidden.includes(id)).map((id) => [id, TOOLS.get(id).label, TOOLS.get(id).alias])])
    .filter(([, , items]) => items.length);
}

/** the Quick Access row as built: [[colour key, id] or SEP]; a tool takes its group's colour, an app command 'file'; no separator at an end or twice */
export function quickRow(layout) {
  const out = [];
  for (const id of layout.quick) {
    if (id === SEP) { if (out.length && out.at(-1) !== SEP) out.push(SEP); continue; }
    out.push([TOOLS.has(id) ? groupOf(layout, id) : 'file', id]);
  }
  if (out.at(-1) === SEP) out.pop();
  return out;
}

export function setHidden(layout, id, hidden) {
  const l = copy(layout);
  l.hidden = l.hidden.filter((x) => x !== id);
  if (hidden && canHide(id)) l.hidden.push(id);
  return l;
}
/** show (on) or hide every tool of a group; Select stays shown */
export function setGroupShown(layout, group, on) {
  let l = copy(layout);
  for (const id of l.order[group] ?? []) l = setHidden(l, id, !on);
  return l;
}
/** move a tool one place up (-1) or down (+1) inside its group */
export function moveItem(layout, id, delta) {
  const l = copy(layout);
  const g = groupOf(l, id); if (!g) return l;
  const list = l.order[g], i = list.indexOf(id), j = i + delta;
  if (j < 0 || j >= list.length) return l;
  [list[i], list[j]] = [list[j], list[i]];
  return l;
}
/** move a tool to the end of another group */
export function moveToGroup(layout, id, group) {
  const l = copy(layout);
  const g = groupOf(l, id);
  if (!g || g === group || !Object.hasOwn(l.order, group)) return l;
  l.order[g] = l.order[g].filter((x) => x !== id);
  l.order[group].push(id);
  return l;
}
/** move a whole group one place up (-1) or down (+1) */
export function moveGroup(layout, group, delta) {
  const l = copy(layout);
  const i = l.groupOrder.indexOf(group), j = i + delta;
  if (i < 0 || j < 0 || j >= l.groupOrder.length) return l;
  [l.groupOrder[i], l.groupOrder[j]] = [l.groupOrder[j], l.groupOrder[i]];
  return l;
}
/** add a command (or a separator) at the end of the Quick Access row; a command already there is not added twice */
export function quickAdd(layout, id) {
  const l = copy(layout);
  if (id === SEP || (isCommand(id) && !l.quick.includes(id))) l.quick.push(id);
  return l;
}
/** remove the entry at `index` of the Quick Access row, or the command `id` */
export function quickRemove(layout, at) {
  const l = copy(layout);
  const i = typeof at === 'number' ? at : l.quick.indexOf(at);
  if (i >= 0 && i < l.quick.length) l.quick.splice(i, 1);
  return l;
}
/** move the entry at `index` of the Quick Access row one place left (-1) or right (+1) */
export function quickMove(layout, index, delta) {
  const l = copy(layout);
  const j = index + delta;
  if (index < 0 || index >= l.quick.length || j < 0 || j >= l.quick.length) return l;
  [l.quick[index], l.quick[j]] = [l.quick[j], l.quick[index]];
  return l;
}
export const setQuickRow = (layout, on) => ({ ...copy(layout), quickRow: !!on });

/** View > Tools: Compact folds every group except Select ('tools.collapsed' keys); Expanded folds none */
export const compactKeys = () => GROUP_KEYS.filter((g) => g !== COMPACT_KEEPS);
/** 'compact' | 'expanded' | 'custom' for the View menu check marks */
export function foldMode(collapsed) {
  if (!collapsed.some((k) => GROUP_KEYS.includes(k))) return 'expanded';
  return compactKeys().every((k) => collapsed.includes(k)) && !collapsed.includes(COMPACT_KEEPS) ? 'compact' : 'custom';
}
