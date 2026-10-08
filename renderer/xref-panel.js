// ASH Draw Studio - external references: loading on open and the External References panel (XREF / XR).
import { listXrefs, loadXref, unloadXref } from '../src/core/xref.js';
import { loadDrawing, OPEN_FILTERS } from './files.js';
import { loadOneXref, loadXrefs, relativePath, xrefStatusLabel } from './xrefs.js';
import { el, modal, toast } from './ui.js';

const BAD = ['Not found', 'Unreadable', 'Circular reference'];
const parser = (api) => async (bytes, r) => (await loadDrawing(api, 'xref.dxf', bytes)).doc;
const reader = (api, hostPath) => (ref) => (hostPath ? api.xrefRead(hostPath, ref) : Promise.resolve(null));
const opts = (hostPath) => ({ chain: hostPath ? [hostPath] : [], depth: 3, host: hostPath });

/** resolve and load every xref of a drawing being opened (before its scene is built) */
export async function loadDrawingXrefs(api, doc, hostPath) {
  if (![...doc.blocks.values()].some((b) => b.xref)) return {};
  return loadXrefs(doc, reader(api, hostPath), parser(api), opts(hostPath));
}

/** XATTACH step 1: choose a DXF/DWG and parse it. Resolves { file, path, xdoc } (path relative to the host when
 *  saved on the same drive, else absolute) or null when cancelled/unreadable. */
export async function pickXref(app) {
  let f;
  try { [f] = await window.api.openFiles({ filters: OPEN_FILTERS, multiple: false }); } catch (err) { toast(`Could not open: ${err.message}`); return null; }
  if (!f) return null;
  try { return { file: f, path: f.path ? relativePath(app.file.path, f.path) : f.name, xdoc: (await loadDrawing(window.api, f.name, f.bytes)).doc }; } catch (err) { toast(`XATTACH: ${f.name} could not be read (${err.message})`); return null; }
}

/** the External References panel of the active drawing */
export async function xrefPanel(app) {
  const api = window.api, body = el('div', { class: 'xref-panel' });
  const host = () => app.file.path;
  const done = (msg) => { app.vp.refreshStructure(); app.refreshPanels(); draw(); if (msg) toast(msg, 2000); };
  const reload = async (x) => { const s = await loadOneXref(app.fileDoc, x.name, reader(api, host()), parser(api), opts(host())); done(`${x.name}: ${s === 'loaded' ? 'loaded' : xrefStatusLabel(x)}`); };
  const browse = async (x) => {
    let f;
    try { [f] = await api.openFiles({ filters: OPEN_FILTERS, multiple: false }); } catch (err) { toast(`Could not open: ${err.message}`); return; }
    if (!f) return;
    const path = f.path ? relativePath(host(), f.path) : f.name;
    app.session.transact('Xref path', (tx) => tx.block(x.name, { ...x.block, xref: { ...x.block.xref, path } }));
    const blk = app.fileDoc.blocks.get(x.name);
    try {
      loadXref(app.fileDoc, x.name, (await loadDrawing(api, f.name, f.bytes)).doc, f.path);
    } catch { blk.xref.status = 'unreadable'; }
    done();
  };
  const draw = () => {
    const rows = listXrefs(app.fileDoc);
    body.replaceChildren(rows.length ? el('table', { class: 'xref-table' },
      el('tr', {}, ['Name', 'Status', 'Path', 'Inserts', ''].map((h) => el('th', { text: h }))),
      rows.map((x) => el('tr', { 'data-xref': x.name },
        el('td', { text: x.name }), el('td', { class: `xref-status${BAD.includes(xrefStatusLabel(x)) ? ' bad' : ''}`, text: xrefStatusLabel(x) }), el('td', { text: x.path, title: x.block.xref.resolved ?? '' }), el('td', { text: String(x.inserts) }),
        el('td', {},
          el('button', { 'data-act': 'reload', onclick: () => reload(x) }, 'Reload'),
          el('button', { 'data-act': 'unload', onclick: () => { unloadXref(app.fileDoc, x.name); done(`${x.name} unloaded`); } }, 'Unload'),
          el('button', { 'data-act': 'browse', onclick: () => browse(x) }, 'Browse…'))))) : el('p', { text: 'This drawing has no external references.' }));
  };
  draw();
  const r = await modal('External References', body, [{ label: 'Attach…', value: 'attach' }, { label: 'Close', value: true, primary: true }]);
  if (r === 'attach') app.setTool('xattach');
}
