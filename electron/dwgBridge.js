// DWG <-> DXF bridge over the separately-distributed LibreDWG command-line tools.
//
// Licence boundary: LibreDWG (GPL-3.0-or-later) is never linked or loaded into this
// process. The unmodified dwg2dxf / dxf2dwg executables run as child processes via
// execFile (no shell) with a fixed argument list; data crosses the boundary only as
// files in a private temporary directory.
//
// No Electron imports here, so this module can be unit-tested in plain Node.
import { execFile } from 'node:child_process';
import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_BYTES = 200 * 1024 * 1024; // input/output size cap
export const TIMEOUT_MS = 120_000;
export const MAX_BUFFER = 10 * 1024 * 1024; // stdout/stderr capture cap
export const STDERR_LIMIT = 4096; // characters of stderr surfaced in errors
// Versions dxf2dwg 0.13.3 accepts for `--as` AND can actually encode
// ("Encoding currently only works for R13-R2000"; r12 is accepted but not encoded).
export const DWG_OUT_VERSIONS = Object.freeze(['r2000', 'r14']);
export const DEFAULT_DWG_OUT_VERSION = 'r2000';

/** Path of a converter executable for the given platform. */
export function converterPath(dir, platform, name) {
  return path.join(dir, platform === 'win32' ? `${name}.exe` : name);
}

function trimStderr(s) {
  const t = String(s ?? '').trim();
  return t.length > STDERR_LIMIT ? `${t.slice(0, STDERR_LIMIT)}\n...[truncated]` : t;
}

function toBuffer(bytes, what, maxBytes) {
  let buf;
  if (Buffer.isBuffer(bytes)) buf = bytes;
  else if (bytes instanceof Uint8Array) buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else if (bytes instanceof ArrayBuffer) buf = Buffer.from(bytes);
  else throw new TypeError(`${what} must be a Uint8Array or ArrayBuffer`);
  if (buf.length === 0) throw new RangeError(`${what} is empty`);
  if (buf.length > maxBytes) throw new RangeError(`${what} is ${buf.length} bytes; the limit is ${maxBytes} bytes`);
  return buf;
}

function run(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}

function describeFailure(name, err, timeoutMs) {
  const stderr = trimStderr(err.stderr);
  let why;
  if (err.code === 'ENOENT') why = 'executable not found';
  else if (err.killed && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL') && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    why = `timed out after ${Math.round(timeoutMs / 1000)} s`;
  } else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') why = 'produced too much console output';
  else if (typeof err.code === 'number') why = `exit code ${err.code}`;
  else why = err.signal ? `terminated by ${err.signal}` : err.message;
  const e = new Error(`${name} failed (${why})${stderr ? `: ${stderr}` : ''}`);
  e.stderr = stderr;
  return e;
}

/**
 * @param {string} dir       folder holding dwg2dxf[.exe] / dxf2dwg[.exe]
 * @param {string} platform  process.platform value deciding the executable suffix
 * @param {{tmpRoot?: string, timeoutMs?: number, maxBytes?: number}} [opts]
 */
export function createDwgBridge(dir, platform = process.platform, opts = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir must be a non-empty string');
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const dwg2dxf = converterPath(dir, platform, 'dwg2dxf');
  const dxf2dwg = converterPath(dir, platform, 'dxf2dwg');
  const execOpts = (cwd, timeout) => ({
    cwd, timeout, windowsHide: true, maxBuffer: MAX_BUFFER, shell: false, encoding: 'utf8',
  });
  let availability = null;

  async function probe() {
    const mode = platform === 'win32' ? fsc.F_OK : fsc.X_OK;
    const required = [dwg2dxf, dxf2dwg];
    if (platform === 'win32') required.push(path.join(dir, 'libredwg-0.dll'));
    for (const f of required) {
      try { await fs.access(f, mode); } catch {
        return { available: false, version: null, reason: `LibreDWG converter missing: ${path.basename(f)} in ${dir}` };
      }
    }
    try {
      const { stdout, stderr } = await run(dwg2dxf, ['--version'], execOpts(dir, 15_000));
      const text = `${stdout}\n${stderr}`;
      const m = text.match(/(\d+\.\d+(?:\.\d+)*(?:[-.\w]*)?)/);
      return { available: true, version: m ? m[1] : text.trim().split('\n')[0] || 'unknown' };
    } catch (err) {
      return { available: false, version: null, reason: describeFailure('dwg2dxf --version', err, 15_000).message };
    }
  }

  async function convert(name, exe, input, inExt, outExt, extraArgs) {
    const tmp = await fs.mkdtemp(path.join(tmpRoot, 'ash-dwg-'));
    try {
      const inPath = path.join(tmp, `input.${inExt}`);
      const outPath = path.join(tmp, `output.${outExt}`);
      await fs.writeFile(inPath, input);
      let stderr = '';
      try {
        ({ stderr } = await run(exe, [...extraArgs, '-y', '-o', outPath, inPath], execOpts(tmp, timeoutMs)));
      } catch (err) {
        throw describeFailure(name, err, timeoutMs);
      }
      let st;
      try { st = await fs.stat(outPath); } catch {
        const s = trimStderr(stderr);
        throw new Error(`${name} produced no output${s ? `: ${s}` : ''}`);
      }
      if (st.size === 0) throw new Error(`${name} produced an empty file`);
      if (st.size > maxBytes) throw new RangeError(`${name} output exceeds ${maxBytes} bytes`);
      return new Uint8Array(await fs.readFile(outPath));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  return {
    dir,
    /** @returns {Promise<{available:boolean, version:string|null, reason?:string}>} */
    available() {
      availability ??= probe();
      return availability;
    },
    /** DWG bytes -> {dxfBytes} */
    async toDxf(dwgBytes) {
      const input = toBuffer(dwgBytes, 'DWG data', maxBytes);
      return { dxfBytes: await convert('dwg2dxf', dwg2dxf, input, 'dwg', 'dxf', []) };
    },
    /** DXF bytes -> {dwgBytes}; version one of DWG_OUT_VERSIONS (default r2000) */
    async fromDxf(dxfBytes, version = DEFAULT_DWG_OUT_VERSION) {
      const v = version ?? DEFAULT_DWG_OUT_VERSION;
      if (!DWG_OUT_VERSIONS.includes(v)) {
        throw new RangeError(`unsupported DWG output version ${JSON.stringify(v)}; use one of ${DWG_OUT_VERSIONS.join(', ')}`);
      }
      const input = toBuffer(dxfBytes, 'DXF data', maxBytes);
      return { dwgBytes: await convert('dxf2dwg', dxf2dwg, input, 'dxf', 'dwg', ['--as', v]) };
    },
  };
}
