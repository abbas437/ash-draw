// ASH Draw Studio - COPYCLIP / COPYBASE / PASTECLIP / PASTEBLOCK / PASTEORIG through the system clipboard.
// The selection goes out as a self-contained DXF fragment (src/core/clipboard.js); window.api.clipboardWriteDxf /
// clipboardReadDxf carry it (Electron: the system clipboard; browser: navigator.clipboard text). When the host has no
// clipboard the fragment stays in the window (app.clip), as before.
import { fragmentDxf, readFragment, pasteFragment } from '../src/core/clipboard.js';
import { INSUNITS } from '../src/core/measure.js';

const api = window.api;
const unitName = (u) => INSUNITS.find((x) => x[0] === u)?.[1] ?? `units ${u}`;

/** one point from the user, then fn(p); Esc / right click cancels */
export function pickPoint(app, prompt, fn) {
  if (app.toolId === 'pickpoint') app.tools.pickpoint.cancel(); // a pick still open: leave it (restores the tool and lastTool) before replacing it
  const prev = app.toolId === 'pickpoint' ? 'select' : app.toolId, prevLast = app.lastTool;
  let done = false;
  const leave = (p) => { if (done) return; done = true; app.setTool(prev); app.lastTool = prevLast; if (p) fn(p); };
  app.tools.pickpoint = {
    prompt,
    activate() {}, deactivate() { done = true; },
    cancel() { leave(null); },
    up(p, ev) { if (!ev.dragged) this.click(p); },
    click(p) { leave({ x: p.x, y: p.y }); },
    key(e) { if (e.key === 'Escape') { leave(null); return true; } return e.key === 'Enter'; },
    rightClick() { leave(null); },
  };
  app.setTool('pickpoint');
}

/** COPYCLIP (no base point: the fragment's base is 0,0) / COPYBASE (asks for the base point first) */
export function copyClip(app, { base = false } = {}) {
  const ids = [...app.vp.selection];
  if (!ids.length) { app.toast('Select objects first, then copy.'); return; }
  const go = (bp) => {
    const text = fragmentDxf(app.doc, ids, bp);
    app.clip = text;
    app.clipLocal = true; // app.clip is newer than whatever the system clipboard holds until a system write succeeds
    const done = () => app.toast(`${ids.length} object(s) copied`, 1500);
    const ok = (written) => {
      if (written === false) { app.toast('Selection too large for the system clipboard - copied inside ASH only.', 4000); return; }
      if (app.clip === text) app.clipLocal = false;
      done();
    };
    const p = api.clipboardWriteDxf?.(text);
    if (p?.then) p.then(ok, done); else done();
  };
  if (base) pickPoint(app, 'COPYBASE  Specify base point:', go); else go(null);
}

/** PASTECLIP ('clip': asks for the insertion point), PASTEBLOCK ('block': as a new block), PASTEORIG ('orig') */
export async function pasteClip(app, mode = 'clip') {
  let text = app.clip, system = false;
  if (!(app.clipLocal && app.clip) && api.clipboardReadDxf) { // the system clipboard, unless ASH's own copy is newer than its last system write
    try { text = await api.clipboardReadDxf(); system = true; } catch { text = app.clip; } // unavailable: the window's own copy
  }
  const frag = readFragment(text);
  if (!frag) { app.toast(system ? 'Nothing to paste (the clipboard holds no drawing objects).' : 'The clipboard holds no drawing objects.'); return; }
  const place = (at) => {
    const r = pasteFragment(app.session, frag, { at, orig: mode === 'orig', asBlock: mode === 'block' });
    app.vp.setSelection(r.entities.map((e) => e.id));
    const notes = [];
    if (r.scale !== 1) notes.push(`scaled ×${+r.scale.toPrecision(6)} from ${unitName(frag.units)} to ${unitName(app.doc.units)}`);
    if (r.renamed.length) notes.push(`blocks renamed: ${r.renamed.map(([a, b]) => `${a} → ${b}`).join(', ')}`);
    const msg = `${r.entities.length} object(s) pasted${notes.length ? ' - ' + notes.join('; ') : ''}`;
    app.toast(msg, notes.length ? 4000 : 1500);
    if (notes.length) app.log(msg);
  };
  if (mode === 'orig') place(null);
  else pickPoint(app, mode === 'block' ? 'PASTEBLOCK  Specify insertion point:' : 'PASTECLIP  Specify insertion point:', place);
}
