// ASH Draw Studio - layer state commands (AutoCAD LAYISO / LAYUNISO / LAYFRZ / LAYON / LAYTHW).
// Each command is one undo step. On/off (`visible`) and freeze (`frozen`) are independent, as in AutoCAD.
import { getEntity } from './model.js';

const layersOf = (doc, ids) => new Set(ids.map((id) => getEntity(doc, id)?.layer).filter((n) => n != null));

/** keep the layers of the given objects on, turn every other layer off.
 *  Returns the previous on/off state (for layUnisolate) or null when nothing was selected. */
export function layIsolate(s, ids) {
  const keep = layersOf(s.doc, ids);
  if (!keep.size) return null;
  const before = new Map([...s.doc.layers.values()].map((l) => [l.name, l.visible !== false]));
  s.transact('Layer isolate', (tx) => {
    for (const l of s.doc.layers.values()) {
      const on = keep.has(l.name);
      if ((l.visible !== false) !== on || (on && l.frozen)) tx.layer(l.name, on ? { visible: true, frozen: false } : { visible: false });
    }
  });
  return before;
}

/** restore the on/off state saved by layIsolate (layers created since keep their state) */
export function layUnisolate(s, saved) {
  if (!saved) return false;
  s.transact('Layer unisolate', (tx) => {
    for (const [name, on] of saved) { const l = s.doc.layers.get(name); if (l && (l.visible !== false) !== on) tx.layer(name, { visible: on }); }
  });
  return true;
}

/** freeze the layers of the given objects; returns the frozen layer names */
export function layFreeze(s, ids) {
  const names = [...layersOf(s.doc, ids)];
  s.transact('Layer freeze', (tx) => { for (const n of names) if (!s.doc.layers.get(n)?.frozen) tx.layer(n, { frozen: true }); });
  return names;
}

/** set one flag on every layer (LAYON: visible=true, LAYTHW: frozen=false) */
function setAll(s, label, key, value) {
  return s.transact(label, (tx) => { let n = 0; for (const l of s.doc.layers.values()) if (!!l[key] !== value) { tx.layer(l.name, { [key]: value }); n++; } return n; });
}
export const layOn = (s) => setAll(s, 'Layers on', 'visible', true);
export const layThaw = (s) => setAll(s, 'Thaw all layers', 'frozen', false);
