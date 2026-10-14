// Converted-drawing cache (reviewer #3): the DXF that a DWG converted to, kept in <userData>/dwg-cache so that opening
// an unchanged DWG again skips the converter (a 121 MB DWG takes about a minute to convert). An entry is
// <key>.dxf + <key>.json; the key hashes the DWG's absolute path, size and modification time and the converter
// identity, so a changed file or another converter misses. The .json is written last (it marks a complete entry) and
// its modification time is the entry's last use: the oldest entries are evicted when the folder is over its limit.
// No Electron imports: testable in plain Node.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from './backup.js';

export const DEFAULT_CACHE_MB = 2048;
export const MAX_CACHE_MB = 100 * 1024;
const KEY = /^[0-9a-f]{64}$/;
const STALE_TMP_MS = 60 * 60 * 1000; // a temporary file older than this is a crash leftover
const EOF_TAIL = 64; // a complete DXF ends with "0\nEOF" (and maybe a line break) within its last bytes

/** the limit in bytes from a setting in MB: a whole number 0..MAX_CACHE_MB (0 turns the cache off), else the default */
export function cacheLimitBytes(mb) {
  const n = Number.isInteger(mb) && mb >= 0 && mb <= MAX_CACHE_MB ? mb : DEFAULT_CACHE_MB;
  return n * 1024 * 1024;
}

/** the cache key of a DWG: {path (absolute), size, mtimeMs, ino, ctimeMs, converter: string naming the converter, its version and binary} */
export function cacheKey({ path: p, size, mtimeMs, ino, ctimeMs, converter }) {
  return createHash('sha256').update(JSON.stringify([path.resolve(p), size, mtimeMs, ino ?? null, ctimeMs ?? null, String(converter)])).digest('hex');
}

const looksComplete = (bytes) => /\bEOF\s*$/.test(Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - EOF_TAIL))).toString('latin1'));

/** `dir()`: the cache folder; `limitBytes()`: the size limit, read at every store; `now` injectable */
export function createDwgCache({ dir, limitBytes = () => cacheLimitBytes(DEFAULT_CACHE_MB), now = () => Date.now() }) {
  const files = (key) => {
    if (!KEY.test(key)) throw new TypeError('invalid cache key');
    return { dxf: path.join(dir(), `${key}.dxf`), json: path.join(dir(), `${key}.json`) };
  };
  const drop = async (f) => { await fs.rm(f.json, { force: true }); await fs.rm(f.dxf, { force: true }); };
  // one operation at a time: a store's eviction never races a read or a clear
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

  async function entries() {
    let names;
    try { names = await fs.readdir(dir()); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    const present = new Set(names);
    for (const n of names) {
      const own = /^(\.?)[0-9a-f]{64}\.(dxf|json)(\..+\.tmp)?$/.test(n);
      if (!own) continue; // only this cache's own files
      if (n.endsWith('.tmp')) { // an interrupted atomic write
        try { const st = await fs.stat(path.join(dir(), n)); if (Date.now() - st.mtimeMs > STALE_TMP_MS) await fs.rm(path.join(dir(), n), { force: true }); } catch { /* gone */ }
        continue;
      }
      if (/^[0-9a-f]{64}\.dxf$/.test(n) && !present.has(`${n.slice(0, 64)}.json`)) { // the drawing without its description
        await fs.rm(path.join(dir(), n), { force: true });
        continue;
      }
      const m = /^([0-9a-f]{64})\.json$/.exec(n);
      if (!m) continue;
      const f = files(m[1]);
      try {
        const [j, d] = await Promise.all([fs.stat(f.json), fs.stat(f.dxf)]);
        out.push({ key: m[1], used: j.mtimeMs, bytes: j.size + d.size });
      } catch { await drop(f); } // a description without its drawing: incomplete
    }
    return out;
  }

  async function evict(limit) {
    const list = (await entries()).sort((a, b) => a.used - b.used);
    let total = list.reduce((n, e) => n + e.bytes, 0);
    for (const e of list) {
      if (total <= limit) break;
      await drop(files(e.key));
      total -= e.bytes;
    }
  }

  return {
    /** {dxfBytes, meta} of a complete entry (its use time refreshed), or null; a damaged entry is deleted */
    /** whether the cache is on (a limit above 0) */
    enabled: () => limitBytes() > 0,
    get: (key) => serial(async () => {
      const f = files(key);
      let meta, dxfBytes;
      try { meta = JSON.parse(await fs.readFile(f.json, 'utf8')); } catch (err) {
        if (err.code !== 'ENOENT') await drop(f);
        return null;
      }
      try { dxfBytes = new Uint8Array(await fs.readFile(f.dxf)); } catch { await drop(f); return null; }
      if (!meta || typeof meta !== 'object' || meta.dxfSize !== dxfBytes.byteLength || !looksComplete(dxfBytes)) { await drop(f); return null; }
      const t = new Date(now());
      await fs.utimes(f.json, t, t).catch(() => {});
      return { dxfBytes, meta };
    }),
    /** store an entry (the drawing, then its description, both atomically), then evict the least recently used entries
     *  over the limit; nothing is stored when the drawing alone is over the limit (or the limit is 0) */
    put: (key, dxfBytes, meta = {}) => serial(async () => {
      const f = files(key);
      const limit = limitBytes();
      if (!(dxfBytes instanceof Uint8Array)) throw new TypeError('dxfBytes must be a Uint8Array');
      if (dxfBytes.byteLength > limit) return false;
      await fs.mkdir(dir(), { recursive: true });
      await atomicWrite(f.dxf, dxfBytes);
      await atomicWrite(f.json, JSON.stringify({ ...meta, dxfSize: dxfBytes.byteLength }));
      const t = new Date(now());
      await fs.utimes(f.json, t, t).catch(() => {});
      await evict(limit);
      return true;
    }),
    /** {entries, bytes} in the cache */
    info: () => serial(async () => {
      const list = await entries();
      return { entries: list.length, bytes: list.reduce((n, e) => n + e.bytes, 0) };
    }),
    /** delete every entry (and any temporary file a crash left); returns the number of entries deleted */
    clear: () => serial(async () => {
      let names;
      try { names = await fs.readdir(dir()); } catch (err) { if (err.code === 'ENOENT') return 0; throw err; }
      let n = 0;
      for (const name of names) {
        if (!/^\.?[0-9a-f]{64}\.(dxf|json)(\..+\.tmp)?$/.test(name)) continue; // only this cache's own files
        if (name.endsWith('.json')) n++;
        await fs.rm(path.join(dir(), name), { force: true });
      }
      return n;
    }),
  };
}

/**
 * Open a DWG through the cache. `converter`: the converter identity for the key; `read(p)` -> DWG bytes;
 * `convert(bytes)` -> {dxfBytes, warnings?, engine, converter, errorCount, log}. Returns that result plus
 * {dwgSize, header (the DWG's first 6 bytes, e.g. "AC1032"), cached}; on a miss `stored` is the pending store
 * (it never rejects: the drawing opens whether or not it could be cached).
 */
export async function openCached(cache, p, { converter, read, convert, stat = fs.stat }) {
  const st = await stat(p);
  const stamp = (s) => [s.size, s.mtimeMs, s.ino, s.ctimeMs].join(':');
  const key = cacheKey({ path: p, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs, converter });
  const on = cache.enabled();
  const hit = on ? await cache.get(key).catch(() => null) : null;
  if (hit) {
    const { dxfSize, ...meta } = hit.meta;
    return { ...meta, dxfBytes: hit.dxfBytes, cached: true };
  }
  const dwgBytes = await read(p);
  const r = await convert(dwgBytes);
  const meta = {
    dwgSize: dwgBytes.byteLength, header: Buffer.from(dwgBytes.subarray(0, 6)).toString('latin1'),
    ...(r.warnings ? { warnings: r.warnings } : {}), engine: r.engine, converter: r.converter, errorCount: r.errorCount ?? 0, log: r.log ?? '',
  };
  // the DWG changed while it was read: the key describes a file we may not have converted, so store nothing
  const unchanged = on && stamp(await stat(p).catch(() => ({}))) === stamp(st);
  const stored = unchanged ? cache.put(key, r.dxfBytes, meta).catch(() => false) : Promise.resolve(false);
  return { ...meta, dxfBytes: r.dxfBytes, cached: false, stored };
}
