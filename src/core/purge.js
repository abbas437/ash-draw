// ASH Draw Studio - PURGE: unused named items (blocks, layers, linetypes, text styles, dimension styles) and
// zero-length geometry / empty text. Pure ES module (no DOM).
//
// "Used" is counted over model space, every layout (paper space, viewport frozen-layer lists) and EVERY block
// definition, used or not: as in AutoCAD, an item referenced only from an unused block stays until that block is
// purged; "Purge nested items" repeats the purge so it goes too. A layer frozen in a viewport (VP freeze list) is
// kept, as AutoCAD keeps it: the viewport references it.
// Never purged: layer 0, Defpoints, the current layer, Standard text/dimension styles, the current dimension style,
// Continuous/ByLayer/ByBlock, layout blocks, xrefs and xref-dependent items (names with "|").
// Multileader and multiline styles are not listed: the model keeps them only as read-time defaults (no named table).

export const KINDS = ['Blocks', 'Layers', 'Linetypes', 'Text styles', 'Dimension styles'];
const U = (s) => String(s ?? '').toUpperCase();

/** every entity list of the drawing: model, layouts, block definitions (with the INSERTs' attributes) */
function* allEntities(doc) {
  const lists = [doc.entities, ...(doc.layouts ?? []).map((l) => l.entities ?? []), ...[...doc.blocks.values()].map((b) => b.entities ?? [])];
  for (const list of lists) for (const e of list) { yield e; for (const a of e.attribs ?? []) yield a; }
}

/** names referenced in the drawing, upper-cased, per kind */
export function usage(doc) {
  const u = { Blocks: new Set(), Layers: new Set(), Linetypes: new Set(), 'Text styles': new Set(), 'Dimension styles': new Set() };
  for (const e of allEntities(doc)) {
    u.Layers.add(U(e.layer ?? '0'));
    if (e.linetype) u.Linetypes.add(U(e.linetype));
    if ((e.type === 'INSERT' || e.type === 'DIMENSION') && e.block) u.Blocks.add(U(e.block));
    if (e.type === 'TEXT' || e.type === 'MTEXT') u['Text styles'].add(U(e.style ?? 'STANDARD'));
    if ((e.type === 'DIMENSION' || e.type === 'LEADER') && e.style) u['Dimension styles'].add(U(e.style));
    if (e.type === 'VIEWPORT') for (const n of e.frozen ?? []) u.Layers.add(U(n));
  }
  for (const l of doc.layers.values()) u.Linetypes.add(U(l.linetype));
  if (doc.header?.currentDimStyle) u['Dimension styles'].add(U(doc.header.currentDimStyle));
  for (const st of doc.dimStyles?.values() ?? []) {
    if (st.DIMTXSTY) u['Text styles'].add(U(st.DIMTXSTY));
    for (const k of ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK']) if (st[k]) u.Blocks.add(U(st[k]));
    for (const k of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2']) if (st[k]) u.Linetypes.add(U(st[k]));
  }
  return u;
}

/** dimension style names: the parsed styles and the names read from the table */
export const dimStyleNames = (doc) => {
  const out = new Map();
  for (const n of [...(doc.header?.dimStyles ?? []), ...(doc.dimStyles?.keys() ?? [])]) if (!out.has(U(n))) out.set(U(n), n);
  return [...out.values()];
};

/** names that may never be purged */
function protectedName(doc, kind, name, currentLayer) {
  const n = U(name);
  if (n.includes('|')) return true; // xref-dependent
  if (kind === 'Layers') return n === '0' || n === 'DEFPOINTS' || n === U(currentLayer) || !!doc.layers.get(name)?.xrefDep;
  if (kind === 'Linetypes') return n === 'CONTINUOUS' || n === 'BYLAYER' || n === 'BYBLOCK';
  if (kind === 'Text styles') return n === 'STANDARD';
  if (kind === 'Dimension styles') return n === 'STANDARD' || n === U(doc.header?.currentDimStyle);
  if (kind === 'Blocks') { const b = doc.blocks.get(name); return /^[*$](MODEL|PAPER)_SPACE/.test(n) || !!b?.xref || !!b?.xrefDep; }
  return false;
}

const namesOf = (doc, kind) => (kind === 'Blocks' ? [...doc.blocks.keys()] : kind === 'Layers' ? [...doc.layers.keys()]
  : kind === 'Linetypes' ? [...doc.linetypes.keys()] : kind === 'Text styles' ? [...doc.textStyles.keys()] : dimStyleNames(doc));

/** unused, purgeable items: { kind: [names] } (sorted) */
export function purgeable(doc, { currentLayer = '0' } = {}) {
  const u = usage(doc), out = {};
  for (const k of KINDS) out[k] = namesOf(doc, k).filter((n) => !u[k].has(U(n)) && !protectedName(doc, k, n, currentLayer)).sort((a, b) => a.localeCompare(b));
  return out;
}

/** a light copy of the named tables (entity lists shared) for simulating a purge */
function shadow(doc) {
  return { ...doc, layers: new Map(doc.layers), linetypes: new Map(doc.linetypes), textStyles: new Map(doc.textStyles), blocks: new Map(doc.blocks),
    dimStyles: new Map(doc.dimStyles ?? []), header: { ...doc.header, dimStyles: [...(doc.header?.dimStyles ?? [])] } };
}
function drop(d, kind, name) {
  if (kind === 'Blocks') d.blocks.delete(name);
  else if (kind === 'Layers') d.layers.delete(name);
  else if (kind === 'Linetypes') d.linetypes.delete(name);
  else if (kind === 'Text styles') d.textStyles.delete(name);
  else { for (const k of [...d.dimStyles.keys()]) if (U(k) === U(name)) d.dimStyles.delete(k); d.header.dimStyles = d.header.dimStyles.filter((n) => U(n) !== U(name)); }
}

/** what a purge removes: [{ kind, name }]. pick: { kind: [names] } (checked items) or 'all'.
 *  nested: repeat until nothing more becomes unused (with 'all', everything; with picked items, only what they freed). */
export function planPurge(doc, { pick = 'all', nested = false, currentLayer = '0' } = {}) {
  const d = shadow(doc), plan = [];
  const first = purgeable(d, { currentLayer });
  const before = new Set(KINDS.flatMap((k) => first[k].map((n) => `${k}\u0001${n}`)));
  let take = pick === 'all' ? first : Object.fromEntries(KINDS.map((k) => [k, (pick[k] ?? []).filter((n) => first[k].includes(n))]));
  for (;;) {
    const items = KINDS.flatMap((k) => (take[k] ?? []).map((name) => ({ kind: k, name })));
    if (!items.length) break;
    for (const it of items) { drop(d, it.kind, it.name); plan.push(it); }
    if (!nested) break;
    const next = purgeable(d, { currentLayer });
    take = pick === 'all' ? next : Object.fromEntries(KINDS.map((k) => [k, next[k].filter((n) => !before.has(`${k}\u0001${n}`))]));
  }
  return plan;
}

/** zero-length geometry and empty text in an entity list */
const MT_CODES = /\\[PpNn~]|\\[A-Za-z][^;\\{}]*;|[{}]/g;
export function isZeroOrEmpty(e) {
  const same = (a, b) => Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12;
  switch (e.type) {
    case 'LINE': return same(e.p1, e.p2);
    case 'LWPOLYLINE': return e.vertices.every((v) => same(v, e.vertices[0]));
    case 'CIRCLE': case 'ARC': return !(e.r > 0);
    case 'TEXT': return !e.attdef && !String(e.text ?? '').trim();
    case 'MTEXT': return !String(e.text ?? '').replace(MT_CODES, '').trim();
    default: return false;
  }
}
/** owners of entity lists with zero-length / empty objects: [{ owner, entities: filtered list, removed: n }] */
export function zeroLengthCleanup(doc) {
  const owners = [doc, ...(doc.layouts ?? []), ...[...doc.blocks.values()].filter((b) => !b.xref && !b.xrefDep)];
  const out = [];
  for (const o of owners) {
    const list = o.entities ?? [], kept = list.filter((e) => !isZeroOrEmpty(e));
    if (kept.length !== list.length) out.push({ owner: o, entities: kept, removed: list.length - kept.length });
  }
  return out;
}

/** apply a purge as ONE undo step on session s (root drawing doc). Returns { items: n, geometry: n }. */
export function applyPurge(s, doc, plan, { zeroLength = false } = {}) {
  const geo = zeroLength ? zeroLengthCleanup(doc) : [];
  let items = 0, geometry = 0;
  s.transact('Purge', (tx) => {
    for (const { kind, name } of plan) {
      items++;
      if (kind === 'Blocks') tx.set(doc.blocks, name, undefined);
      else if (kind === 'Layers') tx.set(doc.layers, name, undefined);
      else if (kind === 'Linetypes') tx.set(doc.linetypes, name, undefined);
      else if (kind === 'Text styles') tx.set(doc.textStyles, name, undefined);
      else {
        for (const k of [...(doc.dimStyles?.keys() ?? [])]) if (U(k) === U(name)) tx.set(doc.dimStyles, k, undefined);
        if (doc.header?.dimStyles?.some((n) => U(n) === U(name))) tx.set(doc.header, 'dimStyles', doc.header.dimStyles.filter((n) => U(n) !== U(name)));
      }
    }
    for (const g of geo) { tx.set(g.owner, 'entities', g.entities); geometry += g.removed; }
  });
  return { items, geometry };
}
