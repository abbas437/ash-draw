// ASH Draw Studio - Model / layout tabs under the canvas, layout (paper space) mode and the MV tool.
// A layout is shown by pointing the tab's Session (and so the Viewport, picking and editing) at a
// "space doc": the drawing seen through the layout's entity list (layers, blocks, ids stay shared).
import { buildScene, docWithFrozen } from '../src/core/render.js';
import { makeViewport, viewportScale } from '../src/core/layouts.js';
import { Tool, TOOL_ALIASES } from './tools.js';
import { el, toast } from './ui.js';

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
