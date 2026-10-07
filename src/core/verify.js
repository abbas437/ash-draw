// ASH Draw Studio - compare two drawings (used to check a DWG save by reading the file back).
// compareDocuments(a, b) -> { ok, counts:{TYPE:[a,b]}, mismatched:{TYPE:n}, total }
//   ok = same entity counts and no geometry mismatches.
const PICK = {
  LINE: ['p1', 'p2'], CIRCLE: ['c', 'r'], ARC: ['c', 'r', 'a0', 'a1'], ELLIPSE: ['c', 'major', 'ratio'],
  LWPOLYLINE: ['vertices', 'closed'], POINT: ['p'], SOLID: ['pts'], SPLINE: ['ctrl', 'degree'],
  TEXT: ['p', 'height', 'text', 'rot', 'widthFactor', 'hAlign', 'vAlign'], MTEXT: ['p', 'height', 'text', 'rot', 'width'],
  INSERT: ['block', 'p', 'sx', 'sy', 'rot'], HATCH: ['loops', 'pattern'], LEADER: ['pts'],
};
const round = (v, d) => {
  if (typeof v === 'number') return Math.round(v * 10 ** d) / 10 ** d + 0;
  if (Array.isArray(v)) return v.map((x) => round(x, d));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = round(v[k], d); return o; }
  return v;
};
const sig = (e, d) => JSON.stringify(round((PICK[e.type] ?? []).map((k) => e[k]), d));

export function compareDocuments(a, b, digits = 5) {
  const group = (doc) => { const g = {}; for (const e of doc.entities) (g[e.type] ??= []).push(e); return g; };
  const ga = group(a), gb = group(b);
  const counts = {}, mismatched = {};
  let total = 0, countsOk = true;
  for (const t of new Set([...Object.keys(ga), ...Object.keys(gb)])) {
    const la = ga[t] ?? [], lb = gb[t] ?? [];
    counts[t] = [la.length, lb.length];
    if (la.length !== lb.length) countsOk = false;
    // match as multisets, so a different entity order does not count as a difference
    const pool = new Map();
    for (const e of lb) { const s = sig(e, digits); pool.set(s, (pool.get(s) ?? 0) + 1); }
    let bad = 0;
    for (const e of la) {
      const s = sig(e, digits);
      const n = pool.get(s);
      if (n) pool.set(s, n - 1); else bad++;
    }
    if (bad) { mismatched[t] = bad; total += bad; }
  }
  return { ok: countsOk && total === 0, counts, mismatched, total };
}
