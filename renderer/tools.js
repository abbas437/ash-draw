// ASH Draw Studio - drawing and modifying tools (state machines driven by the Viewport).
//
// Tool contract (all optional except `prompt`):
//   prompt            string shown on the command line
//   activate() / deactivate() / cancel()
//   down(p,ev) move(p,ev) up(p,ev)      pointer events in world coordinates (p = snapped, ev.raw = unsnapped)
//   click(p)                            a point was chosen (mouse click or typed coordinate)
//   text(str)                           typed text; return true when consumed (numbers, options)
//   key(ev)                             keyboard; return true when consumed
//   rightClick(p)                       default: same as Enter
import {
  makeLine, makePolyline, makeRect, makeCircle, makeArc, makeEllipse, makePoint, makeText, makeMText, makeHatch,
} from '../src/core/model.js';
import {
  addEntities, moveEntities, rotateEntities, scaleEntities, mirrorEntities, eraseEntities, explodeEntities,
  offsetCommand, trimCommand, extendCommand,
} from '../src/core/edit.js';
import { MeasureGeomTool } from './tools-measure.js';
import { gripsOf, applyGrip, gripEdit, gripsStretch, matchPropsEdit, nextGripMode, GRIP_MODES, gripMatrix, gripModeEdit, MATCH_SETTINGS, defaultMatchSettings } from './grips.js';
import { el, modal, popMenu } from './ui.js';
import { createModifyTools } from './tools-modify.js';
import { createDimTools } from './tools-dims.js';
import { createBlockTools } from './tools-blocks.js';
import { createMTextTools } from './mtext-editor.js';
import { createMLeaderTools } from './tools-mleader.js';
import { createMarkupTools } from './markup.js';
import { findBoundary } from '../src/core/boundary.js';
import { tessellate, transformEntity, translation, rotation, scaling, mirrorLine, dist, DEG } from '../src/core/geom.js';

const num = (s) => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) && String(s).trim() !== '' ? v : null; };
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(4)).replace(/\.?0+$/, '');
const angleOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);

export class Tool {
  constructor(host) { this.h = host; this.vp = host.vp; }
  get prompt() { return ''; }
  activate() { this.vp.preview = (c, v) => this.draw?.(c, v); }
  deactivate() { this.vp.preview = null; this.vp.rubber = null; this.vp.lastPoint = null; }
  cancel() { this.h.setTool('select'); }
  up(p, ev) { if (!ev.dragged) this.click(p, ev); }
  rightClick() { this.key({ key: 'Enter' }); }
  key(e) { if (e.key === 'Escape') { this.cancel(); return true; } return false; }
  add(entity) { return addEntities(this.h.session, [entity])[0]; }
  props() { return this.h.newProps(); }
  report(r, verb) {
    if (r.failed?.length) this.h.toast(`${verb}: ${r.failed.length} object(s) could not be processed (${[...new Set(r.failed.map((f) => f.reason))].join(', ')})`);
  }
  line(c, a, b) { const A = this.vp.toScreen(a), B = this.vp.toScreen(b); c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y); c.stroke(); }
  dyn(c, text, p) { const s = this.vp.toScreen(p); c.fillStyle = this.vp.inkColor; c.font = '12px "Segoe UI", sans-serif'; c.fillText(text, s.x + 14, s.y + 18); }
  poly(c, pts, closed = false) {
    if (pts.length < 2) return;
    c.beginPath();
    pts.forEach((q, i) => { const s = this.vp.toScreen(q); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
    if (closed) c.closePath();
    c.stroke();
  }
}

// ---------------------------------------------------------------------------------------------
// selection helper shared by Select and the modify tools
class Selector {
  constructor(vp) { this.vp = vp; this.start = null; }
  down(p, ev) { this.start = ev.raw; }
  move(p, ev) {
    if (this.start && ev.dragging) this.vp.rubber = { a: this.start, b: ev.raw, crossing: ev.raw.x < this.start.x };
  }
  up(p, ev) {
    const a = this.start; this.start = null; this.vp.rubber = null;
    if (!a) return false;
    const vp = this.vp, base = ev.shiftKey ? new Set(vp.selection) : new Set();
    if (ev.dragged) {
      for (const id of vp.box(a, ev.raw, ev.raw.x < a.x)) base.add(id);
      vp.setSelection(base);
    } else {
      const hit = vp.pick(ev.raw);
      if (hit) { if (ev.shiftKey && vp.selection.has(hit.id)) base.delete(hit.id); else base.add(hit.id); vp.setSelection(base); }
      else if (!ev.shiftKey) vp.setSelection([]);
    }
    return true;
  }
}

const GRIP_ASK = { STRETCH: 'specify stretch point', MOVE: 'specify move point (or @dx,dy)', ROTATE: 'specify rotation angle (click or type degrees)', SCALE: 'specify scale factor (click or type)', MIRROR: 'specify second point of mirror line' };
/** Select + grip editing. A hot grip starts ** STRETCH **; Space / Enter cycles the modes (grips.js GRIP_MODES).
 *  MOVE/ROTATE/SCALE/MIRROR act on the whole selection about the base point (the hot grip, or B = new base point).
 *  C = Copy: originals stay and each pick adds copies until Enter / Esc; the whole grip command is ONE undo step. */
class SelectTool extends Tool {
  constructor(h) { super(h); this.sel = new Selector(this.vp); this.hot = null; this.multi = []; }
  setMulti(m) { this.multi = m; this.vp.gripHots = m.length ? m : null; this.vp.requestRender(); }
  get prompt() {
    if (!this.hot) return 'Select objects (drag right-to-left = crossing, Shift = add/remove)';
    if (this.pickBase) return `** ${this.mode} **  specify base point`;
    const done = this.copy && this.step != null ? ', Enter = done' : ', Space/Enter = next mode';
    return `** ${this.mode}${this.copy ? ' (multiple)' : ''} **  ${GRIP_ASK[this.mode]}  [B = base point, C = copy${done}, Esc = exit]`;
  }
  /** grip under the screen point -> {id, i, base} (5 px pick box) */
  gripAt(sx, sy) {
    if (!this.vp.selection.size || this.vp.selection.size > 300) return null;
    for (const e of this.vp.selectedEntities()) {
      const gs = gripsOf(e);
      for (let i = 0; i < gs.length; i++) { const s = this.vp.toScreen(gs[i]); if (Math.abs(s.x - sx) <= 5 && Math.abs(s.y - sy) <= 5) return { id: e.id, i, base: { x: gs[i].x, y: gs[i].y } }; }
    }
    return null;
  }
  setHover(g) { this.vp.gripHover = g; }
  down(p, ev) {
    if (this.hot) return;
    const g = this.gripAt(ev.sx, ev.sy), same = (a) => a.id === g?.id && a.i === g?.i;
    if (g && ev.shiftKey) { this.setMulti(this.multi.some(same) ? this.multi.filter((a) => !same(a)) : [...this.multi, g]); return; } // Shift-click: make grips hot
    if (g) {
      Object.assign(this, { hot: g, fresh: true, mode: 'STRETCH', base: g.base, copy: false, step: null, pickBase: false });
      this.hots = this.multi.some(same) ? this.multi : [g];
      this.vp.gripHot = g; this.vp.lastPoint = g.base; this.h.refreshPrompt(); return;
    }
    if (this.multi.length) this.setMulti([]);
    this.sel.down(p, ev);
  }
  move(p, ev) {
    if (this.hot) return;
    this.sel.move(p, ev);
    if (!ev.dragging) this.setHover(this.gripAt(ev.sx, ev.sy));
  }
  up(p, ev) {
    if (this.hot) { if (this.fresh && !ev.dragged) { this.fresh = false; return; } this.fresh = false; this.place(p); return; } // click-click or drag-release
    this.sel.up(p, ev);
  }
  click(p) { if (this.hot) this.place(p); } // typed coordinate
  place(p) {
    if (this.pickBase) { this.base = p; this.vp.lastPoint = p; this.pickBase = false; this.h.refreshPrompt(); return; }
    if (this.mode !== 'STRETCH') { this.apply({ p }); return; }
    const g = this.hot, hots = this.hots;
    this.endGrip();
    const ok = hots.length > 1 ? gripsStretch(this.h.session, hots, { x: p.x - g.base.x, y: p.y - g.base.y }) : gripEdit(this.h.session, g.id, g.i, p);
    if (!ok) this.h.toast('That grip edit cannot be applied.');
  }
  apply(arg) {
    const ids = [...this.vp.selection];
    const r = gripModeEdit(this.h.session, ids, this.mode, this.base, arg, { copy: this.copy, join: this.step });
    if (!r) { this.h.toast(`${this.mode}: that point gives no transformation.`); return; }
    this.report(r, this.mode);
    if (this.copy) { this.step = r.step; this.vp.lastPoint = this.base; this.h.refreshPrompt(); this.vp.requestRender(); return; }
    this.endGrip();
  }
  text(s) {
    if (!this.hot) return false;
    const low = s.trim().toLowerCase(), v = num(s);
    if (low === 'c' || low === 'copy') { this.copy = !this.copy; this.h.refreshPrompt(); return true; }
    if (low === 'b' || low === 'base') { this.pickBase = true; this.h.refreshPrompt(); return true; }
    if (low === 'x' || low === 'exit') { this.endGrip(); return true; }
    if (v !== null && !this.pickBase && (this.mode === 'ROTATE' || this.mode === 'SCALE')) { this.apply({ value: v }); return true; }
    return false;
  }
  endGrip() { this.hot = null; this.fresh = false; this.step = null; this.pickBase = false; this.vp.gripHot = null; this.setMulti([]); this.vp.lastPoint = null; this.h.refreshPrompt(); this.vp.requestRender(); }
  key(e) {
    if (e.key === 'Escape') { if (this.hot) this.endGrip(); else this.cancel(); return true; }
    if (this.hot && (e.key === 'Enter' || e.key === ' ')) {
      if (this.copy && this.step != null) this.endGrip();
      else { this.mode = nextGripMode(this.mode); this.pickBase = false; this.h.refreshPrompt(); this.vp.requestRender(); }
      return true;
    }
    return false;
  }
  cancel() { if (this.hot) this.endGrip(); this.setMulti([]); this.vp.setSelection([]); }
  rightClick(p, ev) {
    if (!this.hot) { this.key({ key: 'Enter' }); return; }
    const go = (m) => () => { this.mode = m; this.pickBase = false; this.h.refreshPrompt(); this.vp.requestRender(); };
    popMenu(ev, [
      ...GRIP_MODES.map((m) => [m[0] + m.slice(1).toLowerCase(), go(m)]),
      ['Base point', () => { this.pickBase = true; this.h.refreshPrompt(); }],
      [this.copy ? 'Copy (on)' : 'Copy', () => { this.copy = !this.copy; this.h.refreshPrompt(); }],
      ['Exit', () => this.endGrip()],
    ]);
  }
  deactivate() { super.deactivate(); this.sel.start = null; this.hot = null; this.setMulti([]); this.vp.gripHot = null; this.vp.gripHover = null; }
  draw(c) {
    if (!this.hot || this.pickBase) return;
    const q = this.vp.cursor;
    if (this.mode === 'STRETCH') {
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
      const d = { x: q.x - this.hot.base.x, y: q.y - this.hot.base.y };
      for (const h of this.hots) {
        const e = this.vp.doc.entities.find((x) => x.id === h.id);
        const ne = e && applyGrip(e, h.i, { x: h.base.x + d.x, y: h.base.y + d.y });
        if (ne) for (const pl of tessellate(ne, this.vp.doc, 0.5 / this.vp.view.zoom)) this.poly(c, pl);
      }
    } else {
      const m = gripMatrix(this.mode, this.base, { p: q });
      if (m) ghost(this.vp, [...this.vp.selection], m)(c);
    }
    c.strokeStyle = this.vp.inkColor; this.line(c, this.base, q);
  }
}

/** MATCHPROP: pick a source object, then destination objects (click or window); Enter/Esc ends */
class MatchPropTool extends Tool {
  constructor(h) { super(h); this.sel = new Selector(this.vp); }
  activate() { super.activate(); this.src = null; this.vp.setSelection([]); this.settings ??= defaultMatchSettings(); } // remembered for the session
  get prompt() { return this.src ? 'MATCHPROP  select destination object(s) (click or window, S = settings, Enter = done)' : 'MATCHPROP  select source object'; }
  text(s) {
    if (!this.src || !['s', 'settings'].includes(s.trim().toLowerCase())) return false;
    this.editSettings();
    return true;
  }
  async editSettings() {
    const boxes = MATCH_SETTINGS.map(([k, label]) => el('label', {}, el('input', { type: 'checkbox', name: k, checked: this.settings[k] }), ` ${label}`));
    const ok = await modal('Property Settings', el('div', { class: 'match-settings' }, boxes),
      [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (ok) for (const b of boxes) { const i = b.querySelector('input'); this.settings[i.name] = i.checked; }
    this.vp.canvas.focus();
  }
  down(p, ev) { if (this.src) this.sel.down(p, ev); }
  move(p, ev) { if (this.src) this.sel.move(p, ev); }
  up(p, ev) {
    if (!this.src) {
      const hit = this.vp.pick(ev.raw);
      if (hit) { this.src = hit; this.vp.setSelection([hit.id]); }
      return;
    }
    this.sel.up(p, ev);
    const ids = [...this.vp.selection].filter((id) => id !== this.src.id);
    this.vp.setSelection([this.src.id]);
    if (!ids.length) return;
    matchPropsEdit(this.h.session, this.src, ids, this.settings);
  }
  key(e) { if (e.key === 'Escape' || e.key === 'Enter') { this.vp.setSelection([]); this.h.setTool('select'); return true; } return false; }
}

// ---------------------------------------------------------------------------------------------
// drawing tools
class LineTool extends Tool {
  activate() { super.activate(); this.last = null; this.first = null; this.count = 0; }
  get prompt() { return this.last ? 'LINE  next point (U = undo, C = close, Enter = end)' : 'LINE  first point'; }
  click(p) {
    if (this.last) {
      this.add(makeLine(this.last, p, this.props()));
      this.count++;
    } else this.first = p;
    this.last = p; this.vp.lastPoint = p;
  }
  text(s) {
    const t = s.trim().toLowerCase();
    if (t === 'u' && this.count) { this.h.session.undo(); this.count--; this.last = this.count ? this.vp.doc.entities.at(-1).p2 : this.first; this.vp.lastPoint = this.last; return true; }
    if (t === 'c' && this.count > 1) { this.add(makeLine(this.last, this.first, this.props())); this.finish(); return true; }
    return false;
  }
  finish() { this.last = null; this.vp.lastPoint = null; this.count = 0; }
  key(e) { if (e.key === 'Enter' || e.key === 'Escape') { if (this.last) { this.finish(); return true; } if (e.key === 'Escape') this.cancel(); return true; } return false; }
  draw(c) {
    if (!this.last) return;
    c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); this.line(c, this.last, this.vp.cursor);
    this.dyn(c, `${fmt(dist(this.last, this.vp.cursor))} < ${fmt(((angleOf(this.last, this.vp.cursor) / DEG) + 360) % 360)}°`, this.vp.cursor);
  }
}

class PolylineTool extends Tool {
  activate() { super.activate(); this.pts = []; }
  get prompt() { return this.pts.length ? 'PLINE  next point (U = undo point, C = close, Enter = finish, Esc = cancel)' : 'PLINE  first point'; }
  click(p) { this.pts.push(p); this.vp.lastPoint = p; }
  text(s) {
    const t = s.trim().toLowerCase();
    if (t === 'u') { this.pts.pop(); this.vp.lastPoint = this.pts.at(-1) ?? null; return true; }
    if (t === 'c' && this.pts.length > 2) { this.commit(true); return true; }
    return false;
  }
  commit(closed = false) {
    if (this.pts.length > 1) this.add(makePolyline(this.pts, closed, this.props()));
    this.pts = []; this.vp.lastPoint = null;
  }
  key(e) {
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Escape') { if (this.pts.length) { this.pts = []; this.vp.lastPoint = null; } else this.cancel(); return true; }
    return false;
  }
  draw(c) {
    if (!this.pts.length) return;
    c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); this.poly(c, [...this.pts, this.vp.cursor]);
  }
}

class RectTool extends Tool {
  activate() { super.activate(); this.a = null; }
  get prompt() { return this.a ? 'RECTANGLE  opposite corner (or @width,height)' : 'RECTANGLE  first corner'; }
  click(p) {
    if (!this.a) { this.a = p; this.vp.lastPoint = p; return; }
    if (Math.abs(p.x - this.a.x) > 1e-12 && Math.abs(p.y - this.a.y) > 1e-12) this.add(makeRect(this.a, p, this.props()));
    this.a = null; this.vp.lastPoint = null;
  }
  key(e) { if (e.key === 'Escape') { if (this.a) { this.a = null; this.vp.lastPoint = null; } else this.cancel(); return true; } return e.key === 'Enter'; }
  draw(c) {
    if (!this.a) return;
    const q = this.vp.cursor;
    c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
    this.poly(c, [this.a, { x: q.x, y: this.a.y }, q, { x: this.a.x, y: q.y }], true);
    this.dyn(c, `${fmt(Math.abs(q.x - this.a.x))} × ${fmt(Math.abs(q.y - this.a.y))}`, q);
  }
}

class CircleTool extends Tool {
  activate() { super.activate(); this.c = null; }
  get prompt() { return this.c ? 'CIRCLE  radius (click or type)' : 'CIRCLE  center point'; }
  click(p) {
    if (!this.c) { this.c = p; this.vp.lastPoint = p; return; }
    const r = dist(this.c, p);
    if (r > 1e-12) this.add(makeCircle(this.c, r, this.props()));
    this.c = null; this.vp.lastPoint = null;
  }
  text(s) {
    const v = num(s);
    if (this.c && v > 0) { this.add(makeCircle(this.c, v, this.props())); this.c = null; this.vp.lastPoint = null; return true; }
    return false;
  }
  key(e) { if (e.key === 'Escape') { if (this.c) { this.c = null; this.vp.lastPoint = null; } else this.cancel(); return true; } return e.key === 'Enter'; }
  draw(c) {
    if (!this.c) return;
    const r = dist(this.c, this.vp.cursor), s = this.vp.toScreen(this.c);
    c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); c.beginPath(); c.arc(s.x, s.y, r * this.vp.view.zoom, 0, Math.PI * 2); c.stroke();
    this.line(c, this.c, this.vp.cursor); this.dyn(c, `R ${fmt(r)}`, this.vp.cursor);
  }
}

/** circle through three points -> {c, r} or null */
export function circleFrom3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}
/** ARC entity (CCW degrees) passing through start a, point b, end c */
export function arcFrom3(a, b, c) {
  const k = circleFrom3(a, b, c);
  if (!k) return null;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); // >0 : a->b->c turns left (CCW)
  const s = Math.atan2(a.y - k.c.y, a.x - k.c.x) / DEG, e = Math.atan2(c.y - k.c.y, c.x - k.c.x) / DEG;
  return cross > 0 ? { c: k.c, r: k.r, a0: s, a1: e } : { c: k.c, r: k.r, a0: e, a1: s };
}

class ArcTool extends Tool {
  activate() { super.activate(); this.pts = []; }
  get prompt() { return ['ARC  start point', 'ARC  second point (on the arc)', 'ARC  end point'][this.pts.length]; }
  click(p) {
    this.pts.push(p);
    if (this.pts.length < 3) { this.vp.lastPoint = p; return; }
    const a = arcFrom3(...this.pts);
    if (a) this.add(makeArc(a.c, a.r, ((a.a0 % 360) + 360) % 360, ((a.a1 % 360) + 360) % 360, this.props()));
    else this.h.toast('The three points are in a line.');
    this.pts = []; this.vp.lastPoint = null;
  }
  key(e) { if (e.key === 'Escape') { if (this.pts.length) { this.pts = []; this.vp.lastPoint = null; } else this.cancel(); return true; } return e.key === 'Enter'; }
  draw(c) {
    const q = this.vp.cursor; c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
    if (this.pts.length === 1) this.line(c, this.pts[0], q);
    if (this.pts.length === 2) {
      const a = arcFrom3(this.pts[0], this.pts[1], q);
      if (!a) { this.poly(c, [...this.pts, q]); return; }
      const s = this.vp.toScreen(a.c);
      c.beginPath(); c.arc(s.x, s.y, a.r * this.vp.view.zoom, -a.a0 * DEG, -a.a1 * DEG, true); c.stroke();
    }
  }
}

class EllipseTool extends Tool {
  activate() { super.activate(); this.pts = []; }
  get prompt() { return ['ELLIPSE  center', 'ELLIPSE  end of first axis', 'ELLIPSE  distance to the other axis'][this.pts.length]; }
  click(p) {
    this.pts.push(p);
    if (this.pts.length < 3) { this.vp.lastPoint = p; return; }
    const [c, m, q] = this.pts;
    const major = { x: m.x - c.x, y: m.y - c.y }, L = Math.hypot(major.x, major.y);
    const perp = Math.abs(((q.x - c.x) * -major.y + (q.y - c.y) * major.x) / L);
    if (L > 1e-12 && perp > 1e-12) this.add(makeEllipse(c, major, Math.min(1, perp / L), 0, Math.PI * 2, this.props()));
    this.pts = []; this.vp.lastPoint = null;
  }
  key(e) { if (e.key === 'Escape') { if (this.pts.length) { this.pts = []; this.vp.lastPoint = null; } else this.cancel(); return true; } return e.key === 'Enter'; }
  draw(c) {
    const q = this.vp.cursor; c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
    if (this.pts.length === 1) this.line(c, this.pts[0], q);
    if (this.pts.length === 2) {
      const [cc, m] = this.pts, major = { x: m.x - cc.x, y: m.y - cc.y }, L = Math.hypot(major.x, major.y);
      if (L < 1e-12) return;
      const perp = Math.abs(((q.x - cc.x) * -major.y + (q.y - cc.y) * major.x) / L);
      const s = this.vp.toScreen(cc), z = this.vp.view.zoom;
      c.beginPath(); c.ellipse(s.x, s.y, L * z, Math.max(perp * z, 0.5), -Math.atan2(major.y, major.x), 0, Math.PI * 2); c.stroke();
    }
  }
}

class PointTool extends Tool {
  get prompt() { return 'POINT  location'; }
  click(p) { this.add(makePoint(p, this.props())); }
}

class TextTool extends Tool {
  get prompt() { return 'TEXT  insertion point'; }
  async click(p) {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.h.askText({ title: 'Add text', value: '', height: this.h.defaults.textHeight ?? this.autoHeight() });
      if (r && r.text.trim()) {
        this.h.defaults.textHeight = r.height;
        const lines = r.text.replace(/\r/g, '').split('\n');
        const e = lines.length > 1 ? makeMText(p, r.height, lines.join('\\P'), { ...this.props(), width: 0 }) : makeText(p, r.height, lines[0], this.props());
        this.add(e);
      }
    } finally { this.busy = false; }
  }
  autoHeight() { const v = this.vp.view; return +(v.height / v.zoom / 50).toPrecision(2); }
}

// ---- hatch: click inside a closed region (AutoCAD "pick internal point") ---------------------------
/** smallest closed region around p formed by lines, arcs, polylines, circles, ellipses, splines (also in blocks)
 *  visible in the current view; hatch loops (outer first, then islands) or null */
export function findHatchBoundary(doc, p, vp = null) {
  let view = null;
  if (vp?.view?.width && vp.view.height) {
    const a = vp.toWorld(0, 0), b = vp.toWorld(vp.view.width, vp.view.height);
    view = { minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y), maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y) };
  }
  return findBoundary(doc, p, { view });
}

class HatchTool extends Tool {
  get prompt() { return 'HATCH  pick an internal point'; }
  click(p, ev) {
    const loops = findHatchBoundary(this.vp.doc, ev?.raw ?? p, this.vp);
    if (!loops) { this.h.toast('No closed boundary found around that point'); return; }
    const d = this.h.defaults;
    this.add(makeHatch(loops, { ...this.props(), solid: d.hatchPattern === 'SOLID', pattern: d.hatchPattern, scale: d.hatchScale, angle: d.hatchAngle }));
  }
}

// ---------------------------------------------------------------------------------------------
// modify tools
function ghost(vp, ids, m) {
  return (c) => {
    c.strokeStyle = vp.inkColor; c.setLineDash([4, 3]); c.lineWidth = 1;
    let n = 0;
    for (const id of ids) {
      if (n++ > 400) break;
      const e = vp.doc.entities.find((x) => x.id === id);
      if (!e) continue;
      let t; try { t = transformEntity(e, m); } catch { continue; }
      for (const pl of tessellate(t, vp.doc, vp.tolWorld / 4)) {
        c.beginPath();
        pl.forEach((q, i) => { const s = vp.toScreen(q); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
        c.stroke();
      }
    }
  };
}

class ModifyTool extends Tool {
  /** subclasses set `needsSelection = true` and implement begin() once ids are known */
  constructor(h) { super(h); this.sel = new Selector(this.vp); }
  activate() {
    super.activate();
    this.ids = [...this.vp.selection];
    this.phase = this.ids.length ? 'go' : 'select';
    if (this.phase === 'go') this.begin();
  }
  down(p, ev) { if (this.phase === 'select') this.sel.down(p, ev); }
  move(p, ev) { if (this.phase === 'select') this.sel.move(p, ev); }
  up(p, ev) {
    if (this.phase === 'select') { this.sel.up(p, ev); this.h.refreshPrompt(); return; }
    if (!ev.dragged) this.click(p, ev);
  }
  key(e) {
    if (e.key === 'Escape') { if (this.phase === 'go' && this.reset) { this.reset(); this.phase = 'select'; this.vp.setSelection([]); this.h.refreshPrompt(); return true; } this.cancel(); return true; }
    if (e.key === 'Enter' && this.phase === 'select') { this.finishSelect(); return true; }
    return false;
  }
  rightClick() { this.key({ key: 'Enter' }); }
  finishSelect() {
    this.ids = [...this.vp.selection];
    if (!this.ids.length) { this.cancel(); return; }
    this.phase = 'go'; this.begin(); this.h.refreshPrompt();
  }
  get selPrompt() { return `${this.name}  select objects (${this.vp.selection.size} selected, Enter = done)`; }
  done() { this.vp.lastPoint = null; this.reset?.(); this.vp.setSelection([]); this.h.setTool('select'); }
}

class MoveTool extends ModifyTool {
  constructor(h, copy = false) { super(h); this.copy = copy; this.name = copy ? 'COPY' : 'MOVE'; }
  begin() { this.base = null; }
  reset() { this.base = null; this.vp.lastPoint = null; }
  get prompt() { return this.phase === 'select' ? this.selPrompt : this.base ? `${this.name}  second point (or @dx,dy)` : `${this.name}  base point`; }
  click(p) {
    if (this.phase !== 'go') return;
    if (!this.base) { this.base = p; this.vp.lastPoint = p; return; }
    const r = moveEntities(this.h.session, this.ids, p.x - this.base.x, p.y - this.base.y, { copy: this.copy });
    this.report(r, this.name);
    if (this.copy) { this.vp.lastPoint = this.base; return; } // keep copying from the same base
    this.done();
  }
  key(e) { if (this.copy && this.phase === 'go' && (e.key === 'Enter')) { this.done(); return true; } return super.key(e); }
  draw(c) {
    if (this.phase === 'go' && this.base) {
      const q = this.vp.cursor;
      ghost(this.vp, this.ids, translation(q.x - this.base.x, q.y - this.base.y))(c);
      c.strokeStyle = this.vp.inkColor; this.line(c, this.base, q);
    }
  }
}

class RotateTool extends ModifyTool {
  constructor(h) { super(h); this.name = 'ROTATE'; }
  begin() { this.base = null; }
  reset() { this.base = null; this.vp.lastPoint = null; }
  get prompt() { return this.phase === 'select' ? this.selPrompt : this.base ? 'ROTATE  angle (click or type degrees)' : 'ROTATE  base point'; }
  click(p) {
    if (this.phase !== 'go') return;
    if (!this.base) { this.base = p; this.vp.lastPoint = p; return; }
    this.apply(angleOf(this.base, p));
  }
  text(s) { const v = num(s); if (this.phase === 'go' && this.base && v !== null) { this.apply(v * DEG); return true; } return false; }
  apply(rad) { this.report(rotateEntities(this.h.session, this.ids, this.base, rad), 'Rotate'); this.done(); }
  draw(c) {
    if (this.phase === 'go' && this.base) {
      const a = angleOf(this.base, this.vp.cursor);
      ghost(this.vp, this.ids, rotation(a, this.base.x, this.base.y))(c);
      c.strokeStyle = this.vp.inkColor; this.line(c, this.base, this.vp.cursor); this.dyn(c, `${fmt(((a / DEG) + 360) % 360)}°`, this.vp.cursor);
    }
  }
}

class ScaleTool extends ModifyTool {
  constructor(h) { super(h); this.name = 'SCALE'; }
  begin() { this.base = null; this.ref = null; }
  reset() { this.base = null; this.ref = null; this.vp.lastPoint = null; }
  get prompt() {
    if (this.phase === 'select') return this.selPrompt;
    return this.base ? (this.ref ? 'SCALE  new length point' : 'SCALE  type a factor, or click a reference point') : 'SCALE  base point';
  }
  click(p) {
    if (this.phase !== 'go') return;
    if (!this.base) { this.base = p; this.vp.lastPoint = p; return; }
    if (!this.ref) { if (dist(this.base, p) > 1e-12) this.ref = p; return; }
    this.apply(dist(this.base, p) / dist(this.base, this.ref));
  }
  text(s) { const v = num(s); if (this.phase === 'go' && this.base && v > 0) { this.apply(v); return true; } return false; }
  apply(k) { if (k > 0 && Number.isFinite(k)) this.report(scaleEntities(this.h.session, this.ids, this.base, k), 'Scale'); this.done(); }
  draw(c) {
    if (this.phase === 'go' && this.base && this.ref) {
      const k = dist(this.base, this.vp.cursor) / dist(this.base, this.ref);
      if (k > 0) ghost(this.vp, this.ids, scaling(k, k, this.base.x, this.base.y))(c);
      this.dyn(c, `× ${fmt(k)}`, this.vp.cursor);
    }
  }
}

class MirrorTool extends ModifyTool {
  constructor(h) { super(h); this.name = 'MIRROR'; this.del = false; }
  begin() { this.a = null; }
  reset() { this.a = null; this.vp.lastPoint = null; }
  get prompt() { return this.phase === 'select' ? this.selPrompt : this.a ? `MIRROR  second point of mirror line (D = delete source: ${this.del ? 'yes' : 'no'})` : 'MIRROR  first point of mirror line'; }
  click(p) {
    if (this.phase !== 'go') return;
    if (!this.a) { this.a = p; this.vp.lastPoint = p; return; }
    if (dist(this.a, p) < 1e-12) return;
    this.report(mirrorEntities(this.h.session, this.ids, this.a, p, { deleteSource: this.del }), 'Mirror');
    this.done();
  }
  text(s) { if (s.trim().toLowerCase() === 'd') { this.del = !this.del; this.h.refreshPrompt(); return true; } return false; }
  draw(c) {
    if (this.phase === 'go' && this.a && dist(this.a, this.vp.cursor) > 1e-12) {
      ghost(this.vp, this.ids, mirrorLine(this.a, this.vp.cursor))(c);
      c.strokeStyle = this.vp.inkColor; this.line(c, this.a, this.vp.cursor);
    }
  }
}

class EraseTool extends ModifyTool {
  constructor(h) { super(h); this.name = 'ERASE'; }
  begin() { eraseEntities(this.h.session, this.ids); this.done(); }
  get prompt() { return this.selPrompt; }
  click() {}
}
class ExplodeTool extends ModifyTool {
  constructor(h) { super(h); this.name = 'EXPLODE'; }
  begin() {
    const r = explodeEntities(this.h.session, this.ids);
    if (r.failed.length) this.h.toast(`${r.failed.length} object(s) cannot be exploded (only blocks, dimensions and polylines).`);
    this.done();
  }
  get prompt() { return this.selPrompt; }
  click() {}
}

class OffsetTool extends Tool {
  constructor(h) { super(h); this.dist = null; }
  activate() { super.activate(); this.id = null; this.dp = null; }
  get prompt() {
    if (this.dist === null) return 'OFFSET  distance (type a number, or click two points)';
    return this.id ? 'OFFSET  click the side to offset to' : `OFFSET  (distance ${fmt(this.dist)})  click the object to offset`;
  }
  text(s) { const v = num(s); if (v > 0) { this.dist = v; this.h.refreshPrompt(); return true; } return false; }
  click(p, ev) {
    if (this.dist === null) {
      if (!this.dp) { this.dp = p; this.vp.lastPoint = p; return; }
      this.dist = dist(this.dp, p); this.dp = null; this.vp.lastPoint = null; this.h.refreshPrompt(); return;
    }
    if (!this.id) {
      const hit = this.vp.pick(ev?.raw ?? p);
      if (hit) { this.id = hit.id; this.vp.setSelection([hit.id]); }
      return;
    }
    const r = offsetCommand(this.h.session, this.id, this.dist, ev?.raw ?? p);
    if (r.failed.length) this.h.toast(`Cannot offset this object (${r.failed[0].reason}). Lines, circles, arcs and straight polylines are supported.`);
    this.id = null; this.vp.setSelection([]);
  }
  key(e) {
    if (e.key === 'Escape') { if (this.id) { this.id = null; this.vp.setSelection([]); } else this.cancel(); return true; }
    return e.key === 'Enter';
  }
  draw(c) { if (this.dp) { c.strokeStyle = this.vp.inkColor; this.line(c, this.dp, this.vp.cursor); } }
}

class TrimTool extends Tool {
  constructor(h, extend = false) { super(h); this.extend = extend; }
  get prompt() { return this.extend ? 'EXTEND  click near the end to extend (boundary = every other object)' : 'TRIM  click the part to remove (cutting edges = every other object)'; }
  click(p, ev) {
    const raw = ev?.raw ?? p;
    const hit = this.vp.pick(raw);
    if (!hit) return;
    const others = this.vp.doc.entities.filter((e) => e.id !== hit.id && this.vp.index.bboxOf(e)).map((e) => e.id);
    const r = this.extend ? extendCommand(this.h.session, hit.id, others, raw) : trimCommand(this.h.session, hit.id, others, raw);
    if (!r.done) this.h.toast(this.extend ? 'Nothing to extend to.' : 'No cutting edge crosses that object.');
  }
  key(e) { if (e.key === 'Escape') { this.cancel(); return true; } return e.key === 'Enter' ? (this.cancel(), true) : false; }
}

export function createTools(h) {
  return {
    select: new SelectTool(h),
    line: new LineTool(h), pline: new PolylineTool(h), rect: new RectTool(h), circle: new CircleTool(h),
    arc: new ArcTool(h), ellipse: new EllipseTool(h), point: new PointTool(h), text: new TextTool(h), hatch: new HatchTool(h),
    measure: new MeasureGeomTool(h), area: new MeasureGeomTool(h, 'AREA'),
    move: new MoveTool(h), copy: new MoveTool(h, true), rotate: new RotateTool(h), scale: new ScaleTool(h), mirror: new MirrorTool(h),
    offset: new OffsetTool(h), trim: new TrimTool(h), extend: new TrimTool(h, true), erase: new EraseTool(h), explode: new ExplodeTool(h),
    ...createModifyTools(h, { Tool, ModifyTool }),
    ...createDimTools(h, { Tool }),
    ...createBlockTools(h, { Tool, ModifyTool }),
    ...createMTextTools(h, { Tool }),
    ...createMLeaderTools(h, { Tool }),
    ...createMarkupTools(h, { Tool }),
    matchprop: new MatchPropTool(h),
  };
}

export const TOOL_ALIASES = {
  mea: 'measure', measuregeom: 'measure', area: 'area', aa: 'area',
  l: 'line', line: 'line', pl: 'pline', pline: 'pline', polyline: 'pline', rec: 'rect', rect: 'rect', rectangle: 'rect',
  c: 'circle', circle: 'circle', a: 'arc', arc: 'arc', el: 'ellipse', ellipse: 'ellipse', po: 'point', point: 'point',
  t: 'text', text: 'text', mt: 'mtext', mtext: 'mtext', h: 'hatch', hatch: 'hatch', di: 'measure', dist: 'measure', measure: 'measure',
  m: 'move', move: 'move', co: 'copy', cp: 'copy', copy: 'copy', ro: 'rotate', rotate: 'rotate', sc: 'scale', scale: 'scale',
  mi: 'mirror', mirror: 'mirror', o: 'offset', offset: 'offset', tr: 'trim', trim: 'trim', ex: 'extend', extend: 'extend',
  e: 'erase', erase: 'erase', x: 'explode', explode: 'explode', select: 'select', s: 'select',
  f: 'fillet', fillet: 'fillet', cha: 'chamfer', chamfer: 'chamfer', br: 'break', break: 'break', j: 'join', join: 'join',
  len: 'lengthen', lengthen: 'lengthen', str: 'stretch', stretch: 'stretch', ar: 'arrayrect', arrayrect: 'arrayrect',
  arraypolar: 'arraypolar', arraypath: 'arraypath',
  dli: 'dimlinear', dimlinear: 'dimlinear', dal: 'dimaligned', dimaligned: 'dimaligned', dan: 'dimangular', dimangular: 'dimangular', dra: 'dimradius', dimradius: 'dimradius',
  ddi: 'dimdiameter', dimdiameter: 'dimdiameter', dor: 'dimordinate', dimordinate: 'dimordinate', dco: 'dimcontinue', dimcontinue: 'dimcontinue', dba: 'dimbaseline', dimbaseline: 'dimbaseline',
  mld: 'mleader', mleader: 'mleader', ma: 'matchprop', matchprop: 'matchprop', painter: 'matchprop',
  b: 'block', block: 'block', bmake: 'block', att: 'attdef', attdef: 'attdef', i: 'insert', insert: 'insert', ddinsert: 'insert',
  xa: 'xattach', xattach: 'xattach',
  ate: 'eattedit', eattedit: 'eattedit', attedit: 'eattedit', ddatte: 'eattedit',
  mkc: 'mkc', mkr: 'mkr', mkt: 'mkt',
};
