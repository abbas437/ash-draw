// ASH Draw Studio - command-line view and inquiry tools over src/core/cmdline.js (ZOOM, ID, LIST, LTSCALE; options as in AutoCAD LT).
// tools.js owns the Tool base class and passes it to createViewTools (a factory, so this module does not import tools.js back).
import { parseZoomInput, entitiesBox, formatId, listEntities, setLinetypeScale } from '../src/core/cmdline.js';
import { lengthPrecision } from '../src/core/measure.js';
import { getEntity } from '../src/core/model.js';

export function createViewTools(h, { Tool }) {
  class ZoomTool extends Tool {
    activate() { super.activate(); this.a = null; this.mode = null; }
    get prompt() {
      if (this.mode === 'object') return 'ZOOM  select objects, then Enter';
      if (this.a) return 'ZOOM  specify opposite corner';
      if (this.mode === 'window') return 'ZOOM  specify first corner';
      return 'ZOOM  [All/Extents/Window/Previous/Object] or scale (nX) <Window>';
    }
    /** run a zoom as its own ZOOM Previous entry, then back to Select */
    done(fn) { h.viewHistory?.breakGesture(h.viewKey()); fn?.(); this.cancel(); }
    objects() {
      const ents = [...this.vp.selection].map((id) => getEntity(h.doc, id)).filter(Boolean);
      const b = ents.length ? entitiesBox(ents, h.doc) : null;
      if (!b) { h.toast('ZOOM Object: select objects first.'); return false; }
      this.done(() => this.vp.zoomBox(b));
      return true;
    }
    text(s) {
      if (this.a || this.mode) return false; // corners are typed as coordinates
      const r = parseZoomInput(s);
      if (!r) return false;
      if (r.mode === 'xp') { this.cancel(); h.zoomPaperScale(r.k); return true; }
      if (r.scale) { this.done(() => this.vp.zoomBy(r.scale)); return true; }
      switch (r.opt) {
        case 'all': case 'extents': this.done(() => this.vp.zoomExtents()); break;
        case 'previous': if (!h.zoomPrevious()) h.toast('ZOOM: no previous view.'); this.cancel(); break;
        case 'object': if (this.vp.selection.size) this.objects(); else this.mode = 'object'; break;
        case 'window': this.mode = 'window'; break;
      }
      return true;
    }
    down(p, ev) { if (this.mode === 'object') this.selStart = ev.raw; }
    up(p, ev) {
      if (this.mode !== 'object') { super.up(p, ev); return; }
      const a = this.selStart; this.selStart = null;
      const sel = new Set(this.vp.selection);
      if (a && ev.dragged) for (const id of this.vp.box(a, ev.raw, ev.raw.x < a.x)) sel.add(id);
      else { const hit = this.vp.pick(ev.raw); if (hit) sel.add(hit.id); }
      this.vp.setSelection(sel);
    }
    click(p) {
      if (this.mode === 'object') return;
      if (!this.a) { this.a = p; this.mode = 'window'; this.vp.lastPoint = p; return; }
      const a = this.a;
      if (Math.abs(p.x - a.x) < 1e-12 || Math.abs(p.y - a.y) < 1e-12) { h.toast('ZOOM Window: the corners must differ in X and Y.'); return; }
      this.done(() => this.vp.zoomBox({ minx: Math.min(a.x, p.x), miny: Math.min(a.y, p.y), maxx: Math.max(a.x, p.x), maxy: Math.max(a.y, p.y) }));
    }
    key(e) {
      if (e.key === 'Enter') {
        if (this.mode === 'object') this.objects();
        else if (!this.mode) this.mode = 'window'; // <Window> is the default
        return true;
      }
      return super.key(e);
    }
    draw(c) {
      if (!this.a) return;
      const q = this.vp.cursor;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
      this.poly(c, [this.a, { x: q.x, y: this.a.y }, q, { x: this.a.x, y: q.y }], true);
      c.setLineDash([]);
    }
  }
  /** units and precision of the whole drawing (UNITS), as the Measure tool labels values */
  const fmt = () => ({ prec: lengthPrecision(h.fileDoc.header?.luprec), units: h.fileDoc.units ?? 0 });

  class IdTool extends Tool {
    get prompt() { return 'ID  specify point'; }
    click(p) { const t = formatId(p, fmt().prec); this.cancel(); h.toast(t, 8000); h.log(t); }
  }

  class ListTool extends Tool {
    activate() { super.activate(); if (this.vp.selection.size) queueMicrotask(() => { if (h.tool === this) this.finish(); }); }
    get prompt() { return 'LIST  select objects'; }
    finish() {
      const ents = [...this.vp.selection].map((id) => getEntity(h.doc, id)).filter(Boolean);
      if (!ents.length) { h.toast('LIST: select objects first.'); return; }
      this.cancel();
      const text = listEntities(ents, h.doc, fmt());
      h.log(`LIST: ${ents.length} objects\n${text}`);
      h.listDialog(text);
    }
    down(p, ev) { this.selStart = ev.raw; }
    up(p, ev) {
      const a = this.selStart; this.selStart = null;
      const sel = new Set(this.vp.selection);
      if (a && ev.dragged) for (const id of this.vp.box(a, ev.raw, ev.raw.x < a.x)) sel.add(id);
      else { const hit = this.vp.pick(ev.raw); if (hit) sel.add(hit.id); }
      this.vp.setSelection(sel);
    }
    key(e) { if (e.key === 'Enter') { if (this.vp.selection.size) this.finish(); else this.cancel(); return true; } return super.key(e); }
  }

  class LtscaleTool extends Tool {
    get current() { return h.fileDoc.header?.ltscale || 1; }
    get prompt() { return `LTSCALE  new linetype scale factor <${this.current}>`; }
    text(s) {
      const t = s.trim();
      if (!/^[-+]?\d*\.?\d+$/.test(t) || !(Number(t) > 0)) { h.toast('LTSCALE: requires a number greater than 0.'); return true; }
      const k = Number(t);
      this.cancel();
      if (setLinetypeScale(h.session, k, h.fileDoc)) h.toast(`Linetype scale = ${k}`, 2500);
      return true;
    }
    key(e) { if (e.key === 'Enter') { this.cancel(); return true; } return super.key(e); } // Enter keeps <current>
  }

  return { zoom: new ZoomTool(h), id: new IdTool(h), list: new ListTool(h), ltscale: new LtscaleTool(h) };
}
