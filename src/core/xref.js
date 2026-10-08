// External references (XREF): path resolution and loading an xref drawing into the host as a read-only block.
// An xref is a BLOCK whose flags have bit 4 (external) and whose group 1 holds the referenced file's path; its
// INSERTs place it. Loaded content lives in that block; layers and nested blocks are renamed "XREFNAME|NAME" and
// marked `xrefDep` so the writer leaves them out (the xref is written back as an empty external block).
import { addBlock, addLayer } from './model.js';

const isAbs = (p) => /^([A-Za-z]:[\\/]|[\\/])/.test(p);
const baseName = (p) => String(p).split(/[\\/]/).pop();

/** The files to try for an xref path, in order (AutoCAD's search simplified): relative to the host drawing's folder,
 *  the path as written when it is absolute, then the file name in the host folder. `pathLib` is node's path module
 *  (or path.win32 / path.posix in tests). Duplicates are removed. */
export function xrefCandidates(hostPath, refPath, pathLib) {
  const ref = pathLib.sep === '/' ? String(refPath).replace(/\\/g, '/') : String(refPath);
  const dir = pathLib.dirname(hostPath);
  const out = [];
  if (!isAbs(ref)) out.push(pathLib.resolve(dir, ref));
  else out.push(pathLib.resolve(ref));
  out.push(pathLib.join(dir, baseName(ref)));
  return [...new Set(out)];
}

/** xref blocks of a document: [{ name, path, status, block, inserts }] */
export function listXrefs(doc) {
  const inserts = new Map();
  const count = (list) => { for (const e of list) if (e.type === 'INSERT') inserts.set(e.block, (inserts.get(e.block) ?? 0) + 1); };
  count(doc.entities);
  for (const b of doc.blocks.values()) if (!b.xrefDep) count(b.entities);
  for (const lo of doc.layouts ?? []) count(lo.entities ?? []);
  return [...doc.blocks.values()].filter((b) => b.xref).map((b) => ({
    name: b.name, path: b.xref.path, block: b, inserts: inserts.get(b.name) ?? 0,
    status: !inserts.get(b.name) ? 'Unreferenced' : b.xref.status === 'loaded' ? 'Loaded' : b.xref.status === 'unloaded' ? 'Unloaded' : 'Not found',
  }));
}

/** drop what a previous load of xref `name` added (layers, nested blocks, content) */
export function unloadXref(doc, name, status = 'unloaded') {
  const blk = doc.blocks.get(name);
  if (!blk?.xref) return false;
  for (const [k, l] of doc.layers) if (l.xrefDep === name) doc.layers.delete(k);
  for (const [k, b] of doc.blocks) if (b.xrefDep === name) doc.blocks.delete(k);
  blk.entities = [];
  blk.xref.status = status;
  return true;
}

/** Put the model space of `xdoc` into the host's xref block `name` (read-only content). */
export function loadXref(doc, name, xdoc, resolvedPath = null) {
  const blk = doc.blocks.get(name);
  if (!blk?.xref) throw new Error(`"${name}" is not an external reference`);
  unloadXref(doc, name);
  const ln = (l) => (l === '0' || l == null ? '0' : `${name}|${l}`);
  for (const l of xdoc.layers.values()) {
    if (l.name === '0') continue;
    const nl = addLayer(doc, { ...l, name: ln(l.name) });
    nl.xrefDep = name;
  }
  const bn = (b) => `${name}|${b}`;
  const copy = (e) => {
    const c = structuredClone(e);
    c.layer = ln(e.layer);
    if (c.block && xdoc.blocks.has(c.block)) c.block = bn(c.block);
    for (const a of c.attribs ?? []) a.layer = ln(a.layer);
    return c;
  };
  for (const b of xdoc.blocks.values()) {
    if (b.xref) continue; // nested xrefs are not followed
    const nb = addBlock(doc, bn(b.name), b.base, b.entities.map(copy));
    nb.xrefDep = name;
  }
  blk.entities = xdoc.entities.map(copy);
  blk.xref.status = 'loaded';
  if (resolvedPath) blk.xref.resolved = resolvedPath;
  return blk;
}
