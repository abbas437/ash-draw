// ASH Draw Studio - symbol count schedule (SYMCOUNT / BCOUNT): how many times each block (symbol) is inserted.
// Pure ES module (no DOM). The dialog, export and the schedule placed in the drawing are in renderer/symcount-ui.js.
//
//   const { rows, total } = countSymbols(doc, { entities, nested, space });  // rows: [{ name, count, layers }]
//   symcountCsv(rows);                                                       // Symbol,Count,Layers
//
// Skipped: anonymous / internal blocks (*D dimensions, *U, *X hatches…), external references and their dependent
// blocks. An array insert (MINSERT rows x cols) counts rows x cols.

const U = (s) => String(s ?? '').toUpperCase();
const findCI = (m, n) => { if (m.has(n)) return n; const u = U(n); for (const k of m.keys()) if (U(k) === u) return k; return null; };
/** cells of an INSERT: rows x cols of a MINSERT, else 1 */
const cellsOf = (e) => Math.max(1, Math.trunc(e.rows ?? 1) || 1) * Math.max(1, Math.trunc(e.cols ?? 1) || 1);
/** the block definition an INSERT refers to, or null when it is not a countable symbol */
function symbolBlock(doc, e) {
  if (e?.type !== 'INSERT' || !e.block || /^\*/.test(e.block)) return null;
  const k = findCI(doc.blocks ?? new Map(), e.block);
  const b = k == null ? null : doc.blocks.get(k);
  if (b && (b.xref || b.xrefDep)) return null;
  return { name: k ?? e.block, block: b };
}

/** entities of a space: 'model' (default) or a layout name */
export function spaceEntities(doc, space = 'model') {
  if (!space || U(space) === 'MODEL') return doc.entities ?? [];
  return (doc.layouts ?? []).find((l) => U(l.name) === U(space))?.entities ?? [];
}

/** count the symbols of `entities` (the selection) or of `space`; nested: also the inserts inside the counted blocks'
 *  definitions, recursively, times the parent's count (a block that contains itself is not followed again).
 *  Returns { rows: [{ name, count, layers }] sorted by name, total }. */
export function countSymbols(doc, { entities = null, nested = false, space = 'model' } = {}) {
  const by = new Map();
  const add = (name, n, layer) => {
    let r = by.get(U(name));
    if (!r) by.set(U(name), (r = { name, count: 0, layers: new Set() }));
    r.count += n;
    if (layer != null) r.layers.add(String(layer));
  };
  const walk = (list, mult, path) => {
    for (const e of list) {
      const s = symbolBlock(doc, e);
      if (!s) continue;
      const n = cellsOf(e) * mult;
      add(s.name, n, e.layer ?? '0');
      if (nested && s.block && !path.has(U(s.name))) walk(s.block.entities ?? [], n, new Set(path).add(U(s.name)));
    }
  };
  walk(entities ?? spaceEntities(doc, space), 1, new Set());
  const rows = [...by.values()].map((r) => ({ name: r.name, count: r.count, layers: [...r.layers].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { rows, total: rows.reduce((t, r) => t + r.count, 0) };
}

/** the count as CSV (RFC 4180 quoting, like markupsCsv); layers joined by "; " */
export function symcountCsv(rows) {
  const q = (v) => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return ['Symbol,Count,Layers', ...rows.map((r) => [r.name, r.count, r.layers.join('; ')].map(q).join(','))].join('\r\n') + '\r\n';
}

/** the sheet of the .xlsx: title row (drawing, date), header, one row per symbol, total */
export function symcountSheet(rows, total, title) {
  return { name: 'Symbol count', colWidths: [36, 10, 36], boldRows: [0, 1],
    rows: [[title], ['Symbol', 'Count', 'Layers'], ...rows.map((r) => [r.name, r.count, r.layers.join('; ')]), ['Total', total]] };
}
