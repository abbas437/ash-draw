// Symbol library folders (Symbols panel): the .dxf/.dwg files under a folder the user chose in a dialog, listed
// recursively with a cap. The renderer never names a file to read: it names a listed folder and a path relative to it,
// which must be a listed symbol file. No Electron imports: testable in plain Node.
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
