// ASH Draw Studio - blocks and attributes (AutoCAD BLOCK / INSERT / ATTDEF / ATTRIB).
// Pure ES module (no DOM).
//
// Representation
//  - ATTDEF: a TEXT entity (text = the tag, shown like AutoCAD shows an attribute definition) carrying
//    `attdef: { tag, prompt, default, flags }`. Being a TEXT it moves, picks and renders like one in model space.
//  - ATTRIB: a TEXT entity carrying `attrib: { tag, flags }` (text = the value), held in its INSERT's `attribs`
//    array in the INSERT's own coordinate space (as in DXF), never in doc.entities.
//  - flags (DXF 70): 1 invisible, 2 constant, 4 verify, 8 preset.
import { makeText, makeInsert } from './model.js';
import { compose, translation, rotation, scaling, transformEntity, DEG } from './geom.js';

export const ATT_INVISIBLE = 1, ATT_CONSTANT = 2, ATT_VERIFY = 4, ATT_PRESET = 8;

// -- DXF read hooks -----------------------------------------------------------------------------
/** rec: an ATTDEF/ATTRIB record; e: the TEXT built from it. Adds the attribute data. */
export function buildAttribute(rec, e) {
  if (!e) return e;
  const vAlign = rec.int(74);
  e.vAlign = vAlign; // attributes keep the vertical alignment in 74 (73 is the field length)
  if (vAlign && !e.hAlign && rec.has(11)) e.p = { x: rec.num(11), y: rec.num(21) };
  const tag = rec.str(2), flags = rec.int(70);
  if (rec.type === 'ATTDEF') { e.attdef = { tag, prompt: rec.str(3), default: e.text, flags }; e.text = tag; } else e.attrib = { tag, flags };
  return e;
}

/** Attach the ATTRIB entities that followed an INSERT to it. */
export function linkAttribs(ins, attribs) {
  if (!ins || ins.type !== 'INSERT') return;
  ins.attribs = attribs.filter((a) => a && a.attrib).map((a) => { a.id = 0; return a; });
}

// -- queries ------------------------------------------------------------------------------------
export const attdefsOf = (blk) => (blk ? blk.entities.filter((e) => e.attdef) : []);

/** Blocks a user can INSERT: not anonymous (*D1, *U2 ...) and not layout blocks. */
export function insertableBlocks(doc) {
  return [...doc.blocks.keys()].filter((n) => !/^[*$]/.test(n)).sort((a, b) => a.localeCompare(b));
}

/** AutoCAD naming rules: 1-255 chars, none of <>/\":;?*|,=` and not already defined (case-insensitive).
 *  Returns an error message, or null when the name is valid. */
export function blockNameError(doc, name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Enter a block name.';
  if (n.length > 255) return 'Block names are limited to 255 characters.';
  if (/[<>/\\":;?*|,=`]/.test(n)) return 'Block names cannot contain < > / \\ " : ; ? * | , = `';
  const u = n.toUpperCase();
  for (const k of doc.blocks.keys()) if (k.toUpperCase() === u) return `A block named "${k}" already exists.`;
  return null;
}

/** The matrix that places block content for an INSERT (single cell). */
export function insertMatrix(ins, blk) {
  return compose(translation(ins.p.x, ins.p.y), compose(rotation((ins.rot || 0) * DEG),
    compose(scaling(ins.sx ?? 1, ins.sy ?? 1), translation(-blk.base.x, -blk.base.y))));
}

// -- commands (pure: they return new objects; edit.js / the tools apply them as one undo step) ---
/** BLOCK: definition from `ents` with base point `base`. Entities are copied and translated by -base, so the
 *  definition's base is the origin. Returns { block, insert }: insert places the block where the originals were
 *  (used for the "Convert to block" option), its attributes taking the definitions' defaults. */
export function makeBlock(doc, name, ents, base) {
  const err = blockNameError(doc, name);
  if (err) { const e = new Error(err); e.code = 'BAD_NAME'; throw e; }
  const m = translation(-base.x, -base.y);
  const entities = ents.map((e) => { const t = transformEntity(e, m); t.id = 0; return t; });
  const block = { name: String(name).trim(), base: { x: 0, y: 0 }, entities };
  const insert = instantiate(block, base, {});
  return { block, insert };
}

/** INSERT: an INSERT of `blk` at p. o: { sx, sy, rot, layer, values: { TAG: value } }. Non-constant ATTDEFs
 *  become ATTRIBs (value from o.values, else the default) placed through the insert transform. */
export function instantiate(blk, p, o = {}) {
  const ins = makeInsert(blk.name, p, { ...o, sx: o.sx ?? 1, sy: o.sy ?? o.sx ?? 1, rot: o.rot ?? 0 });
  delete ins.values;
  const defs = attdefsOf(blk).filter((d) => !(d.attdef.flags & ATT_CONSTANT));
  if (defs.length) {
    const m = insertMatrix(ins, blk);
    const values = o.values ?? {};
    ins.attribs = defs.map((d) => {
      const a = transformEntity(d, m);
      const { tag, flags } = d.attdef;
      delete a.attdef;
      a.id = 0;
      a.text = String(values[tag] ?? d.attdef.default ?? '');
      a.attrib = { tag, flags: flags & (ATT_INVISIBLE | ATT_PRESET) };
      return a;
    });
  }
  return ins;
}

/** A copy of the INSERT with attribute values replaced ({ TAG: value }); tags not given keep their value. */
export function withAttribValues(ins, values) {
  const c = structuredClone(ins);
  for (const a of c.attribs ?? []) if (Object.hasOwn(values, a.attrib.tag)) a.text = String(values[a.attrib.tag]);
  return c;
}

/** ATTDEF entity for model space (becomes part of a block when BLOCK includes it). */
export function makeAttdef(p, height, tag, o = {}) {
  const e = makeText(p, height, String(tag).toUpperCase(), o);
  e.attdef = { tag: String(tag).toUpperCase(), prompt: o.prompt ?? '', default: o.default ?? '', flags: o.flags ?? 0 };
  return e;
}

/** Display form of a block-definition entity inside an INSERT: ATTDEFs are not drawn (their ATTRIBs are),
 *  except constant ones, which show their value. Returns null to skip. */
export function blockContentView(be) {
  if (!be.attdef) return be;
  if (!(be.attdef.flags & ATT_CONSTANT) || (be.attdef.flags & ATT_INVISIBLE)) return null;
  return { ...be, text: be.attdef.default };
}

/** Visible ATTRIBs of an INSERT as plain TEXT entities (for EXPLODE). */
export function attribsAsText(ins) {
  return (ins.attribs ?? []).filter((a) => !(a.attrib.flags & ATT_INVISIBLE)).map((a) => { const t = structuredClone(a); delete t.attrib; t.id = 0; return t; });
}

// -- ATTSYNC ------------------------------------------------------------------------------------
/** Blocks whose definition has attributes (ATTSYNC "?"). */
export const blocksWithAttdefs = (doc) => insertableBlocks(doc).filter((n) => attdefsOf(doc.blocks.get(n)).length);

const sameNum = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) <= 1e-9 * Math.max(1, Math.abs(a ?? 0), Math.abs(b ?? 0));
/** two ATTRIBs agree in what ATTSYNC sets: tag, value, position, height, rotation, style, flags, invisibility (an
 *  insert read from DXF carries other fields, and floats that went through text) */
const sameAttrib = (a, b) => !!b && a.attrib?.tag === b.attrib?.tag && (a.text ?? '') === (b.text ?? '')
  && sameNum(a.p?.x, b.p?.x) && sameNum(a.p?.y, b.p?.y) && sameNum(a.height, b.height) && sameNum(a.rot, b.rot)
  && (a.style || 'Standard').toLowerCase() === (b.style || 'Standard').toLowerCase()
  && (a.attrib?.flags ?? 0) === (b.attrib?.flags ?? 0) && !!a.invisible === !!b.invisible;
/** ATTSYNC on one INSERT: ATTRIBs rebuilt from blk's ATTDEFs (placement, height, style, rotation, justification through
 *  the insert transform, as INSERT makes them), keeping the values of tags that are still defined. Null when unchanged. */
export function syncAttribs(ins, blk) {
  const values = Object.fromEntries((ins.attribs ?? []).map((a) => [a.attrib.tag, a.text]));
  const fresh = instantiate(blk, ins.p, { sx: ins.sx ?? 1, sy: ins.sy ?? 1, rot: ins.rot ?? 0, values }).attribs ?? [];
  const cur = ins.attribs ?? [];
  if (fresh.length === cur.length && fresh.every((a, i) => sameAttrib(a, cur[i]))) return null;
  const c = structuredClone(ins);
  if (fresh.length) c.attribs = fresh; else delete c.attribs;
  return c;
}

/** ATTSYNC: every INSERT of block `name` (model space, every layout, nested in other blocks) synced as ONE undo step on
 *  session s. Xref content is left alone (it is reloaded from its file). Returns the number of INSERTs changed. */
export function attSync(s, name) {
  const doc = s.doc.modelDoc ?? s.doc;
  if (!doc.blocks.get(name)) return 0;
  return s.transact('ATTSYNC', (tx) => attSyncTx(tx, s, name));
}

/** ATTSYNC's changes recorded on an open transaction tx of session s (so BSAVE can redefine and sync in one undo step) */
export function attSyncTx(tx, s, name) {
  const doc = s.doc.modelDoc ?? s.doc, blk = doc.blocks.get(name);
  if (!blk) return 0;
  const fix = (list, put) => { let n = 0; list.forEach((e, i) => { const c = e?.type === 'INSERT' && e.block === name && syncAttribs(e, blk); if (c) { put(i, c); n++; } }); return n; };
  {
    const lists = [...new Set([doc.entities, ...(doc.layouts ?? []).map((l) => l.entities)].filter(Boolean))];
    let n = 0;
    for (const list of lists) n += fix(list, (i, c) => (list === s.doc.entities ? tx.replace(c) : tx.set(list, i, c)));
    for (const [bn, b] of [...doc.blocks]) {
      if (b === blk || b.xref || b.xrefDep || lists.includes(b.entities) || (doc.layouts?.length && /^\*(paper|model)_space/i.test(bn))) continue;
      const ents = b.entities.slice();
      const k = fix(ents, (i, c) => { ents[i] = c; });
      if (k) { tx.block(bn, { ...b, entities: ents }); n += k; }
    }
    return n;
  }
}
