// ASH Draw Studio - DIMLINEAR, DIMALIGNED, DIMRADIUS, DIMDIAMETER, DIMCONTINUE and DIMBASELINE: the UI over
// src/core/dims.js. Prompts and options follow AutoCAD LT. tools.js owns the Tool base class and passes it to
// createDimTools (a factory, so this module does not import tools.js back).
import { getEntity } from '../src/core/model.js';
import { tessellate, dist } from '../src/core/geom.js';
import { buildDimension, rebuildDimension, continueDimension, baselineDimension } from '../src/core/dims.js';
import { ensureDimStyle, resolveDimStyle } from '../src/core/dimsStyle.js';

const num = (s) => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) && String(s).trim() !== '' ? v : null; };
const opt = (s) => String(s).trim().toLowerCase();
const between = (v, a, b) => v > Math.min(a, b) && v < Math.max(a, b);

// Per drawing: the current dimension style (DIMSTYLE) and the last dimension placed (for DIMCONTINUE / DIMBASELINE).
const dimVars = new WeakMap();
export function dimVarsOf(doc) {
  let v = dimVars.get(doc);
  if (!v) dimVars.set(doc, (v = { style: 'ISO-25', lastId: null }));
  return v;
}

/** linear angle from the cursor, like AutoCAD: horizontal when dragged above/below, vertical when dragged aside */
export function linearAngleFor(p1, p2, c) {
  const inX = between(c.x, p1.x, p2.x), inY = between(c.y, p1.y, p2.y);
  if (inX && !inY) return 0;
  if (inY && !inX) return 90;
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  return Math.abs(c.y - mid.y) >= Math.abs(c.x - mid.x) ? 0 : 90;
}

export function createDimTools(h, { Tool }) {
  class DimTool extends Tool {
    get vars() { return dimVarsOf(this.vp.doc); }
    get style() { return resolveDimStyle(this.vp.doc, this.vars.style); }
    /** add the dimension for `def` on the current layer as one undo step */
    place(def) {
      const doc = this.vp.doc, st = ensureDimStyle(doc, this.vars.style);
      const tpl = { id: 0, type: 'DIMENSION', linetype: 'BYLAYER', lineweight: -1, ...this.props(), ltscale: 1, block: '', dimType: 0, p: null, text: '', style: st.name };
      const e = this.add(rebuildDimension(doc, tpl, def, st));
      this.vars.lastId = e.id;
      return e;
    }
    drawDef(c, def) {
      if (!def) return;
      let r; try { r = buildDimension(def, this.style); } catch { return; }
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); c.lineWidth = 1;
      for (const e of r.entities) for (const pl of tessellate(e, this.vp.doc, this.vp.tolWorld / 4)) this.poly(c, pl);
      if (r.text) this.dyn(c, r.text, r.textMid);
    }
  }

  // ---- DIMLINEAR / DIMALIGNED -------------------------------------------------------------------
  class DimLinearTool extends DimTool {
    constructor(host, kind) { super(host); this.kind = kind; this.name = kind === 'linear' ? 'DIMLINEAR' : 'DIMALIGNED'; }
    activate() { super.activate(); this.p1 = null; this.p2 = null; this.pickObj = false; this.angle = null; this.askAngle = false; }
    get prompt() {
      const n = this.name;
      if (this.askAngle) return `${n}  angle of dimension line <0>`;
      if (this.pickObj) return `${n}  select object to dimension`;
      if (!this.p1) return `${n}  first extension line origin or <select object>`;
      if (!this.p2) return `${n}  second extension line origin`;
      return `${n}  dimension line location${this.kind === 'linear' ? ' or [Rotated]' : ''}`;
    }
    def(at) {
      if (!this.p1 || !this.p2) return null;
      if (this.kind === 'aligned') return { kind: 'aligned', p1: this.p1, p2: this.p2, at };
      return { kind: 'linear', p1: this.p1, p2: this.p2, at, angle: this.angle ?? linearAngleFor(this.p1, this.p2, at) };
    }
    click(p, ev) {
      if (this.askAngle) return;
      if (this.pickObj) {
        const hit = this.vp.pick(ev?.raw ?? p), e = hit && getEntity(this.vp.doc, hit.id);
        if (!e || e.type !== 'LINE') { this.h.toast('Select a line.'); return; }
        this.p1 = { ...e.p1 }; this.p2 = { ...e.p2 }; this.pickObj = false; this.vp.lastPoint = null; return;
      }
      if (!this.p1) { this.p1 = p; this.vp.lastPoint = p; return; }
      if (!this.p2) { if (dist(this.p1, p) < 1e-9) return; this.p2 = p; this.vp.lastPoint = null; return; }
      this.place(this.def(p));
      this.h.setTool('select');
    }
    text(s) {
      if (this.askAngle) { const a = num(s); if (a === null) return true; this.angle = a; this.askAngle = false; return true; }
      if (this.p2 && this.kind === 'linear' && opt(s) === 'r') { this.askAngle = true; return true; }
      return false;
    }
    key(e) {
      if (e.key === 'Enter' && !this.p1 && !this.pickObj) { this.pickObj = true; return true; }
      if (e.key === 'Enter' && this.askAngle) { this.angle = 0; this.askAngle = false; return true; }
      return super.key(e);
    }
    draw(c) {
      if (this.p2) { this.drawDef(c, this.def(this.vp.cursor)); return; }
      if (this.p1) { c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); this.line(c, this.p1, this.vp.cursor); }
    }
  }

  // ---- DIMRADIUS / DIMDIAMETER -----------------------------------------------------------------
  class DimRadialTool extends DimTool {
    constructor(host, kind) { super(host); this.kind = kind; this.name = kind === 'radius' ? 'DIMRADIUS' : 'DIMDIAMETER'; }
    activate() { super.activate(); this.circ = null; }
    get prompt() { return this.circ ? `${this.name}  dimension line location` : `${this.name}  select arc or circle`; }
    def(at) {
      const { c, r } = this.circ, d = dist(c, at);
      const u = d > 1e-9 ? { x: (at.x - c.x) / d, y: (at.y - c.y) / d } : { x: 1, y: 0 };
      return { kind: this.kind, center: { ...c }, p: { x: c.x + u.x * r, y: c.y + u.y * r } };
    }
    click(p, ev) {
      if (!this.circ) {
        const hit = this.vp.pick(ev?.raw ?? p), e = hit && getEntity(this.vp.doc, hit.id);
        if (!e || (e.type !== 'CIRCLE' && e.type !== 'ARC')) { this.h.toast('Select an arc or a circle.'); return; }
        this.circ = { c: { ...e.c }, r: e.r }; return;
      }
      this.place(this.def(p));
      this.h.setTool('select');
    }
    draw(c) { if (this.circ) this.drawDef(c, this.def(this.vp.cursor)); }
  }

  // ---- DIMCONTINUE / DIMBASELINE ---------------------------------------------------------------
  class DimChainTool extends DimTool {
    constructor(host, mode) { super(host); this.mode = mode; this.name = mode === 'continue' ? 'DIMCONTINUE' : 'DIMBASELINE'; }
    activate() {
      super.activate();
      const e = this.vars.lastId && getEntity(this.vp.doc, this.vars.lastId);
      this.prev = e && this.usable(e) ? e.def : null;
    }
    usable(e) { return e.type === 'DIMENSION' && e.def && ['linear', 'aligned', 'angular3'].includes(e.def.kind); }
    get prompt() { return this.prev ? `${this.name}  second extension line origin (Enter = done)` : `${this.name}  select ${this.mode === 'continue' ? 'continued' : 'base'} dimension`; }
    next(p) { return this.mode === 'continue' ? continueDimension(this.prev, p) : baselineDimension(this.prev, p, this.style); }
    click(p, ev) {
      if (!this.prev) {
        const hit = this.vp.pick(ev?.raw ?? p), e = hit && getEntity(this.vp.doc, hit.id);
        if (!e || !this.usable(e)) { this.h.toast('Select a linear, aligned or angular dimension.'); return; }
        this.prev = e.def; return;
      }
      const def = this.next(p);
      if (!def) return;
      this.prev = this.place(def).def;
    }
    key(e) { if (e.key === 'Enter') { this.h.setTool('select'); return true; } return super.key(e); }
    draw(c) { if (this.prev) this.drawDef(c, this.next(this.vp.cursor)); }
  }

  return {
    dimlinear: new DimLinearTool(h, 'linear'), dimaligned: new DimLinearTool(h, 'aligned'),
    dimradius: new DimRadialTool(h, 'radius'), dimdiameter: new DimRadialTool(h, 'diameter'),
    dimcontinue: new DimChainTool(h, 'continue'), dimbaseline: new DimChainTool(h, 'baseline'),
  };
}
