// ASH Draw Studio - dimension engine: measurement, text formatting and the geometry of the anonymous *D block.
// Pure ES module.
//
// Definitions (`def`), all points {x,y} in WCS:
//   { kind:'linear',   p1, p2, at, angle }   rotated linear; angle in degrees (0 horizontal, 90 vertical); `at` on the dim line
//   { kind:'aligned',  p1, p2, at }
//   { kind:'angular',  l1:[a,b], l2:[c,d], at }   two lines; `at` picks the sector and the arc radius
//   { kind:'angular3', vertex, p1, p2, at }
//   { kind:'radius',   center, p }           p on the curve
//   { kind:'diameter', center, p }           p on the curve (the opposite point is mirrored through center)
//   optional on every def: text (override; '' or '<>' = measured, '<>' inside is substituted, ' ' = no text)
//
//   buildDimension(def, style) -> { measurement, text, textMid, textRot, dimType, entities }
//       measurement is the DXF group-42 value: drawing units x DIMLFAC, radians for angular.
//   formatLinear(value, style) / formatAngle(radians, style) -> string
//   continueDimension(prev, point) / baselineDimension(prev, point, style) -> next def
//   createDimension(doc, def, styleName, o) -> DIMENSION entity added to doc, with its *D block
//   regenerateDimension(doc, e, style)      -> rebuilds e's block from e.def (drops the stored raw tags)
//   dimensionTags(e) -> DXF group pairs after the common entity head;  dimDefFromTags(tags) -> def | null
//   arrowEntities(kind, tip, dir, size, o)  -> arrowhead entities (DIMBLK names: '' closed filled, _ARCHTICK, _OBLIQUE, _DOT, _OPEN)
import { makeLine, makeArc, makeSolid, makeMText, makeHatch, addBlock, addEntity } from './model.js';
import { resolveDimStyle, ensureDimStyle } from './dimsStyle.js';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const unit = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const perp = (a) => ({ x: -a.y, y: a.x });
const polar = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
const normAng = (a) => ((a % TAU) + TAU) % TAU;

export const DIM_TYPE = { linear: 0, aligned: 1, angular: 2, diameter: 3, radius: 4, angular3: 5 };

// ---- number formatting -----------------------------------------------------------------------
function fmtDecimal(x, dec, zin, sep = 46) {
  let s = Math.abs(x).toFixed(Math.max(0, dec));
  if (zin & 8 && s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (zin & 4 && s.startsWith('0.')) s = s.slice(1);
  const neg = x < 0 && /[1-9]/.test(s);
  if (sep !== 46) s = s.replace('.', String.fromCharCode(sep));
  return (neg ? '-' : '') + s;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function fraction(num, den) { const g = gcd(num, den); return `${num / g}/${den / g}`; }

/** linear value (already multiplied by DIMLFAC) -> text, per DIMLUNIT / DIMDEC / DIMZIN / DIMRND / DIMDSEP */
export function formatLinear(value, st) {
  let x = value;
  if (st.DIMRND > 0) x = Math.round(x / st.DIMRND) * st.DIMRND;
  const dec = st.DIMDEC, zin = st.DIMZIN ?? 0, unitMode = st.DIMLUNIT ?? 2;
  const sign = x < 0 ? '-' : '';
  const ax = Math.abs(x);
  if (unitMode === 1) return x.toExponential(dec).replace(/e\+?/, 'E+').replace('E+-', 'E-');
  if (unitMode === 4 || unitMode === 5) {
    const den = 2 ** Math.max(0, Math.min(8, dec));
    const n = Math.round(ax * den);
    if (unitMode === 5) {
      const whole = Math.floor(n / den), fr = n % den;
      return sign + (fr ? (whole ? `${whole} ${fraction(fr, den)}` : fraction(fr, den)) : `${whole}`);
    }
    const feet = Math.floor(n / (12 * den));
    const rem = n - feet * 12 * den;
    const inch = Math.floor(rem / den), fr = rem % den;
    const inStr = `${inch}${fr ? ` ${fraction(fr, den)}` : ''}"`;
    return sign + feetInches(feet, inStr, rem === 0, zin);
  }
  if (unitMode === 3) {
    const feet = Math.floor(ax / 12 + 1e-12);
    const inches = ax - feet * 12;
    return sign + feetInches(feet, `${fmtDecimal(inches, dec, zin & 12)}"`, Math.abs(inches) < 1e-12, zin);
  }
  return fmtDecimal(x, dec, zin, st.DIMDSEP ?? 46);
}
// DIMZIN low bits for feet-inch units: 0 drop 0' and 0", 1 keep both, 2 keep 0' drop 0", 3 keep 0" drop 0'
function feetInches(feet, inStr, zeroInches, zin) {
  const z = zin & 3;
  const showFeet = feet !== 0 || z === 1 || z === 2;
  const showInches = !zeroInches || z === 1 || z === 3 || feet === 0;
  if (!showFeet) return inStr;
  return showInches ? `${feet}'-${inStr}` : `${feet}'`;
}

/** angle in radians -> text, per DIMAUNIT / DIMADEC / DIMAZIN */
export function formatAngle(rad, st) {
  const dec = st.DIMADEC === -1 || st.DIMADEC === undefined ? st.DIMDEC : st.DIMADEC;
  const azin = st.DIMAZIN ?? 0;
  const zin = (azin & 1 ? 4 : 0) | (azin & 2 ? 8 : 0);
  const sep = st.DIMDSEP ?? 46;
  switch (st.DIMAUNIT ?? 0) {
    case 1: {
      const total = Math.round(Math.abs(rad) * DEG * 3600);
      const d = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
      return `${d}°${m}'${s}"`;
    }
    case 2: return `${fmtDecimal(rad * 200 / Math.PI, dec, zin, sep)}g`;
    case 3: return `${fmtDecimal(rad, dec, zin, sep)}r`;
    default: return `${fmtDecimal(rad * DEG, dec, zin, sep)}°`;
  }
}

/** measured string + DIMPOST + user override (<> substitution) */
function composeText(measured, st, override) {
  let m = measured;
  const post = st.DIMPOST || '';
  if (post) m = post.includes('<>') ? post.replace('<>', m) : m + post;
  const ov = override ?? '';
  if (ov === '' || ov === '<>') return m;
  if (ov === ' ') return '';
  return ov.includes('<>') ? ov.replace('<>', m) : ov;
}

// ---- arrowheads ------------------------------------------------------------------------------
/** tip = arrow point; dir = unit direction the arrow points (from its body to the tip) */
export function arrowEntities(kind, tip, dir, size, o = {}) {
  const px = perp(dir);
  const at = (x, y) => add(tip, add(mul(dir, x * size), mul(px, y * size)));
  const k = String(kind || '').toUpperCase().replace(/^_?/, '_');
  if (k === '_ARCHTICK' || k === '_OBLIQUE') return [makeLine(at(-0.5, -0.5), at(0.5, 0.5), o)];
  if (k === '_OPEN') return [makeLine(at(-1, 1 / 6), tip, o), makeLine(at(-1, -1 / 6), tip, o)];
  if (k === '_DOT' || k === '_DOTSMALL') {
    const r = k === '_DOT' ? 0.25 : 0.0625;
    return [makeHatch([{ pts: [{ ...at(-r, 0), bulge: 1 }, { ...at(r, 0), bulge: 1 }], closed: true }], { ...o, solid: true, pattern: 'SOLID' })];
  }
  if (k === '_NONE') return [];
  return [makeSolid([tip, at(-1, 1 / 6), at(-1, -1 / 6), at(-1, -1 / 6)], o)];
}

// ---- geometry --------------------------------------------------------------------------------
function sizes(st) {
  const s = st.DIMSCALE > 0 ? st.DIMSCALE : 1;
  return { asz: st.DIMASZ * s, exo: st.DIMEXO * s, exe: st.DIMEXE * s, h: st.DIMTXT * s, gap: Math.abs(st.DIMGAP) * s, dli: st.DIMDLI * s };
}
const textWidth = (text, h) => text.length * h * 0.7; // estimate; the real width depends on the font

/** distance of the text centre from the dimension line, per DIMTAD (0 centred, 1/2/3 above, 4 below) */
function textOffset(st, z) {
  const off = z.gap + z.h / 2;
  if (st.DIMTAD === 4) return -off;
  if (st.DIMTAD > 0) return off;
  return 0;
}

/** text along direction t through point mid; inside = text between the extension lines */
function placeText(mid, t, st, z, inside = true) {
  let ang = Math.atan2(t.y, t.x);
  if (ang > Math.PI / 2 + 1e-9) ang -= Math.PI;
  else if (ang <= -Math.PI / 2 + 1e-9) ang += Math.PI;
  const rot = (inside ? st.DIMTIH : st.DIMTOH) ? 0 : ang;
  const up = { x: -Math.sin(rot), y: Math.cos(rot) };
  return { p: add(mid, mul(up, textOffset(st, z))), rot: rot * DEG };
}

function linearGeom(def, st, u, out, o) {
  const z = sizes(st);
  const { p1, p2, at } = def;
  const d1 = add(at, mul(u, dot(sub(p1, at), u)));
  const d2 = add(at, mul(u, dot(sub(p2, at), u)));
  for (const [p, d] of [[p1, d1], [p2, d2]]) {
    const v = sub(d, p);
    if (len(v) < 1e-9) continue;
    const w = unit(v);
    out.push(makeLine(add(p, mul(w, z.exo)), add(d, mul(w, z.exe)), o.ext));
  }
  return { d1, d2, z };
}

/** dimension line d1-d2 with arrows and text; returns text placement */
function dimLine(d1, d2, st, z, text, out, o, arrows = [true, true]) {
  const L = len(sub(d2, d1));
  const t = L > 1e-12 ? unit(sub(d2, d1)) : { x: 1, y: 0 };
  const tw = textWidth(text, z.h);
  const inside = L >= 2 * z.asz + (st.DIMTAD === 0 ? tw + 2 * z.gap : 0);
  let mid = mul(add(d1, d2), 0.5);
  if (st.DIMJUST === 1 || st.DIMJUST === 3) mid = add(d1, mul(t, 2 * z.asz + tw / 2));
  else if (st.DIMJUST === 2 || st.DIMJUST === 4) mid = sub(d2, mul(t, 2 * z.asz + tw / 2));
  const tp = placeText(mid, t, st, z, inside);
  // dimension line, broken around centred text
  const segs = [];
  const a = inside ? d1 : sub(d1, mul(t, 2 * z.asz)), b = inside ? d2 : add(d2, mul(t, 2 * z.asz));
  if (inside || st.DIMTOFL) {
    if (st.DIMTAD === 0 && text) {
      const half = tw / 2 + z.gap;
      const s = dot(sub(mid, a), t), e = len(sub(b, a));
      if (s - half > 0) segs.push([a, add(a, mul(t, s - half))]);
      if (s + half < e) segs.push([add(a, mul(t, s + half)), b]);
    } else segs.push([a, b]);
  }
  if (!inside) { segs.push([a, d1]); segs.push([d2, b]); }
  for (const [p, q] of segs) if (len(sub(q, p)) > 1e-12) out.push(makeLine(p, q, o.dim));
  const sgn = inside ? 1 : -1;
  if (arrows[0]) out.push(...arrowEntities(st.DIMBLK, d1, mul(t, -sgn), z.asz, o.dim));
  if (arrows[1]) out.push(...arrowEntities(st.DIMBLK, d2, mul(t, sgn), z.asz, o.dim));
  return tp;
}

function lineIntersect(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const tt = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  return add(a, mul(r, tt));
}

/** sector of the angle: { c, a0, sweep, rays:[[angle, pts], [angle, pts]] } */
function angularSector(def) {
  if (def.kind === 'angular3') {
    const c = def.vertex;
    const a1 = Math.atan2(def.p1.y - c.y, def.p1.x - c.x), a2 = Math.atan2(def.p2.y - c.y, def.p2.x - c.x);
    const th = Math.atan2(def.at.y - c.y, def.at.x - c.x);
    const s = normAng(a2 - a1);
    if (normAng(th - a1) <= s) return { c, a0: a1, sweep: s, rays: [[a1, [def.p1]], [a2, [def.p2]]] };
    return { c, a0: a2, sweep: TAU - s, rays: [[a2, [def.p2]], [a1, [def.p1]]] };
  }
  const [a, b] = def.l1, [cc, d] = def.l2;
  const c = lineIntersect(a, b, cc, d);
  if (!c) throw new Error('angular dimension: the lines are parallel');
  const v1 = Math.atan2(b.y - a.y, b.x - a.x), v2 = Math.atan2(d.y - cc.y, d.x - cc.x);
  const th = normAng(Math.atan2(def.at.y - c.y, def.at.x - c.x));
  const rays = [[normAng(v1), def.l1], [normAng(v1 + Math.PI), def.l1], [normAng(v2), def.l2], [normAng(v2 + Math.PI), def.l2]]
    .sort((p, q) => p[0] - q[0]);
  for (let i = 0; i < 4; i++) {
    const r0 = rays[i], r1 = rays[(i + 1) % 4];
    const s = normAng(r1[0] - r0[0]);
    if (normAng(th - r0[0]) <= s && r0[1] !== r1[1]) return { c, a0: r0[0], sweep: s, rays: [r0, r1] };
  }
  return { c, a0: rays[0][0], sweep: normAng(rays[1][0] - rays[0][0]), rays: [rays[0], rays[1]] };
}

function angularGeom(def, st, text, out, o) {
  const z = sizes(st);
  const { c, a0, sweep, rays } = angularSector(def);
  const r = len(sub(def.at, c));
  const a1 = a0 + sweep;
  out.push(makeArc(c, r, a0 * DEG, a1 * DEG, o.dim));
  for (const [ang, pts] of rays) {
    const w = { x: Math.cos(ang), y: Math.sin(ang) };
    const ts = pts.map((p) => dot(sub(p, c), w)).filter((t) => t > -1e-9);
    if (!ts.length) continue;
    const tmax = Math.max(...ts), tmin = Math.min(...ts);
    if (r > tmax + 1e-9) out.push(makeLine(add(c, mul(w, tmax + z.exo)), add(c, mul(w, r + z.exe)), o.ext));
    else if (r < tmin - 1e-9) out.push(makeLine(add(c, mul(w, tmin - z.exo)), add(c, mul(w, r - z.exe)), o.ext));
  }
  out.push(...arrowEntities(st.DIMBLK, polar(c, r, a0), { x: Math.sin(a0), y: -Math.cos(a0) }, z.asz, o.dim));
  out.push(...arrowEntities(st.DIMBLK, polar(c, r, a1), { x: -Math.sin(a1), y: Math.cos(a1) }, z.asz, o.dim));
  const am = a0 + sweep / 2;
  const tp = placeText(polar(c, r, am), { x: -Math.sin(am), y: Math.cos(am) }, st, z, true);
  void text;
  return { tp, sweep, P10: def.kind === 'angular3' ? def.at : def.l2[1] };
}

/** def + style -> measurement, text and the entities of the dimension block (block base 0,0 = WCS) */
export function buildDimension(def, st) {
  const colorOf = (c) => (c === undefined ? 0 : c);
  const o = { dim: { color: colorOf(st.DIMCLRD) }, ext: { color: colorOf(st.DIMCLRE) }, text: { color: colorOf(st.DIMCLRT) } };
  const entities = [];
  const lf = st.DIMLFAC || 1;
  let measurement, text, tp, P10;
  switch (def.kind) {
    case 'linear': case 'aligned': {
      const u = def.kind === 'linear' ? { x: Math.cos((def.angle ?? 0) / DEG), y: Math.sin((def.angle ?? 0) / DEG) } : unit(sub(def.p2, def.p1));
      measurement = Math.abs(dot(sub(def.p2, def.p1), u)) * lf;
      text = composeText(formatLinear(measurement, st), st, def.text);
      const { d1, d2, z } = linearGeom(def, st, u, entities, o);
      tp = dimLine(d1, d2, st, z, text, entities, o);
      P10 = d2;
      break;
    }
    case 'angular': case 'angular3': {
      const tmp = [];
      const g = angularGeom(def, st, '', tmp, o);
      measurement = g.sweep;
      text = composeText(formatAngle(measurement, st), st, def.text);
      entities.push(...tmp);
      ({ tp, P10 } = g);
      break;
    }
    case 'radius': case 'diameter': {
      const z = sizes(st);
      const r = len(sub(def.p, def.center));
      const q = def.kind === 'diameter' ? sub(mul(def.center, 2), def.p) : def.center;
      measurement = (def.kind === 'diameter' ? 2 * r : r) * lf;
      text = composeText((def.kind === 'diameter' ? 'Ø' : 'R') + formatLinear(measurement, st), st, def.text);
      tp = dimLine(q, def.p, st, { ...z, asz: z.asz }, text, entities, o, [def.kind === 'diameter', true]);
      P10 = q;
      break;
    }
    default: throw new Error(`unsupported dimension kind "${def.kind}"`);
  }
  if (text) {
    const z = sizes(st);
    entities.push(makeMText(tp.p, z.h, text, { ...o.text, rot: tp.rot, attach: 5, style: st.DIMTXSTY || 'Standard' }));
  }
  return { measurement, text, textMid: tp.p, textRot: tp.rot, dimType: DIM_TYPE[def.kind], entities, P10 };
}

// ---- continue / baseline -----------------------------------------------------------------------
/** next def of a DIMCONTINUE chain: starts at the previous second point, same dimension line */
export function continueDimension(prev, point) {
  if (prev.kind === 'linear' || prev.kind === 'aligned') {
    const angle = prev.kind === 'linear' ? prev.angle ?? 0 : Math.atan2(prev.p2.y - prev.p1.y, prev.p2.x - prev.p1.x) * DEG;
    return { kind: 'linear', p1: { ...prev.p2 }, p2: { ...point }, at: { ...prev.at }, angle };
  }
  if (prev.kind === 'angular3') {
    const s = angularSector(prev);
    const end = s.rays[1][1][0];
    return { kind: 'angular3', vertex: { ...prev.vertex }, p1: { ...end }, p2: { ...point }, at: polar(prev.vertex, len(sub(prev.at, prev.vertex)), (s.a0 + s.sweep + normAng(Math.atan2(point.y - prev.vertex.y, point.x - prev.vertex.x) - s.a0 - s.sweep) / 2)) };
  }
  return null;
}

/** next def of a DIMBASELINE chain: same first point, dimension line moved out by DIMDLI */
export function baselineDimension(prev, point, st) {
  const dli = sizes(st).dli;
  if (prev.kind === 'linear' || prev.kind === 'aligned') {
    const angle = prev.kind === 'linear' ? prev.angle ?? 0 : Math.atan2(prev.p2.y - prev.p1.y, prev.p2.x - prev.p1.x) * DEG;
    const n = perp({ x: Math.cos(angle / DEG), y: Math.sin(angle / DEG) });
    const side = Math.sign(dot(sub(prev.at, prev.p1), n)) || 1;
    return { kind: 'linear', p1: { ...prev.p1 }, p2: { ...point }, at: add(prev.at, mul(n, side * dli)), angle };
  }
  if (prev.kind === 'angular3') {
    const s = angularSector(prev);
    const start = s.rays[0][1][0];
    const r = len(sub(prev.at, prev.vertex)) + dli;
    const a2 = Math.atan2(point.y - prev.vertex.y, point.x - prev.vertex.x);
    return { kind: 'angular3', vertex: { ...prev.vertex }, p1: { ...start }, p2: { ...point }, at: polar(prev.vertex, r, s.a0 + normAng(a2 - s.a0) / 2) };
  }
  return null;
}

// ---- document integration ----------------------------------------------------------------------
function anonBlockName(doc) {
  let n = 1;
  const used = new Set([...doc.blocks.keys()].map((k) => k.toUpperCase()));
  while (used.has(`*D${n}`)) n++;
  return `*D${n}`;
}

function applyBuild(doc, e, st) {
  const r = buildDimension(e.def, st);
  let blk = doc.blocks.get(e.block);
  if (!blk) blk = addBlock(doc, e.block, { x: 0, y: 0 }, []);
  blk.entities.length = 0;
  for (const x of r.entities) addEntity(doc, x, blk.entities);
  Object.assign(e, { dimType: r.dimType, p: { ...r.textMid }, measurement: r.measurement, dimText: r.text, textRot: r.textRot, defPoint: { ...r.P10 } });
  e.raw = null;
  return e;
}

/** a new DIMENSION entity (model entity type 'DIMENSION') with its generated *D block */
export function createDimension(doc, def, styleName = 'ISO-25', o = {}) {
  const st = ensureDimStyle(doc, styleName);
  const e = {
    id: 0, type: 'DIMENSION', layer: o.layer ?? '0', color: o.color ?? 256, linetype: o.linetype ?? 'BYLAYER',
    lineweight: o.lineweight ?? -1, ltscale: o.ltscale ?? 1,
    block: anonBlockName(doc), dimType: 0, p: null, text: def.text ?? '', def, style: st.name,
  };
  applyBuild(doc, e, st);
  addEntity(doc, e);
  return e;
}

/** rebuild the block from e.def (after the def or the style changed) */
export function regenerateDimension(doc, e, st = resolveDimStyle(doc, e.style)) {
  if (!e.def) throw new Error('dimension has no definition to regenerate from');
  e.text = e.def.text ?? '';
  return applyBuild(doc, e, st);
}

// ---- DXF ----------------------------------------------------------------------------------------
const P3 = (code, p) => [[code, p.x], [code + 10, p.y], [code + 20, 0]];

/** DIMENSION body (after the AcDbEntity head) for a dimension built by this module */
export function dimensionTags(e) {
  const d = e.def;
  const t = [[100, 'AcDbDimension'], [2, e.block], ...P3(10, e.defPoint), ...P3(11, e.p), [70, DIM_TYPE[d.kind] | 32], [71, 5],
    [42, e.measurement], [1, e.text ?? ''], [3, e.style || 'Standard']];
  switch (d.kind) {
    case 'linear': t.push([100, 'AcDbAlignedDimension'], ...P3(13, d.p1), ...P3(14, d.p2), [50, d.angle ?? 0], [100, 'AcDbRotatedDimension']); break;
    case 'aligned': t.push([100, 'AcDbAlignedDimension'], ...P3(13, d.p1), ...P3(14, d.p2)); break;
    case 'angular': t.push([100, 'AcDb2LineAngularDimension'], ...P3(13, d.l1[0]), ...P3(14, d.l1[1]), ...P3(15, d.l2[0]), ...P3(16, d.at)); break;
    case 'angular3': t.push([100, 'AcDb3PointAngularDimension'], ...P3(13, d.p1), ...P3(14, d.p2), ...P3(15, d.vertex)); break;
    case 'radius': t.push([100, 'AcDbRadialDimension'], ...P3(15, d.p), [40, 0]); break;
    case 'diameter': t.push([100, 'AcDbDiametricDimension'], ...P3(15, d.p), [40, 0]); break;
    default: break;
  }
  return t;
}

/** def from the DIMENSION group pairs of a file (null for ordinate / unknown) */
export function dimDefFromTags(tags) {
  const first = new Map();
  for (const [c, v] of tags) if (!first.has(c)) first.set(c, v);
  const n = (c) => parseFloat(first.get(c) ?? '0') || 0;
  const P = (c) => ({ x: n(c), y: n(c + 10) });
  const text = first.get(1) ?? '';
  switch (Math.trunc(n(70)) & 7) {
    case 0: return { kind: 'linear', p1: P(13), p2: P(14), at: P(10), angle: n(50), text };
    case 1: return { kind: 'aligned', p1: P(13), p2: P(14), at: P(10), text };
    case 2: return { kind: 'angular', l1: [P(13), P(14)], l2: [P(15), P(10)], at: P(16), text };
    case 3: return { kind: 'diameter', center: mul(add(P(10), P(15)), 0.5), p: P(15), text };
    case 4: return { kind: 'radius', center: P(10), p: P(15), text };
    case 5: return { kind: 'angular3', vertex: P(15), p1: P(13), p2: P(14), at: P(10), text };
    default: return null;
  }
}
