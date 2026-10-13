// ASH Draw Studio - DRAWORDER (DR), TEXTTOFRONT, HATCHTOBACK (AutoCAD LT): the UI over src/core/draworder.js.
// tools.js passes the Tool / ModifyTool base classes in (no import cycle). Each command is one reorder of the current
// space's entity list, so one undo step; the session change rebuilds the scene in the new order.
import { drawOrder, textToFront, hatchToBack } from '../src/core/draworder.js';

const OPTS = { a: 'above', above: 'above', u: 'under', under: 'under', f: 'front', front: 'front', b: 'back', back: 'back' };

export function createDrawOrderTools(h, { Tool, ModifyTool }) {
  class DrawOrderTool extends ModifyTool {
    constructor(host) { super(host); this.name = 'DRAWORDER'; }
    begin() { this.mode = null; }
    reset() { this.mode = null; }
    get prompt() {
      if (this.phase === 'select') return this.selPrompt;
      if (this.phase === 'ref') return `DRAWORDER  select reference objects (${this.vp.selection.size} selected, Enter = done)`;
      return 'DRAWORDER  Enter object ordering option [Above objects/Under objects/Front/Back] <Back>';
    }
    // the reference objects are picked with the same selector as the objects
    down(p, ev) { if (this.phase === 'ref') this.sel.down(p, ev); else super.down(p, ev); }
    move(p, ev) { if (this.phase === 'ref') this.sel.move(p, ev); else super.move(p, ev); }
    up(p, ev) { if (this.phase === 'ref') { this.sel.up(p, ev); h.refreshPrompt(); return; } super.up(p, ev); }
    text(s) {
      if (this.phase !== 'go') return false;
      const mode = OPTS[String(s).trim().toLowerCase()];
      if (!mode) return false;
      this.choose(mode);
      return true;
    }
    key(e) {
      if (e.key === 'Enter' && this.phase === 'go') { this.choose('back'); return true; }
      if (e.key === 'Enter' && this.phase === 'ref') { this.apply([...this.vp.selection]); return true; }
      return super.key(e);
    }
    choose(mode) {
      this.mode = mode;
      if (mode === 'front' || mode === 'back') { this.apply([]); return; }
      this.phase = 'ref'; this.vp.setSelection([]); h.refreshPrompt();
    }
    apply(refs) {
      if ((this.mode === 'above' || this.mode === 'under') && !refs.length) { this.done(); return; }
      const n = drawOrder(h.session, this.ids, this.mode, refs);
      h.toast(n ? `Draw order: ${n} object(s) moved` : 'Draw order unchanged');
      this.done();
    }
  }
  // immediate commands: run on activation, then back to Select
  class OnceTool extends Tool {
    constructor(host, name, run, verb) { super(host); this.name = name; this.run = run; this.verb = verb; }
    get prompt() { return this.name; }
    activate() {
      super.activate();
      const n = this.run(h.session);
      h.toast(n ? `${this.name}: ${n} object(s) ${this.verb}` : `${this.name}: nothing to move`);
      queueMicrotask(() => h.setTool('select'));
    }
  }
  return {
    draworder: new DrawOrderTool(h),
    texttofront: new OnceTool(h, 'TEXTTOFRONT', textToFront, 'brought to front'),
    hatchtoback: new OnceTool(h, 'HATCHTOBACK', hatchToBack, 'sent to back'),
  };
}
