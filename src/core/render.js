// ASH Draw Studio - scene building and Canvas2D drawing.
// Works with the browser canvas and with @napi-rs/canvas in Node (same CanvasRenderingContext2D API).
//
//   const scene = buildScene(doc);            // flatten entities (blocks exploded) into drawable items
//   drawScene(ctx, scene, view, opts);        // view = { cx, cy, zoom, width, height }  (zoom = pixels per unit)
//
// Path "ops" are flat number arrays in WORLD coordinates (Y up):
//   0 M x y | 1 L x y | 2 A cx cy r a0 sweep | 3 E cx cy rx ry rot t0 sweep | 4 Z
// They are converted to screen space in JS doubles at draw time (Canvas paths are float32, so big
// drawing coordinates would otherwise lose precision when zoomed in).
import { blockContentView } from './blocks.js';
import { imageCorners, imageClipWorld, wipeoutRing } from './image.js';
import { resolveColor, aciToRgb } from './aci.js';
import { parseMText, layoutMText } from './mtext.js';
import {
  DEG, compose, translation, rotation, scaling, apply, isSimilarity, matScale, transformEntity, bulgeToArc,
  ccwSweep, tessellate, ellipsePoint, unionBox, growBox,
} from './geom.js';
import { plainText } from './dxfRead.js';
import { mleaderParts } from './mleader.js';
import { mlineParts } from './mline.js';
import { patternLines, hasPattern } from './patterns.js';
import { SceneGrid } from './sceneGrid.js';
import { strokeLayout, shxSubstitute } from './shx.js';
import { isGdtFont, gdtText, gdtModel } from './gdt.js';
import { textFrame, textCorners, textAdvance } from './textMetrics.js';

const TAU = Math.PI * 2;
const OP_M = 0, OP_L = 1, OP_A = 2, OP_E = 3, OP_Z = 4;
const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------------------------
// scene building
function lineweightOf(e, layer, inherit) {
  let lw = e.lineweight;
  if (lw === undefined || lw === -1) lw = layer ? layer.lineweight : -3;
  if (lw === -2) lw = inherit ? inherit.lw : -3;
  return lw;
}
function linetypeOf(e, layer, inherit) {
  let lt = e.linetype && e.linetype !== 'BYLAYER' ? e.linetype : (layer ? layer.linetype : 'CONTINUOUS');
  if (String(lt).toUpperCase() === 'BYBLOCK') lt = inherit ? inherit.lt : 'CONTINUOUS';
  return lt;
}

/** opacity 0..1 from the entity's alpha (ByLayer: the layer's, ByBlock: the enclosing INSERT's) */
function opacityOf(e, layer, inherit) {
  const a = e.alpha;
  if (a === -2) return inherit ? inherit.alpha ?? 1 : 1;
  if (a >= 0) return a / 255;
  return layer && layer.alpha >= 0 ? layer.alpha / 255 : 1;
}

class Builder {
  constructor(doc) {
    this.doc = doc;
    this.items = [];
    this.byId = new Map();
    this.bbox = null;
    this.globalLt = doc.header.ltscale || 1;
  }

  layerOf(e, inherit) {
    let name = e.layer;
    if ((name === '0' || name === undefined) && inherit) name = inherit.layerName;
    return { name: name ?? '0', layer: this.doc.layers.get(name ?? '0') ?? null };
  }

  /** emit drawable items for entity e under matrix m; inherit = resolved style of the enclosing INSERT */
  emit(e, m, inherit, rootId, depth) {
    if (e.invisible) return;
    const { name, layer } = this.layerOf(e, inherit);
    if (layer && (layer.visible === false || layer.frozen)) return;
    if (e.type === 'INSERT') { this.emitInsert(e, m, inherit, rootId, depth, name, layer); return; }
    if (e.type === 'DIMENSION') {
      const blk = this.doc.blocks.get(e.block);
      if (blk) this.emitBlockContent(blk, m, this.styleFor(e, layer, inherit, name), rootId, depth);
      return;
    }
    if (e.type === 'MLINE') {
      const st = this.styleFor(e, layer, inherit, name);
      for (const sub of mlineParts(e, this.doc.mlineStyles?.get(e.styleH))) this.emit(sub, m, st, rootId, depth + 1);
      return;
    }
    if (e.type === 'MLEADER') {
      const st = this.styleFor(e, layer, inherit, name);
      for (const sub of mleaderParts(e)) this.emit(sub, m, st, rootId, depth + 1);
      return;
    }
    const style = this.styleFor(e, layer, inherit, name);
    const sim = isSimilarity(m);
    let ent = e;
    let mm = m;
    if (!sim) {
      try { ent = transformEntity(e, m); mm = null; } catch { return; }
    }
    this.build(ent, mm, style, rootId);
  }

  styleFor(e, layer, inherit, layerName) {
    const insertColor = inherit ? inherit.color : null;
    const color = resolveColor(e, layer, insertColor);
    const lw = lineweightOf(e, layer, inherit);
    const lt = linetypeOf(e, layer, inherit);
    const lts = (e.ltscale ?? 1) * this.globalLt;
    return { color, lw, lt, lts, layerName, alpha: opacityOf(e, layer, inherit) };
  }

  emitInsert(e, m, inherit, rootId, depth, layerName, layer) {
    if (depth >= MAX_DEPTH) return;
    const blk = this.doc.blocks.get(e.block);
    if (!blk) return;
    // an xref that is not loaded: its path in red at the insertion point (AutoCAD shows the same)
    if (blk.xref && blk.xref.status !== 'loaded') {
      if (isSimilarity(m)) this.build({ type: 'TEXT', p: e.p, height: 2.5, text: blk.xref.path || blk.name, rot: 0, ui: true }, m, { color: { rgb: [255, 0, 0] }, lw: -3, lt: 'CONTINUOUS', lts: 1, layerName }, rootId);
      return;
    }
    const style = this.styleFor(e, layer, inherit, layerName);
    const cols = Math.max(1, e.cols || 1), rows = Math.max(1, e.rows || 1);
    const rot = (e.rot || 0) * DEG;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const local = compose(translation(e.p.x, e.p.y), compose(rotation(rot),
          compose(translation(c * (e.colSp || 0), r * (e.rowSp || 0)), compose(scaling(e.sx ?? 1, e.sy ?? 1), translation(-blk.base.x, -blk.base.y)))));
        this.emitBlockContent(blk, compose(m, local), style, rootId, depth + 1);
      }
    }
    // ATTRIBs live in the INSERT's own space (not the block's); invisible ones (flag 1) are hidden
    for (const at of e.attribs ?? []) if (!(at.attrib.flags & 1)) this.emit(at, m, style, rootId, depth + 1);
  }

  emitBlockContent(blk, m, style, rootId, depth) {
    for (const be of blk.entities) { const v = blockContentView(be); if (v) this.emit(v, m, style, rootId, depth); }
  }

  push(item, rootId) {
    item.id = rootId;
    this.items.push(item);
    let list = this.byId.get(rootId);
    if (!list) this.byId.set(rootId, (list = []));
    list.push(item);
    if (item.bbox) this.bbox = unionBox(this.bbox, item.bbox);
  }

  /** ops builders; `m` is a similarity matrix (or null when e is already in world coordinates) */
  build(e, m, style, rootId) {
    const P = (p) => (m ? apply(m, p) : p);
    const s = m ? matScale(m) : 1;
    const flip = m ? m[0] * m[3] - m[1] * m[2] < 0 : false;
    const ang = m ? Math.atan2(m[1], m[0]) : 0;
    const ops = [];
    let bbox = null;
    const grow = (x, y) => { bbox = growBox(bbox, { x, y }); };
    const M = (p) => { ops.push(OP_M, p.x, p.y); grow(p.x, p.y); };
    const L = (p) => { ops.push(OP_L, p.x, p.y); grow(p.x, p.y); };
    const arcOp = (c, r, a0, sweep) => {
      ops.push(OP_A, c.x, c.y, r, a0, sweep);
      // the arc's own extents (ends + the quadrant points it passes), not its full circle: a huge-radius arc with
      // a small sweep would otherwise push the scene extents far away
      const lo = Math.min(a0, a0 + sweep), hi = Math.max(a0, a0 + sweep);
      if (hi - lo >= TAU) { grow(c.x - r, c.y - r); grow(c.x + r, c.y + r); return; }
      grow(c.x + r * Math.cos(lo), c.y + r * Math.sin(lo)); grow(c.x + r * Math.cos(hi), c.y + r * Math.sin(hi));
      for (let k = Math.ceil(lo / (Math.PI / 2)), a = k * Math.PI / 2; a < hi; a = ++k * Math.PI / 2) grow(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
    };
    const mapArc = (c, r, a0, sweep) => {
      const cc = P(c);
      let na0 = a0 + ang, ns = sweep;
      if (flip) { na0 = -a0 + ang; ns = -sweep; }
      return [cc, r * s, na0, ns];
    };
    const mkItem = (kind, extra = {}) => ({ kind, ops, style, bbox, ...extra });

    switch (e.type) {
      case 'LINE': M(P(e.p1)); L(P(e.p2)); this.push(mkItem('path'), rootId); return;
      case 'CIRCLE': {
        const [c, r] = mapArc(e.c, e.r, 0, TAU);
        M({ x: c.x + r, y: c.y }); arcOp(c, r, 0, TAU); this.push(mkItem('path'), rootId); return;
      }
      case 'ARC': {
        const sw = ccwSweep(e.a0 * DEG, e.a1 * DEG);
        const [c, r, a0, ns] = mapArc(e.c, e.r, e.a0 * DEG, sw);
        M({ x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) });
        arcOp(c, r, a0, ns); this.push(mkItem('path'), rootId); return;
      }
      case 'ELLIPSE': {
        const full = Math.abs((e.a1 ?? TAU) - (e.a0 ?? 0)) >= TAU - 1e-9;
        const sw = full ? TAU : ccwSweep(e.a0 ?? 0, e.a1);
        const maj = m ? { x: m[0] * e.major.x + m[2] * e.major.y, y: m[1] * e.major.x + m[3] * e.major.y } : e.major;
        const c = P(e.c);
        const rx = Math.hypot(maj.x, maj.y), ry = rx * e.ratio, rot = Math.atan2(maj.y, maj.x);
        // a mirrored ellipse runs the other way round: parameter t becomes -t
        const t0 = flip ? -(e.a0 ?? 0) : (e.a0 ?? 0);
        M(ellipsePoint({ c, major: maj, ratio: e.ratio }, t0));
        ops.push(OP_E, c.x, c.y, rx, ry, rot, t0, flip ? -sw : sw);
        grow(c.x - rx, c.y - rx); grow(c.x + rx, c.y + rx);
        this.push(mkItem('path'), rootId); return;
      }
      case 'LWPOLYLINE': {
        const v = e.vertices;
        if (!v || v.length < 2) return;
        M(P(v[0]));
        const n = e.closed ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) {
          const p1 = v[i], p2 = v[(i + 1) % v.length];
          if (p1.bulge && Math.abs(p1.bulge) > 1e-12) {
            const a = bulgeToArc(p1, p2, p1.bulge);
            const [c, r, a0, ns] = mapArc(a.c, a.r, a.a0, a.sweep);
            arcOp(c, r, a0, ns);
          } else L(P(p2));
        }
        if (e.closed) ops.push(OP_Z);
        this.push(mkItem('path'), rootId); return;
      }
      case 'SPLINE': {
        const pls = tessellate(e, this.doc, 0);
        const pl = pls[0];
        if (!pl || pl.length < 2) return;
        M(P(pl[0])); for (let i = 1; i < pl.length; i++) L(P(pl[i]));
        if (e.closed) ops.push(OP_Z);
        this.push(mkItem('path'), rootId); return;
      }
      case 'LEADER': {
        if (!e.pts || e.pts.length < 2) return;
        M(P(e.pts[0])); for (let i = 1; i < e.pts.length; i++) L(P(e.pts[i]));
        const it = mkItem('path');
        if (e.arrow !== false) it.arrow = [P(e.pts[1]), P(e.pts[0])];
        this.push(it, rootId); return;
      }
      case 'SOLID': {
        const p = tessellate(e)[0];
        if (!p) return;
        M(P(p[0])); for (let i = 1; i < p.length - 1; i++) L(P(p[i]));
        ops.push(OP_Z);
        this.push(mkItem('fill'), rootId); return;
      }
      case 'POINT': { const p = P(e.p); grow(p.x, p.y); this.push({ kind: 'point', p, style, bbox }, rootId); return; }
      case 'HATCH': { this.buildHatch(e, m, style, rootId); return; }
      case 'IMAGE': {
        // a loaded raster (doc.images: path -> { status, bitmap }) is an 'image' item; a missing file is its frame and
        // file name in red (as AutoCAD shows an image it cannot find)
        const img = this.doc.images?.get(e.path);
        const lin = (q) => (m ? { x: m[0] * q.x + m[2] * q.y, y: m[1] * q.x + m[3] * q.y } : q);
        const w = { p: P(e.p), u: lin(e.u), v: lin(e.v), size: e.size, clip: e.clip, fade: e.fade };
        const q = imageCorners(w);
        M(q[0]); L(q[1]); L(q[2]); L(q[3]); ops.push(OP_Z);
        if (img?.status === 'loaded') {
          this.push(mkItem('image', { image: { ...w, path: e.path, clipPts: e.clip?.on ? imageClipWorld(w) : null } }), rootId);
          return;
        }
        const red = { color: { rgb: [255, 0, 0] }, lw: -3, lt: 'CONTINUOUS', lts: 1, layerName: style.layerName };
        this.push({ kind: 'path', ops, style: red, bbox, missingImage: e.path }, rootId);
        const W = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), H = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
        const h = Math.max(Math.min(W, H) / 12, 1e-9), ux = (q[1].x - q[0].x) / (W || 1), uy = (q[1].y - q[0].y) / (W || 1);
        const name = String(e.path || '').split(/[\\/]/).pop() || 'IMAGE';
        this.build({ type: 'TEXT', p: { x: q[0].x + (ux - uy) * h, y: q[0].y + (uy + ux) * h }, height: h, text: name, rot: Math.atan2(uy, ux) / DEG, ui: true }, null, red, rootId);
        return;
      }
      case 'WIPEOUT': {
        // a background-coloured mask over what was drawn before it; the frame (WIPEOUTFRAME, default shown) on top
        const lin = (q) => (m ? { x: m[0] * q.x + m[2] * q.y, y: m[1] * q.x + m[3] * q.y } : q);
        const ring = wipeoutRing({ p: P(e.p), u: lin(e.u), v: lin(e.v), size: e.size, clip: e.clip });
        if (ring.length < 3) return;
        M(ring[0]); for (let i = 1; i < ring.length; i++) L(ring[i]); ops.push(OP_Z);
        this.push(mkItem('wipeout'), rootId);
        if ((this.doc.header.wipeoutFrame ?? 1) !== 0) this.push(mkItem('path'), rootId);
        return;
      }
      case 'TEXT': case 'MTEXT': {
        const p = P(e.p);
        const h = (e.height || 1) * s;
        const rot = ((e.rot || 0) * DEG) + ang;
        const tst = this.doc.textStyles.get(String(e.style || 'STANDARD').toUpperCase());
        const gdt = isGdtFont(tst?.fontFile || tst?.font);
        let raw = plainText(e.text);
        if (!raw) return;
        if (gdt) raw = gdtText(raw);
        const lines = raw.split('\n');
        const w = Math.max(...lines.map((l) => l.length)) * h * 0.6 * (e.widthFactor || 1);
        // conservative bbox around the (rotated) text block
        let box = null;
        const mt = e.type === 'MTEXT' ? gdtModel(parseMText(e.text, { height: h }), gdt) : null;
        const lay = mt && layoutMText(mt, { width: (e.width || 0) * s, attach: e.attach || 1, lineSpacing: e.lineSpacing || 1 });
        const corners = lay ? [[lay.x0, -lay.y0], [lay.x0 + lay.width, -lay.y0], [lay.x0 + lay.width, -lay.y0 - lay.height], [lay.x0, -lay.y0 - lay.height]]
          : [[0, -h * lines.length * 1.4], [w, -h * lines.length * 1.4], [w, h], [0, h]];
        for (const [x, y] of corners) {
          box = growBox(box, { x: p.x + x * Math.cos(rot) - y * Math.sin(rot), y: p.y + x * Math.sin(rot) + y * Math.cos(rot) });
        }
        if (e.type === 'TEXT') {
          // real width and the 15 justifications (Aligned / Fit: drawn from p with the fitted height / width factor)
          const f = textFrame({ ...e, p, p2: e.p2 && P(e.p2), height: h, rot: rot / DEG }, this.doc);
          box = textCorners(f).reduce((b, q) => growBox(b, q), null);
          if (f.stroke) { this.pushStrokeText(strokeLayout(raw, f.h), f, style, box, rootId); return; }
          if (e.hAlign === 3 || e.hAlign === 5) {
            this.push({ kind: 'text', p: f.o, h: f.h, rot: f.rot, lines, wf: f.wf, style, bbox: box, mtext: false, attach: 1, boxW: 0, hAlign: 0, vAlign: 0,
              font: this.doc.textStyles.get(String(e.style || 'STANDARD').toUpperCase())?.font || 'Arial', mt: null, lineSpacing: 1 }, rootId);
            return;
          }
        }
        if (mt && this.pushStrokeMText(e, mt, p, rot, s, style, lines, rootId)) return;
        this.push({
          kind: 'text', p, h, rot, lines, wf: e.widthFactor || 1, style, bbox: box, mtext: e.type === 'MTEXT', attach: e.attach || 1,
          boxW: e.type === 'MTEXT' ? (e.width || 0) * s : 0, hAlign: e.hAlign || 0, vAlign: e.vAlign || 0,
          font: this.doc.textStyles.get(String(e.style || 'STANDARD').toUpperCase())?.font || 'Arial',
          // MTEXT: the parsed run model (heights in drawing units of this item)
          mt, lineSpacing: e.lineSpacing || 1,
        }, rootId);
        return;
      }
      default: return;
    }
  }

  /** TEXT in an SHX style: the stroke font's glyphs as one path item (width factor, oblique, justification) */
  pushStrokeText(sl, f, style, estBox, rootId) {
    const { wf, t, o: p0, h, rot } = f, W = sl.width * wf;
    const c = Math.cos(rot), sn = Math.sin(rot), ops = [];
    let bbox = null;
    for (const st of sl.strokes) {
      for (let i = 0; i < st.length; i += 2) {
        const y = st[i + 1], x = st[i] * wf + y * t;
        const q = { x: p0.x + x * c - y * sn, y: p0.y + x * sn + y * c };
        ops.push(i ? OP_L : OP_M, q.x, q.y);
        bbox = growBox(bbox, q);
      }
    }
    // the item box also holds the text box that pick and zoom extents use (textMetrics.textFrame)
    bbox = unionBox(bbox, estBox);
    // text strokes ignore the entity linetype (as in AutoCAD); start of the baseline and length for the LOD bar
    const st = style.lt === 'CONTINUOUS' ? style : { ...style, lt: 'CONTINUOUS', _ks: undefined, _key: undefined };
    this.push({ kind: 'path', ops, style: st, bbox, strokeText: { p: p0, h, rot, w: W } }, rootId);
  }

  /**
   * MTEXT with SHX runs (style font or \f run font): one fixed layout measured with the stroke font for those runs and
   * the canvas measure for the others; stroke runs (with their underline / overline / strike / fraction bars) become
   * path items, one per colour and line; the other runs stay a text item that draws the fixed layout (it.lay).
   * A run with a character the stroke font lacks stays on canvas. false: no stroke run (caller pushes the text item).
   */
  pushStrokeMText(e, mt, p, rot, s, style, lines, rootId) {
    const ts = this.doc.textStyles.get(String(e.style || 'STANDARD').toUpperCase());
    const styleFont = ts?.fontFile || ts?.font, ttFont = ts?.font || 'Arial';
    let any = false;
    for (const para of mt.paras) {
      for (const r of para.runs) {
        if (!r.props || !shxSubstitute(r.props.font ?? styleFont)) continue;
        if (!strokeLayout(r.stack ? `${r.stack.a}${r.stack.b}/` : r.text, 1)) continue;
        r.props = { ...r.props, stroke: true }; any = true;
      }
    }
    if (!any) return false;
    const measure = (t, pr) => (pr.stroke ? strokeLayout(t, pr.h).width : textAdvance(t, pr.font || ttFont, pr.bold, pr.italic) * pr.h);
    const lay = layoutMText(mt, { width: (e.width || 0) * s, attach: e.attach || 1, lineSpacing: e.lineSpacing || 1, measure });
    const c = Math.cos(rot), sn = Math.sin(rot);
    // layout frame: origin p, x along the text, y DOWN
    const W = (x, y) => ({ x: p.x + x * c + y * sn, y: p.y + x * sn - y * c });
    let box = null;
    for (const [x, y] of [[lay.x0, lay.y0], [lay.x0 + lay.width, lay.y0], [lay.x0 + lay.width, lay.y0 + lay.height], [lay.x0, lay.y0 + lay.height]]) box = growBox(box, W(x, y));
    const lineOf = (y) => { let k = 0; lay.lines.forEach((l, i) => { if (Math.abs(l.y - y) < Math.abs(lay.lines[k].y - y)) k = i; }); return k; };
    const groups = new Map();
    const group = (color, y) => {
      const li = lineOf(y), key = `${JSON.stringify(color)}|${li}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { color, line: lay.lines[li], ops: [], bbox: null, x0: Infinity, x1: -Infinity }));
      return g;
    };
    const seg = (g, pts) => pts.forEach(([x, y], i) => {
      const q = W(x, y);
      g.ops.push(i ? OP_L : OP_M, q.x, q.y); g.bbox = growBox(g.bbox, q);
      g.x0 = Math.min(g.x0, x); g.x1 = Math.max(g.x1, x);
    });
    const glyphs = [], rules = [];
    for (const gl of lay.glyphs) {
      if (!gl.stroke) { glyphs.push(gl); continue; }
      const sl = strokeLayout(gl.text, gl.h, gl.track || 1), wf = gl.wf || 1, t = Math.tan((gl.oblique || 0) * DEG);
      const g = group(gl.color, gl.y);
      for (const st of sl.strokes) {
        const pts = [];
        for (let i = 0; i < st.length; i += 2) pts.push([gl.x + st[i] * wf + st[i + 1] * t, gl.y - st[i + 1]]);
        seg(g, pts);
      }
    }
    for (const r of lay.rules) {
      if (r.stroke) seg(group(r.color, r.y), [[r.x1, r.y], [r.x2, r.y]]);
      else rules.push(r);
    }
    // text strokes ignore the entity linetype (as in AutoCAD); a run colour overrides the entity colour
    const base = style.lt === 'CONTINUOUS' ? style : { ...style, lt: 'CONTINUOUS', _ks: undefined, _key: undefined };
    const styleOf = (col) => (!col ? base : { ...base, _ks: undefined, _key: undefined, _css: undefined,
      color: col.rgb ? { rgb: col.rgb, auto: false } : col.aci === 7 ? { rgb: [255, 255, 255], auto: true } : { rgb: aciToRgb(col.aci), auto: false } });
    for (const g of groups.values()) {
      if (!g.ops.length) continue;
      const l = g.line;
      this.push({ kind: 'path', ops: g.ops, style: styleOf(g.color), bbox: unionBox(g.bbox, box), strokeText: { p: W(g.x0, l.y), h: l.h, rot, w: g.x1 - g.x0 } }, rootId);
    }
    if (glyphs.length || rules.length) {
      this.push({
        kind: 'text', p, h: (e.height || 1) * s, rot, lines, wf: e.widthFactor || 1, style, bbox: box, mtext: true, attach: e.attach || 1,
        boxW: (e.width || 0) * s, hAlign: 0, vAlign: 0, font: ttFont, mt, lineSpacing: e.lineSpacing || 1,
        lay: { ...lay, glyphs, rules },   // fixed layout: drawMText and the SVG / PDF export draw it as laid out here
      }, rootId);
    }
    return true;
  }

  buildHatch(e, m, style, rootId) {
    const P = (p) => (m ? apply(m, p) : p);
    const ops = [];
    let bbox = null;
    for (const loop of e.loops) {
      let pts;
      if (loop.pts) {
        const tess = tessellate({ type: 'LWPOLYLINE', vertices: loop.pts, closed: true });
        pts = tess[0];
      } else {
        pts = tessellate({ type: 'HATCH', loops: [loop] })[0];
      }
      if (!pts || pts.length < 3) continue;
      const q = pts.map(P);
      ops.push(OP_M, q[0].x, q[0].y);
      bbox = growBox(bbox, q[0]);
      for (let i = 1; i < q.length; i++) { ops.push(OP_L, q[i].x, q[i].y); bbox = growBox(bbox, q[i]); }
      ops.push(OP_Z);
    }
    if (!ops.length) return;
    const solid = !!e.solid || e.pattern === 'SOLID';
    let lines = null;
    if (!solid) {
      lines = e.patLines && e.patLines.length ? e.patLines : (hasPattern(e.pattern) ? patternLines(e.pattern, e.scale || 1, e.angle || 0) : null);
      if (lines && m) {
        const a = Math.atan2(m[1], m[0]) / DEG, sc = matScale(m);
        lines = lines.map((l) => ({
          angle: l.angle + a, base: apply(m, l.base), offset: { x: (m[0] * l.offset.x + m[2] * l.offset.y), y: (m[1] * l.offset.x + m[3] * l.offset.y) },
          dashes: l.dashes.map((d) => d * sc),
        }));
      }
    }
    this.push({ kind: 'hatch', ops, style, bbox, solid, lines }, rootId);
  }
}

export function buildScene(doc) {
  const b = new Builder(doc);
  for (const e of doc.entities) b.emit(e, [1, 0, 0, 1, 0, 0], null, e.id, 0);
  b.items.forEach((it, i) => { it.pos = i; });
  const entIndex = new Map();
  doc.entities.forEach((e, i) => entIndex.set(e.id, i));
  return {
    items: b.items, byId: b.byId, doc, version: 0, grid: null,
    entIndex, _entLen: doc.entities.length, _bbox: b.bbox, _bboxDirty: false,
    // the scene bbox: grown on insert by updateScene, recomputed lazily only after an edge item was removed
    get bbox() { if (this._bboxDirty) { this._bbox = itemsBox(this.items); this._bboxDirty = false; } return this._bbox; },
    set bbox(v) { this._bbox = v; this._bboxDirty = false; },
  };
}

function itemsBox(items) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const b = items[i].bbox;
    if (!b) continue;
    if (b.minx < minx) minx = b.minx; if (b.miny < miny) miny = b.miny;
    if (b.maxx > maxx) maxx = b.maxx; if (b.maxy > maxy) maxy = b.maxy;
  }
  return minx <= maxx ? { minx, miny, maxx, maxy } : null;
}

/** the scene's item grid, built on first use (drawing) and kept up to date by updateScene */
export function sceneGrid(scene) {
  if (!scene.grid) {
    scene.grid = new SceneGrid(scene.bbox, scene.items.length);
    for (const it of scene.items) scene.grid.insert(it);
  }
  return scene.grid;
}

/** the scene items whose bbox touches the view box, in scene (draw) order. When the view contains the whole scene
 *  (every item bbox lies inside the scene bbox) this is scene.items itself, not a copy: read it, do not change it. */
export function visibleItems(scene, minx, miny, maxx, maxy) {
  const items = scene.items, out = [];
  const touches = (b) => !b || !(b.maxx < minx || b.minx > maxx || b.maxy < miny || b.miny > maxy);
  const sb = scene.bbox;
  if (!sb || (minx <= sb.minx && miny <= sb.miny && maxx >= sb.maxx && maxy >= sb.maxy)) return items;
  const cand = sceneGrid(scene).query({ minx, miny, maxx, maxy });
  const ord = new Uint32Array(cand.length);
  let n = 0;
  for (const it of cand) if (touches(it.bbox)) ord[n++] = it.pos;
  const sorted = ord.subarray(0, n).sort();
  for (let i = 0; i < n; i++) out.push(items[sorted[i]]);
  return out;
}

/** the document entity with this id, through the scene's id -> index map. The map is only a hint: edit.js replaces
 *  doc.entities[i] and model.js reassigns doc.entities, so every hit is checked against doc.entities[index]; a miss
 *  first indexes entities appended since the last look, then (once per call) rebuilds the map. */
function entityLookup(scene) {
  let rebuilt = false;
  const find = (ents, id) => { const i = scene.entIndex.get(id); return i !== undefined && ents[i]?.id === id ? ents[i] : null; };
  return (id) => {
    const ents = scene.doc.entities;
    let e = find(ents, id);
    if (e) return e;
    if (ents.length > scene._entLen) { for (let i = scene._entLen; i < ents.length; i++) scene.entIndex.set(ents[i].id, i); }
    scene._entLen = ents.length;
    if ((e = find(ents, id)) || rebuilt) return e;
    rebuilt = true;
    scene.entIndex.clear();
    for (let i = 0; i < ents.length; i++) scene.entIndex.set(ents[i].id, i);
    return find(ents, id);
  };
}

/** rebuild just the given entity ids (after edits); unknown ids are removed. Work is O(items of those ids): an entity
 *  that yields as many items as before is replaced in place (keeping its draw order); otherwise its old items are
 *  dropped (one compaction pass from the first of them) and the new ones appended. */
export function updateScene(scene, ids) {
  const items = scene.items, grid = scene.grid, look = entityLookup(scene);
  const b = new Builder(scene.doc);
  const added = [];
  let firstDead = -1;
  for (const id of new Set(ids)) {
    const old = scene.byId.get(id) ?? [];
    const e = look(id);
    const start = b.items.length;
    if (e) b.emit(e, [1, 0, 0, 1, 0, 0], null, id, 0);
    const nu = b.items.slice(start);
    const sb = scene._bboxDirty ? null : scene._bbox;
    for (const it of old) {
      if (grid) grid.remove(it);
      const ib = it.bbox;
      if (sb && ib && (ib.minx <= sb.minx || ib.miny <= sb.miny || ib.maxx >= sb.maxx || ib.maxy >= sb.maxy)) scene._bboxDirty = true;
    }
    if (nu.length === old.length) {
      for (let k = 0; k < nu.length; k++) { const p = old[k].pos; nu[k].pos = p; items[p] = nu[k]; }
    } else {
      for (const it of old) { it._dead = true; if (firstDead < 0 || it.pos < firstDead) firstDead = it.pos; }
      for (const it of nu) added.push(it);
    }
    if (nu.length) scene.byId.set(id, nu); else scene.byId.delete(id);
    for (const it of nu) {
      if (grid) grid.insert(it);
      if (!scene._bboxDirty && it.bbox) scene._bbox = unionBox(scene._bbox, it.bbox);
    }
  }
  if (firstDead >= 0) {
    let w = firstDead;
    for (let r = firstDead; r < items.length; r++) { const it = items[r]; if (it._dead) continue; if (w !== r) items[w] = it; it.pos = w++; }
    items.length = w;
  }
  for (const it of added) { it.pos = items.length; items.push(it); }
  scene.version++;
  return scene;
}

// ---------------------------------------------------------------------------------------------
// drawing
const rgbCss = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
const luminance = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

function dashFor(doc, style, zoom) {
  const name = String(style.lt ?? 'CONTINUOUS').toUpperCase();
  if (name === 'CONTINUOUS' || name === 'BYLAYER') return null;
  const def = doc.linetypes.get(name);
  if (!def || !def.pattern.length) return null;
  const k = style.lts * zoom;
  const period = def.pattern.reduce((a, b) => a + Math.abs(b), 0) * k;
  if (period < 2.5) return null;       // too small to be visible: draw solid
  const arr = def.pattern.map((d) => (d === 0 ? 1 : Math.max(Math.abs(d) * k, 0.5)));  // dots get a 1px mark
  return arr.length % 2 ? [...arr, ...arr] : arr;
}

/** CSS px around the view inside which path coordinates are handed to the canvas unchanged (see drawScene) */
const GUARD_PX = 2048;
/** arcs with a larger screen radius are drawn as chords of their visible part */
const ARC_MAX_PX = 1e5;
/** Liang-Barsky: parameter range [t0, t1] of p + t (dx, dy), t in [0, 1], inside the box; null when outside */
export function clipSegment(px, py, dx, dy, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1;
  const edge = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!edge(-dx, px - x0) || !edge(dx, x1 - px) || !edge(-dy, py - y0) || !edge(dy, y1 - py)) return null;
  return [t0, t1];
}
/** Sutherland-Hodgman: ring [x0, y0, x1, y1, ...] clipped to the box; `out(points)` gets the result when not empty */
export function clipRing(ring, x0, y0, x1, y1, out) {
  let pts = ring;
  const pass = (inside, cut) => {
    const n = pts.length, res = [];
    for (let i = 0; i < n; i += 2) {
      const ax = pts[i], ay = pts[i + 1], bx = pts[(i + 2) % n], by = pts[(i + 3) % n], ia = inside(ax, ay), ib = inside(bx, by);
      if (ia) res.push(ax, ay);
      if (ia !== ib) res.push(...cut(ax, ay, bx, by));
    }
    pts = res;
  };
  const cx = (x) => (ax, ay, bx, by) => [x, ay + (by - ay) * (x - ax) / (bx - ax)];
  const cy = (y) => (ax, ay, bx, by) => [ax + (bx - ax) * (y - ay) / (by - ay), y];
  pass((x) => x >= x0, cx(x0)); if (pts.length) pass((x) => x <= x1, cx(x1));
  if (pts.length) pass((x, y) => y >= y0, cy(y0)); if (pts.length) pass((x, y) => y <= y1, cy(y1));
  if (pts.length >= 6) out(pts);
}
/** angle range [a, b] (radians, b - a < pi) seen from world centre (cx, cy) covering the view grown by `pad` px;
 *  null when the centre is inside it */
function arcWindow(cx, cy, view, pad) {
  const hw = (view.width / 2 + pad) / view.zoom, hh = (view.height / 2 + pad) / view.zoom;
  const ox = view.cx - cx, oy = view.cy - cy;
  if (Math.abs(ox) <= hw && Math.abs(oy) <= hh) return null;
  const ref = Math.atan2(oy, ox);
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of [[ox - hw, oy - hh], [ox + hw, oy - hh], [ox + hw, oy + hh], [ox - hw, oy + hh]]) {
    let a = Math.atan2(y, x) - ref;
    a -= Math.round(a / TAU) * TAU;
    lo = Math.min(lo, a); hi = Math.max(hi, a);
  }
  return [ref + lo, ref + hi];
}

export function drawScene(ctx, scene, view, opts = {}) {
  const { width: W, height: H, zoom: z } = view;
  const bg = opts.background ?? '#1b1f23';
  const dark = luminance(bg) < 0.5;
  const doc = scene.doc;
  const dpr = opts.dpr ?? 1;
  if (opts.baseTransform) ctx.setTransform(opts.baseTransform); // drawLayout: viewport placement (clip, twist)
  else ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // view.width/height are CSS pixels
  if (!opts.noClear) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const sx = (x) => (x - view.cx) * z + W / 2;
  const sy = (y) => H / 2 - (y - view.cy) * z;
  const minx = view.cx - W / 2 / z, maxx = view.cx + W / 2 / z, miny = view.cy - H / 2 / z, maxy = view.cy + H / 2 / z;
  const hi = opts.highlight instanceof Set ? opts.highlight : null;
  const aOf = opts.transparency === false ? () => 1 : (st) => st.alpha ?? 1; // View > Transparency off: all opaque
  const colorOf = (st) => (st.color.auto ? (dark ? '#ffffff' : '#000000') : (st._css ??= rgbCss(st.color.rgb)));
  const lwPx = (st) => {
    if (!opts.showLineweight) return 1;
    const mm = st.lw >= 0 ? st.lw : 0.25;
    return Math.min(8, Math.max(1, mm * (opts.pixelsPerMm ?? 3.78)));
  };

  const tracePath = (ops) => {
    for (let i = 0; i < ops.length;) {
      const op = ops[i];
      if (op === OP_M) { ctx.moveTo(sx(ops[i + 1]), sy(ops[i + 2])); i += 3; }
      else if (op === OP_L) { ctx.lineTo(sx(ops[i + 1]), sy(ops[i + 2])); i += 3; }
      else if (op === OP_A) {
        const r = ops[i + 3] * z;
        const a0 = ops[i + 4], sw = ops[i + 5];
        if (r < 0.01) { i += 6; continue; }
        ctx.arc(sx(ops[i + 1]), sy(ops[i + 2]), r, -a0, -(a0 + sw), sw > 0);
        i += 6;
      } else if (op === OP_E) {
        const rx = ops[i + 3] * z, ry = ops[i + 4] * z;
        if (rx < 0.01) { i += 8; continue; }
        const t0 = ops[i + 6], sw = ops[i + 7];
        ctx.ellipse(sx(ops[i + 1]), sy(ops[i + 2]), rx, Math.max(ry, 0.01), -ops[i + 5], -t0, -(t0 + sw), sw > 0);
        i += 8;
      } else if (op === OP_Z) { ctx.closePath(); i += 1; } else break;
    }
  };

  // Deep zoom: screen coordinates of far-away parts of visible items grow without bound (a 9 km line at 1 mm/px ends
  // ~1e7 px off screen). GPU canvas backends drop or distort paths with such coordinates, and one bad point loses the
  // whole batch. So paths are clipped in doubles to a guard band around the view before they reach the canvas:
  // strokes segment by segment (dash phase kept), fill rings with Sutherland-Hodgman.
  const gx0 = -GUARD_PX, gy0 = -GUARD_PX, gx1 = W + GUARD_PX, gy1 = H + GUARD_PX;
  const inGuard = (x, y) => x >= gx0 && x <= gx1 && y >= gy0 && y <= gy1;
  const far = (ops) => {
    for (let i = 0; i < ops.length;) {
      const op = ops[i];
      if (op === OP_M || op === OP_L) { if (!inGuard(sx(ops[i + 1]), sy(ops[i + 2]))) return true; i += 3; }
      else if (op === OP_A) { const r = ops[i + 3] * z, x = sx(ops[i + 1]), y = sy(ops[i + 2]); if (!inGuard(x - r, y - r) || !inGuard(x + r, y + r)) return true; i += 6; }
      else if (op === OP_E) { const r = Math.max(ops[i + 3], ops[i + 4]) * z, x = sx(ops[i + 1]), y = sy(ops[i + 2]); if (!inGuard(x - r, y - r) || !inGuard(x + r, y + r)) return true; i += 8; }
      else if (op === OP_Z) i += 1; else break;
    }
    return false;
  };
  /** stroke outline of `ops` clipped to the guard band; `period` (px) keeps the dash phase of clipped segments */
  const strokePath = (ops, period = 0) => {
    if (!far(ops)) { tracePath(ops); return; }
    let px = 0, py = 0, fx = 0, fy = 0, pen = false, L = 0;
    const seg = (qx, qy) => { // p -> q, both screen
      const dx = qx - px, dy = qy - py, len = Math.hypot(dx, dy);
      if (pen && inGuard(qx, qy)) ctx.lineTo(qx, qy);
      else {
        const t = clipSegment(px, py, dx, dy, gx0, gy0, gx1, gy1);
        if (!t) pen = false;
        else {
          if (!pen || t[0] > 0) {
            let t0 = t[0];
            if (period > 0 && len > 0) { const back = (L + t0 * len) % period; if (back <= GUARD_PX) t0 -= back / len; }
            ctx.moveTo(px + dx * t0, py + dy * t0);
          }
          ctx.lineTo(px + dx * t[1], py + dy * t[1]);
          pen = t[1] === 1;
        }
      }
      if (period > 0) L += len;
      px = qx; py = qy;
    };
    for (let i = 0; i < ops.length;) {
      const op = ops[i];
      if (op === OP_M) { px = fx = sx(ops[i + 1]); py = fy = sy(ops[i + 2]); L = 0; pen = inGuard(px, py); if (pen) ctx.moveTo(px, py); i += 3; }
      else if (op === OP_L) { seg(sx(ops[i + 1]), sy(ops[i + 2])); i += 3; }
      else if (op === OP_Z) { seg(fx, fy); i += 1; }
      else if (op === OP_A || op === OP_E) {
        const e = op === OP_E, n = e ? 8 : 6, cx = ops[i + 1], cy = ops[i + 2], R = ops[i + 3];
        const Ry = e ? ops[i + 4] : R, rot = e ? ops[i + 5] : 0, a0 = ops[e ? i + 6 : i + 4], sw = ops[e ? i + 7 : i + 5];
        const r = Math.max(R, Ry) * z, ccx = sx(cx), ccy = sy(cy);
        const at = (t) => { const c = Math.cos(t) * R, s = Math.sin(t) * Ry, cr = Math.cos(rot), sr = Math.sin(rot); return [sx(cx + c * cr - s * sr), sy(cy + c * sr + s * cr)]; };
        const [ex, ey] = at(a0 + sw);
        if (R * z < 0.01 || ccx + r < gx0 || ccx - r > gx1 || ccy + r < gy0 || ccy - r > gy1) { pen = false; px = ex; py = ey; i += n; continue; }
        if (r <= ARC_MAX_PX) { // small enough: native arc, starting with a move if the pen was lifted
          if (!pen) { const [bx, by] = at(a0); ctx.moveTo(bx, by); }
          if (e) ctx.ellipse(ccx, ccy, R * z, Math.max(Ry * z, 0.01), -rot, -a0, -(a0 + sw), sw > 0);
          else ctx.arc(ccx, ccy, r, -a0, -(a0 + sw), sw > 0);
          if (period > 0) L += Math.abs(sw) * r;
          pen = true; px = ex; py = ey; i += n; continue;
        }
        // huge radius: only the part near the view, as chords within 0.1 px of the curve, through the segment clipper
        const step = 2 * Math.sqrt(0.2 / r), win = e ? null : arcWindow(cx, cy, view, GUARD_PX), d = Math.sign(sw) || 1;
        const lo = Math.min(a0, a0 + sw), hi = Math.max(a0, a0 + sw), pieces = [];
        if (!win) pieces.push([lo, hi]);
        else for (let k = Math.floor((lo - win[1]) / TAU); k <= Math.ceil((hi - win[0]) / TAU); k++) {
          const p0 = Math.max(lo, win[0] + k * TAU), p1 = Math.min(hi, win[1] + k * TAU);
          if (p1 > p0) pieces.push([p0, p1]);
        }
        if (d < 0) pieces.reverse();
        for (const [p0, p1] of pieces) {
          if ((p1 - p0) / step > 200000) continue;
          const s0 = d > 0 ? p0 : p1, s1 = d > 0 ? p1 : p0, m = Math.max(1, Math.ceil((p1 - p0) / step));
          const L0 = L;
          if (period > 0) L = L0 + Math.abs(s0 - a0) * r;
          pen = false; [px, py] = at(s0);
          for (let j = 1; j <= m; j++) { const [qx, qy] = at(s0 + (s1 - s0) * j / m); seg(qx, qy); }
          L = L0;
        }
        if (period > 0) L += Math.abs(sw) * r;
        pen = false; px = ex; py = ey; i += n;
      } else break;
    }
  };
  /** fill outline of `ops`: rings made of lines are clipped to the guard band (fills stay correct inside it) */
  const fillPath = (ops) => {
    if (!far(ops)) { tracePath(ops); return; }
    let ring = [], plain = true, start = 0;
    const flush = (end) => {
      if (plain) clipRing(ring, gx0, gy0, gx1, gy1, (pts) => { for (let j = 0; j < pts.length; j += 2) (j ? ctx.lineTo(pts[j], pts[j + 1]) : ctx.moveTo(pts[j], pts[j + 1])); ctx.closePath(); });
      else tracePath(ops.slice(start, end));
      ring = []; plain = true;
    };
    for (let i = 0; i < ops.length;) {
      const op = ops[i];
      if (op === OP_M) { if (ring.length || !plain) flush(i); start = i; ring.push(sx(ops[i + 1]), sy(ops[i + 2])); i += 3; }
      else if (op === OP_L) { ring.push(sx(ops[i + 1]), sy(ops[i + 2])); i += 3; }
      else if (op === OP_Z) i += 1;
      else if (op === OP_A) { plain = false; i += 6; } else if (op === OP_E) { plain = false; i += 8; } else break;
    }
    if (ring.length || !plain) flush(ops.length);
  };

  // one pass over the visible items buckets them for the drawing phases (grid-culled, scene order kept).
  // Level of detail: an item under 1 px on screen becomes a 1-px dot (one fill per colour); a pattern hatch whose
  // line spacing is under 2 px (or that is tiny) becomes a light tint (one fill per colour, no clip); text under
  // 2 px high becomes a bar (one stroke per colour).
  const prof = opts.profile; // optional (phase, info) callback after each phase (scripts/bench.mjs)
  const vis = visibleItems(scene, minx, miny, maxx, maxy);
  prof?.('query', vis.length);
  // wipeouts mask what comes before them: the items are drawn in levels (see wipeoutLevels), each level's wipeout
  // fills (background colour) first, then its items batched as usual
  const levels = wipeoutLevels(scene);
  const drawItems = (vis) => {
    const fills = [], marks = [], texts = [], images = [], batches = new Map(), dots = new Map(), tints = new Map(), bars = new Map();
    const lwSig = opts.showLineweight ? (opts.pixelsPerMm ?? 3.78) : 0;
    // per colour and opacity: list.col, list.a
    const bucket = (map, st) => {
      const col = colorOf(st), a = aOf(st), key = a === 1 ? col : `${col}|${a}`;
      let l = map.get(key); if (!l) { map.set(key, (l = [])); l.col = col; l.a = a; } return l;
    };
    for (const it of vis) {
      const k = it.kind;
      if (k === 'wipeout') continue;
      if (it.arrow || k === 'point') marks.push(it);
      if (k === 'point') continue;
      const b = it.bbox;
      const tiny = b && (b.maxx - b.minx) * z < 1 && (b.maxy - b.miny) * z < 1;
      if (k === 'hatch' && !it.solid && it.lines) {
        it._sp ??= patternSpacing(it.lines);
        if (tiny || it._sp * z < 2) { bucket(tints, it.style).push(it); continue; }
      }
      if (k === 'image') { images.push(it); continue; }
      if (tiny) { bucket(dots, it.style).push(it); continue; }
      if (it.strokeText && it.strokeText.h * z < 2) { bucket(bars, it.style).push(it.strokeText); continue; }
      if (k === 'hatch' || k === 'fill') fills.push(it);
      else if (k === 'path' || k === 'hatchOutline') {
        const st = it.style;
        if (st._ks !== lwSig) { st._ks = lwSig; st._key = `${st.color.auto ? 'a' : st.color.rgb.join(',')}|${lwPx(st)}|${st.lt}|${st.lts}|${st.alpha ?? 1}`; }
        let bt = batches.get(st._key);
        if (!bt) batches.set(st._key, (bt = { st, items: [] }));
        bt.items.push(it);
      } else if (k === 'text') {
        if (!it.mt && it.h * z < 2) bucket(bars, it.style).push(it);
        else texts.push(it);
      }
    }
    if (prof) {
      const n = (m) => { let c = 0; for (const v of m.values()) c += (v.items ?? v).length; return c; };
      prof('bucket', { fills: fills.length, tints: n(tints), dots: n(dots), lines: n(batches), batches: batches.size, marks: marks.length, bars: n(bars), texts: texts.length });
    }

    // 0. raster images, in draw order, under the vector work
    for (const it of images) drawImageItem(ctx, it, doc.images?.get(it.image.path)?.bitmap, sx, sy, z);
    prof?.('images');

    // 1. hatches and solid fills; LOD tints first (one fill per colour), then the per-item fills and patterns
    const fillAlphaPattern = opts.patternFallbackAlpha ?? 0.25;
    if (tints.size) {
      ctx.save();
      for (const list of tints.values()) {
        ctx.globalAlpha = fillAlphaPattern * list.a; ctx.fillStyle = list.col;
        ctx.beginPath();
        // single-loop boundaries share one non-zero path, all wound the same way so overlaps do not cancel
        for (const it of list) if (loopCount(it) === 1) traceLoopCcw(ctx, it, sx, sy);
        ctx.fill();
        for (const it of list) if (loopCount(it) !== 1) { ctx.beginPath(); fillPath(it.ops); ctx.fill('evenodd'); }
      }
      ctx.restore();
    }
    prof?.('tints');
    for (const it of fills) {
      const col = colorOf(it.style), a = aOf(it.style);
      ctx.globalAlpha = a;
      if (it.kind === 'fill' || it.solid) {
        ctx.beginPath(); fillPath(it.ops);
        ctx.fillStyle = col; ctx.fill('evenodd');
      } else if (it.lines) {
        drawPatternHatch(ctx, it, view, col, fillPath, sx, sy, fillAlphaPattern * a);
      } else {
        ctx.beginPath(); fillPath(it.ops); ctx.save(); ctx.globalAlpha = fillAlphaPattern * a; ctx.fillStyle = col; ctx.fill('evenodd'); ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    prof?.('fills');

    // LOD dots: one 1-px rect per covered pixel and colour, one fill per colour
    if (dots.size) {
      const Wi = Math.ceil(W), Hi = Math.ceil(H), stamp = dotStamp(Wi * Hi);
      let ci = 0;
      for (const list of dots.values()) {
        const col = list.col;
        ctx.globalAlpha = list.a;
        const mark = dotFrame * 256 + (ci++ & 255);
        ctx.beginPath();
        for (const it of list) {
          const b = it.bbox;
          const x = Math.floor(sx((b.minx + b.maxx) / 2)), y = Math.floor(sy((b.miny + b.maxy) / 2));
          if (x < 0 || y < 0 || x >= Wi || y >= Hi) continue;
          const i = y * Wi + x;
          if (stamp[i] === mark) continue;
          stamp[i] = mark;
          ctx.rect(x, y, 1, 1);
        }
        ctx.fillStyle = col; ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    prof?.('dots');

    // 2. line work, batched by style
    for (const { st, items } of batches.values()) {
      const dash = dashFor(doc, st, z), period = dash ? dash.reduce((a, b) => a + b, 0) : 0;
      ctx.beginPath();
      for (const it of items) strokePath(it.ops, period);
      ctx.strokeStyle = colorOf(st); ctx.globalAlpha = aOf(st);
      ctx.lineWidth = lwPx(st);
      ctx.setLineDash(dash ?? []);
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    prof?.('lines');

    // leader arrow heads and points
    for (const it of marks) {
      ctx.globalAlpha = aOf(it.style);
      if (it.arrow) {
        ctx.fillStyle = colorOf(it.style);
        const a = it.arrow[0], b = it.arrow[1];
        const dx = sx(b.x) - sx(a.x), dy = sy(b.y) - sy(a.y), l = Math.hypot(dx, dy) || 1;
        const ux = dx / l, uy = dy / l, size = 9;
        ctx.beginPath(); ctx.moveTo(sx(b.x), sy(b.y));
        ctx.lineTo(sx(b.x) - ux * size + uy * size * 0.2, sy(b.y) - uy * size - ux * size * 0.2);
        ctx.lineTo(sx(b.x) - ux * size - uy * size * 0.2, sy(b.y) - uy * size + ux * size * 0.2);
        ctx.closePath(); ctx.fill();
      } else {
        const x = sx(it.p.x), y = sy(it.p.y);
        ctx.strokeStyle = colorOf(it.style); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
    prof?.('marks');

    // 3. text; LOD bars (text under 2 px) as one stroke per colour
    if (bars.size) {
      ctx.save(); ctx.lineWidth = 1;
      for (const list of bars.values()) {
        const col = list.col; ctx.globalAlpha = 0.5 * list.a;
        ctx.beginPath();
        for (const it of list) {
          const x = sx(it.p.x), y = sy(it.p.y);
          const w = it.lines ? (it._maxLen ??= Math.max(...it.lines.map((l) => l.length))) * it.h * z * 0.6 * it.wf : it.w * z;
          ctx.moveTo(x, y); ctx.lineTo(x + w * Math.cos(it.rot), y - w * Math.sin(it.rot));
        }
        ctx.strokeStyle = col; ctx.stroke();
      }
      ctx.restore();
    }
    prof?.('bars');
    for (const it of texts) {
      ctx.globalAlpha = aOf(it.style);
      if (it.mt) drawMText(ctx, it, sx(it.p.x), sy(it.p.y), z, colorOf(it.style), dark);
      else drawText(ctx, it, sx(it.p.x), sy(it.p.y), z, colorOf(it.style));
    }
    ctx.globalAlpha = 1;
    prof?.('text');
  };
  if (!levels) drawItems(vis);
  else {
    const per = Array.from({ length: levels + 1 }, () => ({ wipe: [], items: [] }));
    for (const it of vis) (it.kind === 'wipeout' ? per[it.wl].wipe : per[it.wl].items).push(it);
    for (const { wipe, items } of per) {
      if (wipe.length) { ctx.beginPath(); for (const it of wipe) fillPath(it.ops); ctx.fillStyle = bg; ctx.fill(); }
      if (items.length) drawItems(items);
    }
  }

  // 4. highlight / selection overlay
  if (hi && hi.size) {
    ctx.save();
    ctx.strokeStyle = opts.highlightColor ?? '#4dd2ff';
    ctx.fillStyle = opts.highlightColor ?? '#4dd2ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    for (const id of hi) {
      const list = scene.byId.get(id);
      if (!list) continue;
      for (const it of list) {
        if (it.kind === 'path' || it.kind === 'hatch' || it.kind === 'fill' || it.kind === 'image' || it.kind === 'wipeout') { ctx.beginPath(); strokePath(it.ops, 9); ctx.stroke(); }
        else if (it.kind === 'text' || it.kind === 'point') {
          const b = it.bbox;
          if (b) ctx.strokeRect(sx(b.minx) - 2, sy(b.maxy) - 2, (b.maxx - b.minx) * z + 4, (b.maxy - b.miny) * z + 4);
        }
      }
    }
    ctx.restore();
  }
}

/** Draw levels for scenes with wipeouts (it.wl; returns the highest level, 0 when the scene has none). A wipeout must
 *  be drawn after the earlier items it overlaps and before the later ones; batching may reorder everything else. So,
 *  in scene order over a coarse grid of the scene bbox: an item's level is the highest level of the earlier wipeouts
 *  touching its cells, a wipeout's is one more than the highest level of the earlier items touching its cells.
 *  Cells over-approximate overlap, which only adds levels. Recomputed when the scene version changes. */
function wipeoutLevels(scene) {
  if (scene._wlVer === scene.version) return scene._wl;
  scene._wlVer = scene.version;
  const items = scene.items, sb = scene.bbox;
  if (!sb || !items.some((it) => it.kind === 'wipeout')) return (scene._wl = 0);
  const G = 64, kx = G / ((sb.maxx - sb.minx) || 1), ky = G / ((sb.maxy - sb.miny) || 1);
  const nrm = new Int32Array(G * G).fill(-1), wip = new Int32Array(G * G);
  const cell = (v, k, o) => Math.max(0, Math.min(G - 1, Math.floor((v - o) * k)));
  let top = 0;
  for (const it of items) {
    const b = it.bbox ?? sb, wipe = it.kind === 'wipeout';
    const x0 = cell(b.minx, kx, sb.minx), x1 = cell(b.maxx, kx, sb.minx), y0 = cell(b.miny, ky, sb.miny), y1 = cell(b.maxy, ky, sb.miny);
    let l = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = wipe ? nrm[y * G + x] + 1 : wip[y * G + x]; if (v > l) l = v; }
    const arr = wipe ? wip : nrm;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (arr[y * G + x] < l) arr[y * G + x] = l;
    it.wl = l;
    if (l > top) top = l;
  }
  return (scene._wl = top);
}

/** one raster image: bitmap pixel (x, y) (y down from the top row) maps to p + u x + v (rows - y) in the drawing;
 *  the clip boundary (world points) clips it, fade 0..100 lowers its opacity */
function drawImageItem(ctx, it, bmp, sx, sy, z) {
  const { p, u, v, size, clipPts, fade } = it.image;
  if (!bmp) return;
  ctx.save();
  if (clipPts?.length >= 3) {
    ctx.beginPath();
    clipPts.forEach((q, i) => (i ? ctx.lineTo(sx(q.x), sy(q.y)) : ctx.moveTo(sx(q.x), sy(q.y))));
    ctx.closePath(); ctx.clip();
  }
  ctx.globalAlpha = Math.max(0, Math.min(1, 1 - (fade || 0) / 100));
  const top = { x: p.x + v.x * size.y, y: p.y + v.y * size.y };
  ctx.transform(u.x * z, -u.y * z, -v.x * z, v.y * z, sx(top.x), sy(top.y));
  ctx.drawImage(bmp, 0, 0, size.x, size.y);
  ctx.restore();
}

// LOD helpers: shared 1-px dot de-duplication buffer (stamped per frame), hatch pattern spacing, CCW loop tracing
let dotBuf = null, dotFrame = 0;
function dotStamp(n) {
  if (!dotBuf || dotBuf.length < n) { dotBuf = new Uint32Array(n); dotFrame = 0; }
  if (++dotFrame >= 0xffffff) { dotBuf.fill(0); dotFrame = 1; }
  return dotBuf;
}
/** smallest perpendicular spacing of a hatch's pattern line families (world units) */
function patternSpacing(lines) {
  let m = Infinity;
  for (const L of lines) {
    const a = L.angle * DEG;
    m = Math.min(m, Math.abs(-L.offset.x * Math.sin(a) + L.offset.y * Math.cos(a)));
  }
  return m;
}
/** number of boundary loops of a hatch item (its ops are M/L/Z only) */
function loopCount(it) {
  if (it._loops === undefined) { let n = 0; for (let i = 0; i < it.ops.length; i += it.ops[i] === OP_Z ? 1 : 3) if (it.ops[i] === OP_M) n++; it._loops = n; }
  return it._loops;
}
/** trace a single-loop hatch boundary counter-clockwise (world), whichever way it was stored */
function traceLoopCcw(ctx, it, sx, sy) {
  const o = it.ops;
  let n = 0; while (n < o.length && o[n] !== OP_Z) n += 3; // n = end of the point ops
  if (it._ccw === undefined) {
    let a = 0;
    for (let i = 0; i < n; i += 3) { const j = i + 3 < n ? i + 3 : 0; a += o[i + 1] * o[j + 2] - o[j + 1] * o[i + 2]; }
    it._ccw = a >= 0;
  }
  if (it._ccw) { ctx.moveTo(sx(o[1]), sy(o[2])); for (let i = 3; i < n; i += 3) ctx.lineTo(sx(o[i + 1]), sy(o[i + 2])); }
  else { ctx.moveTo(sx(o[n - 2]), sy(o[n - 1])); for (let i = n - 6; i >= 0; i -= 3) ctx.lineTo(sx(o[i + 1]), sy(o[i + 2])); }
  ctx.closePath();
}

function drawText(ctx, it, x, y, z, color) {
  const px = it.h * z;
  const lineH = px * (it.mtext ? 1.25 : 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-it.rot);
  ctx.scale(it.wf, 1);
  ctx.font = `${px}px "${it.font}", Arial, "Segoe UI", sans-serif`;
  ctx.fillStyle = color;
  let lines = it.lines;
  if (it.mtext && it.boxW > 0) lines = wrapLines(ctx, lines, it.boxW * z / it.wf);
  const n = lines.length;
  // MTEXT attachment: 1-3 top, 4-6 middle, 7-9 bottom ; left/centre/right = 1,2,3 mod 3
  let hAlign = it.hAlign, vOff = 0;
  if (it.mtext) {
    const col = ((it.attach - 1) % 3), row = Math.floor((it.attach - 1) / 3);
    hAlign = col === 0 ? 0 : col === 1 ? 1 : 2;
    ctx.textBaseline = 'alphabetic';
    vOff = row === 0 ? px * 0.9 : row === 1 ? px * 0.9 - (n * lineH) / 2 + px * 0.0 : px * 0.9 - n * lineH + lineH * 0.9;
  } else {
    ctx.textBaseline = 'alphabetic';
    const v = it.vAlign; // 0 baseline, 1 bottom, 2 middle, 3 top
    vOff = v === 1 ? -px * 0.2 : v === 2 || hAlign === 4 ? px * 0.35 : v === 3 ? px * 0.8 : 0;
  }
  ctx.textAlign = hAlign === 1 || hAlign === 4 ? 'center' : hAlign === 2 ? 'right' : 'left';
  for (let i = 0; i < n; i++) ctx.fillText(lines[i], 0, vOff + i * lineH);
  ctx.restore();
}

/** CSS font for an MTEXT glyph / run at `px` pixels. */
export const mtextFont = (g, px, fallback) => `${g.italic ? 'italic ' : ''}${g.bold ? 'bold ' : ''}${px}px "${g.font || fallback}", Arial, "Segoe UI", sans-serif`;

/** MTEXT layout of a scene item, measured with canvas fonts (cached on the item). */
export function mtextLayout(ctx, it) {
  if (it.lay) return it.lay;   // MTEXT with stroke (SHX) runs: fixed layout from buildScene
  if (it._lay) return it._lay;
  const REF = 100;
  const measure = (t, p) => { ctx.font = mtextFont(p, REF, it.font); return ctx.measureText(t).width * p.h / REF; };
  it._lay = layoutMText(it.mt, { width: it.boxW, attach: it.attach, lineSpacing: it.lineSpacing, measure });
  return it._lay;
}

function drawMText(ctx, it, x, y, z, color, dark) {
  ctx.save();
  const lay = mtextLayout(ctx, it);
  const colOf = (c) => (!c ? color : c.rgb ? rgbCss(c.rgb) : c.aci === 7 ? (dark ? '#ffffff' : '#000000') : rgbCss(aciToRgb(c.aci)));
  ctx.translate(x, y);
  ctx.rotate(-it.rot);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  for (const g of lay.glyphs) {
    const px = g.h * z;
    ctx.fillStyle = colOf(g.color);
    if (px < 2) { const ga = ctx.globalAlpha; ctx.globalAlpha = ga * 0.5; ctx.fillRect(g.x * z, g.y * z - 1, (g.w ?? g.text.length * g.h * 0.6) * z, 1); ctx.globalAlpha = ga; continue; }
    ctx.save();
    ctx.translate(g.x * z, g.y * z);
    if (g.oblique) ctx.transform(1, 0, -Math.tan(g.oblique * DEG), 1, 0, 0);
    ctx.scale(g.wf || 1, 1);
    ctx.font = mtextFont(g, px, it.font);
    if (g.track && g.track !== 1) ctx.letterSpacing = `${(g.track - 1) * px * 0.6}px`;
    ctx.fillText(g.text, 0, 0);
    ctx.restore();
  }
  for (const r of lay.rules) {
    ctx.strokeStyle = colOf(r.color); ctx.lineWidth = Math.max(1, r.h * z * 0.06);
    ctx.beginPath(); ctx.moveTo(r.x1 * z, r.y * z); ctx.lineTo(r.x2 * z, r.y * z); ctx.stroke();
  }
  ctx.restore();
}

function wrapLines(ctx, lines, maxW) {
  const out = [];
  for (const line of lines) {
    if (ctx.measureText(line).width <= maxW) { out.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      const t = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = word; } else cur = t;
    }
    out.push(cur);
  }
  return out;
}

/** Pattern hatch: clip to the boundary, then draw each pattern line family across the bounding box. */
function drawPatternHatch(ctx, it, view, color, tracePath, sx, sy, fallbackAlpha) {
  const z = view.zoom;
  ctx.save();
  ctx.beginPath(); tracePath(it.ops); ctx.clip('evenodd');
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  const vminx = view.cx - view.width / 2 / z, vmaxx = view.cx + view.width / 2 / z;
  const vminy = view.cy - view.height / 2 / z, vmaxy = view.cy + view.height / 2 / z;
  const b = it.bbox;
  const bx0 = Math.max(b.minx, vminx), bx1 = Math.min(b.maxx, vmaxx), by0 = Math.max(b.miny, vminy), by1 = Math.min(b.maxy, vmaxy);
  if (bx1 <= bx0 || by1 <= by0) { ctx.restore(); return; }
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, R = Math.hypot(bx1 - bx0, by1 - by0) / 2 + 1e-9;
  let dense = false;
  for (const L of it.lines) {
    const a = L.angle * DEG, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const spacing = Math.abs(L.offset.x * nx + L.offset.y * ny);
    if (spacing * z < 3) { dense = true; break; }
  }
  if (dense) { ctx.globalAlpha = fallbackAlpha; ctx.fillStyle = color; ctx.fillRect(0, 0, view.width, view.height); ctx.restore(); return; }
  ctx.beginPath();
  for (const L of it.lines) {
    const a = L.angle * DEG, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const spacing = L.offset.x * nx + L.offset.y * ny;
    if (Math.abs(spacing) < 1e-9) continue;
    const d0 = (cx - L.base.x) * nx + (cy - L.base.y) * ny; // perpendicular distance of box centre from the base line
    const k0 = Math.floor((d0 - R) / spacing), k1 = Math.ceil((d0 + R) / spacing);
    const lo = Math.min(k0, k1) - 1, hi = Math.max(k0, k1) + 1;
    if (hi - lo > 4000) continue;
    for (let k = lo; k <= hi; k++) {
      const ox = L.base.x + k * L.offset.x, oy = L.base.y + k * L.offset.y;
      const t0 = (cx - ox) * dx + (cy - oy) * dy;
      ctx.moveTo(sx(ox + dx * (t0 - R)), sy(oy + dy * (t0 - R)));
      ctx.lineTo(sx(ox + dx * (t0 + R)), sy(oy + dy * (t0 + R)));
    }
    if (L.dashes && L.dashes.length) {
      // dashes apply along each line; draw per family
      ctx.setLineDash(L.dashes.map((d) => Math.max(Math.abs(d) * z, 0.5)));
    }
    ctx.stroke(); ctx.beginPath();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// view helpers
export function fitView(bbox, width, height, margin = 0.05) {
  if (!bbox) return { cx: 0, cy: 0, zoom: 1, width, height };
  const w = Math.max(bbox.maxx - bbox.minx, 1e-9), h = Math.max(bbox.maxy - bbox.miny, 1e-9);
  const zoom = Math.min(width / w, height / h) * (1 - margin * 2);
  return { cx: (bbox.minx + bbox.maxx) / 2, cy: (bbox.miny + bbox.maxy) / 2, zoom, width, height };
}
export const screenToWorld = (view, sx, sy) => ({ x: view.cx + (sx - view.width / 2) / view.zoom, y: view.cy - (sy - view.height / 2) / view.zoom });
export const worldToScreen = (view, p) => ({ x: (p.x - view.cx) * view.zoom + view.width / 2, y: view.height / 2 - (p.y - view.cy) * view.zoom });
/** zoom range (px per drawing unit) for a drawing with extents `bbox`: out to 1/1000 of the fitted zoom, in to
 *  1e-9 of the extents per pixel, and never so deep that a pixel is under 2^-36 of the largest coordinate (doubles
 *  then still place points to ~1e-5 px, so panning does not wobble) */
export function zoomLimits(bbox, width, height) {
  if (!bbox || !Number.isFinite(bbox.minx)) return { min: 1e-9, max: 1e9 };
  const size = Math.max(bbox.maxx - bbox.minx, bbox.maxy - bbox.miny, 1e-6);
  const mag = Math.max(Math.abs(bbox.minx), Math.abs(bbox.maxx), Math.abs(bbox.miny), Math.abs(bbox.maxy), size);
  const fit = fitView(bbox, width, height, 0.04).zoom;
  return { min: fit / 1000, max: Math.max(fit, Math.min(1e9 / size, 2 ** 36 / mag)) };
}
export function zoomAt(view, sx, sy, factor, limits = { min: 1e-9, max: 1e9 }) {
  const before = screenToWorld(view, sx, sy);
  const zoom = Math.min(Math.max(limits.max, Math.min(view.zoom, 1e9)), Math.max(Math.min(limits.min, view.zoom), view.zoom * factor));
  if (zoom === view.zoom) return view;
  const v = { ...view, zoom };
  const after = screenToWorld(v, sx, sy);
  return { ...v, cx: v.cx + (before.x - after.x), cy: v.cy + (before.y - after.y) };
}

// ---------------------------------------------------------------------------------------------
// paper-space layouts
/** model point -> paper point through a VIEWPORT (scale 1:N = viewHeight/height, twist turns the model counter-clockwise) */
export function viewportToPaper(vp, p) {
  const k = vp.height / (vp.viewHeight || 1), t = vp.twist || 0, c = Math.cos(t), s = Math.sin(t);
  const dx = p.x - vp.viewCenter.x, dy = p.y - vp.viewCenter.y;
  return { x: vp.c.x + k * (c * dx - s * dy), y: vp.c.y + k * (s * dx + c * dy) };
}

/** a copy of `doc` whose layer table has the given layers frozen (for viewport-frozen layers) */
export function docWithFrozen(doc, frozen) {
  if (!frozen?.length) return doc;
  const set = new Set(frozen.map((n) => String(n).toUpperCase()));
  const layers = new Map([...doc.layers].map(([k, l]) => [k, set.has(String(k).toUpperCase()) ? { ...l, frozen: true } : l]));
  return { ...doc, layers };
}

/** layout (paper space) colours: the sheet is always white and the surround mid-grey, whatever the model-space background */
export const PAPER_COLOUR = '#ffffff';
export const PAPER_SURROUND = '#8a8f96';

/** Draw a layout: grey surround, white sheet with shadow, dashed printable area, viewports showing model space
 *  (scene per frozen-layer set from `modelScene(frozen)`), then the paper-space scene and its highlight. */
export function drawLayout(ctx, paperScene, view, layout, paperRectsOf, modelScene, opts = {}) {
  const { width: W, height: H, zoom: z } = view, dpr = opts.dpr ?? 1;
  const sx = (x) => (x - view.cx) * z + W / 2, sy = (y) => H / 2 - (y - view.cy) * z;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = opts.surround ?? PAPER_SURROUND; ctx.fillRect(0, 0, W, H);
  const { sheet, printable } = paperRectsOf(layout);
  const r = (b) => [sx(b.minx), sy(b.maxy), (b.maxx - b.minx) * z, (b.maxy - b.miny) * z];
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; const sr = r(sheet); ctx.fillRect(sr[0] + 4, sr[1] + 4, sr[2], sr[3]);
  ctx.fillStyle = PAPER_COLOUR; ctx.fillRect(...sr);
  ctx.strokeStyle = '#888'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.strokeRect(...r(printable)); ctx.setLineDash([]);
  const vports = paperScene.doc.entities.filter((e) => e.type === 'VIEWPORT' && e.vpId !== 1 && e.on !== false && e.width > 0 && e.height > 0);
  for (const v of vports) {
    const k = (v.height / (v.viewHeight || 1)) * z, cx = sx(v.c.x), cy = sy(v.c.y), w = v.width * z, h = v.height * z;
    const D = Math.hypot(w, h) + 2;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath(); ctx.rect(cx - w / 2, cy - h / 2, w, h); ctx.clip();
    // model view centred on the viewport, D x D pixels so culling covers the rotated window
    ctx.translate(cx, cy); ctx.rotate(-(v.twist || 0)); ctx.translate(-D / 2, -D / 2);
    drawScene(ctx, modelScene(v.frozen ?? []), { cx: v.viewCenter.x, cy: v.viewCenter.y, zoom: k, width: D, height: D },
      { ...opts, background: PAPER_COLOUR, noClear: true, baseTransform: ctx.getTransform(), highlight: v === opts.activeVp ? opts.modelHighlight : null });
    ctx.restore();
  }
  drawScene(ctx, paperScene, view, { ...opts, background: PAPER_COLOUR, noClear: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
  for (const v of vports) {
    const sel = opts.highlight instanceof Set && opts.highlight.has(v.id);
    ctx.strokeStyle = sel ? (opts.highlightColor ?? '#0a6fd1') : '#333'; ctx.lineWidth = v === opts.activeVp ? 3 : sel ? 2 : 1; ctx.strokeRect(sx(v.c.x - v.width / 2), sy(v.c.y + v.height / 2), v.width * z, v.height * z);
  }
}
