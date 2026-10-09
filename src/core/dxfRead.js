// ASH Draw Studio - DXF reader (ASCII DXF, R12 .. R2018). Pure ES module, no dependencies.
//
// Own group-code reader (instead of a third-party parser) so that HATCH, LEADER, layer settings,
// true colour, line weights, text styles, extrusion and unknown-entity accounting are handled in one place.
//
//   decodeDxfBytes(Uint8Array) -> string      (throws Error{code:'BINARY_DXF'} for binary DXF)
//   parseDxf(text)             -> doc         (see model.js)
//   readDxf(Uint8Array)        -> doc
//   plainText(raw)             -> display string (text codes resolved)
import { buildAttribute, linkAttribs } from './blocks.js';
import {
  newDocument, addLayer, addLinetype, addTextStyle, addBlock, addEntity, BYLAYER,
  makeLine, makeCircle, makeArc, makeEllipse, makePolyline, makePoint, makeText, makeMText,
  makeSpline, makeSolid, makeInsert, makeHatch, makeDimension, makeLeader,
} from './model.js';
import { transformEntity } from './geom.js';
import { dimStyleFromTags } from './dimsStyle.js';
import { dimDefFromTags } from './dims.js';
import { mtextPlain } from './mtext.js';
import { mleaderFromTags, mleaderStyleFromTags } from './mleader.js';
import { parseLayoutObject, readViewport } from './layouts.js';
import { imageDefFromTags, imageFromTags } from './image.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// bytes -> text
const BINARY_SENTINEL = 'AutoCAD Binary DXF';

const CODEPAGE_LABEL = {
  ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5', ANSI_874: 'windows-874',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258', DOS866: 'ibm866', UTF8: 'utf-8', 'UTF-8': 'utf-8',
};

export function decodeDxfBytes(bytes) {
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
  const modern = ver >= 'AC1021';
  if (modern || start) return new TextDecoder('utf-8').decode(body);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { /* not UTF-8 */ }
  const label = (cp && CODEPAGE_LABEL[cp]) || 'windows-1252';
  try { return new TextDecoder(label).decode(body); } catch { return new TextDecoder('windows-1252').decode(body); }
}

// ---------------------------------------------------------------------------------------------
// text helpers

const decodeU = (s) => (s.includes('\\U+') ? s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : s);

/** Resolve DXF text codes into what should be displayed (also used for MTEXT): derived from the MTEXT parser. */
export function plainText(raw) {
  return mtextPlain(raw);
}

// ---------------------------------------------------------------------------------------------
// tokenizer: parallel arrays of group codes and raw values
function tokenize(text) {
  const codes = [];
  const vals = [];
  let pos = 0;
  const n = text.length;
  const nextLine = () => {
    if (pos > n) return null;
    let e = text.indexOf('\n', pos);
    if (e < 0) e = n;
    let line = text.slice(pos, e);
    pos = e + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line;
  };
  for (;;) {
    const c = nextLine();
    if (c === null) break;
    if (c.trim() === '' && pos > n) break;
    const v = nextLine();
    if (v === null) break;
    const code = parseInt(c, 10);
    if (Number.isNaN(code)) {
      const err = new Error(`Not a DXF file (bad group code "${c.slice(0, 20)}" near line ${codes.length * 2 + 1}).`);
      err.code = 'BAD_DXF';
      throw err;
    }
    codes.push(code);
    vals.push(v);
  }
  return { codes, vals };
}

const isStringCode = (c) => c < 10 || (c >= 100 && c <= 102) || c === 105 || (c >= 300 && c <= 369) || (c >= 390 && c <= 399) || (c >= 410 && c <= 419) || (c >= 430 && c <= 439) || (c >= 470 && c <= 481) || c === 999 || (c >= 1000 && c <= 1009);

class Rec {
  constructor(tk, a, b) { this.tk = tk; this.a = a; this.b = b; this.type = tk.vals[a]; }
  get length() { return this.b - this.a; }
  code(i) { return this.tk.codes[this.a + i]; }
  val(i) { return this.tk.vals[this.a + i]; }
  /** first value for group code, or undefined */
  get(code) {
    const { codes, vals } = this.tk;
    for (let i = this.a + 1; i < this.b; i++) if (codes[i] === code) return isStringCode(code) ? decodeU(vals[i]) : vals[i];
    return undefined;
  }
  num(code, d = 0) { const v = this.get(code); if (v === undefined) return d; const x = parseFloat(v); return Number.isFinite(x) ? x : d; }
  int(code, d = 0) { const v = this.get(code); if (v === undefined) return d; const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; }
  str(code, d = '') { const v = this.get(code); return v === undefined ? d : v; }
  has(code) { return this.get(code) !== undefined; }
  all(code) {
    const out = [];
    const { codes, vals } = this.tk;
    for (let i = this.a + 1; i < this.b; i++) if (codes[i] === code) out.push(isStringCode(code) ? decodeU(vals[i]) : vals[i]);
    return out;
  }
  allNum(code) { return this.all(code).map(parseFloat); }
  /** array of [code, value] pairs (value strings) between a+1 and b */
  tags() { const out = []; for (let i = this.a + 1; i < this.b; i++) out.push([this.tk.codes[i], this.tk.vals[i]]); return out; }
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
  const { codes, vals } = tk;
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === 0 && vals[i] === 'SECTION' && codes[i + 1] === 2) {
      const name = vals[i + 1];
      let j = i + 2;
      while (j < codes.length && !(codes[j] === 0 && vals[j] === 'ENDSEC')) j++;
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

function isFlipped(rec) {
  const nz = rec.num(230, 1);
  return nz < 0 && Math.abs(rec.num(210)) < 1e-6 && Math.abs(rec.num(220)) < 1e-6;
}
const FLIP = [-1, 0, 0, 1, 0, 0];


// -- entity builders --------------------------------------------------------------------------
function buildLwpolyline(rec, o) {
  const verts = [];
  let cur = null;
  const { codes, vals } = rec.tk;
  for (let i = rec.a + 1; i < rec.b; i++) {
    const c = codes[i];
    if (c === 10) { cur = { x: parseFloat(vals[i]), y: 0, bulge: 0 }; verts.push(cur); }
    else if (c === 20 && cur) cur.y = parseFloat(vals[i]);
    else if (c === 42 && cur) cur.bulge = parseFloat(vals[i]) || 0;
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
  const { codes, vals } = rec.tk;
  let cc = null, ff = null;
  for (let i = rec.a + 1; i < rec.b; i++) {
    const c = codes[i];
    if (c === 10) { cc = { x: parseFloat(vals[i]), y: 0 }; ctrl.push(cc); }
    else if (c === 20 && cc) cc.y = parseFloat(vals[i]);
    else if (c === 11) { ff = { x: parseFloat(vals[i]), y: 0 }; fit.push(ff); }
    else if (c === 21 && ff) ff.y = parseFloat(vals[i]);
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
  let rot = rec.num(50);
  if (rec.has(11)) rot = Math.atan2(rec.num(21), rec.num(11)) / DEG;
  rot = ((rot % 360) + 360) % 360;
  return makeMText(pt(rec, 10), rec.num(40, 1), text, {
    ...o, width: rec.num(41), rot, attach: rec.int(71, 1), style: rec.str(7, 'STANDARD').toUpperCase(),
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
  const { codes, vals } = rec.tk;
  let inGroup = false;
  for (let i = rec.a + 1; i < rec.b; i++) {
    const c = codes[i];
    if (c === 102) { inGroup = !vals[i].startsWith('}') ? true : false; continue; }
    if (inGroup) continue;
    if (c === 100) { if (vals[i] === 'AcDbEntity') continue; if (vals[i] === 'AcDbDimension') hasSub = true; }
    if (skip.has(c) || c >= 1000 || (c >= 330 && c <= 369)) continue;
    raw.push([c, vals[i]]);
  }
  const e = makeDimension(rec.str(2), { ...o, dimType: rec.int(70), p: rec.has(11) ? pt(rec, 11) : null, text: rec.str(1) });
  e.raw = hasSub ? raw : null;
  e.style = rec.str(3, 'Standard');
  if (hasSub) e.def = dimDefFromTags(raw);
  return e;
}

function buildLeader(rec, o) {
  const pts = [];
  const { codes, vals } = rec.tk;
  let cur = null;
  for (let i = rec.a + 1; i < rec.b; i++) {
    if (codes[i] === 10) { cur = { x: parseFloat(vals[i]), y: 0 }; pts.push(cur); }
    else if (codes[i] === 20 && cur) cur.y = parseFloat(vals[i]);
  }
  if (pts.length < 2) return null;
  return makeLeader(pts, { ...o, arrow: rec.int(71, 1) !== 0 });
}

function buildHatch(rec, o, doc) {
  const { codes, vals } = rec.tk;
  let i = rec.a + 1;
  const end = rec.b;
  const seek = (code) => { while (i < end && codes[i] !== code) i++; return i < end; };
  const f = (k) => parseFloat(vals[k]);
  const n = (k) => parseInt(vals[k], 10);
  if (!seek(2)) return null;
  const pattern = vals[i].trim() || 'SOLID';
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
  const flipped = isFlipped(rec);
  let e = null;
  switch (rec.type) {
    case 'LINE': e = makeLine(pt(rec, 10), pt(rec, 11), o); break;
    case 'CIRCLE': e = makeCircle(pt(rec, 10), rec.num(40), o); break;
    case 'ARC': e = makeArc(pt(rec, 10), rec.num(40), rec.num(50), rec.num(51), o); break;
    case 'ELLIPSE': e = makeEllipse(pt(rec, 10), pt(rec, 11), rec.num(40, 1), rec.num(41), rec.has(42) ? rec.num(42) : Math.PI * 2, o); break;
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
    case 'ATTDEF': case 'ATTRIB': e = buildAttribute(rec, buildText(rec, o)); break;
    default: return undefined;
  }
  if (!e) return null;
  if (rec.int(60) === 1) e.invisible = true;
  const xd = readXData(rec);
  if (xd) e.xdata = xd;
  if (flipped) {
    if (e.type === 'TEXT') { e.p = { x: -e.p.x, y: e.p.y }; e.rot = 180 - e.rot; if (e.p2) e.p2 = { x: -e.p2.x, y: e.p2.y }; }
    else if (['CIRCLE', 'ARC', 'LWPOLYLINE', 'SOLID', 'INSERT', 'HATCH'].includes(e.type)) {
      const id = e.id;
      const t = transformEntity(e, FLIP);
      t.id = id;
      e = t;
    }
  }
  return e;
}

function readEntityList(recs, doc, target, stats) {
  for (let k = 0; k < recs.length; k++) {
    const rec = recs[k];
    const t = rec.type;
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
  const tk = tokenize(text);
  const secs = sections(tk);
  if (!secs.ENTITIES && !secs.HEADER && !secs.TABLES) {
    const err = new Error('This file does not look like a DXF drawing (no HEADER, TABLES or ENTITIES section).');
    err.code = 'BAD_DXF';
    throw err;
  }
  const doc = newDocument();
  const paperLists = new Map();
  const blockRecH = new Map();
  const stats = { errors: [], layerH: new Map(), paperList: (n) => paperLists.get(n.toUpperCase()) ?? paperLists.set(n.toUpperCase(), []).get(n.toUpperCase()) };

  // HEADER
  if (secs.HEADER) {
    const { codes, vals } = tk;
    for (let i = secs.HEADER.from; i < secs.HEADER.to; i++) {
      if (codes[i] !== 9) continue;
      const name = vals[i];
      let j = i + 1;
      const first = codes[j];
      if (name === '$ACADVER') doc.header.version = vals[j];
      else if (name === '$INSUNITS') doc.units = parseInt(vals[j], 10) || 0;
      else if (name === '$DWGCODEPAGE') doc.header.codepage = vals[j];
      else if (name === '$DIMSTYLE') doc.header.currentDimStyle = vals[j];
      else if (name === '$LTSCALE') doc.header.ltscale = parseFloat(vals[j]) || 1;
      else if (name === '$EXTMIN' && first === 10) doc.header.extmin = { x: parseFloat(vals[j]), y: parseFloat(vals[j + 1]) };
      else if (name === '$EXTMAX' && first === 10) doc.header.extmax = { x: parseFloat(vals[j]), y: parseFloat(vals[j + 1]) };
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
      if (cur.flags & 4) {
        addBlock(doc, cur.name, cur.base, []).xref = { path: cur.path, flags: cur.flags, overlay: (cur.flags & 8) === 8, status: 'pending' };
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
  return doc;
}

export function readDxf(bytes) {
  return parseDxf(decodeDxfBytes(bytes));
}
