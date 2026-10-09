// ASH Draw Studio - DXF reader (ASCII DXF, R12 .. R2018). Pure ES module, no dependencies.
//
// Own group-code reader (instead of a third-party parser) so that HATCH, LEADER, layer settings,
// true colour, line weights, text styles, extrusion and unknown-entity accounting are handled in one place.
//
//   decodeDxfBytes(Uint8Array) -> string      (small inputs; same encoding detection as readDxf)
//   tokenizeDxf(Uint8Array)    -> tokens      (throws Error{code:'BINARY_DXF'} for binary DXF, {code:'BAD_DXF'})
//   parseDxf(text)             -> doc         (see model.js)
//   readDxf(Uint8Array, {onProgress}) -> doc   (onProgress(fraction 0..1) is called as the file is read)
//   plainText(raw)             -> display string (text codes resolved)
import { buildAttribute, linkAttribs } from './blocks.js';
import {
  newDocument, addLayer, addLinetype, addTextStyle, addBlock, addEntity, BYLAYER,
  makeLine, makeCircle, makeArc, makeEllipse, makePolyline, makePoint, makeText, makeMText,
  makeSpline, makeSolid, makeInsert, makeHatch, makeDimension, makeLeader,
} from './model.js';
import { transformEntity, applyVec, apply, det, matScale } from './geom.js';
import { dimStyleFromTags } from './dimsStyle.js';
import { dimDefFromTags } from './dims.js';
import { mtextPlain } from './mtext.js';
import { mleaderFromTags, mleaderStyleFromTags } from './mleader.js';
import { mlineFromTags, mlineStyleFromTags } from './mline.js';
import { parseLayoutObject, readViewport } from './layouts.js';
import { imageDefFromTags, imageFromTags } from './image.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// bytes -> tokens. The file is never decoded as one string (V8 strings stop at ~512 M characters and a 500 MB DXF
// is common for AutoCAD 2018 drawings): lines are found on the bytes, group codes are parsed from the bytes, and each
// value is decoded only when it is read (one line at a time), so the token stream costs ~12 bytes per pair.
const BINARY_SENTINEL = 'AutoCAD Binary DXF';

const CODEPAGE_LABEL = {
  ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5', ANSI_874: 'windows-874',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258', DOS866: 'ibm866', UTF8: 'utf-8', 'UTF-8': 'utf-8',
};

/** true when every line of `body` holding a non-ASCII byte is valid UTF-8 (a "\n" byte never sits inside a UTF-8
 *  sequence, so this equals validating the whole body), decoding at most one line at a time */
function isUtf8(body) {
  const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const n = body.length;
  for (let i = 0; i < n; i++) {
    if (body[i] < 0x80) continue;
    let a = body.lastIndexOf(10, i) + 1, b = body.indexOf(10, i);
    if (b < 0) b = n;
    try { fatal.decode(body.subarray(a, b)); } catch { return false; }
    i = b;
  }
  return true;
}

/** the text decoder of a DXF body: UTF-8 for AC1021+ or a BOM; older files UTF-8 when valid, else $DWGCODEPAGE */
function dxfDecoder(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 32));
  if (head.startsWith(BINARY_SENTINEL)) {
    const err = new Error('This is a binary DXF file. Save it as ASCII DXF (or as DWG) and open it again.');
    err.code = 'BINARY_DXF';
    throw err;
  }
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3; // UTF-8 BOM
  const body = start ? bytes.subarray(start) : bytes;
  // $ACADVER / $DWGCODEPAGE live in the header: read the first 8 KB as latin1 to find them.
  const peek = new TextDecoder('latin1').decode(body.subarray(0, 8192));
  const ver = /\$ACADVER\s+1\s+(AC\d+)/.exec(peek)?.[1] ?? '';
  const cp = /\$DWGCODEPAGE\s+3\s+([^\r\n]+)/.exec(peek)?.[1]?.trim().toUpperCase();
  const utf8 = () => new TextDecoder('utf-8', { ignoreBOM: true });
  if (ver >= 'AC1021' || start || isUtf8(body)) return { body, decoder: utf8() };
  const label = (cp && CODEPAGE_LABEL[cp]) || 'windows-1252';
  try { return { body, decoder: new TextDecoder(label) }; } catch { return { body, decoder: new TextDecoder('windows-1252') }; }
}
/** whole-file text with the reader's encoding detection (small inputs only: readDxf never decodes the whole file) */
export function decodeDxfBytes(bytes) {
  const { body, decoder } = dxfDecoder(bytes);
  return decoder.decode(body);
}

// ---------------------------------------------------------------------------------------------
// text helpers

const decodeU = (s) => (s.includes('\\U+') ? s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : s);

/** Resolve DXF text codes into what should be displayed (also used for MTEXT): derived from the MTEXT parser. */
export function plainText(raw) {
  return mtextPlain(raw);
}

// ---------------------------------------------------------------------------------------------
// tokenizer: group codes in an Int32Array, values as byte ranges decoded on demand by val(i). `repaired` counts string
// values that were split over several lines (LibreDWG's dwg2dxf breaks long group-1 values such as GEODATA WKT strings
// mid-word): a line where a group code is expected that is not an integer, right after a string-valued pair, is joined
// onto that value.
const INT_LINE = /^\s*-?\d+\s*$/;
const isWs = (b) => b === 32 || (b >= 9 && b <= 13);
const PROGRESS_STEP = 1 << 22; // report progress every 4 MB

/** Tokenize DXF bytes. `decoder` (a TextDecoder) skips the encoding detection (parseDxf passes UTF-8). */
export function tokenizeDxf(bytes, { decoder = null, onProgress = null } = {}) {
  let body = bytes;
  if (!decoder) ({ body, decoder } = dxfDecoder(bytes));
  const n = body.length;
  const big = n > 0xfffffff0;
  let cap = Math.max(1024, Math.ceil(n / 12));
  let codes = new Int32Array(cap), vs = big ? new Float64Array(cap) : new Uint32Array(cap), ve = big ? new Float64Array(cap) : new Uint32Array(cap);
  const grow = () => {
    cap = Math.ceil(cap * 1.5);
    const c2 = new Int32Array(cap); c2.set(codes); codes = c2;
    const s2 = new vs.constructor(cap); s2.set(vs); vs = s2;
    const e2 = new ve.constructor(cap); e2.set(ve); ve = e2;
  };
  const tmp = [];
  const decode = (a, b) => {
    const len = b - a;
    if (len === 0) return '';
    if (len <= 64) {
      tmp.length = len;
      let k = 0;
      for (; k < len; k++) { const c = body[a + k]; if (c > 127) break; tmp[k] = c; }
      if (k === len) return String.fromCharCode.apply(null, tmp);
    }
    return decoder.decode(body.subarray(a, b));
  };
  const ascii = (a, b) => { for (let k = a; k < b; k++) if (body[k] > 127) return false; return true; };
  let joined = null; // token index -> rejoined value
  let count = 0, repaired = 0, lastJoined = -1;
  let pos = 0, ls = 0, le = 0, nextReport = PROGRESS_STEP;
  // next line -> [ls, le) without the "\r"; false past the end (mirrors splitting the text at "\n")
  const nextLine = () => {
    if (pos > n) return false;
    let e = body.indexOf(10, pos);
    if (e < 0) e = n;
    ls = pos; le = e; pos = e + 1;
    if (le > ls && body[le - 1] === 13) le--;
    return true;
  };
  for (;;) {
    if (!nextLine()) break;
    if (onProgress && pos >= nextReport) { nextReport = pos + PROGRESS_STEP; onProgress(Math.min(pos, n) / n); }
    const cs = ls, ce = le;
    const plain = ascii(cs, ce);
    const cText = plain ? null : decoder.decode(body.subarray(cs, ce));
    if (pos > n) { // last line of the file: a blank one ends it
      let k = cs; while (k < ce && isWs(body[k])) k++;
      if (plain ? k === ce : cText.trim() === '') break;
    }
    let intLine;
    if (plain) {
      let k = cs; while (k < ce && isWs(body[k])) k++;
      if (k < ce && body[k] === 45) k++;
      const d = k; while (k < ce && body[k] >= 48 && body[k] <= 57) k++;
      const digits = k > d; while (k < ce && isWs(body[k])) k++;
      intLine = digits && k === ce;
    } else intLine = INT_LINE.test(cText);
    const last = count - 1;
    if (last >= 0 && !intLine && isStringCode(codes[last]) && codes[last] !== 0) {
      joined ??= new Map();
      const prev = joined.has(last) ? joined.get(last) : decode(vs[last], ve[last]);
      joined.set(last, prev + (plain ? decode(cs, ce) : cText)); // the break is mid-word, so no separator belongs in the value
      if (lastJoined !== last) { repaired++; lastJoined = last; }
      continue;
    }
    if (!nextLine()) break;
    let code;
    if (intLine && plain) {
      let k = cs; while (isWs(body[k])) k++;
      const neg = body[k] === 45; if (neg) k++;
      code = 0; while (k < ce && body[k] >= 48 && body[k] <= 57) code = code * 10 + body[k++] - 48;
      if (neg) code = -code;
    } else code = parseInt(plain ? decode(cs, ce) : cText, 10);
    if (Number.isNaN(code)) {
      const err = new Error(`Not a DXF file (bad group code "${(plain ? decode(cs, ce) : cText).slice(0, 20)}" near line ${count * 2 + 1}).`);
      err.code = 'BAD_DXF';
      throw err;
    }
    if (count === cap) grow();
    codes[count] = code; vs[count] = ls; ve[count] = le; count++;
  }
  onProgress?.(1);
  codes = codes.subarray(0, count);
  const val = joined
    ? (i) => { const j = joined.get(i); return j !== undefined ? j : decode(vs[i], ve[i]); }
    : (i) => decode(vs[i], ve[i]);
  return { codes, val, count, repaired };
}
const isStringCode = (c) => c < 10 || (c >= 100 && c <= 102) || c === 105 || (c >= 300 && c <= 369) || (c >= 390 && c <= 399) || (c >= 410 && c <= 419) || (c >= 430 && c <= 439) || (c >= 470 && c <= 481) || c === 999 || (c >= 1000 && c <= 1009);

class Rec {
  constructor(tk, a, b) { this.tk = tk; this.a = a; this.b = b; this.type = tk.val(a); }
  get length() { return this.b - this.a; }
  code(i) { return this.tk.codes[this.a + i]; }
  val(i) { return this.tk.val(this.a + i); }
  /** first value for group code, or undefined */
  get(code) {
    const { codes, val } = this.tk;
    for (let i = this.a + 1; i < this.b; i++) if (codes[i] === code) return isStringCode(code) ? decodeU(val(i)) : val(i);
    return undefined;
  }
  num(code, d = 0) { const v = this.get(code); if (v === undefined) return d; const x = parseFloat(v); return Number.isFinite(x) ? x : d; }
  int(code, d = 0) { const v = this.get(code); if (v === undefined) return d; const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; }
  str(code, d = '') { const v = this.get(code); return v === undefined ? d : v; }
  has(code) { return this.get(code) !== undefined; }
  all(code) {
    const out = [];
    const { codes, val } = this.tk;
    for (let i = this.a + 1; i < this.b; i++) if (codes[i] === code) out.push(isStringCode(code) ? decodeU(val(i)) : val(i));
    return out;
  }
  allNum(code) { return this.all(code).map(parseFloat); }
  /** array of [code, value] pairs (value strings) between a+1 and b */
  tags() { const out = []; for (let i = this.a + 1; i < this.b; i++) out.push([this.tk.codes[i], this.tk.val(i)]); return out; }
}

/** split a token range [from,to) into records starting at each group code 0 */
function records(tk, from, to) {
  const out = [];
  let a = -1;
  for (let i = from; i < to; i++) {
    if (tk.codes[i] === 0) { if (a >= 0) out.push(new Rec(tk, a, i)); a = i; }
  }
  if (a >= 0) out.push(new Rec(tk, a, to));
  return out;
}

function sections(tk) {
  const secs = {};
  const { codes, val } = tk;
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === 0 && val(i) === 'SECTION' && codes[i + 1] === 2) {
      const name = val(i + 1);
      let j = i + 2;
      while (j < codes.length && !(codes[j] === 0 && val(j) === 'ENDSEC')) j++;
      secs[name] = { from: i + 2, to: j };
      i = j;
    }
  }
  return secs;
}

// ---------------------------------------------------------------------------------------------
const trueColor = (v) => ({ r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 });

function normLt(name) {
  const u = String(name).toUpperCase();
  return u === 'BYLAYER' || u === 'BYBLOCK' ? u : name;
}

function readColor(rec) {
  if (rec.has(420)) return trueColor(rec.int(420));
  if (rec.has(62)) { const c = rec.int(62); return c < 0 ? -c : c; }
  return BYLAYER;
}

function common(rec) {
  const lw = rec.has(370) ? rec.int(370) : -1;
  const o = {
    layer: rec.str(8, '0'),
    color: readColor(rec),
    linetype: rec.has(6) ? normLt(rec.str(6)) : 'BYLAYER',
    lineweight: lw >= 0 ? lw / 100 : lw,
    ltscale: rec.has(48) ? rec.num(48, 1) : 1,
  };
  return o;
}

function pt(rec, c = 10) { return { x: rec.num(c), y: rec.num(c + 10) }; }

// -- OCS (object coordinate system) ---------------------------------------------------------------
// 2D entities store their geometry in the OCS of their extrusion vector (210/220/230). The DXF spec's Arbitrary Axis
// Algorithm gives the OCS axes Ax, Ay; WCS = Ax*x + Ay*y + N*elevation. The model is a plan view, so the OCS -> WCS
// map is projected onto the XY plane (Z dropped): a 2D affine matrix [Ax.x, Ax.y, Ay.x, Ay.y, N.x*elev, N.y*elev].
// For (0,0,-1) that is the mirror x -> -x; for a tilted normal it is a general (possibly sheared) affine map.
function ocsAxes(rec) {
  let nx = rec.num(210), ny = rec.num(220), nz = rec.num(230, 1);
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-12)) return null;
  nx /= l; ny /= l; nz /= l;
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null; // default OCS == WCS
  let ax = Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64 ? [nz, 0, -nx] : [-ny, nx, 0]; // Wy x N : Wz x N
  const la = Math.hypot(ax[0], ax[1], ax[2]);
  ax = ax.map((v) => v / la);
  const n = [nx, ny, nz];
  const ay = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
  return { ax, ay, n };
}
/** OCS -> projected WCS matrix of a record (null for the default OCS). */
function ocsMatrix(rec, elev) {
  const o = ocsAxes(rec);
  return o && [o.ax[0], o.ax[1], o.ay[0], o.ay[1], o.n[0] * elev, o.n[1] * elev];
}
const OCS_ELEVATION = {
  LWPOLYLINE: 38, POLYLINE: 30, CIRCLE: 30, ARC: 30, TEXT: 30, ATTRIB: 30, ATTDEF: 30, INSERT: 30, SOLID: 30, TRACE: 30, HATCH: 30, DIMENSION: 31,
};
const HALIGN_MIRROR = { 0: 2, 2: 0 };
/** TEXT seen through a mirroring map m (det < 0) is drawn backwards in AutoCAD. Glyphs are not mirrored here: the
 *  text is kept readable with the same footprint (baseline reversed, left/right justification swapped). */
function mirroredText(e, m) {
  const a = (e.rot || 0) * DEG;
  const b = applyVec(m, { x: Math.cos(a), y: Math.sin(a) });
  const c = structuredClone(e);
  c.p = apply(m, e.p); c.height = e.height * matScale(m);
  c.rot = ((((Math.atan2(-b.y, -b.x) / DEG) % 360) + 360) % 360);
  if (e.p2) { c.p = apply(m, e.p2); c.p2 = apply(m, e.p); }
  else if (e.hAlign in HALIGN_MIRROR) c.hAlign = HALIGN_MIRROR[e.hAlign];
  return c;
}
/** INSERT under a projected tilted OCS: the shear part of the map cannot be represented; keep rotation and scale. */
function insertNoShear(e, m) {
  try { return transformEntity(e, m); } catch (err) {
    if (err.code !== 'SHEAR') throw err;
    const lin = [m[0], m[1], m[2], m[3], 0, 0];
    const a = (e.rot || 0) * DEG;
    const ux = applyVec(lin, { x: Math.cos(a) * (e.sx ?? 1), y: Math.sin(a) * (e.sx ?? 1) });
    const sx = Math.hypot(ux.x, ux.y);
    const d = det(lin) * (e.sx ?? 1) * (e.sy ?? 1);
    return { ...structuredClone(e), p: apply(m, e.p), rot: Math.atan2(ux.y, ux.x) / DEG, sx, sy: sx > 0 ? d / sx : 0 };
  }
}
/** ELLIPSE: centre and major axis are WCS; the minor axis is N x major, so a -Z or tilted normal changes the
 *  direction the parameters run (and, tilted, the projected shape). */
function ellipseToPlan(rec, e) {
  const o = ocsAxes(rec);
  if (!o) return e;
  const M = [rec.num(11), rec.num(21), rec.num(31)];
  const L = Math.hypot(M[0], M[1], M[2]);
  if (!(L > 0)) return e;
  const n = o.n;
  const v = [(n[1] * M[2] - n[2] * M[1]) / L, (n[2] * M[0] - n[0] * M[2]) / L, (n[0] * M[1] - n[1] * M[0]) / L];
  // local ellipse with major (L,0) and minor (0,L*ratio), mapped by [M/L | N x M/L] and moved to the centre
  const local = { ...e, c: { x: 0, y: 0 }, major: { x: L, y: 0 } };
  const t = transformEntity(local, [M[0] / L, M[1] / L, v[0], v[1], e.c.x, e.c.y]);
  return t;
}
/** Bring an entity read in its OCS into the (plan) WCS model. */
function ocsToPlan(rec, e) {
  const m = ocsMatrix(rec, rec.num(OCS_ELEVATION[rec.type] ?? 30));
  if (!m) return e;
  const id = e.id;
  let t;
  if (e.type === 'TEXT' && det(m) < 0) t = mirroredText(e, m);
  else if (e.type === 'INSERT') t = insertNoShear(e, m);
  else t = transformEntity(e, m);
  t.id = id;
  if (e.type === 'HATCH' && e.pattern !== 'SOLID') { const a = (e.angle || 0) * DEG, d = applyVec(m, { x: Math.cos(a), y: Math.sin(a) }); t.angle = Math.atan2(d.y, d.x) / DEG; }
  return t;
}

// -- entity builders --------------------------------------------------------------------------
function buildLwpolyline(rec, o) {
  const verts = [];
  let cur = null;
  const { codes, val } = rec.tk;
  for (let i = rec.a + 1; i < rec.b; i++) {
    const c = codes[i];
    if (c === 10) { cur = { x: parseFloat(val(i)), y: 0, bulge: 0 }; verts.push(cur); }
    else if (c === 20 && cur) cur.y = parseFloat(val(i));
    else if (c === 42 && cur) cur.bulge = parseFloat(val(i)) || 0;
  }
  const e = makePolyline(verts, (rec.int(70) & 1) === 1, o);
  const w = rec.num(43);
  if (w > 0) e.width = w;
  return e;
}

function buildPolyline(rec, verts, o) {
  const flags = rec.int(70);
  if (flags & (16 | 64)) return null; // polygon / polyface mesh
  const pts = [];
  for (const v of verts) {
    const vf = v.int(70);
    if (vf & 16) continue;            // spline frame control point
    if (vf & 128 && !(vf & 64)) { /* polyface face record */ continue; }
    pts.push({ x: v.num(10), y: v.num(20), bulge: v.num(42) });
  }
  if (pts.length < 2) return null;
  const e = makePolyline(pts, (flags & 1) === 1, o);
  const w = rec.num(40);
  if (w > 0) e.width = w;
  return e;
}

function buildSpline(rec, o) {
  const ctrl = [], fit = [];
  const knots = rec.allNum(40);
  const weights = rec.allNum(41);
  const { codes, val } = rec.tk;
  let cc = null, ff = null;
  for (let i = rec.a + 1; i < rec.b; i++) {
    const c = codes[i];
    if (c === 10) { cc = { x: parseFloat(val(i)), y: 0 }; ctrl.push(cc); }
    else if (c === 20 && cc) cc.y = parseFloat(val(i));
    else if (c === 11) { ff = { x: parseFloat(val(i)), y: 0 }; fit.push(ff); }
    else if (c === 21 && ff) ff.y = parseFloat(val(i));
  }
  const flags = rec.int(70);
  return makeSpline({ ...o, degree: rec.int(71, 3), ctrl, knots, weights: weights.length === ctrl.length && weights.length ? weights : null, fit, closed: (flags & 1) === 1 });
}

function buildText(rec, o) {
  const hAlign = rec.int(72), vAlign = rec.int(73);
  let p = pt(rec, 10), p2 = null;
  // Aligned / Fit run from 10 to 11; every other non-default justification is placed at 11
  if ((hAlign === 3 || hAlign === 5) && rec.has(11)) p2 = pt(rec, 11);
  else if ((hAlign || vAlign) && rec.has(11)) p = pt(rec, 11);
  return makeText(p, rec.num(40, 1), rec.str(1), {
    ...o, p2, rot: rec.num(50), widthFactor: rec.num(41, 1), style: rec.str(7, 'STANDARD').toUpperCase(), hAlign, vAlign,
    oblique: rec.num(51),
  });
}

function buildMText(rec, o) {
  const chunks = rec.all(3);
  const text = chunks.join('') + rec.str(1);
  // insertion point and direction (11) are WCS; rotation 50 (no 11) is in the OCS
  const ocs = ocsMatrix(rec, 0);
  const a = rec.num(50) * DEG;
  let dir = rec.has(11) ? { x: rec.num(11), y: rec.num(21) } : { x: Math.cos(a), y: Math.sin(a) };
  if (ocs && !rec.has(11)) dir = applyVec(ocs, dir);
  let attach = rec.int(71, 1);
  // a mirrored OCS (normal pointing down) shows the text backwards: keep it readable over the same footprint
  if (ocs && det(ocs) < 0) { dir = { x: -dir.x, y: -dir.y }; const col = (attach - 1) % 3; attach += col === 0 ? 2 : col === 2 ? -2 : 0; }
  let rot = Math.atan2(dir.y, dir.x) / DEG;
  rot = ((rot % 360) + 360) % 360;
  return makeMText(pt(rec, 10), rec.num(40, 1), text, {
    ...o, width: rec.num(41), rot, attach, style: rec.str(7, 'STANDARD').toUpperCase(),
    lineSpacing: rec.num(44, 1) > 0 ? rec.num(44, 1) : 1,
  });
}

function buildSolid(rec, o) {
  const pts = [pt(rec, 10), pt(rec, 11), pt(rec, 12)];
  pts.push(rec.has(13) ? pt(rec, 13) : { ...pts[2] });
  return makeSolid(pts, o);
}

function buildInsert(rec, o) {
  return makeInsert(rec.str(2), pt(rec, 10), {
    ...o, sx: rec.num(41, 1), sy: rec.num(42, 1), rot: rec.num(50), cols: Math.max(1, rec.int(70, 1)), rows: Math.max(1, rec.int(71, 1)),
    colSp: rec.num(44), rowSp: rec.num(45),
  });
}

function buildDimension(rec, o) {
  const skip = new Set([0, 5, 8, 62, 420, 6, 370, 48, 60, 67, 102]);
  const raw = [];
  let hasSub = false;
  const { codes, val } = rec.tk;
  let inGroup = false;
  for (let i = rec.a + 1; i < rec.b; i++) {
    const c = codes[i];
    if (c === 102) { inGroup = !val(i).startsWith('}') ? true : false; continue; }
    if (inGroup) continue;
    if (c === 100) { if (val(i) === 'AcDbEntity') continue; if (val(i) === 'AcDbDimension') hasSub = true; }
    if (skip.has(c) || c >= 1000 || (c >= 330 && c <= 369)) continue;
    raw.push([c, val(i)]);
  }
  const e = makeDimension(rec.str(2), { ...o, dimType: rec.int(70), p: rec.has(11) ? pt(rec, 11) : null, text: rec.str(1) });
  e.raw = hasSub ? raw : null;
  e.style = rec.str(3, 'Standard');
  if (hasSub) e.def = dimDefFromTags(raw);
  return e;
}

function buildLeader(rec, o) {
  const pts = [];
  const { codes, val } = rec.tk;
  let cur = null;
  for (let i = rec.a + 1; i < rec.b; i++) {
    if (codes[i] === 10) { cur = { x: parseFloat(val(i)), y: 0 }; pts.push(cur); }
    else if (codes[i] === 20 && cur) cur.y = parseFloat(val(i));
  }
  if (pts.length < 2) return null;
  return makeLeader(pts, { ...o, arrow: rec.int(71, 1) !== 0 });
}

function buildHatch(rec, o, doc) {
  const { codes, val } = rec.tk;
  let i = rec.a + 1;
  const end = rec.b;
  const seek = (code) => { while (i < end && codes[i] !== code) i++; return i < end; };
  const f = (k) => parseFloat(val(k));
  const n = (k) => parseInt(val(k), 10);
  if (!seek(2)) return null;
  const pattern = val(i).trim() || 'SOLID';
  const solid = rec.int(70) === 1;
  const nPaths = rec.int(91);
  if (!seek(91)) return null;
  i++;
  const loops = [];
  for (let p = 0; p < nPaths; p++) {
    if (!seek(92)) break;
    const ptype = n(i); i++;
    if (ptype & 2) { // polyline boundary
      let hasBulge = 0, closed = true, nv = 0;
      while (i < end && codes[i] !== 93) { if (codes[i] === 72) hasBulge = n(i); else if (codes[i] === 73) closed = n(i) !== 0; i++; }
      nv = n(i); i++;
      const pts = [];
      for (let k = 0; k < nv; k++) {
        if (codes[i] !== 10) break;
        const v = { x: f(i), y: 0, bulge: 0 }; i++;
        if (codes[i] === 20) { v.y = f(i); i++; }
        if (hasBulge && codes[i] === 42) { v.bulge = f(i); i++; }
        pts.push(v);
      }
      loops.push({ pts, closed });
    } else {
      const ne = (seek(93), n(i)); i++;
      const segs = [];
      // each edge has a fixed tag sequence per type (group codes repeat between types, so read by position)
      const nextNum = (code, def = 0) => { if (i < end && codes[i] === code) { const v = f(i); i++; return v; } return def; };
      for (let k = 0; k < ne; k++) {
        if (!(i < end && codes[i] === 72)) break;
        const et = n(i); i++;
        if (et === 1) {
          const x1 = nextNum(10), y1 = nextNum(20), x2 = nextNum(11), y2 = nextNum(21);
          segs.push({ type: 'line', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
        } else if (et === 2) {
          const cx = nextNum(10), cy = nextNum(20), r = nextNum(40), a0 = nextNum(50), a1 = nextNum(51, 360), ccw = nextNum(73, 1);
          segs.push({ type: 'arc', c: { x: cx, y: cy }, r, a0, a1, ccw: ccw !== 0 });
        } else if (et === 3) {
          const cx = nextNum(10), cy = nextNum(20), mx = nextNum(11), my = nextNum(21), ratio = nextNum(40, 1), a0 = nextNum(50), a1 = nextNum(51, 360), ccw = nextNum(73, 1);
          segs.push({ type: 'ellipse', c: { x: cx, y: cy }, major: { x: mx, y: my }, ratio, a0: a0 * DEG, a1: a1 * DEG, ccw: ccw !== 0 });
        } else if (et === 4) {
          const degree = nextNum(94, 3), rational = nextNum(73), periodic = nextNum(74), nk = nextNum(95), nc = nextNum(96);
          void periodic;
          const knots = [];
          for (let q = 0; q < nk; q++) knots.push(nextNum(40));
          const ctrl = [], weights = [];
          for (let q = 0; q < nc; q++) {
            const x = nextNum(10), y = nextNum(20);
            ctrl.push({ x, y });
            if (rational) weights.push(nextNum(42, 1)); else if (i < end && codes[i] === 42) { weights.push(f(i)); i++; }
          }
          const nf = nextNum(97);
          const fit = [];
          for (let q = 0; q < nf; q++) { const x = nextNum(11), y = nextNum(21); fit.push({ x, y }); }
          if (nf > 0) { nextNum(12); nextNum(22); nextNum(13); nextNum(23); }
          segs.push({ type: 'spline', degree, ctrl, fit, knots, weights: weights.length === ctrl.length && weights.length ? weights : null });
        } else break;
      }
      loops.push({ segs, closed: true });
    }
    // source boundary objects (97 count then 330 handles) belong to the path; skipped by seek(92) next time
    if (i < end && codes[i] === 97) { const cnt = n(i); i++; for (let k = 0; k < cnt && i < end && codes[i] === 330; k++) i++; }
  }
  const hatch = makeHatch(loops, { ...o, solid, pattern: solid ? 'SOLID' : pattern });
  // pattern parameters (after the boundary paths)
  const tail = new Rec(rec.tk, i - 1, end);
  hatch.angle = tail.num(52);
  hatch.scale = tail.num(41, 1) || 1;
  if (!solid) {
    hatch.patLines = [];
    const nlines = tail.int(78);
    if (nlines) {
      let k = i;
      for (let q = 0; q < nlines; q++) {
        while (k < end && codes[k] !== 53) k++;
        if (k >= end) break;
        const L = { angle: f(k), base: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, dashes: [] };
        k++;
        while (k < end && codes[k] !== 53 && codes[k] !== 47 && codes[k] !== 98) {
          const c = codes[k];
          if (c === 43) L.base.x = f(k); else if (c === 44) L.base.y = f(k);
          else if (c === 45) L.offset.x = f(k); else if (c === 46) L.offset.y = f(k);
          else if (c === 49) L.dashes.push(f(k));
          k++;
        }
        hatch.patLines.push(L);
      }
    }
  }
  void doc;
  return hatch;
}

/** XDATA of the applications this program keeps (see XDATA_APPS): { APP: [[code, value], ...] } or null */
export const XDATA_APPS = ['ASH_MARKUP'];
function readXData(rec) {
  let out = null, cur = null;
  for (const [c, v] of rec.tags()) {
    if (c === 1001) { cur = XDATA_APPS.includes(v) ? ((out ??= {})[v] = []) : null; continue; }
    if (cur && c >= 1000 && c < 1072) cur.push([c, isStringCode(c) ? decodeU(v) : v]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
let mlStyles = new Map(); // MLEADERSTYLE handle -> defaults (set per parse)
let imageDefs = new Map(); // IMAGEDEF handle -> image definition (set per parse)
function buildEntity(rec, doc, extra) {
  const o = common(rec);
  let e = null;
  switch (rec.type) {
    case 'LINE': e = makeLine(pt(rec, 10), pt(rec, 11), o); break;
    case 'CIRCLE': e = makeCircle(pt(rec, 10), rec.num(40), o); break;
    case 'ARC': e = makeArc(pt(rec, 10), rec.num(40), rec.num(50), rec.num(51), o); break;
    case 'ELLIPSE': e = ellipseToPlan(rec, makeEllipse(pt(rec, 10), pt(rec, 11), rec.num(40, 1), rec.num(41), rec.has(42) ? rec.num(42) : Math.PI * 2, o)); break;
    case 'LWPOLYLINE': e = buildLwpolyline(rec, o); break;
    case 'POLYLINE': e = buildPolyline(rec, extra.verts, o); break;
    case 'SPLINE': e = buildSpline(rec, o); break;
    case 'TEXT': e = buildText(rec, o); break;
    case 'MTEXT': e = buildMText(rec, o); break;
    case 'POINT': e = makePoint(pt(rec, 10), o); break;
    case 'SOLID': case 'TRACE': e = buildSolid(rec, o); break;
    case 'INSERT': e = buildInsert(rec, o); break;
    case 'HATCH': e = buildHatch(rec, o, doc); break;
    case 'DIMENSION': e = buildDimension(rec, o); break;
    case 'LEADER': e = buildLeader(rec, o); break;
    case 'MLEADER': case 'MULTILEADER': {
      const tags = rec.tags();
      const ml = mleaderFromTags(tags, tags.map(([c, v]) => c === 340 && mlStyles.get(v)).find(Boolean) ?? mlStyles.get('*'));
      e = ml && { ...ml, ...o, type: 'MLEADER' };
      break;
    }
    case 'IMAGE': {
      const tags = rec.tags();
      const h = tags.find(([c]) => c === 340)?.[1];
      e = { ...o, id: 0, type: 'IMAGE', ...imageFromTags(tags, imageDefs.get(h) ?? null) };
      break;
    }
    case 'WIPEOUT': {
      e = { ...o, id: 0, type: 'WIPEOUT', ...imageFromTags(rec.tags(), null) };
      delete e.def; delete e.path;
      break;
    }
    case 'MLINE': { const ml = mlineFromTags(rec.tags()); e = ml && { ...o, id: 0, type: 'MLINE', ...ml }; break; }
    case 'ATTDEF': case 'ATTRIB': e = buildAttribute(rec, buildText(rec, o)); break;
    default: return undefined;
  }
  if (!e) return null;
  if (rec.int(60) === 1) e.invisible = true;
  const xd = readXData(rec);
  if (xd) e.xdata = xd;
  // OCS entities (3D POLYLINEs, flag 8, are WCS); LINE, SPLINE, POINT, LEADER, MLEADER, IMAGE, MTEXT and ELLIPSE are WCS
  if (rec.type in OCS_ELEVATION && !(rec.type === 'POLYLINE' && (rec.int(70) & 8))) e = ocsToPlan(rec, e);
  return e;
}

function readEntityList(recs, doc, target, stats) {
  for (let k = 0; k < recs.length; k++) {
    const rec = recs[k];
    const t = rec.type;
    if (stats.tick && (k & 4095) === 0) stats.tick(rec.a);
    if (t === 'VERTEX' || t === 'SEQEND' || t === 'ATTRIB') continue; // consumed with their parent
    let extra = {};
    if (t === 'POLYLINE') {
      const verts = [];
      let j = k + 1;
      while (j < recs.length && recs[j].type === 'VERTEX') { verts.push(recs[j]); j++; }
      extra = { verts };
    }
    let attribs = null;
    if (t === 'INSERT' && rec.int(66) === 1) {
      attribs = [];
      let j = k + 1;
      while (j < recs.length && recs[j].type === 'ATTRIB') { attribs.push(recs[j]); j++; }
    }
    // paper space: ENTITIES with 67=1 belong to the active layout (*Paper_Space); layout blocks pass their own list
    const list = rec.int(67) === 1 && target === doc.entities ? stats.paperList('*PAPER_SPACE') : target;
    if (t === 'VIEWPORT') { if (list !== doc.entities) addEntity(doc, readViewport(rec, stats.layerH), list); else doc.skipped[t] = (doc.skipped[t] ?? 0) + 1; continue; }
    let e;
    try { e = buildEntity(rec, doc, extra); } catch (err) { e = undefined; stats.errors.push(`${t}: ${err.message}`); }
    if (e === undefined) { doc.skipped[t] = (doc.skipped[t] ?? 0) + 1; continue; }
    if (e === null) { doc.skipped[`${t} (unusable)`] = (doc.skipped[`${t} (unusable)`] ?? 0) + 1; continue; }
    addEntity(doc, e, list);
    if (attribs) linkAttribs(e, attribs.map((a) => buildEntity(a, doc, {})));
  }
}

// ---------------------------------------------------------------------------------------------
export function parseDxf(text) {
  return parseTokens(tokenizeDxf(new TextEncoder().encode(text), { decoder: new TextDecoder('utf-8', { ignoreBOM: true }) }));
}

function parseTokens(tk, onProgress = null) {
  const secs = sections(tk);
  if (!secs.ENTITIES && !secs.HEADER && !secs.TABLES) {
    const err = new Error('This file does not look like a DXF drawing (no HEADER, TABLES or ENTITIES section).');
    err.code = 'BAD_DXF';
    throw err;
  }
  const doc = newDocument();
  const paperLists = new Map();
  const blockRecH = new Map();
  const stats = { errors: [], layerH: new Map(), tick: onProgress && ((i) => onProgress(i / tk.count)), paperList: (n) => paperLists.get(n.toUpperCase()) ?? paperLists.set(n.toUpperCase(), []).get(n.toUpperCase()) };

  // HEADER
  if (secs.HEADER) {
    const { codes, val } = tk;
    for (let i = secs.HEADER.from; i < secs.HEADER.to; i++) {
      if (codes[i] !== 9) continue;
      const name = val(i);
      let j = i + 1;
      const first = codes[j];
      if (name === '$ACADVER') doc.header.version = val(j);
      else if (name === '$INSUNITS') doc.units = parseInt(val(j), 10) || 0;
      else if (name === '$DWGCODEPAGE') doc.header.codepage = val(j);
      else if (name === '$DIMSTYLE') doc.header.currentDimStyle = val(j);
      else if (name === '$LTSCALE') doc.header.ltscale = parseFloat(val(j)) || 1;
      else if (name === '$EXTMIN' && first === 10) doc.header.extmin = { x: parseFloat(val(j)), y: parseFloat(val(j + 1)) };
      else if (name === '$EXTMAX' && first === 10) doc.header.extmax = { x: parseFloat(val(j)), y: parseFloat(val(j + 1)) };
      j++;
    }
  }

  // TABLES
  if (secs.TABLES) {
    const dimRecs = [], styleH = new Map();
    for (const rec of records(tk, secs.TABLES.from, secs.TABLES.to)) {
      if (rec.type === 'BLOCK_RECORD') blockRecH.set(rec.str(5), rec.str(2));
      if (rec.type === 'STYLE') styleH.set(rec.str(5), rec.str(2));
      if (rec.type === 'LAYER') {
        const name = rec.str(2);
        if (!name) continue;
        stats.layerH.set(rec.str(5), name);
        const c = rec.int(62, 7);
        const flags = rec.int(70);
        if (flags & 16) continue; // xref-dependent layer: recreated when the xref is loaded
        addLayer(doc, {
          name,
          color: rec.has(420) ? trueColor(rec.int(420)) : Math.abs(c) || 7,
          linetype: normLt(rec.str(6, 'CONTINUOUS')),
          lineweight: rec.has(370) ? (rec.int(370) >= 0 ? rec.int(370) / 100 : rec.int(370)) : -3,
          visible: c >= 0,
          frozen: (flags & 1) === 1,
          locked: (flags & 4) === 4,
          plot: rec.int(290, 1) !== 0,
        });
      } else if (rec.type === 'LTYPE') {
        const name = rec.str(2);
        if (!name || /^by(layer|block)$/i.test(name)) continue;
        addLinetype(doc, { name, description: rec.str(3), pattern: rec.allNum(49) });
      } else if (rec.type === 'DIMSTYLE') {
        const name = rec.str(2);
        if (name) { (doc.header.dimStyles ??= []).push(name); dimRecs.push(rec); }
      } else if (rec.type === 'STYLE') {
        const name = rec.str(2);
        if (!name) continue;
        const font = rec.str(3).replace(/\.(ttf|shx|otf)$/i, '') || 'Arial';
        const st = addTextStyle(doc, { name, font, height: rec.num(40), widthFactor: rec.num(41, 1) || 1, oblique: rec.num(50) });
        st.fontFile = rec.str(3);
      }
    }
    if (dimRecs.length) {
      const resolve = (k, h) => (k === 'DIMBLK' ? blockRecH : styleH).get(h);
      doc.dimStyles = new Map(dimRecs.map((r) => { const st = dimStyleFromTags(r.tags(), resolve); return [st.name, st]; }));
    }
  }

  // OBJECTS: MLEADERSTYLE defaults for MLEADER entities
  mlStyles = new Map();
  imageDefs = new Map();
  if (secs.OBJECTS) {
    for (const rec of records(tk, secs.OBJECTS.from, secs.OBJECTS.to)) {
      if (rec.type === 'IMAGEDEF') imageDefs.set(rec.str(5), imageDefFromTags(rec.tags()));
      if (rec.type === 'WIPEOUTVARIABLES') doc.header.wipeoutFrame = rec.int(70); // WIPEOUTFRAME: 0 hidden, 1 shown + plotted, 2 shown only
      if (rec.type === 'MLINESTYLE') (doc.mlineStyles ??= new Map()).set(rec.str(5), mlineStyleFromTags(rec.tags()));
      if (rec.type !== 'MLEADERSTYLE') continue;
      const st = mleaderStyleFromTags(rec.tags());
      mlStyles.set(rec.str(5), st);
      if (!mlStyles.has('*') || /^standard$/i.test(st.name)) mlStyles.set('*', st);
    }
  }

  // BLOCKS
  if (secs.BLOCKS) {
    const recs = records(tk, secs.BLOCKS.from, secs.BLOCKS.to);
    let cur = null;
    let list = [];
    const flush = () => {
      if (!cur) return;
      const isLayoutBlock = /^[*$](model_space|paper_space)/i.test(cur.name);
      // xref: flag bit 4, or (LibreDWG writes the flags without bit 4) a drawing path in group 1
      if ((cur.flags & 4) || (!(cur.flags & 16) && /\.(dwg|dxf)$/i.test(cur.path.trim()))) {
        addBlock(doc, cur.name, cur.base, []).xref = { path: cur.path.trim(), flags: cur.flags | 4, overlay: (cur.flags & 8) === 8, status: 'pending' };
      } else if (cur.flags & 16) { /* xref-dependent block: recreated when the xref is loaded */
      } else if (!isLayoutBlock) {
        const blk = addBlock(doc, cur.name, cur.base, []);
        readEntityList(list, doc, blk.entities, stats);
      } else if (/^[*$]paper_space./i.test(cur.name)) readEntityList(list, doc, stats.paperList(cur.name), stats);
      cur = null; list = [];
    };
    for (const rec of recs) {
      if (rec.type === 'BLOCK') { flush(); cur = { name: rec.str(2), base: pt(rec, 10), flags: rec.int(70), path: rec.str(1) }; }
      else if (rec.type === 'ENDBLK') flush();
      else if (cur) list.push(rec);
    }
    flush();
  }

  // ENTITIES
  if (secs.ENTITIES) readEntityList(records(tk, secs.ENTITIES.from, secs.ENTITIES.to), doc, doc.entities, stats);

  // OBJECTS: LAYOUT objects name the paper-space blocks; paper entities without a layout get a default one
  const layouts = [];
  if (secs.OBJECTS) {
    for (const rec of records(tk, secs.OBJECTS.from, secs.OBJECTS.to)) {
      if (rec.type !== 'LAYOUT') continue;
      const lo = parseLayoutObject(rec.tags());
      const block = blockRecH.get(lo.blockHandle) ?? '';
      if (/^\*model_space$/i.test(block) || lo.name.toUpperCase() === 'MODEL') continue;
      lo.block = block || (layouts.length ? `*Paper_Space${layouts.length - 1}` : '*Paper_Space');
      delete lo.blockHandle;
      lo.entities = paperLists.get(lo.block.toUpperCase()) ?? [];
      paperLists.delete(lo.block.toUpperCase());
      layouts.push(lo);
    }
  }
  for (const [blk, ents] of paperLists) {
    if (!ents.length) continue;
    const lo = parseLayoutObject([]);
    Object.assign(lo, { name: `Layout${layouts.length + 1}`, tab: layouts.length + 1, block: blk, entities: ents });
    delete lo.blockHandle;
    layouts.push(lo);
  }
  layouts.sort((a, b) => a.tab - b.tab);
  doc.layouts = layouts;
  if (stats.errors.length) doc.header.readErrors = stats.errors.slice(0, 20);
  if (tk.repaired) doc.header.repairedValues = tk.repaired; // text values split over several lines, rejoined
  return doc;
}

/** onProgress(fraction): the byte scan is the first half, reading the BLOCKS and ENTITIES records the second */
export function readDxf(bytes, { onProgress = null } = {}) {
  const tk = tokenizeDxf(bytes, { onProgress: onProgress && ((f) => onProgress(f / 2)) });
  const doc = parseTokens(tk, onProgress && ((f) => onProgress(0.5 + f / 2)));
  onProgress?.(1);
  return doc;
}
