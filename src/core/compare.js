// ASH Draw Studio - drawing compare (command COMPARE): which objects were added, removed or changed between two drawings.
// Pure ES module (no DOM). Entities are matched geometrically, never by list order:
//  1. "same": same type, same strings (text, block name ...), same properties and every coordinate/number within `tol`
//     (found through a spatial hash of each entity's anchor point).
//  2. "changed": among the rest, pairs with the same handle (when both files carry shared handles), else the best
//     geometric partner of the same type: one sharing defining points (edited in place: colour, layer, text, one end
//     moved ...) or an identical shape translated by at most `moveRadius` (moved).
//  3. what is left over is "removed" (A only) or "added" (B only).
import { newDocument, addLayer, addEntity } from './model.js';
import { bboxOf, unionBox } from './geom.js';

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

/**
 * Compare drawing `a` (original) with `b` (revised), model space.
 * opts: tol (geometry tolerance, drawing units, default 1e-6), moveRadius (largest move still reported as "changed",
 * default 5 % of the drawings' anchor extents), clusterGap (changes closer than this form one cluster, default 2 %).
 * Returns { added: [B entities], removed: [A entities], changed: [{a, b}], same: [{a, b}], clusters: [{box, added, removed, changed}] }.
 */
export function compareDocs(a, b, opts = {}) {
  const tol = Math.max(opts.tol ?? 1e-6, 1e-12);
  const fa = a.entities.map((e) => feature(e, a)), fb = b.entities.map((e) => feature(e, b));
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
  for (const j of rb) {
    const f = fb[j], t = f.e.type;
    for (let k = 0; k < Math.min(f.pts.length, MAX_PTS * 2); k += 2) gp.add(t, f.pts[k], f.pts[k + 1], j);
    gm.add(f.s, f.ax, f.ay, j);
  }
  const cand = [];
  for (const i of ra) {
    const f = fa[i], seen = new Set();
    for (let k = 0; k < Math.min(f.pts.length, MAX_PTS * 2); k += 2) {
      for (const j of gp.near(f.e.type, f.pts[k], f.pts[k + 1])) {
        if (seen.has(j)) continue; seen.add(j);
        const n = sharedPoints(f, fb[j], tol);
        if (n) cand.push({ i, j, rank: 0, score: -n, d: Math.hypot(f.ax - fb[j].ax, f.ay - fb[j].ay) });
      }
    }
    for (const j of gm.near(f.s, f.ax, f.ay)) {
      if (seen.has(j)) continue;
      const dx = fb[j].ax - f.ax, dy = fb[j].ay - f.ay, d = Math.hypot(dx, dy);
      if (d <= moveRadius && within(f, fb[j], tol, dx, dy)) cand.push({ i, j, rank: 1, score: 0, d });
    }
  }
  cand.sort((p, q) => p.rank - q.rank || p.score - q.score || p.d - q.d);
  for (const c of cand) {
    if (usedA[c.i] || usedB[c.j]) continue;
    usedA[c.i] = usedB[c.j] = 1; changed.push({ a: fa[c.i].e, b: fb[c.j].e });
  }

  const removed = fa.filter((f, i) => !usedA[i]).map((f) => f.e);
  const added = fb.filter((f, j) => !usedB[j]).map((f) => f.e);
  const clusters = clusterChanges(a, b, { added, removed, changed }, opts.clusterGap ?? diag * 0.02);
  return { added, removed, changed, same, clusters };
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
  const order = items.map((_, i) => i).sort((p, q) => items[p].box.minx - items[q].box.minx);
  for (let s = 0; s < order.length; s++) {
    const A = items[order[s]].box;
    for (let t = s + 1; t < order.length && items[order[t]].box.minx <= A.maxx + gap; t++) {
      const B = items[order[t]].box;
      if (B.miny <= A.maxy + gap && A.miny <= B.maxy + gap) parent[find(order[t])] = find(order[s]);
    }
  }
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
  same: { name: 'COMPARE-SAME', color: 8 },        // unchanged: dimmed grey
  added: { name: 'COMPARE-ADDED', color: 3 },      // in B only: green
  removed: { name: 'COMPARE-REMOVED', color: 1 },  // in A only: red
  changed: { name: 'COMPARE-CHANGED', color: 40 }, // amber (both versions drawn)
  marks: { name: 'COMPARE-MARKS', color: 6 },      // dotted rectangles around change clusters (no revision clouds)
};

/** a drawing showing both overlaid in the compare colours, with dotted rectangles around the change clusters */
export function buildCompareDoc(a, b, r) {
  const doc = newDocument();
  doc.units = b.units || a.units;
  for (const L of Object.values(COMPARE_LAYERS)) addLayer(doc, { name: L.name, color: L.color });
  for (const src of [a, b]) {
    for (const [k, v] of src.linetypes) if (!doc.linetypes.has(k)) doc.linetypes.set(k, v);
    for (const [k, v] of src.textStyles) if (!doc.textStyles.has(k)) doc.textStyles.set(k, v);
  }
  // blocks: B's under their names, A's too unless B has one of that name (then A's is renamed "<name>|A")
  const rename = new Map();
  for (const k of a.blocks.keys()) if (b.blocks.has(k)) rename.set(k, `${k}|A`);
  const copyBlocks = (src, ren) => {
    for (const [k, blk] of src.blocks) {
      const ents = structuredClone(blk.entities).map((e) => {
        e.color = 0; e.layer = '0'; // children follow the insert's compare colour and layer
        if (e.block && ren.has(e.block)) e.block = ren.get(e.block);
        return e;
      });
      doc.blocks.set(ren.get(k) ?? k, { ...structuredClone(blk), name: ren.get(k) ?? k, entities: ents });
    }
  };
  copyBlocks(b, new Map());
  copyBlocks(a, rename);
  const put = (e, kind, ren) => {
    const c = structuredClone(e);
    c.id = 0; c.layer = COMPARE_LAYERS[kind].name; c.color = 256;
    if (c.block && ren?.has(c.block)) c.block = ren.get(c.block);
    return addEntity(doc, c);
  };
  for (const p of r.same) put(p.b, 'same');
  for (const p of r.changed) { put(p.a, 'changed', rename); put(p.b, 'changed'); }
  for (const e of r.removed) put(e, 'removed', rename);
  for (const e of r.added) put(e, 'added');
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
