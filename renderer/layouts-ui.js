// ASH Draw Studio - Model / layout tabs under the canvas, layout (paper space) mode and the MV tool.
// A layout is shown by pointing the tab's Session (and so the Viewport, picking and editing) at a
// "space doc": the drawing seen through the layout's entity list (layers, blocks, ids stay shared).
import { buildScene, docWithFrozen, fitView, screenToWorld, viewportToPaper } from '../src/core/render.js';
import { makeViewport, viewportScale, modelViewThrough, viewportFromModelView, viewportAt, STANDARD_SCALES } from '../src/core/layouts.js';
import { Tool, TOOL_ALIASES } from './tools.js';
import { el, modal, toast } from './ui.js';

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
  tab.session.doc = layout ? (sp.docs[name] ??= spaceDoc(tab.doc, layout)) : tab.doc;
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
    onclick: () => setSpace(app, n),
  })));
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
  const m = vp.mspace;
  const paperView = m ? { ...m.paperView } : { ...vp.view }, paperScene = m ? m.paperScene : vp.scene;
  if (app.toolId) app.setTool(app.toolId === 'select' ? 'select' : app.toolId); // drop a half-done command
  tab.session.doc = tab.doc;
  vp.mspace = { vp: v, paperView, paperScene, zoomExtents: () => zoomViewportExtents(app) };
  vp.setSession(tab.session, { fit: false, view: modelViewThrough(paperView, v) });
  app.refreshPanels(); app.refreshStatus();
  return true;
}

/** back to paper space on the shown layout (no-op outside MSPACE) */
export function exitMspace(app) {
  const vp = app.vp, m = vp.mspace, tab = app.active;
  if (!m) return false;
  if (app.toolId) app.setTool(app.toolId === 'select' ? 'select' : app.toolId);
  vp.mspace = null;
  tab.session.doc = spaces(tab).docs[spaces(tab).cur];
  vp.setSession(tab.session, { fit: false, view: { ...m.paperView, width: vp.view.width, height: vp.view.height } });
  app.refreshPanels(); app.refreshStatus();
  return true;
}

/** zoom/pan in MSPACE moved the model view: write it into the viewport (a locked viewport keeps its scale: the paper moves) */
function syncViewport(vp) {
  const m = vp.mspace;
  if (!m) return;
  const v = m.vp, mv = vp.view;
  m.paperView = { ...m.paperView, width: mv.width, height: mv.height };
  if (v.locked) {
    const c = viewportToPaper(v, { x: mv.cx, y: mv.cy });
    m.paperView = { ...m.paperView, cx: c.x, cy: c.y, zoom: mv.zoom * viewportScale(v) };
  } else Object.assign(v, viewportFromModelView(m.paperView, v, mv));
}

/** ZOOM Extents inside a viewport: fit the model extents in the viewport window */
function zoomViewportExtents(app) {
  const vp = app.vp, m = vp.mspace, v = m.vp, b = vp.scene?.bbox;
  if (!b || v.locked) return;
  const f = fitView(b, v.width, v.height, 0.02);
  Object.assign(v, { viewCenter: { x: f.cx, y: f.cy }, viewHeight: v.height / f.zoom });
  vp.view = modelViewThrough(m.paperView, v); vp.requestRender(); vp.emit('view');
}

/** set the active (or selected) viewport to 1:n, keeping its view centre */
export function setViewportScale(app, n) {
  const m = app.vp.mspace;
  if (!m || !(n > 0)) return;
  m.vp.viewHeight = m.vp.height * n;
  app.vp.view = modelViewThrough(m.paperView, m.vp); app.vp.requestRender(); app.vp.emit('view');
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

/** status bar: the active viewport's scale with the standard scales to pick from (shown in MSPACE only) */
export function renderVpScale(app) {
  let sel = document.getElementById('vpscale');
  if (!sel) {
    sel = el('select', { id: 'vpscale', title: 'Viewport scale', style: 'margin-left:12px' });
    sel.onchange = async () => {
      let n = Number(sel.value);
      if (sel.value === 'custom') {
        const inp = el('input', { type: 'number', min: '0.000001', step: 'any', value: String(+viewportScale(app.vp.mspace.vp).toPrecision(6)), style: 'width:8em' });
        n = (await modal('Viewport scale', [el('label', {}, 'Scale 1 : ', inp)], [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }])) === 'ok' ? Number(inp.value) : NaN;
      }
      if (n > 0) setViewportScale(app, n);
      renderVpScale(app); app.vp.canvas.focus();
    };
    document.getElementById('units')?.before(sel);
  }
  const m = app.vp.mspace;
  sel.hidden = !m;
  if (!m) return;
  const n = +viewportScale(m.vp).toPrecision(6);
  const list = STANDARD_SCALES.includes(n) ? STANDARD_SCALES : [...STANDARD_SCALES, n].sort((a, b) => a - b);
  sel.replaceChildren(...list.map((k) => el('option', { value: String(k), text: `1:${k}` })), el('option', { value: 'custom', text: 'Custom…' }));
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

/** Properties rows for a selected VIEWPORT: scale as "1:N" (keeps the paper size, changes the model window) */
export function viewportFields(e, edit) {
  const fmt = (n) => `1:${+n.toFixed(4)}`;
  const inp = el('input', { type: 'text', 'data-prop': 'Scale', value: fmt(viewportScale(e)) });
  inp.onchange = () => {
    const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(inp.value) ?? /^\s*()([\d.]+)\s*$/.exec(inp.value);
    const a = m ? Number(m[1] || 1) : NaN, b = m ? Number(m[2]) : NaN;
    if (a > 0 && b > 0) edit((c) => { c.viewHeight = (c.height * b) / a; }); else inp.value = fmt(viewportScale(e));
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
    const v = vp.doc.entities.find((x) => x.type === 'VIEWPORT' && x.vpId !== 1 && x.on !== false && x.width > 0 && x.height > 0);
    if (!v) toast('This layout has no viewport to enter.'); else enterMspace(app, v);
  };
  app.layoutCommands = { ms, mspace: ms, ps: () => exitMspace(app), pspace: () => exitMspace(app) };
  vp.on('view', () => { if (vp.mspace) { syncViewport(vp); renderVpScale(app); } });
  vp.modelScene = (frozen) => {
    const sp = spaces(app.active), key = frozen.join('\u0001');
    let s = sp.scenes.get(key);
    if (!s) sp.scenes.set(key, (s = buildScene(docWithFrozen(app.active.doc, frozen))));
    return s;
  };
  const drop = () => { if (app.active) spaces(app.active).scenes.clear(); };
  vp.on('change', (info) => { if (!info.doc || info.doc === app.active?.doc || info.structure) drop(); });
  vp.on('structure', drop);
}
