// ASH Draw Studio - drawing compare (command COMPARE): which objects were added, removed or changed between two drawings.
// Pure ES module (no DOM). Entities are matched geometrically, never by list order:
//  1. "same": same type, same strings (text, block name ...), same properties and every coordinate/number within `tol`
//     (found through a spatial hash of each entity's anchor point).
//  2. "changed": among the rest, pairs with the same handle (when both files carry shared handles), else the best
//     geometric partner of the same type: one sharing defining points (edited in place: colour, layer, text, one end
//     moved ...) or an identical shape translated by at most `moveRadius` (moved).
//  3. what is left over is "removed" (A only) or "added" (B only).
// Matching works on drawn pieces: INSERTs (not xrefs, nested ones too) and DIMENSIONs are expanded to their world
// geometry (expandEntities), so a block in A that was exploded or renamed in B still matches. A can first be moved by
// an offset (opts.dx/dy, or opts.align 'auto' = estimateOffset) so a plan redrawn elsewhere still lines up.
import { newDocument, addLayer, addEntity } from './model.js';
import { bboxOf, unionBox, explode, transformEntity, translation } from './geom.js';

const MAX_DEPTH = 16; // nested blocks expanded at most this deep (guards self-referencing blocks)

/**
 * The drawn pieces of `ents` (default: model space): INSERTs of non-xref blocks (nested too, arrays included) and
 * DIMENSIONs are replaced by their transformed block geometry, with layer "0" / BYBLOCK properties resolved from the
 * enclosing INSERT. Returns [{ e: piece, top: the model-space entity it comes from }] (top === e when not expanded).
 */
export function expandEntities(doc, ents = doc.entities) {
  const out = [];
  const rec = (e, top, inh, depth) => {
    if (inh) { // a fresh copy made by explode(): resolve what it inherits from the INSERT it was drawn by
      if (e.layer === '0' || e.layer == null) e.layer = inh.layer;
      if (e.color === 0) e.color = inh.color;
      if (String(e.linetype).toUpperCase() === 'BYBLOCK') e.linetype = inh.linetype;
      if (e.lineweight === -2) e.lineweight = inh.lineweight;
      delete e.parent; delete e.handle;
    }
    const blk = (e.type === 'INSERT' || e.type === 'DIMENSION') && depth < MAX_DEPTH ? doc.blocks.get(e.block) : null;
    if (blk && !blk.xref) {
      const kids = explode(e, doc);
      if (kids.length || e.type === 'INSERT') { for (const k of kids) rec(k, top, e, depth + 1); return; }
    }
    out.push({ e, top });
  };
  for (const e of ents) rec(e, e, null, 0);
  return out;
}

// ---- alignment ----------------------------------------------------------------------------------
/** translation-invariant signature (k) and position of a piece, or null; w = vote weight (long lines count more) */
function offsetFeature(e, q, longLine) {
  const r = (v) => Math.round(v / q);
  switch (e.type) {
    case 'LINE': {
      const len = Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
      if (len < q) return null;
      let ang = Math.atan2(e.p2.y - e.p1.y, e.p2.x - e.p1.x); if (ang < 0) ang += Math.PI; if (ang >= Math.PI - 1e-9) ang = 0;
      return { k: `L|${r(len)}|${Math.round(ang * 1e3)}`, x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2, w: Math.min(4, 1 + len / longLine) };
    }
    case 'CIRCLE': return { k: `C|${r(e.r)}`, x: e.c.x, y: e.c.y, w: 1 };
    case 'ARC': return { k: `A|${r(e.r)}|${Math.round(e.a0)}|${Math.round(e.a1)}`, x: e.c.x, y: e.c.y, w: 1 };
    case 'INSERT': return e.p ? { k: `I|${e.block}|${Math.round(e.rot || 0)}|${e.sx ?? 1}|${e.sy ?? 1}`, x: e.p.x, y: e.p.y, w: 1 } : null;
    case 'TEXT': case 'MTEXT': return e.p ? { k: `T|${e.text}|${r(e.height || 0)}`, x: e.p.x, y: e.p.y, w: 1 } : null;
    case 'LWPOLYLINE': {
      const v = e.vertices; if (!v?.length) return null;
      let per = 0, sx = 0, sy = 0;
      for (let i = 0; i < v.length; i++) { sx += v[i].x; sy += v[i].y; if (i) per += Math.hypot(v[i].x - v[i - 1].x, v[i].y - v[i - 1].y); }
      return { k: `P|${v.length}|${e.closed ? 1 : 0}|${r(per)}`, x: sx / v.length, y: sy / v.length, w: 1 };
    }
    default: return null;
  }
}

const MAX_KEY_PAIRS = 1024;   // a signature shared by more A x B pairs than this is too common to vote
const MAX_VOTES = 4e6;

/** translation (dx, dy) that best moves pieces pa onto pb: pairs of pieces with the same signature vote for their
 *  offset; the densest vote cell is searched coarse to fine (each level 8x finer) down to the tolerance */
function offsetOf(pa, pb, tol) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const fa = [], fb = [];
  const ext = (f) => { if (f.x < minx) minx = f.x; if (f.x > maxx) maxx = f.x; if (f.y < miny) miny = f.y; if (f.y > maxy) maxy = f.y; };
  // first pass: extents of the anchor points, to size the signature quantum and the coarse cells
  for (const p of [...pa, ...pb]) { const e = p.e; const pt = e.p1 ?? e.c ?? e.p ?? e.vertices?.[0]; if (pt) ext(pt); }
  const diag = Math.hypot(maxx - minx, maxy - miny) || 1;
  const q = Math.max(tol, diag * 2e-5);
  for (const [ps, fs] of [[pa, fa], [pb, fb]]) for (const p of ps) { const f = offsetFeature(p.e, q, diag * 0.02); if (f && Number.isFinite(f.x) && Number.isFinite(f.y)) fs.push(f); }
  const byKey = new Map();
  fa.forEach((f, i) => { let g = byKey.get(f.k); if (!g) byKey.set(f.k, g = { a: [], b: [] }); g.a.push(i); });
  fb.forEach((f, j) => { const g = byKey.get(f.k); if (g) g.b.push(j); });
  const groups = [...byKey.values()].filter((g) => g.b.length && g.a.length * g.b.length <= MAX_KEY_PAIRS)
    .sort((g, h) => g.a.length * g.b.length - h.a.length * h.b.length); // rarest signatures first
  const vx = [], vy = [], vw = [], vi = [];
  for (const g of groups) {
    if (vx.length + g.a.length * g.b.length > MAX_VOTES) break;
    for (const i of g.a) for (const j of g.b) { vx.push(fb[j].x - fa[i].x); vy.push(fb[j].y - fa[i].y); vw.push(Math.min(fa[i].w, fb[j].w)); vi.push(i); }
  }
  const none = { dx: 0, dy: 0, votes: 0, confidence: 0 };
  if (!vx.length) return none;
  // coarse to fine: in the current window, the cell whose 3x3 neighbourhood holds the most weight; window = that 3x3
  let idx = vx.map((_, k) => k), cell = diag / 64, cx = 0, cy = 0;
  for (;;) {
    const h = new Map();
    for (const k of idx) { const key = `${Math.floor(vx[k] / cell)},${Math.floor(vy[k] / cell)}`; h.set(key, (h.get(key) ?? 0) + vw[k]); }
    let best = -1, bx = 0, by = 0;
    for (const key of h.keys()) {
      const [i, j] = key.split(',').map(Number);
      let s = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += h.get(`${i + a},${j + b}`) ?? 0;
      if (s > best || (s === best && (i < bx || (i === bx && j < by)))) { best = s; bx = i; by = j; }
    }
    cx = (bx + 0.5) * cell; cy = (by + 0.5) * cell;
    idx = idx.filter((k) => Math.abs(vx[k] - cx) <= cell * 1.5 && Math.abs(vy[k] - cy) <= cell * 1.5);
    if (cell <= tol) break;
    cell = Math.max(cell / 8, tol);
  }
  // final: weighted mean of the votes within tol of the peak cell, counted once per A piece
  let sw = 0, sx = 0, sy = 0; const agree = new Set();
  for (const k of idx) if (Math.abs(vx[k] - cx) <= tol && Math.abs(vy[k] - cy) <= tol) { sw += vw[k]; sx += vx[k] * vw[k]; sy += vy[k] * vw[k]; agree.add(vi[k]); }
  if (!sw) return none;
  return { dx: sx / sw, dy: sy / sw, votes: agree.size, confidence: Math.min(1, agree.size / Math.max(1, Math.min(fa.length, fb.length))) };
}

/**
 * Estimate the translation that moves drawing `a` onto drawing `b` (only translation: no rotation or scale), from the
 * pieces' feature points (line midpoints, arc / circle centres, insertion points, polyline centroids) voting coarse to
 * fine. opts.tol: final resolution in drawing units (default 1). Returns { dx, dy, votes, confidence 0..1 }.
 */
export function estimateOffset(a, b, opts = {}) {
  return offsetOf(expandEntities(a), expandEntities(b), Math.max(opts.tol ?? 1, 1e-9));
}

/** 1 mm in the drawing's units ($INSUNITS; unitless taken as mm): the default compare tolerance */
export function defaultTolerance(units) {
  return { 1: 1 / 25.4, 2: 1 / 304.8, 4: 1, 5: 0.1, 6: 0.001 }[units] ?? 1;
}

// keys that are properties (compared for "changed") or bookkeeping, not geometry
const PROP_KEYS = new Set(['layer', 'color', 'linetype', 'lineweight', 'ltscale']);
const SKIP_KEYS = new Set(['id', 'type', 'handle', 'parent', ...PROP_KEYS]);

/** feature of one entity: strings (identity), points (x,y pairs), scalars; anchor = first point */
function feature(e, doc) {
  const pts = [], sc = [], str = [];
  const walk = (v, k) => {
    if (v == null) return;
    if (typeof v === 'number') { sc.push(v); return; }
    if (typeof v === 'string' || typeof v === 'boolean') { str.push(`${k}=${v}`); return; }
    if (Array.isArray(v)) { str.push(`${k}#${v.length}`); for (const x of v) walk(x, k); return; }
    if (typeof v === 'object') {
      if (typeof v.x === 'number' && typeof v.y === 'number') pts.push(v.x, v.y);
      for (const kk of Object.keys(v).sort()) if (!(kk === 'x' || kk === 'y') || typeof v[kk] !== 'number') walk(v[kk], kk);
    }
  };
  for (const k of Object.keys(e).sort()) {
    if (SKIP_KEYS.has(k)) continue;
    if (e.type === 'DIMENSION' && k === 'block') continue; // anonymous block names (*D12) differ between files
    walk(e[k], k);
  }
  if (e.type === 'DIMENSION') { // what the dimension draws stands in for its definition points
    const b = bboxOf(e, doc);
    if (b) pts.push(b.minx, b.miny, b.maxx, b.maxy);
  }
  if (e.type === 'LINE' && (pts[0] > pts[2] || (pts[0] === pts[2] && pts[1] > pts[3]))) pts.push(...pts.splice(0, 2)); // direction-free
  const props = `${e.layer}|${typeof e.color === 'object' ? JSON.stringify(e.color) : e.color}|${e.linetype}|${e.lineweight}|${e.ltscale ?? 1}`;
  const s = `${e.type}\u0001${str.join('\u0002')}`;
  return { e, s, props, pts, sc, ax: pts.length ? pts[0] : 0, ay: pts.length ? pts[1] : 0 };
}

function within(a, b, tol, dx = 0, dy = 0) {
  if (a.pts.length !== b.pts.length || a.sc.length !== b.sc.length) return false;
  for (let i = 0; i < a.pts.length; i += 2) {
    if (Math.abs(a.pts[i] + dx - b.pts[i]) > tol || Math.abs(a.pts[i + 1] + dy - b.pts[i + 1]) > tol) return false;
  }
  for (let i = 0; i < a.sc.length; i++) if (Math.abs(a.sc[i] - b.sc[i]) > tol) return false;
  return true;
}
/** number of A's points that coincide (within tol) with some point of B */
function sharedPoints(a, b, tol) {
  let n = 0;
  for (let i = 0; i < a.pts.length; i += 2) {
    for (let j = 0; j < b.pts.length; j += 2) {
      if (Math.abs(a.pts[i] - b.pts[j]) <= tol && Math.abs(a.pts[i + 1] - b.pts[j + 1]) <= tol) { n++; break; }
    }
  }
  return n;
}

class Grid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  key(k, x, y) { return `${k}|${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }
  add(k, x, y, v) { const key = this.key(k, x, y); const l = this.m.get(key); if (l) l.push(v); else this.m.set(key, [v]); }
  *near(k, x, y) {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const l = this.m.get(`${k}|${cx + i},${cy + j}`); if (l) yield* l; }
  }
}

const MAX_PTS = 16; // points of one entity indexed for the in-place search (long polylines: the first ones)
const MAX_CAND = 256; // partners examined per object in the changed search (dense repeated patterns)

/**
 * Compare drawing `a` (original) with `b` (revised), model space.
 * opts: tol (geometry tolerance, drawing units, default 1e-6), moveRadius (largest move still reported as "changed",
 * default 5 % of the drawings' anchor extents), clusterGap (changes closer than this form one cluster, default 2 %),
 * expand (compare drawn pieces, blocks expanded: default true), dx/dy (move A by this first) or align: 'auto'
 * (estimateOffset).
 * Returns { added: [B pieces], removed: [A pieces], changed: [{a, b}], same: [{a, b}], clusters: [{box, added, removed,
 * changed}], offset: {dx, dy, votes?, confidence?}, topOf: Map(piece -> model-space entity) } — A's pieces already moved.
 */
export function compareDocs(a, b, opts = {}) {
  const tol = Math.max(opts.tol ?? 1e-6, 1e-12);
  const expand = opts.expand ?? true;
  const pa = expand ? expandEntities(a) : a.entities.map((e) => ({ e, top: e }));
  const pb = expand ? expandEntities(b) : b.entities.map((e) => ({ e, top: e }));
  const offset = opts.align === 'auto' ? offsetOf(pa, pb, tol) : { dx: opts.dx ?? 0, dy: opts.dy ?? 0 };
  if (offset.dx || offset.dy) { const m = translation(offset.dx, offset.dy); for (const p of pa) p.e = transformEntity(p.e, m); }
  const topOf = new Map();
  for (const p of pa) topOf.set(p.e, p.top);
  for (const p of pb) topOf.set(p.e, p.top);
  const fa = pa.map((p) => feature(p.e, a)), fb = pb.map((p) => feature(p.e, b));
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const f of [...fa, ...fb]) { if (f.ax < minx) minx = f.ax; if (f.ax > maxx) maxx = f.ax; if (f.ay < miny) miny = f.ay; if (f.ay > maxy) maxy = f.ay; }
  const diag = fa.length + fb.length ? Math.hypot(maxx - minx, maxy - miny) : 0;
  const moveRadius = Math.max(opts.moveRadius ?? diag * 0.05, tol);
  const usedA = new Uint8Array(fa.length), usedB = new Uint8Array(fb.length);
  const same = [], changed = [];

  // 1. identical objects
  const g = new Grid(tol * 2);
  fb.forEach((f, j) => g.add(f.s + f.props, f.ax, f.ay, j));
  fa.forEach((f, i) => {
    for (const j of g.near(f.s + f.props, f.ax, f.ay)) {
      if (usedB[j] || !within(f, fb[j], tol)) continue;
      usedA[i] = usedB[j] = 1; same.push({ a: f.e, b: fb[j].e }); return;
    }
  });

  // 2a. same handle in both files (only when the files share handles, e.g. two saves of one drawing)
  const restA = () => fa.map((f, i) => i).filter((i) => !usedA[i]);
  const restB = () => fb.map((f, j) => j).filter((j) => !usedB[j]);
  const hb = new Map();
  for (const j of restB()) if (fb[j].e.handle) hb.set(`${fb[j].e.type}|${fb[j].e.handle}`, j);
  const shared = a.entities.filter((e) => e.handle).length > 0 && b.entities.filter((e) => e.handle).length > 0;
  if (shared) {
    for (const i of restA()) {
      const j = hb.get(`${fa[i].e.type}|${fa[i].e.handle}`);
      if (j !== undefined && !usedB[j]) { usedA[i] = usedB[j] = 1; changed.push({ a: fa[i].e, b: fb[j].e }); }
    }
  }

  // 2b. geometric partners: collect candidate pairs, then assign best-first (independent of list order)
  const ra = restA(), rb = restB();
  const gp = new Grid(tol * 2), gm = new Grid(moveRadius);
  // shape key: identical shapes (relative points, numbers) share it, so a moved copy is only sought among its twins
  const q = tol * 4;
  const shapeKey = (f) => {
    let k = f.s;
    for (let i = 2; i < Math.min(f.pts.length, MAX_PTS * 2); i += 2) k += `|${Math.round((f.pts[i] - f.ax) / q)},${Math.round((f.pts[i + 1] - f.ay) / q)}`;
    for (let i = 0; i < Math.min(f.sc.length, MAX_PTS); i++) k += `|${Math.round(f.sc[i] / q)}`;
    return k;
  };
  for (const j of rb) {
    const f = fb[j], t = f.e.type;
    for (let k = 0; k < Math.min(f.pts.length, MAX_PTS * 2); k += 2) gp.add(t, f.pts[k], f.pts[k + 1], j);
    gm.add(shapeKey(f), f.ax, f.ay, j);
  }
  const cand = [];
  for (const i of ra) {
    const f = fa[i], seen = new Set(), paired = new Set();
    scan: for (let k = 0; k < Math.min(f.pts.length, MAX_PTS * 2); k += 2) {
      for (const j of gp.near(f.e.type, f.pts[k], f.pts[k + 1])) {
        if (seen.has(j)) continue; seen.add(j);
        if (seen.size > MAX_CAND) break scan; // a dense pile of touching objects: enough candidates
        const n = sharedPoints(f, fb[j], tol);
        if (n) { paired.add(j); cand.push({ i, j, rank: 0, score: -n, d: Math.hypot(f.ax - fb[j].ax, f.ay - fb[j].ay) }); }
      }
    }
    const moved = [];
    let looked = 0;
    for (const j of gm.near(shapeKey(f), f.ax, f.ay)) {
      if (paired.has(j)) continue;
      if (++looked > MAX_CAND) break;
      const dx = fb[j].ax - f.ax, dy = fb[j].ay - f.ay, d = Math.hypot(dx, dy);
      if (d <= moveRadius && within(f, fb[j], tol, dx, dy)) moved.push({ i, j, rank: 1, score: 0, d });
    }
    moved.sort((p, q2) => p.d - q2.d);
    cand.push(...moved.slice(0, 4)); // the nearest twins only
  }
  cand.sort((p, q) => p.rank - q.rank || p.score - q.score || p.d - q.d);
  for (const c of cand) {
    if (usedA[c.i] || usedB[c.j]) continue;
    usedA[c.i] = usedB[c.j] = 1; changed.push({ a: fa[c.i].e, b: fb[c.j].e });
  }

  const removed = fa.filter((f, i) => !usedA[i]).map((f) => f.e);
  const added = fb.filter((f, j) => !usedB[j]).map((f) => f.e);
  const clusters = clusterChanges(a, b, { added, removed, changed }, opts.clusterGap ?? diag * 0.02);
  return { added, removed, changed, same, clusters, offset, topOf };
}

/** group nearby changes; each cluster = { box, added, removed, changed } (counts), in reading order (top-left first) */
function clusterChanges(a, b, r, gap) {
  const items = [
    ...r.added.map((e) => ({ k: 'added', box: bboxOf(e, b) })),
    ...r.removed.map((e) => ({ k: 'removed', box: bboxOf(e, a) })),
    ...r.changed.map((p) => ({ k: 'changed', box: unionBox(bboxOf(p.a, a), bboxOf(p.b, b)) })),
  ].filter((it) => it.box);
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  // grid of cells `gap` wide: items whose boxes (grown by gap/2) reach a common cell join one cluster (linear time)
  const cell = Math.max(gap, 1e-9), owner = new Map();
  items.forEach((it, i) => {
    const B = it.box, h = gap / 2;
    let x0 = Math.floor((B.minx - h) / cell), x1 = Math.floor((B.maxx + h) / cell), y0 = Math.floor((B.miny - h) / cell), y1 = Math.floor((B.maxy + h) / cell);
    while ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { x0 >>= 1; x1 >>= 1; y0 >>= 1; y1 >>= 1; } // huge box: ignore its interior detail
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`, o = owner.get(k);
      if (o === undefined) owner.set(k, i); else parent[find(i)] = find(o);
    }
  });
  const byRoot = new Map();
  items.forEach((it, i) => {
    const r0 = find(i);
    const c = byRoot.get(r0) ?? { box: null, added: 0, removed: 0, changed: 0 };
    c.box = unionBox(c.box, it.box); c[it.k]++; byRoot.set(r0, c);
  });
  return [...byRoot.values()].sort((p, q) => q.box.maxy - p.box.maxy || p.box.minx - q.box.minx);
}

// ---- the compare drawing ------------------------------------------------------------------------
export const COMPARE_LAYERS = {
  same: { name: 'COMPARE-SAME', color: 8 },             // unchanged: dimmed grey (B's copy)
  added: { name: 'COMPARE-ADDED', color: 3 },           // in B only: green
  removed: { name: 'COMPARE-REMOVED', color: 1 },       // in A only: red
  changed: { name: 'COMPARE-CHANGED', color: 40 },      // changed, B's version: amber
  changedA: { name: 'COMPARE-CHANGED-A', color: 40 },   // changed, A's version: amber
  marks: { name: 'COMPARE-MARKS', color: 6 },           // dotted rectangles around change clusters (no revision clouds)
};

/** the compare tab's views: colour of each compare layer, null = layer hidden */
export const COMPARE_VIEWS = {
  differences: { same: 8, added: 3, removed: 1, changed: 40, changedA: 40, marks: 6 },
  overlay: { same: 7, added: 3, removed: 1, changed: 3, changedA: 1, marks: 6 },   // A red, B green, both: white
  a: { same: 7, added: null, removed: 1, changed: null, changedA: 1, marks: 6 },    // drawing A only (its own parts red)
  b: { same: 7, added: 3, removed: null, changed: 3, changedA: null, marks: 6 },    // drawing B only (its own parts green)
};

/** switch a compare drawing to one of COMPARE_VIEWS (layer colours and visibility; the scene must be rebuilt) */
export function setCompareView(doc, view) {
  const v = COMPARE_VIEWS[view];
  if (!v) throw new Error(`unknown compare view ${view}`);
  for (const [k, L] of Object.entries(COMPARE_LAYERS)) {
    const layer = doc.layers.get(L.name); if (!layer) continue;
    layer.visible = v[k] != null;
    if (v[k] != null) layer.color = v[k];
  }
}

/** names of the blocks the given entities use, nested ones included */
function blocksUsed(src, ents) {
  const used = new Set(), todo = [...ents];
  while (todo.length) {
    const e = todo.pop();
    if (!e.block || used.has(e.block)) continue;
    const blk = src.blocks.get(e.block); if (!blk) continue;
    used.add(e.block); todo.push(...blk.entities);
  }
  return used;
}

/** a drawing showing both overlaid in the compare colours (A moved by r.offset), with dotted rectangles around the
 *  change clusters. A model-space entity whose pieces all share one status is drawn whole (an INSERT stays an INSERT);
 *  otherwise its pieces are drawn one by one. */
export function buildCompareDoc(a, b, r) {
  const doc = newDocument();
  doc.units = b.units || a.units;
  for (const L of Object.values(COMPARE_LAYERS)) addLayer(doc, { name: L.name, color: L.color });
  for (const src of [a, b]) {
    for (const [k, v] of src.linetypes) if (!doc.linetypes.has(k)) doc.linetypes.set(k, v);
    for (const [k, v] of src.textStyles) if (!doc.textStyles.has(k)) doc.textStyles.set(k, v);
  }
  const topOf = r.topOf ?? new Map();
  const off = r.offset ?? { dx: 0, dy: 0 };
  // the status of every piece of each expanded model-space entity: one status -> draw the entity whole
  const statusA = new Map(), statusB = new Map();
  const note = (m, piece, kind) => { const t = topOf.get(piece); if (!t || t === piece) return; const s = m.get(t); m.set(t, s === undefined || s === kind ? kind : null); };
  for (const p of r.same) { note(statusA, p.a, 'same'); note(statusB, p.b, 'same'); }
  for (const p of r.changed) { note(statusA, p.a, 'changed'); note(statusB, p.b, 'changed'); }
  for (const e of r.removed) note(statusA, e, 'removed');
  for (const e of r.added) note(statusB, e, 'added');
  const whole = (m, kind) => [...m].filter(([, s]) => s === kind).map(([t]) => t);
  const sameB = new Set(whole(statusB, 'same')), addedB = new Set(whole(statusB, 'added')), removedA = new Set(whole(statusA, 'removed'));
  const moveA = off.dx || off.dy ? translation(off.dx, off.dy) : null;
  const topsA = [...removedA].map((t) => (moveA ? transformEntity(t, moveA) : t));
  // blocks drawn whole: B's under their names, A's too unless B has one of that name (then A's is "<name>|A")
  const usedB = blocksUsed(b, [...sameB, ...addedB]), usedA = blocksUsed(a, topsA);
  const rename = new Map();
  for (const k of usedA) if (b.blocks.has(k)) rename.set(k, `${k}|A`);
  const copyBlocks = (src, used, ren) => {
    for (const k of used) {
      const blk = src.blocks.get(k);
      const ents = structuredClone(blk.entities).map((e) => {
        e.color = 0; e.layer = '0'; // children follow the insert's compare colour and layer
        if (e.block && ren.has(e.block)) e.block = ren.get(e.block);
        return e;
      });
      doc.blocks.set(ren.get(k) ?? k, { ...structuredClone({ ...blk, entities: [] }), name: ren.get(k) ?? k, entities: ents });
    }
  };
  copyBlocks(b, usedB, new Map());
  copyBlocks(a, usedA, rename);
  const put = (e, kind, ren) => {
    const c = structuredClone(e);
    c.id = 0; c.layer = COMPARE_LAYERS[kind].name; c.color = 256;
    if (c.block && ren?.has(c.block)) c.block = ren.get(c.block);
    return addEntity(doc, c);
  };
  const piecewise = (piece, set) => !set.has(topOf.get(piece));
  for (const t of sameB) put(t, 'same');
  for (const p of r.same) if (piecewise(p.b, sameB)) put(p.b, 'same');
  for (const p of r.changed) { put(p.a, 'changedA'); put(p.b, 'changed'); }
  for (const t of topsA) put(t, 'removed', rename);
  for (const e of r.removed) if (piecewise(e, removedA)) put(e, 'removed');
  for (const t of addedB) put(t, 'added');
  for (const e of r.added) if (piecewise(e, addedB)) put(e, 'added');
  doc.linetypes.set('COMPARE_DOT', { name: 'COMPARE_DOT', description: 'Compare marks . . .', pattern: [1, -1] });
  for (const c of r.clusters) {
    const w = c.box.maxx - c.box.minx, h = c.box.maxy - c.box.miny, pad = Math.max(w, h, 1e-3) * 0.15 + 1e-3;
    const x0 = c.box.minx - pad, y0 = c.box.miny - pad, x1 = c.box.maxx + pad, y1 = c.box.maxy + pad;
    c.mark = { minx: x0, miny: y0, maxx: x1, maxy: y1 };
    addEntity(doc, {
      id: 0, type: 'LWPOLYLINE', layer: COMPARE_LAYERS.marks.name, color: 256, linetype: 'COMPARE_DOT', lineweight: -1,
      ltscale: Math.max(x1 - x0, y1 - y0) / 60, closed: true,
      vertices: [{ x: x0, y: y0, bulge: 0 }, { x: x1, y: y0, bulge: 0 }, { x: x1, y: y1, bulge: 0 }, { x: x0, y: y1, bulge: 0 }],
    });
  }
  return doc;
}
