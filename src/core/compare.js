// ASH Draw Studio - drawing compare (command COMPARE): which objects were added, removed or changed between two drawings.
// Pure ES module (no DOM). Entities are matched geometrically, never by list order:
//  1. "same": same type, same strings (text, block name ...), same properties and every coordinate/number within `tol`
//     (found through a spatial hash of each entity's anchor point).
//  2. "changed": among the rest, pairs with the same handle (when both files carry shared handles), else the best
//     geometric partner of the same type: one sharing defining points (edited in place: colour, layer, text, one end
//     moved ...) or an identical shape translated by at most `moveRadius` (moved).
//  3. what is left over is "removed" (A only) or "added" (B only).
// Matching works on drawn pieces: INSERTs (not xrefs, nested ones too) and DIMENSIONs are expanded to their world
// geometry (expandEntities), so a block in A that was exploded or renamed in B still matches. A can first be turned and
// moved (opts.transform, opts.dx/dy, or opts.align 'auto' = estimateTransform, block by block where that fits better)
// so a plan redrawn elsewhere, or turned by quarter turns, still lines up.
import { newDocument, addLayer, addEntity } from './model.js';
import { bboxOf, unionBox, explode, transformEntity, compose, translation, DEG } from './geom.js';

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
// Transforms are geom.js matrices [m0..m5]: x' = m0*x + m2*y + m4, y' = m1*x + m3*y + m5. Alignment only ever finds
// a rotation (about the origin) followed by a translation: m = [c, s, -s, c, dx, dy].

/** cos / sin of a rotation in degrees, exact for quarter turns (so rotated keys are bit-identical to drawn ones) */
function cosSin(deg) {
  const n = ((deg % 360) + 360) % 360;
  return n === 0 ? [1, 0] : n === 90 ? [0, 1] : n === 180 ? [-1, 0] : n === 270 ? [0, -1] : [Math.cos(n * DEG), Math.sin(n * DEG)];
}
const deg360 = (v) => ((Math.round(v) % 360) + 360) % 360;

/** signature (k) and position of a piece as it would be after turning by `deg` about the origin, or null.
 *  The signature holds what a rotation keeps (lengths, radii, sweeps, texts, block names) plus the orientation after the
 *  turn (line direction, arc start, insert rotation), so only pieces consistent with that rotation pair up.
 *  w = vote weight (long lines count more). */
function alignFeature(e, q, longLine, deg = 0) {
  const r = (v) => Math.round(v / q);
  const [c, s] = cosSin(deg);
  const P = (p) => ({ x: c * p.x - s * p.y, y: s * p.x + c * p.y });
  switch (e.type) {
    case 'LINE': {
      const p1 = P(e.p1), p2 = P(e.p2);
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (len < q) return null;
      let ang = Math.atan2(p2.y - p1.y, p2.x - p1.x); if (ang < 0) ang += Math.PI; if (ang >= Math.PI - 1e-9) ang = 0;
      return { k: `L|${r(len)}|${Math.round(ang * 1e3)}`, ...P({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 }), w: Math.min(4, 1 + len / longLine) };
    }
    case 'CIRCLE': return { k: `C|${r(e.r)}`, ...P(e.c), w: 1 };
    case 'ARC': return { k: `A|${r(e.r)}|${deg360(e.a0 + deg)}|${deg360(e.a1 - e.a0)}`, ...P(e.c), w: 1 };
    case 'INSERT': return e.p ? { k: `I|${e.block}|${deg360((e.rot || 0) + deg)}|${e.sx ?? 1}|${e.sy ?? 1}`, ...P(e.p), w: 1 } : null;
    case 'TEXT': case 'MTEXT': return e.p ? { k: `T|${e.text}|${r(e.height || 0)}`, ...P(e.p), w: 1 } : null;
    case 'LWPOLYLINE': {
      const v = e.vertices; if (!v?.length) return null;
      let per = 0, sx = 0, sy = 0;
      for (let i = 0; i < v.length; i++) { sx += v[i].x; sy += v[i].y; if (i) per += Math.hypot(v[i].x - v[i - 1].x, v[i].y - v[i - 1].y); }
      return { k: `P|${v.length}|${e.closed ? 1 : 0}|${r(per)}`, ...P({ x: sx / v.length, y: sy / v.length }), w: 1 };
    }
    default: return null;
  }
}

const MAX_KEY_PAIRS = 8192;   // a signature shared by more A x B pairs than this is too common to vote
const MAX_VOTES = 4e6;

/** what every vote needs, computed once: the signature quantum, B's features grouped by signature */
function alignContext(pa, pb, tol) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of [...pa, ...pb]) {
    const e = p.e, pt = e.p1 ?? e.c ?? e.p ?? e.vertices?.[0];
    if (pt) { if (pt.x < minx) minx = pt.x; if (pt.x > maxx) maxx = pt.x; if (pt.y < miny) miny = pt.y; if (pt.y > maxy) maxy = pt.y; }
  }
  const diag = Math.hypot(maxx - minx, maxy - miny) || 1;
  const ctx = { tol, diag, q: Math.max(tol, diag * 2e-5), longLine: diag * 0.02, fb: [], byKey: new Map() };
  for (const p of pb) {
    const f = alignFeature(p.e, ctx.q, ctx.longLine);
    if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
    const l = ctx.byKey.get(f.k); if (l) l.push(ctx.fb.length); else ctx.byKey.set(f.k, [ctx.fb.length]);
    ctx.fb.push(f);
  }
  return ctx;
}

/** offset votes of pieces pa turned by `deg`: every pair of an A and a B piece sharing a signature votes for B - A */
function gatherVotes(ctx, pa, deg) {
  const fa = [];
  for (const p of pa) { const f = alignFeature(p.e, ctx.q, ctx.longLine, deg); if (f && Number.isFinite(f.x) && Number.isFinite(f.y)) fa.push(f); }
  const byKey = new Map();
  fa.forEach((f, i) => { const b = ctx.byKey.get(f.k); if (!b) return; let g = byKey.get(f.k); if (!g) byKey.set(f.k, g = { a: [], b }); g.a.push(i); });
  const groups = [...byKey.values()].filter((g) => g.a.length * g.b.length <= MAX_KEY_PAIRS)
    .sort((g, h) => g.a.length * g.b.length - h.a.length * h.b.length); // rarest signatures first
  const vx = [], vy = [], vw = [], vi = [], fb = ctx.fb;
  for (const g of groups) {
    if (vx.length + g.a.length * g.b.length > MAX_VOTES) break;
    for (const i of g.a) for (const j of g.b) { vx.push(fb[j].x - fa[i].x); vy.push(fb[j].y - fa[i].y); vw.push(Math.min(fa[i].w, fb[j].w)); vi.push(i); }
  }
  return { vx, vy, vw, vi, n: fa.length };
}

/** weighted mean of the votes within tol of (cx, cy), and how many A pieces agree with it */
function votesNear(V, idx, cx, cy, tol, nb) {
  let sw = 0, sx = 0, sy = 0; const agree = new Set();
  for (const k of idx) if (Math.abs(V.vx[k] - cx) <= tol && Math.abs(V.vy[k] - cy) <= tol) { sw += V.vw[k]; sx += V.vx[k] * V.vw[k]; sy += V.vy[k] * V.vw[k]; agree.add(V.vi[k]); }
  if (!sw) return { dx: 0, dy: 0, votes: 0, confidence: 0 };
  return { dx: sx / sw, dy: sy / sw, votes: agree.size, confidence: Math.min(1, agree.size / Math.max(1, Math.min(V.n, nb))) };
}

const PEAK_SEEDS = 8; // coarse cells refined: noise from common signatures can outweigh the true peak at coarse size

/** the vote peak: the PEAK_SEEDS heaviest coarse cells are each searched coarse to fine (each level 8x finer) down to
 *  the tolerance; the one most A pieces agree with wins */
function peak(ctx, V) {
  const { vx, vy, vw } = V, tol = ctx.tol;
  let best = { dx: 0, dy: 0, votes: 0, confidence: 0 };
  if (!vx.length) return best;
  // the cells (with their 3x3 neighbourhood weight) of one level, heaviest first
  const cells = (idx, cell) => {
    const h = new Map();
    for (const k of idx) { const key = `${Math.floor(vx[k] / cell)},${Math.floor(vy[k] / cell)}`; h.set(key, (h.get(key) ?? 0) + vw[k]); }
    const out = [];
    for (const key of h.keys()) {
      const [i, j] = key.split(',').map(Number);
      let s = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += h.get(`${i + a},${j + b}`) ?? 0;
      out.push({ s, i, j });
    }
    return out.sort((p, q) => q.s - p.s || p.i - q.i || p.j - q.j);
  };
  const all = vx.map((_, k) => k), cell0 = ctx.diag / 64;
  for (const seed of cells(all, cell0).slice(0, PEAK_SEEDS)) {
    // window = the 3x3 around the chosen cell; then the heaviest cell inside it, 8x finer
    let cell = cell0, cx = (seed.i + 0.5) * cell, cy = (seed.j + 0.5) * cell;
    let idx = all.filter((k) => Math.abs(vx[k] - cx) <= cell * 1.5 && Math.abs(vy[k] - cy) <= cell * 1.5);
    while (cell > tol && idx.length) {
      cell = Math.max(cell / 8, tol);
      const c = cells(idx, cell)[0];
      cx = (c.i + 0.5) * cell; cy = (c.j + 0.5) * cell;
      idx = idx.filter((k) => Math.abs(vx[k] - cx) <= cell * 1.5 && Math.abs(vy[k] - cy) <= cell * 1.5);
    }
    const o = votesNear(V, idx, cx, cy, tol, ctx.fb.length);
    if (o.votes > best.votes) best = o;
  }
  return best;
}

const rotMatrix = (deg, dx, dy) => { const [c, s] = cosSin(deg); return [c, s, -s, c, dx, dy]; };
/** rotation of a matrix's linear part in degrees, 0 <= rot < 360 */
const rotOf = (m) => { const d = Math.atan2(m[1], m[0]) / DEG; const n = ((d % 360) + 360) % 360; return Math.abs(n - 360) < 1e-9 ? 0 : n; };

/** best rotation + translation of pieces pa onto the context's B: one vote per candidate rotation, most agreeing wins
 *  (ties: the earlier rotation in the list). `at` (optional matrix): also count how many of pa agree with it. */
function bestTransform(ctx, pa, rotations, at = null) {
  let best = null, atVotes = 0;
  const atRot = at ? rotOf(at) : null;
  for (const deg of rotations) {
    const V = gatherVotes(ctx, pa, deg);
    const o = peak(ctx, V);
    if (at && Math.abs(deg360(deg) - atRot) < 1e-6) atVotes = votesNear(V, V.vx.map((_, k) => k), at[4], at[5], ctx.tol, ctx.fb.length).votes;
    if (!best || o.votes > best.votes) best = { ...o, rot: deg360(deg) };
  }
  if (!best || !best.votes) best = { dx: 0, dy: 0, votes: 0, confidence: 0, rot: 0 };
  return { m: rotMatrix(best.rot, best.dx, best.dy), rot: best.rot, dx: best.dx, dy: best.dy, votes: best.votes, confidence: best.confidence, atVotes };
}

/**
 * Estimate the rotation + translation that moves drawing `a` onto drawing `b` (no scale, no mirror). Each candidate
 * rotation (opts.rotations, degrees, default the quarter turns) turns A's feature points (line midpoints, arc / circle
 * centres, insertion points, polyline centroids) with their orientations; pieces sharing a signature then vote for the
 * offset coarse to fine; the rotation whose peak gathers the most agreeing pieces wins. opts.tol: final resolution in
 * drawing units (default 1). Returns { m: [c, s, -s, c, dx, dy] (geom.js convention: x' = m0*x + m2*y + m4,
 * y' = m1*x + m3*y + m5, i.e. A turned by rot about the origin, then moved by dx, dy), rot (degrees), dx, dy, votes,
 * confidence 0..1 }.
 */
export function estimateTransform(a, b, opts = {}) {
  const pa = expandEntities(a), pb = expandEntities(b);
  const { atVotes, ...t } = bestTransform(alignContext(pa, pb, Math.max(opts.tol ?? 1, 1e-9)), pa, opts.rotations ?? [0, 90, 180, 270]);
  return t;
}

/** Estimate the translation only that moves drawing `a` onto drawing `b` (estimateTransform without rotation).
 *  Returns { dx, dy, votes, confidence 0..1 }. */
export function estimateOffset(a, b, opts = {}) {
  const { dx, dy, votes, confidence } = estimateTransform(a, b, { tol: opts.tol, rotations: [0] });
  return { dx, dy, votes, confidence };
}

/**
 * The rotation + translation (no scale) that puts point a1 on b1 and turns direction a1->a2 onto b1->b2; with one pair
 * only (a2 or b2 null), the translation a1 -> b1. Returns a geom.js matrix.
 */
export function transformFromPoints(a1, a2, b1, b2) {
  if (!a2 || !b2) return [1, 0, 0, 1, b1.x - a1.x, b1.y - a1.y];
  const t = Math.atan2(b2.y - b1.y, b2.x - b1.x) - Math.atan2(a2.y - a1.y, a2.x - a1.x);
  const c = Math.cos(t), s = Math.sin(t);
  return [c, s, -s, c, b1.x - (c * a1.x - s * a1.y), b1.y - (s * a1.x + c * a1.y)];
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

const MIN_GROUP = 200, GROUP_SHARE = 0.02; // a top-level INSERT this big (pieces; share of A) is aligned on its own
const MIN_REALIGN_VOTES = 20;

/**
 * Piecewise alignment: each big top-level INSERT of A (and, as one group named '*Model_Space', everything else) is
 * aligned on its own; a group whose best transform is not the global one `M` and is backed by at least twice the
 * pieces that agree with `M` gets it. Returns { realigned: [{ name, rot, dx, dy, m, votes, confidence }],
 * topM: Map(top-level entity -> matrix) } (only the groups that differ from M).
 */
function realign(ctx, pa, M, rotations) {
  const groups = new Map();
  for (const p of pa) if (p.top !== p.e && p.top.type === 'INSERT') { const l = groups.get(p.top); if (l) l.push(p); else groups.set(p.top, [p]); }
  const big = [...groups].filter(([, l]) => l.length >= Math.max(MIN_GROUP, pa.length * GROUP_SHARE));
  const realigned = [], topM = new Map();
  if (!big.length) return { realigned, topM };
  const inBig = new Set(big.map(([t]) => t));
  const rest = pa.filter((p) => !inBig.has(p.top));
  const rotM = rotOf(M);
  for (const [top, l] of [...big, [null, rest]]) {
    if (!l.length) continue;
    const t = bestTransform(ctx, l, rotations, M);
    const differs = Math.abs(t.rot - rotM) > 1e-6 || Math.hypot(t.dx - M[4], t.dy - M[5]) > 2 * ctx.tol;
    if (!differs || t.votes < Math.max(MIN_REALIGN_VOTES, 2 * t.atVotes)) continue;
    realigned.push({ name: top ? top.block : '*Model_Space', rot: t.rot, dx: t.dx, dy: t.dy, m: t.m, votes: t.votes, confidence: t.confidence });
    for (const p of top ? [{ top }] : l) topM.set(p.top, t.m);
  }
  return { realigned, topM };
}

const isIdentity = (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && !m[4] && !m[5];

/**
 * Compare drawing `a` (original) with `b` (revised), model space.
 * opts: tol (geometry tolerance, drawing units, default 1e-6), moveRadius (largest move still reported as "changed",
 * default 5 % of the drawings' anchor extents), clusterGap (changes closer than this form one cluster, default 2 %),
 * expand (compare drawn pieces, blocks expanded: default true), transform (geom.js matrix applied to A's pieces first)
 * and/or dx/dy (then move A by this), or align: 'auto' (estimateTransform; opts.rotations as there), which by default
 * (piecewise: false to skip) also aligns each big top-level INSERT, and the rest of A as one group, on its own when
 * that fits clearly better than the global transform.
 * Returns { added: [B pieces], removed: [A pieces], changed: [{a, b}], same: [{a, b}], clusters: [{box, added, removed,
 * changed}], offset: { m, rot, dx, dy, votes?, confidence? } (the global A->B transform; dx, dy = m[4], m[5]),
 * realigned: [{ name (block, or '*Model_Space' for the other objects), rot, dx, dy, m, votes, confidence }] (groups moved
 * by their own transform instead), topM: Map(model-space entity of A -> its matrix, when not offset.m),
 * topOf: Map(piece -> model-space entity) } — A's pieces already transformed.
 */
export function compareDocs(a, b, opts = {}) {
  const tol = Math.max(opts.tol ?? 1e-6, 1e-12);
  const expand = opts.expand ?? true;
  const pa = expand ? expandEntities(a) : a.entities.map((e) => ({ e, top: e }));
  const pb = expand ? expandEntities(b) : b.entities.map((e) => ({ e, top: e }));
  let offset, realigned = [], topM = new Map();
  if (opts.align === 'auto') {
    const ctx = alignContext(pa, pb, tol), rotations = opts.rotations ?? [0, 90, 180, 270];
    const { atVotes, ...t } = bestTransform(ctx, pa, rotations);
    offset = t;
    if (opts.piecewise ?? true) ({ realigned, topM } = realign(ctx, pa, t.m, rotations));
  } else {
    let m = opts.transform ? [...opts.transform] : [1, 0, 0, 1, 0, 0];
    if (opts.dx || opts.dy) m = compose(translation(opts.dx ?? 0, opts.dy ?? 0), m);
    offset = { m, rot: rotOf(m), dx: m[4], dy: m[5] };
  }
  for (const p of pa) { const m = topM.get(p.top) ?? offset.m; if (!isIdentity(m)) p.e = transformEntity(p.e, m); }
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
  return { added, removed, changed, same, clusters, offset, realigned, topM, topOf };
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

/** a drawing showing both overlaid in the compare colours (A moved by r.offset / r.topM), with dotted rectangles around the
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
  const mOff = off.m ?? translation(off.dx ?? 0, off.dy ?? 0);
  // the status of every piece of each expanded model-space entity: one status -> draw the entity whole
  const statusA = new Map(), statusB = new Map();
  const note = (m, piece, kind) => { const t = topOf.get(piece); if (!t || t === piece) return; const s = m.get(t); m.set(t, s === undefined || s === kind ? kind : null); };
  for (const p of r.same) { note(statusA, p.a, 'same'); note(statusB, p.b, 'same'); }
  for (const p of r.changed) { note(statusA, p.a, 'changed'); note(statusB, p.b, 'changed'); }
  for (const e of r.removed) note(statusA, e, 'removed');
  for (const e of r.added) note(statusB, e, 'added');
  const whole = (m, kind) => [...m].filter(([, s]) => s === kind).map(([t]) => t);
  const sameB = new Set(whole(statusB, 'same')), addedB = new Set(whole(statusB, 'added')), removedA = new Set(whole(statusA, 'removed'));
  const topsA = [...removedA].map((t) => { const m = r.topM?.get(t) ?? mOff; return isIdentity(m) ? t : transformEntity(t, m); });
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
