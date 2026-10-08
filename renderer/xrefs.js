// ASH Draw Studio - loading a drawing's external references (pure helpers, no DOM).
// `read(refPath)` resolves an xref path against the top host drawing's folder (window.api.xrefRead bound to the host)
// and gives { path, bytes } (DXF; DWG already converted) or null; `parse(bytes)` makes a document of it.
import { loadXref, unloadXref } from '../src/core/xref.js';

const isAbs = (p) => /^([A-Za-z]:[\\/]|[\\/])/.test(p);
const winLike = (p) => /^[A-Za-z]:|\\/.test(p);
const parts = (p) => String(p).split(/[\\/]+/).filter((s, i) => s !== '' || i === 0);
const norm = (p) => (winLike(p) ? p.replace(/\//g, '\\').toLowerCase() : p);
export const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);

/** `target` relative to the folder of `host` (".\sub\ref.dxf", "..\x\ref.dxf"); absolute when on another drive or root */
export function relativePath(host, target) {
  if (!host || !isAbs(host) || !isAbs(target)) return target;
  const sep = winLike(host) ? '\\' : '/';
  const h = parts(host).slice(0, -1), t = parts(target);
  const eq = (a, b) => (sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!eq(h[0], t[0])) return target; // another drive (or UNC share)
  let i = 0;
  while (i < h.length && i < t.length - 1 && eq(h[i], t[i])) i++;
  const up = h.length - i;
  return [...(up ? Array(up).fill('..') : ['.']), ...t.slice(i)].join(sep);
}

/** a relative xref path `ref` written in a drawing whose folder is `dir` (relative to the top host, or absolute) */
export function joinRel(dir, ref) {
  if (!dir || isAbs(ref)) return ref;
  const sep = winLike(dir) || winLike(ref) ? '\\' : '/';
  const out = parts(dir).filter((s) => s !== '.');
  for (const s of parts(ref)) {
    if (s === '.' || s === '') continue;
    if (s === '..' && out.length && out.at(-1) !== '..' && out.at(-1) !== '') out.pop(); else out.push(s);
  }
  return out.join(sep);
}
const dirOf = (p) => parts(p).slice(0, -1).join(winLike(p) ? '\\' : '/');

/** load one xref block of `doc` (nested xrefs `depth - 1` levels further); sets blk.xref.status */
export async function loadOneXref(doc, name, read, parse, { chain = [], depth = 2, base = '', host = null } = {}) {
  const blk = doc.blocks.get(name);
  const fail = (status) => { unloadXref(doc, name, status); return status; };
  let r;
  try { r = await read(joinRel(base, blk.xref.path)); } catch { return fail('unreadable'); }
  if (!r) return fail('notfound');
  if (chain.some((p) => samePath(p, r.path))) return fail('circular'); // a drawing that references itself (directly or not)
  let x;
  try { x = await parse(r.bytes, r); } catch { return fail('unreadable'); }
  if (depth > 1) {
    await loadXrefs(x, read, parse, { chain: [...chain, r.path], depth: depth - 1, base: dirOf(host ? relativePath(host, r.path) : r.path), host });
    for (const b of x.blocks.values()) if (b.xref) delete b.xref; // nested content travels with the xref as plain blocks
  }
  loadXref(doc, name, x, r.path);
  return 'loaded';
}

/** load every xref of `doc`; `chain` holds the drawings above (the host first) for cycle protection */
export async function loadXrefs(doc, read, parse, opts = {}) {
  const names = [...doc.blocks.values()].filter((b) => b.xref && !b.xrefDep).map((b) => b.name);
  const out = {};
  for (const n of names) out[n] = await loadOneXref(doc, n, read, parse, opts);
  return out;
}

/** status shown in the External References panel */
export const xrefStatusLabel = (x) => ({ unreadable: 'Unreadable', circular: 'Circular reference' })[x.block.xref.status] ?? x.status;
