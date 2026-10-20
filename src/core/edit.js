// ASH Draw Studio - editing session: undo/redo journal plus the modify commands.
// Pure ES module (no DOM). Every change to the document goes through Session.transact so it can be undone.
//
//   const s = new Session(doc);
//   s.onChange = (info) => { ... };               // info = { ids:[...], structure:boolean, kind:'do'|'undo'|'redo', label }
//   addEntities(s, [makeLine(...)]);              // -> [entities with ids]
//   moveEntities(s, ids, 10, 0, { copy:false });  // -> { done:n, failed:[{id,reason}] }
//   s.undo(); s.redo();
import {
  addEntity, removeEntities, cloneEntity, getEntity, addLayer, getLayer,
} from './model.js';
import {
  translation, rotation, scaling, mirrorLine, compose, transformEntity, explode, offsetEntity, trimEntity, extendEntity,
} from './geom.js';
import { transformDimension, rebuildDimension } from './dims.js';
import { relinkClipCopies } from './layouts.js';

const UNDO_LIMIT = 500;

class Tx {
  /** tt: the drawing session's Tx that takes this step's table changes (a block editor session; see Session) */
  constructor(session, tt = null) { this.s = session; this.tt = tt; this.ops = []; this.ids = new Set(); this.structure = false; }
  get doc() { return this.s.doc; }
  /** the drawing a routed table change applies to (the working copy's own properties are its entities and nextId) */
  get root() { return this.doc.modelDoc ?? this.tt.doc; }
  /** add an entity (gets a fresh id when e.id is 0) */
  add(e) {
    addEntity(this.doc, e);
    this.ops.push({ k: 'add', e });
    this.ids.add(e.id);
    return e;
  }
  /** remove entities by id */
  remove(ids) {
    const set = new Set(ids);
    const items = [];
    this.doc.entities.forEach((e, index) => { if (set.has(e.id)) items.push({ e, index }); });
    if (!items.length) return [];
    removeEntities(this.doc, [...set]);
    this.ops.push({ k: 'remove', items });
    for (const it of items) this.ids.add(it.e.id);
    return items.map((i) => i.e);
  }
  /** replace the entity with the same id by `ne` (same position in the list) */
  replace(ne) {
    const index = this.doc.entities.findIndex((e) => e.id === ne.id);
    if (index < 0) return false;
    const before = this.doc.entities[index];
    this.doc.entities[index] = ne;
    this.ops.push({ k: 'replace', index, before, after: ne });
    this.ids.add(ne.id);
    return true;
  }
  /** define (block object) or delete (null) the block definition `name` in doc.blocks */
  block(name, blk) {
    if (this.tt) { this.tt.block(name, blk); return; }
    const before = this.doc.blocks.get(name) ?? null;
    const idx = blk ? -1 : mapDelete(this.doc.blocks, name);
    if (blk) this.doc.blocks.set(name, blk);
    this.ops.push({ k: 'block', name, before, after: blk, idx });
    this.structure = true;
  }
  /** set (style object) or delete (null) the dimension style `name` in doc.dimStyles */
  dimStyle(name, style) {
    if (this.tt) { this.tt.dimStyle(name, style); return; }
    const m = (this.doc.dimStyles ??= new Map());
    const before = m.get(name) ?? null;
    const idx = style ? -1 : mapDelete(m, name);
    if (style) m.set(name, style);
    this.ops.push({ k: 'dimstyle', name, before, after: style, idx });
    this.structure = true;
  }
  /** set drawing header values on `target` (the whole drawing; default the session's): units ($INSUNITS), luprec ($LUPREC) */
  header(vals, target = this.doc) {
    if (this.tt) { this.tt.header(vals, target === this.doc ? this.root : target); return; }
    const before = readHeader(target);
    writeHeader(target, vals);
    this.ops.push({ k: 'header', target, before, after: readHeader(target), rebuild: before.ltscale !== readHeader(target).ltscale }); // labels only, unless $LTSCALE changed
    if (before.ltscale !== readHeader(target).ltscale) this.structure = true; // linetype patterns are built into the scene
  }
  /** set obj[key] to value, or a Map entry (value undefined deletes): named tables, entity lists of other owners;
   *  rebuild false: nothing drawn depends on it (named views), so no scene rebuild on do / undo / redo */
  set(obj, key, value, rebuild = true) {
    if (this.tt && obj !== this.doc.entities && !this.s.local.has(obj)) { this.tt.set(obj === this.doc ? this.root : obj, key, value, rebuild); return; }
    const before = obj instanceof Map ? obj.get(key) : obj[key];
    const idx = putKey(obj, key, value);
    this.ops.push({ k: 'set', obj, key, before, after: value, idx, ...(rebuild ? {} : { quiet: true }) });
    if (rebuild) this.structure = true;
  }
  /** assign plain properties of `obj` in place (a viewport's view): no scene rebuild, a redraw reads them */
  props(obj, vals) {
    const before = {};
    for (const k of Object.keys(vals)) before[k] = obj[k];
    Object.assign(obj, vals);
    this.ops.push({ k: 'props', obj, before, after: { ...vals } });
  }
  /** reorder doc.entities (the draw order) to `list`, the same entities in a new order; undo restores the old order */
  order(list) {
    const before = this.doc.entities.slice();
    setList(this.doc.entities, list);
    this.ops.push({ k: 'order', before, after: list.slice(), rebuild: true });
    this.structure = true; // the scene is built in entity order
  }
  /** create or change a layer: props merged into the existing layer; null deletes it */
  layer(name, props) {
    if (this.tt) { this.tt.layer(name, props); return; }
    const before = getLayer(this.doc, name);
    const snap = before ? { ...before } : null;
    let idx = -1;
    if (props === null) idx = mapDelete(this.doc.layers, name);
    else if (before) Object.assign(before, props);
    else addLayer(this.doc, { name, ...props });
    const after = getLayer(this.doc, name);
    this.ops.push({ k: 'layer', name, before: snap, after: after ? { ...after } : null, idx });
    this.structure = true;
  }
}

/** overwrite arr's contents with src's (keeps the array object, which other holders reference) */
function setList(arr, src) { arr.length = src.length; for (let i = 0; i < src.length; i++) arr[i] = src[i]; }
/** delete a Map entry; returns its position in the key order (-1 when absent) so an undo can put it back there */
function mapDelete(m, key) {
  if (!m.has(key)) return -1;
  let i = 0;
  for (const k of m.keys()) { if (k === key) break; i++; }
  m.delete(key);
  return i;
}
/** set a Map entry; a key that is absent goes back at position idx (when >= 0), keeping the other entries' order and identity */
function mapSetAt(m, key, v, idx) {
  if (idx < 0 || idx >= m.size || m.has(key)) { m.set(key, v); return; }
  const rest = [...m]; m.clear();
  rest.splice(idx, 0, [key, v]);
  for (const [k, x] of rest) m.set(k, x);
}
/** returns the deleted Map entry's position (see mapDelete), else -1 */
function putKey(obj, key, v, idx = -1) {
  if (obj instanceof Map) {
    if (v === undefined) return mapDelete(obj, key);
    mapSetAt(obj, key, v, idx);
  } else if (v === undefined) delete obj[key]; else obj[key] = v;
  return -1;
}
const readHeader = (d) => ({ units: d.units ?? 0, luprec: d.header?.luprec ?? 4, ltscale: d.header?.ltscale || 1 });
function writeHeader(d, v) {
  if (v.units !== undefined) d.units = v.units;
  if (v.luprec !== undefined) (d.header ??= {}).luprec = v.luprec;
  if (v.ltscale !== undefined) (d.header ??= {}).ltscale = v.ltscale;
}

function applyInverse(doc, op) {
  switch (op.k) {
    case 'add': removeEntities(doc, [op.e.id]); break;
    case 'remove': for (const it of [...op.items].sort((a, b) => a.index - b.index)) doc.entities.splice(it.index, 0, it.e); break;
    case 'replace': { const i = doc.entities.findIndex((e) => e.id === op.after.id); if (i >= 0) doc.entities[i] = op.before; break; }
    case 'layer': if (op.before) mapSetAt(doc.layers, op.name, { ...op.before }, op.idx ?? -1); else doc.layers.delete(op.name); break;
    case 'dimstyle': if (op.before) mapSetAt(doc.dimStyles, op.name, op.before, op.idx ?? -1); else doc.dimStyles.delete(op.name); break;
    case 'block': if (op.before) mapSetAt(doc.blocks, op.name, op.before, op.idx ?? -1); else doc.blocks.delete(op.name); break;
    case 'header': writeHeader(op.target, op.before); break;
    case 'set': putKey(op.obj, op.key, op.before, op.idx ?? -1); break;
    case 'order': setList(doc.entities, op.before); break;
    case 'props': Object.assign(op.obj, op.before); break;
    default: break;
  }
}
function applyForward(doc, op) {
  switch (op.k) {
    case 'add': doc.entities.push(op.e); break;
    case 'remove': removeEntities(doc, op.items.map((i) => i.e.id)); break;
    case 'replace': { const i = doc.entities.findIndex((e) => e.id === op.before.id); if (i >= 0) doc.entities[i] = op.after; break; }
    case 'layer': if (op.after) doc.layers.set(op.name, { ...op.after }); else doc.layers.delete(op.name); break;
    case 'dimstyle': if (op.after) (doc.dimStyles ??= new Map()).set(op.name, op.after); else doc.dimStyles.delete(op.name); break;
    case 'block': if (op.after) doc.blocks.set(op.name, op.after); else doc.blocks.delete(op.name); break;
    case 'header': writeHeader(op.target, op.after); break;
    case 'set': putKey(op.obj, op.key, op.after); break;
    case 'order': setList(doc.entities, op.after); break;
    case 'props': Object.assign(op.obj, op.after); break;
    default: break;
  }
}

export class Session {
  /** opts.tableSession: the drawing's session, for a session on a working copy that shares the drawing's tables (the block
   *  editor). Table changes (layers, blocks, dimension styles, header, Tx.set on anything but this doc's entities and
   *  opts.local objects) then apply through tableSession as its own undo step with the same label, so they are drawing
   *  changes: the drawing is dirty and can undo them, and they stay when the working copy is discarded. */
  constructor(doc, { tableSession = null, local = [] } = {}) {
    this.doc = doc;
    this.tableSession = tableSession;
    this.local = new Set(local);
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = null;
    this.revision = 0;      // increments on every change (also undo/redo)
    this.stepSeq = 0;
    this.savedStep = 0;     // id of the undo step that was on top when the document was last saved (0 = none)
    this.viewTouched = false; // a change with no undo step (VPLOCK in MSPACE) since the last save
    this.viewPending = false; // a viewport view changed in MSPACE, not yet recorded as an undo step (recordViewportView)
  }

  /** unsaved changes? Compares the top undo step with the one recorded at save, so
   *  "save, undo, make a different edit" is correctly dirty (a plain counter would say clean). */
  get dirty() { return this.viewTouched || this.viewPending || (this.undoStack.at(-1)?.id ?? 0) !== this.savedStep; }
  /** `step`: the undo step that was on top when the save started (edits made while saving stay unsaved); default the top one */
  markSaved(step = this.undoStack.at(-1)?.id ?? 0) { this.savedStep = step; this.viewTouched = false; this.viewPending = false; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? ''; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? ''; }

  /** run fn(tx) as one undoable step. Returns fn's result. An empty transaction is not recorded. */
  transact(label, fn) {
    if (this.tableSession) return this.tableSession.transact(label, (tt) => this._transact(label, fn, tt));
    return this._transact(label, fn, null);
  }

  _transact(label, fn, tt) {
    const tx = new Tx(this, tt);
    let result;
    try { result = fn(tx); } catch (err) {
      for (const op of [...tx.ops].reverse()) applyInverse(this.doc, op); // roll back a half-done step
      throw err;
    }
    if (tx.ops.length) {
      this.undoStack.push({ id: ++this.stepSeq, label, ops: tx.ops, doc: this.doc });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.revision++;
      this._emit({ ids: [...tx.ids], structure: tx.structure || !!tt?.ops.length, kind: 'do', label, doc: this.doc });
    } else if (tt?.ops.length) this._emit({ ids: [], structure: true, kind: 'do', label, doc: this.doc }); // a drawing change only: redraw
    return result;
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return false;
    const ids = new Set();
    let structure = false;
    for (const op of [...step.ops].reverse()) {
      applyInverse(step.doc ?? this.doc, op);
      if (op.k === 'layer' || op.k === 'dimstyle' || op.k === 'block' || (op.k === 'set' && !op.quiet) || op.rebuild) structure = true; else collectIds(op, ids);
    }
    this.redoStack.push(step);
    this.revision--;
    this._emit({ ids: [...ids], structure, kind: 'undo', label: step.label, doc: step.doc });
    return true;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return false;
    const ids = new Set();
    let structure = false;
    for (const op of step.ops) {
      applyForward(step.doc ?? this.doc, op);
      if (op.k === 'layer' || op.k === 'dimstyle' || op.k === 'block' || (op.k === 'set' && !op.quiet) || op.rebuild) structure = true; else collectIds(op, ids);
    }
    this.undoStack.push(step);
    this.revision++;
    this._emit({ ids: [...ids], structure, kind: 'redo', label: step.label, doc: step.doc });
    return true;
  }

  _emit(info) { if (this.onChange) this.onChange(info); }
}

function collectIds(op, ids) {
  if (op.k === 'add') ids.add(op.e.id);
  else if (op.k === 'remove') for (const it of op.items) ids.add(it.e.id);
  else if (op.k === 'replace') ids.add(op.after.id);
}

// ---------------------------------------------------------------------------------------------
// commands
/** a dimension with a definition stays a dimension (def transformed, block regenerated); others via geom */
const xform = (doc, e, m) => (e.type === 'DIMENSION' && e.def ? transformDimension(doc, e, m) : transformEntity(e, m));
const fail = (id, err) => ({ id, reason: err?.code ?? err?.message ?? 'failed' });

/** the view fields of a VIEWPORT that zoom/pan in MSPACE changes (twist cannot: MSPACE refuses twisted viewports) */
export const viewportView = (v) => ({ viewCenter: { x: v.viewCenter.x, y: v.viewCenter.y }, viewHeight: v.viewHeight });

/** Record a viewport view change made in place (zoom/pan in MSPACE) as one undo step: `v` holds the new view, `before`
 *  (viewportView) the view it had when the view session began. `doc` is the space the viewport lives in (its layout's),
 *  so undo/redo redraw that space. Clears s.viewPending. Returns true when a step was recorded (false: view unchanged). */
export function recordViewportView(s, v, before, doc = s.doc) {
  s.viewPending = false;
  const after = viewportView(v), tol = 1e-12 * Math.max(Math.abs(before.viewHeight), Math.abs(after.viewHeight));
  if (Math.abs(after.viewHeight - before.viewHeight) <= tol && Math.abs(after.viewCenter.x - before.viewCenter.x) <= tol
    && Math.abs(after.viewCenter.y - before.viewCenter.y) <= tol) return false;
  Object.assign(v, viewportView(before)); // the step goes from the session's first view to its last
  const cur = s.doc;
  s.doc = doc;
  try { s.transact('Viewport view', (tx) => tx.props(v, after)); } finally { s.doc = cur; }
  return true;
}

export function addEntities(s, entities, label = 'Draw') {
  return s.transact(label, (tx) => entities.map((e) => tx.add(e)));
}

export function eraseEntities(s, ids) {
  return s.transact('Erase', (tx) => tx.remove(ids).length);
}

/** Apply matrix m to entities. copy=true leaves the originals and adds transformed copies. */
export function transformEntities(s, ids, m, { copy = false, label = 'Transform' } = {}) {
  const failed = [];
  let done = 0;
  const created = [], pairs = [];
  s.transact(label, (tx) => {
    for (const id of ids) {
      const e = getEntity(s.doc, id);
      if (!e) continue;
      try {
        const t = xform(s.doc, e, m);
        if (copy) { t.id = 0; created.push(tx.add(t)); pairs.push([e, t]); } else tx.replace(t);
        done++;
      } catch (err) { failed.push(fail(id, err)); }
    }
    relinkClipCopies(pairs);
  });
  return { done, failed, created };
}

export const moveEntities = (s, ids, dx, dy, opts = {}) =>
  transformEntities(s, ids, translation(dx, dy), { label: opts.copy ? 'Copy' : 'Move', ...opts });

export const rotateEntities = (s, ids, base, rad, opts = {}) =>
  transformEntities(s, ids, rotation(rad, base.x, base.y), { label: 'Rotate', ...opts });

export const scaleEntities = (s, ids, base, factor, opts = {}) =>
  transformEntities(s, ids, scaling(factor, factor, base.x, base.y), { label: 'Scale', ...opts });

/** Mirror about the line p1-p2. deleteSource=true removes the originals (AutoCAD "Delete source objects? Y"). */
export function mirrorEntities(s, ids, p1, p2, { deleteSource = false } = {}) {
  return transformEntities(s, ids, mirrorLine(p1, p2), { copy: !deleteSource, label: 'Mirror' });
}

/** Explode INSERT / DIMENSION / LWPOLYLINE into simpler entities. Others are reported as failed. */
export function explodeEntities(s, ids) {
  const failed = [];
  const created = [];
  s.transact('Explode', (tx) => {
    for (const id of ids) {
      const e = getEntity(s.doc, id);
      if (!e) continue;
      if (!['INSERT', 'DIMENSION', 'LWPOLYLINE'].includes(e.type)) { failed.push({ id, reason: 'NOT_EXPLODABLE' }); continue; }
      let parts;
      try { parts = explode(e, s.doc); } catch (err) { failed.push(fail(id, err)); continue; }
      tx.remove([id]);
      for (const p of parts) {
        p.id = 0;
        if (e.type !== 'LWPOLYLINE') {
          // pieces of a block take the INSERT's layer/colour when they were on layer 0 / BYBLOCK
          if (p.layer === '0') p.layer = e.layer;
          if (p.color === 0) p.color = e.color;
        }
        created.push(tx.add(p));
      }
    }
  });
  return { done: created.length, failed, created };
}

/** Apply an edit set {add, remove, change} from modify.js as one undo step; returns the added entities. `copies` (the
 *  arrays): [[source, copy]...] per array item, copies among `add`, so copied clipped viewports link to their copied
 *  boundaries. */
export function applyEditSet(s, label, set) {
  return s.transact(label, (tx) => {
    for (const e of set.change || []) tx.replace(e);
    if (set.remove && set.remove.length) tx.remove(set.remove);
    const added = (set.add || []).map((e) => { e.id = 0; return tx.add(e); });
    for (const pairs of set.copies || []) relinkClipCopies(pairs);
    return added;
  });
}

/** Offset one entity by distance d to the side of sidePt; the new entity goes on the same layer. */
export function offsetCommand(s, id, d, sidePt) {
  const e = getEntity(s.doc, id);
  if (!e) return { done: 0, failed: [{ id, reason: 'NOT_FOUND' }], created: [] };
  try {
    const o = offsetEntity(e, d, sidePt);
    o.id = 0;
    const created = s.transact('Offset', (tx) => [tx.add(o)]);
    return { done: 1, failed: [], created };
  } catch (err) { return { done: 0, failed: [fail(id, err)], created: [] }; }
}

/** Trim entity `id` against the cutting-edge entities; pick = the point on the part to remove. */
export function trimCommand(s, id, cutterIds, pick) {
  const e = getEntity(s.doc, id);
  if (!e) return { done: 0, failed: [{ id, reason: 'NOT_FOUND' }] };
  const cutters = cutterIds.map((c) => getEntity(s.doc, c)).filter((c) => c && c.id !== id);
  let r;
  try { r = trimEntity(e, cutters, pick, s.doc); } catch (err) { return { done: 0, failed: [fail(id, err)] }; }
  if (!r) return { done: 0, failed: [{ id, reason: 'NO_INTERSECTION' }] };
  s.transact('Trim', (tx) => {
    const [first, ...rest] = r.replace;
    if (first) { first.id = e.id; tx.replace(first); } else tx.remove([e.id]);
    for (const p of rest) { p.id = 0; tx.add(p); }
  });
  return { done: 1, failed: [] };
}

export function extendCommand(s, id, boundaryIds, pick) {
  const e = getEntity(s.doc, id);
  if (!e) return { done: 0, failed: [{ id, reason: 'NOT_FOUND' }] };
  const bounds = boundaryIds.map((c) => getEntity(s.doc, c)).filter((c) => c && c.id !== id);
  let ne;
  try { ne = extendEntity(e, bounds, pick); } catch (err) { return { done: 0, failed: [fail(id, err)] }; }
  if (!ne) return { done: 0, failed: [{ id, reason: 'NO_BOUNDARY' }] };
  ne.id = e.id;
  s.transact('Extend', (tx) => { tx.replace(ne); });
  return { done: 1, failed: [] };
}

/** Change layer / colour / linetype / lineweight / ltscale / transparency (alpha) of entities. */
export function setEntityProps(s, ids, props) {
  const allowed = ['layer', 'color', 'linetype', 'lineweight', 'ltscale', 'alpha']; // alpha: undefined = ByLayer
  const clean = {};
  for (const k of allowed) if (k in props) clean[k] = props[k];
  return s.transact('Properties', (tx) => {
    let n = 0;
    if (clean.layer && !getLayer(s.doc, clean.layer)) tx.layer(clean.layer, {});
    for (const id of ids) {
      const e = getEntity(s.doc, id);
      if (!e) continue;
      const c = { ...structuredClone(e), ...clean };
      if (c.alpha === undefined) delete c.alpha;
      tx.replace(c);
      n++;
    }
    return n;
  });
}

/** Edit the text of TEXT / MTEXT entities (and height). */
export function setText(s, id, patch) {
  const e = getEntity(s.doc, id);
  if (!e || (e.type !== 'TEXT' && e.type !== 'MTEXT')) return false;
  const c = structuredClone(e);
  if ('text' in patch) c.text = String(patch.text);
  if ('height' in patch && patch.height > 0) c.height = patch.height;
  if (e.type === 'MTEXT' && Number.isInteger(patch.attach) && patch.attach >= 1 && patch.attach <= 9) c.attach = patch.attach;
  s.transact('Edit text', (tx) => { tx.replace(c); });
  return true;
}

export function setLayerProps(s, name, props) {
  return s.transact('Layer', (tx) => { tx.layer(name, props); });
}

/** Why `name` cannot be the new name of layer `from` (AutoCAD rules), or '' when it can: non-empty, none of
 *  < > / \\ " : ; ? * | , = `, unique ignoring case (a case-only change of the same layer is allowed); layer 0 and
 *  xref-dependent layers (name with "|") keep their names. */
export function layerRenameError(doc, from, name) {
  const U = (x) => String(x).toUpperCase();
  const l = getLayer(doc, from);
  if (!l) return 'No such layer.';
  if (from === '0') return 'Layer 0 cannot be renamed.';
  if (from.includes('|') || l.xrefDep) return 'Xref-dependent layers cannot be renamed.';
  if (!name || !name.trim()) return 'The layer name cannot be empty.';
  if (/[<>/\\":;?*|,=`]/.test(name)) return 'A layer name cannot contain < > / \\ " : ; ? * | , = `';
  if (name !== name.trim()) return 'A layer name cannot start or end with a space.';
  for (const k of doc.layers.keys()) if (k !== from && U(k) === U(name)) return `A layer named "${k}" already exists.`;
  return '';
}

/** Rename layer `from` to `to` as ONE undo step: the layer table entry, every entity on it (model space, every
 *  layout, every block definition, INSERT attributes), viewport frozen-layer lists, and the current layer when
 *  `opts.current.layer` names it. `opts.doc` is the whole drawing (default the session's). Throws on an invalid name. */
export function renameLayer(s, from, to, opts = {}) {
  const doc = opts.doc ?? s.doc;
  const err = layerRenameError(doc, from, to);
  if (err) throw new Error(err);
  if (from === to) return false;
  const U = (x) => String(x ?? '0').toUpperCase(), old = U(from);
  // the layer table is case-sensitive: a reference follows only when it names `from` exactly, or when it has no exact
  // table key at all (an orphan such as a block piece on "WALLS") and matches ignoring case
  const keys = new Set(doc.layers.keys());
  const hit = (n) => n === from || (!keys.has(n) && U(n) === old);
  const lists = [doc.entities, ...(doc.layouts ?? []).map((lo) => lo.entities ?? []), ...[...doc.blocks.values()].filter((b) => !b.xref && !b.xrefDep).map((b) => b.entities ?? [])];
  s.transact('Rename layer', (tx) => {
    const before = { ...getLayer(doc, from) };
    tx.layer(from, null);
    tx.layer(to, { ...before, name: to });
    for (const list of lists) {
      for (const e of list) {
        if (hit(e.layer)) tx.props(e, { layer: to });
        for (const a of e.attribs ?? []) if (hit(a.layer)) tx.props(a, { layer: to });
        if (e.type === 'VIEWPORT' && e.frozen?.some(hit)) tx.props(e, { frozen: e.frozen.map((n) => (hit(n) ? to : n)) });
      }
    }
    if (opts.current && hit(opts.current.layer)) tx.props(opts.current, { layer: to });
  });
  return true;
}

/** Delete a layer unless it is "0" or still has entities. Returns true when deleted. */
export function deleteLayer(s, name) {
  if (name === '0') return false;
  if (s.doc.entities.some((e) => e.layer === name)) return false;
  if (!getLayer(s.doc, name)) return false;
  s.transact('Delete layer', (tx) => { tx.layer(name, null); });
  return true;
}

/** Set dimension style `name` to `style` and regenerate the dimensions that use it, as one undo step. */
export function setDimStyle(s, name, style) {
  return s.transact('Dimension Style', (tx) => {
    tx.dimStyle(name, { ...style, name });
    const key = name.toLowerCase();
    for (const e of [...s.doc.entities]) if (e.type === 'DIMENSION' && e.def && String(e.style).toLowerCase() === key) tx.replace(rebuildDimension(s.doc, e));
  });
}

/** UNITS dialog: drawing units ($INSUNITS) and length precision ($LUPREC) of `target` (the whole drawing) as one
 *  undoable step. Labels only: no geometry is scaled. No step when nothing changes. */
export function setDrawingUnits(s, { units, luprec }, target = s.doc) {
  const cur = readHeader(target);
  if (cur.units === units && cur.luprec === luprec) return false;
  s.transact('Units', (tx) => tx.header({ units, luprec }, target));
  return true;
}

/** Copy of entities (for clipboard); ids stripped. */
export function copyToClipboard(doc, ids) {
  return ids.map((id) => getEntity(doc, id)).filter(Boolean).map((e) => { const c = structuredClone(e); c.id = 0; return c; });
}
export function pasteEntities(s, clip, dx = 0, dy = 0) {
  const m = translation(dx, dy);
  return s.transact('Paste', (tx) => {
    const out = [];
    for (const e of clip) {
      try { const t = xform(s.doc, e, m); t.id = 0; out.push(tx.add(t)); } catch { /* skip */ }
    }
    return out;
  });
}

export { compose, cloneEntity };
