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

const UNDO_LIMIT = 500;

class Tx {
  constructor(session) { this.s = session; this.ops = []; this.ids = new Set(); this.structure = false; }
  get doc() { return this.s.doc; }
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
  /** set (style object) or delete (null) the dimension style `name` in doc.dimStyles */
  dimStyle(name, style) {
    const m = (this.doc.dimStyles ??= new Map());
    const before = m.get(name) ?? null;
    if (style) m.set(name, style); else m.delete(name);
    this.ops.push({ k: 'dimstyle', name, before, after: style });
    this.structure = true;
  }
  /** create or change a layer: props merged into the existing layer; null deletes it */
  layer(name, props) {
    const before = getLayer(this.doc, name);
    const snap = before ? { ...before } : null;
    if (props === null) this.doc.layers.delete(name);
    else if (before) Object.assign(before, props);
    else addLayer(this.doc, { name, ...props });
    const after = getLayer(this.doc, name);
    this.ops.push({ k: 'layer', name, before: snap, after: after ? { ...after } : null });
    this.structure = true;
  }
}

function applyInverse(doc, op) {
  switch (op.k) {
    case 'add': removeEntities(doc, [op.e.id]); break;
    case 'remove': for (const it of [...op.items].sort((a, b) => a.index - b.index)) doc.entities.splice(it.index, 0, it.e); break;
    case 'replace': { const i = doc.entities.findIndex((e) => e.id === op.after.id); if (i >= 0) doc.entities[i] = op.before; break; }
    case 'layer': if (op.before) doc.layers.set(op.name, { ...op.before }); else doc.layers.delete(op.name); break;
    case 'dimstyle': if (op.before) doc.dimStyles.set(op.name, op.before); else doc.dimStyles.delete(op.name); break;
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
    default: break;
  }
}

export class Session {
  constructor(doc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = null;
    this.revision = 0;      // increments on every change (also undo/redo)
    this.stepSeq = 0;
    this.savedStep = 0;     // id of the undo step that was on top when the document was last saved (0 = none)
  }

  /** unsaved changes? Compares the top undo step with the one recorded at save, so
   *  "save, undo, make a different edit" is correctly dirty (a plain counter would say clean). */
  get dirty() { return (this.undoStack.at(-1)?.id ?? 0) !== this.savedStep; }
  markSaved() { this.savedStep = this.undoStack.at(-1)?.id ?? 0; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? ''; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? ''; }

  /** run fn(tx) as one undoable step. Returns fn's result. An empty transaction is not recorded. */
  transact(label, fn) {
    const tx = new Tx(this);
    let result;
    try { result = fn(tx); } catch (err) {
      for (const op of [...tx.ops].reverse()) applyInverse(this.doc, op); // roll back a half-done step
      throw err;
    }
    if (tx.ops.length) {
      this.undoStack.push({ id: ++this.stepSeq, label, ops: tx.ops });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.revision++;
      this._emit({ ids: [...tx.ids], structure: tx.structure, kind: 'do', label });
    }
    return result;
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return false;
    const ids = new Set();
    let structure = false;
    for (const op of [...step.ops].reverse()) {
      applyInverse(this.doc, op);
      if (op.k === 'layer' || op.k === 'dimstyle') structure = true; else collectIds(op, ids);
    }
    this.redoStack.push(step);
    this.revision--;
    this._emit({ ids: [...ids], structure, kind: 'undo', label: step.label });
    return true;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return false;
    const ids = new Set();
    let structure = false;
    for (const op of step.ops) {
      applyForward(this.doc, op);
      if (op.k === 'layer' || op.k === 'dimstyle') structure = true; else collectIds(op, ids);
    }
    this.undoStack.push(step);
    this.revision++;
    this._emit({ ids: [...ids], structure, kind: 'redo', label: step.label });
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
  const created = [];
  s.transact(label, (tx) => {
    for (const id of ids) {
      const e = getEntity(s.doc, id);
      if (!e) continue;
      try {
        const t = xform(s.doc, e, m);
        if (copy) { t.id = 0; created.push(tx.add(t)); } else tx.replace(t);
        done++;
      } catch (err) { failed.push(fail(id, err)); }
    }
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

/** Apply an edit set {add, remove, change} from modify.js as one undo step; returns the added entities. */
export function applyEditSet(s, label, set) {
  return s.transact(label, (tx) => {
    for (const e of set.change || []) tx.replace(e);
    if (set.remove && set.remove.length) tx.remove(set.remove);
    return (set.add || []).map((e) => { e.id = 0; return tx.add(e); });
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

/** Change layer / colour / linetype / lineweight / ltscale of entities. */
export function setEntityProps(s, ids, props) {
  const allowed = ['layer', 'color', 'linetype', 'lineweight', 'ltscale'];
  const clean = {};
  for (const k of allowed) if (k in props) clean[k] = props[k];
  return s.transact('Properties', (tx) => {
    let n = 0;
    if (clean.layer && !getLayer(s.doc, clean.layer)) tx.layer(clean.layer, {});
    for (const id of ids) {
      const e = getEntity(s.doc, id);
      if (!e) continue;
      tx.replace({ ...structuredClone(e), ...clean });
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
  s.transact('Edit text', (tx) => { tx.replace(c); });
  return true;
}

export function setLayerProps(s, name, props) {
  return s.transact('Layer', (tx) => { tx.layer(name, props); });
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
