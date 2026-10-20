// The change list of a compare result, for the CRS: one row per changed object, with the number of its group (the
// numbered dotted rectangle on the sheet and the row of the panel list). Columns: Group, Change (added / removed /
// changed), Layer, Object type, X, Y (centre of the object's box, drawing units, 3 decimals; B's version when changed,
// A's when removed; blank when it has no finite box) and Details (text old -> new, how far a changed object moved, the
// property names of a property-only change). Out as tab-separated text (Copy list) or CSV (src/core/csv.js).
import { bboxOf } from './geom.js';
import { csvText } from './csv.js';

export const CHANGE_LIST_HEADER = ['Group', 'Change', 'Layer', 'Object type', 'X', 'Y', 'Details'];

const n3 = (v) => +v.toFixed(3) + 0; // 3 decimals as a number (no -0)
const centre = (e, doc) => {
  const b = bboxOf(e, doc);
  if (!b || !Number.isFinite(b.minx + b.maxx + b.miny + b.maxy)) return null;
  return { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2 };
};
const textOf = (e) => (e.type === 'TEXT' || e.type === 'MTEXT') ? String(e.text ?? '') : null;

function details(kind, ref, ca, cb) {
  if (kind !== 'changed') {
    const e = ref, t = textOf(e);
    return t != null ? `text "${t}"` : e.type === 'INSERT' && e.block ? `block ${e.block}` : '';
  }
  const parts = [];
  if (ref.why === 'props') parts.push(`properties: ${(ref.props ?? []).join(', ')}`);
  else if (ref.why === 'layer hidden') parts.push('layer hidden on one side');
  else if (ref.why === 'moved with group') parts.push('moved with its group');
  const ta = textOf(ref.a), tb = textOf(ref.b);
  if (ta != null && tb != null && ta !== tb) parts.push(`text "${ta}" → "${tb}"`);
  if (ref.a.type === 'INSERT' && ref.b.type === 'INSERT' && ref.a.block !== ref.b.block) parts.push(`block ${ref.a.block} → ${ref.b.block}`);
  if (ref.why !== 'props' && ca && cb) {
    const dx = n3(cb.x - ca.x), dy = n3(cb.y - ca.y);
    if (dx || dy) parts.push(`moved ${dx}, ${dy}`);
    else if (!parts.length) parts.push('shape changed');
  }
  if (ref.a.layer !== ref.b.layer && ref.why !== 'props') parts.push(`layer ${ref.a.layer} → ${ref.b.layer}`);
  return parts.join('; ');
}

/** the rows [Group, Change, Layer, Object type, X, Y, Details] of compare result `r` (A, B its documents), in the order
 *  of the group list; X, Y are numbers or '' */
export function compareChangeRows(a, b, r) {
  const rows = [];
  (r.clusters ?? []).forEach((c, gi) => {
    for (const { k, ref } of c.members ?? []) {
      const e = k === 'changed' ? ref.b : ref, doc = k === 'removed' ? a : b;
      const cb = centre(e, doc), ca = k === 'changed' ? centre(ref.a, a) : null;
      rows.push([gi + 1, k, e.layer ?? '', e.type, cb ? n3(cb.x) : '', cb ? n3(cb.y) : '', details(k, ref, ca, cb)]);
    }
  });
  return rows;
}

/** the list as tab-separated text with a header line (line ends \n; tabs and line breaks inside a cell become spaces) */
export function compareChangeTsv(rows) {
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return [CHANGE_LIST_HEADER, ...rows].map((r) => r.map(cell).join('\t')).join('\n') + '\n';
}

/** the list as CSV text for Excel (BOM, formula guard: src/core/csv.js) */
export function compareChangeCsv(rows) { return csvText(CHANGE_LIST_HEADER, rows); }

/** suggested file name: `<A>-vs-<B>-changes.csv` (the names without extension, made safe for a Windows file name) */
export function compareChangeFileName(nameA, nameB) {
  const safe = (n) => String(n ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'drawing';
  return `${safe(nameA)}-vs-${safe(nameB)}-changes.csv`;
}
