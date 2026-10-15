// ASH Draw Studio - layers frozen in one viewport only (AutoCAD VP Freeze / VPLAYER).
// A VIEWPORT keeps `frozen: [layer names]` (DXF 331, src/core/layouts.js); its model scene is drawn with those layers
// frozen (docWithFrozen). Each change below is one undo step. The viewports live in a layout's entity list, so the step
// is recorded on `doc`, the layout space the viewports belong to (undo/redo then redraw that space).
import { isPaperViewport } from './layouts.js';

const U = (n) => String(n).toUpperCase();

/** is layer `name` frozen in viewport `v` (names compare without case, as layer names do) */
export const vpFrozen = (v, name) => (v.frozen ?? []).some((n) => U(n) === U(name));

/** the model viewports of a layout entity list (not the paper-space viewport) */
export const layoutViewports = (entities) => entities.filter((e) => e.type === 'VIEWPORT' && !isPaperViewport(e));

/** Layer names of `doc` matching a VPLAYER list: comma-separated names, `*` any characters, `?` one character, no case.
 *  Returns { names, missing } (missing: plain names that match no layer). */
export function matchLayerNames(doc, list) {
  const all = [...doc.layers.keys()], names = [], missing = [];
  for (const raw of String(list).split(',').map((t) => t.trim()).filter(Boolean)) {
    const re = new RegExp(`^${raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    const hit = all.filter((n) => re.test(n));
    if (!hit.length && !/[*?]/.test(raw)) missing.push(raw);
    for (const n of hit) if (!names.includes(n)) names.push(n);
  }
  return { names, missing };
}

/** Freeze (`freeze` true) or thaw the layers `names` in the viewports `vps`, as ONE undo step on session `s`, recorded on
 *  `doc` (the layout space the viewports live in; default s.doc). Each viewport gets a new list (the old one stays with
 *  the undo step). Returns the number of viewports changed (0: nothing to do, no step). */
export function setVpFreeze(s, vps, names, freeze, doc = s.doc) {
  const changes = [];
  for (const v of vps) {
    const cur = v.frozen ?? [];
    const next = freeze ? [...cur, ...names.filter((n) => !vpFrozen(v, n))] : cur.filter((n) => !names.some((m) => U(m) === U(n)));
    if (next.length !== cur.length) changes.push([v, next]);
  }
  if (!changes.length) return 0;
  const was = s.doc;
  s.doc = doc;
  try { s.transact(freeze ? 'Viewport freeze' : 'Viewport thaw', (tx) => { for (const [v, frozen] of changes) tx.props(v, { frozen }); }); } finally { s.doc = was; }
  return changes.length;
}

/** VPLAYER Reset: back to the default visibility. Layers carry no "frozen in new viewports" setting in this version, so
 *  the default is thawed: every listed layer is thawed in the viewports. */
export const resetVpFreeze = (s, vps, names, doc = s.doc) => setVpFreeze(s, vps, names, false, doc);
