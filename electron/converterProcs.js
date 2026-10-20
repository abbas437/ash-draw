// The DWG converters' child processes (LibreDWG dwg2dxf / dxf2dwg, the ODA File Converter) and their temp folders.
// - one registry of the live children and folders, so that quitting the app kills them and removes the folders
//   (main.js: will-quit -> converterProcs.killAll());
// - runConverter: runs one converter; a timeout or a cancel escalates to a hard kill (the whole process tree on
//   Windows: ODA starts processes of its own) and stops waiting for a process that never closes;
// - sweepConverterTemp: at start-up, removes the folders that a killed run (or Windows ending the app) left behind.
//
// No Electron imports here, so this module can be unit-tested in plain Node.
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';

export const KILL_GRACE_MS = 5000; // SIGTERM -> hard kill
export const CLOSE_WAIT_MS = 5000; // hard kill -> give up waiting for 'close'
export const SWEEP_MIN_AGE_MS = 2 * 60 * 60_000; // younger folders may belong to a conversion running now (ODA's limit is 1 hour)
/** the converters' temp folders: fs.mkdtemp(<tmpRoot>/ash-dwg- | ash-oda-) adds 6 characters */
export const CONVERTER_TEMP = /^ash-(?:dwg|oda)-[A-Za-z0-9]{6}$/;

export const cancelledError = () => Object.assign(new Error('The DWG conversion was cancelled.'), { code: 'CANCELLED' });

/** Kills a child at once (synchronous): on Windows with the processes it started (`taskkill /pid <pid> /T /F`), else SIGKILL. */
export function killTree(child, platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', timeout: 5000 });
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

export function createConverterRegistry({ platform = process.platform } = {}) {
  const children = new Set();
  const dirs = new Set();
  return {
    /** -> untrack() */
    addChild(child) { children.add(child); return () => children.delete(child); },
    addDir(dir) { dirs.add(dir); },
    removeDir(dir) { dirs.delete(dir); },
    live() { return { children: [...children], dirs: [...dirs] }; },
    /** quit: kill every live converter, then remove every temp folder (synchronous: the process is about to exit) */
    killAll() {
      for (const c of children) killTree(c, platform);
      children.clear();
      for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* swept at the next start */ }
      }
      dirs.clear();
    },
  };
}

/** the app's registry, shared by both converter bridges */
export const converterProcs = createConverterRegistry();

/**
 * Runs a converter (no shell, hidden window) until it closes; stdout (when `stdout`) and stderr chunks go to onOutput.
 * After `timeout` ms it is stopped: on POSIX SIGTERM, then a hard kill after graceMs; on Windows the whole tree at once
 * (killing there is never graceful, and once the parent is gone its children can no longer be found by the tree).
 * An aborted `signal` (Cancel) kills it hard at once. A process still not closed closeWaitMs after the hard kill is
 * given up (`stuck`). Never rejects: resolves {code, signal, timedOut, cancelled, stuck} or {error, ...} (spawn failure).
 */
export function runConverter(file, args, { cwd, timeout, signal = null, registry = converterProcs, platform = process.platform,
  graceMs, closeWaitMs, stdout = false, onOutput = null }) {
  graceMs ??= KILL_GRACE_MS;
  closeWaitMs ??= CLOSE_WAIT_MS;
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ code: null, signal: null, timedOut: false, cancelled: true, stuck: false }); return; }
    let timedOut = false, cancelled = false, hardKilled = false, settled = false;
    const timers = [];
    const child = spawn(file, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', stdout ? 'pipe' : 'ignore', 'pipe'] });
    const untrack = registry.addChild(child);
    const onAbort = () => { if (!timedOut && !cancelled) { cancelled = true; hard(); } };
    const done = (v) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener('abort', onAbort);
      untrack();
      resolve({ code: null, signal: null, stuck: false, ...v, timedOut, cancelled });
    };
    function hard() {
      if (hardKilled) return;
      hardKilled = true;
      killTree(child, platform);
      timers.push(setTimeout(() => done({ stuck: true }), closeWaitMs));
    }
    timers.push(setTimeout(() => {
      timedOut = true;
      if (platform === 'win32') hard();
      else { child.kill('SIGTERM'); timers.push(setTimeout(hard, graceMs)); }
    }, timeout));
    signal?.addEventListener('abort', onAbort);
    if (onOutput) { child.stdout?.on('data', onOutput); child.stderr?.on('data', onOutput); }
    child.on('error', (error) => done({ error }));
    child.on('close', (code, sig) => done({ code, signal: sig }));
  });
}

/**
 * Removes converter temp folders (CONVERTER_TEMP names only) directly under `root` that were last modified more than
 * minAgeMs ago. Symbolic links are never followed or removed. Returns the names removed.
 */
export async function sweepConverterTemp(root, { minAgeMs = SWEEP_MIN_AGE_MS, now = Date.now() } = {}) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  for (const d of entries) {
    if (!d.isDirectory() || !CONVERTER_TEMP.test(d.name)) continue; // a Dirent of a symlink is not a directory
    const p = path.join(root, d.name);
    try {
      const st = await fs.lstat(p);
      if (!st.isDirectory() || now - st.mtimeMs < minAgeMs) continue;
      await fs.rm(p, { recursive: true, force: true }); // removes links inside, never what they point to
      removed.push(d.name);
    } catch { /* in use or gone: next start */ }
  }
  return removed;
}
