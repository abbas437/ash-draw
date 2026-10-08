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
import { resolveColor, aciToRgb } from './aci.js';
import { parseMText, layoutMText } from './mtext.js';
import {
  DEG, compose, translation, rotation, scaling, apply, isSimilarity, matScale, transformEntity, bulgeToArc,
  ccwSweep, tessellate, ellipsePoint, unionBox, growBox,
} from './geom.js';
import { plainText } from './dxfRead.js';
import { mleaderParts } from './mleader.js';
import { patternLines, hasPattern } from './patterns.js';
import { SceneGrid } from './sceneGrid.js';
import { strokeLayout } from './shx.js';
import { textFrame, textCorners } from './textMetrics.js';

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
    return { color, lw, lt, lts, layerName };
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
      grow(c.x - r, c.y - r); grow(c.x + r, c.y + r);
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
      case 'TEXT': case 'MTEXT': {
        const p = P(e.p);
        const h = (e.height || 1) * s;
        const rot = ((e.rot || 0) * DEG) + ang;
        const raw = plainText(e.text);
        if (!raw) return;
        const lines = raw.split('\n');
        const w = Math.max(...lines.map((l) => l.length)) * h * 0.6 * (e.widthFactor || 1);
        // conservative bbox around the (rotated) text block
        let box = null;
        const mt = e.type === 'MTEXT' ? parseMText(e.text, { height: h }) : null;
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

  // one pass over the visible items buckets them for the drawing phases (grid-culled, scene order kept).
  // Level of detail: an item under 1 px on screen becomes a 1-px dot (one fill per colour); a pattern hatch whose
  // line spacing is under 2 px (or that is tiny) becomes a light tint (one fill per colour, no clip); text under
  // 2 px high becomes a bar (one stroke per colour).
  const fills = [], marks = [], texts = [], batches = new Map(), dots = new Map(), tints = new Map(), bars = new Map();
  const lwSig = opts.showLineweight ? (opts.pixelsPerMm ?? 3.78) : 0;
  const bucket = (map, key) => { let l = map.get(key); if (!l) map.set(key, (l = [])); return l; };
  const prof = opts.profile; // optional (phase, info) callback after each phase (scripts/bench.mjs)
  const vis = visibleItems(scene, minx, miny, maxx, maxy);
  prof?.('query', vis.length);
  for (const it of vis) {
    const k = it.kind;
    if (it.arrow || k === 'point') marks.push(it);
    if (k === 'point') continue;
    const b = it.bbox;
    const tiny = b && (b.maxx - b.minx) * z < 1 && (b.maxy - b.miny) * z < 1;
    if (k === 'hatch' && !it.solid && it.lines) {
      it._sp ??= patternSpacing(it.lines);
      if (tiny || it._sp * z < 2) { bucket(tints, colorOf(it.style)).push(it); continue; }
    }
    if (tiny) { bucket(dots, colorOf(it.style)).push(it); continue; }
    if (it.strokeText && it.strokeText.h * z < 2) { bucket(bars, colorOf(it.style)).push(it.strokeText); continue; }
    if (k === 'hatch' || k === 'fill') fills.push(it);
    else if (k === 'path' || k === 'hatchOutline') {
      const st = it.style;
      if (st._ks !== lwSig) { st._ks = lwSig; st._key = `${st.color.auto ? 'a' : st.color.rgb.join(',')}|${lwPx(st)}|${st.lt}|${st.lts}`; }
      let bt = batches.get(st._key);
      if (!bt) batches.set(st._key, (bt = { st, items: [] }));
      bt.items.push(it);
    } else if (k === 'text') {
      if (!it.mt && it.h * z < 2) bucket(bars, colorOf(it.style)).push(it);
      else texts.push(it);
    }
  }
  if (prof) {
    const n = (m) => { let c = 0; for (const v of m.values()) c += (v.items ?? v).length; return c; };
    prof('bucket', { fills: fills.length, tints: n(tints), dots: n(dots), lines: n(batches), batches: batches.size, marks: marks.length, bars: n(bars), texts: texts.length });
  }

  // 1. hatches and solid fills; LOD tints first (one fill per colour), then the per-item fills and patterns
  const fillAlphaPattern = opts.patternFallbackAlpha ?? 0.25;
  if (tints.size) {
    ctx.save(); ctx.globalAlpha = fillAlphaPattern;
    for (const [col, list] of tints) {
      ctx.fillStyle = col;
      ctx.beginPath();
      // single-loop boundaries share one non-zero path, all wound the same way so overlaps do not cancel
      for (const it of list) if (loopCount(it) === 1) traceLoopCcw(ctx, it, sx, sy);
      ctx.fill();
      for (const it of list) if (loopCount(it) !== 1) { ctx.beginPath(); tracePath(it.ops); ctx.fill('evenodd'); }
    }
    ctx.restore();
  }
  prof?.('tints');
  for (const it of fills) {
    const col = colorOf(it.style);
    if (it.kind === 'fill' || it.solid) {
      ctx.beginPath(); tracePath(it.ops);
      ctx.fillStyle = col; ctx.fill('evenodd');
    } else if (it.lines) {
      drawPatternHatch(ctx, it, view, col, tracePath, sx, sy, fillAlphaPattern);
    } else {
      ctx.beginPath(); tracePath(it.ops); ctx.save(); ctx.globalAlpha = fillAlphaPattern; ctx.fillStyle = col; ctx.fill('evenodd'); ctx.restore();
    }
  }
  prof?.('fills');

  // LOD dots: one 1-px rect per covered pixel and colour, one fill per colour
  if (dots.size) {
    const Wi = Math.ceil(W), Hi = Math.ceil(H), stamp = dotStamp(Wi * Hi);
    let ci = 0;
    for (const [col, list] of dots) {
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
  }
  prof?.('dots');

  // 2. line work, batched by style
  for (const { st, items } of batches.values()) {
    ctx.beginPath();
    for (const it of items) tracePath(it.ops);
    ctx.strokeStyle = colorOf(st);
    ctx.lineWidth = lwPx(st);
    const dash = dashFor(doc, st, z);
    ctx.setLineDash(dash ?? []);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  prof?.('lines');

  // leader arrow heads and points
  for (const it of marks) {
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

  prof?.('marks');

  // 3. text; LOD bars (text under 2 px) as one stroke per colour
  if (bars.size) {
    ctx.save(); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    for (const [col, list] of bars) {
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
    if (it.mt) drawMText(ctx, it, sx(it.p.x), sy(it.p.y), z, colorOf(it.style), dark);
    else drawText(ctx, it, sx(it.p.x), sy(it.p.y), z, colorOf(it.style));
  }
  prof?.('text');

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
        if (it.kind === 'path' || it.kind === 'hatch' || it.kind === 'fill') { ctx.beginPath(); tracePath(it.ops); ctx.stroke(); }
        else if (it.kind === 'text' || it.kind === 'point') {
          const b = it.bbox;
          if (b) ctx.strokeRect(sx(b.minx) - 2, sy(b.maxy) - 2, (b.maxx - b.minx) * z + 4, (b.maxy - b.miny) * z + 4);
        }
      }
    }
    ctx.restore();
  }
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
    if (px < 2) { ctx.globalAlpha = 0.5; ctx.fillRect(g.x * z, g.y * z - 1, (g.w ?? g.text.length * g.h * 0.6) * z, 1); ctx.globalAlpha = 1; continue; }
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
export function zoomAt(view, sx, sy, factor) {
  const before = screenToWorld(view, sx, sy);
  const zoom = Math.min(1e9, Math.max(1e-9, view.zoom * factor));
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

/** Draw a layout: grey surround, white sheet with shadow, dashed printable area, viewports showing model space
 *  (scene per frozen-layer set from `modelScene(frozen)`), then the paper-space scene and its highlight. */
export function drawLayout(ctx, paperScene, view, layout, paperRectsOf, modelScene, opts = {}) {
  const { width: W, height: H, zoom: z } = view, dpr = opts.dpr ?? 1;
  const sx = (x) => (x - view.cx) * z + W / 2, sy = (y) => H / 2 - (y - view.cy) * z;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = opts.surround ?? '#8a9099'; ctx.fillRect(0, 0, W, H);
  const { sheet, printable } = paperRectsOf(layout);
  const r = (b) => [sx(b.minx), sy(b.maxy), (b.maxx - b.minx) * z, (b.maxy - b.miny) * z];
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; const sr = r(sheet); ctx.fillRect(sr[0] + 4, sr[1] + 4, sr[2], sr[3]);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(...sr);
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
      { ...opts, background: '#ffffff', noClear: true, baseTransform: ctx.getTransform(), highlight: v === opts.activeVp ? opts.modelHighlight : null });
    ctx.restore();
  }
  drawScene(ctx, paperScene, view, { ...opts, background: '#ffffff', noClear: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
  for (const v of vports) {
    const sel = opts.highlight instanceof Set && opts.highlight.has(v.id);
    ctx.strokeStyle = sel ? (opts.highlightColor ?? '#0a6fd1') : '#333'; ctx.lineWidth = v === opts.activeVp ? 3 : sel ? 2 : 1; ctx.strokeRect(sx(v.c.x - v.width / 2), sy(v.c.y + v.height / 2), v.width * z, v.height * z);
  }
}
