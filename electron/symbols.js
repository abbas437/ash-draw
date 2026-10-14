// Symbol library folders (Symbols panel): the .dxf/.dwg files under a folder the user chose in a dialog, listed
// recursively with a cap. The renderer never names a file to read: it names a listed folder and a path relative to it,
// which must be a listed symbol file. No Electron imports: testable in plain Node.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './backup.js';
import { thumbKey } from '../src/core/symbols-lib.js';

export const SYMBOL_EXT = /\.(dxf|dwg)$/i;
export const MAX_SYMBOL_FILES = 2000;
export const MAX_SYMBOL_DEPTH = 6;
export const MAX_SYMBOL_FILE_BYTES = 8 * 1024 * 1024;

/** [{ rel, name, category, size, mtimeMs }] of the .dxf/.dwg files under `root` (subfolders = categories, "/"-joined),
 *  at most `max` files and MAX_SYMBOL_DEPTH folder levels; symlinks are not followed. `truncated` is set on the array. */
export async function listSymbolFiles(root, { max = MAX_SYMBOL_FILES } = {}) {
  const out = [];
  let truncated = false;
  const walk = async (dir, rel, depth) => {
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= max) { truncated = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < MAX_SYMBOL_DEPTH) await walk(path.join(dir, e.name), r, depth + 1); continue; }
      if (!e.isFile() || !SYMBOL_EXT.test(e.name)) continue;
      const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
      if (st) out.push({ rel: r, name: e.name, category: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  };
  await walk(path.resolve(root), '', 0);
  out.truncated = truncated;
  return out;
}

/** the absolute path of symbol file `rel` under `root`, or a TypeError: no "..", no absolute path, .dxf/.dwg only */
export function symbolFilePath(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0') || !SYMBOL_EXT.test(rel)) throw new TypeError('invalid symbol path');
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => !p || p === '.' || p === '..') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new TypeError('invalid symbol path');
  const base = path.resolve(root), p = path.resolve(base, ...parts);
  if (!p.startsWith(base + path.sep)) throw new TypeError('invalid symbol path');
  return p;
}

/** read symbol file `rel` under `root` (size-capped) */
export async function readSymbolFile(root, rel) {
  const p = symbolFilePath(root, rel);
  const st = await fs.lstat(p);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_SYMBOL_FILE_BYTES) throw new RangeError('symbol file too large');
  return { name: path.basename(p), format: path.extname(p).slice(1).toLowerCase(), bytes: new Uint8Array(await fs.readFile(p)) };
}

// ---- the symbol folders the user added, and their thumbnail cache (main-process handlers, no Electron imports) ----
// Folders are kept in <userData>/symbol-folders.json, apart from the generic settings store, so the window cannot add a
// root: only a folder chosen in the native dialog (`pickFolder`) is stored. The window names a folder by its opaque id.
// Thumbnails: <userData>/symbol-cache/<thumbKey>.png, the key computed here from the file's path, mtime and size.
export const FOLDER_ID = /^[0-9a-f]{16}$/;
export const MAX_THUMB_BYTES = 256 * 1024;
export const MAX_THUMB_CACHE_BYTES = 64 * 1024 * 1024;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FOLDERS_FILE = 'symbol-folders.json';
const CACHE_DIR = 'symbol-cache';

/** the PNG bytes, or a TypeError/RangeError: a Uint8Array of at most MAX_THUMB_BYTES starting with the PNG signature */
export function checkPng(b) {
  if (!(b instanceof Uint8Array)) throw new TypeError('thumbnail must be a Uint8Array');
  if (b.byteLength > MAX_THUMB_BYTES) throw new RangeError('thumbnail too large');
  if (b.byteLength < PNG_SIG.length || PNG_SIG.some((v, i) => b[i] !== v)) throw new TypeError('thumbnail is not a PNG');
  return b;
}

/** delete the least recently used (oldest mtime) .png files of `dir` until their total is at most `max`; the total left */
export async function pruneThumbCache(dir, max = MAX_THUMB_CACHE_BYTES) {
  let names; try { names = await fs.readdir(dir); } catch { return 0; }
  const files = [];
  for (const n of names) {
    if (!/^[0-9a-f]{16}\.png$/.test(n)) continue;
    const st = await fs.stat(path.join(dir, n)).catch(() => null);
    if (st?.isFile()) files.push({ p: path.join(dir, n), size: st.size, t: st.mtimeMs });
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (total <= max) break;
    await fs.rm(f.p, { force: true });
    total -= f.size;
  }
  return total;
}

/** `dir()`: userData (a function, so main can resolve it late); `pickFolder()`: the native folder dialog -> path | null;
 *  `toDxf(bytes)`: the DWG converter -> { dxfBytes }; `newId()` (16 hex digits), `maxCacheBytes` injectable */
export function createSymbolLibrary({ dir, pickFolder, toDxf, newId, maxCacheBytes = MAX_THUMB_CACHE_BYTES }) {
  let folders = null; // [{ id, path, name }]
  let cacheBytes = null; // running estimate of the cache size; null until scanned
  const cacheDir = () => path.join(dir(), CACHE_DIR);
  const load = async () => {
    if (folders) return folders;
    let v; try { v = JSON.parse(await fs.readFile(path.join(dir(), FOLDERS_FILE), 'utf8')); } catch { v = []; }
    folders = (Array.isArray(v) ? v : []).filter((f) => f && FOLDER_ID.test(f.id) && typeof f.path === 'string' && path.isAbsolute(f.path))
      .map((f) => ({ id: f.id, path: f.path, name: typeof f.name === 'string' ? f.name : path.basename(f.path) }));
    return folders;
  };
  const save = async () => { await fs.mkdir(dir(), { recursive: true }); await atomicWrite(path.join(dir(), FOLDERS_FILE), JSON.stringify(folders, null, 2)); };
  const rootOf = async (id) => {
    if (typeof id !== 'string' || !FOLDER_ID.test(id)) throw new TypeError('invalid symbol folder id');
    const f = (await load()).find((x) => x.id === id);
    if (!f) throw new Error('unknown symbol folder');
    return f.path;
  };
  const listing = async (root) => { const files = await listSymbolFiles(root); return { files: [...files], truncated: files.truncated }; };
  /** the cache file of symbol `rel` in folder `id` (the key follows the file's current mtime and size) */
  const thumbFile = async (id, rel) => {
    const p = symbolFilePath(await rootOf(id), rel);
    const st = await fs.stat(p);
    if (!st.isFile()) throw new Error('not a file');
    return path.join(cacheDir(), `${thumbKey(p, st.mtimeMs, st.size)}.png`);
  };
  return {
    /** the dialog's folder, stored (once per path); { id, path, name, files, truncated } or null when cancelled */
    async addFolder() {
      const picked = await pickFolder();
      if (typeof picked !== 'string' || !picked) return null;
      const p = path.resolve(picked);
      if (!(await fs.stat(p)).isDirectory()) throw new Error('not a folder');
      await load();
      let f = folders.find((x) => x.path === p);
      if (!f) { f = { id: newId(), path: p, name: path.basename(p) || p }; folders.push(f); await save(); }
      return { ...f, ...await listing(p) };
    },
    async folders() { return (await load()).map((f) => ({ ...f })); },
    async removeFolder(id) {
      await rootOf(id);
      folders = folders.filter((f) => f.id !== id);
      await save();
      return true;
    },
    async list(id) { return listing(await rootOf(id)); },
    /** a listed symbol file as DXF: { name, format: 'dxf', sourceFormat, bytes }; a DWG goes through the converter */
    async read(id, rel) {
      const f = await readSymbolFile(await rootOf(id), rel);
      if (f.format !== 'dwg') return { name: f.name, format: 'dxf', sourceFormat: 'dxf', bytes: f.bytes };
      const { dxfBytes } = await toDxf(f.bytes);
      return { name: f.name, format: 'dxf', sourceFormat: 'dwg', bytes: dxfBytes };
    },
    /** the cached PNG thumbnail or null; a hit is touched so the cache prunes least recently used first */
    async thumbGet(id, rel) {
      const p = await thumbFile(id, rel);
      let bytes; try { bytes = await fs.readFile(p); } catch { return null; }
      const now = new Date(); await fs.utimes(p, now, now).catch(() => {});
      return new Uint8Array(bytes);
    },
    async thumbPut(id, rel, png) {
      checkPng(png);
      const p = await thumbFile(id, rel);
      await fs.mkdir(cacheDir(), { recursive: true });
      await atomicWrite(p, png);
      cacheBytes = (cacheBytes ?? await pruneThumbCache(cacheDir(), Infinity)) + png.byteLength;
      if (cacheBytes > maxCacheBytes) cacheBytes = await pruneThumbCache(cacheDir(), maxCacheBytes);
      return true;
    },
  };
}
