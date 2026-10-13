// ASH Draw Studio - PEDIT, REVERSE and BREAKATPOINT tools: the UI over src/core/pedit.js.
// Prompts and options follow AutoCAD LT. tools.js passes the Tool / ModifyTool base classes in (no import cycle).
import { applyEditSet } from '../src/core/edit.js';
import { getEntity } from '../src/core/model.js';
import { bboxOf, unionBox } from '../src/core/geom.js';
import {
  toPolyline, setClosed, setWidth, fitCurve, splineFit, decurve, reverse, reverseEntity, joinToPolyline, joinMany, breakAtPoint, mergeTopSteps,
} from '../src/core/pedit.js';

const num = (s) => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) && String(s).trim() !== '' ? v : null; };
const opt = (s) => String(s).trim().toLowerCase();
const empty = (set) => !set.change.length && !set.remove.length && !set.add.length;
/** Default join tolerance, as JOIN: 1e-6 x the diagonal of the objects' extents. */
function defaultFuzz(ents) {
  let b = null;
  for (const e of ents) b = unionBox(b, bboxOf(e));
  return b ? 1e-6 * Math.hypot(b.maxx - b.minx, b.maxy - b.miny) : 0;
}

export function createModify2Tools(h, { Tool, ModifyTool }) {
  const ent = (id) => getEntity(h.vp.doc, id);

  // ---- PEDIT -------------------------------------------------------------------------------------
  // Every option is applied at once (so the drawing shows it); the steps are merged into one undo step when the
  // command ends. Undo (the option) takes back the last option of this PEDIT.
  class PeditTool extends ModifyTool {
    constructor(host) { super(host); this.name = 'PEDIT'; }
    activate() {
      Tool.prototype.activate.call(this);
      Object.assign(this, { state: 'pick', ids: [], multi: false, stepIds: [] });
      const pre = [...this.vp.selection];
      if (pre.length === 1) this.picked(pre[0]);
      else if (pre.length > 1) { this.multi = true; this.endMulti(); }
    }
    deactivate() { this.merge(); super.deactivate(); }
    get polys() { return this.ids.map(ent).filter((e) => e?.type === 'LWPOLYLINE'); }
    get prompt() {
      const n = this.vp.selection.size;
      switch (this.state) {
        case 'pick': return 'PEDIT  select polyline or [Multiple]';
        case 'multi': return `PEDIT  select objects (${n} selected, Enter = done)`;
        case 'convert': return 'PEDIT  Object selected is not a polyline. Do you want to turn it into one? <Y>';
        case 'mconvert': return 'PEDIT  Convert Lines and Arcs to polylines [Yes/No]? <Y>';
        case 'join': return `PEDIT  select objects to join (${n} selected, Enter = done)`;
        case 'fuzz': return 'PEDIT  enter fuzz distance <0>';
        case 'width': return 'PEDIT  specify new width for all segments';
        default: {
          const oc = this.multi ? 'Close/Open' : this.polys[0]?.closed ? 'Open' : 'Close';
          return `PEDIT  enter an option [${oc}/Join/Width/Fit/Spline/Decurve/Reverse/Undo]  (Enter = done)`;
        }
      }
    }
    // selection: the shared Selector while picking objects
    selecting() { return this.state === 'pick' || this.state === 'multi' || this.state === 'join'; }
    down(p, ev) { if (this.selecting()) this.sel.down(p, ev); }
    move(p, ev) { if (this.selecting()) this.sel.move(p, ev); }
    up(p, ev) {
      if (!this.selecting()) return;
      // Multiple / Join build up a set: a pick or window adds to it (Shift+pick removes), as AutoCAD's "Select objects"
      const keep = this.state === 'pick' || ev.shiftKey ? null : [...this.vp.selection];
      this.sel.up(p, ev);
      if (keep) this.vp.setSelection([...new Set([...keep, ...this.vp.selection])]);
      if (this.state === 'pick') { const [id] = this.vp.selection; if (id !== undefined) this.picked(id); }
      this.h.refreshPrompt();
    }
    click() {}
    picked(id) {
      const e = ent(id);
      this.ids = [id];
      this.vp.setSelection([id]);
      if (e?.type === 'LWPOLYLINE') this.state = 'opts';
      else if (e?.type === 'LINE' || e?.type === 'ARC') this.state = 'convert';
      else { this.h.toast('PEDIT: that object is not a polyline, line or arc.'); this.ids = []; this.vp.setSelection([]); }
    }
    endMulti() {
      this.ids = [...this.vp.selection];
      if (!this.ids.length) { this.cancel(); return; }
      this.state = this.ids.some((id) => ['LINE', 'ARC'].includes(ent(id)?.type)) ? 'mconvert' : 'opts';
      if (this.state === 'opts') this.keepPolys();
    }
    keepPolys() {
      this.ids = this.polys.map((e) => e.id);
      this.vp.setSelection(this.ids);
      if (!this.ids.length) { this.h.toast('PEDIT: no polylines selected.'); this.state = 'pick'; this.multi = false; }
    }
    /** apply one option as a session step */
    run(fn) {
      let set;
      try { set = fn(); } catch (err) { if (!err.code) throw err; this.h.toast(`PEDIT: ${err.message}`); return null; }
      if (empty(set)) return set;
      applyEditSet(this.h.session, 'Pedit', set);
      this.stepIds.push(this.h.session.undoStack.at(-1)?.id);
      this.ids = this.ids.filter((id) => ent(id));
      this.vp.setSelection(this.ids);
      return set;
    }
    /** one option on every selected polyline, as one step */
    each(op) {
      return this.run(() => {
        const out = { add: [], remove: [], change: [] };
        for (const e of this.polys) out.change.push(...op(e).change);
        return out;
      });
    }
    undoOne() {
      const s = this.h.session;
      if (!this.stepIds.length || s.undoStack.at(-1)?.id !== this.stepIds.at(-1)) { this.h.toast('PEDIT: nothing to undo.'); return; }
      s.undo(); this.stepIds.pop();
      if (!this.polys.length) { this.state = 'pick'; this.ids = []; this.multi = false; this.vp.setSelection([]); return; }
      this.vp.setSelection(this.ids);
    }
    merge() {
      const s = this.h.session, n = this.stepIds.length;
      const top = s.undoStack.slice(-n).map((x) => x.id);
      if (n > 1 && top.length === n && top.every((id, i) => id === this.stepIds[i])) mergeTopSteps(s, n, 'Pedit');
      this.stepIds = [];
    }
    finish() { this.merge(); this.vp.setSelection([]); this.h.setTool('select'); }
    doJoin(fuzz) {
      const others = [...this.vp.selection].filter((id) => !this.ids.includes(id)).map(ent).filter(Boolean);
      this.state = 'opts';
      if (this.multi) {
        const all = [...this.polys, ...others];
        const r = this.run(() => joinMany(all, { fuzz }));
        if (r) this.h.toast(`${r.joined} segment(s) added to polylines`, 2000);
        return;
      }
      const pl = this.polys[0];
      const r = this.run(() => joinToPolyline(pl, others, { fuzz: fuzz ?? defaultFuzz([pl, ...others]) }));
      if (r) this.h.toast(`${r.joined} segment(s) added to polyline`, 2000);
    }
    text(s) {
      const o = opt(s), x = num(s);
      switch (this.state) {
        case 'pick': if (o === 'm' || o === 'multiple') { this.multi = true; this.state = 'multi'; this.vp.setSelection([]); return true; } return false;
        case 'convert':
          if (o === 'y' || o === 'yes') { this.run(() => toPolyline(ent(this.ids[0]))); this.state = 'opts'; return true; }
          if (o === 'n' || o === 'no') { this.state = 'pick'; this.ids = []; this.vp.setSelection([]); return true; }
          return false;
        case 'mconvert':
          if (o === 'y' || o === 'yes') { this.convertAll(); return true; }
          if (o === 'n' || o === 'no') { this.state = 'opts'; this.keepPolys(); return true; }
          return false;
        case 'width':
          if (x === null || x < 0) { this.h.toast('Enter a width of 0 or more.'); return true; }
          this.each((e) => setWidth(e, x)); this.state = 'opts'; return true;
        case 'fuzz':
          if (x === null || x < 0) { this.h.toast('Enter a distance of 0 or more.'); return true; }
          this.doJoin(x); return true;
        case 'opts': break;
        default: return false;
      }
      if (o === 'c' || o === 'close') this.each((e) => setClosed(e, true));
      else if (o === 'o' || o === 'open') this.each((e) => setClosed(e, false));
      else if (o === 'j' || o === 'join') { this.state = this.multi ? 'fuzz' : 'join'; if (!this.multi) this.vp.setSelection([]); }
      else if (o === 'w' || o === 'width') this.state = 'width';
      else if (o === 'f' || o === 'fit') this.each(fitCurve);
      else if (o === 's' || o === 'spline') this.each((e) => splineFit(e)); // SPLINETYPE 6, SPLINESEGS 8 (no such settings yet)
      else if (o === 'd' || o === 'decurve') this.each(decurve);
      else if (o === 'r' || o === 'reverse') this.each((e) => ({ change: [reverseEntity(e)] }));
      else if (o === 'u' || o === 'undo') this.undoOne();
      else return false;
      return true;
    }
    convertAll() {
      this.run(() => {
        const out = { add: [], remove: [], change: [] };
        for (const e of this.ids.map(ent)) if (e && (e.type === 'LINE' || e.type === 'ARC')) out.change.push(...toPolyline(e).change);
        return out;
      });
      this.state = 'opts'; this.keepPolys();
    }
    key(e) {
      const esc = e.key === 'Escape', enter = e.key === 'Enter';
      if (!esc && !enter) return false;
      switch (this.state) {
        case 'pick': this.cancel(); break;
        case 'multi': if (esc) this.cancel(); else this.endMulti(); break;
        case 'convert': if (enter) this.text('y'); else { this.state = 'pick'; this.ids = []; this.vp.setSelection([]); } break;
        case 'mconvert': if (enter) this.convertAll(); else this.cancel(); break;
        case 'join': if (enter) this.doJoin(null); else { this.state = 'opts'; this.vp.setSelection(this.ids); } break;
        case 'fuzz': if (enter) this.doJoin(0); else this.state = 'opts'; break;
        case 'width': this.state = 'opts'; break;
        default: this.finish(); // Enter ends PEDIT; Esc too, keeping what was done (as AutoCAD)
      }
      this.h.refreshPrompt();
      return true;
    }
  }

  // ---- REVERSE -----------------------------------------------------------------------------------
  class ReverseTool extends ModifyTool {
    constructor(host) { super(host); this.name = 'REVERSE'; }
    get prompt() { return this.selPrompt; }
    begin() {
      const set = reverse(this.ids.map(ent).filter(Boolean));
      if (set.change.length) applyEditSet(this.h.session, 'Reverse', set);
      this.h.toast(`${set.change.length} object(s) direction has been reversed${set.failed.length ? `; ${set.failed.length} could not be (lines, arcs, polylines and splines only)` : ''}.`, 2500);
      this.done();
    }
    click() {}
  }

  // ---- BREAKATPOINT ------------------------------------------------------------------------------
  class BreakAtPointTool extends Tool {
    activate() {
      super.activate();
      const pre = [...this.vp.selection];
      this.id = pre.length === 1 ? pre[0] : null;
      if (!this.id) this.vp.setSelection([]);
    }
    get prompt() { return this.id ? 'BREAKATPOINT  specify break point' : 'BREAKATPOINT  select object'; }
    click(p, ev) {
      if (!this.id) {
        const hit = this.vp.pick(ev?.raw ?? p);
        if (hit) { this.id = hit.id; this.vp.setSelection([hit.id]); }
        return;
      }
      try { applyEditSet(this.h.session, 'Break', breakAtPoint(ent(this.id), p)); } catch (err) {
        if (!err.code) throw err;
        this.h.toast(`BREAKATPOINT: ${err.message}`);
      }
      this.vp.setSelection([]); this.h.setTool('select');
    }
    key(e) {
      if (e.key === 'Escape' || e.key === 'Enter') { this.vp.setSelection([]); this.cancel(); return true; }
      return false;
    }
  }

  return { pedit: new PeditTool(h), reverse: new ReverseTool(h), breakatpoint: new BreakAtPointTool(h) };
}
