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
// The long passes are step generators (src/core/slice.js): compareSteps / buildCompareSteps yield a progress fraction
// every few milliseconds of work, so the window's thread can run them with runSliced; compareDocs / buildCompareDoc drain
// them straight through. Inner steps yield `undefined` (no progress of their own) or a fraction of their own work.

/** re-yield a step generator's progress mapped into lo..hi (a non-number keeps the last fraction); returns its result */
function* phase(gen, lo, hi) {
  let r, f = 0;
  while (!(r = gen.next()).done) { if (typeof r.value === 'number') f = r.value; yield lo + (hi - lo) * f; }
  return r.value;
}

/** the indices k < n (0..n-1) for which keep(k), yielding every 32768 checked */
function* indicesSteps(n, keep = null) {
  const out = [];
  for (let k = 0; k < n; k++) { if (!keep || keep(k)) out.push(k); if ((k & 32767) === 32767) yield; }
  return out;
}
/** the members k of idx for which keep(k), yielding every 32768 checked */
function* filterSteps(idx, keep) {
  const out = [];
  for (let n = 0; n < idx.length; n++) { const k = idx[n]; if (keep(k)) out.push(k); if ((n & 32767) === 32767) yield; }
  return out;
}
import { newDocument, addLayer, addEntity } from './model.js';
import { bboxOf, unionBox, explodeSteps, transformEntity, compose, translation, apply, DEG } from './geom.js';
import { drain } from './slice.js';

const MAX_DEPTH = 16; // nested blocks expanded at most this deep (guards self-referencing blocks)

/**
 * The drawn pieces of `ents` (default: model space): INSERTs of non-xref blocks (nested too, arrays included) and
 * DIMENSIONs are replaced by their transformed block geometry, with layer "0" / BYBLOCK properties resolved from the
 * enclosing INSERT (BYBLOCK of a BYLAYER INSERT: its layer's value). Returns [{ e: piece, top: the model-space entity it
 * comes from, outer?: layers of the INSERTs it is drawn by, outermost first }] (top === e when not expanded).
 */
export function expandEntities(doc, ents = doc.entities) {
  return drain(expandSteps(doc, ents));
}

/** step generator behind expandEntities: yields (fraction of `ents` done) about every 1024 pieces or exploded children */
export function* expandSteps(doc, ents = doc.entities) {
  const out = [], stack = [];
  let work = 0;
  for (let t = 0; t < ents.length; t++) {
    const top = ents[t];
    stack.push({ e: top, inh: null, depth: 0, outer: null }); // depth first, children in order (as the recursion it replaces)
    while (stack.length) {
      if (work >= 1024) { work = 0; yield t / ents.length; }
      const { e, inh, depth, outer } = stack.pop();
      if (inh) { // a fresh copy made by explode(): resolve what it inherits from the INSERT it was drawn by
        if (e.layer === '0' || e.layer == null) e.layer = inh.layer;
        // BYBLOCK takes the INSERT's value; when that is BYLAYER, it is the INSERT's layer's (not the piece's layer's)
        const L = () => layerOf(doc, inh.layer);
        if (e.color === 0) e.color = inh.color === 256 ? (L()?.color ?? 7) : inh.color;
        if (String(e.linetype).toUpperCase() === 'BYBLOCK') e.linetype = String(inh.linetype ?? 'BYLAYER').toUpperCase() === 'BYLAYER' ? (L()?.linetype ?? 'CONTINUOUS') : inh.linetype;
        if (e.lineweight === -2) e.lineweight = inh.lineweight === -1 ? (L()?.lineweight ?? -3) : inh.lineweight;
        delete e.parent; delete e.handle;
      }
      const blk = (e.type === 'INSERT' || e.type === 'DIMENSION') && depth < MAX_DEPTH ? doc.blocks.get(e.block) : null;
      if (blk && !blk.xref) {
        const kids = yield* explodeSteps(e, doc);
        work += kids.length;
        if (kids.length || e.type === 'INSERT') {
          const o = [...(outer ?? []), e.layer]; // the layers of the INSERTs drawing these pieces (a frozen one hides them)
          for (let i = kids.length - 1; i >= 0; i--) stack.push({ e: kids[i], inh: e, depth: depth + 1, outer: o });
          continue;
        }
      }
      out.push(outer ? { e, top, outer } : { e, top });
      work++;
    }
  }
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
function* alignContextSteps(pa, pb, tol) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const l of [pa, pb]) {
    for (let i = 0; i < l.length; i++) {
      const e = l[i].e, pt = e.p1 ?? e.c ?? e.p ?? e.vertices?.[0];
      if (pt) { if (pt.x < minx) minx = pt.x; if (pt.x > maxx) maxx = pt.x; if (pt.y < miny) miny = pt.y; if (pt.y > maxy) maxy = pt.y; }
      if ((i & 16383) === 16383) yield;
    }
  }
  const diag = Math.hypot(maxx - minx, maxy - miny) || 1;
  const ctx = { tol, diag, q: Math.max(tol, diag * 2e-5), longLine: diag * 0.02, fb: [], byKey: new Map() };
  for (let i = 0; i < pb.length; i++) {
    if ((i & 2047) === 2047) yield i / pb.length;
    const f = alignFeature(pb[i].e, ctx.q, ctx.longLine);
    if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
    const l = ctx.byKey.get(f.k); if (l) l.push(ctx.fb.length); else ctx.byKey.set(f.k, [ctx.fb.length]);
    ctx.fb.push(f);
  }
  return ctx;
}

/** offset votes of pieces pa turned by `deg`: every pair of an A and a B piece sharing a signature votes for B - A */
function* gatherVotesSteps(ctx, pa, deg) {
  const fa = [];
  for (let i = 0; i < pa.length; i++) {
    const f = alignFeature(pa[i].e, ctx.q, ctx.longLine, deg); if (f && Number.isFinite(f.x) && Number.isFinite(f.y)) fa.push(f);
    if ((i & 2047) === 2047) yield 0.5 * i / pa.length;
  }
  const byKey = new Map();
  for (let i = 0; i < fa.length; i++) {
    const f = fa[i], b = ctx.byKey.get(f.k);
    if (b) { let g = byKey.get(f.k); if (!g) byKey.set(f.k, g = { a: [], b }); g.a.push(i); }
    if ((i & 16383) === 16383) yield;
  }
  const groups = [...byKey.values()].filter((g) => g.a.length * g.b.length <= MAX_KEY_PAIRS)
    .sort((g, h) => g.a.length * g.b.length - h.a.length * h.b.length); // rarest signatures first
  yield 0.5;
  const vx = [], vy = [], vw = [], vi = [], fb = ctx.fb;
  let since = 0;
  for (const g of groups) {
    if (vx.length + g.a.length * g.b.length > MAX_VOTES) break;
    for (const i of g.a) for (const j of g.b) { vx.push(fb[j].x - fa[i].x); vy.push(fb[j].y - fa[i].y); vw.push(Math.min(fa[i].w, fb[j].w)); vi.push(i); }
    if ((since += g.a.length * g.b.length + 1) >= 65536) { since = 0; yield 0.5 + 0.5 * vx.length / MAX_VOTES; }
  }
  return { vx, vy, vw, vi, n: fa.length };
}

/** weighted mean of the votes within tol of (cx, cy), and how many A pieces agree with it */
function* votesNearSteps(V, idx, cx, cy, tol, nb) {
  let sw = 0, sx = 0, sy = 0; const agree = new Set();
  for (let n = 0; n < idx.length; n++) {
    const k = idx[n];
    if (Math.abs(V.vx[k] - cx) <= tol && Math.abs(V.vy[k] - cy) <= tol) { sw += V.vw[k]; sx += V.vx[k] * V.vw[k]; sy += V.vy[k] * V.vw[k]; agree.add(V.vi[k]); }
    if ((n & 32767) === 32767) yield;
  }
  if (!sw) return { dx: 0, dy: 0, votes: 0, confidence: 0 };
  return { dx: sx / sw, dy: sy / sw, votes: agree.size, confidence: Math.min(1, agree.size / Math.max(1, Math.min(V.n, nb))) };
}

const PEAK_SEEDS = 8; // coarse cells refined: noise from common signatures can outweigh the true peak at coarse size

/** the vote peak: the PEAK_SEEDS heaviest coarse cells are each searched coarse to fine (each level 8x finer) down to
 *  the tolerance; the one most A pieces agree with wins */
function* peakSteps(ctx, V) {
  const { vx, vy, vw } = V, tol = ctx.tol;
  let best = { dx: 0, dy: 0, votes: 0, confidence: 0 };
  if (!vx.length) return best;
  // the cells (with their 3x3 neighbourhood weight) of one level, heaviest first
  function* cells(idx, cell) {
    const h = new Map();
    for (let n = 0; n < idx.length; n++) {
      const k = idx[n], key = `${Math.floor(vx[k] / cell)},${Math.floor(vy[k] / cell)}`; h.set(key, (h.get(key) ?? 0) + vw[k]);
      if ((n & 16383) === 16383) yield;
    }
    const out = [];
    let n = 0;
    for (const key of h.keys()) {
      const [i, j] = key.split(',').map(Number);
      let s = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += h.get(`${i + a},${j + b}`) ?? 0;
      out.push({ s, i, j });
      if ((++n & 4095) === 0) yield;
    }
    return out.sort((p, q) => q.s - p.s || p.i - q.i || p.j - q.j);
  }
  const all = yield* indicesSteps(vx.length), cell0 = ctx.diag / 64;
  const seeds = (yield* cells(all, cell0)).slice(0, PEAK_SEEDS);
  for (let n = 0; n < seeds.length; n++) {
    yield n / seeds.length;
    const seed = seeds[n];
    // window = the 3x3 around the chosen cell; then the heaviest cell inside it, 8x finer
    let cell = cell0, cx = (seed.i + 0.5) * cell, cy = (seed.j + 0.5) * cell;
    let idx = yield* filterSteps(all, (k) => Math.abs(vx[k] - cx) <= cell * 1.5 && Math.abs(vy[k] - cy) <= cell * 1.5);
    while (cell > tol && idx.length) {
      cell = Math.max(cell / 8, tol);
      const c = (yield* cells(idx, cell))[0];
      cx = (c.i + 0.5) * cell; cy = (c.j + 0.5) * cell;
      idx = yield* filterSteps(idx, (k) => Math.abs(vx[k] - cx) <= cell * 1.5 && Math.abs(vy[k] - cy) <= cell * 1.5);
    }
    const o = yield* votesNearSteps(V, idx, cx, cy, tol, ctx.fb.length);
    if (o.votes > best.votes) best = o;
  }
  return best;
}

const rotMatrix = (deg, dx, dy) => { const [c, s] = cosSin(deg); return [c, s, -s, c, dx, dy]; };
/** rotation of a matrix's linear part in degrees, 0 <= rot < 360 */
const rotOf = (m) => { const d = Math.atan2(m[1], m[0]) / DEG; const n = ((d % 360) + 360) % 360; return Math.abs(n - 360) < 1e-9 ? 0 : n; };

/** best rotation + translation of pieces pa onto the context's B: one vote per candidate rotation, most agreeing wins
 *  (ties: the earlier rotation in the list). `at` (optional matrix): also count how many of pa agree with it. */
function* bestTransformSteps(ctx, pa, rotations, at = null) {
  let best = null, atVotes = 0;
  const atRot = at ? rotOf(at) : null;
  for (let r = 0; r < rotations.length; r++) {
    const deg = rotations[r], f = (x) => (r + x) / rotations.length;
    const V = yield* phase(gatherVotesSteps(ctx, pa, deg), f(0), f(0.4));
    const o = yield* phase(peakSteps(ctx, V), f(0.4), f(0.9));
    if (at && Math.abs(deg360(deg) - atRot) < 1e-6) atVotes = (yield* votesNearSteps(V, yield* indicesSteps(V.vx.length), at[4], at[5], ctx.tol, ctx.fb.length)).votes;
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
  const { atVotes, ...t } = drain(bestTransformSteps(drain(alignContextSteps(pa, pb, Math.max(opts.tol ?? 1, 1e-9))), pa, opts.rotations ?? [0, 90, 180, 270]));
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
// numbers by meaning: lengths are compared with tol as they are; angles (degrees) and other numbers (bulge, ratios,
// scale factors ...) times the object's size, so a change that moves what is drawn by more than tol is never "same".
// Integers of other keys (counts, flags, alignments) are compared exactly, as strings.
const LEN_KEYS = new Set(['r', 'height', 'width', 'colSp', 'rowSp', 'startWidth', 'endWidth', 'constWidth', 'thickness', 'elevation', 'z']);
const ANG_KEYS = new Set(['rot', 'angle', 'oblique', 'a0', 'a1']);
const VEC_KEYS = new Set(['major', 'dir', 'u', 'v', 'normal', 'extrusion']); // {x, y} that are directions, not places
// per type: keys whose meaning is carried by the drawn check points derived below instead
const OWN_KEYS = {
  ARC: new Set(['a0', 'a1']), ELLIPSE: new Set(['major', 'ratio', 'a0', 'a1']), XLINE: new Set(['dir']), RAY: new Set(['dir']),
  TEXT: new Set(['rot', 'widthFactor', 'oblique']), MTEXT: new Set(['rot', 'widthFactor', 'oblique']), INSERT: new Set(['sx', 'sy', 'rot']),
};
const norm360 = (d) => ((d % 360) + 360) % 360;

/** a layer of `doc` by name, any case (null when unknown) */
const layerCache = new WeakMap();
function layerOf(doc, name) {
  let m = layerCache.get(doc.layers);
  if (!m) { m = new Map(); for (const [k, L] of doc.layers) m.set(String(k).toUpperCase(), L); layerCache.set(doc.layers, m); }
  return m.get(String(name ?? '0').toUpperCase()) ?? null;
}
/** is a piece (its layer, and the layers of the INSERTs it is drawn by) hidden by `doc`'s layer table: off or frozen */
function hiddenIn(doc, p) {
  const L = layerOf(doc, p.e.layer);
  if (L && (L.frozen || L.visible === false)) return true;
  for (const n of p.outer ?? []) if (layerOf(doc, n)?.frozen) return true;
  return false;
}
/** size (block units) of a block about its base point, at least 1: an INSERT's scale and rotation act at this distance */
const blockSizes = new WeakMap();
function blockSize(doc, name) {
  let m = blockSizes.get(doc.blocks); if (!m) blockSizes.set(doc.blocks, m = new Map());
  if (m.has(name)) return m.get(name);
  m.set(name, 1); // guards self-references
  const blk = doc.blocks.get(name); let box = null;
  for (const c of blk?.entities ?? []) box = unionBox(box, bboxOf(c, doc));
  const bx = blk?.base?.x ?? 0, by = blk?.base?.y ?? 0;
  const S = box && Number.isFinite(box.minx + box.maxx + box.miny + box.maxy) ? Math.max(1, Math.abs(box.minx - bx), Math.abs(box.maxx - bx), Math.abs(box.miny - by), Math.abs(box.maxy - by)) : 1;
  m.set(name, S);
  return S;
}

/** drawn check points of the types whose angles / ratios / scales would otherwise be bare numbers */
function checkPoints(e, doc, out) {
  const at = (c, r, deg) => out.push(c.x + r * Math.cos(deg * DEG), c.y + r * Math.sin(deg * DEG));
  switch (e.type) {
    case 'ARC': {
      const sweep = norm360(e.a1 - e.a0) || 360;
      at(e.c, e.r, e.a0); at(e.c, e.r, e.a0 + sweep / 2); at(e.c, e.r, e.a0 + sweep);
      break;
    }
    case 'ELLIPSE': {
      const M = e.major, k = e.ratio ?? 1, N = { x: -M.y * k, y: M.x * k };
      const P = (t) => out.push(e.c.x + M.x * Math.cos(t) + N.x * Math.sin(t), e.c.y + M.y * Math.cos(t) + N.y * Math.sin(t));
      for (const t of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI]) P(t);
      let sw = (e.a1 ?? 2 * Math.PI) - (e.a0 ?? 0); sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      P(e.a0 ?? 0); P((e.a0 ?? 0) + sw / 2); P((e.a0 ?? 0) + sw);
      break;
    }
    case 'LWPOLYLINE': { // every segment's middle, on the arc for a bulged one
      const v = e.vertices ?? [], n = v.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const p = v[i], q = v[(i + 1) % n], b = p.bulge || 0;
        out.push((p.x + q.x) / 2 + b * (q.y - p.y) / 2, (p.y + q.y) / 2 - b * (q.x - p.x) / 2);
      }
      break;
    }
    case 'XLINE': case 'RAY': if (e.p && e.dir) out.push(e.p.x + e.dir.x * 1e6, e.p.y + e.dir.y * 1e6); break;
    case 'TEXT': case 'MTEXT': if (e.p) { // the far end of the baseline and the top corner over it
      const h = e.height || 0, chars = Math.max(1, ...String(e.text ?? '').split(/\\P|\n/).map((l) => l.length));
      const L = Math.max(h * (e.widthFactor ?? 1) * chars, e.type === 'MTEXT' ? e.width || 0 : 0), sh = h * Math.tan((e.oblique || 0) * DEG);
      const c = Math.cos((e.rot || 0) * DEG), s = Math.sin((e.rot || 0) * DEG);
      out.push(e.p.x + c * L, e.p.y + s * L, e.p.x + c * (L + sh) - s * h, e.p.y + s * (L + sh) + c * h);
      break;
    }
    case 'INSERT': if (e.p) { // the block's x and y axes, scaled, at its size
      const S = blockSize(doc, e.block), c = Math.cos((e.rot || 0) * DEG), s = Math.sin((e.rot || 0) * DEG), sx = (e.sx ?? 1) * S, sy = (e.sy ?? 1) * S;
      out.push(e.p.x + c * sx, e.p.y + s * sx, e.p.x - s * sy, e.p.y + c * sy);
      break;
    }
  }
}

/** colour / linetype / lineweight as drawn: BYLAYER resolved through `doc`'s layer table (BYBLOCK was resolved when the
 *  piece was expanded from its INSERT) */
function effectiveProps(e, doc, hid) {
  const L = layerOf(doc, e.layer);
  const color = e.color === 256 ? (L?.color ?? 7) : e.color;
  const lt = String(e.linetype ?? 'BYLAYER').toUpperCase() === 'BYLAYER' ? (L?.linetype ?? 'CONTINUOUS') : e.linetype;
  const lw = e.lineweight === -1 ? (L?.lineweight ?? -3) : e.lineweight;
  return JSON.stringify([e.layer, color, String(lt).toUpperCase(), lw, e.ltscale ?? 1, hid ? 1 : 0]);
}

/** feature of one entity: strings (identity), points (x,y pairs: defining points, then drawn check points), scalars
 *  (lengths, and the other numbers scaled to lengths); anchor = first point. hid: on a layer hidden in its drawing */
function feature(e, doc, hid = false) {
  const pts = [], sc = [], str = [], rel = [], own = OWN_KEYS[e.type];
  const walk = (v, k) => {
    if (v == null) return;
    if (typeof v === 'number') {
      if (LEN_KEYS.has(k)) sc.push(v);
      else if (ANG_KEYS.has(k)) rel.push(norm360(v) * DEG);
      else if (Number.isInteger(v)) str.push(`${k}=${v}`);
      else rel.push(v);
      return;
    }
    if (typeof v === 'string' || typeof v === 'boolean') { str.push(`${k}=${v}`); return; }
    if (Array.isArray(v)) { str.push(`${k}#${v.length}`); for (const x of v) walk(x, k); return; }
    if (typeof v === 'object') {
      const xy = typeof v.x === 'number' && typeof v.y === 'number';
      if (xy && VEC_KEYS.has(k)) rel.push(v.x, v.y);
      else if (xy) pts.push(v.x, v.y);
      for (const kk of Object.keys(v).sort()) if (!(kk === 'x' || kk === 'y') || typeof v[kk] !== 'number') walk(v[kk], kk);
    }
  };
  for (const k of Object.keys(e).sort()) {
    if (SKIP_KEYS.has(k) || own?.has(k)) continue;
    if (e.type === 'DIMENSION' && k === 'block') continue; // anonymous block names (*D12) differ between files
    walk(e[k], k);
  }
  if (e.type === 'DIMENSION') { // what the dimension draws stands in for its definition points
    const b = bboxOf(e, doc);
    if (b) pts.push(b.minx, b.miny, b.maxx, b.maxy);
  }
  if (e.type === 'LINE' && (pts[0] > pts[2] || (pts[0] === pts[2] && pts[1] > pts[3]))) pts.push(...pts.splice(0, 2)); // direction-free
  checkPoints(e, doc, pts);
  // the object's size: the numbers that are not lengths are compared as (number x size), i.e. an angle within tol / size
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { if (pts[i] < minx) minx = pts[i]; if (pts[i] > maxx) maxx = pts[i]; if (pts[i + 1] < miny) miny = pts[i + 1]; if (pts[i + 1] > maxy) maxy = pts[i + 1]; }
  const size = Math.max(1, pts.length > 2 ? Math.hypot(maxx - minx, maxy - miny) : 0, 2 * Math.abs(e.r || 0), Math.abs(e.height || 0));
  for (const v of rel) sc.push(v * size);
  const props = effectiveProps(e, doc, hid);
  const s = JSON.stringify([e.type, str]);
  return { e, s, props, hid, pts, sc, ax: pts.length ? pts[0] : 0, ay: pts.length ? pts[1] : 0 };
}

/** identity strings and properties equal (the grid keys only narrow the search) */
const sameIdentity = (a, b) => a.s === b.s && a.props === b.props;

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
function* realignSteps(ctx, pa, M, rotations) {
  const groups = new Map();
  for (let i = 0; i < pa.length; i++) {
    const p = pa[i];
    if (p.top !== p.e && p.top.type === 'INSERT') { const l = groups.get(p.top); if (l) l.push(p); else groups.set(p.top, [p]); }
    if ((i & 16383) === 16383) yield;
  }
  const big = [...groups].filter(([, l]) => l.length >= Math.max(MIN_GROUP, pa.length * GROUP_SHARE));
  const realigned = [], topM = new Map();
  if (!big.length) return { realigned, topM };
  const inBig = new Set(big.map(([t]) => t));
  const rest = pa.filter((p) => !inBig.has(p.top));
  const rotM = rotOf(M), todo = [...big, [null, rest]];
  // progress: by pieces aligned
  let done = 0;
  for (const [top, l] of todo) {
    if (!l.length) continue;
    const t = yield* phase(bestTransformSteps(ctx, l, rotations, M), done / pa.length, (done + l.length) / pa.length);
    done += l.length;
    const differs = Math.abs(t.rot - rotM) > 1e-6 || Math.hypot(t.dx - M[4], t.dy - M[5]) > 2 * ctx.tol;
    if (!differs || t.votes < Math.max(MIN_REALIGN_VOTES, 2 * t.atVotes)) continue;
    const g = { name: top ? top.block : '*Model_Space', rot: t.rot, dx: t.dx, dy: t.dy, m: t.m, votes: t.votes, confidence: t.confidence };
    if (!top) g.ref = big.filter(([b]) => !topM.has(b)).map(([b]) => b.block); // the big blocks that stayed with the global transform
    realigned.push(g);
    for (const p of top ? [{ top }] : l) topM.set(p.top, t.m);
  }
  return { realigned, topM };
}

/** bounding box of points */
const boxOfPts = (ps) => ps.reduce((B, p) => unionBox(B, { minx: p.x, miny: p.y, maxx: p.x, maxy: p.y }), null);
const isIdentity = (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && !m[4] && !m[5];

/**
 * Compare drawing `a` (original) with `b` (revised), model space.
 * opts: tol (geometry tolerance, drawing units, default 1e-6), moveRadius (largest move still reported as "changed",
 * default 5 % of the drawings' anchor extents), clusterGap (changes closer than this form one cluster, drawing units, default
 * defaultClusterGap = 1.5 m), ignoreLayers (layer names, any case: pieces on them, or drawn by a model-space entity on them,
 * are left out of the compare),
 * expand (compare drawn pieces, blocks expanded: default true), transform (geom.js matrix applied to A's pieces first)
 * and/or dx/dy (then move A by this), or align: 'auto' (estimateTransform; opts.rotations as there), which by default
 * (piecewise: false to skip) also aligns each big top-level INSERT, and the rest of A as one group, on its own when
 * that fits clearly better than the global transform.
 * Returns { added: [B pieces], removed: [A pieces], changed: [{a, b}], same: [{a, b}], clusters: [{box, added, removed,
 * changed}], offset: { m, rot, dx, dy, votes?, confidence? } (the global A->B transform; dx, dy = m[4], m[5]),
 * realigned: [{ name (block, or '*Model_Space' for the other objects), rot, dx, dy, m, votes, confidence, pieces, moved,
 * rel: { dx, dy, rot } (move of the group's centre relative to the global transform), ref? ('*Model_Space': the big
 * blocks that stayed with the global transform) }] (groups aligned by their own transform instead; a moved one's pieces
 * that only matched through that transform are "changed" with why 'moved with group', A's piece at the global position,
 * and its changes form one cluster { ..., moved: name } placed first), topM: Map(model-space entity of A -> its matrix, when not offset.m),
 * topOf: Map(piece -> model-space entity) } — A's pieces already transformed.
 */
export function compareDocs(a, b, opts = {}) {
  return drain(compareSteps(a, b, opts));
}

/** step generator behind compareDocs (same options and result): yields a progress fraction 0..1 about every
 *  millisecond or so of work, for src/core/slice.js runSliced. A and B must not change until it is done. */
export function* compareSteps(a, b, opts = {}) {
  const tol = Math.max(opts.tol ?? 1e-6, 1e-12);
  const expand = opts.expand ?? true;
  // progress milestones: expand A, B | align (global; per group) | transform + features | match | clusters
  const P = { a: 0.08, b: 0.16, global: 0.42, realign: 0.66, feat: 0.78, match: 0.95 };
  let pa = expand ? yield* phase(expandSteps(a), 0, P.a) : a.entities.map((e) => ({ e, top: e }));
  let pb = expand ? yield* phase(expandSteps(b), P.a, P.b) : b.entities.map((e) => ({ e, top: e }));
  let ignored = 0; // pieces left out because their layer (or their INSERT's) is ignored
  if (opts.ignoreLayers?.length) {
    const ign = new Set([...opts.ignoreLayers].map((n) => String(n).toUpperCase()));
    const keep = (p) => !ign.has(String(p.e.layer ?? '0').toUpperCase()) && !ign.has(String(p.top.layer ?? '0').toUpperCase());
    const n0 = pa.length + pb.length;
    pa = pa.filter(keep); pb = pb.filter(keep);
    ignored = n0 - pa.length - pb.length;
  }
  // layer table: a piece hidden (layer off / frozen) in both drawings is left out; hidden in one only, it is compared
  // with that state as a property (so it is never "same" with its visible twin)
  const hidA = new Set(), hidB = new Set();
  pa = pa.filter((p) => { const h = hiddenIn(a, p); if (h && hiddenIn(b, p)) return false; if (h) hidA.add(p); return true; });
  pb = pb.filter((p) => { const h = hiddenIn(b, p); if (h && hiddenIn(a, p)) return false; if (h) hidB.add(p); return true; });
  let offset, realigned = [], topM = new Map();
  if (opts.align === 'auto') {
    const ctx = yield* phase(alignContextSteps(pa, pb, tol), P.b, P.b + 0.02), rotations = opts.rotations ?? [0, 90, 180, 270];
    const { atVotes, ...t } = yield* phase(bestTransformSteps(ctx, pa, rotations), P.b + 0.02, P.global);
    offset = t;
    if (opts.piecewise ?? true) ({ realigned, topM } = yield* phase(realignSteps(ctx, pa, t.m, rotations), P.global, P.realign));
  } else {
    let m = opts.transform ? [...opts.transform] : [1, 0, 0, 1, 0, 0];
    if (opts.dx || opts.dy) m = compose(translation(opts.dx ?? 0, opts.dy ?? 0), m);
    offset = { m, rot: rotOf(m), dx: m[4], dy: m[5] };
  }
  const nAB = pa.length + pb.length || 1;
  const step = (i, n, lo, hi) => lo + (hi - lo) * (i / Math.max(n, 1)); // progress of item i of n within lo..hi
  // realigned groups: their original pieces are kept (a moved group's pieces are compared again at the global position)
  const gIdx = new Map(realigned.map((g, k) => [g.m, k])), ext = realigned.map(() => null), cnt = realigned.map(() => 0);
  const origA = new Map(), groupA = new Map(); // A piece as matched -> original piece / index of its realigned group
  for (let i = 0; i < pa.length; i++) {
    const p = pa[i], gm = topM.get(p.top), m = gm ?? offset.m, o = p.e;
    if (!isIdentity(m)) p.e = transformEntity(p.e, m);
    if (gm) {
      const k = gIdx.get(gm), bx = bboxOf(o, a);
      origA.set(p.e, o); groupA.set(p.e, k); cnt[k]++;
      if (bx && Number.isFinite(bx.minx + bx.maxx + bx.miny + bx.maxy)) ext[k] = unionBox(ext[k], bx);
    }
    if ((i & 1023) === 1023) yield step(i, nAB * 3, P.realign, P.feat);
  }
  // a group is moved when its transform and the global one put a corner of its A extent more than tol apart
  realigned.forEach((g, k) => {
    const B = ext[k], corners = B ? [{ x: B.minx, y: B.miny }, { x: B.maxx, y: B.miny }, { x: B.maxx, y: B.maxy }, { x: B.minx, y: B.maxy }] : [];
    g.pieces = cnt[k];
    g.moved = corners.some((c) => { const p = apply(g.m, c), q = apply(offset.m, c); return Math.hypot(p.x - q.x, p.y - q.y) > tol; });
    const c = B ? { x: (B.minx + B.maxx) / 2, y: (B.miny + B.maxy) / 2 } : { x: 0, y: 0 }, p = apply(g.m, c), q = apply(offset.m, c);
    let rot = norm360(rotOf(g.m) - rotOf(offset.m)); if (rot > 180) rot -= 360; if (Math.abs(rot) < 1e-9) rot = 0;
    g.rel = { dx: p.x - q.x, dy: p.y - q.y, rot };
    g.box = B && unionBox(boxOfPts(corners.map((pt) => apply(g.m, pt))), boxOfPts(corners.map((pt) => apply(offset.m, pt))));
  });
  const topOf = new Map();
  for (const p of pa) topOf.set(p.e, p.top);
  for (const p of pb) topOf.set(p.e, p.top);
  const fa = [], fb = [];
  for (const [ps, d, fs, hid] of [[pa, a, fa, hidA], [pb, b, fb, hidB]]) {
    for (let i = 0; i < ps.length; i++) {
      fs.push(feature(ps[i].e, d, hid.has(ps[i])));
      if ((i & 511) === 511) yield step(pa.length + fa.length + fb.length, nAB * 3, P.realign, P.feat);
    }
  }
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const fs of [fa, fb]) for (const f of fs) { if (f.ax < minx) minx = f.ax; if (f.ax > maxx) maxx = f.ax; if (f.ay < miny) miny = f.ay; if (f.ay > maxy) maxy = f.ay; }
  yield P.feat;
  const diag = fa.length + fb.length ? Math.hypot(maxx - minx, maxy - miny) : 0;
  const moveRadius = Math.max(opts.moveRadius ?? diag * 0.05, tol);
  const usedA = new Uint8Array(fa.length), usedB = new Uint8Array(fb.length);
  const same = [], changed = [], sameIJ = [];

  // 1. identical objects
  const M1 = P.feat + (P.match - P.feat) * 0.3; // progress: identical objects up to here, then the partners
  const g = new Grid(tol * 2);
  const idKey = (f) => `${f.s}\u0003${f.props}`;
  for (let j = 0; j < fb.length; j++) { const f = fb[j]; g.add(idKey(f), f.ax, f.ay, j); if ((j & 4095) === 4095) yield; }
  for (let i = 0; i < fa.length; i++) {
    const f = fa[i];
    for (const j of g.near(idKey(f), f.ax, f.ay)) {
      if (usedB[j] || !sameIdentity(f, fb[j]) || !within(f, fb[j], tol)) continue;
      usedA[i] = usedB[j] = 1; same.push({ a: f.e, b: fb[j].e }); sameIJ.push(i, j); break;
    }
    if ((i & 1023) === 1023) yield step(i, fa.length, P.feat, M1);
  }

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
  for (let n = 0; n < rb.length; n++) {
    const j = rb[n], f = fb[j], t = f.e.type;
    for (let k = 0; k < Math.min(f.pts.length, MAX_PTS * 2); k += 2) gp.add(t, f.pts[k], f.pts[k + 1], j);
    gm.add(shapeKey(f), f.ax, f.ay, j);
    if ((n & 1023) === 1023) yield;
  }
  const cand = [];
  for (let n = 0; n < ra.length; n++) {
    if ((n & 127) === 127) yield step(n, ra.length, M1, P.match);
    const i = ra[n], f = fa[i], seen = new Set(), paired = new Set();
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
  yield P.match;
  cand.sort((p, q) => p.rank - q.rank || p.score - q.score || p.d - q.d);
  yield P.match;
  for (const c of cand) {
    if (usedA[c.i] || usedB[c.j]) continue;
    usedA[c.i] = usedB[c.j] = 1;
    changed.push(fa[c.i].hid !== fb[c.j].hid ? { a: fa[c.i].e, b: fb[c.j].e, why: 'layer hidden' } : { a: fa[c.i].e, b: fb[c.j].e });
  }

  // 3. a moved group's "same" pairs matched only through its own transform: A's original at the global position
  //    compared again with the same partner; no longer matching, the pair is changed ('moved with group')
  if (realigned.some((g) => g.moved)) {
    const keep = [];
    for (let n = 0; n < same.length; n++) {
      const i = sameIJ[2 * n], j = sameIJ[2 * n + 1], k = groupA.get(fa[i].e);
      if (k === undefined || !realigned[k].moved) { keep.push(same[n]); continue; }
      const o = origA.get(fa[i].e), e = isIdentity(offset.m) ? o : transformEntity(o, offset.m), f = feature(e, a, fa[i].hid);
      if (sameIdentity(f, fb[j]) && within(f, fb[j], tol)) { keep.push(same[n]); continue; }
      topOf.set(e, topOf.get(fa[i].e)); groupA.set(e, k);
      changed.push({ a: e, b: fb[j].e, why: 'moved with group' });
      if ((n & 1023) === 1023) yield;
    }
    same.splice(0, same.length, ...keep);
  }
  const removed = fa.filter((f, i) => !usedA[i]).map((f) => f.e);
  const added = fb.filter((f, j) => !usedB[j]).map((f) => f.e);
  // the changes of each moved group form one cluster, first; clusterSteps gets the others
  const movedOf = (e) => { const k = groupA.get(e); return k !== undefined && realigned[k].moved ? k : -1; };
  const gcl = realigned.map((g) => ({ box: g.box, added: 0, removed: 0, changed: 0, moved: g.name }));
  const outRemoved = removed.filter((e) => { const k = movedOf(e); if (k < 0) return true; gcl[k].removed++; return false; });
  const outChanged = changed.filter((p) => { const k = movedOf(p.a); if (k < 0) return true; gcl[k].changed++; return false; });
  const rest = yield* phase(clusterSteps(a, b, { added, removed: outRemoved, changed: outChanged }, opts.clusterGap ?? defaultClusterGap(b.units || a.units)), P.match, 1);
  const clusters = [...gcl.filter((c) => c.box && c.removed + c.changed), ...rest];
  for (const g of realigned) delete g.box;
  return { added, removed, changed, same, clusters, ignored, offset, realigned, topM, topOf };
}

const CLUSTER_SPAN = 10;     // a cluster wider or taller than this many group distances is cut into smaller ones
const CELL_CHECKS = 64;      // members of one grid cell checked exactly; beyond that a shared cell is near enough

/** default distance between changes that a reviewer would mark separately: 1.5 m in the drawing's units */
export function defaultClusterGap(units) { return 1500 * defaultTolerance(units); }

const boxGap = (p, q) => Math.max(p.minx - q.maxx, q.minx - p.maxx, p.miny - q.maxy, q.miny - p.maxy, 0);

/**
 * Group nearby changes; each cluster = { box, added, removed, changed } (counts).
 *  1. single linkage: changes whose boxes are at most `gap` apart share a cluster (grid of gap-wide cells: linear-ish);
 *  2. a cluster whose box is more than CLUSTER_SPAN group distances (its larger side; 15 m at the default 1.5 m) is cut
 *     along its longer side, at its largest empty gap, or (none visible) into equal parts, until each part fits; a single
 *     change bigger than that is a cluster of its own;
 *  3. no cap and no merging (a merge would cross the size limit of 2.); the panel pages a long list;
 *     changes without a finite box (XLINE, RAY, untessellatable) form one extra last cluster {unbounded: n} whose box
 *     is the drawing extent;
 *  4. reading order: rows from the top, left to right within a row.
 */
export function clusterChanges(a, b, r, gap) {
  return drain(clusterSteps(a, b, r, gap));
}

/** step generator behind clusterChanges */
function* clusterSteps(a, b, r, gap) {
  const items = [], unb = { added: 0, removed: 0, changed: 0 }, total = r.added.length + r.removed.length + r.changed.length;
  const lists = [[r.added, (e) => bboxOf(e, b), 'added'], [r.removed, (e) => bboxOf(e, a), 'removed'], [r.changed, (p) => unionBox(bboxOf(p.a, a), bboxOf(p.b, b)), 'changed']];
  for (const [l, boxOf, k] of lists) {
    for (let i = 0; i < l.length; i++) {
      const box = boxOf(l[i]);
      if (box && Number.isFinite(box.minx + box.maxx + box.miny + box.maxy)) items.push({ k, box }); else unb[k]++;
      if ((i & 1023) === 1023) yield 0.4 * items.length / total;
    }
  }
  const nUnb = unb.added + unb.removed + unb.changed;
  if (!items.length && !nUnb) return [];
  gap = Math.max(gap, 1e-9);
  const limit = CLUSTER_SPAN * gap;
  // a change bigger than a cluster may be (a long polyline, a hatch) is a cluster of its own: linked, it would hold
  // every change it spans in one box no cut can shrink
  const huge = items.filter((it) => Math.max(it.box.maxx - it.box.minx, it.box.maxy - it.box.miny) > limit);
  if (huge.length) { const h = new Set(huge); items.splice(0, items.length, ...items.filter((it) => !h.has(it))); }
  // 1. single linkage on boxes
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const cell = gap, cells = new Map();
  for (let i = 0; i < items.length; i++) {
    if ((i & 1023) === 1023) yield 0.4 + 0.4 * i / items.length;
    const it = items[i], B = it.box, h = gap / 2;
    let x0 = Math.floor((B.minx - h) / cell), x1 = Math.floor((B.maxx + h) / cell), y0 = Math.floor((B.miny - h) / cell), y1 = Math.floor((B.maxy + h) / cell);
    const border = (x1 - x0 + 1) * (y1 - y0 + 1) > 4096; // a huge box: its rim cells only (what is inside touches it anyway via others)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (border && x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
      const key = x * 1e7 + y, l = cells.get(key);
      if (!l) { cells.set(key, [i]); continue; }
      let n = 0;
      for (const o of l) {
        if (find(o) === find(i)) continue;
        if (++n > CELL_CHECKS || boxGap(it.box, items[o].box) <= gap) parent[find(i)] = find(o);
      }
      l.push(i);
    }
  }
  const groups = new Map(huge.map((it, i) => [-1 - i, [it]]));
  items.forEach((it, i) => { const g = find(i), l = groups.get(g); if (l) l.push(it); else groups.set(g, [it]); });
  // 2. cut oversize clusters
  const boxOf = (l) => l.reduce((bx, it) => unionBox(bx, it.box), null);
  const parts = [], todo = [...groups.values()];
  while (todo.length) {
    yield 0.8;
    const l = todo.pop(), B = boxOf(l);
    const wx = B.maxx - B.minx, wy = B.maxy - B.miny, side = Math.max(wx, wy);
    if (side <= limit || l.length < 2) { parts.push({ l, box: B }); continue; }
    const [lo, hi] = wx >= wy ? ['minx', 'maxx'] : ['miny', 'maxy'];
    l.sort((p, q) => p.box[lo] - q.box[lo]);
    // largest empty gap along the axis (between the reach so far and the next start)
    let reach = l[0].box[hi], cut = -1, best = 0;
    for (let i = 1; i < l.length; i++) {
      const g = l[i].box[lo] - reach;
      if (g > best) { best = g; cut = i; }
      if (l[i].box[hi] > reach) reach = l[i].box[hi];
    }
    if (best < gap / 4) { // no visible gap: equal parts (by centre), the first one cut off here
      const k = Math.ceil(side / limit), at = B[lo] + side / k;
      const c = (it) => (it.box[lo] + it.box[hi]) / 2;
      l.sort((p, q) => c(p) - c(q));
      cut = l.findIndex((it) => c(it) > at);
      if (cut <= 0) cut = l.length >> 1;
      if (c(l[cut - 1]) === c(l[cut]) && c(l[0]) === c(l[l.length - 1])) { parts.push({ l, box: B }); continue; } // cannot split
    }
    todo.push(l.slice(0, cut), l.slice(cut));
  }
  const out = parts.map(({ box, l }) => { const c = { box, added: 0, removed: 0, changed: 0 }; for (const it of l) c[it.k]++; return c; });
  // 4. reading order: a row starts with the highest remaining top; clusters whose top reaches above its middle (or
  //    less than 2 gaps below its top) join it
  out.sort((p, q) => q.box.maxy - p.box.maxy || p.box.minx - q.box.minx);
  const sorted = [];
  for (let i = 0; i < out.length;) {
    const mid = Math.min((out[i].box.miny + out[i].box.maxy) / 2, out[i].box.maxy - 2 * gap);
    let j = i + 1;
    while (j < out.length && out[j].box.maxy >= mid) j++;
    sorted.push(...out.slice(i, j).sort((p, q) => p.box.minx - q.box.minx || q.box.maxy - p.box.maxy));
    i = j;
  }
  if (nUnb) { // changes without a box: one last cluster over the drawing extent
    let box = null;
    for (const d of [a, b]) for (const e of d.entities) { const x = bboxOf(e, d); if (x && Number.isFinite(x.minx + x.maxx + x.miny + x.maxy)) box = unionBox(box, x); }
    sorted.push({ box: box ?? { minx: 0, miny: 0, maxx: limit, maxy: limit }, ...unb, unbounded: nUnb });
  }
  return sorted;
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
  return drain(buildCompareSteps(a, b, r));
}

/** step generator behind buildCompareDoc: yields a progress fraction about every 256 objects copied */
export function* buildCompareSteps(a, b, r) {
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
  let n = 0;
  const total = 2 * (r.same.length + r.changed.length) + r.removed.length + r.added.length + 1; // pieces drawn at most
  for (const p of r.same) { note(statusA, p.a, 'same'); note(statusB, p.b, 'same'); if ((++n & 8191) === 0) yield 0; }
  for (const p of r.changed) { note(statusA, p.a, 'changed'); note(statusB, p.b, 'changed'); }
  for (const e of r.removed) note(statusA, e, 'removed');
  for (const e of r.added) note(statusB, e, 'added');
  const whole = (m, kind) => [...m].filter(([, s]) => s === kind).map(([t]) => t);
  const sameB = new Set(whole(statusB, 'same')), addedB = new Set(whole(statusB, 'added')), removedA = new Set(whole(statusA, 'removed'));
  const topsA = [];
  for (const t of removedA) { const m = r.topM?.get(t) ?? mOff; topsA.push(isIdentity(m) ? t : transformEntity(t, m)); if ((topsA.length & 1023) === 0) yield 0; }
  // blocks drawn whole: B's under their names, A's too unless B has one of that name (then A's is "<name>|A")
  const usedB = blocksUsed(b, [...sameB, ...addedB]), usedA = blocksUsed(a, topsA);
  const rename = new Map();
  for (const k of usedA) if (b.blocks.has(k)) rename.set(k, `${k}|A`);
  function* copyBlocks(src, used, ren) {
    for (const k of used) {
      yield 0;
      const blk = src.blocks.get(k);
      const ents = [];
      for (let i = 0; i < blk.entities.length; i += 512) { // a huge block: cloned in slices
        if (i) yield 0;
        for (const e of structuredClone(blk.entities.slice(i, i + 512))) {
          e.color = 0; e.layer = '0'; // children follow the insert's compare colour and layer
          if (e.block && ren.has(e.block)) e.block = ren.get(e.block);
          ents.push(e);
        }
      }
      doc.blocks.set(ren.get(k) ?? k, { ...structuredClone({ ...blk, entities: [] }), name: ren.get(k) ?? k, entities: ents });
    }
  }
  yield* copyBlocks(b, usedB, new Map());
  yield* copyBlocks(a, usedA, rename);
  n = 0;
  const put = (e, kind, ren) => {
    const c = structuredClone(e);
    c.id = 0; c.layer = COMPARE_LAYERS[kind].name; c.color = 256;
    if (c.block && ren?.has(c.block)) c.block = ren.get(c.block);
    return addEntity(doc, c);
  };
  const piecewise = (piece, set) => !set.has(topOf.get(piece));
  const tick = () => (++n & 255) === 0;
  for (const t of sameB) { put(t, 'same'); if (tick()) yield n / total; }
  for (const p of r.same) { if (piecewise(p.b, sameB)) put(p.b, 'same'); if (tick()) yield n / total; }
  for (const p of r.changed) { put(p.a, 'changedA'); put(p.b, 'changed'); if (tick()) yield n / total; }
  for (const t of topsA) { put(t, 'removed', rename); if (tick()) yield n / total; }
  for (const e of r.removed) { if (piecewise(e, removedA)) put(e, 'removed'); if (tick()) yield n / total; }
  for (const t of addedB) { put(t, 'added'); if (tick()) yield n / total; }
  for (const e of r.added) { if (piecewise(e, addedB)) put(e, 'added'); if (tick()) yield n / total; }
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
