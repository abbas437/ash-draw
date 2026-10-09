// Picking, box selection, object snaps and ortho/polar helpers.
// Pure module: world coordinates (Y up); every tolerance is in WORLD units (caller: pixels / zoom).
import { bboxOf, growBox, unionBox, distanceToEntity, nearestPoint, snapPoints, intersections, explode, tessellate, ccwSweep, DEG } from './geom.js';
import { drain } from './slice.js';

const TAU = Math.PI * 2;
const MAX_CELLS_AXIS = 1024;
const OVERSIZE_CELLS = 256; // an entity spanning more grid cells than this goes to the oversize list
const INT_CANDIDATES = 40;
const INSERT_SNAP_LIMIT = 500; // explode INSERTs for snapping only when the block is at most this big

export const SNAP_KINDS = ['end', 'int', 'mid', 'cen', 'quad', 'node', 'ins', 'per', 'near']; // priority order
const RANK = new Map(SNAP_KINDS.map((k, i) => [k, i]));

/** block entities _insertBoxSteps bounds per step */
const BOX_CHUNK = 2000;
const finiteBox = (b) => !!b && Number.isFinite(b.minx) && Number.isFinite(b.miny) && Number.isFinite(b.maxx) && Number.isFinite(b.maxy);
const boxesTouch = (a, b) => a.minx <= b.maxx && a.maxx >= b.minx && a.miny <= b.maxy && a.maxy >= b.miny;
const boxInside = (a, b) => a.minx >= b.minx && a.maxx <= b.maxx && a.miny >= b.miny && a.maxy <= b.maxy;
const normBox = (b) => ({ minx: Math.min(b.minx, b.maxx), miny: Math.min(b.miny, b.maxy), maxx: Math.max(b.minx, b.maxx), maxy: Math.max(b.miny, b.maxy) });
// Indexed extent: the bbox grown to include the insertion point of TEXT/MTEXT/INSERT, so the 'ins' snap is
// reachable even when a block's base point lies outside its geometry.
function reachOf(e, box) {
  const p = (e.type === 'INSERT' || e.type === 'TEXT' || e.type === 'MTEXT') && e.p;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return box;
  return { minx: Math.min(box.minx, p.x), miny: Math.min(box.miny, p.y), maxx: Math.max(box.maxx, p.x), maxy: Math.max(box.maxy, p.y) };
}
const around = (p, tol) => ({ minx: p.x - tol, miny: p.y - tol, maxx: p.x + tol, maxy: p.y + tol });

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
function defaultVisible(doc) {
  return (e) => {
    const l = doc.layers.get(e.layer);
    return (!l || (l.visible !== false && !l.frozen)) && !e.invisible;
  };
}
function isLocked(doc, e) {
  const l = doc.layers.get(e.layer);
  return !!(l && l.locked);
}

/** Uniform-grid spatial index over the visible entities of `doc`.
 *  Visibility is evaluated when an entity is (re)indexed: after a layer visibility change call rebuild(). */
export class SpatialIndex {
  /** deferred: leave the index empty; the caller runs rebuildSteps() (time-sliced, src/core/slice.js runSliced) */
  constructor(doc, { isVisible, deferred = false } = {}) {
    this.doc = doc;
    this.isVisible = isVisible || defaultVisible(doc);
    this._boxCache = new WeakMap(); // entity object -> bbox|null
    if (!deferred) this.rebuild();
  }

  /** Cached bbox of an entity object (null when empty / not finite). Replaced objects get a fresh entry. */
  bboxOf(e) {
    if (this._boxCache.has(e)) return this._boxCache.get(e);
    const b = safe(() => bboxOf(e, this.doc), null);
    const r = finiteBox(b) ? b : null;
    this._boxCache.set(e, r);
    return r;
  }

  rebuild() { drain(this.rebuildSteps()); }

  /** leaf entities an INSERT of block `name` expands to (nested INSERTs and arrays counted through), memoised */
  _leafCount(name, seen = new Set()) {
    const memo = (this._leaves ??= new Map());
    if (memo.has(name)) return memo.get(name);
    const ents = this.doc.blocks.get(name)?.entities;
    if (!ents || seen.has(name)) return 0;
    seen.add(name);
    let n = 0;
    for (const s of ents) n += s.type === 'INSERT' ? Math.max(1, s.cols || 1) * Math.max(1, s.rows || 1) * this._leafCount(s.block, seen) : 1;
    seen.delete(name);
    memo.set(name, n);
    return n;
  }

  /** bboxOf(e) of an INSERT of a big block (counting nested blocks through), computed about BOX_CHUNK leaf entities
   *  per step (yielding `frac` in between) and cached: the same pieces bboxOf would tessellate in one go */
  *_insertBoxSteps(e, frac) {
    if (this._leafCount(e.block) <= BOX_CHUNK) return;
    const st = { work: 0 };
    const b = yield* this._boxSteps(e, frac, st, new Set());
    this._boxCache.set(e, finiteBox(b) ? b : null);
  }

  /** box of the leaves of INSERT e (already placed in world space by explode): its block BOX_CHUNK entities at a
   *  time, a nested INSERT of a big block walked the same way; st.work counts leaves since the last yield */
  *_boxSteps(e, frac, st, seen) {
    const blk = this.doc.blocks.get(e.block), ents = blk?.entities;
    if (!ents || seen.has(e.block)) return null;
    seen.add(e.block);
    let b = null;
    for (let i = 0; i < ents.length; i += BOX_CHUNK) {
      const part = ents.length <= BOX_CHUNK ? blk : { ...blk, entities: ents.slice(i, i + BOX_CHUNK) };
      const doc = part === blk ? this.doc : { ...this.doc, blocks: { get: (name) => (name === e.block ? part : this.doc.blocks.get(name)) } };
      const subs = safe(() => explode(e, doc), []);
      for (const sub of subs) {
        let q = null;
        if (sub.type === 'INSERT' && this._leafCount(sub.block) > BOX_CHUNK / 4) q = yield* this._boxSteps(sub, frac, st, seen);
        else {
          q = safe(() => { let r = null; for (const pl of tessellate(sub, this.doc, 0)) for (const p of pl) r = growBox(r, p); return r; }, null);
          st.work += sub.type === 'INSERT' ? this._leafCount(sub.block) : 1;
        }
        if (q) b = b ? unionBox(b, q) : q;
        if (st.work >= BOX_CHUNK) { st.work = 0; yield frac; }
      }
    }
    seen.delete(e.block);
    return b;
  }

  /** rebuild as a step generator: yields the fraction done after each entity (bounds: 0..0.9, grid: 0.9..1) */
  *rebuildSteps() {
    this._entries = new Map(); // id -> {e, box, reach, order, cells:[c0,r0,c1,r1]|null, mark}
    this._oversize = [];
    this._stamp = 0;
    const entries = [], ents = this.doc.entities, n = ents.length;
    let ext = null;
    for (let i = 0; i < n; i++) {
      if (!(i in ents)) continue; // a hole (forEach skipped them too)
      const e = ents[i];
      yield (0.9 * i) / n;
      if (!safe(() => this.isVisible(e), false)) continue;
      if (e.type === 'INSERT' && !this._boxCache.has(e)) yield* this._insertBoxSteps(e, (0.9 * i) / n);
      const box = this.bboxOf(e);
      if (!box) continue;
      const reach = reachOf(e, box);
      entries.push({ e, box, reach, order: i, cells: null, mark: 0 });
      ext = ext ? { minx: Math.min(ext.minx, reach.minx), miny: Math.min(ext.miny, reach.miny), maxx: Math.max(ext.maxx, reach.maxx), maxy: Math.max(ext.maxy, reach.maxy) } : { ...reach };
    }
    this._setupGrid(ext, entries.length);
    for (let i = 0; i < entries.length; i++) { this._insert(entries[i]); yield 0.9 + (0.1 * (i + 1)) / entries.length; }
  }

  _setupGrid(ext, n) {
    if (!ext) ext = { minx: 0, miny: 0, maxx: 1, maxy: 1 };
    const w = ext.maxx - ext.minx, h = ext.maxy - ext.miny;
    const big = Math.max(w, h, 1e-9);
    let cell = Math.sqrt(Math.max(w * h, 0) / Math.max(n, 1));
    cell = Math.max(cell, big / MAX_CELLS_AXIS, big * 1e-12);
    this._ox = ext.minx; this._oy = ext.miny; this._cell = cell;
    this._cols = Math.min(MAX_CELLS_AXIS, Math.floor(w / cell) + 1);
    this._rows = Math.min(MAX_CELLS_AXIS, Math.floor(h / cell) + 1);
    this._grid = new Array(this._cols * this._rows);
  }

  // cell range of a box, clamped to the grid (clamping keeps box/box overlap monotone, so results stay exact)
  _range(b) {
    const cl = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    return [
      cl(Math.floor((b.minx - this._ox) / this._cell), this._cols), cl(Math.floor((b.miny - this._oy) / this._cell), this._rows),
      cl(Math.floor((b.maxx - this._ox) / this._cell), this._cols), cl(Math.floor((b.maxy - this._oy) / this._cell), this._rows),
    ];
  }

  _insert(en) {
    this._entries.set(en.e.id, en);
    const r = this._range(en.reach);
    if ((r[2] - r[0] + 1) * (r[3] - r[1] + 1) > OVERSIZE_CELLS) { this._oversize.push(en); return; }
    en.cells = r;
    for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
      const k = y * this._cols + x;
      (this._grid[k] || (this._grid[k] = [])).push(en);
    }
  }

  _remove(id) {
    const en = this._entries.get(id);
    if (!en) return;
    this._entries.delete(id);
    if (!en.cells) { this._oversize.splice(this._oversize.indexOf(en), 1); return; }
    const r = en.cells;
    for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
      const list = this._grid[y * this._cols + x];
      const i = list ? list.indexOf(en) : -1;
      if (i >= 0) list.splice(i, 1);
    }
  }

  /** Re-index only these ids (entity removed, added, or its object replaced). */
  update(ids) {
    const want = new Set(ids);
    for (const id of want) this._remove(id);
    this.doc.entities.forEach((e, i) => {
      if (!want.has(e.id)) return;
      if (!safe(() => this.isVisible(e), false)) return;
      const box = this.bboxOf(e);
      if (box) this._insert({ e, box, reach: reachOf(e, box), order: i, cells: null, mark: 0 });
    });
  }

  // entries whose reach box intersects `box` (callers needing the true bbox test en.box themselves)
  _query(box) {
    const b = normBox(box);
    const out = [];
    const stamp = ++this._stamp;
    const take = (en) => { if (en.mark !== stamp) { en.mark = stamp; if (boxesTouch(en.reach, b)) out.push(en); } };
    if (this._entries.size) {
      const r = this._range(b);
      for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
        const list = this._grid[y * this._cols + x];
        if (list) for (const en of list) take(en);
      }
      for (const en of this._oversize) take(en);
    }
    return out;
  }

  /** Entities whose bbox intersects `box` ({minx,miny,maxx,maxy}). */
  query(box) {
    const b = normBox(box);
    return this._query(b).filter((en) => boxesTouch(en.box, b)).map((en) => en.e);
  }
}

/** Nearest entity whose outline is within `tol` of p; ties go to the later (topmost) entity. */
export function pickEntity(index, p, tol, opts = {}) {
  const doc = index.doc;
  let best = null, bd = Infinity;
  for (const en of index._query(around(p, tol))) {
    const e = en.e;
    if (opts.exclude && opts.exclude.has(e.id)) continue;
    if (opts.skipLocked && isLocked(doc, e)) continue;
    const d = safe(() => distanceToEntity(e, p, doc), Infinity);
    if (!(d <= tol)) continue;
    if (d < bd - 1e-12 || (Math.abs(d - bd) <= 1e-12 && en.order > best.order)) { bd = d; best = en; }
  }
  return best ? best.e : null;
}

function segmentHitsBox(a, b, box) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const checks = [[-dx, a.x - box.minx], [dx, box.maxx - a.x], [-dy, a.y - box.miny], [dy, box.maxy - a.y]];
  for (const [pp, q] of checks) {
    if (pp === 0) { if (q < 0) return false; continue; }
    const r = q / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
function geometryTouchesBox(e, box, doc) {
  if (e.type === 'TEXT' || e.type === 'MTEXT') return true; // text: its bbox is its geometry
  const pls = safe(() => tessellate(e, doc, 0), []);
  for (const pl of pls) {
    if (pl.length === 1 && pl[0].x >= box.minx && pl[0].x <= box.maxx && pl[0].y >= box.miny && pl[0].y <= box.maxy) return true;
    for (let i = 0; i + 1 < pl.length; i++) if (segmentHitsBox(pl[i], pl[i + 1], box)) return true;
  }
  return false;
}

/** Ids selected by a window (crossing=false: bbox fully inside) or crossing (geometry touches/inside) box. */
export function selectInBox(index, box, crossing, opts = {}) {
  const b = normBox(box);
  const doc = index.doc;
  const out = [];
  for (const en of index._query(b)) {
    const e = en.e;
    if (!boxesTouch(en.box, b) || (opts.skipLocked && isLocked(doc, e))) continue;
    if (boxInside(en.box, b)) { out.push(e.id); continue; }
    if (crossing && geometryTouchesBox(e, b, doc)) out.push(e.id);
  }
  return out;
}

function perpendicularFeet(e, from) {
  if (e.type === 'LINE') {
    const { p1: a, p2: b } = e;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (!(l2 > 0)) return [];
    const t = ((from.x - a.x) * dx + (from.y - a.y) * dy) / l2;
    return t >= 0 && t <= 1 ? [{ x: a.x + t * dx, y: a.y + t * dy }] : [];
  }
  if (e.type === 'CIRCLE' || e.type === 'ARC') {
    const ux = from.x - e.c.x, uy = from.y - e.c.y, l = Math.hypot(ux, uy);
    if (!(l > 0)) return [];
    const out = [];
    for (const s of [1, -1]) {
      const q = { x: e.c.x + (s * e.r * ux) / l, y: e.c.y + (s * e.r * uy) / l };
      if (e.type === 'ARC') {
        const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
        let d = (Math.atan2(q.y - e.c.y, q.x - e.c.x) - a0) % TAU;
        if (d < 0) d += TAU;
        if (d > sw + 1e-12) continue;
      }
      out.push(q);
    }
    return out;
  }
  return [];
}

function entitySnapPoints(index, e) {
  const doc = index.doc;
  const pts = safe(() => snapPoints(e, doc), []);
  if (e.type === 'INSERT') {
    const cache = index._insertSnaps || (index._insertSnaps = new WeakMap());
    let sub = cache.get(e);
    if (!sub) {
      const blk = doc.blocks && doc.blocks.get(e.block);
      const n = blk ? blk.entities.length * Math.max(1, e.cols || 1) * Math.max(1, e.rows || 1) : 0;
      sub = [];
      if (n > 0 && n <= INSERT_SNAP_LIMIT) {
        for (const c of safe(() => explode(e, doc), [])) {
          for (const q of safe(() => snapPoints(c, doc), [])) if (q.kind !== 'ins') sub.push(q);
        }
      }
      cache.set(e, sub);
    }
    return pts.concat(sub);
  }
  return pts;
}

/** Best object snap near p: {x,y,kind,id} or null. Priority end > int > mid > cen > quad > node > ins > per > near. */
export function findSnap(index, p, tol, opts = {}) {
  const doc = index.doc;
  const kinds = opts.kinds || null;
  const want = (k) => !kinds || kinds.has(k);
  let best = null;
  const offer = (q, kind, id) => {
    if (!want(kind) || !Number.isFinite(q.x) || !Number.isFinite(q.y)) return;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (!(d <= tol)) return;
    const r = RANK.get(kind);
    if (!best || r < best.r || (r === best.r && d < best.d)) best = { x: q.x, y: q.y, kind, id, r, d };
  };
  const near = []; // entities whose outline is within tol (for int / per / near)
  for (const en of index._query(around(p, tol))) {
    const e = en.e;
    if (opts.exclude && opts.exclude.has(e.id)) continue;
    for (const q of entitySnapPoints(index, e)) offer(q, q.kind, e.id);
    const d = safe(() => distanceToEntity(e, p, doc), Infinity);
    if (d <= tol) near.push({ e, d });
  }
  near.sort((a, b) => a.d - b.d);
  if (want('int')) {
    const c = near.slice(0, INT_CANDIDATES);
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      for (const q of safe(() => intersections(c[i].e, c[j].e, doc), [])) offer(q, 'int', c[i].e.id);
    }
  }
  if (want('per') && opts.from) for (const { e } of near) for (const q of perpendicularFeet(e, opts.from)) offer(q, 'per', e.id);
  if (want('near')) for (const { e } of near) { const q = safe(() => nearestPoint(e, p, doc), null); if (q) offer(q, 'near', e.id); }
  return best ? { x: best.x, y: best.y, kind: best.kind, id: best.id } : null;
}

/** p projected onto the horizontal or vertical axis through base, whichever is nearer. */
export function orthoPoint(base, p) {
  return Math.abs(p.x - base.x) >= Math.abs(p.y - base.y) ? { x: p.x, y: base.y } : { x: base.x, y: p.y };
}

/** Snap p's direction from base to the nearest multiple of stepDeg when within tolDeg (distance kept). angle in [0,360). */
export function polarPoint(base, p, stepDeg, tolDeg = 5) {
  const dx = p.x - base.x, dy = p.y - base.y, d = Math.hypot(dx, dy);
  let ang = Math.atan2(dy, dx) / DEG;
  if (ang < 0) ang += 360;
  if (!(d > 0) || !(stepDeg > 0)) return { x: p.x, y: p.y, angle: ang, snapped: false };
  const k = Math.round(ang / stepDeg) * stepDeg;
  if (Math.abs(ang - k) > tolDeg) return { x: p.x, y: p.y, angle: ang, snapped: false };
  const a = ((k % 360) + 360) % 360;
  return { x: base.x + d * Math.cos(a * DEG), y: base.y + d * Math.sin(a * DEG), angle: a, snapped: true };
}
