// ASH Draw Studio - POLYGON, SPLINE (fit points) and DONUT tools. Exported as a factory (createDraw2Tools) so this
// module does not import tools.js back; the geometry lives in src/core/draw2.js.
import { makePolyline, makeSpline } from '../src/core/model.js';
import { tessellate, dist } from '../src/core/geom.js';
import { polygonFromRadius, polygonFromEdge, donutPolyline, splineFromFit } from '../src/core/draw2.js';

// strict: a typed coordinate such as "5,0" must not be read as the number 5
const NUM = /^[-+]?\d*\.?\d+$/;
const numOf = (s) => (NUM.test(s.trim()) ? Number(s.trim()) : null);
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(4)).replace(/\.?0+$/, '');

export function createDraw2Tools(h, { Tool }) {
  // ---- POLYGON ---------------------------------------------------------------------------------
  // sides -> centre or [Edge] -> [Inscribed/Circumscribed] -> radius; Edge: first and second endpoint.
  class PolygonTool extends Tool {
    constructor(host) { super(host); this.sides = 4; this.inscribed = true; }
    activate() { super.activate(); this.reset(); }
    reset() { this.step = 'sides'; this.c = null; this.a = null; this.vp.lastPoint = null; }
    get prompt() {
      switch (this.step) {
        case 'sides': return `POLYGON  number of sides <${this.sides}>`;
        case 'center': return 'POLYGON  center of polygon or [Edge]';
        case 'mode': return `POLYGON  [Inscribed in circle/Circumscribed about circle] <${this.inscribed ? 'I' : 'C'}>`;
        case 'radius': return 'POLYGON  radius of circle (click or type)';
        case 'edge1': return 'POLYGON  first endpoint of edge';
        default: return 'POLYGON  second endpoint of edge';
      }
    }
    finish(vertices) { this.add(makePolyline(vertices, true, this.props())); this.reset(); }
    click(p) {
      if (this.step === 'center') { this.c = p; this.vp.lastPoint = p; this.step = 'mode'; }
      else if (this.step === 'radius') { if (dist(this.c, p) > 1e-12) this.finish(polygonFromRadius(this.c, this.sides, this.inscribed, p)); }
      else if (this.step === 'edge1') { this.a = p; this.vp.lastPoint = p; this.step = 'edge2'; }
      else if (this.step === 'edge2') { if (dist(this.a, p) > 1e-12) this.finish(polygonFromEdge(this.a, p, this.sides)); }
    }
    text(s) {
      const t = s.trim().toLowerCase(), v = numOf(s);
      if (this.step === 'sides') {
        if (v === null) return false;
        if (Number.isInteger(v) && v >= 3 && v <= 1024) { this.sides = v; this.step = 'center'; }
        else this.h.toast('Enter an integer between 3 and 1024.');
        return true;
      }
      if (this.step === 'center' && (t === 'e' || t === 'edge')) { this.step = 'edge1'; return true; }
      if (this.step === 'mode') {
        if (t === 'i' || t === 'inscribed') { this.inscribed = true; this.step = 'radius'; return true; }
        if (t === 'c' || t === 'circumscribed') { this.inscribed = false; this.step = 'radius'; return true; }
        return false;
      }
      if (this.step === 'radius' && v !== null) {
        if (v > 0) this.finish(polygonFromRadius(this.c, this.sides, this.inscribed, v)); else this.h.toast('The radius must be positive.');
        return true;
      }
      return false;
    }
    key(e) {
      if (e.key === 'Enter') {
        if (this.step === 'sides') this.step = 'center';
        else if (this.step === 'mode') this.step = 'radius';
        return true;
      }
      if (e.key === 'Escape') { this.reset(); this.cancel(); return true; } // Esc cancels the command, as in AutoCAD
      return false;
    }
    draw(c) {
      const q = this.vp.cursor;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
      if (this.step === 'radius' && dist(this.c, q) > 1e-12) {
        this.poly(c, polygonFromRadius(this.c, this.sides, this.inscribed, q), true);
        this.line(c, this.c, q); this.dyn(c, `R ${fmt(dist(this.c, q))}`, q);
      } else if (this.step === 'edge2' && dist(this.a, q) > 1e-12) {
        this.poly(c, polygonFromEdge(this.a, q, this.sides), true); this.dyn(c, fmt(dist(this.a, q)), q);
      }
    }
  }

  // ---- SPLINE (fit points) ---------------------------------------------------------------------
  class SplineTool extends Tool {
    activate() { super.activate(); this.pts = []; }
    get prompt() {
      if (!this.pts.length) return 'SPLINE  first fit point';
      return `SPLINE  next fit point (U = undo point${this.pts.length > 2 ? ', C = close' : ''}, Enter = finish, Esc = cancel)`;
    }
    click(p) {
      const last = this.pts.at(-1);
      if (last && dist(last, p) <= 1e-12) return;
      this.pts.push(p); this.vp.lastPoint = p;
    }
    text(s) {
      const t = s.trim().toLowerCase();
      if (!this.pts.length) return false;
      if (t === 'u' || t === 'undo') { this.pts.pop(); this.vp.lastPoint = this.pts.at(-1) ?? null; return true; }
      if ((t === 'c' || t === 'close') && this.pts.length > 2) { this.commit(true); return true; }
      return false;
    }
    commit(closed = false) {
      const s = this.pts.length > 1 ? splineFromFit(this.pts, closed) : null;
      if (s) this.add(makeSpline({ ...this.props(), ...s }));
      this.pts = []; this.vp.lastPoint = null;
    }
    key(e) {
      if (e.key === 'Enter') { this.commit(); return true; }
      if (e.key === 'Escape') { this.pts = []; this.vp.lastPoint = null; this.cancel(); return true; } // discards the points
      return false;
    }
    draw(c) {
      if (!this.pts.length) return;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
      const s = splineFromFit([...this.pts, this.vp.cursor]);
      if (!s) return;
      for (const run of tessellate(makeSpline(s))) this.poly(c, run);
    }
  }

  // ---- DONUT -----------------------------------------------------------------------------------
  // inside diameter -> outside diameter -> centres until Enter / Esc. All donuts of one run are ONE undo step (as U after
  // DONUT in AutoCAD): each new donut is folded into the step the first one opened.
  class DonutTool extends Tool {
    constructor(host) { super(host); this.inside = 0.5; this.outside = 1; }
    activate() { super.activate(); this.step = 'inside'; this.run = null; }
    get prompt() {
      if (this.step === 'inside') return `DONUT  inside diameter <${fmt(this.inside)}>`;
      if (this.step === 'outside') return `DONUT  outside diameter <${fmt(this.outside)}>`;
      return 'DONUT  center of donut (Enter = exit)';
    }
    shape(p) { return donutPolyline(p, Math.min(this.inside, this.outside), Math.max(this.inside, this.outside)); }
    click(p) {
      if (this.step !== 'center') return;
      const d = this.shape(p), e = makePolyline(d.vertices, true, this.props());
      e.width = d.width;
      const s = this.h.session, prev = s.undoStack.at(-1);
      this.add(e);
      const last = s.undoStack.at(-1);
      if (this.run != null && prev?.id === this.run && last !== prev) { s.undoStack.pop(); prev.ops.push(...last.ops); } else this.run = last?.id ?? null;
    }
    text(s) {
      if (this.step === 'center') return false;
      const v = numOf(s);
      if (v === null) return false;
      if (this.step === 'inside') { if (v >= 0) { this.inside = v; this.step = 'outside'; } else this.h.toast('The inside diameter cannot be negative.'); }
      else if (v > 0) { this.outside = v; this.step = 'center'; } else this.h.toast('The outside diameter must be positive.');
      return true;
    }
    key(e) {
      if (e.key === 'Enter') {
        if (this.step === 'inside') this.step = 'outside';
        else if (this.step === 'outside') this.step = 'center';
        else this.cancel();
        return true;
      }
      if (e.key === 'Escape') { this.cancel(); return true; }
      return false;
    }
    draw(c) {
      if (this.step !== 'center') return;
      const s = this.vp.toScreen(this.vp.cursor), z = this.vp.view.zoom;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
      for (const d of [this.inside, this.outside]) if (d > 0) { c.beginPath(); c.arc(s.x, s.y, (d / 2) * z, 0, Math.PI * 2); c.stroke(); }
    }
  }

  return { polygon: new PolygonTool(h), spline: new SplineTool(h), donut: new DonutTool(h) };
}
