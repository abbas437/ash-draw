// ASH Draw Studio - the saved preview picture of an OLE2FRAME (an embedded Excel table, Word text, logo, picture ...).
//
// An OLE2FRAME's binary data (DXF group 310) is a 128-byte AutoCAD header - the frame's four corners as 3D doubles
// (upper-left, upper-right, lower-right, lower-left) from byte 2, and the size of what follows at byte 124 - then the
// OLE object as a compound file (cfb.js). AutoCAD draws the object's saved presentation, so does this module:
//   - "Picture (Device Independent Bitmap)": a BMP file in CONTENTS
//   - "Bitmap Image" (PBrush): a BMP file in \x01Ole10Native (after its 4-byte length)
//   - "Picture (Metafile)" / "Picture (Enhanced Metafile)" / any object's \x02OlePres000 metafile: the bitmap blitted
//     by its stretch-blit record, placed where the metafile puts it
// Vector metafile records (lines, text) are not drawn; a metafile without a bitmap gives no preview.

import { readCfb, isCfb } from './cfb.js';

const HEADER = 128;
const MAX_PIXELS = 64e6;

/** the OLE2FRAME data chunks (hex strings) as bytes */
export function oleBytes(chunks) {
  const n = (chunks ?? []).reduce((s, h) => s + (h.length >> 1), 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const h of chunks ?? []) for (let i = 0; i + 1 < h.length; i += 2) out[at++] = (NIB[h.charCodeAt(i)] << 4) | NIB[h.charCodeAt(i + 1)];
  return out;
}
const NIB = new Uint8Array(128);
for (let i = 0; i < 16; i++) { NIB['0123456789abcdef'.charCodeAt(i)] = i; NIB['0123456789ABCDEF'.charCodeAt(i)] = i; }

const hasHeader = (b) => b.length >= HEADER && (b[0] & 0xfe) === 0x80 && b[1] === 0x55;

/** the frame's upper-left and lower-right corners from the data header: { p1, p2 }, or null when there is none */
export function oleFrameCorners(chunks) {
  const first = (chunks ?? []).join('').slice(0, HEADER * 2); // the header lies in the first two chunks
  const b = oleBytes([first]);
  if (!hasHeader(b)) return null;
  const dv = new DataView(b.buffer);
  const d = (i) => dv.getFloat64(2 + i * 8, true);
  const p1 = { x: d(0), y: d(1) }, p2 = { x: d(6), y: d(7) };
  if (![p1.x, p1.y, p2.x, p2.y].every(Number.isFinite) || p1.x === p2.x || p1.y === p2.y) return null;
  return { p1, p2 };
}

/** the data chunks with the header's corners set to the frame p1 (upper-left) / p2 (lower-right); the chunks as they
 *  are when the header already holds them (or there is no header) */
export function oleDataWithCorners(chunks, p1, p2) {
  const c = oleFrameCorners(chunks);
  if (!c || (c.p1.x === p1.x && c.p1.y === p1.y && c.p2.x === p2.x && c.p2.y === p2.y)) return chunks;
  let n = 0, k = 0;
  while (k < chunks.length && n < HEADER * 2) n += chunks[k++].length;
  const head = oleBytes(chunks.slice(0, k));
  const dv = new DataView(head.buffer);
  const corners = [p1.x, p1.y, 0, p2.x, p1.y, 0, p2.x, p2.y, 0, p1.x, p2.y, 0];
  corners.forEach((v, i) => dv.setFloat64(2 + i * 8, v, true));
  let hex = '';
  for (const x of head) hex += x.toString(16).padStart(2, '0').toUpperCase();
  const out = [];
  let at = 0;
  for (let i = 0; i < k; i++) { out.push(hex.slice(at, at + chunks[i].length)); at += chunks[i].length; }
  return [...out, ...chunks.slice(k)];
}

/**
 * decode a device-independent bitmap: BITMAPINFO at `info` in `b`, pixels at `bits` (null: right after the colour
 * table) -> { width, height, rgba } (top row first, opaque), or null for a format not handled (RLE, JPEG/PNG in a DIB)
 */
export function decodeDib(b, info, bits = null) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (info + 12 > b.length) return null;
  const hs = dv.getUint32(info, true);
  let w, h, bpp, comp = 0, used = 0, palEntry = 4;
  if (hs === 12) { w = dv.getUint16(info + 4, true); h = dv.getInt16(info + 6, true); bpp = dv.getUint16(info + 10, true); palEntry = 3; } else {
    if (hs < 40 || info + 40 > b.length) return null;
    w = dv.getInt32(info + 4, true); h = dv.getInt32(info + 8, true); bpp = dv.getUint16(info + 14, true);
    comp = dv.getUint32(info + 16, true); used = dv.getUint32(info + 32, true);
  }
  const topDown = h < 0; h = Math.abs(h);
  if (!(w > 0 && h > 0) || w * h > MAX_PIXELS || ![1, 4, 8, 16, 24, 32].includes(bpp)) return null;
  if (comp !== 0 && comp !== 3) return null;
  // BI_BITFIELDS masks follow a 40-byte header (inside the larger V4 / V5 headers)
  let masks = null;
  if (comp === 3) {
    const mo = info + 40;
    if (mo + 12 > b.length) return null;
    masks = [dv.getUint32(mo, true), dv.getUint32(mo + 4, true), dv.getUint32(mo + 8, true)];
  } else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f];
  const nPal = bpp <= 8 ? Math.min(used || 1 << bpp, 1 << bpp) : 0;
  const palAt = info + hs + (comp === 3 && hs === 40 ? 12 : 0);
  if (bits == null) bits = palAt + nPal * palEntry;
  const stride = ((w * bpp + 31) >>> 5) * 4;
  if (!(bits >= 0) || bits + stride * (h - 1) + Math.ceil(w * bpp / 8) > b.length) return null;
  const pal = [];
  for (let i = 0; i < nPal; i++) { const o = palAt + i * palEntry; pal.push(o + 2 < b.length ? [b[o + 2], b[o + 1], b[o]] : [0, 0, 0]); }
  const field = (m) => {
    if (!m) return null;
    let s = 0; while (!((m >>> s) & 1)) s++;
    return { m, s, max: m >>> s };
  };
  const f = masks?.map(field);
  const ch = (v, q) => (q ? Math.round((((v & q.m) >>> 0) >>> q.s) * 255 / q.max) : 0);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = bits + (topDown ? y : h - 1 - y) * stride;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      let r, g, bl;
      if (bpp <= 8) {
        const bit = x * bpp, v = (b[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        [r, g, bl] = pal[v] ?? [0, 0, 0];
      } else if (bpp === 24) { const p = row + x * 3; bl = b[p]; g = b[p + 1]; r = b[p + 2]; } else if (bpp === 32 && comp === 0) {
        const p = row + x * 4; bl = b[p]; g = b[p + 1]; r = b[p + 2];
      } else {
        const v = bpp === 16 ? dv.getUint16(row + x * 2, true) : dv.getUint32(row + x * 4, true);
        r = ch(v, f[0]); g = ch(v, f[1]); bl = ch(v, f[2]);
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

/** a BMP file (starting 'BM') at `at` -> decoded bitmap or null */
function decodeBmpFile(b, at = 0) {
  if (b.length < at + 26 || b[at] !== 0x42 || b[at + 1] !== 0x4d) return null;
  const off = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at + 10, true);
  return decodeDib(b, at + 14, at + off);
}

// the biggest bitmap blit of a metafile, with its destination box in the metafile's own space
const best = (cands) => cands.filter((c) => c.bmp).sort((a, b) => Math.abs(b.w * b.h) - Math.abs(a.w * a.h))[0] ?? null;
/** box -> fractions of the frame from its top-left corner [x0, y0, x1, y1] */
const fractions = (c, sp) => {
  const fx = (x) => (x - sp.x) / sp.w, fy = (y) => (y - sp.y) / sp.h;
  const xs = [fx(c.x), fx(c.x + c.w)].sort((a, b) => a - b), ys = [fy(c.y), fy(c.y + c.h)].sort((a, b) => a - b);
  return [xs[0], ys[0], xs[1], ys[1]];
};

/** Windows metafile at `at` (its 18-byte header) -> { bmp, box } or null; `space` the placeable header's box, if any */
function wmfPreview(b, at, space = null) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (at + 18 > b.length) return null;
  let o = at + dv.getUint16(at + 2, true) * 2;
  let org = null, ext = null;
  const cands = [];
  const i16 = (k) => dv.getInt16(k, true);
  while (o + 6 <= b.length) {
    const size = dv.getUint32(o, true) * 2, fn = dv.getUint16(o + 4, true), p = o + 6;
    if (fn === 0 || size < 6 || o + size > b.length) break;
    if (fn === 0x020b) org = { y: i16(p), x: i16(p + 2) };
    else if (fn === 0x020c) ext = { y: i16(p), x: i16(p + 2) };
    else if (fn === 0x0b41 && size / 2 !== (fn >> 8) + 3) { // META_DIBSTRETCHBLT with a bitmap
      cands.push({ h: i16(p + 12), w: i16(p + 14), y: i16(p + 16), x: i16(p + 18), at: p + 20, end: o + size });
    } else if (fn === 0x0f43) { // META_STRETCHDIB
      cands.push({ h: i16(p + 14), w: i16(p + 16), y: i16(p + 18), x: i16(p + 20), at: p + 22, end: o + size });
    } else if (fn === 0x0940 && size / 2 !== (fn >> 8) + 3) { // META_DIBBITBLT with a bitmap
      cands.push({ h: i16(p + 8), w: i16(p + 10), y: i16(p + 12), x: i16(p + 14), at: p + 16, end: o + size });
    }
    o += size;
  }
  for (const c of cands) c.bmp = decodeDib(b.subarray(0, c.end), c.at);
  const c = best(cands);
  if (!c) return null;
  const sp = org && ext ? { x: org.x, y: org.y, w: ext.x, h: ext.y } : space ?? { x: c.x, y: c.y, w: c.w, h: c.h };
  return { bmp: c.bmp, box: fractions(c, sp) };
}

/** enhanced metafile at `at` (its EMR_HEADER) -> { bmp, box } or null */
function emfPreview(b, at) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const i32 = (k) => dv.getInt32(k, true), u32 = (k) => dv.getUint32(k, true);
  const L = i32(at + 8), T = i32(at + 12), R = i32(at + 16), B = i32(at + 20);
  let org = null, ext = null;
  const cands = [];
  for (let o = at; o + 8 <= b.length;) {
    const t = u32(o), size = u32(o + 4);
    if (size < 8 || o + size > b.length) break;
    if (t === 9) ext = { x: i32(o + 8), y: i32(o + 12) };
    else if (t === 10) org = { x: i32(o + 8), y: i32(o + 12) };
    else if (t === 81 && size >= 80) { // EMR_STRETCHDIBITS
      const rec = b.subarray(o, o + size);
      if (u32(o + 52)) cands.push({ x: i32(o + 24), y: i32(o + 28), w: i32(o + 72), h: i32(o + 76), bmp: decodeDib(rec, u32(o + 48), u32(o + 56)) });
    }
    if (t === 14) break;
    o += size;
  }
  const c = best(cands);
  if (!c) return null;
  const sp = org && ext ? { x: org.x, y: org.y, w: ext.x, h: ext.y } : { x: L, y: T, w: R - L + 1, h: B - T + 1 };
  return { bmp: c.bmp, box: fractions(c, sp) };
}

const isEmf = (b, at) => b.length >= at + 88 && b[at] === 1 && b[at + 1] === 0 && b[at + 2] === 0 && b[at + 3] === 0 &&
  b[at + 40] === 0x20 && b[at + 41] === 0x45 && b[at + 42] === 0x4d && b[at + 43] === 0x46;

/** a metafile or bitmap in a \x02OlePres stream -> { bmp, box } or null */
function olePresPreview(s) {
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  if (s.length < 40 || dv.getInt32(0, true) !== -1) return null; // a standard clipboard format follows
  const cf = dv.getUint32(4, true);
  let o = 8 + dv.getUint32(8, true); // target device (its size field counts itself)
  o += 16 + 12; // aspect, lindex, advf, reserved; width, height, size
  if (o >= s.length) return null;
  if (cf === 3 || cf === 14) return s[o] <= 2 && s[o + 2] === 9 ? wmfPreview(s, o) : isEmf(s, o) ? emfPreview(s, o) : null;
  if (cf === 8 || cf === 2) { const bmp = decodeDib(s, o); return bmp && { bmp, box: [0, 0, 1, 1] }; }
  return null;
}

/**
 * the preview picture of an OLE2FRAME's data chunks -> { width, height, rgba, box: [x0, y0, x1, y1] (fractions of the
 * frame from its top-left corner) } | { error: why there is none }
 */
export function olePreview(chunks) {
  if (!chunks?.length) return { error: 'no data' };
  const all = oleBytes(chunks);
  const at = hasHeader(all) ? HEADER : 0;
  const b = all.subarray(at);
  if (!isCfb(b)) return { error: 'not an OLE compound file' };
  let cf;
  try { cf = readCfb(b); } catch (err) { return { error: err.message }; }
  const tries = [
    () => { const s = cf.read('CONTENTS'); const bmp = s && decodeBmpFile(s); return bmp && { bmp, box: [0, 0, 1, 1] }; },
    () => { const s = cf.read('\u0001Ole10Native'); const bmp = s && decodeBmpFile(s, 4); return bmp && { bmp, box: [0, 0, 1, 1] }; },
    () => {
      const s = cf.read('CONTENTS');
      if (!s || s.length < 22) return null;
      const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      if (dv.getUint32(0, true) === 0x9ac6cdd7) {
        const l = dv.getInt16(6, true), t = dv.getInt16(8, true), r = dv.getInt16(10, true), bt = dv.getInt16(12, true);
        return wmfPreview(s, 22, { x: l, y: t, w: r - l, h: bt - t });
      }
      for (const o of [0, 4]) if (isEmf(s, o)) return emfPreview(s, o);
      return null;
    },
    () => { const p = cf.entries.find((e) => /^\u0002OlePres\d{3}$/.test(e.path)); const s = p && cf.read(p.path); return s && olePresPreview(s); },
  ];
  for (const t of tries) {
    let r = null;
    try { r = t(); } catch { r = null; }
    if (r?.bmp) return { width: r.bmp.width, height: r.bmp.height, rgba: r.bmp.rgba, box: r.box };
  }
  return { error: 'no picture it can show' };
}

const cache = new WeakMap();
/** olePreview of an entity's data, decoded once per data array */
export function olePreviewOf(e) {
  const d = e?.data;
  if (!d) return { error: 'no data' };
  let pv = cache.get(d);
  if (!pv) cache.set(d, (pv = olePreview(d)));
  return pv;
}
