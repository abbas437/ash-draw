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
