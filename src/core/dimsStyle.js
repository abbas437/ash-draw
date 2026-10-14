// ASH Draw Studio - dimension styles (DIMSTYLE table). Pure ES module.
//
// A style is a plain object keyed by the AutoCAD system-variable names (DIMSCALE, DIMASZ, ...) plus `name`.
//   defaultDimStyle(name)            -> style ('Standard' = AutoCAD imperial defaults, anything else = ISO-25)
//   dimStyleFromTags(tags, resolve)  -> style from DIMSTYLE record [code, value] pairs
//   dimStyleTags(style, handles)     -> [code, value] pairs for the DIMSTYLE record body (after group 2)
//   resolveDimStyle(doc, name)       -> doc.dimStyles entry or default
//   ensureDimStyle(doc, name)        -> adds the default to doc.dimStyles when missing

import { aciField } from './aci.js';

/** variable -> [group code, kind]; kind: 'n' number, 'i' integer, 'c' colour (ACI 0..256; raw CmColor values from
 *  converters are decoded), 's' string, 'h' handle (name resolved) */
export const DIMVARS = {
  DIMPOST: [3, 's'], DIMSCALE: [40, 'n'], DIMASZ: [41, 'n'], DIMEXO: [42, 'n'], DIMDLI: [43, 'n'], DIMEXE: [44, 'n'],
  DIMRND: [45, 'n'], DIMTXT: [140, 'n'], DIMCEN: [141, 'n'], DIMLFAC: [144, 'n'], DIMGAP: [147, 'n'],
  DIMTIH: [73, 'i'], DIMTOH: [74, 'i'], DIMTAD: [77, 'i'], DIMZIN: [78, 'i'], DIMAZIN: [79, 'i'],
  DIMTOFL: [172, 'i'], DIMCLRD: [176, 'c'], DIMCLRE: [177, 'c'], DIMCLRT: [178, 'c'], DIMADEC: [179, 'i'],
  DIMDEC: [271, 'i'], DIMAUNIT: [275, 'i'], DIMLUNIT: [277, 'i'], DIMDSEP: [278, 'i'], DIMJUST: [280, 'i'],
  DIMTXSTY: [340, 'h'], DIMBLK: [342, 'h'],
};

/** further variables a per-dimension DSTYLE override (XDATA "ACAD") may carry; read and written back, and those the
 *  dimension engine knows (DIMSAH / DIMBLK1 / DIMBLK2 separate arrows, DIMTMOVE) are applied */
export const DIMVARS_OVERRIDE = {
  ...DIMVARS, DIMTSZ: [142, 'n'], DIMTVP: [145, 'n'], DIMTFAC: [146, 'n'], DIMALTF: [143, 'n'], DIMTP: [47, 'n'], DIMTM: [48, 'n'],
  DIMTOL: [71, 'i'], DIMLIM: [72, 'i'], DIMSE1: [75, 'i'], DIMSE2: [76, 'i'], DIMALT: [170, 'i'], DIMALTD: [171, 'i'],
  DIMSAH: [173, 'i'], DIMTIX: [174, 'i'], DIMSOXD: [175, 'i'], DIMTDEC: [272, 'i'], DIMFRAC: [276, 'i'], DIMTMOVE: [279, 'i'],
  DIMATFIT: [289, 'i'], DIMLDRBLK: [341, 'h'], DIMBLK1: [343, 'h'], DIMBLK2: [344, 'h'], DIMLWD: [371, 'i'], DIMLWE: [372, 'i'],
  DIMAPOST: [4, 's'],
};
const OVERRIDE_BY_CODE = new Map(Object.entries(DIMVARS_OVERRIDE).map(([k, [c, kind]]) => [c, [k, kind]]));
const XD_CODE = { n: 1040, i: 1070, c: 1070, s: 1000, h: 1005 };

/** ACAD XDATA [[code, value], ...] of a DIMENSION -> DSTYLE overrides { DIMSCALE: 50, DIMBLK: 'NAME', ... } or null.
 *  resolve(kind, handle) -> name for handle variables (unresolvable ones are dropped); codes without a name here are
 *  kept as G<code>: { x: xdata code, v: value } so they are written back unchanged */
export function dimOverridesFromXData(tags, resolve = () => undefined) {
  const at = tags.findIndex(([c, v]) => c === 1000 && String(v).toUpperCase() === 'DSTYLE');
  if (at < 0 || tags[at + 1]?.[0] !== 1002) return null;
  const out = {};
  for (let i = at + 2; i + 1 < tags.length; i += 2) {
    const [c, v] = tags[i];
    if (c === 1002) break;
    if (c !== 1070) break;
    const code = parseInt(v, 10), [xc, xv] = tags[i + 1];
    const known = OVERRIDE_BY_CODE.get(code);
    if (!known) { if (xc !== 1005) out[`G${code}`] = { x: xc, v: xv }; continue; }
    const [k, kind] = known;
    if (kind === 'h') { const n = resolve(k, xv); if (n !== undefined) out[k] = /^_?closedfilled$/i.test(n) ? '' : n; } else if (kind === 's') out[k] = String(xv);
    else if (kind === 'c') out[k] = aciField(xv, 0);
    else { const x = kind === 'n' ? parseFloat(xv) : parseInt(xv, 10); if (Number.isFinite(x)) out[k] = x; }
  }
  return Object.keys(out).length ? out : null;
}

/** DSTYLE overrides -> ACAD XDATA tags (after 1001 ACAD); handles(kind, name) -> handle or undefined (then omitted) */
export function dimOverridesXData(ov, handles = () => undefined) {
  const body = [];
  for (const [k, v] of Object.entries(ov ?? {})) {
    if (v && typeof v === 'object' && /^G\d+$/.test(k)) { body.push([1070, +k.slice(1)], [v.x, v.v]); continue; }
    const d = DIMVARS_OVERRIDE[k];
    if (!d) continue;
    const [code, kind] = d;
    if (kind === 'h') {
      const h = handles(k, v === '' ? '_ClosedFilled' : v); // an empty arrow name is the default (closed filled) block
      if (h) body.push([1070, code], [1005, h]);
    } else body.push([1070, code], [XD_CODE[kind], kind === 'c' ? aciField(v) : v]);
  }
  return body.length ? [[1000, 'DSTYLE'], [1002, '{'], ...body, [1002, '}']] : [];
}

/** style with the per-dimension overrides applied (named variables only) */
export function withDimOverrides(st, ov) {
  if (!ov) return st;
  const r = { ...st };
  for (const [k, v] of Object.entries(ov)) if (k in DIMVARS_OVERRIDE) r[k] = v;
  return r;
}

const STANDARD = {
  DIMPOST: '', DIMSCALE: 1, DIMASZ: 0.18, DIMEXO: 0.0625, DIMDLI: 0.38, DIMEXE: 0.18, DIMRND: 0, DIMTXT: 0.18, DIMCEN: 0.09,
  DIMLFAC: 1, DIMGAP: 0.09, DIMTIH: 1, DIMTOH: 1, DIMTAD: 0, DIMZIN: 0, DIMAZIN: 0, DIMTOFL: 0,
  DIMCLRD: 0, DIMCLRE: 0, DIMCLRT: 0, DIMADEC: 0, DIMDEC: 4, DIMAUNIT: 0, DIMLUNIT: 2, DIMDSEP: 46, DIMJUST: 0,
  DIMTXSTY: 'Standard', DIMBLK: '',
};
const ISO25 = {
  ...STANDARD, DIMASZ: 2.5, DIMEXO: 0.625, DIMDLI: 3.75, DIMEXE: 1.25, DIMTXT: 2.5, DIMCEN: 2.5, DIMGAP: 0.625,
  DIMTIH: 0, DIMTOH: 0, DIMTAD: 1, DIMZIN: 8, DIMTOFL: 1, DIMDEC: 2, DIMDSEP: 44,
};

export function defaultDimStyle(name = 'ISO-25') {
  return { name, ...(String(name).toLowerCase() === 'standard' ? STANDARD : ISO25) };
}

/** resolve(kind, handle) -> name, for 'h' variables (DIMTXSTY -> STYLE name, DIMBLK -> BLOCK_RECORD name) */
export function dimStyleFromTags(tags, resolve = () => '') {
  const map = new Map();
  for (const [c, v] of tags) if (!map.has(c)) map.set(c, v);
  const name = map.get(2) ?? 'Standard';
  const st = defaultDimStyle(name);
  for (const [k, [code, kind]] of Object.entries(DIMVARS)) {
    if (!map.has(code)) continue;
    const v = map.get(code);
    if (kind === 's') st[k] = v;
    else if (kind === 'h') st[k] = resolve(k, v) ?? '';
    else if (kind === 'c') st[k] = aciField(v, st[k]);
    else { const x = kind === 'i' ? parseInt(v, 10) : parseFloat(v); if (Number.isFinite(x)) st[k] = x; }
  }
  // R12 files keep DIMBLK as a name in group 5
  if (!map.has(342) && map.has(5) && !/^[0-9A-F]+$/i.test(String(map.get(5)))) st.DIMBLK = map.get(5);
  if (/^_?closedfilled$/i.test(st.DIMBLK)) st.DIMBLK = '';
  return st;
}

/** handles(kind, name) -> handle string or undefined (variable is then omitted) */
export function dimStyleTags(style, handles = () => undefined) {
  const out = [[70, 0]];
  for (const [k, [code, kind]] of Object.entries(DIMVARS)) {
    const v = style[k];
    if (v === undefined) continue;
    if (kind === 'h') { if (v) { const h = handles(k, v); if (h) out.push([code, h]); } }
    else out.push([code, kind === 'c' ? aciField(v) : v]);
  }
  return out;
}

export function resolveDimStyle(doc, name = 'Standard') {
  const m = doc.dimStyles;
  if (m) for (const [k, v] of m) if (k.toLowerCase() === String(name).toLowerCase()) return v;
  return defaultDimStyle(name);
}

export function ensureDimStyle(doc, name = 'ISO-25') {
  doc.dimStyles ??= new Map();
  for (const k of doc.dimStyles.keys()) if (k.toLowerCase() === String(name).toLowerCase()) return doc.dimStyles.get(k);
  const st = defaultDimStyle(name);
  doc.dimStyles.set(name, st);
  return st;
}
