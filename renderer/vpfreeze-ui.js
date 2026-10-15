// ASH Draw Studio - freeze a layer in one viewport only: the Layers panel "VP" column and the VPLAYER command.
// The UI over src/core/vpfreeze.js; every change is one undo step on the layout space the viewports live in.
import { isPaperViewport } from '../src/core/layouts.js';
import { screenToWorld } from '../src/core/render.js';
import { vpFrozen, layoutViewports, matchLayerNames, setVpFreeze, resetVpFreeze } from '../src/core/vpfreeze.js';
import { Tool, TOOL_ALIASES } from './tools.js';
import { el, toast, renderLayers } from './ui.js';

/** the layout space doc the shown layout's viewports live in (the session shows the model doc in MSPACE) */
const layoutSpace = (app) => { const sp = app.active?.spaces; return sp?.docs[sp.cur] ?? null; };

/** the viewport the VP column works on: the active one in MSPACE, else the one selected viewport in paper space */
export function vpFreezeTarget(app) {
  const vp = app.vp;
  if (!vp.layout) return null;
  if (vp.mspace) return vp.mspace.vp;
  if (vp.selection.size !== 1) return null;
  const v = vp.doc.entities.find((e) => vp.selection.has(e.id));
  return v?.type === 'VIEWPORT' && !isPaperViewport(v) ? v : null;
}

/** freeze or thaw layer `name` in viewport `v` (one undo step); the viewport redraws through the change event */
export function toggleVpFreeze(app, v, name) {
  const space = layoutSpace(app);
  if (!space) return 0;
  return setVpFreeze(app.active.session, [v], [name], !vpFrozen(v, name), space);
}

/** VPLAYER (AutoCAD LT prompts): Freeze / Thaw / Reset, layer list (comma, * and ? wildcards), then the viewports:
 *  Current (the active / selected one), All (every viewport of the shown layout) or Select (click viewport borders) */
const vplayerTool = (app) => new (class VplayerTool extends Tool {
  get tracks() { return false; }
  activate() {
    super.activate();
    Object.assign(this, { step: 'option', mode: null, names: [], picked: [] });
    if (!this.vp.layout) { toast('VPLAYER works on a layout tab.'); this.cancel(); }
  }
  get prompt() {
    const verb = { freeze: 'freeze', thaw: 'thaw', reset: 'reset' }[this.mode];
    switch (this.step) {
      case 'layers': return `VPLAYER  Enter layer name(s) to ${verb} (comma list, * wildcard):`;
      case 'where': return 'VPLAYER  Apply to [All viewports/Select viewports/Current viewport] <Current>:';
      case 'select': return `VPLAYER  Select viewports (${this.picked.length} selected, Enter = done):`;
      default: return 'VPLAYER  Enter an option [Freeze/Thaw/Reset]:';
    }
  }
  text(s) {
    const t = s.trim(), lo = t.toLowerCase();
    if (this.step === 'option') {
      const mode = { f: 'freeze', freeze: 'freeze', t: 'thaw', thaw: 'thaw', r: 'reset', reset: 'reset' }[lo];
      if (!mode) return false;
      this.mode = mode; this.step = 'layers'; return true;
    }
    if (this.step === 'layers') {
      if (!t) return false;
      const { names, missing } = matchLayerNames(app.active.doc, t);
      if (missing.length) toast(`VPLAYER: no layer named ${missing.join(', ')}.`);
      if (!names.length) return true;
      this.names = names; this.step = 'where'; return true;
    }
    if (this.step === 'where') {
      if (lo === 'a' || lo === 'all' || lo === 'all viewports') { this.apply(layoutViewports(layoutSpace(app)?.entities ?? [])); return true; }
      if (lo === 's' || lo === 'select' || lo === 'select viewports') { this.step = 'select'; return true; }
      if (lo === '' || lo === 'c' || lo === 'current' || lo === 'current viewport') {
        const v = vpFreezeTarget(app);
        if (!v) { toast('VPLAYER: there is no current viewport; enter MSPACE in one, select one, or use All / Select.'); return true; }
        this.apply([v]); return true;
      }
      return false;
    }
    return false;
  }
  click(p) {
    if (this.step !== 'select') return;
    const vp = this.vp, m = vp.mspace, sc = vp.toScreen(p);
    // in MSPACE the click is in model coordinates: the same screen point in the paper view
    const q = m ? screenToWorld({ ...m.paperView, width: vp.view.width, height: vp.view.height }, sc.x, sc.y) : p;
    const v = layoutViewports(layoutSpace(app)?.entities ?? []).find((e) => Math.abs(q.x - e.c.x) <= e.width / 2 && Math.abs(q.y - e.c.y) <= e.height / 2);
    if (v && !this.picked.includes(v)) this.picked.push(v);
    this.h.refreshPrompt();
  }
  key(e) {
    if (e.key === 'Enter') {
      if (this.step === 'select') { if (this.picked.length) this.apply(this.picked); else this.cancel(); }
      else if (!this.text('')) this.cancel();
      this.h.refreshPrompt();
      return true;
    }
    return super.key(e);
  }
  apply(vps) {
    const space = layoutSpace(app), s = app.active.session;
    const n = this.mode === 'reset' ? resetVpFreeze(s, vps, this.names, space) : setVpFreeze(s, vps, this.names, this.mode === 'freeze', space);
    toast(`VPLAYER: ${this.names.join(', ')} ${this.mode === 'freeze' ? 'frozen' : 'thawed'} in ${n} viewport${n === 1 ? '' : 's'}.`, 2500);
    const cur = app.state.layer;
    if (this.mode === 'freeze' && this.names.includes(cur) && vps.includes(vpFreezeTarget(app))) {
      toast(`The current layer ${cur} is frozen in this viewport; new objects on it won't show here.`, 4000);
    }
    this.cancel();
  }
})(app);

/** wire the VP column and VPLAYER into the app (called from initLayouts) */
export function initVpFreeze(app) {
  app.tools.vplayer = vplayerTool(app);
  TOOL_ALIASES.vplayer = 'vplayer';
  /** the Layers panel's VP freeze button for layer `l`, or null when no viewport is current (model space, Model tab) */
  app.layerVpButton = (l) => {
    const v = vpFreezeTarget(app);
    if (!v) return null;
    const on = vpFrozen(v, l.name);
    return el('button', { class: 'icon lay-vpfrz', title: on ? 'Thaw in this viewport' : 'Freeze in this viewport', onclick: () => toggleVpFreeze(app, v, l.name) }, on ? '❄' : '☀');
  };
  // selecting a viewport in paper space only refreshes the Properties panel: show or hide the VP column
  let shown = null;
  app.vp.on('selection', () => { const v = vpFreezeTarget(app); if (v !== shown) { shown = v; renderLayers(app); } });
}
