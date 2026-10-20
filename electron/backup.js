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

/** a temporary file next to `p` (same folder, so a rename over `p` stays on one volume): ".<name>.<pid>-<8 hex>.<ext>".
 *  `ext` 'prev' names the copy of the previous content made before an in-place write: it is the copy to recover from if
 *  that write is cut off (a crash), so the sweep of stale temporary files (sweepStaleTemps) never matches it. */
const tempPathOf = (p, ext = 'tmp') => path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}-${randomBytes(4).toString('hex')}.${ext}`);

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

/** remove a temporary file of ours; a sync client or scanner holding it is waited for (retried), then it is left */
const removeTemp = (fs, p, opts) => retried(() => fs.rm(p, { force: true }), opts).catch(() => {});

/** flush `p` (already written and closed) to the disk, so a power loss cannot leave it empty or garbled */
async function syncPath(fs, p) {
  const h = await fs.open(p, 'r+');
  try { await h.sync(); } finally { await h.close().catch(() => {}); }
}

export const STALE_TEMP_MS = 10 * 60 * 1000;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Remove the temporary files replaceFile left next to `target` in an earlier save (a crash, or a sync client that held
 *  them): exactly ".<name>.<pid>-<8 hex>.tmp", a file, last changed over 10 minutes ago. Nothing else is touched. */
async function sweepStaleTemps(target, fs, now = Date.now()) {
  const dir = path.dirname(target);
  const own = new RegExp(`^\\.${escapeRe(path.basename(target))}\\.\\d+-[0-9a-f]{8}\\.tmp$`);
  for (const name of (await fs.readdir(dir).catch(() => [])).filter((n) => own.test(n))) {
    const p = path.join(dir, name);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile() && now - st.mtimeMs > STALE_TEMP_MS) await fs.rm(p, { force: true }).catch(() => {});
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
// written back if the write fails part-way, so a failed save does not leave a half-written file. The previous content
// is read through our own handle: on Windows a copy (CopyFileW) or a second open for reading of a file we hold open for
// writing is refused as a sharing violation. The copy is flushed to the disk before the first byte of `target` changes.
async function writeInPlace(target, buf, fs, opts) {
  let h;
  try { h = await fs.open(target, 'r+'); } catch (err) {
    if (err?.code !== 'ENOENT') throw saveError(err, target, { inUse: true });
    try { await fs.writeFile(target, buf, { flag: 'wx' }); return; } catch (e) { // a new file whose temp file could not be renamed
      if (e?.code !== 'EEXIST') await fs.rm(target, { force: true }).catch(() => {});
      throw saveError(e, target, { inUse: true });
    }
  }
  const prev = tempPathOf(target, 'prev');
  let keepPrev = false, made = false;
  try {
    let old;
    try {
      old = await h.readFile();
      const ph = await fs.open(prev, 'wx');
      made = true;
      try { await writeAll(ph, old); } finally { await ph.close().catch(() => {}); }
    } catch (err) { throw saveError(err, target); }
    try { await writeAll(h, buf); } catch (err) {
      try { await writeAll(h, old); } catch { keepPrev = true; }
      const e = saveError(err, target);
      if (keepPrev) e.message += ` Its previous content is kept in ${prev}.`;
      throw e;
    }
  } finally {
    await h.close().catch(() => {});
    if (made && !keepPrev) await removeTemp(fs, prev, opts);
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
  await sweepStaleTemps(target, fs);
  const tmp = tempPathOf(target);
  try {
    try { await fs.writeFile(tmp, buf, { flag: 'wx' }); await syncPath(fs, tmp); } catch (err) { throw saveError(err, target); }
    try { await retried(() => fs.rename(tmp, target), { delays, sleep }); return; } catch (err) {
      if (!BUSY.has(err?.code)) throw saveError(err, target);
    }
    await writeInPlace(target, buf, fs, { delays, sleep });
  } finally {
    await removeTemp(fs, tmp, { delays, sleep });
  }
}

/** "Plan A (previous 2026-10-20 14-32-05).bak" for "Plan A.bak": where the previous version is kept when the .bak itself
 *  cannot be replaced (open in another program, or held by a sync client) */
export function keptPathOf(bak, date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ${p2(date.getHours())}-${p2(date.getMinutes())}-${p2(date.getSeconds())}`;
  return `${bak.replace(/\.bak$/i, '')} (previous ${stamp}).bak`;
}

/**
 * Write `bytes` to `target` with `write(target, bytes)`. When `target` is an existing .dxf/.dwg file, its content is
 * first copied to a temporary file (flushed to the disk); if that copy fails nothing is written (the error is thrown).
 * Only once the write succeeded does that copy replace the older .bak, so a failed save leaves both the file and its
 * .bak as they were. Returns {backup, warning?}: backup is the path the previous content was kept as (null: none
 * needed, or it could not be kept); warning (only when the .bak could not be replaced) says so in plain language.
 */
export async function writeWithBackup(target, bytes, write, { fs = fsp, delays, sleep } = {}) {
  const bak = backupPathOf(target);
  const exists = bak && (await fs.stat(target).then((s) => s.isFile(), () => false));
  if (!exists) { await write(target, bytes); return { backup: null }; }
  const fail = (err) => new Error(`Could not make the backup copy ${path.basename(bak)} (${err.code ?? err.message}); the file was not saved.`);
  // something other than a file at the .bak path could not be replaced after the save: refuse before writing
  const blocked = await fs.stat(bak).then((s) => (s.isFile() ? null : { code: 'EISDIR' }), (err) => (err.code === 'ENOENT' ? null : err));
  if (blocked) throw fail(blocked);
  const older = await fs.stat(bak).then(() => true, () => false);
  const copy = tempPathOf(bak);
  const opts = { delays, sleep };
  try { await fs.copyFile(target, copy); await syncPath(fs, copy); } catch (err) { await removeTemp(fs, copy, opts); throw fail(err); }
  try { await write(target, bytes); } catch (err) { await removeTemp(fs, copy, opts); throw err; }
  try { await retried(() => fs.rename(copy, bak), opts); return { backup: bak }; } catch { /* saved; the .bak is held */ }
  // the save went through: keep the previous version under a visible name of its own, and say so
  const name = path.basename(bak);
  const why = `The previous version could not be kept as ${name} (it may be open in another program or held by a sync client)`;
  const kept = keptPathOf(bak);
  try { await retried(() => fs.rename(copy, kept), opts); } catch {
    await removeTemp(fs, copy, opts);
    return { backup: null, warning: `${why}${older ? `; ${name} still holds an older version` : ''}.` };
  }
  return { backup: kept, warning: `${why}; it is kept as ${path.basename(kept)}.` };
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
 *  content is saved (writeWithBackup over replaceFile). Returns {path, backup, warning?} (backup: the path the previous
 *  content was kept as, or null; warning: the .bak could not be replaced, see writeWithBackup).
 *  `opts` ({fs, delays, sleep}): for tests. */
export async function saveDrawingFile(target, bytes, opts = {}) {
  const { backup, warning } = await writeWithBackup(target, bytes, (t, b) => replaceFile(t, b, opts), opts);
  return { path: target, backup, ...(warning ? { warning } : {}) };
}
