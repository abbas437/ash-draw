// ASH Draw Studio - symbol library: symbol files (DXF; DWG after conversion) -> block definitions, insertion as blocks.
// Pure ES module (no DOM). The panel (renderer/symbols-ui.js) and the folder listing (electron/symbols.js) sit on top.
//
//   const syms = symbolsFromDxf(text, 'Mech_Vent_AirTerminals_Ceiling_Return.dxf');  // [{ name, base, units, entities, blocks, paper }]
//   insertSymbol(session, syms[0], p, { rot, scale, values });                        // one undo step: block(s) + INSERT
//
// Base point: $INSBASE when the file sets one (the reader keeps only a non-zero $INSBASE); else the origin when the
// geometry surrounds it (symbol files drawn about 0,0 with the default $INSBASE 0,0); else the centre of the bounds.
// A file whose model space is empty but which defines blocks is a block library: each top-level block (one no other
// block references) becomes a symbol with its own base point.
import { parseDxf } from './dxfRead.js';
import { bboxOf, tessellate, boxOfPoints } from './geom.js';
import { instantiate, blockContentView, ATT_CONSTANT } from './blocks.js';
import { unitScale } from './clipboard.js';

export const MAX_SYMBOL_BYTES = 8 * 1024 * 1024;
export const MAX_SYMBOL_ENTITIES = 20000;
export const MAX_LIBRARY_SYMBOLS = 500;

const U = (s) => String(s ?? '').toUpperCase();
const findCI = (m, n) => { if (m.has(n)) return n; const u = U(n); for (const k of m.keys()) if (U(k) === u) return k; return null; };
const fail = (msg) => Object.assign(new Error(msg), { code: 'BAD_SYMBOL' });

/** "Mech_Vent_AirTerminals_Ceiling_Return.dxf" -> "Ceiling Return": four or more "_" parts drop the first three
 *  (discipline / system / category prefix); CamelCase and "-" split into words */
export function cleanSymbolName(file) {
  let parts = String(file ?? '').replace(/^.*[\\/]/, '').replace(/\.(dxf|dwg)$/i, '').split('_').filter(Boolean);
  if (parts.length >= 4) parts = parts.slice(3);
  const s = parts.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-\s]+/g, ' ').trim();
  return s || 'Symbol';
}

/** block names a set of entities reference, nested ones included (a Map of name -> definition copy) */
function referenced(doc, ents, out = new Map()) {
  for (const e of ents) {
    if (e.type !== 'INSERT' || !e.block) continue;
    const k = findCI(doc.blocks, e.block);
    if (!k || out.has(k)) continue;
    const b = doc.blocks.get(k);
    if (b.xref) continue;
    out.set(k, structuredClone(b));
    if (out.size > MAX_LIBRARY_SYMBOLS) throw fail('too many nested blocks');
    referenced(doc, b.entities ?? [], out);
  }
  return out;
}

function boundsOf(doc, ents) {
  let b = null;
  for (const e of ents) {
    let x; try { x = bboxOf(e, doc); } catch { x = null; }
    if (!x || ![x.minx, x.miny, x.maxx, x.maxy].every(Number.isFinite)) continue;
    b = b ? { minx: Math.min(b.minx, x.minx), miny: Math.min(b.miny, x.miny), maxx: Math.max(b.maxx, x.maxx), maxy: Math.max(b.maxy, x.maxy) } : { ...x };
  }
  return b;
}

/** base point for model-space geometry (see the header comment) */
export function symbolBase(doc, ents) {
  if (doc.header?.insbase) return { ...doc.header.insbase };
  const b = boundsOf(doc, ents);
  if (!b) return { x: 0, y: 0 };
  if (b.minx <= 0 && b.maxx >= 0 && b.miny <= 0 && b.maxy >= 0) return { x: 0, y: 0 };
  return { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2 };
}

/** symbols of a parsed drawing; `file` names the model-space symbol */
export function symbolsFromDoc(doc, file = 'Symbol.dxf') {
  const units = doc.units ?? 0;
  const ents = (doc.entities ?? []).filter((e) => e.type !== 'VIEWPORT');
  if (ents.length > MAX_SYMBOL_ENTITIES) throw fail(`more than ${MAX_SYMBOL_ENTITIES} objects`);
  if (ents.length) {
    const entities = ents.map((e) => { const c = structuredClone(e); c.id = 0; return c; });
    return [{ name: cleanSymbolName(file), base: symbolBase(doc, ents), units, entities, blocks: referenced(doc, ents), paper: false }];
  }
  const user = [...doc.blocks.keys()].filter((n) => !/^[*$]/.test(n) && !doc.blocks.get(n).xref);
  const inner = new Set();
  for (const n of user) for (const k of referenced(doc, doc.blocks.get(n).entities ?? []).keys()) inner.add(U(k));
  const top = user.filter((n) => !inner.has(U(n))).slice(0, MAX_LIBRARY_SYMBOLS);
  return top.map((n) => {
    const b = doc.blocks.get(n);
    const entities = (b.entities ?? []).map((e) => { const c = structuredClone(e); c.id = 0; return c; });
    return { name: n, base: { x: b.base?.x ?? 0, y: b.base?.y ?? 0 }, units, entities, blocks: referenced(doc, entities), paper: false };
  }).filter((s) => s.entities.length);
}

/** DXF text or bytes -> symbols; throws Error{code:'BAD_SYMBOL'} for an oversized, unreadable or empty file */
export function symbolsFromDxf(src, file = 'Symbol.dxf') {
  const size = typeof src === 'string' ? src.length : src?.byteLength ?? 0;
  if (!size) throw fail('empty file');
  if (size > MAX_SYMBOL_BYTES) throw fail('file too large for a symbol');
  const text = typeof src === 'string' ? src : new TextDecoder('utf-8').decode(src);
  let doc; try { doc = parseDxf(text); } catch (err) { throw fail(`unreadable DXF (${err.message})`); }
  const syms = symbolsFromDoc(doc, file);
  if (!syms.length) throw fail('no objects in the file');
  return syms;
}

/** thumbnail cache key: path + modification time + size (a changed file gets a new key) */
export function thumbKey(path, mtimeMs, size) {
  const s = `${String(path).toLowerCase()}|${Math.round(Number(mtimeMs) || 0)}|${Number(size) || 0}`;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** INSERT scale: symbol units -> drawing units, x the symbol scale; paper-size symbols also x the drawing scale 1:N */
export function symbolScale(sym, docUnits, { scale = 1, drawingScale = 1 } = {}) {
  return unitScale(sym.units ?? 0, docUnits ?? 0) * (Number(scale) || 1) * (sym.paper ? Number(drawingScale) || 1 : 1);
}

/** polylines of a symbol in its own coordinates (attribute definitions drawn as their tags) */
export function symbolPolylines(sym, tol = 0) {
  const doc = { blocks: sym.blocks ?? new Map(), layers: new Map(), linetypes: new Map(), textStyles: new Map(), header: {} };
  const pls = [];
  for (const be of sym.entities) {
    const v = blockContentView(be.attdef ? { ...be, attdef: { ...be.attdef, flags: ATT_CONSTANT, default: be.attdef.tag } } : be);
    if (v) try { pls.push(...tessellate(v, doc, tol)); } catch { /* not drawable: skipped */ }
  }
  return pls;
}

/** draw a symbol fitted into a w x h 2D context (thumbnail); false when it has nothing drawable */
export function drawSymbolThumb(c, sym, w, h, ink = '#000') {
  c.clearRect(0, 0, w, h);
  const pls = symbolPolylines(sym);
  const b = boxOfPoints(pls.flat());
  if (!b) return false;
  const bw = Math.max(b.maxx - b.minx, 1e-9), bh = Math.max(b.maxy - b.miny, 1e-9);
  const k = Math.min((w - 8) / bw, (h - 8) / bh);
  const ox = (w - bw * k) / 2, oy = (h - bh * k) / 2;
  c.strokeStyle = ink; c.lineWidth = 1;
  for (const pl of pls) {
    c.beginPath();
    pl.forEach((q, i) => { const x = ox + (q.x - b.minx) * k, y = h - (oy + (q.y - b.miny) * k); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.stroke();
  }
  return true;
}

const sameDef = (a, b) => JSON.stringify([a.base, a.entities]) === JSON.stringify([b.base, b.entities]);
/** the name to define `def` under: `name` when free or holding an identical definition, else the first free "name (2)"… */
function blockNameFor(doc, name, def) {
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${name} (${i})`;
    const k = findCI(doc.blocks, n);
    if (!k) return { name: n, reuse: false };
    if (sameDef(doc.blocks.get(k), def)) return { name: k, reuse: true };
  }
}
const safeName = (n) => String(n).replace(/[<>/\\":;?*|,=`]/g, '-').slice(0, 200).trim() || 'Symbol';

/** Insert a symbol at p as one undo step: its block definition (and nested ones) plus an INSERT.
 *  o: { rot (degrees), scale (overall INSERT scale), values: { TAG: value }, layer, color… entity props }.
 *  Block name = symbol name; an existing block of that name is reused when its definition is identical, else the
 *  symbol is defined as "<name> (2)", "(3)"… Returns { insert, block }. */
export function insertSymbol(s, sym, p, o = {}) {
  const doc = s.doc;
  const { rot = 0, scale = 1, values = {}, ...props } = o;
  return s.transact('Insert symbol', (tx) => {
    const names = new Map();
    const rename = (e) => { if (e.block && names.has(U(e.block))) e.block = names.get(U(e.block)); return e; };
    const define = (name, blk) => {
      const def = { base: { x: blk.base?.x ?? 0, y: blk.base?.y ?? 0 }, entities: (blk.entities ?? []).map((e) => rename(structuredClone(e))) };
      const r = blockNameFor(doc, safeName(name), def);
      if (!r.reuse) tx.block(r.name, { name: r.name, ...def });
      return r.name;
    };
    // nested blocks first, deepest last-referenced order does not matter: references are renamed after all are named
    const nested = [...(sym.blocks ?? new Map()).entries()];
    for (const [n] of nested) names.set(U(n), n);
    for (const [n, b] of nested.reverse()) names.set(U(n), define(n, b));
    const name = define(sym.name, sym);
    const blk = doc.blocks.get(name);
    const ins = instantiate(blk, p, { ...props, sx: scale, sy: scale, rot, values });
    return { insert: tx.add(ins), block: name };
  });
}
