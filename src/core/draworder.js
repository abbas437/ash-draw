// ASH Draw Studio - draw order (AutoCAD LT DRAWORDER, TEXTTOFRONT, HATCHTOBACK). The entity list of a space IS its draw
// order (dxfRead applies SORTENTSTABLE, the renderer and dxfWrite follow the array), so each command is one reorder
// of the session document's entities: one undo step that restores the exact old order.

export const TEXT_TYPES = new Set(['TEXT', 'MTEXT', 'DIMENSION', 'LEADER', 'MLEADER']);

/** the list with the entities `ids` moved: 'front', 'back', or 'above' / 'under' the reference entities refIds
 *  (moved entities keep their relative order). null when nothing would change. */
export function reorderList(list, ids, mode, refIds = []) {
  const ref = new Set(refIds), sel = new Set([...ids].filter((id) => !ref.has(id)));
  const moving = list.filter((e) => sel.has(e.id)), rest = list.filter((e) => !sel.has(e.id));
  if (!moving.length) return null;
  let at;
  if (mode === 'front') at = rest.length;
  else if (mode === 'back') at = 0;
  else if (mode === 'above' || mode === 'under') {
    let lo = -1, hi = -1;
    rest.forEach((e, i) => { if (ref.has(e.id)) { if (lo < 0) lo = i; hi = i; } });
    if (lo < 0) return null;
    at = mode === 'above' ? hi + 1 : lo;
  } else throw new Error(`unknown draw order mode ${mode}`);
  const out = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return out.every((e, i) => e === list[i]) ? null : out;
}

/** reorder the session document's entities; returns the number of entities moved (0 = order unchanged, no undo step) */
export function drawOrder(s, ids, mode, refIds = [], label = 'Draw Order') {
  const next = reorderList(s.doc.entities, ids, mode, refIds);
  if (!next) return 0;
  s.transact(label, (tx) => tx.order(next));
  const ref = new Set(refIds);
  return new Set([...ids].filter((id) => !ref.has(id))).size;
}

const idsOf = (s, pred) => s.doc.entities.filter(pred).map((e) => e.id);
/** TEXTTOFRONT (All): text, mtext, dimensions and leaders in front of everything else */
export const textToFront = (s) => drawOrder(s, idsOf(s, (e) => TEXT_TYPES.has(e.type)), 'front', [], 'Text to Front');
/** HATCHTOBACK: hatches behind everything else */
export const hatchToBack = (s) => drawOrder(s, idsOf(s, (e) => e.type === 'HATCH'), 'back', [], 'Hatch to Back');
