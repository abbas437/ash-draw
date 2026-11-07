// ASH Draw Studio - plot style tables (.ctb colour-dependent, .stb named): read, write, built-in tables.
//
//   const table = parsePlotStyleTable(bytes);   // { kind: 'ctb'|'stb', description, scaleFactor, applyGlobalScale, lineweights, styles }
//   exportSvg(doc, { plotStyle: table });       // pens applied by exportSvg.js penOf / colorRgb / lineweightMm / dashUnits
//
// File format, as read and written by ezdxf's ezdxf.addons.acadctb (MIT, (c) Manfred Moitzi), whose rules this module
// follows: a 48-byte ASCII header "PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec", three little-endian uint32
// (adler32 of the compressed body, decompressed size, compressed size), then a zlib stream of a line-based text:
// `name=value` lines (strings open with a quote that is never closed) and `name{ ... }` sections
// (aci_table, plot_style, custom_lineweight_table). A plot style's `color` of -1 or -1006632961 (0xC3FFFFFF) is
// "use object colour"; otherwise its colour is the low three bytes (r, g, b) of `mode_color` (default: `color`).
// color_policy bit 1 = dither, bit 2 = greyscale; linetype 31 = use object; lineweight is an index into
// custom_lineweight_table, whose 0.0 means "use object lineweight". ezdxf on 64-bit Linux/macOS writes the three
// sizes as native 8-byte longs (struct "LLL"), so a 24-byte size block is accepted too when its compressed size fits.
//
// Inflate: the FlateDecode stream decoder bundled in pdf-lib (decodePDFRawStream; synchronous, also in the renderer
// through the importmap). The writer emits zlib "stored" deflate blocks, which every zlib reader accepts.
import { PDFName, decodePDFRawStream } from 'pdf-lib';

const MAGIC = 'PIAFILEVERSION_2.0,';
const HEADER = 'PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec';
const HEADER_LEN = 48;
export const MAX_PLOT_STYLE_BYTES = 1 << 20; // input file and decompressed text limit
export const OBJECT_LINETYPE = 31;
const OBJECT_COLOR = -1, OBJECT_COLOR2 = -1006632961;
const DITHER = 1, GRAYSCALE = 2;
/** AutoCAD's standard lineweight list (mm), as ezdxf's DEFAULT_LINE_WEIGHTS; index 0 (0.0) = use object */
export const STANDARD_LINEWEIGHTS = Object.freeze([0, 0.05, 0.09, 0.10, 0.13, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.53,
  0.60, 0.65, 0.70, 0.80, 0.90, 1.00, 1.06, 1.20, 1.40, 1.58, 2.00, 2.11]);

const fail = (msg) => { throw new Error(`Plot style table: ${msg}`); };

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const n = Math.min(bytes.length, i + 3800);
    for (; i < n; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function inflate(z) {
  const dict = { lookup: (k) => (k === PDFName.of('Filter') ? PDFName.of('FlateDecode') : undefined) };
  let out;
  try { out = decodePDFRawStream({ dict, contents: z }).getBytes(MAX_PLOT_STYLE_BYTES + 1); }
  catch (err) { fail(`the compressed data is damaged (${err.message})`); }
  if (out.length > MAX_PLOT_STYLE_BYTES) fail('the table is too large (over 1 MB decompressed)');
  // the zlib trailer: adler32 of the decompressed data, big endian (catches truncated or damaged data)
  const t = z.length - 4;
  if (t < 2 || ((z[t] << 24) | (z[t + 1] << 16) | (z[t + 2] << 8) | z[t + 3]) >>> 0 !== adler32(out)) fail('the compressed data is truncated or damaged (checksum mismatch)');
  return out;
}

/** the zlib stream of a .ctb / .stb file's bytes */
function body(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('expected file bytes');
  if (bytes.length > MAX_PLOT_STYLE_BYTES) fail('the file is too large (over 1 MB)');
  const head = String.fromCharCode(...bytes.subarray(0, HEADER_LEN));
  if (!head.startsWith(MAGIC) || !head.includes('pmzlibcodec')) fail('not a CTB/STB file (bad header)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= HEADER_LEN + 24 && dv.getUint32(HEADER_LEN + 16, true) === bytes.length - HEADER_LEN - 24 && dv.getUint32(HEADER_LEN + 20, true) === 0) {
    return bytes.subarray(HEADER_LEN + 24); // ezdxf on LP64: three 8-byte sizes
  }
  if (bytes.length < HEADER_LEN + 12 + 6) fail('the file is truncated');
  const comp = dv.getUint32(HEADER_LEN + 8, true);
  if (comp > bytes.length - HEADER_LEN - 12) fail('the file is truncated');
  return bytes.subarray(HEADER_LEN + 12, HEADER_LEN + 12 + comp);
}

/** the text's top-level entries as nested plain objects (ezdxf's PlotStyleFileParser: line-based, `name{` opens a section, a line ending in `}` closes it) */
function parseText(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let i = 0;
  const nameOf = (l) => (l.endsWith('{') ? l.slice(0, -1) : l.split('=', 1)[0]).trim();
  const clean = (v) => {
    v = v.trim();
    if (v.startsWith('"')) return v.slice(1);
    return v.endsWith(')') ? v.split(' ')[0] : v; // "0.00762 (+7.Z+...)" appendix
  };
  const value = () => {
    const l = lines[i];
    if (l.endsWith('{')) { i++; return section(); }
    if (!l.includes('=')) fail(`unexpected line ${i + 1}: "${l.slice(0, 40)}"`);
    i++;
    return clean(l.slice(l.indexOf('=') + 1));
  };
  const section = () => {
    const out = {};
    for (;;) {
      if (i >= lines.length) fail('the table text ends inside a { } section');
      if (!lines[i].trim()) { i++; continue; }
      if (lines[i].trim().endsWith('}')) { i++; return out; }
      const n = nameOf(lines[i]);
      out[n] = value();
    }
  };
  const top = {};
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const n = nameOf(lines[i]);
    top[n] = value();
  }
  return top;
}

const bool = (v, d) => (v === undefined ? d : String(v).toUpperCase() === 'TRUE');
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

function styleOf(s, index, lineweights, kind) {
  const color = int(s.color, OBJECT_COLOR);
  const policy = int(s.color_policy, DITHER);
  let rgb = null;
  if (color !== OBJECT_COLOR && color !== OBJECT_COLOR2) {
    const m = int(s.mode_color, color) >>> 0;
    rgb = [(m >>> 16) & 255, (m >>> 8) & 255, m & 255];
  }
  const lwIx = int(s.lineweight, 0), lw = lineweights[lwIx];
  const lt = int(s.linetype, OBJECT_LINETYPE);
  const screen = int(s.screen, 100);
  return {
    name: s.name ?? (kind === 'ctb' ? `Color_${index + 1}` : ''),
    localizedName: s.localized_name ?? s.name ?? '',
    description: s.description ?? '',
    color: rgb,
    screening: Math.max(0, Math.min(100, screen)),
    lineweight: lw > 0 ? lw : null,
    linetype: lt === OBJECT_LINETYPE || lt < 0 ? null : lt,
    linetypeScale: Number(s.linepattern_size ?? 0.5),
    adaptive: bool(s.adaptive_linetype, true),
    lineEnd: int(s.end_style, 4), lineJoin: int(s.join_style, 5), fill: int(s.fill_style, 73),
    grayscale: !!(policy & GRAYSCALE), dither: !!(policy & DITHER),
    penNumber: int(s.physical_pen_number, 0), virtualPen: int(s.virtual_pen_number, 0),
  };
}

/** parse .ctb / .stb file bytes (Uint8Array); throws an Error with a readable message on anything that is not one */
export function parsePlotStyleTable(bytes) {
  const raw = inflate(body(bytes));
  const end = raw.indexOf(0);
  const text = new TextDecoder('latin1').decode(end >= 0 ? raw.subarray(0, end) : raw);
  const top = parseText(text);
  if (!top.plot_style || typeof top.plot_style !== 'object') fail('no plot_style section');
  const kind = String(top.aci_table_available ?? '').toUpperCase() === 'TRUE' ? 'ctb' : 'stb';
  const lwt = top.custom_lineweight_table;
  const lineweights = lwt && typeof lwt === 'object' ? [] : [...STANDARD_LINEWEIGHTS];
  if (lwt && typeof lwt === 'object') for (const [k, v] of Object.entries(lwt)) { const ix = int(k, -1), mm = Number(v); if (ix >= 0 && ix < 4096 && Number.isFinite(mm)) lineweights[ix] = mm; }
  for (let k = 0; k < lineweights.length; k++) if (lineweights[k] === undefined) lineweights[k] = 0;
  const entries = Object.entries(top.plot_style).filter(([k, v]) => v && typeof v === 'object' && int(k, -1) >= 0).sort((a, b) => int(a[0]) - int(b[0]));
  let styles;
  if (kind === 'ctb') {
    styles = Array.from({ length: 255 }, (_, ix) => styleOf({}, ix, lineweights, kind));
    for (const [k, v] of entries) { const ix = int(k); if (ix < 255) styles[ix] = styleOf(v, ix, lineweights, kind); }
  } else styles = entries.map(([k, v]) => styleOf(v, int(k), lineweights, kind));
  return {
    kind, description: top.description ?? '', scaleFactor: Number(top.scale_factor ?? 1) || 1,
    applyGlobalScale: bool(top.apply_factor, false), lineweights, styles,
  };
}

/** a zlib stream of `data` in stored (uncompressed) deflate blocks */
function zlibStored(data) {
  const n = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + n * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < n; b++) {
    const chunk = data.subarray(b * 65535, (b + 1) * 65535), len = chunk.length;
    out[o++] = b === n - 1 ? 1 : 0;
    out[o++] = len & 255; out[o++] = len >>> 8; out[o++] = ~len & 255; out[o++] = (~len >>> 8) & 255;
    out.set(chunk, o); o += len;
  }
  const a = adler32(data);
  out[o++] = a >>> 24; out[o++] = (a >>> 16) & 255; out[o++] = (a >>> 8) & 255; out[o] = a & 255;
  return out;
}

const fmtMm = (v) => v.toFixed(2);
/** .ctb / .stb file bytes of a table in parsePlotStyleTable's shape (missing style fields take the "use object" defaults) */
export function writePlotStyleTable(table) {
  const ctb = table.kind !== 'stb';
  const lws = [...(table.lineweights?.length ? table.lineweights : STANDARD_LINEWEIGHTS)];
  const lwIndex = (mm) => {
    if (!(mm > 0)) return 0;
    let ix = lws.findIndex((v) => Math.abs(v - mm) < 1e-6);
    if (ix <= 0) { lws.push(mm); ix = lws.length - 1; }
    return ix;
  };
  const styles = ctb ? Array.from({ length: 255 }, (_, i) => table.styles?.[i] ?? {}) : (table.styles ?? []);
  const L = [`description="${table.description ?? ''}`, `aci_table_available=${ctb ? 'TRUE' : 'FALSE'}`,
    `scale_factor=${Number(table.scaleFactor ?? 1).toFixed(1)}`, `apply_factor=${table.applyGlobalScale ? 'TRUE' : 'FALSE'}`, 'custom_lineweight_display_units=0'];
  if (ctb) { L.push('aci_table{'); for (let i = 0; i < 255; i++) L.push(` ${i}="Color_${i + 1}`); L.push('}'); }
  L.push('plot_style{');
  styles.forEach((s, i) => {
    const c = s.color ? ((0xC2 << 24) | ((s.color[0] & 255) << 16) | ((s.color[1] & 255) << 8) | (s.color[2] & 255)) | 0 : OBJECT_COLOR2;
    const name = s.name ?? (ctb ? `Color_${i + 1}` : `Style_${i}`);
    L.push(` ${i}{`, `  name="${name}`, `  localized_name="${s.localizedName ?? name}`, `  description="${s.description ?? ''}`,
      `  color=${c}`, `  mode_color=${c}`, `  color_policy=${(s.dither ?? true ? DITHER : 0) | (s.grayscale ? GRAYSCALE : 0)}`,
      `  physical_pen_number=${s.penNumber ?? 0}`, `  virtual_pen_number=${s.virtualPen ?? 0}`, `  screen=${s.screening ?? 100}`,
      `  linepattern_size=${s.linetypeScale ?? 0.5}`, `  linetype=${s.linetype ?? OBJECT_LINETYPE}`,
      `  adaptive_linetype=${s.adaptive ?? true ? 'TRUE' : 'FALSE'}`, `  lineweight=${lwIndex(s.lineweight)}`,
      `  fill_style=${s.fill ?? 73}`, `  end_style=${s.lineEnd ?? 4}`, `  join_style=${s.lineJoin ?? 5}`, ' }');
  });
  L.push('}', 'custom_lineweight_table{', ...lws.map((v, i) => ` ${i}=${fmtMm(v)}`), '}');
  const text = new TextEncoder().encode(`${L.join('\n')}\n\0`);
  const z = zlibStored(text);
  const out = new Uint8Array(HEADER_LEN + 12 + z.length);
  for (let i = 0; i < HEADER.length; i++) out[i] = HEADER.charCodeAt(i);
  const dv = new DataView(out.buffer);
  dv.setUint32(HEADER_LEN, adler32(z), true); dv.setUint32(HEADER_LEN + 4, text.length, true); dv.setUint32(HEADER_LEN + 8, z.length, true);
  out.set(z, HEADER_LEN + 12);
  return out;
}

/** Rec. 601 luma of [r, g, b], rounded */
export const luma = (rgb) => Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);

function builtin(description, pen) {
  const lineweights = [...STANDARD_LINEWEIGHTS];
  const styles = Array.from({ length: 255 }, (_, i) => ({
    name: `Color_${i + 1}`, localizedName: `Color_${i + 1}`, description: '', color: null, screening: 100, lineweight: null, linetype: null,
    linetypeScale: 0.5, adaptive: true, lineEnd: 4, lineJoin: 5, fill: 73, grayscale: false, dither: true, penNumber: 0, virtualPen: 0, ...pen(i + 1),
  }));
  return Object.freeze({ kind: 'ctb', description, scaleFactor: 1, applyGlobalScale: false, lineweights, styles });
}

/** AutoCAD's stock tables: acad.ctb (all "use object"), monochrome.ctb (every colour black), grayscale.ctb (object colour
 *  with greyscale on: each colour plots as its Rec. 601 grey) */
export const BUILTIN_TABLES = Object.freeze({
  'acad.ctb': builtin('', () => ({})),
  'monochrome.ctb': builtin('', () => ({ color: [0, 0, 0] })),
  'grayscale.ctb': builtin('', () => ({ grayscale: true })),
});

