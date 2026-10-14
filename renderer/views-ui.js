// ASH Draw Studio - VIEW / V: the named views dialog (new, set current, update, rename, delete) and the View menu's
// one-click list of named views. The model (doc.views, DXF VIEW table) is in src/core/views.js.
import { viewsIn, findView, restorable, restoreView, saveView, renameView, deleteView, viewFromScreen, viewFromBox, validViewName } from '../src/core/views.js';
import { el, modal, message, promptDialog, confirmDialog, toast } from './ui.js';
import { pickPoint } from './clipboard-ui.js';

const MENU_VIEWS = 10;
const fmt = (v) => String(+v.toPrecision(6));

/** the views space of the shown tab: 'model', or the layout's name */
export const viewSpace = (app) => { const cur = app.active?.spaces?.cur ?? 'Model'; return cur === 'Model' ? 'model' : cur; };
/** in MSPACE the canvas shows model space through a layout viewport: a view of the layout cannot be shown or taken there */
const inMspace = (app) => { if (!app.vp.mspace) return false; toast('Named views work in model space or on the layout sheet: leave the viewport first (PSPACE).'); return true; };

/** show named view `name` in the viewport, as its own ZOOM Previous step; false when it cannot be shown */
export function setCurrentView(app, name) {
  if (inMspace(app)) return false;
  const vp = app.vp, r = restoreView(app.doc, name, vp.view.width, vp.view.height);
  if (!r) { toast(`View "${name}" cannot be shown (a 3D view, or no such view).`); return false; }
  app.viewHistory?.breakGesture(app.viewKey());
  vp.view = { ...vp.view, ...r };
  vp.requestRender(); vp.emit('view');
  return true;
}

/** two corners picked on the drawing -> {minx, miny, maxx, maxy}, or null when cancelled */
async function pickBox(app) {
  const pick = (prompt) => new Promise((res) => {
    pickPoint(app, prompt, res);
    const t = app.tools.pickpoint, d0 = t.deactivate;
    t.deactivate = () => { d0.call(t); queueMicrotask(() => res(null)); }; // Esc / another tool: no point (a pick resolves first)
  });
  const a = await pick('VIEW  first corner of the window');
  if (!a) return null;
  app.vp.lastPoint = a;
  const b = await pick('VIEW  opposite corner of the window');
  app.vp.lastPoint = null;
  if (!b || Math.abs(b.x - a.x) < 1e-12 || Math.abs(b.y - a.y) < 1e-12) return null;
  return { minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y), maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y) };
}

/** save `v`, asking first when it would replace another view; true when saved */
async function store(app, v) {
  const old = findView(app.doc, v.name);
  if (old && (await confirmDialog('New view', `A view named "${old.name}" already exists. Replace it?`, 'Replace', 'Cancel', null)) !== 'yes') return false;
  try { saveView(app.session, v); return true; } catch (err) { await message('New view', err.message); return false; }
}

/** the New View dialog: a name, and the current display or a window picked on the drawing */
async function newView(app) {
  const name = el('input', { type: 'text', id: 'view-name', style: 'width:100%' });
  const from = el('select', { id: 'view-from' }, el('option', { value: 'screen', text: 'Current display' }), el('option', { value: 'window', text: 'Define window' }));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.querySelector('#dlg button.primary').click(); } });
  const r = await modal('New view', el('div', { class: 'cmp-pick' }, el('label', {}, 'View name', el('div', {}, name)), el('label', {}, 'Boundary', el('div', {}, from))),
    [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  if (r !== 'ok') return null;
  const n = name.value.trim();
  if (!validViewName(n)) { await message('New view', n ? `"${n}" is not a valid view name: it cannot contain < > / \\ " : ; ? * | , = \`` : 'Enter a name for the view.'); return null; }
  if (inMspace(app)) return null;
  const space = viewSpace(app);
  let v;
  if (from.value === 'window') { const b = await pickBox(app); if (!b) return null; v = viewFromBox(n, b, space); } else v = viewFromScreen(n, app.vp.view, space);
  return (await store(app, v)) ? v.name : null;
}

/** VIEW / V: the named views of the current space, with New, Set current, Update, Rename and Delete */
export async function viewManager(app) {
  let sel = null;
  for (;;) {
    const views = viewsIn(app.doc, viewSpace(app));
    if (!views.some((v) => v.name === sel)) sel = views.find(restorable)?.name ?? views[0]?.name ?? null;
    const list = el('select', { id: 'view-list', size: 10, style: 'width:100%;min-width:22em', 'aria-label': 'Named views' },
      views.map((v) => el('option', { value: v.name, text: restorable(v) ? v.name : `${v.name}  (3D view, cannot be shown)`, style: restorable(v) ? null : 'color:var(--dim)', selected: v.name === sel })));
    const info = el('p', { id: 'view-info' });
    const show = () => {
      const v = views.find((x) => x.name === list.value);
      info.textContent = v ? `Centre (${fmt(v.center.x)}, ${fmt(v.center.y)}), ${fmt(v.width)} wide, ${fmt(v.height)} high` : views.length ? '' : 'No named views in this space yet: use New… to save the current display.';
    };
    list.addEventListener('change', show); list.addEventListener('dblclick', () => { if (list.value) document.querySelector('#dlg button.primary').click(); });
    show();
    const r = await modal(`Named views: ${viewSpace(app) === 'model' ? 'Model' : viewSpace(app)}`, el('div', { class: 'cmp-pick' }, list, info),
      [{ label: 'Set current', value: 'set', primary: true }, { label: 'New…', value: 'new' }, { label: 'Update', value: 'update' }, { label: 'Rename…', value: 'rename' }, { label: 'Delete', value: 'delete' }, { label: 'Close', value: null }]);
    if (r == null) return;
    sel = list.value || null;
    if (r === 'new') { sel = (await newView(app)) ?? sel; continue; }
    if (!sel) { await message('Named views', 'Choose a view in the list first.'); continue; }
    if (r === 'set') { if (setCurrentView(app, sel)) return; continue; }
    if (r === 'update') {
      if (inMspace(app)) continue;
      const v = findView(app.doc, sel);
      saveView(app.session, { ...v, ...viewFromScreen(v.name, app.vp.view, v.space), dxf: undefined }); // the current display, same name and space
      toast(`View "${v.name}" updated to the current display.`, 2000);
    } else if (r === 'rename') {
      const to = await promptDialog(`Rename view "${sel}"`, sel);
      if (to == null || to.trim() === sel) continue;
      try { sel = renameView(app.session, sel, to).name; } catch (err) { await message('Rename view', err.message); }
    } else if (r === 'delete') { deleteView(app.session, sel); sel = null; }
  }
}

/** View menu items: "Named views…" and one item per restorable view of the current space (up to 10, read when the menu opens) */
export function viewMenuItems(app) {
  const shown = () => (app.doc ? viewsIn(app.doc, viewSpace(app)).filter(restorable).slice(0, MENU_VIEWS) : []);
  return [['Named views…', 'VIEW', () => viewManager(app)],
    ...Array.from({ length: MENU_VIEWS }, (_, i) => [() => shown()[i]?.name ?? '', '', () => { const v = shown()[i]; if (v) setCurrentView(app, v.name); }, null, () => !!shown()[i]])];
}

/** VIEW and V on the command line */
export const viewCommands = (app) => ({ view: () => viewManager(app), v: () => viewManager(app) });
