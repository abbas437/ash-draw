// ASH Draw Studio - MEASUREGEOM (MEA) and AREA, after AutoCAD LT: distance, radius, angle and area
// (points or object, with Add / Subtract running totals). Results go to a docked panel that stays until closed.
import { entityMeasure, loopMeasure, AreaTotal, angleAt, unitLabel, formatLength, showLegsFrom } from '../src/core/measure.js';
import { tessellate, ccwSweep, dist, DEG } from '../src/core/geom.js';
import { viewportAt, viewportScale, paperToModel, viewportPrintScale } from '../src/core/layouts.js';
import { findHatchBoundary } from './tools.js';
import { angleFromWorld } from '../src/core/coords.js';
import { el, toast } from './ui.js';
import { unitsOf, ensureUnits } from './units-ask.js';

const f4 = (v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4).replace(/\.?0+$/, '');
const FILL = 'rgba(42,140,200,0.2)';

/** straight segment of a LINE or LWPOLYLINE nearest to p (arcs excluded), or null */
function segmentAt(e, p) {
  if (e.type === 'LINE') return [e.p1, e.p2];
  if (e.type !== 'LWPOLYLINE') return null;
  const v = e.vertices, n = e.closed ? v.length : v.length - 1;
  let best = null, bd = Infinity;
  for (let i = 0; i < n; i++) {
    if (v[i].bulge) continue;
    const a = v[i], b = v[(i + 1) % v.length], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < bd) { bd = d; best = [a, b]; }
  }
  return best;
}

/** vertex and the two picked-side points of two picked segments, or null when they are parallel */
function angleGeom(A, B) {
  const [a1, a2] = A.seg, [b1, b2] = B.seg;
  const r = { x: a2.x - a1.x, y: a2.y - a1.y }, s = { x: b2.x - b1.x, y: b2.y - b1.y }, den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12 * Math.hypot(r.x, r.y) * Math.hypot(s.x, s.y)) return null;
  const t = ((b1.x - a1.x) * s.y - (b1.y - a1.y) * s.x) / den, I = { x: a1.x + t * r.x, y: a1.y + t * r.y };
  const side = ({ seg: [p, q], at }) => {
    const d = { x: q.x - p.x, y: q.y - p.y }, L = Math.hypot(d.x, d.y), k = ((at.x - I.x) * d.x + (at.y - I.y) * d.y) / L;
    if (Math.abs(k) > 1e-9 * L) return { x: I.x + (d.x / L) * k, y: I.y + (d.y / L) * k };
    return dist(I, p) > dist(I, q) ? p : q;
  };
  return { v: I, a: side(A), b: side(B) };
}

/** angle (degrees) between two picked segments, measured at their intersection on the sides that were picked */
function angleBetween(A, B) {
  const g = angleGeom(A, B);
  return g ? angleAt(g.v, g.a, g.b) : 0;
}

// ---- measurement markers: drawn on the view only (not entities: never saved, never undoable) ----------
// Kept while the results panel is open, even after the command ends; a new measurement or closing the panel clears them.
let marks = null, marksVp = null;
const MARK = '#00d0ff';
// "Show ΔX / ΔY" (results panel check box, setting 'measure.showLegs'): the dotted legs of a distance; off by default
let showLegs = false;
/** apply the saved setting (app start-up) */
export function setShowLegs(v) { showLegs = showLegsFrom(v); syncLegsBox(); marksVp?.requestRender(); }
export const legsShown = () => showLegs;
function syncLegsBox() { const b = panel?.querySelector('.mp-legs input'); if (b) b.checked = showLegs; }
function setMarks(vp, m) { marks = m; marksVp = vp; vp.requestRender(); }
/** accent stroke over a wider contrasting outline, so it reads on the dark and the light model background */
function strokeMark(c, vp, dash) {
  c.setLineDash([]); c.lineWidth = 3.5; c.strokeStyle = (vp.overlayDark ?? vp.settings.dark) ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)'; c.stroke();
  c.setLineDash(dash); c.lineWidth = 1.5; c.strokeStyle = MARK; c.stroke(); c.setLineDash([]);
}
function drawMarks(c, vp) {
  if (!marks) return;
  const S = (q) => vp.toScreen(q), m = marks;
  const line = (pts, dash, closed) => {
    c.beginPath(); pts.forEach((q, i) => { const s = S(q); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
    if (closed) c.closePath(); strokeMark(c, vp, dash);
  };
  const cross = (q) => { const s = S(q), k = 6; c.beginPath(); c.moveTo(s.x - k, s.y); c.lineTo(s.x + k, s.y); c.moveTo(s.x, s.y - k); c.lineTo(s.x, s.y + k); strokeMark(c, vp, []); };
  c.save();
  if (m.a && m.b) {
    if (showLegs) line([m.a, { x: m.b.x, y: m.a.y }, m.b], [2, 3]); // dotted DeltaX / DeltaY legs (option)
    line([m.a, m.b], [6, 4]);
    cross(m.a); cross(m.b);
    if (m.label) { // the value beside the middle of the measured line
      const s = S({ x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 });
      c.font = '12px "Segoe UI", sans-serif'; c.lineWidth = 3; c.strokeStyle = (vp.overlayDark ?? vp.settings.dark) ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)';
      c.strokeText(m.label, s.x + 8, s.y - 8); c.fillStyle = MARK; c.fillText(m.label, s.x + 8, s.y - 8);
    }
  }
  if (m.shape) {
    c.beginPath(); for (const pl of m.shape) pl.forEach((q, i) => { const s = S(q); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
    c.fillStyle = FILL; c.fill('evenodd');
    for (const pl of m.shape) if (pl.length > 1) line(pl, [6, 4], true);
  }
  if (m.arc) { // circle / arc (a0..a1 in degrees, counter-clockwise) with its centre
    const s = S(m.arc.c);
    c.beginPath();
    if (m.arc.a0 == null) c.arc(s.x, s.y, m.arc.r * vp.view.zoom, 0, Math.PI * 2);
    else c.arc(s.x, s.y, m.arc.r * vp.view.zoom, -m.arc.a0 * DEG, -m.arc.a1 * DEG, true);
    strokeMark(c, vp, [6, 4]); cross(m.arc.c);
  }
  if (m.angle) { line([m.angle.a, m.angle.v, m.angle.b], [6, 4]); cross(m.angle.v); }
  c.restore();
}

// ---- docked results panel -----------------------------------------------------------------------
let panel = null, last = null;
/** the open results panel follows a change of drawing units / precision (UNITS): its last result is formatted again */
export function refreshMeasureResults() {
  if (!panel?.isConnected || !last) return;
  showResults(last.title, last.make);
  if (marks?.a && last.label) { marks.label = last.label(); marksVp?.requestRender(); }
}
/** the open results panel and its marks belong to one drawing: close them when the drawing is switched away or closed,
 *  so the result is never shown again in another drawing's units */
export function clearMeasureResults() {
  const had = !!panel?.isConnected;
  panel?.remove(); panel = null; last = null;
  if (marks && marksVp) setMarks(marksVp, null);
  return had;
}
function showResults(title, make, label = null) {
  last = { title, make, label };
  const { lines, units } = make();
  if (!panel?.isConnected) {
    const body = el('pre', { class: 'mp-body' });
    const copy = () => {
      const txt = body.textContent;
      const fallback = () => { const r = document.createRange(); r.selectNodeContents(body); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); };
      (navigator.clipboard?.writeText(txt) ?? Promise.reject()).catch(fallback).finally(() => toast('Copied', 1200));
    };
    panel = el('div', { id: 'measure-panel', role: 'region', 'aria-label': 'Measure results' },
      el('div', { class: 'phead' }, el('span', { class: 'mp-title' }), el('span', { class: 'spacer' }),
        el('button', { class: 'mp-copy', title: 'Copy the results', onclick: copy }, 'Copy'),
        el('button', { class: 'mp-close', title: 'Close', 'aria-label': 'Close', onclick: () => { panel.remove(); if (marks) setMarks(marksVp, null); } }, '×')),
      body, el('div', { class: 'mp-foot' }, el('span', { class: 'mp-units' }), el('span', { class: 'spacer' }),
        el('label', { class: 'mp-legs', title: 'Draw the horizontal and vertical legs of a measured distance' },
          el('input', { type: 'checkbox', onchange: (e) => { showLegs = e.target.checked; window.api?.settingsSet?.('measure.showLegs', showLegs)?.catch?.(() => {}); marksVp?.requestRender(); } }), ' Show ΔX / ΔY')));
    document.getElementById('stage').append(panel);
  }
  panel.querySelector('.mp-title').textContent = title;
  panel.querySelector('.mp-body').textContent = lines.join('\n');
  panel.querySelector('.mp-units').textContent = `Units: ${units || 'unitless'}`;
  syncLegsBox();
}

// ---- the tool -----------------------------------------------------------------------------------
const MEA_OPTIONS = { d: 'distance', distance: 'distance', r: 'radius', radius: 'radius', n: 'angle', a: 'angle', angle: 'angle', ar: 'area', area: 'area' };

export class MeasureGeomTool {
  /** command = 'MEASUREGEOM' (MEA, DI, DIST: starts in Distance) or 'AREA' (area only) */
  constructor(host, command = 'MEASUREGEOM') { this.h = host; this.vp = host.vp; this.command = command; }
  activate() { this.vp.preview = (c) => this.draw(c); this.setMode(this.command === 'AREA' ? 'area' : 'distance'); this.askUnits(); }
  /** a unitless drawing: ask once (per tab, this session) what a unit is before the first readout; Cancel ends the command */
  async askUnits() {
    const tab = this.h.active;
    if (!tab || unitsOf(tab)) return;
    const u = await ensureUnits(tab);
    if (this.h.tool !== this || this.h.active !== tab) return;
    if (u == null) this.h.setTool('select'); else { this.h.refreshStatus?.(); this.h.refreshPrompt?.(); }
  }
  deactivate() {
    // the markers outlive the command while the results panel is open: leave a marks-only painter behind
    this.vp.preview = marks && panel?.isConnected ? (c, v, vp) => drawMarks(c, vp ?? this.vp) : null;
    this.vp.rubber = null; this.reset(); this.shape = null;
  }
  cancel() { this.h.setTool('select'); }
  rightClick() { this.key({ key: 'Enter' }); }
  up(p, ev) { if (!ev.dragged) this.click(p, ev); }
  setMode(m) { if (marks) setMarks(this.vp, null); this.mode = m; this.total = null; this.sub = m === 'area' ? 'points' : 'pick'; this.reset(); this.shape = null; }
  reset() { this.pts = []; this.picked = null; this.vp.lastPoint = null; this.vports = null; }

  /** on a layout in paper space: the model viewport (not the overall paper one) that every one of the paper points
   *  `pts` lies in, so a measurement through it reports the model value; null in Model and in MSPACE (the points are
   *  model coordinates there), and when the points are outside any viewport or in different ones */
  throughViewport(pts) {
    const vp = this.vp;
    if (!vp.layout || vp.mspace || !pts.length) return null;
    // kept for the rubber band: the viewports and their clip boundaries (viewportAt tests a clipped one against its boundary)
    const vports = (this.vports ??= ((all) => {
      const clips = new Set(all.filter((e) => e.type === 'VIEWPORT' && e.clipId).map((e) => e.clipId));
      return all.filter((e) => e.type === 'VIEWPORT' || clips.has(e.id));
    })(vp.doc.entities));
    const v = viewportAt(vports, pts[0]);
    return v && pts.every((q) => viewportAt(vports, q) === v) ? v : null;
  }
  /** the model value through viewport v first, the sheet value second: '810.31 mm  (sheet 16.21 mm, viewport 1:50)' */
  dual(model, sheet, v, fmt) {
    const n = +viewportPrintScale(v, this.vp.layout.plot, this.fileUnits).toPrecision(6);
    return `${fmt(model)}  (sheet ${fmt(sheet)}, viewport 1:${n})`;
  }

  /** units and precision belong to the whole drawing (UNITS), also while a layout is shown */
  get file() { return this.h.fileDoc ?? this.vp.doc; }
  /** $INSUNITS, or the unit chosen for a unitless drawing this session */
  get fileUnits() { return this.h.active ? unitsOf(this.h.active) : this.file.units; }
  get units() { return unitLabel(this.fileUnits); }
  len(v) { return formatLength(v, this.file.header?.luprec, this.fileUnits); }
  area(v) { return formatLength(v, this.file.header?.luprec, this.fileUnits, 2); }
  /** lines() is called again when the units change while the panel is open */
  result(title, lines, label = null) { showResults(title, () => ({ lines: lines(), units: this.units }), label); }

  get prompt() {
    const head = this.command === 'AREA' ? 'AREA' : 'MEASUREGEOM';
    const mea = this.command === 'AREA' ? '' : '   [Distance/Radius/aNgle/ARea/eXit]';
    switch (this.mode) {
      case 'distance': return `${head}  ${this.pts.length ? 'second point' : 'first point'}${mea}`;
      case 'radius': return `${head}  select an arc or circle${mea}`;
      case 'angle':
        if (this.sub === 'vertex') return `${head}  ${['angle vertex', 'first end point of angle', 'second end point of angle'][this.pts.length]}${mea}`;
        return `${head}  ${this.picked ? 'select second line' : 'select an arc or line, or Enter to specify a vertex'}${mea}`;
      default: {
        const tag = this.total ? `(${this.total.mode.toUpperCase()} mode) ` : '';
        if (this.sub === 'object') return `${head}  ${tag}select a closed object, or click inside a closed shape (Enter = points)`;
        if (this.pts.length) return `${head}  ${tag}next point (C or Enter = close, U = undo)`;
        const opts = !this.total ? 'Object/Add area/Subtract area/eXit' : this.total.mode === 'add' ? 'Object/Subtract area/eXit' : 'Object/Add area/eXit';
        return `${head}  ${tag}first corner point or [${opts}] <Object>${this.command === 'AREA' ? '' : mea}`;
      }
    }
  }

  text(s) {
    const t = s.trim().toLowerCase();
    const done = () => { this.vp.requestRender(); return true; };
    if (this.mode === 'area') {
      if (t === 'o' || t === 'object') { this.pts = []; this.vp.lastPoint = null; this.sub = 'object'; return done(); }
      if (t === 'a' || t === 'add' || t === 's' || t === 'subtract') {
        this.total ??= new AreaTotal();
        this.total.mode = t[0] === 'a' ? 'add' : 'subtract';
        this.reset(); this.sub = 'points';
        return done();
      }
      if (t === 'c' && this.pts.length > 2) { this.closeArea(); return done(); }
      if (t === 'u' && this.pts.length) { this.pts.pop(); this.vp.lastPoint = this.pts.at(-1) ?? null; return done(); }
    }
    if (t === 'x' || t === 'exit') { this.cancel(); return true; }
    if (this.mode === 'angle' && t === 'v' && !this.picked) { this.sub = 'vertex'; this.pts = []; return done(); }
    if (this.command === 'AREA' || !MEA_OPTIONS[t]) return false;
    this.setMode(MEA_OPTIONS[t]);
    return done();
  }

  click(p, ev) {
    const raw = ev?.raw ?? p;
    if (this.mode === 'distance') {
      if (!this.pts.length) { setMarks(this.vp, null); this.pts = [p]; this.vp.lastPoint = p; return; }
      // through a layout viewport the result is the model distance (scale and twist), the sheet distance second
      const a = this.pts[0], v = this.throughViewport([a, p]);
      const A = v ? paperToModel(v, a) : a, B = v ? paperToModel(v, p) : p, ang = angleFromWorld(Math.atan2(B.y - A.y, B.x - A.x) / DEG, this.file.header);
      const label = () => this.len(dist(A, B));
      const d = () => (v ? this.dual(dist(A, B), dist(a, p), v, (x) => this.len(x)) : this.len(dist(a, p)));
      this.reset(); setMarks(this.vp, { a, b: p, label: label() });
      this.result('Distance', () => [`Distance = ${d()}`, `Delta X = ${this.len(B.x - A.x)}, Delta Y = ${this.len(B.y - A.y)}`, `Angle in XY plane = ${f4(ang)}°`], label);
    } else if (this.mode === 'radius') {
      const e = this.vp.pick(raw);
      if (!e || !['CIRCLE', 'ARC'].includes(e.type)) { toast('Select an arc or a circle.'); return; }
      setMarks(this.vp, { arc: { c: e.c, r: e.r, a0: e.type === 'ARC' ? e.a0 : null, a1: e.a1 } });
      const v = this.throughViewport([e.c, raw]), s = v ? viewportScale(v) : 1, r = e.r;
      const L = (x) => (v ? this.dual(x * s, x, v, (y) => this.len(y)) : this.len(x));
      this.result('Radius', () => [`Radius = ${L(r)}`, `Diameter = ${L(2 * r)}`]);
    } else if (this.mode === 'angle') this.clickAngle(p, raw);
    else if (this.sub === 'object') this.pickArea(raw);
    else { if (!this.pts.length) setMarks(this.vp, null); this.pts.push(p); this.vp.lastPoint = p; }
  }

  clickAngle(p, raw) {
    if (this.sub === 'vertex') {
      this.pts.push(p); this.vp.lastPoint = p;
      if (this.pts.length < 3) return;
      const [v, a, b] = this.pts;
      this.reset(); this.sub = 'pick'; setMarks(this.vp, { angle: { v, a, b } });
      this.result('Angle', () => [`Angle = ${f4(angleAt(v, a, b))}°`]);
      return;
    }
    const e = this.vp.pick(raw);
    if (!e) return;
    if (!this.picked && e.type === 'ARC') {
      const pe = (a) => ({ x: e.c.x + e.r * Math.cos(a * DEG), y: e.c.y + e.r * Math.sin(a * DEG) });
      setMarks(this.vp, { arc: { c: e.c, r: e.r, a0: e.a0, a1: e.a1 }, angle: { a: pe(e.a0), v: e.c, b: pe(e.a1) } });
      this.result('Angle', () => [`Angle = ${f4(ccwSweep(e.a0 * DEG, e.a1 * DEG) / DEG)}°`]); return; }
    const seg = segmentAt(e, raw);
    if (!seg) { toast('Select a line, a straight polyline segment or an arc.'); return; }
    if (!this.picked) { this.picked = { seg, at: raw }; return; }
    const a = this.picked; this.picked = null;
    const B = { seg, at: raw }, g = angleGeom(a, B);
    if (g) setMarks(this.vp, { angle: g });
    this.result('Angle', () => [`Angle = ${f4(angleBetween(a, B))}°`]);
  }

  pickArea(raw) {
    const doc = this.vp.doc, e = this.vp.pick(raw);
    let m = null, shape = null;
    if (e) {
      shape = tessellate(e, doc, 0);
      m = entityMeasure(e, e.type === 'SPLINE' ? shape[0] : e.type === 'HATCH' && shape.length === e.loops.length ? shape : null);
    }
    if (!m) { // nothing closed under the cursor: measure the closed boundary around the point, as HATCH finds it
      const loops = findHatchBoundary(doc, raw, this.vp);
      const b = loops && { type: 'HATCH', loops };
      if (b) { shape = tessellate(b, doc, 0); m = entityMeasure(b, shape.length === loops.length ? shape : null); }
    }
    if (!m) { toast('Select a closed polyline, circle, ellipse, hatch or closed spline, or click inside a closed shape.'); return; }
    this.addArea(m, shape);
  }

  closeArea() {
    const pts = this.pts;
    this.reset();
    this.addArea(loopMeasure(pts), [[...pts, pts[0]]]);
  }

  addArea(m, shape) {
    this.shape = shape; setMarks(this.vp, { shape });
    // through a layout viewport: model area (scale²) and perimeter (scale) first, the sheet values second
    const v = this.throughViewport(shape.flat()), s = v ? viewportScale(v) : 1;
    const t = this.total, total = t ? t.push(m.area) : null;
    let tv = null, tm = 0;
    if (t) { // a model total while every area in it came through the same viewport, else the sheet total only
      t.vp = t.vp === undefined || t.vp === v ? v : null;
      t.model = (t.model ?? 0) + (t.mode === 'subtract' ? -1 : 1) * m.area * s * s;
      tv = t.vp; tm = t.model;
    }
    const A = (x) => this.area(x), P = (x) => this.len(x);
    this.result(t ? `Area (${t.mode})` : 'Area', () => [
      ...(v ? [`Area = ${this.dual(m.area * s * s, m.area, v, A)}`, `Perimeter = ${this.dual(m.perimeter * s, m.perimeter, v, P)}`]
        : [`Area = ${A(m.area)}, Perimeter = ${P(m.perimeter)}`]),
      ...(m.loops > 1 ? [`${m.loops} loops (separate areas added, holes subtracted)`] : []),
      ...(total === null ? [] : [`Total area = ${tv ? this.dual(tm, total, tv, A) : A(total)}`])]);
  }

  key(e) {
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key !== 'Enter') return false;
    if (this.mode === 'area') {
      if (this.pts.length > 2) this.closeArea();
      else if (this.pts.length) this.reset();
      else this.sub = this.sub === 'object' ? 'points' : 'object';
    } else if (this.mode === 'angle' && this.sub === 'pick' && !this.picked) { this.sub = 'vertex'; this.pts = []; }
    else if (this.pts.length || this.picked) { this.reset(); if (this.mode === 'angle') this.sub = 'pick'; }
    else this.cancel();
    this.vp.requestRender();
    return true;
  }

  draw(c) {
    const vp = this.vp, cur = vp.cursor, S = (q) => vp.toScreen(q);
    drawMarks(c, vp);
    const path = (pts, closed) => { pts.forEach((q, i) => { const s = S(q); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); }); if (closed) c.closePath(); };
    c.setLineDash([]); c.lineWidth = 1; c.strokeStyle = vp.inkColor; c.fillStyle = FILL;
    const area = this.mode === 'area' && this.pts.length ? [[...this.pts, cur]] : null; // a finished shape is drawn by drawMarks
    if (area) {
      c.beginPath(); for (const pl of area) if (pl.length > 1) path(pl, true);
      c.fill('evenodd'); c.stroke();
    }
    if (this.mode === 'distance' && this.pts.length) {
      c.beginPath(); path([this.pts[0], cur]); c.stroke();
      const s = S(cur); c.fillStyle = vp.inkColor; c.font = '12px "Segoe UI", sans-serif';
      const a = this.pts[0], v = this.throughViewport([a, cur]); // the model distance through a layout viewport
      c.fillText(this.len(v ? dist(paperToModel(v, a), paperToModel(v, cur)) : dist(a, cur)), s.x + 14, s.y + 18);
    }
    if (this.mode === 'angle' && this.sub === 'vertex' && this.pts.length) { c.beginPath(); path([...this.pts.slice(1, 2), this.pts[0], cur]); c.stroke(); }
  }
}
