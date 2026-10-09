// DWG -> DXF through the ODA File Converter (free download from the Open Design Alliance; it cannot be bundled,
// the user installs it) plus the engine choice/fallback between it and the built-in LibreDWG bridge.
//
// Command line, as used by FreeCAD (src/Mod/Draft/importDWG.py: [oda, indir, outdir, "ACAD2000", "DXF", "0", "1", basename])
// and documented by ezdxf (addons/odafc):
//   ODAFileConverter.exe "<input folder>" "<output folder>" <output version> <output type DXF|DWG|DXB> <recurse 0|1> <audit 0|1> ["<input filter>"]
// It runs via execFile (no shell, windowsHide) with a fixed argument array; only fixed names reach argv.
//
// No Electron imports here, so this module can be unit-tested in plain Node with a stub converter script.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ODA_TIMEOUT_MS = 10 * 60_000;
export const ODA_MAX_BYTES = 1536 * 1024 * 1024; // same cap as the LibreDWG bridge
export const ODA_OUT_VERSION = 'ACAD2018';
export const ODA_EXE = 'ODAFileConverter.exe';
export const ODA_DOWNLOAD_URL = 'https://www.opendesign.com/guestfiles/oda_file_converter';
export const DWG_MODES = Object.freeze(['auto', 'oda', 'libredwg']);
export const ODA_HINT = 'The built-in converter could not read this DWG (AutoCAD 2018 format files from some programs are not fully supported). Install the free ODA File Converter (opendesign.com) and ASH Draw Studio will use it automatically.';
const IN_NAME = 'drawing.dwg';

/** Only an executable named ODAFileConverter[.exe] is ever run (a settings value cannot name another program). */
export const isOdaExeName = (p) => typeof p === 'string' && /^ODAFileConverter(\.exe)?$/i.test(path.basename(p));

/** "ODAFileConverter 25.12.0" -> [25, 12, 0]; no number -> [] */
const versionOf = (dirName) => (/(\d+(?:\.\d+)*)/.exec(dirName)?.[1] ?? '').split('.').filter(Boolean).map(Number);
function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1);
  return false;
}

/**
 * Newest <root>/ODA/ODAFileConverter*<version>/ODAFileConverter.exe under the given Program Files roots, or null.
 * Reads directory listings only (no shell).
 */
export async function findOdaConverter(roots) {
  let best = null;
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue;
    const odaDir = path.join(root, 'ODA');
    let entries;
    try { entries = await fs.readdir(odaDir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      if (!d.isDirectory() || !/^ODAFileConverter/i.test(d.name)) continue;
      const exe = path.join(odaDir, d.name, ODA_EXE);
      if (!(await fs.stat(exe).then((s) => s.isFile(), () => false))) continue;
      const v = versionOf(d.name);
      if (!best || newer(v, best.v)) best = { exe, v };
    }
  }
  return best ? best.exe : null;
}

/** Version string from the install folder name ("ODAFileConverter 25.12.0" -> "25.12.0"), or "unknown". */
export const odaVersion = (exe) => versionOf(path.basename(path.dirname(exe))).join('.') || 'unknown';

function run(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
  });
}

/**
 * @param {string} exe  ODAFileConverter executable
 * @param {{tmpRoot?: string, timeoutMs?: number, maxBytes?: number, version?: string}} [opts]
 */
export function createOdaBridge(exe, opts = {}) {
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();
  const timeoutMs = opts.timeoutMs ?? ODA_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? ODA_MAX_BYTES;
  return {
    exe,
    version: opts.version ?? odaVersion(exe),
    /** DWG bytes -> {dxfBytes} (ASCII DXF, ACAD2018, audit on); the temp folder is always removed. */
    async toDxf(dwgBytes) {
      const input = Buffer.from(dwgBytes.buffer ?? dwgBytes, dwgBytes.byteOffset ?? 0, dwgBytes.byteLength);
      if (input.length === 0) throw new RangeError('DWG data is empty');
      if (input.length > maxBytes) throw new RangeError(`DWG data is ${input.length} bytes; the limit is ${maxBytes} bytes`);
      const tmp = await fs.mkdtemp(path.join(tmpRoot, 'ash-oda-'));
      try {
        const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out');
        await fs.mkdir(inDir); await fs.mkdir(outDir);
        await fs.writeFile(path.join(inDir, IN_NAME), input);
        const args = [inDir, outDir, ODA_OUT_VERSION, 'DXF', '0', '1', IN_NAME];
        try {
          await run(exe, args, { cwd: tmp, timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
        } catch (err) {
          let why;
          if (err.code === 'ENOENT') why = 'executable not found';
          else if (err.killed && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') why = `timed out after ${Math.round(timeoutMs / 1000)} s`;
          else if (typeof err.code === 'number') why = `exit code ${err.code}`;
          else why = err.signal ? `terminated by ${err.signal}` : err.message;
          throw new Error(`ODA File Converter failed (${why})`);
        }
        const names = await fs.readdir(outDir);
        const dxf = names.find((n) => /\.dxf$/i.test(n));
        if (!dxf) {
          const errFile = names.find((n) => /\.err$/i.test(n));
          const detail = errFile ? (await fs.readFile(path.join(outDir, errFile), 'utf8')).trim().slice(0, 4096) : '';
          throw new Error(`ODA File Converter produced no DXF${detail ? `: ${detail}` : ''}`);
        }
        const st = await fs.stat(path.join(outDir, dxf));
        if (st.size === 0) throw new Error('ODA File Converter produced an empty file');
        if (st.size > maxBytes) throw new RangeError(`ODA File Converter output exceeds ${maxBytes} bytes`);
        return { dxfBytes: new Uint8Array(await fs.readFile(path.join(outDir, dxf))) };
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Engine choice and fallback. `getConfig()` -> {mode: 'auto'|'oda'|'libredwg', odaPath?: string} read at every call;
 * `detectOda()` -> auto-detected executable or null; `makeOda(exe)` -> ODA bridge.
 * Automatic: ODA first when installed, else LibreDWG; when the first engine fails the other is tried.
 */
export function createDwgService({ libre, getConfig, detectOda, makeOda }) {
  async function oda() {
    const { odaPath } = getConfig();
    if (odaPath) {
      if (isOdaExeName(odaPath) && path.isAbsolute(odaPath) && (await fs.stat(odaPath).then((s) => s.isFile(), () => false))) return { exe: odaPath, source: 'setting' };
      return { exe: null, reason: `ODA File Converter not found at ${odaPath}` };
    }
    const exe = await detectOda();
    return exe ? { exe, source: 'auto' } : { exe: null, reason: 'ODA File Converter is not installed' };
  }
  const modeOf = () => (DWG_MODES.includes(getConfig().mode) ? getConfig().mode : 'auto');
  async function engines() {
    const mode = modeOf();
    const o = mode === 'libredwg' ? null : await oda();
    const order = [];
    if (o?.exe) order.push({ name: 'oda', bridge: makeOda(o.exe) });
    if (mode !== 'oda') order.push({ name: 'libredwg', bridge: libre });
    return { mode, oda: o, order };
  }
  return {
    async available() {
      const { mode, oda: o, order } = await engines();
      const lib = mode === 'oda' ? null : await libre.available();
      const odaInfo = o?.exe ? { available: true, path: o.exe, source: o.source, version: odaVersion(o.exe) } : { available: false, reason: o?.reason ?? 'not used (Built-in selected)' };
      const usable = order.filter((e) => e.name === 'oda' || lib?.available);
      const first = usable[0]?.name ?? null;
      return {
        available: !!first, mode, engine: first,
        version: first === 'oda' ? `ODA File Converter ${odaInfo.version}` : first ? `LibreDWG ${lib.version}` : null,
        reason: first ? undefined : (mode === 'oda' ? odaInfo.reason : lib?.reason),
        oda: odaInfo, libredwg: lib ?? { available: false, reason: 'not used (ODA File Converter selected)' },
      };
    },
    /** DWG bytes -> {dxfBytes, warnings?, engine}; errors carry `odaHint` when installing ODA would help. */
    async toDxf(dwgBytes) {
      const { mode, order } = await engines();
      const errors = [];
      for (const e of order) {
        try { return { ...(await e.bridge.toDxf(dwgBytes)), engine: e.name }; } catch (err) { errors.push(`${e.name === 'oda' ? 'ODA File Converter' : 'LibreDWG'}: ${String(err.message || err).split('\n')[0]}`); }
      }
      const odaTried = order.some((e) => e.name === 'oda');
      const msg = odaTried ? `This DWG file could not be converted (${errors.join('; ')}).`
        : `${ODA_HINT}${mode === 'libredwg' ? ' (Preferences > DWG converter must be Automatic or ODA File Converter.)' : ''} [${errors.join('; ') || 'no converter available'}]`;
      throw Object.assign(new Error(msg), { odaHint: !odaTried });
    },
    fromDxf: (dxfBytes, version) => libre.fromDxf(dxfBytes, version),
  };
}
