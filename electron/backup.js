// Backup copy before a drawing file is overwritten (reviewer #28): "Plan A.dwg" -> "Plan A.bak" in the same folder, as
// AutoCAD does; "Plan A.dxf" -> "Plan A.dxf.bak", so a .dwg and a .dxf of the same name never share (and overwrite) one
// backup. An older .bak is replaced. No Electron imports, so this can be tested in plain Node.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** "<folder>/<name>.bak" for a .dwg path, "<folder>/<name>.dxf.bak" for a .dxf path, else null (no backup) */
export function backupPathOf(target) {
  if (/\.dwg$/i.test(target)) return path.join(path.dirname(target), `${path.basename(target).replace(/\.dwg$/i, '')}.bak`);
  if (/\.dxf$/i.test(target)) return `${target}.bak`;
  return null;
}

/**
 * Write `bytes` to `target` with `write(target, bytes)` (the caller's atomic write). When `target` is an existing
 * .dxf/.dwg file it is first copied to its .bak; if that copy fails nothing is written (the error is thrown).
 * Returns the backup path, or null when no backup was made.
 */
export async function writeWithBackup(target, bytes, write) {
  const bak = backupPathOf(target);
  const exists = bak && (await fs.stat(target).then((s) => s.isFile(), () => false));
  if (exists) {
    try { await fs.copyFile(target, bak); } catch (err) { throw new Error(`Could not make the backup copy ${path.basename(bak)} (${err.code ?? err.message}); the file was not saved.`); }
  }
  await write(target, bytes);
  return exists ? bak : null;
}

/** write through a temporary file in the same folder, renamed over `target` (no half-written file on a crash) */
export async function atomicWrite(target, bytes) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx' });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** The write behind main's file:write and dialog:save: an existing .dxf/.dwg is copied to its .bak first, then
 *  `bytes` are written atomically. Returns {path, backup} (backup: the .bak path, or null). */
export async function saveDrawingFile(target, bytes) {
  return { path: target, backup: await writeWithBackup(target, bytes, atomicWrite) };
}
