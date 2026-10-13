// ASH Draw Studio - DIVIDE and MEASUREPOINTS (AutoCAD's point-placing MEASURE; MEASURE here is MEASUREGEOM): the UI
// over src/core/divide.js. Prompts and options follow AutoCAD LT. tools.js passes the Tool base class in (no import cycle).
import { addEntities } from '../src/core/edit.js';
import { getEntity } from '../src/core/model.js';
import { insertableBlocks } from '../src/core/blocks.js';
import { divideStations, measureStations, placeAt, DIVIDE_MAX } from '../src/core/divide.js';

// strict: a typed coordinate such as "5,0" must not be read as the number 5
const NUM = /^[-+]?\d*\.?\d+$/;
const numOf = (s) => (NUM.test(s.trim()) ? Number(s.trim()) : null);
const CURVES = new Set(['LINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'LWPOLYLINE', 'SPLINE']);

export function createDivideTools(h, { Tool }) {
  class PlaceTool extends Tool {
    constructor(host, measure) { super(host); this.measure = measure; this.name = measure ? 'MEASURE' : 'DIVIDE'; }
    activate() {
      super.activate();
      Object.assign(this, { step: 'pick', id: null, pick: null, block: null, align: true });
      const pre = [...this.vp.selection];
      if (pre.length === 1 && CURVES.has(getEntity(this.h.doc, pre[0])?.type)) { this.id = pre[0]; this.step = 'value'; } else this.vp.setSelection([]);
    }
    get prompt() {
      const n = this.name;
      switch (this.step) {
        case 'pick': return `${n}  select object to ${this.measure ? 'measure' : 'divide'}`;
        case 'name': return `${n}  enter name of block to insert`;
        case 'align': return `${n}  align block with object? [Yes/No] <Y>`;
        case 'bvalue': return this.measure ? `${n}  specify length of segment` : `${n}  enter the number of segments`;
        default: return this.measure ? `${n}  specify length of segment or [Block]` : `${n}  enter the number of segments or [Block]`;
      }
    }
    click(p, ev) {
      if (this.step !== 'pick') return;
      const hit = this.vp.pick(ev?.raw ?? p);
      if (!hit) return;
      if (!CURVES.has(hit.type)) { this.h.toast(`${this.name}: cannot ${this.measure ? 'measure' : 'divide'} that object (lines, arcs, circles, ellipses, polylines and splines).`); return; }
      this.id = hit.id; this.pick = p; this.step = 'value';
      this.vp.setSelection([hit.id]);
      this.h.refreshPrompt();
    }
    text(s) {
      const t = s.trim(), lo = t.toLowerCase();
      if (this.step === 'value' && (lo === 'b' || lo === 'block')) { this.step = 'name'; return true; }
      if (this.step === 'name') {
        if (!t) return true;
        const name = insertableBlocks(this.h.doc).find((b) => b.toLowerCase() === lo);
        if (!name) { this.h.toast(`${this.name}: block "${t}" not found.`); return true; }
        this.block = this.h.doc.blocks.get(name); this.step = 'align'; return true;
      }
      if (this.step === 'align') {
        if (lo === '' || lo === 'y' || lo === 'yes') this.align = true;
        else if (lo === 'n' || lo === 'no') this.align = false;
        else return false;
        this.step = 'bvalue'; return true;
      }
      if (this.step === 'value' || this.step === 'bvalue') {
        const v = numOf(t);
        if (v === null) return false;
        if (!this.measure && !(Number.isInteger(v) && v >= 2 && v <= DIVIDE_MAX)) { this.h.toast(`${this.name}: enter an integer between 2 and ${DIVIDE_MAX}.`); return true; }
        if (this.measure && !(v > 0)) { this.h.toast(`${this.name}: the segment length must be greater than 0.`); return true; }
        this.run(v); return true;
      }
      return false;
    }
    run(v) {
      const e = getEntity(this.h.doc, this.id);
      try {
        const st = this.measure ? measureStations(e, v, this.pick) : divideStations(e, v);
        const ents = placeAt(st, { props: this.props(), block: this.step === 'bvalue' ? this.block : null, align: this.align });
        if (ents.length) addEntities(this.h.session, ents, this.measure ? 'Measure' : 'Divide');
        else this.h.toast(`${this.name}: the segment length is longer than the object; nothing placed.`);
      } catch (err) {
        if (!err.code) throw err;
        this.h.toast(`${this.name}: ${err.message}`);
        return;
      }
      this.vp.setSelection([]); this.h.setTool('select');
    }
    key(e) {
      if (e.key === 'Enter' && this.step === 'align') { this.text(''); this.h.refreshPrompt(); return true; }
      if (e.key === 'Escape' || e.key === 'Enter') { this.vp.setSelection([]); this.cancel(); return true; }
      return false;
    }
  }
  return { divide: new PlaceTool(h, false), measurepoints: new PlaceTool(h, true) };
}
