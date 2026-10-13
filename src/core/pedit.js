// ASH Draw Studio - PEDIT, REVERSE and BREAKATPOINT as pure geometry (no DOM, no session).
// Behaviour follows AutoCAD LT. Like modify.js, every operation returns an EDIT SET
//   { add: [...], remove: [ids], change: [...] }  (apply with applyEditSet from edit.js)
// and a changed entity keeps its id, layer, colour, linetype, lineweight, transparency and xdata (it is a copy).
// Per-vertex widths are the optional vertex fields `sw` (start width) and `ew` (end width); `width` is the
// polyline's constant width. Failures throw Error with code 'GEOMETRY' or 'UNSUPPORTED'.
import { DEG, dist, ccwSweep } from './geom.js';
import { breakAt } from './modify.js';

function fail(code, msg) { const err = new Error(msg); err.code = code; return err; }
function clone(e) { const c = structuredClone(e); delete c.parent; return c; }
const editSet = () => ({ add: [], remove: [], change: [] });
const polar = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
const isPoly = (e) => e?.type === 'LWPOLYLINE';
const changed = (ne) => { const s = editSet(); s.change.push(ne); return s; };

/** Vertices of a LINE / ARC / LWPOLYLINE as polyline vertices (copies). */
function vertsOf(e) {
  if (e.type === 'LINE') return [{ x: e.p1.x, y: e.p1.y, bulge: 0 }, { x: e.p2.x, y: e.p2.y, bulge: 0 }];
  if (e.type === 'ARC') {
    const a0 = e.a0 * DEG, sw = ccwSweep(a0, e.a1 * DEG);
    return [{ ...polar(e.c, e.r, a0), bulge: Math.tan(sw / 4) }, { ...polar(e.c, e.r, a0 + sw), bulge: 0 }];
  }
  if (isPoly(e)) return e.vertices.map((v) => ({ ...v, bulge: v.bulge || 0 }));
  throw fail('UNSUPPORTED', `${e.type} is not a line, arc or polyline`);
}

/** LINE or ARC -> LWPOLYLINE with the same id and properties (PEDIT "turn it into one? <Y>"). */
export function toPolylineEntity(e) {
  if (e.type !== 'LINE' && e.type !== 'ARC') throw fail('UNSUPPORTED', `${e.type} cannot be turned into a polyline`);
  const c = clone(e);
  for (const k of ['p1', 'p2', 'c', 'r', 'a0', 'a1']) delete c[k];
  return { ...c, type: 'LWPOLYLINE', vertices: vertsOf(e), closed: false };
}
export function toPolyline(e) { return changed(toPolylineEntity(e)); }

function needPoly(e) { if (!isPoly(e)) throw fail('UNSUPPORTED', 'not a polyline'); }

/** Close / Open. */
export function setClosed(e, closed) {
  needPoly(e);
  if (closed && e.vertices.length < 2) throw fail('GEOMETRY', 'a polyline needs two vertices to close');
  return changed({ ...clone(e), closed: !!closed });
}

/** Width: one uniform width for every segment (per-vertex widths are replaced). */
export function setWidth(e, w) {
  needPoly(e);
  if (!(w >= 0)) throw fail('GEOMETRY', 'width must be 0 or more');
  const c = clone(e);
  c.vertices = c.vertices.map(({ sw, ew, ...v }) => v);
  if (w > 0) c.width = w; else delete c.width;
  return changed(c);
}

/** Decurve: every arc segment becomes straight. */
export function decurve(e) {
  needPoly(e);
  const c = clone(e);
  c.vertices = c.vertices.map((v) => ({ ...v, bulge: 0 }));
  return changed(c);
}

/** Vertices in reverse order. New segment k runs over the old segment (n-2-k) mod n backwards, so it takes that
 *  segment's bulge negated and its start / end widths swapped. Works for open and closed polylines. */
export function reverseVertices(v, closed = false) {
  const n = v.length;
  return v.map((_, k) => {
    const out = { ...v[n - 1 - k] };
    delete out.sw; delete out.ew;
    const j = k < n - 1 ? n - 2 - k : closed ? n - 1 : -1; // the old segment the new segment k runs over
    const s = j >= 0 ? v[j] : null;
    out.bulge = s ? -(s.bulge || 0) || 0 : 0;
    if (s && s.ew !== undefined) out.sw = s.ew;
    if (s && s.sw !== undefined) out.ew = s.sw;
    return out;
  });
}

/** REVERSE one entity: the shape is unchanged, its direction is reversed. */
export function reverseEntity(e) {
  const c = clone(e);
  if (e.type === 'LINE') { c.p1 = { ...e.p2 }; c.p2 = { ...e.p1 }; return c; }
  // An ARC is always stored counter-clockwise from a0 to a1, so its geometry (and its stored form) stays as it is.
  if (e.type === 'ARC') return c;
  if (isPoly(e)) { c.vertices = reverseVertices(e.vertices, e.closed); return c; }
  if (e.type === 'SPLINE') {
    if (c.ctrl?.length) {
      c.ctrl = [...e.ctrl].reverse();
      if (e.weights?.length) c.weights = [...e.weights].reverse();
      if (e.knots?.length) { const a = e.knots[0], b = e.knots[e.knots.length - 1]; c.knots = e.knots.map((t) => a + b - t).reverse(); }
    }
    if (c.fit?.length) c.fit = [...e.fit].reverse();
    return c;
  }
  throw fail('UNSUPPORTED', `reverse of ${e.type}`);
}
export function reverse(ents) {
  const out = editSet();
  out.failed = [];
  for (const e of ents) { try { out.change.push(reverseEntity(e)); } catch (err) { if (!err.code) throw err; out.failed.push({ id: e.id, reason: err.message }); } }
  return out;
}

/** Join tolerance: the fuzz distance, at least 1e-9 x the extents of the involved objects. */
const fuzzOf = (fuzz) => Math.max(fuzz || 0, 1e-9);

/** PEDIT Join: LINEs, ARCs and open LWPOLYLINEs whose ends touch the open polyline `pl` (within `fuzz`) are added
 *  to it, end to end, in whichever direction fits; repeated until nothing more connects. The joined objects are
 *  removed; `pl` keeps its id and properties. Returns the edit set with `joined` = number of objects added. */
export function joinToPolyline(pl, ents, { fuzz = 0 } = {}) {
  needPoly(pl);
  if (pl.closed) throw fail('GEOMETRY', 'cannot join to a closed polyline');
  const T = fuzzOf(fuzz);
  const items = ents.filter((e) => e && e.id !== pl.id && (e.type === 'LINE' || e.type === 'ARC' || (isPoly(e) && !e.closed)))
    .map((e) => ({ e, v: vertsOf(e) }));
  let chain = vertsOf(pl);
  const used = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const it of items) {
      if (used.includes(it)) continue;
      const head = chain[0], tail = chain[chain.length - 1];
      const s = it.v[0], t = it.v[it.v.length - 1];
      let v = null, atEnd = true;
      if (dist(tail, s) <= T) v = it.v;
      else if (dist(tail, t) <= T) v = reverseVertices(it.v);
      else if (dist(head, t) <= T) { v = it.v; atEnd = false; } else if (dist(head, s) <= T) { v = reverseVertices(it.v); atEnd = false; }
      if (!v) continue;
      if (atEnd) chain = [...chain.slice(0, -1), { ...v[0], x: tail.x, y: tail.y }, ...v.slice(1)];
      else chain = [...v.slice(0, -1), { ...head }, ...chain.slice(1)];
      used.push(it); grew = true;
    }
  }
  const out = changed({ ...clone(pl), vertices: chain });
  out.remove = used.map((u) => u.e.id);
  out.joined = used.length;
  return out;
}

/** PEDIT Multiple + Join: lines and arcs among `ents` are turned into polylines, then each open polyline gathers
 *  the touching pieces. Returns one edit set (joined = objects merged away). */
export function joinMany(ents, { fuzz = 0 } = {}) {
  const cur = new Map(ents.filter((e) => e.type === 'LINE' || e.type === 'ARC' || (isPoly(e) && !e.closed))
    .map((e) => [e.id, isPoly(e) ? e : toPolylineEntity(e)]));
  const out = editSet();
  out.joined = 0;
  for (const id of [...cur.keys()]) {
    const pl = cur.get(id);
    if (!pl) continue; // already joined into another
    const r = joinToPolyline(pl, [...cur.values()], { fuzz });
    for (const g of r.remove) cur.delete(g);
    cur.set(id, r.change[0]);
    out.joined += r.joined;
    out.remove.push(...r.remove);
  }
  out.change = [...cur.values()].filter((e) => e !== ents.find((x) => x.id === e.id));
  return out;
}

/** BREAKATPOINT: one object split in two at `p`. Closed objects cannot be broken at a single point. */
export function breakAtPoint(e, p) {
  if (e.type === 'CIRCLE') throw fail('GEOMETRY', 'Arc cannot be full 360 degrees.');
  if (e.type === 'ELLIPSE' && Math.abs((e.a1 ?? 2 * Math.PI) - (e.a0 ?? 0)) >= 2 * Math.PI - 1e-9) throw fail('GEOMETRY', 'Arc cannot be full 360 degrees.');
  if ((isPoly(e) || e.type === 'SPLINE') && e.closed) throw fail('GEOMETRY', 'Cannot break a closed object at a single point.');
  return breakAt(e, p);
}

/** Merge the session's top `n` undo steps into one step called `label` (PEDIT is one undo step however many
 *  options were used). Returns true when merged. */
export function mergeTopSteps(session, n, label) {
  if (n < 2 || session.undoStack.length < n) return false;
  const steps = session.undoStack.splice(session.undoStack.length - n, n);
  session.undoStack.push({ id: ++session.stepSeq, label, ops: steps.flatMap((s) => s.ops), doc: steps[0].doc });
  return true;
}
