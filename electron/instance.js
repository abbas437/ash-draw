// Marker file in userData that tells a second, different copy of the app (installed vs portable) that another one is
// already using the same settings/autosave folder. Pure helpers: main.js supplies the paths and the pid check.
import { promises as fs, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const MARKER = 'instance.json';

export function pidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } // EPERM: exists, not ours
}

const samePath = (a, b, win) => (win ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** Reads the marker; null when missing or corrupt. */
export async function readMarker(dir) {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
    return m && typeof m === 'object' && Number.isInteger(m.pid) && typeof m.exe === 'string' ? m : null;
  } catch { return null; }
}

/** The marker of another live copy running from a different exe, else null (missing, corrupt, dead pid or same exe). */
export async function foreignInstance(dir, { exe, pid = process.pid, alive = pidAlive, win = process.platform === 'win32' }) {
  const m = await readMarker(dir);
  if (!m || m.pid === pid || !alive(m.pid) || samePath(m.exe, exe, win)) return null;
  return m;
}

export function warningText(m) {
  return `Another copy of ASH Draw Studio is running from ${m.exe}${m.version ? ` (version ${m.version})` : ''}. `
    + 'Both share the same settings and autosave folder; changes made in one may be overwritten by the other. Close one of them.';
}

/** Records this process as the owner of the folder (replaces a stale or foreign marker). */
export async function writeMarker(dir, { exe, version, pid = process.pid, started = new Date().toISOString() }) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify({ pid, exe, version, started }));
}

/** Removes the marker only if it is ours, so quitting never deletes another copy's marker. */
export async function removeMarker(dir, pid = process.pid) {
  const m = await readMarker(dir);
  if (m && m.pid === pid) await fs.rm(path.join(dir, MARKER), { force: true });
}

/** Sync twin of removeMarker, for will-quit (async work is not awaited there). */
export function removeMarkerSync(dir, pid = process.pid) {
  try {
    const m = JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8'));
    if (m?.pid === pid) rmSync(path.join(dir, MARKER), { force: true });
  } catch { /* missing or corrupt: nothing of ours to remove */ }
}
