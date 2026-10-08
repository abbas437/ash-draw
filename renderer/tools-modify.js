// ASH Draw Studio - FILLET, CHAMFER, BREAK, JOIN, LENGTHEN, STRETCH and ARRAY tools: the UI over src/core/modify.js.
// Prompts and options follow AutoCAD LT. tools.js owns the Tool / ModifyTool base classes and passes them to
// createModifyTools (a factory, so this module does not import tools.js back).
import { applyEditSet } from '../src/core/edit.js';
import { getEntity } from '../src/core/model.js';
import { tessellate, bboxOf, unionBox, dist, ccwSweep, DEG } from '../src/core/geom.js';
import {
  fillet, filletPolyline, chamfer, chamferPolyline, breakAt, breakBetween, join, lengthen, stretch, arrayRect, arrayPolar, arrayPath,
} from '../src/core/modify.js';
import { el, modal } from './ui.js';

const num = (s) => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) && String(s).trim() !== '' ? v : null; };
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(4)).replace(/\.?0+$/, '');
const opt = (s) => String(s).trim().toLowerCase();

// Per-drawing settings, like AutoCAD's FILLETRAD / CHAMFERA / CHAMFERB / CHAMFERC system variables.
const drawingVars = new WeakMap();
function vars(doc) {
  let v = drawingVars.get(doc);
  if (!v) drawingVars.set(doc, (v = { filletRad: 0, chamA: 0, chamB: 0, chamAng: 45, chamMethod: 'distance' }));
  return v;
}
let trimMode = true; // TRIMMODE: shared by FILLET and CHAMFER

/** Run an engine command and apply its edit set as one undo step; engine failures become toasts. */
function apply(h, label, fn) {
  let set;
  try { set = fn(); } catch (err) { if (!err.code) throw err; h.toast(`${label}: ${err.message}`); return null; }
  applyEditSet(h.session, label, set);
  return set;
}
/** The same computation for a preview: null when the engine has no answer. */
function quiet(fn) { try { return fn(); } catch { return null; } }

/** Dashed preview of the entities an edit set adds or changes. */
function drawSet(vp, c, set) {
  if (!set) return;
  c.strokeStyle = vp.inkColor; c.setLineDash([4, 3]); c.lineWidth = 1;
  for (const e of [...(set.change || []), ...(set.add || [])].slice(0, 400)) {
    let pls; try { pls = tessellate(e, vp.doc, vp.tolWorld / 4); } catch { continue; }
    for (const pl of pls) {
      c.beginPath();
      pl.forEach((q, i) => { const s = vp.toScreen(q); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
      c.stroke();
    }
  }
}

/** Small parameter dialog. fields: [key, label, value, kind] with kind 'num' | 'opt' (blank allowed) | 'bool'.
 *  onChange(values) runs while typing (for the live preview). Resolves with the values, or null on Cancel. */
async function paramsDialog(title, fields, onChange) {
  const inputs = {};
  const read = () => Object.fromEntries(fields.map(([k, , , kind]) => [k, kind === 'bool' ? inputs[k].checked : num(inputs[k].value)]));
  const valid = (v) => fields.every(([k, , , kind]) => kind !== 'num' || v[k] !== null);
  const changed = () => { const v = read(); if (valid(v)) onChange(v); };
  const body = fields.map(([k, label, value, kind]) => {
    const inp = kind === 'bool' ? el('input', { type: 'checkbox', name: k }) : el('input', { type: 'text', name: k, value: value == null ? '' : String(value), size: 8 });
    if (kind === 'bool') inp.checked = !!value;
    inp.addEventListener('input', changed);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.querySelector('#dlg button.primary')?.click(); } });
    inputs[k] = inp;
    return el('label', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin:4px 0' }, label, inp);
  });
  changed();
  const r = await modal(title, body, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  if (r !== 'ok') return null;
  const v = read();
  return valid(v) ? v : null;
}

const lengthText = (e) => {
  if (e.type === 'LINE') return `Current length: ${fmt(dist(e.p1, e.p2))}`;
  if (e.type === 'ARC') { const sw = ccwSweep(e.a0 * DEG, e.a1 * DEG); return `Current length: ${fmt(e.r * sw)}, included angle: ${fmt(sw / DEG)}°`; }
  return `${e.type}: LENGTHEN works on lines and arcs.`;
};

export function createModifyTools(h, { Tool, ModifyTool }) {
  const ent = (vp, id) => getEntity(vp.doc, id);

  // ---- FILLET / CHAMFER ------------------------------------------------------------------------
  class CornerTool extends Tool {
    constructor(host, kind) { super(host); this.kind = kind; this.name = kind === 'fillet' ? 'FILLET' : 'CHAMFER'; this.multi = false; }
    activate() { super.activate(); this.first = null; this.ask = null; this.poly = false; this.vp.setSelection([]); }
    get v() { return vars(this.vp.doc); }
    get settings() {
      const v = this.v, t = trimMode ? 'Trim' : 'No trim', m = this.multi ? ', Multiple' : '';
      if (this.kind === 'fillet') return `radius ${fmt(v.filletRad)}, ${t}${m}`;
      return (v.chamMethod === 'angle' ? `length ${fmt(v.chamA)}, angle ${fmt(v.chamAng)}°` : `distances ${fmt(v.chamA)}, ${fmt(v.chamB)}`) + `, ${t}${m}`;
    }
    get prompt() {
      const n = this.name, v = this.v;
      switch (this.ask) {
        case 'radius': return `${n}  fillet radius <${fmt(v.filletRad)}>`;
        case 'd1': return `${n}  first chamfer distance <${fmt(v.chamA)}>`;
        case 'd2': return `${n}  second chamfer distance <${fmt(v.chamB)}>`;
        case 'len': return `${n}  chamfer length on the first line <${fmt(v.chamA)}>`;
        case 'ang': return `${n}  chamfer angle from the first line <${fmt(v.chamAng)}>`;
        default:
      }
      if (this.poly) return `${n}  (${this.settings})  select 2D polyline`;
      if (this.first) return `${n}  select second object`;
      return `${n}  (${this.settings})  select first object or [${this.kind === 'fillet' ? 'Radius' : 'Distance/Angle'}/Trim/Polyline/Multiple]`;
    }
    text(s) {
      const v = this.v, x = num(s), o = opt(s);
      if (this.ask) {
        if (x === null || x < 0 || (this.ask === 'ang' && x >= 90)) { this.h.toast(this.ask === 'ang' ? 'Enter an angle from 0 to 90.' : 'Enter a value of 0 or more.'); return true; }
        if (this.ask === 'radius') { v.filletRad = x; this.ask = null; } else if (this.ask === 'd1') { v.chamA = x; v.chamB = x; v.chamMethod = 'distance'; this.ask = 'd2'; } else if (this.ask === 'd2') { v.chamB = x; this.ask = null; } else if (this.ask === 'len') { v.chamA = x; v.chamMethod = 'angle'; this.ask = 'ang'; } else { v.chamAng = x; this.ask = null; }
        return true;
      }
      if (this.kind === 'fillet' && o === 'r') this.ask = 'radius';
      else if (this.kind === 'chamfer' && o === 'd') this.ask = 'd1';
      else if (this.kind === 'chamfer' && o === 'a') this.ask = 'len';
      else if (o === 't' || o === 'n') trimMode = o === 'n' ? false : !trimMode;
      else if (o === 'p') { this.poly = true; this.first = null; this.vp.setSelection([]); } else if (o === 'm') this.multi = !this.multi;
      else return false;
      return true;
    }
    chamOpts() { const v = this.v; return v.chamMethod === 'angle' ? { d1: v.chamA, angle: v.chamAng } : { d1: v.chamA, d2: v.chamB }; }
    corner(e1, p1, e2, p2) {
      return this.kind === 'fillet' ? fillet(e1, p1, e2, p2, this.v.filletRad, { trim: trimMode }) : chamfer(e1, p1, e2, p2, this.chamOpts(), { trim: trimMode });
    }
    click(p, ev) {
      if (this.ask) return;
      const raw = ev?.raw ?? p, hit = this.vp.pick(raw);
      if (!hit) return;
      const e = ent(this.vp, hit.id);
      if (this.poly) {
        if (e.type !== 'LWPOLYLINE') { this.h.toast('That is not a 2D polyline.'); return; }
        const set = apply(this.h, this.name, () => (this.kind === 'fillet' ? filletPolyline(e, this.v.filletRad) : chamferPolyline(e, this.chamOpts())));
        if (set) this.h.toast(`${set.count ?? 0} corner(s) ${this.kind === 'fillet' ? 'filleted' : 'chamfered'}`, 2000);
        this.poly = false; this.finish(); return;
      }
      if (!this.first) { this.first = { id: e.id, p: raw }; this.vp.setSelection([e.id]); return; }
      if (e.id === this.first.id) { this.h.toast('Select a different object (use Polyline for polyline corners).'); return; }
      const f = this.first; this.first = null; this.vp.setSelection([]);
      if (apply(this.h, this.name, () => this.corner(ent(this.vp, f.id), f.p, e, raw))) this.finish();
    }
    finish() { if (!this.multi) this.h.setTool('select'); }
    key(e) {
      if (e.key === 'Escape') {
        if (this.ask || this.first || this.poly) { this.ask = null; this.first = null; this.poly = false; this.vp.setSelection([]); return true; }
        this.cancel(); return true;
      }
      if (e.key === 'Enter') { // Enter at a value prompt keeps the default shown in <>
        if (this.ask === 'd1') { this.v.chamB = this.v.chamA; this.v.chamMethod = 'distance'; this.ask = 'd2'; } else if (this.ask === 'len') { this.v.chamMethod = 'angle'; this.ask = 'ang'; } else if (this.ask) this.ask = null;
        else this.cancel();
        return true;
      }
      return false;
    }
    draw(c) {
      if (!this.first || this.ask) return;
      const hit = this.vp.pick(this.vp.cursor);
      if (!hit || hit.id === this.first.id) return;
      drawSet(this.vp, c, quiet(() => this.corner(ent(this.vp, this.first.id), this.first.p, ent(this.vp, hit.id), this.vp.cursor)));
    }
  }

  // ---- BREAK -------------------------------------------------------------------------------------
  class BreakTool extends Tool {
    activate() { super.activate(); this.id = null; this.p1 = null; this.askFirst = false; this.vp.setSelection([]); }
    get prompt() {
      if (!this.id) return 'BREAK  select object (the pick point is the first break point)';
      if (this.askFirst) return 'BREAK  first break point';
      return 'BREAK  second break point or [First point]  (@ = break at the first point)';
    }
    click(p, ev) {
      if (!this.id) {
        const hit = this.vp.pick(ev?.raw ?? p);
        if (hit) { this.id = hit.id; this.p1 = p; this.vp.lastPoint = p; this.vp.setSelection([hit.id]); }
        return;
      }
      if (this.askFirst) { this.p1 = p; this.vp.lastPoint = p; this.askFirst = false; return; }
      this.finish(dist(p, this.p1) < 1e-12 ? null : p);
    }
    text(s) {
      const o = opt(s);
      if (!this.id) return false;
      if (o === 'f') { this.askFirst = true; return true; }
      if (o === '@' || o === '@0,0') { this.finish(null); return true; }
      return false;
    }
    compute(p2) { const e = ent(this.vp, this.id); return p2 ? breakBetween(e, this.p1, p2) : breakAt(e, this.p1); }
    finish(p2) { apply(this.h, 'Break', () => this.compute(p2)); this.vp.setSelection([]); this.h.setTool('select'); }
    key(e) {
      if (e.key === 'Escape' && this.id) { this.activate(); return true; }
      if (e.key === 'Enter') { this.cancel(); return true; }
      return super.key(e);
    }
    draw(c) {
      if (!this.id || this.askFirst || dist(this.vp.cursor, this.p1) < 1e-12) return;
      drawSet(this.vp, c, quiet(() => this.compute(this.vp.cursor)));
    }
  }

  // ---- JOIN --------------------------------------------------------------------------------------
  class JoinTool extends ModifyTool {
    constructor(host) { super(host); this.name = 'JOIN'; }
    get prompt() { return this.selPrompt; }
    begin() {
      const ents = this.ids.map((id) => ent(this.vp, id)).filter(Boolean);
      const set = apply(this.h, 'Join', () => join(ents));
      if (set) this.h.toast(set.remove.length ? `${set.remove.length + 1} objects joined into 1` : 'No objects could be joined.', 2000);
      this.done();
    }
    click() {}
  }

  // ---- LENGTHEN ----------------------------------------------------------------------------------
  const MODES = { de: 'delta', delta: 'delta', p: 'percent', percent: 'percent', t: 'total', total: 'total', dy: 'dynamic', dynamic: 'dynamic' };
  class LengthenTool extends Tool {
    constructor(host) { super(host); this.mode = null; this.value = null; this.angle = false; }
    activate() { super.activate(); this.ask = false; this.dyn = null; this.vp.setSelection([]); }
    get ready() { return this.mode === 'dynamic' || (this.mode && this.value !== null); }
    get prompt() {
      const L = 'LENGTHEN', opts = '[DElta/Percent/Total/DYnamic]';
      if (this.ask) {
        if (this.mode === 'percent') return `${L}  percentage length <${fmt(this.value ?? 100)}>`;
        const what = this.angle ? 'angle (degrees)' : 'length';
        return `${L}  ${this.mode === 'delta' ? 'delta' : 'total'} ${what}${this.angle ? '' : ' or [Angle]'}`;
      }
      if (this.dyn) return `${L}  specify new end point`;
      if (!this.ready) return `${L}  select an object to measure or ${opts}`;
      const desc = this.mode === 'dynamic' ? 'dynamic' : `${this.mode} ${fmt(this.value)}${this.mode === 'percent' ? '%' : this.angle ? '°' : ''}`;
      return `${L}  (${desc})  select an object to change or ${opts}`;
    }
    text(s) {
      const o = opt(s), x = num(s);
      if (this.ask) {
        if (o === 'a' && this.mode !== 'percent') { this.angle = true; return true; }
        if (x === null || (this.mode !== 'delta' && x <= 0)) { this.h.toast('Enter a valid number.'); return true; }
        this.value = x; this.ask = false; return true;
      }
      if (!MODES[o] || this.dyn) return false;
      this.mode = MODES[o]; this.value = null; this.angle = false; this.ask = this.mode !== 'dynamic';
      return true;
    }
    click(p, ev) {
      if (this.ask) return;
      if (this.dyn) {
        const d = this.dyn; this.dyn = null; this.vp.lastPoint = null;
        apply(this.h, 'Lengthen', () => lengthen(ent(this.vp, d.id), d.pick, { mode: 'dynamic', point: p, angle: this.angle }));
        this.vp.setSelection([]); return;
      }
      const raw = ev?.raw ?? p, hit = this.vp.pick(raw);
      if (!hit) return;
      const e = ent(this.vp, hit.id);
      if (!this.ready) { this.h.toast(lengthText(e), 4000); return; }
      if (this.mode === 'dynamic') { this.dyn = { id: e.id, pick: raw }; this.vp.setSelection([e.id]); return; }
      apply(this.h, 'Lengthen', () => lengthen(e, raw, { mode: this.mode, value: this.value, angle: this.angle }));
    }
    key(e) {
      if (e.key === 'Escape' && (this.ask || this.dyn)) { this.ask = false; this.dyn = null; this.vp.setSelection([]); return true; }
      if (e.key === 'Enter') { if (this.ask) this.ask = this.value === null && this.mode !== 'dynamic' ? (this.mode = null, false) : false; else this.cancel(); return true; }
      return super.key(e);
    }
    draw(c) {
      if (!this.dyn) return;
      drawSet(this.vp, c, quiet(() => lengthen(ent(this.vp, this.dyn.id), this.dyn.pick, { mode: 'dynamic', point: this.vp.cursor, angle: this.angle })));
    }
  }

  // ---- STRETCH -----------------------------------------------------------------------------------
  class StretchTool extends Tool {
    activate() { super.activate(); this.win = null; this.corner = null; this.start = null; this.ids = []; this.base = null; this.vp.setSelection([]); }
    get prompt() {
      if (!this.win) return this.corner ? 'STRETCH  other corner of the crossing window' : 'STRETCH  select objects to stretch by crossing window (drag, or click two corners)';
      return this.base ? 'STRETCH  second point (or @dx,dy)' : 'STRETCH  base point';
    }
    down(p, ev) { if (!this.win && !this.corner) this.start = ev.raw; }
    move(p, ev) { if (this.start && ev.dragging) this.vp.rubber = { a: this.start, b: ev.raw, crossing: true }; }
    up(p, ev) {
      const a = this.start; this.start = null; this.vp.rubber = null;
      if (a && ev.dragged) { this.setWindow(a, ev.raw); this.h.refreshPrompt(); return; }
      if (!ev.dragged) this.click(p, ev);
    }
    click(p, ev) {
      if (!this.win) {
        const q = ev?.raw ?? p;
        if (!this.corner) this.corner = q; else { this.setWindow(this.corner, q); this.corner = null; }
        return;
      }
      if (!this.base) { this.base = p; this.vp.lastPoint = p; return; }
      apply(this.h, 'Stretch', () => this.compute(p.x - this.base.x, p.y - this.base.y));
      this.vp.setSelection([]); this.h.setTool('select');
    }
    setWindow(a, b) {
      this.ids = [...this.vp.box(a, b, true)];
      if (!this.ids.length) { this.h.toast('No objects cross that window.'); return; }
      this.win = { minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y), maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y) };
      this.vp.setSelection(this.ids);
    }
    compute(dx, dy) { return stretch(this.ids.map((id) => ent(this.vp, id)).filter(Boolean), this.win, dx, dy, this.vp.doc); }
    key(e) {
      if (e.key === 'Escape' && (this.win || this.corner)) { this.activate(); return true; }
      if (e.key === 'Enter') { this.cancel(); return true; }
      return super.key(e);
    }
    draw(c) {
      const q = this.vp.cursor;
      if (this.corner) {
        c.strokeStyle = this.vp.inkColor; c.setLineDash([6, 4]);
        this.poly(c, [this.corner, { x: q.x, y: this.corner.y }, q, { x: this.corner.x, y: q.y }], true);
      } else if (this.base) {
        drawSet(this.vp, c, quiet(() => this.compute(q.x - this.base.x, q.y - this.base.y)));
        c.setLineDash([]); this.line(c, this.base, q);
      }
    }
  }

  // ---- ARRAY -------------------------------------------------------------------------------------
  class ArrayTool extends ModifyTool {
    ents() { return this.ids.map((id) => ent(this.vp, id)).filter(Boolean); }
    async ask(title, fields, compute) {
      const r = await paramsDialog(title, fields, (v) => { this.preview = () => compute(v); this.vp.requestRender(); });
      this.preview = null; this.vp.requestRender();
      if (this.h.tool !== this) return;
      if (r) apply(this.h, 'Array', () => compute(r));
      this.done();
    }
    draw(c) { if (this.preview) drawSet(this.vp, c, quiet(this.preview)); }
    click() {}
  }
  const tooMany = (n) => { if (n > 100000) throw Object.assign(new Error('too many items (at most 100000)'), { code: 'GEOMETRY' }); };

  class ArrayRectTool extends ArrayTool {
    constructor(host) { super(host); this.name = 'ARRAYRECT'; this.last = { rows: 3, cols: 4 }; }
    get prompt() { return this.phase === 'select' ? this.selPrompt : 'ARRAYRECT  set rows, columns and spacing in the dialog'; }
    begin() {
      const ents = this.ents();
      const box = ents.reduce((b, e) => unionBox(b, bboxOf(e, this.vp.doc)), null);
      const sp = (d) => Number(fmt((d > 0 ? d : 1) * 1.5));
      this.ask('Rectangular array', [
        ['rows', 'Rows', this.last.rows, 'num'], ['cols', 'Columns', this.last.cols, 'num'],
        ['rowSpacing', 'Row spacing', sp(box && box.maxy - box.miny), 'num'], ['colSpacing', 'Column spacing', sp(box && box.maxx - box.minx), 'num'],
        ['angle', 'Angle (degrees)', 0, 'num'],
      ], (v) => {
        const rows = Math.round(v.rows), cols = Math.round(v.cols);
        if (!(rows >= 1 && cols >= 1)) throw Object.assign(new Error('rows and columns must be at least 1'), { code: 'GEOMETRY' });
        tooMany(rows * cols * ents.length);
        this.last = { rows, cols };
        return arrayRect(ents, { ...v, rows, cols });
      });
    }
  }

  class ArrayPolarTool extends ArrayTool {
    constructor(host) { super(host); this.name = 'ARRAYPOLAR'; this.last = { count: 6, fillAngle: 360, rotate: true }; }
    begin() { this.center = null; }
    reset() { this.center = null; this.vp.lastPoint = null; }
    get prompt() { return this.phase === 'select' ? this.selPrompt : this.center ? 'ARRAYPOLAR  set items, fill angle and rotation in the dialog' : 'ARRAYPOLAR  center point of array'; }
    click(p) {
      if (this.phase !== 'go' || this.center) return;
      this.center = p; this.h.refreshPrompt();
      const ents = this.ents(), center = p;
      this.ask('Polar array', [
        ['count', 'Items (total)', this.last.count, 'num'], ['fillAngle', 'Angle to fill (degrees)', this.last.fillAngle, 'num'], ['rotate', 'Rotate items as copied', this.last.rotate, 'bool'],
      ], (v) => {
        const count = Math.round(v.count);
        tooMany(count * ents.length);
        this.last = { count, fillAngle: v.fillAngle, rotate: v.rotate };
        return arrayPolar(ents, { center, count, fillAngle: v.fillAngle, rotate: v.rotate, doc: this.vp.doc });
      });
    }
  }

  class ArrayPathTool extends ArrayTool {
    constructor(host) { super(host); this.name = 'ARRAYPATH'; this.last = { count: 6, spacing: null, align: true }; }
    begin() { this.path = null; }
    reset() { this.path = null; }
    get prompt() { return this.phase === 'select' ? this.selPrompt : this.path ? 'ARRAYPATH  set items, spacing and alignment in the dialog' : 'ARRAYPATH  select path curve'; }
    click(p, ev) {
      if (this.phase !== 'go' || this.path) return;
      const hit = this.vp.pick(ev?.raw ?? p);
      if (!hit) return;
      if (this.ids.includes(hit.id)) { this.h.toast('The path cannot be one of the arrayed objects.'); return; }
      const ents = this.ents(), path = ent(this.vp, hit.id);
      this.path = path; this.h.refreshPrompt();
      this.ask('Path array', [
        ['count', 'Items (blank = fill the path at the spacing)', this.last.count, 'opt'], ['spacing', 'Spacing (blank = divide the path evenly)', this.last.spacing, 'opt'],
        ['align', 'Align items to the path', this.last.align, 'bool'],
      ], (v) => {
        const count = v.count === null ? null : Math.round(v.count);
        tooMany((count ?? 1) * ents.length);
        this.last = { count, spacing: v.spacing, align: v.align };
        return arrayPath(ents, path, { count, spacing: v.spacing, align: v.align, doc: this.vp.doc });
      });
    }
  }

  return {
    fillet: new CornerTool(h, 'fillet'), chamfer: new CornerTool(h, 'chamfer'), break: new BreakTool(h), join: new JoinTool(h),
    lengthen: new LengthenTool(h), stretch: new StretchTool(h),
    arrayrect: new ArrayRectTool(h), arraypolar: new ArrayPolarTool(h), arraypath: new ArrayPathTool(h),
  };
}
