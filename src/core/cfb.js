// ASH Draw Studio - a minimal reader for OLE compound files (MS-CFB "structured storage"), read-only.
// Used to take the saved presentation (preview picture) out of an OLE2FRAME's embedded object.
//
//   const cf = readCfb(bytes);           // throws on a file that is not a compound file
//   cf.entries                           // [{ name, path: 'Storage/Stream', type: 'stream'|'storage'|'root', size }]
//   cf.read('\u0002OlePres000')           // stream bytes (Uint8Array) or null

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END = 0xfffffffe, FREE = 0xffffffff, NOSTREAM = 0xffffffff;
const TYPES = { 1: 'storage', 2: 'stream', 5: 'root' };

const bad = (why) => Object.assign(new Error(`Not a readable OLE compound file: ${why}`), { code: 'CFB' });

/** true when `b` starts with the compound-file signature */
export const isCfb = (b) => b?.length >= 512 && SIG.every((x, i) => b[i] === x);

/** parse a compound file held in `bytes` (Uint8Array) */
export function readCfb(bytes) {
  if (!isCfb(bytes)) throw bad('no signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  const shift = u16(30), miniShift = u16(32);
  if (shift !== 9 && shift !== 12) throw bad('sector size');
  const SS = 1 << shift, MS = 1 << miniShift, cutoff = u32(56);
  const nSectors = Math.floor((bytes.length - SS) / SS) + 1; // a truncated last sector still counts
  const sectorAt = (s) => SS + s * SS;

  // FAT sector list: 109 in the header, the rest in the DIFAT chain
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = u32(76 + i * 4); if (s < END) fatSectors.push(s); }
  for (let d = u32(68), n = u32(72), guard = 0; d < END && n > 0 && guard < nSectors; n--, guard++) {
    const o = sectorAt(d), per = SS / 4 - 1;
    for (let i = 0; i < per; i++) { const s = u32(o + i * 4); if (s < END) fatSectors.push(s); }
    d = u32(o + per * 4);
  }
  const fat = new Uint32Array(fatSectors.length * (SS / 4));
  fatSectors.forEach((s, k) => { const o = sectorAt(s); for (let i = 0; i < SS / 4; i++) fat[k * (SS / 4) + i] = o + i * 4 + 4 <= bytes.length ? u32(o + i * 4) : FREE; });

  /** the sector chain from `start` in `table` (guards against loops and running off the table) */
  const chain = (start, table) => {
    const out = [];
    for (let s = start; s < END && s < table.length && out.length <= table.length; s = table[s]) out.push(s);
    return out;
  };
  const readChain = (start, size) => {
    const out = new Uint8Array(size);
    let at = 0;
    for (const s of chain(start, fat)) {
      if (at >= size) break;
      const o = sectorAt(s), n = Math.min(SS, size - at, Math.max(0, bytes.length - o));
      out.set(bytes.subarray(o, o + n), at); at += n;
    }
    if (at < size) throw bad('stream runs past the end of the file');
    return out;
  };

  // directory
  const dirSecs = chain(u32(48), fat);
  if (!dirSecs.length) throw bad('no directory');
  const dir = readChain(u32(48), dirSecs.length * SS);
  const ddv = new DataView(dir.buffer);
  const raw = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nlen = Math.min(ddv.getUint16(o + 64, true), 64);
    let name = '';
    for (let i = 0; i + 2 < nlen; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
    raw.push({ name, type: TYPES[dir[o + 66]] ?? null, left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true),
      child: ddv.getUint32(o + 76, true), start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) });
  }
  const root = raw[0];
  if (root?.type !== 'root') throw bad('no root entry');

  // mini stream (held in the root entry's chain) and the mini FAT
  const miniStream = root.size ? readChain(root.start, root.size) : new Uint8Array(0);
  const mfStart = u32(60), mfSecs = mfStart < END ? chain(mfStart, fat) : [];
  const mfBytes = mfSecs.length ? readChain(mfStart, mfSecs.length * SS) : new Uint8Array(0);
  const miniFat = new Uint32Array(mfBytes.buffer, 0, mfBytes.length >> 2);
  const readMini = (start, size) => {
    const out = new Uint8Array(size);
    let at = 0;
    for (const s of chain(start, miniFat)) {
      if (at >= size) break;
      const n = Math.min(MS, size - at);
      out.set(miniStream.subarray(s * MS, s * MS + n), at); at += n;
    }
    if (at < size) throw bad('mini stream runs short');
    return out;
  };

  // walk the red-black trees into paths
  const entries = [], byPath = new Map(), seen = new Set();
  const walk = (id, prefix) => {
    if (id === NOSTREAM || id >= raw.length || seen.has(id)) return;
    seen.add(id);
    const r = raw[id];
    walk(r.left, prefix);
    if (r.type) {
      const path = prefix + r.name;
      const ent = { name: r.name, path, type: r.type, size: r.size };
      entries.push(ent); byPath.set(path, r);
      if (r.type === 'storage') walk(r.child, `${path}/`);
    }
    walk(r.right, prefix);
  };
  seen.add(0);
  walk(root.child, '');

  return {
    entries,
    /** the bytes of the stream at `path` ('Name' or 'Storage/Name'), or null when there is none */
    read(path) {
      const r = byPath.get(path);
      if (!r || r.type !== 'stream') return null;
      if (!r.size) return new Uint8Array(0);
      return r.size < cutoff ? readMini(r.start, r.size) : readChain(r.start, r.size);
    },
  };
}
