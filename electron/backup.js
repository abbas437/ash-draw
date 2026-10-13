// Backup copy before a drawing file is overwritten (reviewer #28): "Plan A.dwg" / "Plan A.dxf" -> "Plan A.bak" in the
// same folder, as AutoCAD does; an older .bak is replaced. No Electron imports, so this can be tested in plain Node.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DRAWING = /\.(dxf|dwg)$/i;
/** "<folder>/<name>.bak" for a .dxf/.dwg path, else null (other files get no backup) */
export const backupPathOf = (target) => (DRAWING.test(target) ? path.join(path.dirname(target), `${path.basename(target).replace(DRAWING, '')}.bak`) : null);

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
