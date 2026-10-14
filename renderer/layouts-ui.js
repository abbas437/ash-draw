// ASH Draw Studio - Model / layout tabs under the canvas, layout (paper space) mode and the MV tool.
// A layout is shown by pointing the tab's Session (and so the Viewport, picking and editing) at a
// "space doc": the drawing seen through the layout's entity list (layers, blocks, ids stay shared).
import { buildScene, docWithFrozen, fitView, screenToWorld, viewportToPaper } from '../src/core/render.js';
import { makeViewport, viewportScale, modelViewThrough, viewportFromModelView, viewportAt, STANDARD_SCALES, isPaperViewport, viewportPrintScale, viewHeightForScale } from '../src/core/layouts.js';
import { recordViewportView, viewportView } from '../src/core/edit.js';
import { Tool, TOOL_ALIASES } from './tools.js';
import { el, modal, message, toast } from './ui.js';
import { addLayout, copyLayout, renameLayout, deleteLayout, moveLayout, setPageSetup, findLayout, layoutsOf, layoutNameError } from '../src/core/layoutmgmt.js';

/** the drawing seen through one layout: entities are the layout's, everything else is the drawing's */
export function spaceDoc(doc, layout) {
  const fwd = (k) => ({ get: () => doc[k], set: (v) => { doc[k] = v; } });
  return Object.create(doc, {
    entities: { get: () => layout.entities, set: (v) => { layout.entities = v; }, enumerable: true },
    nextId: fwd('nextId'), dimStyles: fwd('dimStyles'),
    modelDoc: { value: doc }, layout: { value: layout },
  });
}

const spaces = (tab) => (tab.spaces ??= { cur: 'Model', views: {}, docs: {}, scenes: new Map() });
const layoutOf = (tab, name) => tab.doc.layouts?.find((l) => l.name === name) ?? null;

/** show the Model tab or a named layout of the active drawing (each keeps its own view) */
export function setSpace(app, name) {
  const tab = app.active, vp = app.vp, sp = spaces(tab);
  if (sp.cur === name) return;
  const layout = name === 'Model' ? null : layoutOf(tab, name);
  if (name !== 'Model' && !layout) return;
  exitMspace(app);
  sp.views[sp.cur] = { cx: vp.view.cx, cy: vp.view.cy, zoom: vp.view.zoom };
  if (app.toolId) app.setTool(app.toolId === 'select' ? 'select' : app.toolId); // drop a half-done command
  if (layout && sp.docs[name]?.layout !== layout) sp.docs[name] = spaceDoc(tab.doc, layout); // a name can move to another layout (rename, delete)
  tab.session.doc = layout ? sp.docs[name] : tab.doc;
  sp.cur = name;
  vp.layout = layout;
  vp.setSession(tab.session, { fit: !sp.views[name], view: sp.views[name] ?? null });
  app.refreshPanels(); app.refreshStatus(); renderSpaceBar(app);
}

/** called by App.switchTo before the tab's session is shown */
export function restoreSpace(app, tab) { app.vp.layout = layoutOf(tab, spaces(tab).cur); }

export function renderSpaceBar(app) {
  const tab = app.active;
  if (!tab || !app.spaceBar) return;
  const cur = spaces(tab).cur;
  const names = ['Model', ...[...(tab.doc.layouts ?? [])].sort((a, b) => a.tab - b.tab).map((l) => l.name)];
  app.spaceBar.replaceChildren(...names.map((n) => el('button', {
    type: 'button', role: 'tab', class: n === cur ? 'active' : '', 'data-space': n, 'aria-selected': String(n === cur), text: n,
    onclick: () => setSpace(app, n), oncontextmenu: (e) => { e.preventDefault(); tabMenu(app, n, e); },
  })));
}

// ---- layout management (LAYOUT command, tab menu): src/core/layoutmgmt.js, one undo step per action ----------------

/** after a layout change or its undo: follow a renamed shown layout, leave a deleted one for Model, redraw the tabs */
function syncSpace(app) {
  const tab = app.active;
  if (!tab) return;
  const sp = spaces(tab), lo = app.vp.layout;
  if (sp.cur !== 'Model' && !layoutOf(tab, sp.cur)) {
    if (lo && tab.doc.layouts?.includes(lo)) { sp.views[lo.name] = sp.views[sp.cur]; sp.docs[lo.name] = sp.docs[sp.cur]; sp.cur = lo.name; } else setSpace(app, 'Model');
  }
  renderSpaceBar(app);
}

async function askLayoutName(app, title, value, except = null) {
  for (;;) {
    const inp = el('input', { type: 'text', name: 'layoutName', value, style: 'width:20em' });
    if ((await modal(title, [el('label', {}, 'Layout name ', inp)], [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }])) !== 'ok') return null;
    const err = layoutNameError(app.active.doc, inp.value, except);
    if (!err) return inp.value.trim();
    await message('Invalid layout name', err); value = inp.value;
  }
}

/** one layout action: new, copy, rename, delete, left, right, set, pagesetup; `name` the layout it applies to */
export async function layoutAction(app, act, name) {
  const s = app.active?.session, doc = app.active?.doc, lo = name && name !== 'Model' ? findLayout(doc, name) : null;
  if (!s) return;
  try {
    if (act === 'new') { const n = await askLayoutName(app, 'New layout', addLayoutName(doc)); if (n) setSpace(app, addLayout(s, n).name); } else if (act === 'set') {
      if (lo || name === 'Model') setSpace(app, lo ? lo.name : 'Model');
    } else if (!lo) toast(name === 'Model' ? 'The Model tab cannot be changed.' : `There is no layout "${name}".`);
    else if (act === 'copy') { const n = await askLayoutName(app, `Copy ${lo.name}`, copyName(doc, lo.name)); if (n) copyLayout(s, lo.name, n); } else if (act === 'rename') {
      const n = await askLayoutName(app, `Rename ${lo.name}`, lo.name, lo); if (n) renameLayout(s, lo.name, n);
    } else if (act === 'delete') {
      if (layoutsOf(doc).length <= 1) { toast('A drawing keeps at least one layout.'); return; }
      const ok = await modal('Delete layout', [el('p', { text: `The layout "${lo.name}" and everything on it will be deleted.` })], [{ label: 'Delete', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
      if (ok === 'ok') deleteLayout(s, lo.name);
    } else if (act === 'left' || act === 'right') moveLayout(s, lo.name, act === 'left' ? -1 : 1);
    else if (act === 'pagesetup') await pageSetupDialog(app, lo);
  } catch (err) { await message('Layout', err.message || String(err)); }
  syncSpace(app);
}
const addLayoutName = (doc) => { for (let i = layoutsOf(doc).length + 1; ; i++) if (!findLayout(doc, `Layout${i}`)) return `Layout${i}`; };
const copyName = (doc, n) => { let i = 2; while (findLayout(doc, `${n} (${i})`)) i++; return `${n} (${i})`; };

const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841], Letter: [279.4, 215.9], Tabloid: [431.8, 279.4] };
const paperKey = (p) => Object.keys(PAPERS).find((k) => Math.abs(Math.max(p.paperW, p.paperH) - PAPERS[k][0]) < 0.6 && Math.abs(Math.min(p.paperW, p.paperH) - PAPERS[k][1]) < 0.6) ?? '';

/** PAGESETUP: paper, orientation, plot scale or fit, plot area, stored in the layout's PLOTSETTINGS fields
 *  (4 paper name, 44/45 paper size mm, 73 rotation, 142/143 scale, 75 standard scale 0 = fit, 74 plot type) */
async function pageSetupDialog(app, lo) {
  const p = lo.plot, cur = paperKey(p);
  const paper = el('select', { name: 'paper' }, [...(cur ? [] : [el('option', { value: '', text: `${p.paperName || 'Current'} (${+p.paperW.toFixed(1)} × ${+p.paperH.toFixed(1)} mm)` })]), ...Object.keys(PAPERS).map((k) => el('option', { value: k, text: k }))]);
  paper.value = cur;
  const ori = el('select', { name: 'orientation' }, [el('option', { value: '0', text: 'Landscape' }), el('option', { value: '1', text: 'Portrait' })]);
  ori.value = (p.rotation === 1 || p.rotation === 3) !== (p.paperH > p.paperW) ? '1' : '0';
  const fit = el('input', { type: 'checkbox', name: 'fit', checked: p.stdScale === 0 });
  const n = el('input', { type: 'number', name: 'scale', min: '0.000001', step: 'any', value: String(+((p.scaleDen || 1) / (p.scaleNum || 1)).toPrecision(6)), style: 'width:7em' });
  const area = el('select', { name: 'area' }, [el('option', { value: '5', text: 'Layout' }), el('option', { value: '1', text: 'Extents' }), el('option', { value: '4', text: 'Window (as stored)' })]);
  area.value = [1, 4].includes(p.plotType) ? String(p.plotType) : '5';
  const r = await modal(`Page setup — ${lo.name}`, [el('label', {}, 'Paper size '), paper, el('label', {}, 'Orientation '), ori,
    el('label', {}, fit, ' Fit to paper'), el('label', {}, 'Plot scale (paper : layout)  1 : ', n), el('label', {}, 'Plot area '), area],
  [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  if (r !== 'ok') return;
  const k = Number(n.value), dims = paper.value ? PAPERS[paper.value] : [Math.max(p.paperW, p.paperH), Math.min(p.paperW, p.paperH)];
  if (!fit.checked && !(k > 0)) { await message('Invalid scale', 'Enter a scale greater than zero, for example 1 : 1.'); return; }
  setPageSetup(app.active.session, lo.name, {
    ...(paper.value ? { paperName: paper.value, paperW: dims[0], paperH: dims[1] } : {}),
    rotation: ori.value === '1' ? (dims[0] >= dims[1] ? 1 : 0) : (dims[0] >= dims[1] ? 0 : 1),
    stdScale: fit.checked ? 0 : 16, ...(fit.checked ? {} : { scaleNum: 1, scaleDen: k }), plotType: Number(area.value),
  });
}

/** right-click on a Model / layout tab */
function tabMenu(app, name, ev) {
  document.querySelector('.popmenu')?.remove();
  const model = name === 'Model', list = layoutsOf(app.active.doc), i = list.findIndex((l) => l.name === name);
  const item = (act, text, off = false) => el('button', { 'data-act': act, disabled: off, onclick: () => { m.remove(); layoutAction(app, act, name); } }, text);
  const m = el('div', { class: 'popmenu', style: `left:${ev.clientX}px;top:${ev.clientY}px` },
    item('new', 'New layout'), item('copy', 'Copy', model), item('rename', 'Rename', model), item('delete', 'Delete', model || list.length <= 1),
    item('left', 'Move left', model || i <= 0), item('right', 'Move right', model || i >= list.length - 1), item('pagesetup', 'Page setup…', model));
  m.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.append(m);
  if (ev.clientY + m.offsetHeight > innerHeight) m.style.top = `${Math.max(0, ev.clientY - m.offsetHeight)}px`; // the tabs sit at the bottom: open upwards
  setTimeout(() => document.addEventListener('pointerdown', () => m.remove(), { once: true }), 0);
}

/** LAYOUT (LO): New / Copy / Delete / Rename / Set / ? as in AutoCAD (Template is not offered) */
async function layoutCommand(app) {
  const cur = spaces(app.active).cur;
  const opts = [['new', 'New'], ['copy', 'Copy'], ['delete', 'Delete'], ['rename', 'Rename'], ['set', 'Set'], ['list', '?']];
  const act = await modal('LAYOUT', [el('p', { text: `Current: ${cur}. Choose an option.` })], [...opts.map(([value, label]) => ({ label, value })), { label: 'Cancel', value: null }]);
  if (!act) return;
  if (act === 'list') { await message('Layouts', layoutsOf(app.active.doc).map((l) => l.name).join('\n')); return; }
  if (act === 'new') { await layoutAction(app, 'new'); return; }
  const sel = el('select', { name: 'layout' }, (act === 'set' ? ['Model'] : []).concat(layoutsOf(app.active.doc).map((l) => l.name)).map((n) => el('option', { value: n, text: n })));
  if (cur !== 'Model' || act === 'set') sel.value = cur;
  if ((await modal(`LAYOUT ${opts.find((o) => o[0] === act)[1]}`, [el('label', {}, 'Layout ', sel)], [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }])) === 'ok') await layoutAction(app, act, sel.value);
}

// ---- model space through a viewport (MSPACE / PSPACE) ----------------------------------------------------------------
// In MSPACE the tab's session and the Viewport show the model doc, and vp.view is the model view that the paper view
// shows through the active viewport, so tools, picking and snapping work in model coordinates unchanged. vp.mspace keeps
// the paper side ({ vp: VIEWPORT entity, paperView, paperScene }) for drawing the layout and for the way back.

/** make viewport `v` of the shown layout the active one (enters model space) */
export function enterMspace(app, v) {
  const vp = app.vp, tab = app.active;
  if (!vp.layout || !v) return false;
  if (v.twist) { toast('Model space through a twisted viewport is not supported in this version.'); return false; }
  commitViewportView(app); // switching viewports ends the previous one's view session
  const m = vp.mspace;
  const paperView = m ? { ...m.paperView } : { ...vp.view }, paperScene = m ? m.paperScene : vp.scene;
  if (app.toolId) app.setTool(app.toolId === 'select' ? 'select' : app.toolId); // drop a half-done command
  tab.session.doc = tab.doc;
  vp.mspace = { vp: v, paperView, paperScene, quiet: true, start: viewportView(v), zoomExtents: () => zoomViewportExtents(app) };
  vp.setSession(tab.session, { fit: false, view: modelViewThrough(paperView, v) });
  vp.mspace.quiet = false; // the view set above is the viewport's own, not a user zoom/pan to write back
  app.refreshPanels(); app.refreshStatus();
  return true;
}

/** back to paper space on the shown layout (no-op outside MSPACE) */
export function exitMspace(app) {
  const vp = app.vp, m = vp.mspace, tab = app.active;
  if (!m) return false;
  if (app.toolId) app.setTool(app.toolId === 'select' ? 'select' : app.toolId);
  commitViewportView(app);
  vp.mspace = null;
  tab.session.doc = spaces(tab).docs[spaces(tab).cur];
  vp.setSession(tab.session, { fit: false, view: { ...m.paperView, width: vp.view.width, height: vp.view.height } });
  app.refreshPanels(); app.refreshStatus();
  return true;
}

/** zoom/pan in MSPACE moved the model view: write it into the viewport (a locked viewport keeps its scale: the paper moves).
 *  Returns true when the VIEWPORT entity changed. */
function syncViewport(vp) {
  const m = vp.mspace;
  if (!m || m.quiet) return false;
  const v = m.vp, mv = vp.view;
  m.paperView = { ...m.paperView, width: mv.width, height: mv.height };
  if (v.locked) {
    const c = viewportToPaper(v, { x: mv.cx, y: mv.cy });
    m.paperView = { ...m.paperView, cx: c.x, cy: c.y, zoom: mv.zoom * viewportScale(v) };
    return false;
  }
  Object.assign(v, viewportFromModelView(m.paperView, v, mv));
  return true;
}

/** a change with no undo step (viewport lock in MSPACE, written straight onto the entity) still makes the drawing dirty;
 *  key 'viewPending': a view change of the active viewport, recorded as one undo step when its view session ends */
function touchDrawing(app, key = 'viewTouched') {
  const s = app.active?.session;
  if (!s || s[key]) return;
  s[key] = true; app.renderTabs();
}

/** End the active viewport's view session (leaving MSPACE, another viewport, undo/redo, save): a changed view becomes
 *  one undo step, so Ctrl+Z restores the view the viewport had when the session began. No-op outside MSPACE. */
export function commitViewportView(app) {
  const m = app.vp.mspace, tab = app.active;
  if (!m || !tab) return false;
  const sp = spaces(tab), pending = tab.session.viewPending;
  const done = recordViewportView(tab.session, m.vp, m.start, sp.docs[sp.cur] ?? tab.session.doc);
  m.start = viewportView(m.vp);
  if (pending && !done) app.renderTabs(); // back to the first view: no step, and no longer changed
  return done;
}

/** VPLOCK: toggle the lock of the active (MSPACE) viewport, or of the selected viewports in paper space */
function vplock(app) {
  const vp = app.vp, m = vp.mspace;
  if (!vp.layout) { toast('VPLOCK works on a layout tab.'); return; }
  if (m) { m.vp.locked = !m.vp.locked; touchDrawing(app); toast(`Viewport display ${m.vp.locked ? 'locked' : 'unlocked'}.`); return; }
  const sel = vp.doc.entities.filter((e) => e.type === 'VIEWPORT' && vp.selection.has(e.id));
  if (!sel.length) { toast('VPLOCK: select one or more viewports first.'); return; }
  setVpLocked(app, sel, !sel.every((e) => e.locked));
}

function setVpLocked(app, vps, lock) {
  app.session.transact('VPLOCK', (tx) => { for (const e of vps) tx.replace({ ...e, locked: lock }); });
}

/** right-click on a viewport border in paper space: "Display locked" toggle */
function viewportMenu(app, ev) {
  const vp = app.vp;
  if (!vp.layout || vp.mspace) return;
  const r = vp.canvas.getBoundingClientRect(), p = screenToWorld(vp.view, ev.clientX - r.left, ev.clientY - r.top), tol = 6 / vp.view.zoom;
  const v = vp.doc.entities.find((e) => {
    if (e.type !== 'VIEWPORT' || isPaperViewport(e) || !(e.width > 0 && e.height > 0)) return false;
    const dx = Math.abs(p.x - e.c.x) - e.width / 2, dy = Math.abs(p.y - e.c.y) - e.height / 2;
    return dx <= tol && dy <= tol && (Math.abs(dx) <= tol || Math.abs(dy) <= tol);
  });
  if (!v) return;
  document.querySelector('.popmenu')?.remove();
  const m = el('div', { class: 'popmenu', style: `left:${ev.clientX}px;top:${ev.clientY}px` },
    el('button', { 'data-act': 'vplock', onclick: () => { m.remove(); setVpLocked(app, [v], !v.locked); } }, `Display locked${v.locked ? ' \u2713' : ''}`));
  m.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.append(m);
  setTimeout(() => document.addEventListener('pointerdown', () => m.remove(), { once: true }), 0);
}

/** ZOOM Extents inside a viewport: fit the model extents in the viewport window */
function zoomViewportExtents(app) {
  const vp = app.vp, m = vp.mspace, v = m.vp, b = vp.scene?.bbox;
  if (!b || v.locked) return;
  const f = fitView(b, v.width, v.height, 0.02);
  Object.assign(v, { viewCenter: { x: f.cx, y: f.cy }, viewHeight: v.height / f.zoom });
  vp.view = modelViewThrough(m.paperView, v); vp.requestRender(); vp.emit('view');
}

/** the viewport a scale change applies to: the active one in MSPACE, else the one selected viewport in paper space */
function scaleTarget(app) {
  const vp = app.vp;
  if (vp.mspace) return vp.mspace.vp;
  if (!vp.layout || vp.selection.size !== 1) return null;
  const v = vp.doc.entities.find((e) => vp.selection.has(e.id));
  return v?.type === 'VIEWPORT' && !isPaperViewport(v) && v.height > 0 ? v : null;
}

/** "1:N" (paper mm : model mm) of viewport `v` on the shown layout */
const printScale = (app, v) => +viewportPrintScale(v, app.vp.layout?.plot ?? { units: 1 }, app.active?.doc.units ?? 0).toPrecision(6);

/** set viewport `v` to `viewHeight` (model units shown over its height), its view centre kept, as ONE undo step.
 *  A locked viewport refuses. In MSPACE a zoom / pan before it is committed as its own step first, and the model view
 *  follows without being written back again. Returns true when the viewport changed. */
function setViewportHeight(app, v, viewHeight) {
  if (!v || !(viewHeight > 0)) return false;
  if (v.locked) { toast('Viewport is locked.'); return false; }
  const vp = app.vp, m = vp.mspace, s = app.active.session;
  if (m && v === m.vp) {
    commitViewportView(app);
    if (v.viewHeight === viewHeight) return false;
    const sp = spaces(app.active), cur = s.doc;
    s.doc = sp.docs[sp.cur]; // the viewport lives in the layout, not in the model doc the session shows in MSPACE
    try { s.transact('Viewport scale', (tx) => tx.props(v, { viewHeight })); } finally { s.doc = cur; }
    m.start = viewportView(v);
    const w = modelViewThrough(m.paperView, v);
    m.quiet = true;
    vp.view = { ...vp.view, cx: w.cx, cy: w.cy, zoom: w.zoom }; vp.requestRender(); vp.emit('view');
    m.quiet = false;
    return true;
  }
  if (v.viewHeight === viewHeight) return false;
  s.transact('Viewport scale', (tx) => tx.replace({ ...v, viewHeight }));
  return true;
}

/** set the active (MSPACE) or the selected viewport to print at 1:n (paper mm : model mm) */
export function setViewportScale(app, n, v = scaleTarget(app)) {
  if (!v || !(n > 0)) return false;
  return setViewportHeight(app, v, viewHeightForScale(v, n, app.vp.layout?.plot ?? { units: 1 }, app.active?.doc.units ?? 0));
}

/** double-click in a layout: inside a viewport enters it, on the paper outside viewports returns to paper space.
 *  Returns true when handled (a double-click inside the active viewport is left to the select tool). */
export function layoutDoubleClick(app, e) {
  const vp = app.vp;
  if (!vp.layout) return false;
  const r = vp.canvas.getBoundingClientRect(), m = vp.mspace;
  const p = screenToWorld(m ? { ...m.paperView, width: vp.view.width, height: vp.view.height } : vp.view, e.clientX - r.left, e.clientY - r.top);
  const v = viewportAt(m ? m.paperScene.doc.entities : vp.doc.entities, p);
  if (m && v === m.vp) return false;
  return v ? enterMspace(app, v) : exitMspace(app);
}

/** status bar: the scale of the active viewport (MSPACE) or of the one selected viewport (paper space), with the
 *  standard scales to pick from; a non-standard scale shows as "Custom 1:n" */
export function renderVpScale(app) {
  let sel = document.getElementById('vpscale');
  if (!sel) {
    sel = el('select', { id: 'vpscale', title: 'Viewport scale', style: 'margin-left:12px' });
    sel.onchange = async () => {
      let n = Number(sel.value);
      if (sel.value === 'custom') {
        const v = scaleTarget(app);
        if (!v) return;
        const inp = el('input', { type: 'number', min: '0.000001', step: 'any', value: String(printScale(app, v)), style: 'width:8em' });
        n = (await modal('Viewport scale', [el('label', {}, 'Scale 1 : ', inp)], [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }])) === 'ok' ? Number(inp.value) : NaN;
      }
      if (n > 0) setViewportScale(app, n);
      renderVpScale(app); app.vp.canvas.focus();
    };
    document.getElementById('units')?.before(sel);
  }
  const v = scaleTarget(app);
  sel.hidden = !v;
  if (!v) return;
  const n = printScale(app, v);
  sel.replaceChildren(...STANDARD_SCALES.map((k) => el('option', { value: String(k), text: `1:${k}` })),
    ...(STANDARD_SCALES.includes(n) ? [] : [el('option', { value: String(n), text: `Custom 1:${n}` })]), el('option', { value: 'custom', text: 'Custom…' }));
  sel.value = String(n);
}

/** MV: a viewport by two corners on the current layout, fitted to the model extents (made at init: tools.js and ui.js import each other) */
const mviewTool = (app) => new (class MViewTool extends Tool {
  activate() { super.activate(); this.a = null; }
  get prompt() { return this.a ? 'MVIEW  opposite corner' : 'MVIEW  first corner of the viewport'; }
  click(p) {
    if (!this.vp.layout) { toast('MV works on a layout tab.'); this.cancel(); return; }
    if (!this.a) { this.a = p; this.vp.lastPoint = p; return; }
    if (Math.abs(p.x - this.a.x) > 1e-9 && Math.abs(p.y - this.a.y) > 1e-9) {
      const model = this.h.active.doc, ids = this.vp.doc.entities.filter((e) => e.type === 'VIEWPORT').map((e) => e.vpId || 0);
      const v = makeViewport(this.a, p, buildScene(model).bbox, Math.max(1, ...ids) + 1);
      v.layer = this.h.state.layer;
      this.add(v);
    }
    this.a = null; this.vp.lastPoint = null;
  }
  key(e) { if (e.key === 'Escape') { if (this.a) { this.a = null; this.vp.lastPoint = null; } else this.cancel(); return true; } return e.key === 'Enter'; }
  draw(c) {
    if (!this.a) return;
    const q = this.vp.cursor;
    c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
    this.poly(c, [this.a, { x: q.x, y: this.a.y }, q, { x: this.a.x, y: q.y }], true);
  }
})(app);

/** Properties rows for a selected VIEWPORT: scale as "1:N", paper mm : model mm as in the status-bar list (keeps the
 *  paper size, changes the model window; one undo step; a locked viewport refuses) */
export function viewportFields(app, e) {
  const fmt = () => `1:${printScale(app, e)}`;
  const inp = el('input', { type: 'text', 'data-prop': 'Scale', value: fmt() });
  inp.onchange = () => {
    const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(inp.value) ?? /^\s*()([\d.]+)\s*$/.exec(inp.value);
    const a = m ? Number(m[1] || 1) : NaN, b = m ? Number(m[2]) : NaN;
    if (!(a > 0 && b > 0) || !setViewportScale(app, b / a, e)) inp.value = fmt();
  };
  return [el('label', {}, 'Scale', inp)];
}

export function initLayouts(app) {
  app.spaceBar = el('div', { id: 'spacebar', role: 'tablist', 'aria-label': 'Model and layouts' });
  document.getElementById('docs').append(app.spaceBar);
  app.tools.mview = mviewTool(app);
  TOOL_ALIASES.mv = TOOL_ALIASES.mview = 'mview';
  const vp = app.vp;
  const ms = () => {
    if (!vp.layout) { toast('MSPACE works on a layout tab.'); return; }
    if (vp.mspace) return;
    const v = vp.doc.entities.find((x) => x.type === 'VIEWPORT' && !isPaperViewport(x) && x.on !== false && x.width > 0 && x.height > 0);
    if (!v) toast('This layout has no viewport to enter.'); else enterMspace(app, v);
  };
  const lo = () => layoutCommand(app);
  app.layoutCommands = { layout: lo, lo, pagesetup: () => (vp.layout ? layoutAction(app, 'pagesetup', vp.layout.name) : toast('PAGESETUP works on a layout tab.')), vplock: () => vplock(app), ms, mspace: ms, ps: () => exitMspace(app), pspace: () => exitMspace(app) };
  /** ZOOM nXP: viewport scale n paper units per model unit, centre kept; a locked viewport keeps its scale */
  app.zoomPaperScale = (k) => {
    const m = vp.mspace;
    if (!m) { toast('nXP works inside a layout viewport (MS).'); return; }
    setViewportHeight(app, m.vp, m.vp.height / k);
  };
  vp.on('view', () => { if (vp.mspace) { if (syncViewport(vp)) touchDrawing(app, 'viewPending'); renderVpScale(app); } });
  // undo/redo in MSPACE that changed the active viewport's view: show the restored view through it
  vp.on('change', (info) => {
    const m = vp.mspace;
    if (!m || info.kind === 'do') return;
    const a = m.start, b = viewportView(m.vp);
    if (a.viewHeight === b.viewHeight && a.viewCenter.x === b.viewCenter.x && a.viewCenter.y === b.viewCenter.y) return;
    const w = modelViewThrough(m.paperView, m.vp);
    m.quiet = true;
    vp.view = { ...vp.view, cx: w.cx, cy: w.cy, zoom: w.zoom }; vp.requestRender(); vp.emit('view');
    m.quiet = false; m.start = b;
  });
  vp.canvas.addEventListener('contextmenu', (e) => viewportMenu(app, e));
  vp.modelScene = (frozen) => {
    const sp = spaces(app.active), key = frozen.join('\u0001');
    let s = sp.scenes.get(key);
    if (!s) sp.scenes.set(key, (s = buildScene(docWithFrozen(app.active.doc, frozen))));
    return s;
  };
  const drop = () => { if (app.active) spaces(app.active).scenes.clear(); };
  vp.on('change', (info) => { if (!info.doc || info.doc === app.active?.doc || info.structure) drop(); });
  vp.on('structure', drop);
  vp.on('change', (info) => { if (info.kind !== 'do') syncSpace(app); }); // undo / redo of a layout action
}
