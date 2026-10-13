// ASH Draw Studio - XLINE (construction line) and RAY tools. Exported as a factory (createXlineTools) so this module does
// not import tools.js back; the Bisect / Offset geometry lives in src/core/xline-tools.js.
import { makeXline } from '../src/core/model.js';
import { clipInfinite } from '../src/core/geom.js';
import { bisectorDir, lineOf, offsetXline } from '../src/core/xline-tools.js';

// strict: a typed coordinate such as "5,0" must not be read as the number 5
const NUM = /^[-+]?\d*\.?\d+$/;
const numOf = (s) => (NUM.test(s.trim()) ? Number(s.trim()) : null);
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(4)).replace(/\.?0+$/, '');
const DEG = Math.PI / 180;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= 1e-12;

export function createXlineTools(h, { Tool }) {
  // Shared by XLINE and RAY: every object of one command run is ONE undo step (as U after XLINE in AutoCAD), folded into
  // the step the first one opened (same scheme as DONUT); a dashed infinite preview clipped to the canvas.
  class InfiniteTool extends Tool {
    activate() { super.activate(); this.run = null; this.reset(); }
    make(type, p, dir) {
      const e = makeXline(type, p, dir, this.props());
      if (!e) return;
      const s = this.h.session, prev = s.undoStack.at(-1);
      this.add(e);
      const last = s.undoStack.at(-1);
      if (this.run != null && prev?.id === this.run && last !== prev) { s.undoStack.pop(); prev.ops.push(...last.ops); } else this.run = last?.id ?? null;
    }
    inf(c, p, dir, ray = false) {
      if (!dir || !(Math.hypot(dir.x, dir.y) > 1e-12)) return;
      const cv = this.vp.canvas, a = this.vp.toWorld(0, 0), b = this.vp.toWorld(cv.clientWidth, cv.clientHeight);
      const seg = clipInfinite(p, dir, ray, { minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y), maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y) });
      if (seg) { c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); this.line(c, seg[0], seg[1]); }
    }
  }

  // ---- XLINE -----------------------------------------------------------------------------------
  // point -> through points | Hor / Ver / Ang -> through points | Bisect: vertex, start, end points | Offset: distance or
  // Through -> line object -> side (or through point), repeated. Enter / Esc ends the command.
  class XlineTool extends InfiniteTool {
    constructor(host) { super(host); this.angle = 0; this.offDist = null; } // offDist null = Through (AutoCAD's default)
    reset() { this.step = 'first'; this.p = null; this.dir = null; this.a = null; this.src = null; this.vp.lastPoint = null; }
    deactivate() { if (this.src) this.vp.setSelection([]); super.deactivate(); }
    get prompt() {
      switch (this.step) {
        case 'first': return 'XLINE  specify a point or [Hor/Ver/Ang/Bisect/Offset]';
        case 'angle': return `XLINE  angle of xline (${fmt(this.angle)})`;
        case 'vertex': return 'XLINE  angle vertex point';
        case 'bstart': return 'XLINE  angle start point';
        case 'bend': return 'XLINE  angle end point (Enter = exit)';
        case 'odist': return `XLINE  offset distance or [Through] <${this.offDist === null ? 'Through' : fmt(this.offDist)}>`;
        case 'osel': return 'XLINE  select a line object (Enter = exit)';
        case 'oside': return this.offDist === null ? 'XLINE  through point' : 'XLINE  specify side to offset';
        default: return 'XLINE  through point (Enter = exit)';
      }
    }
    click(p, ev) {
      switch (this.step) {
        case 'first': this.p = p; this.vp.lastPoint = p; this.step = 'through'; break;
        case 'through': if (this.dir) this.make('XLINE', p, this.dir); else if (!same(this.p, p)) this.make('XLINE', this.p, sub(p, this.p)); break;
        case 'vertex': this.p = p; this.vp.lastPoint = p; this.step = 'bstart'; break;
        case 'bstart': if (!same(this.p, p)) { this.a = p; this.step = 'bend'; } break;
        case 'bend': { const d = bisectorDir(this.p, this.a, p); if (d) this.make('XLINE', this.p, d); break; }
        case 'osel': {
          const raw = ev?.raw ?? p, hit = this.vp.pick(raw), l = lineOf(hit, raw);
          if (!l) { this.h.toast('Select a line, construction line, ray or straight polyline segment.'); break; }
          this.src = l; this.vp.setSelection([hit.id]); this.step = 'oside'; break;
        }
        case 'oside': {
          const o = this.offDist === null ? { p, dir: this.src.dir } : offsetXline(this.src, this.offDist, p);
          if (!o) return;
          this.make('XLINE', o.p, o.dir); this.src = null; this.vp.setSelection([]); this.step = 'osel'; break;
        }
        default: break;
      }
    }
    text(s) {
      const t = s.trim().toLowerCase(), v = numOf(s);
      if (this.step === 'first') {
        if (t === 'h' || t === 'hor') { this.dir = { x: 1, y: 0 }; this.step = 'through'; return true; }
        if (t === 'v' || t === 'ver') { this.dir = { x: 0, y: 1 }; this.step = 'through'; return true; }
        if (t === 'a' || t === 'ang') { this.step = 'angle'; return true; }
        if (t === 'b' || t === 'bisect') { this.step = 'vertex'; return true; }
        if (t === 'o' || t === 'offset') { this.step = 'odist'; return true; }
        return false;
      }
      if (this.step === 'angle') {
        if (t === 'r' || t === 'reference') { this.h.toast('Reference is not available; type the angle in degrees.'); return true; }
        if (v === null) return false;
        this.angle = v; this.setAngle(); return true;
      }
      if (this.step === 'odist') {
        if (t === 't' || t === 'through') { this.offDist = null; this.step = 'osel'; return true; }
        if (v === null) return false;
        if (v > 0) { this.offDist = v; this.step = 'osel'; } else this.h.toast('The offset distance must be positive.');
        return true;
      }
      return false;
    }
    setAngle() { this.dir = { x: Math.cos(this.angle * DEG), y: Math.sin(this.angle * DEG) }; this.step = 'through'; }
    key(e) {
      if (e.key === 'Enter') {
        if (this.step === 'angle') this.setAngle();
        else if (this.step === 'odist') this.step = 'osel';
        else this.cancel();
        return true;
      }
      if (e.key === 'Escape') { this.cancel(); return true; }
      return false;
    }
    draw(c) {
      const q = this.vp.cursor;
      if (this.step === 'through') this.inf(c, this.dir ? q : this.p, this.dir ?? sub(q, this.p));
      else if (this.step === 'bstart') { c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); this.line(c, this.p, q); }
      else if (this.step === 'bend') { const d = bisectorDir(this.p, this.a, q); if (d) this.inf(c, this.p, d); }
      else if (this.step === 'oside') {
        const o = this.offDist === null ? { p: q, dir: this.src.dir } : offsetXline(this.src, this.offDist, q);
        if (o) this.inf(c, o.p, o.dir);
      }
    }
  }

  // ---- RAY -------------------------------------------------------------------------------------
  class RayTool extends InfiniteTool {
    reset() { this.p = null; this.vp.lastPoint = null; }
    get prompt() { return this.p ? 'RAY  through point (Enter = exit)' : 'RAY  specify start point'; }
    click(p) {
      if (!this.p) { this.p = p; this.vp.lastPoint = p; return; }
      if (!same(this.p, p)) this.make('RAY', this.p, sub(p, this.p));
    }
    key(e) {
      if (e.key === 'Enter' || e.key === 'Escape') { this.cancel(); return true; }
      return false;
    }
    draw(c) { if (this.p) this.inf(c, this.p, sub(this.vp.cursor, this.p), true); }
  }

  return { xline: new XlineTool(h), ray: new RayTool(h) };
}
