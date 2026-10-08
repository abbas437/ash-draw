// ASH Draw Studio - canvas viewport: view state, pan/zoom, snapping, selection, overlays.
// The active tool receives world-space events through vp.tool (see tools.js).
import { buildScene, updateScene, drawScene, drawLayout, fitView, screenToWorld, worldToScreen, zoomAt } from '../src/core/render.js';
import { SpatialIndex, findSnap, orthoPoint, polarPoint, pickEntity, selectInBox } from '../src/core/pick.js';
import { bboxOf, growBox } from '../src/core/geom.js';
import { gripsOf } from './grips.js';
import { getEntity } from '../src/core/model.js';
import { setTextMeasure } from '../src/core/textMetrics.js';

// TEXT width for pick boxes, justification and DXF group 10: measured with the same canvas fonts drawText uses
{
  const mctx = document.createElement('canvas').getContext('2d');
  setTextMeasure((t, font) => { mctx.font = `100px "${font}", Arial, "Segoe UI", sans-serif`; return mctx.measureText(t).width / 100; });
}
import { paperRects } from '../src/core/layouts.js';
import { frameKey, framePlan, exposedStrips } from '../src/core/frameCache.js';

const DEFAULT_KINDS = new Set(['end', 'int', 'mid', 'cen', 'quad', 'node', 'ins', 'per']);
const SNAP_PX = 12;
const PICK_PX = 6;
/** a pan / wheel-zoom gesture shows the cached bitmap; the full render follows this long after it ends */
const SETTLE_MS = 120;
/** drawing-area background per theme; settings.dark picks one (it follows the app theme unless overridden) */
export const CANVAS_BG = { light: '#ffffff', dark: '#1b1f23' };

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cx: 0, cy: 0, zoom: 1, width: 800, height: 600 };
    this.dpr = window.devicePixelRatio || 1;
    this.selection = new Set();
    this.listeners = new Map();
    this.tool = null;
    this.cursor = { x: 0, y: 0 };      // last resolved (snapped) world point
    this.rawCursor = { x: 0, y: 0 };
    this.snapMarker = null;
    this.lastPoint = null;             // last point entered (for relative input and ortho)
    this.settings = { snap: true, ortho: false, polar: false, polarStep: 45, lineweights: false, dark: false, kinds: new Set(DEFAULT_KINDS) };
    this.preview = null;               // (ctx, view, vp) => void drawn above the scene
    this.rubber = null;                // selection rectangle {a,b,crossing} in world coordinates
    this.layout = null;                // the layout shown (paper space; see layouts-ui.js), null = model space
    this.modelScene = null;            // (frozenLayers) => model scene for viewports (layouts-ui.js)
    this.mspace = null;                // model space through a viewport: { vp, paperView, paperScene } (layouts-ui.js)
    this._raf = 0;
    this._spaceDown = false;
    this._pan = null;
    this._gesture = null;              // 'pan' | 'zoom' while the cached bitmap stands in for the scene
    this._settleT = 0;
    this._frame = null;                // last scene frame: { key, view, exact } with its bitmap in this._buf
    this._buf = document.createElement('canvas');
    this._buf2 = document.createElement('canvas');
    document.fonts?.addEventListener?.('loadingdone', () => this.invalidate());
    this._bind();
  }
  /** colour for previews and snap markers: yellow on the dark canvas, dark amber on the light one */
  get inkColor() { return this.settings.dark ? '#ffd400' : '#b35c00'; }

  on(name, fn) { (this.listeners.get(name) ?? this.listeners.set(name, []).get(name)).push(fn); return () => this.off(name, fn); }
  off(name, fn) { const l = this.listeners.get(name); if (l) this.listeners.set(name, l.filter((f) => f !== fn)); }
  emit(name, ...a) { for (const f of this.listeners.get(name) ?? []) f(...a); }

  // ---- document ------------------------------------------------------------------------------
  /** show a document. A file tab coming back to the front passes its saved view, selection, scene and index. */
  setSession(session, { fit = true, view = null, selection = [], scene = null, index = null, lastPoint = null } = {}) {
    if (this.session && this.session !== session) this.session.onChange = null;
    this.session = session;
    this.doc = session.doc;
    this.scene = scene ?? buildScene(this.doc);
    this.index = index ?? new SpatialIndex(this.doc);
    this.selection = new Set(selection);
    this.lastPoint = lastPoint;
    session.onChange = (info) => this._changed(info);
    if (view) { this.view = { ...this.view, cx: view.cx, cy: view.cy, zoom: view.zoom }; this.requestRender(); this.emit('view'); }
    else if (fit) this.zoomExtents(); else this.requestRender();
    this.emit('selection', this.selection);
    this.emit('doc');
  }

  _changed(info) {
    if (info.doc && info.doc !== this.doc) { this.requestRender(); this.emit('change', info); return; } // undo of the other space
    if (info.structure) {
      this.scene = buildScene(this.doc);
      this.index.rebuild();
    } else {
      updateScene(this.scene, info.ids);
      this.index.update(info.ids);
    }
    let pruned = false;
    for (const id of [...this.selection]) if (!getEntity(this.doc, id)) { this.selection.delete(id); pruned = true; }
    this.requestRender();
    this.emit('change', info);
    if (pruned) this.emit('selection', this.selection);
  }

  /** layer visibility changes do not go through the session; call this after editing doc.layers directly */
  refreshStructure() {
    this.scene = buildScene(this.doc);
    this.index.rebuild();
    this.emit('structure');
    this.requestRender();
  }

  // ---- view ----------------------------------------------------------------------------------
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.view = { ...this.view, width: w, height: h };
    this.requestRender();
  }
  zoomExtents() {
    if (this.mspace) { this.mspace.zoomExtents(); return; } // inside a viewport (layouts-ui.js)
    const b = this.layout ? paperRects(this.layout).sheet : this.scene?.bbox;
    this.view = fitView(b, this.view.width, this.view.height, 0.04);
    this.requestRender();
    this.emit('view');
  }
  zoomBox(b) {
    this.view = fitView(b, this.view.width, this.view.height, 0.04);
    this.requestRender(); this.emit('view');
  }
  zoomBy(f, sx = this.view.width / 2, sy = this.view.height / 2) {
    this.view = zoomAt(this.view, sx, sy, f);
    this.requestRender(); this.emit('view');
  }
  panPixels(dx, dy) {
    this.view = { ...this.view, cx: this.view.cx - dx / this.view.zoom, cy: this.view.cy + dy / this.view.zoom };
    this.requestRender(); this.emit('view');
  }
  toWorld(sx, sy) { return screenToWorld(this.view, sx, sy); }
  toScreen(p) { return worldToScreen(this.view, p); }
  get tolWorld() { return SNAP_PX / this.view.zoom; }

  // ---- selection -----------------------------------------------------------------------------
  setSelection(ids) {
    this.selection = new Set(ids);
    this.requestRender();
    this.emit('selection', this.selection);
  }
  selectedEntities() { return [...this.selection].map((id) => getEntity(this.doc, id)).filter(Boolean); }
  pick(p, opts = {}) { return pickEntity(this.index, p, PICK_PX / this.view.zoom, { skipLocked: true, ...opts }); }
  box(a, b, crossing) {
    return selectInBox(this.index, { minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y), maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y) }, crossing, { skipLocked: true });
  }
  selectionBox() {
    let b = null;
    for (const e of this.selectedEntities()) { const eb = bboxOf(e, this.doc); if (eb) { b = growBox(b, { x: eb.minx, y: eb.miny }); b = growBox(b, { x: eb.maxx, y: eb.maxy }); } }
    return b;
  }

  // ---- point resolution (snap / ortho / polar) -------------------------------------------------
  resolve(sx, sy, { from = this.lastPoint, snap = this.settings.snap, exclude } = {}) {
    const raw = this.toWorld(sx, sy);
    let p = raw, marker = null;
    if (snap && this.index) {
      const s = findSnap(this.index, raw, this.tolWorld, { kinds: this.settings.kinds, from: from ?? undefined, exclude });
      if (s) { p = { x: s.x, y: s.y }; marker = s; }
    }
    if (!marker && from) {
      if (this.settings.ortho) p = orthoPoint(from, raw);
      else if (this.settings.polar) { const r = polarPoint(from, raw, this.settings.polarStep); p = { x: r.x, y: r.y }; }
    }
    return { p, raw, marker };
  }

  // ---- rendering -----------------------------------------------------------------------------
  /** drop the cached scene bitmap (scene edits, layer and theme changes are detected through frameKey) */
  invalidate() { this._frame = null; this.requestRender(); }
  /** pan / wheel-zoom gesture: frames reuse the cached bitmap until SETTLE_MS after endGesture() */
  beginGesture(kind) { clearTimeout(this._settleT); this._settleT = 0; this._gesture = kind; }
  endGesture(ms = SETTLE_MS) {
    clearTimeout(this._settleT);
    this._settleT = setTimeout(() => { this._settleT = 0; this._gesture = null; this.requestRender(); }, ms);
  }
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  /** drawScene options of the model-space frame */
  sceneOpts() {
    return {
      background: this.settings.dark ? CANVAS_BG.dark : CANVAS_BG.light,
      showLineweight: this.settings.lineweights,
      highlight: this.selection,
      highlightColor: this.settings.dark ? '#4dd2ff' : '#0a6fd1',
      dpr: this.dpr,
    };
  }
  render() {
    if (!this.scene) return;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    const { ctx, view } = this;
    const opts = this.sceneOpts();
    const ms = this.mspace;
    if (this.layout) {
      this._frame = null;
      drawLayout(ctx, ms ? ms.paperScene : this.scene, ms ? { ...ms.paperView, width: view.width, height: view.height } : view, this.layout, paperRects, this.modelScene,
        { ...opts, highlightColor: '#0a6fd1', ...(ms && { highlight: null, modelHighlight: this.selection, activeVp: ms.vp }) });
    }
    else this._sceneFrame(opts);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawGrips();
    if (this.preview) { ctx.save(); this.preview(ctx, view, this); ctx.restore(); }
    if (this.rubber) this._drawRubber();
    if (this.snapMarker) this._drawSnapMarker();
    this._drawCrosshair();
  }

  /** model space: draw the scene through the cached bitmap (see framePlan in src/core/frameCache.js) */
  _sceneFrame(opts) {
    const { ctx, view, canvas } = this;
    const key = frameKey({ scene: this.scene, dark: this.settings.dark, lineweights: this.settings.lineweights, selection: this.selection, dpr: this.dpr, pxWidth: canvas.width, pxHeight: canvas.height });
    const plan = framePlan(this._frame, key, view, this._gesture);
    let buf = this._buf;
    if (plan.mode === 'full') {
      if (buf.width !== canvas.width || buf.height !== canvas.height) { buf.width = canvas.width; buf.height = canvas.height; }
      drawScene(buf.getContext('2d'), this.scene, view, opts);
      this._frame = { key, view, exact: true };
    } else if (plan.mode === 'shift') {
      // move the bitmap into the spare buffer, then render only the exposed strips, each clipped to itself
      const nb = this._buf2, c = nb.getContext('2d'), d = this.dpr, f = plan.view;
      if (nb.width !== buf.width || nb.height !== buf.height) { nb.width = buf.width; nb.height = buf.height; }
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(buf, plan.dx, plan.dy);
      for (const [x, y, w, h] of exposedStrips(plan.dx, plan.dy, nb.width, nb.height)) {
        const sv = { cx: f.cx + ((x + w / 2) / d - f.width / 2) / f.zoom, cy: f.cy - ((y + h / 2) / d - f.height / 2) / f.zoom, zoom: f.zoom, width: w / d, height: h / d };
        c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.beginPath(); c.rect(x, y, w, h); c.clip();
        drawScene(c, this.scene, sv, { ...opts, baseTransform: new DOMMatrix([d, 0, 0, d, x, y]) });
        c.restore();
      }
      this._buf2 = buf; this._buf = buf = nb;
      this._frame = { key, view: f, exact: false };
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (plan.mode === 'scale') {
      ctx.fillStyle = opts.background; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const d = this.dpr;
      ctx.drawImage(buf, plan.ox * d, plan.oy * d, buf.width * plan.s, buf.height * plan.s);
    } else ctx.drawImage(buf, 0, 0);
  }

  _drawGrips() {
    if (!this.selection.size || this.selection.size > 300) return;
    const { ctx } = this, hv = this.gripHover, hot = this.gripHot, hots = this.gripHots;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    for (const e of this.selectedEntities()) {
      gripsOf(e).forEach((g, i) => {
        const s = this.toScreen(g), is = (o) => o && o.id === e.id && o.i === i;
        ctx.fillStyle = is(hot) || hots?.some(is) ? '#ff2020' : is(hv) ? '#ff6ec7' : '#2d7dff';
        ctx.fillRect(s.x - 4, s.y - 4, 8, 8); ctx.strokeRect(s.x - 4.5, s.y - 4.5, 9, 9);
      });
    }
  }
  _drawRubber() {
    const { ctx } = this, r = this.rubber;
    const a = this.toScreen(r.a), b = this.toScreen(r.b);
    ctx.save();
    ctx.fillStyle = r.crossing ? 'rgba(60,200,100,0.15)' : 'rgba(60,140,255,0.15)';
    ctx.strokeStyle = r.crossing ? '#3cc864' : '#3c8cff';
    ctx.setLineDash(r.crossing ? [5, 3] : []);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }
  _drawSnapMarker() {
    const m = this.snapMarker, s = this.toScreen(m), c = this.ctx;
    c.save(); c.strokeStyle = this.inkColor; c.lineWidth = 1.5; c.beginPath();
    const r = 6;
    switch (m.kind) {
      case 'end': c.rect(s.x - r, s.y - r, 2 * r, 2 * r); break;
      case 'mid': c.moveTo(s.x - r, s.y + r); c.lineTo(s.x + r, s.y + r); c.lineTo(s.x, s.y - r); c.closePath(); break;
      case 'cen': c.arc(s.x, s.y, r, 0, Math.PI * 2); break;
      case 'quad': c.moveTo(s.x, s.y - r); c.lineTo(s.x + r, s.y); c.lineTo(s.x, s.y + r); c.lineTo(s.x - r, s.y); c.closePath(); break;
      case 'int': c.moveTo(s.x - r, s.y - r); c.lineTo(s.x + r, s.y + r); c.moveTo(s.x + r, s.y - r); c.lineTo(s.x - r, s.y + r); break;
      case 'per': c.moveTo(s.x - r, s.y - r); c.lineTo(s.x - r, s.y + r); c.lineTo(s.x + r, s.y + r); break;
      default: c.rect(s.x - r, s.y - r, 2 * r, 2 * r); c.moveTo(s.x - r, s.y - r); c.lineTo(s.x + r, s.y + r);
    }
    c.stroke();
    c.fillStyle = this.inkColor; c.font = '11px "Segoe UI", sans-serif';
    c.fillText(SNAP_LABEL[m.kind] ?? m.kind, s.x + r + 3, s.y - r - 2);
    c.restore();
  }
  _drawCrosshair() {
    if (!this.showCross) return;
    const c = this.ctx, s = this.toScreen(this.cursor);
    c.save(); c.strokeStyle = this.settings.dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(s.x - 10, s.y); c.lineTo(s.x + 10, s.y); c.moveTo(s.x, s.y - 10); c.lineTo(s.x, s.y + 10); c.stroke();
    c.restore();
  }

  // ---- input ---------------------------------------------------------------------------------
  _bind() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (this._gesture !== 'pan') { this.beginGesture('zoom'); this.endGesture(); }
      this.zoomBy(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top);
      this._moved(e.clientX - r.left, e.clientY - r.top, e);
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      cv.focus();
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (e.button === 1 || (e.button === 0 && this._spaceDown)) {
        this._pan = { x: e.clientX, y: e.clientY };
        this.beginGesture('pan');
        cv.setPointerCapture(e.pointerId);
        cv.style.cursor = 'grabbing';
        return;
      }
      const res = this.resolve(sx, sy);
      this.cursor = res.p; this.snapMarker = res.marker;
      if (e.button === 2) { this.tool?.rightClick?.(res.p, mk(e, res.raw, sx, sy)); this.requestRender(); return; }
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      this._down = { sx, sy, p: res.p, raw: res.raw, moved: false };
      this.tool?.down?.(res.p, mk(e, res.raw, sx, sy));
      this.requestRender();
    });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (this._pan) {
        this.panPixels(e.clientX - this._pan.x, e.clientY - this._pan.y);
        this._pan = { x: e.clientX, y: e.clientY };
        return;
      }
      this._moved(sx, sy, e);
    });
    cv.addEventListener('pointerup', (e) => {
      if (this._pan) { this._pan = null; cv.style.cursor = ''; this.endGesture(); return; }
      if (e.button !== 0 || !this._down) return;
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const res = this.resolve(sx, sy);
      this.tool?.up?.(res.p, mk(e, res.raw, sx, sy, { dragged: this._down.moved }));
      this._down = null;
      this.requestRender();
    });
    cv.addEventListener('pointerleave', () => { this.showCross = false; this.snapMarker = null; this.requestRender(); this.emit('cursor', null); });
    cv.addEventListener('pointerenter', () => { this.showCross = true; });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && document.activeElement === cv) { this._spaceDown = true; cv.style.cursor = 'grab'; } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this._spaceDown = false; cv.style.cursor = ''; } });
    new ResizeObserver(() => this.resize()).observe(cv);
  }

  _moved(sx, sy, e) {
    this.showCross = true;
    const res = this.resolve(sx, sy);
    this.cursor = res.p; this.rawCursor = res.raw; this.snapMarker = res.marker;
    if (this._down && Math.hypot(sx - this._down.sx, sy - this._down.sy) > 4) this._down.moved = true;
    this.tool?.move?.(res.p, mk(e, res.raw, sx, sy, { dragging: !!this._down?.moved }));
    this.emit('cursor', res.p);
    this.requestRender();
  }
}

/** plain event object for tools (PointerEvent properties are prototype getters and do not survive a spread) */
const mk = (e, raw, sx, sy, extra = {}) => ({ button: e.button, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, raw, sx, sy, ...extra });

const SNAP_LABEL = { end: 'Endpoint', mid: 'Midpoint', cen: 'Center', quad: 'Quadrant', int: 'Intersection', node: 'Node', ins: 'Insertion', per: 'Perpendicular', near: 'Nearest' };
