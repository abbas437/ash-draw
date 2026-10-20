// Backup copy before a drawing file is overwritten (reviewer #28): "Plan A.dwg" -> "Plan A.bak" in the same folder, as
// AutoCAD does; "Plan A.dxf" -> "Plan A.dxf.bak", so a .dwg and a .dxf of the same name never share (and overwrite) one
// backup. An older .bak is replaced. No Electron imports, so this can be tested in plain Node.
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** "<folder>/<name>.bak" for a .dwg path, "<folder>/<name>.dxf.bak" for a .dxf path, else null (no backup) */
export function backupPathOf(target) {
  if (/\.dwg$/i.test(target)) return path.join(path.dirname(target), `${path.basename(target).replace(/\.dwg$/i, '')}.bak`);
  if (/\.dxf$/i.test(target)) return `${target}.bak`;
  return null;
}

/** a hidden temporary file next to `p` (same folder, so a rename over `p` stays on one volume) */
const tempPathOf = (p) => path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);

// A sync client (OneDrive, Google Drive) or a virus scanner often holds a just-written file for a moment, and a file
// open in another program cannot be renamed over on Windows: the rename is retried, about 2 s in all (reviewer #19).
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const RENAME_RETRY_MS = [100, 200, 300, 500, 900]; // the waits between 6 tries
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function retried(fn, { delays = RENAME_RETRY_MS, sleep = wait } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err) {
      if (!BUSY.has(err?.code) || i >= delays.length) throw err;
      await sleep(delays[i]);
    }
  }
}

/**
 * The error shown when `target` could not be saved: plain language naming the file, `.code` and `.cause` kept.
 * `inUse`: the error came from opening `target` itself for writing (a lock or a read-only file), not from its folder.
 */
export function saveError(err, target, { inUse = false } = {}) {
  const code = err?.code;
  const denied = code === 'EPERM' || code === 'EACCES';
  const msg = inUse && (code === 'EBUSY' || code === 'ETXTBSY')
    ? `The file is in use by another program (for example AutoCAD or a sync client): ${target}. Close it there and save again, or use Save As.`
    : code === 'ENOSPC' || code === 'EDQUOT'
      ? `The disk is full: ${target} could not be saved. Free some space on that drive and save again, or use Save As to save it on another drive.`
      : inUse && denied
        ? `You don't have permission to write to ${target} (the file may be read-only). Use Save As to save it under another name or in another folder.`
        : denied || code === 'EROFS'
          ? `You don't have permission to write to this folder: ${path.dirname(target)}. ${path.basename(target)} was not saved; use Save As to save it in another folder.`
          : `${target} could not be saved (${err?.message ?? err}).`;
  return Object.assign(new Error(msg, { cause: err }), code ? { code } : {});
}

async function writeAll(h, buf) {
  for (let off = 0; off < buf.length;) {
    const { bytesWritten } = await h.write(buf, off, buf.length - off, off);
    if (!bytesWritten) throw Object.assign(new Error('nothing was written'), { code: 'EIO' });
    off += bytesWritten;
  }
  await h.truncate(buf.length);
  await h.sync();
}

// The rename did not go through: write the content over `target` itself, only when it can be opened for writing
// (a file locked by another program cannot, and is then left alone). A copy of the previous content is made first and
// written back if the write fails part-way, so a failed save does not leave a half-written file.
async function writeInPlace(target, buf, fs) {
  let h;
  try { h = await fs.open(target, 'r+'); } catch (err) {
    if (err?.code !== 'ENOENT') throw saveError(err, target, { inUse: true });
    try { await fs.writeFile(target, buf, { flag: 'wx' }); return; } catch (e) { // a new file whose temp file could not be renamed
      if (e?.code !== 'EEXIST') await fs.rm(target, { force: true }).catch(() => {});
      throw saveError(e, target, { inUse: true });
    }
  }
  const prev = tempPathOf(target);
  let keepPrev = false;
  try {
    try { await fs.copyFile(target, prev); } catch (err) { throw saveError(err, target); }
    try { await writeAll(h, buf); } catch (err) {
      try { await writeAll(h, await fs.readFile(prev)); } catch { keepPrev = true; }
      const e = saveError(err, target);
      if (keepPrev) e.message += ` Its previous content is kept in ${prev}.`;
      throw e;
    }
  } finally {
    await h.close().catch(() => {});
    if (!keepPrev) await fs.rm(prev, { force: true }).catch(() => {});
  }
}

/**
 * Save `bytes` as `target`: written to a temporary file in the same folder, then renamed over `target` (no half-written
 * file on a crash). A rename refused as busy (EPERM/EBUSY/EACCES) is retried; if it is still refused, the content is
 * written over `target` in place when `target` is not locked. On failure `target` is unchanged, the temporary file is
 * removed and the error is a plain-language one (saveError). `fs`, `delays`, `sleep`: for tests.
 */
export async function replaceFile(target, bytes, { fs = fsp, delays, sleep } = {}) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tmp = tempPathOf(target);
  try {
    try { await fs.writeFile(tmp, buf, { flag: 'wx' }); } catch (err) { throw saveError(err, target); }
    try { await retried(() => fs.rename(tmp, target), { delays, sleep }); return; } catch (err) {
      if (!BUSY.has(err?.code)) throw saveError(err, target);
    }
    await writeInPlace(target, buf, fs);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Write `bytes` to `target` with `write(target, bytes)`. When `target` is an existing .dxf/.dwg file, its content is
 * first copied to a temporary file; if that copy fails nothing is written (the error is thrown). Only once the write
 * succeeded does that copy replace the older .bak, so a failed save leaves both the file and its .bak as they were.
 * Returns the backup path, or null when no backup was made (none needed, or the older .bak could not be replaced).
 */
export async function writeWithBackup(target, bytes, write, { fs = fsp, delays, sleep } = {}) {
  const bak = backupPathOf(target);
  const exists = bak && (await fs.stat(target).then((s) => s.isFile(), () => false));
  if (!exists) { await write(target, bytes); return null; }
  const fail = (err) => new Error(`Could not make the backup copy ${path.basename(bak)} (${err.code ?? err.message}); the file was not saved.`);
  // something other than a file at the .bak path could not be replaced after the save: refuse before writing
  const blocked = await fs.stat(bak).then((s) => (s.isFile() ? null : { code: 'EISDIR' }), (err) => (err.code === 'ENOENT' ? null : err));
  if (blocked) throw fail(blocked);
  const copy = tempPathOf(bak);
  try { await fs.copyFile(target, copy); } catch (err) { await fs.rm(copy, { force: true }).catch(() => {}); throw fail(err); }
  try { await write(target, bytes); } catch (err) { await fs.rm(copy, { force: true }).catch(() => {}); throw err; }
  try { await retried(() => fs.rename(copy, bak), { delays, sleep }); return bak; } catch { // saved; the older .bak stays
    await fs.rm(copy, { force: true }).catch(() => {});
    return null;
  }
}

/** write through a temporary file in the same folder, renamed over `target` (no half-written file on a crash) */
export async function atomicWrite(target, bytes) {
  const tmp = tempPathOf(target);
  try {
    await fsp.writeFile(tmp, bytes, { flag: 'wx' });
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/** The write behind main's file:write and dialog:save: an existing .dxf/.dwg's content becomes its .bak once the new
 *  content is saved (writeWithBackup over replaceFile). Returns {path, backup} (backup: the .bak path, or null).
 *  `opts` ({fs, delays, sleep}): for tests. */
export async function saveDrawingFile(target, bytes, opts = {}) {
  return { path: target, backup: await writeWithBackup(target, bytes, (t, b) => replaceFile(t, b, opts), opts) };
}
