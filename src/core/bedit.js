// ASH Draw Studio - block editor (AutoCAD BEDIT / BSAVE / BCLOSE). Pure ES module (no DOM).
//
// The editor works on a copy: openBlockEdit gives a "block doc" (the drawing seen through a working copy of the
// definition's entities; layers, blocks and styles stay the drawing's) with its own Session, so draw / modify / undo
// inside the editor touch only the copy. saveBlockEdit writes the copy back as ONE undo step on the drawing's session.
// Entities stay in block coordinates (no shift to the base point); the base point is state.base, drawn as a marker.
import { Session } from './edit.js';
import { attdefsOf, attSyncTx } from './blocks.js';

/** why block `name` cannot be edited (null when it can) */
export function blockEditError(doc, name) {
  const root = doc.modelDoc ?? doc, blk = root.blocks.get(name);
  if (!blk) return `There is no block named "${name}".`;
  if (/^[*$](model|paper)_space/i.test(name)) return `"${name}" holds a drawing space, not a block definition.`;
  if (blk.xref) return `"${name}" is an external reference. Open its drawing to edit it.`;
  if (blk.xrefDep || name.includes('|')) return `"${name}" comes from an external reference. Edit it in the referenced drawing.`;
  if (/^[*$]/.test(name)) return `"${name}" is an anonymous block (made by a dimension, hatch or array) and cannot be edited.`;
  return null;
}

/** the blocks BEDIT offers, sorted by name */
export function editableBlocks(doc) {
  const root = doc.modelDoc ?? doc;
  return [...root.blocks.keys()].filter((n) => !blockEditError(root, n)).sort((a, b) => a.localeCompare(b));
}

/** the defined block name matching `t` case-insensitively, or null */
export function findBlockName(doc, t) {
  const u = String(t ?? '').trim().toUpperCase();
  return [...(doc.modelDoc ?? doc).blocks.keys()].find((k) => k.toUpperCase() === u) ?? null;
}

/** Open block `name` for editing. Returns { name, block, doc, session, state }: state.base is the base point (block
 *  coordinates), changed with setBlockBase. Throws (code NOT_EDITABLE) with the reason for blocks that cannot be edited.
 *  `s` is the drawing's session: table changes made in the editor (a new layer, a dimension style, ...) are drawing
 *  changes, applied through `s` as its own undo steps (AutoCAD: layers made in the block editor are drawing layers). */
export function openBlockEdit(doc, name, s = null) {
  const root = doc.modelDoc ?? doc, err = blockEditError(root, name);
  if (err) throw Object.assign(new Error(err), { code: 'NOT_EDITABLE' });
  const block = root.blocks.get(name);
  const entities = block.entities.map((e, i) => ({ ...structuredClone(e), id: i + 1 }));
  const state = { name, base: { x: block.base.x, y: block.base.y } };
  const edoc = Object.create(root, {
    entities: { value: entities, writable: true, enumerable: true },
    nextId: { value: entities.length + 1, writable: true },
    dimStyles: { get: () => root.dimStyles, set: (v) => { root.dimStyles = v; } },
    modelDoc: { value: root }, blockEdit: { value: state },
  });
  const known = new Set(root.blocks.keys());
  return { name, block, doc: edoc, session: new Session(edoc, { tableSession: s, local: [state] }), state, known };
}

/** BASE inside the editor (one undo step of the editor): the geometry stays where it is in block space and the new base
 *  point is stored, so every reference of the block appears shifted by the change (AutoCAD semantics). */
export function setBlockBase(edit, p) {
  edit.session.transact('BASE', (tx) => tx.set(edit.state, 'base', { x: p.x, y: p.y }));
}

/** Leaving the editor (after BSAVE, or Discard): a dimension drawn in the editor generates its *D block straight into the
 *  drawing's blocks (no undo step, as everywhere), so the *D blocks made since the editor opened that no saved definition
 *  uses are removed. Returns their names. */
export function discardBlockEdit(edit) {
  const blocks = edit.doc.modelDoc.blocks, gone = [];
  for (const n of [...blocks.keys()]) if (/^\*D\d+$/i.test(n) && !edit.known.has(n)) { blocks.delete(n); gone.push(n); }
  return gone;
}

/** commands that change other blocks or the whole drawing in ways the editor cannot keep apart (typed names and tool
 *  ids): refused while the block editor is open */
const NOT_IN_EDITOR = new Set(['bedit', 'attsync', 'purge', 'pu', 'layout', 'pagesetup', 'block', 'b', '-b', 'bmake', 'units', 'un']);
export const refusedInEditor = (name) => NOT_IN_EDITOR.has(String(name).toLowerCase());

/** changes in the editor not yet saved */
export const blockEditDirty = (edit) => edit.session.dirty;

const attSig = (ents, base) => JSON.stringify([base.x, base.y, attdefsOf({ entities: ents }).map(({ id, ...d }) => d)]);

/** does any INSERT in `entities` lead to block `name`, directly or through other blocks' definitions (case-insensitive, any depth)? */
function reachesBlock(root, entities, name) {
  const target = name.toLowerCase(), byName = new Map([...root.blocks].map(([k, b]) => [k.toLowerCase(), b])), seen = new Set();
  const stack = [entities];
  while (stack.length) {
    for (const e of stack.pop()) {
      if (e.type !== 'INSERT') continue;
      const n = String(e.block).toLowerCase();
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      const b = byName.get(n);
      if (b) stack.push(b.entities);
    }
  }
  return false;
}

/** BSAVE: replace the definition with the working copy as ONE undo step "BEDIT <name>" on the drawing's session s.
 *  When the attribute definitions (or the base point, which places them) changed, every reference is synced (ATTSYNC)
 *  in the same step. Returns { synced }: the number of references whose attributes were rebuilt. */
export function saveBlockEdit(s, edit) {
  const root = s.doc.modelDoc ?? s.doc, old = root.blocks.get(edit.name);
  if (!old) throw new Error(`Block "${edit.name}" no longer exists.`);
  if (reachesBlock(root, edit.doc.entities, edit.name)) throw Object.assign(new Error(`Block "${edit.name}" cannot contain a reference to itself.`), { code: 'SELF_REF' });
  const entities = edit.doc.entities.map((e) => ({ ...structuredClone(e), id: 0 }));
  const base = { x: edit.state.base.x, y: edit.state.base.y };
  const blk = { ...old, base, entities };
  const resync = attSig(old.entities, old.base) !== attSig(entities, base);
  const synced = s.transact(`BEDIT ${edit.name}`, (tx) => { tx.block(edit.name, blk); return resync ? attSyncTx(tx, s, edit.name) : 0; });
  edit.block = blk;
  for (const e of entities) if (e.type === 'DIMENSION' && e.block) edit.known.add(e.block);
  edit.session.markSaved();
  return { synced };
}
