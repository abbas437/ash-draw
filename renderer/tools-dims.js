// ASH Draw Studio - DIMLINEAR, DIMALIGNED, DIMANGULAR, DIMRADIUS, DIMDIAMETER, DIMCONTINUE, DIMBASELINE and the
// DIMSTYLE manager: the UI over
// src/core/dims.js. Prompts and options follow AutoCAD LT. tools.js owns the Tool base class and passes it to
// createDimTools (a factory, so this module does not import tools.js back).
import { getEntity } from '../src/core/model.js';
import { tessellate, dist } from '../src/core/geom.js';
import { buildDimension, rebuildDimension, continueDimension, baselineDimension } from '../src/core/dims.js';
import { ensureDimStyle, resolveDimStyle } from '../src/core/dimsStyle.js';
import { setDimStyle } from '../src/core/edit.js';
import { el, modal, promptDialog, toast } from './ui.js';

const num = (s) => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) && String(s).trim() !== '' ? v : null; };
const opt = (s) => String(s).trim().toLowerCase();
const between = (v, a, b) => v > Math.min(a, b) && v < Math.max(a, b);

// Per drawing: the current dimension style (header $DIMSTYLE, ISO-25 until set) and the last dimension placed
// (for DIMCONTINUE / DIMBASELINE).
const dimVars = new WeakMap();
export function dimVarsOf(doc) {
  let v = dimVars.get(doc);
  if (!v) {
    dimVars.set(doc, (v = {
      lastId: null,
      get style() { return doc.header.currentDimStyle || 'ISO-25'; },
      set style(name) { doc.header.currentDimStyle = name; },
    }));
  }
  return v;
}

/** style names for the list: the drawing's styles, then ISO-25 and Standard, then the current one (no duplicates) */
export function dimStyleNames(doc) {
  const out = [];
  for (const n of [...(doc.dimStyles?.keys() ?? []), 'ISO-25', 'Standard', dimVarsOf(doc).style]) if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}
export function setCurrentDimStyle(doc, name) { dimVarsOf(doc).style = name; }

const ARROWS = [['', 'Closed filled'], ['_ARCHTICK', 'Architectural tick'], ['_DOT', 'Dot'], ['_OPEN', 'Open']];
const LUNITS = [[2, 'Decimal'], [3, 'Engineering'], [4, 'Architectural']];
// [variable, label, check] for the numeric fields of the Modify dialog
const NUMS = [
  ['DIMTXT', 'Text height', (v) => v > 0], ['DIMASZ', 'Arrow size', (v) => v >= 0], ['DIMEXO', 'Extension line offset', (v) => v >= 0],
  ['DIMEXE', 'Extend beyond dimension line', (v) => v >= 0], ['DIMGAP', 'Text gap', (v) => v >= 0],
  ['DIMDEC', 'Decimal places', (v) => Number.isInteger(v) && v >= 0 && v <= 8], ['DIMSCALE', 'Overall scale', (v) => v > 0],
  ['DIMLFAC', 'Linear scale factor', (v) => v !== 0],
];

// a closed <dialog> fires 'close' in a later task: let it pass before the shared dialog is reused, or it would
// resolve the next modal with null
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Modify / New dialog: resolves with the edited style, or null (Cancel or an invalid value, which is reported) */
async function editStyleDialog(title, st) {
  const row = (label, input) => el('label', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin:4px 0' }, label, input);
  const sel = (name, pairs, value) => {
    const all = pairs.some(([v]) => v === value) ? pairs : [...pairs, [value, String(value)]];
    const s = el('select', { name }, all.map(([v, t]) => el('option', { value: String(v), text: t })));
    s.value = String(value); return s;
  };
  const inp = {};
  for (const [k] of NUMS) inp[k] = el('input', { type: 'text', name: k, value: String(st[k]), size: 8 });
  inp.DIMBLK = sel('DIMBLK', ARROWS, st.DIMBLK || '');
  inp.DIMTAD = sel('DIMTAD', [[1, 'Above the line'], [0, 'Centred']], st.DIMTAD);
  inp.DIMDSEP = sel('DIMDSEP', [[46, '. (period)'], [44, ', (comma)']], st.DIMDSEP);
  inp.DIMLUNIT = sel('DIMLUNIT', LUNITS, st.DIMLUNIT);
  inp.DIMZIN = el('input', { type: 'checkbox', name: 'DIMZIN' }); inp.DIMZIN.checked = !!(st.DIMZIN & 8);
  const post = String(st.DIMPOST || ''), [pre, suf] = post.includes('<>') ? post.split('<>') : ['', post];
  inp.prefix = el('input', { type: 'text', name: 'prefix', value: pre, size: 8 });
  inp.suffix = el('input', { type: 'text', name: 'suffix', value: suf, size: 8 });
  const label = Object.fromEntries(NUMS.map(([k, l]) => [k, l]));
  const body = [
    ...['DIMTXT', 'DIMGAP'].map((k) => row(label[k], inp[k])), row('Text placement', inp.DIMTAD),
    row('Arrowhead', inp.DIMBLK), ...['DIMASZ', 'DIMEXO', 'DIMEXE'].map((k) => row(label[k], inp[k])),
    row('Units', inp.DIMLUNIT), row(label.DIMDEC, inp.DIMDEC), row('Decimal separator', inp.DIMDSEP), row('Suppress trailing zeros', inp.DIMZIN),
    row('Prefix', inp.prefix), row('Suffix', inp.suffix), row(label.DIMSCALE, inp.DIMSCALE), row(label.DIMLFAC, inp.DIMLFAC),
  ];
  await settle();
  if (await modal(title, body, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]) !== 'ok') return null;
  const out = { ...st };
  for (const [k, l, ok] of NUMS) {
    const v = num(inp[k].value);
    if (v === null || !ok(v)) { toast(`${l}: "${inp[k].value}" is not a valid value; the style was not changed.`); return null; }
    out[k] = v;
  }
  out.DIMBLK = inp.DIMBLK.value;
  for (const k of ['DIMTAD', 'DIMDSEP', 'DIMLUNIT']) out[k] = Number(inp[k].value);
  out.DIMZIN = (st.DIMZIN & ~8) | (inp.DIMZIN.checked ? 8 : 0);
  out.DIMPOST = inp.prefix.value ? `${inp.prefix.value}<>${inp.suffix.value}` : inp.suffix.value;
  return out;
}

/** DIMSTYLE: list the styles, set the current one, create (copy of the selected) and modify. h = app host. */
export async function dimStyleManager(h) {
  let pick = dimVarsOf(h.doc).style;
  for (;;) {
    const doc = h.doc, names = dimStyleNames(doc), cur = dimVarsOf(doc).style;
    const list = el('select', { name: 'styles', size: Math.min(8, Math.max(4, names.length)), style: 'width:100%' },
      names.map((n) => el('option', { value: n, text: n.toLowerCase() === cur.toLowerCase() ? `${n}  (current)` : n })));
    list.value = names.find((n) => n.toLowerCase() === pick.toLowerCase()) ?? cur;
    await settle();
    const act = await modal('Dimension Style Manager', [el('p', { text: `Current dimension style: ${cur}` }), list],
      [{ label: 'Set current', value: 'current', primary: true }, { label: 'New…', value: 'new' }, { label: 'Modify…', value: 'modify' }, { label: 'Close', value: null }]);
    if (!act) break;
    pick = list.value || cur;
    if (act === 'current') { setCurrentDimStyle(doc, pick); continue; }
    const base = resolveDimStyle(doc, pick);
    let name = base.name;
    if (act === 'new') {
      await settle();
      const n = (await promptDialog(`New dimension style (copy of ${base.name})`, `Copy of ${base.name}`))?.trim();
      if (!n) continue;
      if (names.some((x) => x.toLowerCase() === n.toLowerCase())) { toast(`A dimension style named "${n}" already exists.`); continue; }
      name = n;
    }
    const st = await editStyleDialog(act === 'new' ? `New dimension style: ${name}` : `Modify dimension style: ${name}`, base);
    if (st) { setDimStyle(h.session, name, st); pick = name; }
  }
  return dimVarsOf(h.doc).style;
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

  // ---- DIMANGULAR: two lines, an arc, a circle (centre + two points) or Enter = vertex and two points -----------
  class DimAngularTool extends DimTool {
    constructor(host) { super(host); this.name = 'DIMANGULAR'; }
    activate() { super.activate(); this.l1 = null; this.l2 = null; this.arc = null; this.three = null; this.vertex = null; this.q1 = null; this.q2 = null; }
    get ready() { return !!(this.l2 || this.arc || this.q2); }
    get prompt() {
      const n = this.name;
      if (this.ready) return `${n}  dimension arc line location`;
      if (this.l1) return `${n}  select second line`;
      if (this.three) return `${n}  ${!this.vertex ? 'angle vertex' : !this.q1 ? 'first angle endpoint' : 'second angle endpoint'}`;
      return `${n}  select arc, circle, line or <specify vertex>`;
    }
    def(at) {
      if (this.l2) return { kind: 'angular', l1: this.l1, l2: this.l2, at };
      if (this.q2) return { kind: 'angular3', vertex: this.vertex, p1: this.q1, p2: this.q2, at };
      if (!this.arc) return null;
      // an arc measures its own angle: keep `at` inside the arc's sector
      const { c, a0, a1 } = this.arc, r = dist(c, at) || 1, sw = ((a1 - a0) % 360 + 360) % 360;
      const t = ((Math.atan2(at.y - c.y, at.x - c.x) * 180 / Math.PI - a0) % 360 + 360) % 360;
      const a = (t <= sw ? a0 + t : a0 + sw / 2) * Math.PI / 180;
      const P = (d) => ({ x: c.x + this.arc.r * Math.cos(d * Math.PI / 180), y: c.y + this.arc.r * Math.sin(d * Math.PI / 180) });
      return { kind: 'angular3', vertex: { ...c }, p1: P(a0), p2: P(a1), at: { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) } };
    }
    click(p, ev) {
      if (this.ready) { try { buildDimension(this.def(p), this.style); } catch (err) { this.h.toast(err.message); return; } this.place(this.def(p)); this.h.setTool('select'); return; }
      if (this.three) {
        if (!this.vertex) { this.vertex = p; this.vp.lastPoint = p; return; }
        if (dist(this.vertex, p) < 1e-9) return;
        if (!this.q1) { this.q1 = p; return; }
        this.q2 = p; this.vp.lastPoint = null; return;
      }
      const hit = this.vp.pick(ev?.raw ?? p), e = hit && getEntity(this.vp.doc, hit.id);
      if (this.l1) {
        if (!e || e.type !== 'LINE') { this.h.toast('Select a line.'); return; }
        const l2 = [{ ...e.p1 }, { ...e.p2 }];
        const d1 = { x: this.l1[1].x - this.l1[0].x, y: this.l1[1].y - this.l1[0].y }, d2 = { x: l2[1].x - l2[0].x, y: l2[1].y - l2[0].y };
        if (Math.abs(d1.x * d2.y - d1.y * d2.x) <= 1e-9 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) { this.h.toast('The lines are parallel; select a line at an angle to the first.'); return; }
        this.l2 = l2; return;
      }
      if (e?.type === 'LINE') { this.l1 = [{ ...e.p1 }, { ...e.p2 }]; return; }
      if (e?.type === 'ARC') { this.arc = { c: { ...e.c }, r: e.r, a0: e.a0, a1: e.a1 }; return; }
      if (e?.type === 'CIRCLE') { // the picked point is the first endpoint, as in AutoCAD
        const d = dist(e.c, p) || 1;
        this.three = true; this.vertex = { ...e.c }; this.q1 = { x: e.c.x + (p.x - e.c.x) * e.r / d, y: e.c.y + (p.y - e.c.y) * e.r / d }; return;
      }
      this.h.toast('Select an arc, circle or line, or press Enter to specify the vertex.');
    }
    key(e) {
      if (e.key === 'Enter' && !this.l1 && !this.arc && !this.three) { this.three = true; return true; }
      return super.key(e);
    }
    draw(c) {
      if (this.ready) { this.drawDef(c, this.def(this.vp.cursor)); return; }
      const from = this.three ? (this.q1 ? this.vertex : null) : null;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
      if (from) { this.line(c, from, this.q1); this.line(c, from, this.vp.cursor); }
      else if (this.three && this.vertex) this.line(c, this.vertex, this.vp.cursor);
    }
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
    dimangular: new DimAngularTool(h),
    dimradius: new DimRadialTool(h, 'radius'), dimdiameter: new DimRadialTool(h, 'diameter'),
    dimcontinue: new DimChainTool(h, 'continue'), dimbaseline: new DimChainTool(h, 'baseline'),
  };
}
