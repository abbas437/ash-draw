// ASH Draw Studio - clipboard between windows and applications: the selection as a self-contained DXF fragment.
// Pure ES module (no DOM).
//
//   const text = fragmentDxf(doc, ids, base);           // COPYCLIP / COPYBASE: DXF text for the system clipboard
//   const frag = readFragment(text);                    // null when the text is not a DXF
//   pasteFragment(s, frag, { at, orig, asBlock });      // PASTECLIP / PASTEORIG / PASTEBLOCK, one undo step
import { newDocument, getEntity } from './model.js';
import { writeDxf } from './dxfWrite.js';
import { parseDxf } from './dxfRead.js';
import { transformEntity } from './geom.js';
import { transformDimension } from './dims.js';

/** the custom clipboard format the Electron host stores the fragment under (the only one it accepts) */
export const CLIP_FORMAT = 'application/x-ash-dxf';

const U = (s) => String(s ?? '').toUpperCase();
const findCI = (m, name) => { if (m.has(name)) return name; const u = U(name); for (const k of m.keys()) if (U(k) === u) return k; return null; };

/** millimetres per drawing unit for $INSUNITS codes; 0 (unitless) and unknown codes have none */
const MM = { 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 25.4e-6, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100, 15: 1e4, 16: 1e5, 17: 1e12, 18: 1.495978707e14, 19: 9.4607304725808e18, 20: 3.0856776e19 };
/** scale from fragment units to target units (1 when either is unitless or unknown) */
export const unitScale = (from, to) => (MM[from] && MM[to] ? MM[from] / MM[to] : 1);

/** Build the fragment drawing: the entities `ids` of `doc` plus the layers, linetypes, text styles, dimension styles
 *  and block definitions they reference (nested blocks included); nothing else. `base` (COPYBASE) is kept as $INSBASE. */
export function buildFragment(doc, ids, base = null) {
  const f = newDocument();
  f.units = doc.units ?? 0;
  if (doc.header?.ltscale) f.header.ltscale = doc.header.ltscale;
  if (base) f.header.insbase = { x: base.x, y: base.y };
  const layers = new Set(['0']), lts = new Set(), styles = new Set(), dims = new Set(), blocks = new Set();
  const visit = (e) => {
    layers.add(e.layer || '0');
    if (e.linetype && !/^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(e.linetype)) lts.add(U(e.linetype));
    if ((e.type === 'TEXT' || e.type === 'MTEXT') && e.style) styles.add(U(e.style));
    if (e.type === 'DIMENSION' && e.style) dims.add(e.style);
    if ((e.type === 'INSERT' || e.type === 'DIMENSION') && e.block && !blocks.has(e.block)) {
      const bn = findCI(doc.blocks, e.block);
      if (bn) { blocks.add(bn); for (const be of doc.blocks.get(bn).entities ?? []) visit(be); }
    }
    for (const a of e.attribs ?? []) visit(a);
  };
  for (const id of ids) {
    const e = getEntity(doc, id);
    if (!e) continue;
    visit(e);
    const c = structuredClone(e); c.id = 0;
    f.entities.push(c); c.id = f.nextId++;
  }
  for (const n of dims) {
    const k = doc.dimStyles ? findCI(doc.dimStyles, n) : null;
    if (!k) continue;
    const st = doc.dimStyles.get(k);
    (f.dimStyles ??= new Map()).set(k, structuredClone(st));
    if (st.DIMTXSTY) styles.add(U(st.DIMTXSTY));
    if (st.DIMBLK) { const bn = findCI(doc.blocks, st.DIMBLK); if (bn) blocks.add(bn); }
  }
  for (const n of blocks) f.blocks.set(n, structuredClone(doc.blocks.get(n)));
  for (const n of layers) {
    const k = findCI(doc.layers, n);
    if (!k) continue;
    const l = doc.layers.get(k);
    f.layers.set(k, structuredClone(l));
    if (l.linetype && !/^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(l.linetype)) lts.add(U(l.linetype));
  }
  for (const n of lts) { const k = findCI(doc.linetypes, n); if (k) f.linetypes.set(k, structuredClone(doc.linetypes.get(k))); }
  for (const n of styles) { const k = findCI(doc.textStyles, n); if (k) f.textStyles.set(k, structuredClone(doc.textStyles.get(k))); }
  return f;
}

/** COPYCLIP / COPYBASE: the selection as DXF text (the existing writer on the fragment drawing) */
export const fragmentDxf = (doc, ids, base = null) => writeDxf(buildFragment(doc, ids, base));

/** the clipboard text as a fragment drawing, or null when it is not DXF (or holds no entities) */
export function readFragment(text) {
  const t = String(text ?? '').replace(/^﻿/, '').trimStart();
  if (!/^(0\s*\r?\n\s*SECTION|999\s*\r?\n)/.test(t)) return null;
  try { const f = parseDxf(t); return f.entities.length ? f : null; } catch { return null; }
}

/** the first free name "<name>$0", "$1"… (case-insensitive against `taken`) */
function freeName(name, taken) {
  for (let i = 0; ; i++) { const n = `${name}$${i}`; if (!findCI(taken, n)) return n; }
}

/** Merge fragment drawing `frag` into the session's drawing as one undo step.
 *  at: insertion point for the fragment's base point ($INSBASE, else 0,0); orig: keep coordinates (PASTEORIG);
 *  asBlock: insert everything as one new block (PASTEBLOCK). Layers, linetypes, text and dimension styles the target
 *  already has keep the target's definition; clashing block names become "<name>$0", "$1"…; fragment units are scaled
 *  to the target's ($INSUNITS). Returns { entities, scale, renamed: [[from, to]], block }. */
export function pasteFragment(s, frag, { at = null, orig = false, asBlock = false } = {}) {
  const doc = s.doc;
  const k = unitScale(frag.units ?? 0, doc.units ?? 0);
  const base = frag.header?.insbase ?? { x: 0, y: 0 };
  const to = orig || !at ? { x: base.x * k, y: base.y * k } : at;
  const m = [k, 0, 0, k, to.x - k * base.x, to.y - k * base.y];
  const renamed = [];
  return s.transact(asBlock ? 'Paste as Block' : 'Paste', (tx) => {
    for (const [n, l] of frag.layers) if (!findCI(doc.layers, n)) tx.layer(n, structuredClone(l));
    for (const [n, lt] of frag.linetypes) if (!findCI(doc.linetypes, n)) tx.set(doc.linetypes, n, structuredClone(lt));
    for (const [n, st] of frag.textStyles) if (!findCI(doc.textStyles, n)) tx.set(doc.textStyles, n, structuredClone(st));
    for (const [n, st] of frag.dimStyles ?? []) if (!doc.dimStyles || !findCI(doc.dimStyles, n)) tx.dimStyle(n, structuredClone(st));
    // block names: a clash gets the first free "<name>$i"; references inside the fragment follow
    const names = new Map();
    const taken = new Map([...doc.blocks.keys(), ...frag.blocks.keys()].map((n) => [n, true]));
    for (const n of frag.blocks.keys()) {
      if (!findCI(doc.blocks, n)) { names.set(n, n); continue; }
      const nn = freeName(n, taken); taken.set(nn, true); names.set(n, nn); renamed.push([n, nn]);
    }
    const rename = (e) => { if (e.block && names.has(e.block)) e.block = names.get(e.block); return e; };
    for (const [n, b] of frag.blocks) {
      const nb = structuredClone(b); nb.name = names.get(n);
      nb.entities = (nb.entities ?? []).map(rename);
      tx.block(nb.name, nb);
    }
    // entities: units scale and placement (block contents stay in block units; the INSERT scale carries the units)
    const placed = [];
    for (const e of frag.entities) {
      const c = rename(structuredClone(e)); c.id = 0;
      try { placed.push(k === 1 && !m[4] && !m[5] ? c : (c.type === 'DIMENSION' && c.def ? transformDimension(doc, c, m) : transformEntity(c, m))); } catch { /* not transformable: skipped */ }
    }
    for (const c of placed) c.id = 0;
    if (!asBlock) return { entities: placed.map((c) => tx.add(c)), scale: k, renamed, block: null };
    const bname = freeName('A$C', taken);
    tx.block(bname, { name: bname, base: { x: to.x, y: to.y }, entities: placed });
    const ins = tx.add({ id: 0, type: 'INSERT', layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, block: bname, p: { x: to.x, y: to.y }, sx: 1, sy: 1, rot: 0, cols: 1, rows: 1, colSp: 0, rowSp: 0 });
    return { entities: [ins], scale: k, renamed, block: bname };
  });
}
