// ASH Draw Studio - layout management (LAYOUT command, layout tab menu): new, copy, rename, delete and tab order.
// Pure ES module (no DOM). Each command is one undo step on the session. Layouts live on the root drawing
// (doc.modelDoc ?? doc) as doc.layouts, kept in tab order with tab = 1..n (the DXF writer writes them in list order).
// Paper-space named views carry `space: <layout name>`: a rename moves them, a delete deletes them, in the same step.
import { newLayout } from './layouts.js';
import { viewsOf } from './views.js';

const rootOf = (doc) => doc.modelDoc ?? doc;
/** the layouts of the drawing behind `doc`, in tab order */
export const layoutsOf = (doc) => [...(rootOf(doc).layouts ?? [])].sort((a, b) => a.tab - b.tab);
export const findLayout = (doc, name) => layoutsOf(doc).find((l) => l.name.toUpperCase() === String(name).trim().toUpperCase()) ?? null;

/** why `name` cannot name a layout (null when it can); `except` is the layout being renamed */
export function layoutNameError(doc, name, except = null) {
  const s = String(name ?? '').trim();
  if (!s) return 'A layout name cannot be empty.';
  if (s.length > 255) return 'A layout name can have at most 255 characters.';
  if (/[<>/\\":;?*|,=`]/.test(s)) return 'A layout name cannot contain any of < > / \\ " : ; ? * | , = `';
  if (s.toUpperCase() === 'MODEL') return '"Model" is the name of model space.';
  const other = findLayout(doc, s);
  if (other && other !== except) return `A layout named "${other.name}" already exists.`;
  return null;
}
const check = (doc, name, except) => { const e = layoutNameError(doc, name, except); if (e) throw new Error(e); return String(name).trim(); };

/** a free "LayoutN" name */
export function nextLayoutName(doc, base = 'Layout') {
  for (let i = layoutsOf(doc).length + 1; ; i++) if (!findLayout(doc, `${base}${i}`)) return `${base}${i}`;
}

/** set the layout list to `list` (tab order) and renumber the tabs 1..n, inside transaction tx */
function commit(tx, root, list) {
  tx.set(root, 'layouts', list);
  list.forEach((l, i) => { if (l.tab !== i + 1) tx.props(l, { tab: i + 1 }); });
}

/** LAYOUT New: an empty A3 layout after the last tab. Returns the layout. */
export function addLayout(s, name = nextLayoutName(s.doc)) {
  const root = rootOf(s.doc), n = check(root, name);
  const lo = newLayout(n, layoutsOf(root).length + 1);
  s.transact(`New layout ${n}`, (tx) => commit(tx, root, [...layoutsOf(root), lo]));
  return lo;
}

/** LAYOUT Copy: a deep copy of layout `from` (page setup, paper entities and viewports with new ids), placed after it */
export function copyLayout(s, from, name) {
  const root = rootOf(s.doc), src = findLayout(root, from);
  if (!src) throw new Error(`There is no layout "${from}".`);
  let n = name;
  if (n == null) { let i = 2; while (findLayout(root, `${src.name} (${i})`)) i++; n = `${src.name} (${i})`; }
  n = check(root, n);
  const { entities, ...rest } = src;
  const lo = { ...structuredClone(rest), name: n, block: null, entities: (entities ?? []).map((e) => ({ ...structuredClone(e), id: root.nextId++ })) };
  const list = layoutsOf(root);
  list.splice(list.indexOf(src) + 1, 0, lo);
  s.transact(`Copy layout ${src.name}`, (tx) => commit(tx, root, list));
  return lo;
}

/** LAYOUT Rename: the layout and its named views, one step */
export function renameLayout(s, from, to) {
  const root = rootOf(s.doc), lo = findLayout(root, from);
  if (!lo) throw new Error(`There is no layout "${from}".`);
  const n = check(root, to, lo), old = lo.name;
  if (n === old) return lo;
  const views = viewsOf(root);
  s.transact(`Rename layout ${old}`, (tx) => {
    tx.props(lo, { name: n });
    for (const [k, v] of [...views]) if (v.space === old) tx.set(views, k, { ...v, space: n }, false);
  });
  return lo;
}

/** LAYOUT Delete: the layout with its paper entities and viewports, and its named views, one step. The last layout stays. */
export function deleteLayout(s, name) {
  const root = rootOf(s.doc), lo = findLayout(root, name);
  if (!lo) throw new Error(`There is no layout "${name}".`);
  const list = layoutsOf(root);
  if (list.length <= 1) throw new Error('A drawing keeps at least one layout.');
  const views = viewsOf(root);
  s.transact(`Delete layout ${lo.name}`, (tx) => {
    commit(tx, root, list.filter((l) => l !== lo));
    for (const [k, v] of [...views]) if (v.space === lo.name) tx.set(views, k, undefined, false);
  });
  return lo;
}

/** Move left (delta -1) / right (+1) on the tabs: the tab order (LAYOUT code 71). Returns false at either end. */
export function moveLayout(s, name, delta) {
  const root = rootOf(s.doc), lo = findLayout(root, name), list = layoutsOf(root);
  const i = list.indexOf(lo), j = i + delta;
  if (!lo || j < 0 || j >= list.length || j === i) return false;
  list.splice(i, 1); list.splice(j, 0, lo);
  s.transact(`Move layout ${lo.name}`, (tx) => commit(tx, root, list));
  return true;
}

/** PAGESETUP: change a layout's plot settings (merged into layout.plot) as one step */
export function setPageSetup(s, name, plot) {
  const lo = findLayout(rootOf(s.doc), name);
  if (!lo) throw new Error(`There is no layout "${name}".`);
  s.transact(`Page setup ${lo.name}`, (tx) => tx.set(lo, 'plot', { ...lo.plot, ...plot }));
  return lo;
}
