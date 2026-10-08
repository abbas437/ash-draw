// ASH Draw Studio - dimension styles (DIMSTYLE table). Pure ES module.
//
// A style is a plain object keyed by the AutoCAD system-variable names (DIMSCALE, DIMASZ, ...) plus `name`.
//   defaultDimStyle(name)            -> style ('Standard' = AutoCAD imperial defaults, anything else = ISO-25)
//   dimStyleFromTags(tags, resolve)  -> style from DIMSTYLE record [code, value] pairs
//   dimStyleTags(style, handles)     -> [code, value] pairs for the DIMSTYLE record body (after group 2)
//   resolveDimStyle(doc, name)       -> doc.dimStyles entry or default
//   ensureDimStyle(doc, name)        -> adds the default to doc.dimStyles when missing

/** variable -> [group code, kind]; kind: 'n' number, 'i' integer, 's' string, 'h' handle (name resolved) */
export const DIMVARS = {
  DIMPOST: [3, 's'], DIMSCALE: [40, 'n'], DIMASZ: [41, 'n'], DIMEXO: [42, 'n'], DIMDLI: [43, 'n'], DIMEXE: [44, 'n'],
  DIMRND: [45, 'n'], DIMTXT: [140, 'n'], DIMLFAC: [144, 'n'], DIMGAP: [147, 'n'],
  DIMTIH: [73, 'i'], DIMTOH: [74, 'i'], DIMTAD: [77, 'i'], DIMZIN: [78, 'i'], DIMAZIN: [79, 'i'],
  DIMTOFL: [172, 'i'], DIMCLRD: [176, 'i'], DIMCLRE: [177, 'i'], DIMCLRT: [178, 'i'], DIMADEC: [179, 'i'],
  DIMDEC: [271, 'i'], DIMAUNIT: [275, 'i'], DIMLUNIT: [277, 'i'], DIMDSEP: [278, 'i'], DIMJUST: [280, 'i'],
  DIMTXSTY: [340, 'h'], DIMBLK: [342, 'h'],
};

const STANDARD = {
  DIMPOST: '', DIMSCALE: 1, DIMASZ: 0.18, DIMEXO: 0.0625, DIMDLI: 0.38, DIMEXE: 0.18, DIMRND: 0, DIMTXT: 0.18,
  DIMLFAC: 1, DIMGAP: 0.09, DIMTIH: 1, DIMTOH: 1, DIMTAD: 0, DIMZIN: 0, DIMAZIN: 0, DIMTOFL: 0,
  DIMCLRD: 0, DIMCLRE: 0, DIMCLRT: 0, DIMADEC: 0, DIMDEC: 4, DIMAUNIT: 0, DIMLUNIT: 2, DIMDSEP: 46, DIMJUST: 0,
  DIMTXSTY: 'Standard', DIMBLK: '',
};
const ISO25 = {
  ...STANDARD, DIMASZ: 2.5, DIMEXO: 0.625, DIMDLI: 3.75, DIMEXE: 1.25, DIMTXT: 2.5, DIMGAP: 0.625,
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
    else out.push([code, v]);
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
