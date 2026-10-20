// ASH Draw Studio - external references: loading on open and the External References panel (XREF / XR).
import { listXrefs, loadXref, unloadXref } from '../src/core/xref.js';
import { loadDrawing, loadPicked, OPEN_FILTERS } from './files.js';
import { loadOneXref, loadXrefs, refusalTracker, relativePath, xrefStatusLabel } from './xrefs.js';
import { loadDrawingImages } from './images.js';
import { el, modal, toast } from './ui.js';

const BAD = ['Not found', 'Unreadable', 'Circular reference'];
const parser = (api) => async (bytes, r) => (await loadDrawing(api, 'xref.dxf', bytes)).doc;
const reader = (api, hostPath) => (ref) => (hostPath ? api.xrefRead(hostPath, ref) : Promise.resolve(null));
const opts = (hostPath) => ({ chain: hostPath ? [hostPath] : [], depth: 3, host: hostPath });

/** "This drawing refers to files outside its folder" (reviewer #22): true = Load. Main is told the answer with the
 *  listed paths (refs:decide) and only then reads them. */
async function allowOutside(api, hostPath, paths) {
  const r = await modal('Files outside the drawing folder', el('div', {},
    el('p', { text: 'This drawing refers to files outside its folder:' }),
    el('ul', { class: 'refs-outside' }, paths.map((p) => el('li', { text: p }))),
    el('p', { text: 'Load them?' })),
  [{ label: 'Load', value: 'load', primary: true }, { label: "Don't load", value: 'skip' }]);
  const load = r === 'load';
  await api.refsDecide?.(hostPath, load, paths);
  return load;
}

/** Resolve and load every xref and raster image of a drawing being opened (before its scene is built). Files outside
 *  the drawing's folder are asked about once (a nested xref found only after loading may add one more question);
 *  resolves { missingImages, notLoaded } (notLoaded: outside files the user did not allow). */
export async function loadDrawingRefs(api, doc, hostPath) {
  const t = refusalTracker();
  const xread = t.wrap(reader(api, hostPath));
  const iapi = { imageRead: t.wrap((h, p) => api.imageRead(h, p)) };
  const hasXrefs = () => [...doc.blocks.values()].some((b) => b.xref && !b.xrefDep);
  if (hasXrefs()) await loadXrefs(doc, xread, parser(api), opts(hostPath));
  let missingImages = await loadDrawingImages(iapi, doc, hostPath);
  const asked = new Set(), allowed = new Set();
  for (let round = 0; round < 3 && hostPath && !t.declined; round++) {
    const fresh = t.refused.filter((p) => !asked.has(p));
    if (!fresh.length) break;
    for (const p of fresh) asked.add(p);
    if (!(await allowOutside(api, hostPath, fresh))) break;
    for (const p of fresh) allowed.add(p);
    for (const b of [...doc.blocks.values()]) if (b.xref && !b.xrefDep && b.xref.status === 'notfound') await loadOneXref(doc, b.name, xread, parser(api), opts(hostPath));
    missingImages = await loadDrawingImages(iapi, doc, hostPath, { retry: true });
  }
  return { missingImages, notLoaded: t.refused.filter((p) => !allowed.has(p)) };
}

/** XATTACH step 1: choose a DXF/DWG and parse it. Resolves { file, path, xdoc } (path relative to the host when
 *  saved on the same drive, else absolute) or null when cancelled/unreadable. */
export async function pickXref(app) {
  let f;
  try { [f] = await window.api.openFiles({ filters: OPEN_FILTERS, multiple: false }); } catch (err) { toast(`Could not open: ${err.message}`); return null; }
  if (!f) return null;
  try { return { file: f, path: f.path ? relativePath(app.file.path, f.path) : f.name, xdoc: (await loadPicked(window.api, f)).doc }; } catch (err) { toast(`XATTACH: ${f.name} could not be read (${err.message})`); return null; }
}

/** the External References panel of the active drawing */
export async function xrefPanel(app) {
  const api = window.api, body = el('div', { class: 'xref-panel' });
  const host = () => app.file.path;
  const done = (msg) => { app.vp.refreshStructure(); app.refreshPanels(); draw(); if (msg) toast(msg, 2000); };
  const reload = async (x) => {
    const t = refusalTracker(), read = t.wrap(reader(api, host()));
    let s = await loadOneXref(app.fileDoc, x.name, read, parser(api), opts(host()));
    if (s !== 'loaded' && t.refused.length && !t.declined && await allowOutside(api, host(), t.refused)) s = await loadOneXref(app.fileDoc, x.name, read, parser(api), opts(host()));
    done(`${x.name}: ${s === 'loaded' ? 'loaded' : t.refused.length ? 'not loaded (outside the drawing folder)' : xrefStatusLabel(x)}`);
  };
  const browse = async (x) => {
    let f;
    try { [f] = await api.openFiles({ filters: OPEN_FILTERS, multiple: false }); } catch (err) { toast(`Could not open: ${err.message}`); return; }
    if (!f) return;
    const path = f.path ? relativePath(host(), f.path) : f.name;
    app.session.transact('Xref path', (tx) => tx.block(x.name, { ...x.block, xref: { ...x.block.xref, path } }));
    const blk = app.fileDoc.blocks.get(x.name);
    try {
      loadXref(app.fileDoc, x.name, (await loadPicked(api, f)).doc, f.path);
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
