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
/** time allowed for one ODA run: at least ODA_TIMEOUT_MS, else 15 s per MB of input (ODA with audit took ~4.5 min for
 *  a 115 MB DWG in its own window on the user's PC and ran past 10 min inside the app), at most 1 hour */
export const odaTimeoutFor = (bytes) => Math.min(60 * 60_000, Math.max(ODA_TIMEOUT_MS, Math.ceil(bytes / (1024 * 1024)) * 15_000));
export const ODA_MAX_BYTES = 1536 * 1024 * 1024; // same cap as the LibreDWG bridge
export const ODA_OUT_VERSION = 'ACAD2018';
/** DWG versions the ODA File Converter writes for Save as DWG (ids as in src/core/dwgpref.js DWG_SAVE_VERSIONS) */
export const ODA_DWG_VERSIONS = Object.freeze({ acad2018: 'ACAD2018', acad2013: 'ACAD2013', acad2010: 'ACAD2010', acad2007: 'ACAD2007', acad2004: 'ACAD2004', acad2000: 'ACAD2000' });
export const ODA_EXE = 'ODAFileConverter.exe';
export const ODA_DOWNLOAD_URL = 'https://www.opendesign.com/guestfiles/oda_file_converter';
export const DWG_MODES = Object.freeze(['auto', 'oda', 'libredwg']);
export const ODA_INSTALL = 'Install the free ODA File Converter (opendesign.com) and ASH Draw Studio will use it automatically.';
export const ODA_HINT = `The built-in converter could not read this DWG (AutoCAD 2018 format files from some programs are not fully supported). ${ODA_INSTALL}`;
// A normal DXF is 5-15x its DWG; the reviewer's failing AutoCAD 2018 file gave 0.2 MB of DXF from 115 MB with 666,694 ERROR lines.
export const IMPLAUSIBLE_MIN_DWG = 2 * 1024 * 1024; // the size rule only applies to DWG files over 2 MB
export const IMPLAUSIBLE_MAX_ERRORS = 100_000;
const mb = (n) => (n < 0.05 * 1048576 ? 'less than 0.1 MB' : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Whether a DWG -> DXF conversion that "succeeded" is too small or too broken to be the drawing: a DWG over 2 MB
 * that gave less than half its size of DXF, or more than 100,000 converter ERROR lines. Sizes in bytes.
 * Returns the reason in plain words, or null when the output is plausible.
 */
export function implausibleConversion({ dwgBytes, dxfBytes, errorCount = 0 }) {
  const errs = errorCount > 0 ? ` and reported ${errorCount.toLocaleString('en-US')} errors` : '';
  if (dwgBytes > IMPLAUSIBLE_MIN_DWG && dxfBytes < dwgBytes / 2) return `a ${mb(dwgBytes)} DWG file gave only ${mb(dxfBytes)} of drawing data${errs}`;
  if (errorCount > IMPLAUSIBLE_MAX_ERRORS) return `the converter reported ${errorCount.toLocaleString('en-US')} errors while reading the ${mb(dwgBytes)} DWG file`;
  return null;
}
/**
 * Blocks that INSERTs reference but that came out of a DWG -> DXF conversion with no entities or with no definition at all (LibreDWG drops the
 * contents of some blocks, e.g. bound xrefs and room tags, so walls and tags vanish without an error).
 * Walks an ASCII DXF (Uint8Array/Buffer) line by line without decoding the whole buffer: in BLOCKS, the entities of
 * each BLOCK..ENDBLK are counted; INSERT names (group 2) are collected in BLOCKS and ENTITIES. Names starting with
 * '*' (model/paper space, anonymous dimension/hatch blocks) are ignored; names compare case-insensitively.
 * Returns {count, names}: how many referenced blocks are empty and up to `limit` of their names, in file order.
 */
export function emptyReferencedBlocks(dxfBytes, limit = 20) {
  const buf = Buffer.isBuffer(dxfBytes) ? dxfBytes : Buffer.from(dxfBytes.buffer, dxfBytes.byteOffset, dxfBytes.byteLength);
  const n = buf.length;
  const blocks = new Map(); // lower-case name -> {name, count}
  const inserted = new Map(); // lower-case name of an inserted block -> its name as first seen
  const defined = new Set(); // lower-case names of every BLOCK definition, '*' blocks included
  let pos = 0;
  let code = null; // group code of the value line that comes next; null: the next line is a group code line
  let section = '';
  let wantSection = false; // the next group 2 names the section
  let block = null; // {name, count} of the BLOCK being read
  let want = 0; // the next group 2 is: 1 the block's name, 2 the INSERT's block name
  while (pos < n) {
    let e = buf.indexOf(0x0a, pos);
    if (e < 0) e = n;
    let s = pos;
    pos = e + 1;
    while (s < e && (buf[s] === 0x20 || buf[s] === 0x09)) s++;
    while (e > s && (buf[e - 1] === 0x0d || buf[e - 1] === 0x20 || buf[e - 1] === 0x09)) e--;
    if (code === null) {
      let v = s < e ? 0 : -1;
      for (let i = s; i < e; i++) {
        const c = buf[i];
        if (c < 0x30 || c > 0x39) { v = -1; break; }
        v = v * 10 + c - 0x30;
      }
      code = v;
      continue;
    }
    const g = code;
    code = null;
    if (g === 0) {
      want = 0;
      wantSection = false;
      const t = e - s <= 32 ? buf.toString('latin1', s, e) : '';
      if (t === 'SECTION') { wantSection = true; section = ''; block = null; }
      else if (t === 'ENDSEC') { section = ''; block = null; }
      else if (section === 'BLOCKS' && t === 'BLOCK') { block = { name: null, count: 0, flags: 0, head: true }; want = 1; }
      else if (section === 'BLOCKS' && t === 'ENDBLK') {
        if (block?.name) defined.add(block.name.toLowerCase());
        // an attached (unbound) xref (flag 4) or an xref-dependent block (16) is empty in the DWG itself: not a loss
        if (block?.name && !block.name.startsWith('*') && !(block.flags & 20)) {
          const key = block.name.toLowerCase();
          const seen = blocks.get(key);
          if (seen) seen.count += block.count; else blocks.set(key, block);
        }
        block = null;
      } else {
        if (block) { block.head = false; block.count++; }
        if (t === 'INSERT' && (section === 'BLOCKS' || section === 'ENTITIES')) want = 2;
      }
    } else if (g === 70 && block?.head) {
      block.flags = Number.parseInt(buf.toString('latin1', s, e), 10) || 0;
    } else if (g === 2) {
      if (wantSection) { section = buf.toString('latin1', s, e); wantSection = false; }
      else if (want === 1) { block.name = buf.toString('utf8', s, e); want = 0; }
      else if (want === 2) { const nm = buf.toString('utf8', s, e); const k = nm.toLowerCase(); if (!inserted.has(k)) inserted.set(k, nm); want = 0; }
    }
  }
  const names = [];
  let count = 0;
  for (const [key, b] of blocks) {
    if (b.count > 0 || !inserted.has(key)) continue;
    count++;
    if (names.length < limit) names.push(b.name);
  }
  // LibreDWG also leaves some blocks out of BLOCKS altogether (seen on a bound drawing: 'room tag', bound xrefs,
  // anonymous *U blocks) while their INSERTs remain: those count as well
  for (const [key, nm] of inserted) {
    if (defined.has(key) || key === '*model_space' || key === '*paper_space') continue;
    count++;
    if (names.length < limit) names.push(nm);
  }
  return { count, names };
}
/** the plain-words warning for LibreDWG output with empty referenced blocks; `odaError` when ODA was tried and failed */
function emptyBlocksWarning({ count, names }, odaError, prefs) {
  // named blocks first: anonymous ones (*U13) mean nothing to the user
  const shown = [...names.filter((nm) => !nm.startsWith('*')), ...names.filter((nm) => nm.startsWith('*'))].slice(0, 5).map((nm) => (nm.length > 40 ? `${nm.slice(0, 39)}…` : nm));
  const eg = shown.length ? ` (e.g. ${shown.join(', ')}${count > shown.length ? ', …' : ''})` : '';
  const what = `${count.toLocaleString('en-US')} ${count === 1 ? 'block' : 'blocks'} came through empty or missing from the built-in converter${eg} — walls, tags or symbols may be missing.`;
  return odaError ? `${what} The ODA File Converter was tried as well but could not convert this DWG (${odaError}).` : `${what} ${ODA_INSTALL}${prefs}`;
}
/** the first lines of a converter log, made safe for the " [detail]" tail of an error message */
const logExcerpt = (log) => String(log ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 20).join('\n').replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'));
const IN_NAME = 'drawing.dwg';
const IN_DXF_NAME = 'drawing.dxf';

/**
 * The converter's argument array: `<inDir> <outDir> <ACADxxxx> <DXF|DWG> 0 1 <input file name>` (no recursion, audit on).
 * `version` is an ODA_DWG_VERSIONS id ('acad2018', ...) for DWG output; DXF output is always ACAD2018.
 */
export function odaArgs(inDir, outDir, outType, version) {
  if (outType === 'DXF') return [inDir, outDir, ODA_OUT_VERSION, 'DXF', '0', '1', IN_NAME];
  if (outType !== 'DWG') throw new RangeError(`unsupported ODA output type ${JSON.stringify(outType)}`);
  if (!Object.hasOwn(ODA_DWG_VERSIONS, version)) throw new RangeError(`unsupported DWG output version ${JSON.stringify(version)}; use one of ${Object.keys(ODA_DWG_VERSIONS).join(', ')}`);
  return [inDir, outDir, ODA_DWG_VERSIONS[version], 'DWG', '0', '1', IN_DXF_NAME];
}

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
  const maxBytes = opts.maxBytes ?? ODA_MAX_BYTES;
  /** run the converter on one input file in a private temp folder and return the single output file's bytes */
  async function convert(bytes, inKind, inName, outType, version) {
    const input = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
    if (input.length === 0) throw new RangeError(`${inKind} data is empty`);
    if (input.length > maxBytes) throw new RangeError(`${inKind} data is ${input.length} bytes; the limit is ${maxBytes} bytes`);
    const tmp = await fs.mkdtemp(path.join(tmpRoot, 'ash-oda-'));
    try {
      const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out');
      await fs.mkdir(inDir); await fs.mkdir(outDir);
      await fs.writeFile(path.join(inDir, inName), input);
      const args = odaArgs(inDir, outDir, outType, version);
      const timeoutMs = opts.timeoutMs ?? odaTimeoutFor(input.length);
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
      const ext = `.${outType.toLowerCase()}`;
      const outName = names.find((n) => n.toLowerCase().endsWith(ext));
      if (!outName) {
        const errFile = names.find((n) => /\.err$/i.test(n));
        const detail = errFile ? (await fs.readFile(path.join(outDir, errFile), 'utf8')).trim().slice(0, 4096) : '';
        throw new Error(`ODA File Converter produced no ${outType}${detail ? `: ${detail}` : ''}`);
      }
      const st = await fs.stat(path.join(outDir, outName));
      if (st.size === 0) throw new Error('ODA File Converter produced an empty file');
      if (st.size > maxBytes) throw new RangeError(`ODA File Converter output exceeds ${maxBytes} bytes`);
      return new Uint8Array(await fs.readFile(path.join(outDir, outName)));
    } finally {
      // a converter still releasing its files (Windows) may need a retry; a leftover temp folder must not hide the real error
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  }
  return {
    exe,
    version: opts.version ?? odaVersion(exe),
    /** DWG bytes -> {dxfBytes} (ASCII DXF, ACAD2018, audit on); the temp folder is always removed. */
    async toDxf(dwgBytes) {
      const out = await convert(dwgBytes, 'DWG', IN_NAME, 'DXF');
      return { dxfBytes: out, errorCount: 0, log: '', converter: 'ODA' };
    },
    /** DXF bytes -> {dwgBytes} in the given ODA_DWG_VERSIONS version ('acad2018', ...); the temp folder is always removed. */
    async fromDxf(dxfBytes, version) {
      odaArgs('', '', 'DWG', version); // unknown versions fail before anything is written
      return { dwgBytes: await convert(dxfBytes, 'DXF', IN_DXF_NAME, 'DWG', version) };
    },
  };
}

/**
 * Engine choice and fallback. `getConfig()` -> {mode: 'auto'|'oda'|'libredwg', odaPath?: string} read at every call;
 * `detectOda()` -> auto-detected executable or null; `makeOda(exe)` -> ODA bridge.
 * Automatic: built-in LibreDWG first, ODA (when installed) when LibreDWG fails or its output is implausible.
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
    // Automatic: the built-in converter first (it opens a 66 MB drawing in about 20 s where ODA, with audit, took
    // about 10 minutes on the user's PC); ODA takes over when it fails or its output is implausible (e.g. the
    // LibreDWG Windows build on drawings with more than 256 MB of object data)
    const order = [];
    if (mode !== 'oda') order.push({ name: 'libredwg', bridge: libre });
    if (o?.exe) order.push({ name: 'oda', bridge: makeOda(o.exe) });
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
        // DWG writing: ODA versions when ODA is usable (see dwgWriteEngines)
        write: { oda: !!o?.exe, odaVersions: o?.exe ? Object.keys(ODA_DWG_VERSIONS) : [], libredwg: !!lib?.available },
      };
    },
    /** DWG bytes -> {dxfBytes, warnings?, engine, converter: 'ODA'|'LibreDWG', errorCount, log}; errors carry `odaHint`
     *  when installing ODA would help. An implausible output (implausibleConversion) counts as a failed engine.
     *  LibreDWG output with empty referenced blocks (emptyReferencedBlocks) is a soft problem: ODA is tried when
     *  installed, else (or when ODA fails) the LibreDWG result is returned with a warning. */
    async toDxf(dwgBytes) {
      const { mode, order } = await engines();
      const errors = [];
      const odaTried = order.some((e) => e.name === 'oda');
      const prefs = mode === 'libredwg' ? ' (Preferences > DWG converter must be Automatic or ODA File Converter.)' : '';
      let incomplete = null; // the built-in converter's implausible result: {reason, log}
      let partial = null; // the built-in converter's result with empty referenced blocks: {res, empty}
      for (const e of order) {
        const label = e.name === 'oda' ? 'ODA File Converter' : 'LibreDWG';
        let r;
        try { r = await e.bridge.toDxf(dwgBytes); } catch (err) { errors.push(`${label}: ${String(err.message || err).split('\n')[0]}`); continue; }
        const res = { ...r, engine: e.name, converter: e.name === 'oda' ? 'ODA' : 'LibreDWG', errorCount: r.errorCount ?? 0, log: r.log ?? '' };
        const reason = implausibleConversion({ dwgBytes: dwgBytes.byteLength, dxfBytes: res.dxfBytes.byteLength, errorCount: res.errorCount });
        if (!reason) {
          if (e.name !== 'libredwg') return res;
          const empty = emptyReferencedBlocks(res.dxfBytes);
          if (!empty.count) return res;
          partial = { res, empty };
          continue;
        }
        errors.push(`${label}: produced an incomplete drawing (${reason})`);
        if (e.name === 'libredwg') incomplete = { reason, log: res.log };
      }
      if (partial) {
        // ODA, when in the order, ran after LibreDWG and failed (a success returned above), so its error is in `errors`
        const odaError = odaTried ? errors.find((m) => m.startsWith('ODA File Converter: ')).slice('ODA File Converter: '.length) : null;
        return { ...partial.res, warnings: [...(partial.res.warnings ?? []), emptyBlocksWarning(partial.empty, odaError, prefs)] };
      }
      const detail = errors.join('; ') || 'no converter available';
      const msg = odaTried ? `This DWG file could not be converted (${errors.join('; ')}).`
        : incomplete ? `The built-in converter produced an incomplete drawing from this DWG: ${incomplete.reason}. It was not opened, so that you do not work on a drawing with missing objects. ${ODA_INSTALL}${prefs} [${detail}${incomplete.log ? `\n${logExcerpt(incomplete.log)}` : ''}]`
          : `${ODA_HINT}${prefs} [${detail}]`;
      throw Object.assign(new Error(msg), { odaHint: !odaTried });
    },
    /** Which engines can write DWG now: ODA (versions ODA_DWG_VERSIONS) when it is installed and the converter
     *  preference is not Built-in; LibreDWG (r2000/r14) unless the preference is ODA File Converter. */
    async dwgWriteEngines() {
      const { mode, oda: o } = await engines();
      return {
        oda: !!o?.exe, odaVersions: o?.exe ? Object.keys(ODA_DWG_VERSIONS) : [],
        odaReason: o?.exe ? undefined : (o?.reason ?? 'not used (Built-in selected)'), libredwg: mode !== 'oda',
      };
    },
    /** DXF bytes -> {dwgBytes, engine}. ODA versions ('acad2018', ...) are written by the ODA File Converter (an error
     *  when it is not available); 'r2000'/'r14' by LibreDWG. */
    async fromDxf(dxfBytes, version) {
      if (Object.hasOwn(ODA_DWG_VERSIONS, version)) {
        const { oda: o } = await engines();
        if (!o?.exe) throw new Error(`Saving DWG ${version.replace(/^acad/, '')} needs the ODA File Converter (${o?.reason ?? 'the DWG converter preference is Built-in (LibreDWG)'}). ${ODA_INSTALL}`);
        return { ...(await makeOda(o.exe).fromDxf(dxfBytes, version)), engine: 'oda' };
      }
      return { ...(await libre.fromDxf(dxfBytes, version)), engine: 'libredwg' };
    },
  };
}
