// GD&T symbol fonts: AutoCAD's gdt.shx / amgdt.shx draw geometric-tolerance symbols for plain lowercase ASCII
// letters. The SHX files are not shipped, so for display the letters are mapped to Unicode symbols (display only:
// the stored text is never changed). Source and the letters that are confirmed: docs/FONTS.md.
//
//   isGdtFont(nameOrFile)        -> true for gdt / amgdt (with or without .shx)
//   gdtText(text)                -> text with every mapped letter replaced by its symbol
//   gdtModel(mt, styleIsGdt)     -> parsed MTEXT model with the run text of GDT runs mapped (in place; returns mt)
export const GDT_MAP = Object.freeze({
  a: '∠', // angularity
  b: '⟂', // perpendicularity
  c: '▱', // flatness
  d: '⌓', // surface profile
  e: '○', // circularity
  f: '∥', // parallelism
  g: '⌭', // cylindricity
  h: '↗', // circular runout
  i: '⌯', // symmetry
  j: '⌖', // position
  k: '⌒', // line profile
  l: 'Ⓛ', // least material condition
  m: 'Ⓜ', // maximum material condition
  n: '⌀', // diameter
  p: 'Ⓟ', // projected tolerance zone
  r: '◎', // concentricity
  s: 'Ⓢ', // regardless of feature size
  t: '⌰', // total runout
  u: '⏤', // straightness
});

export function isGdtFont(nameOrFile) {
  const f = String(nameOrFile ?? '').trim().toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(shx|ttf|otf)$/, '');
  return f === 'gdt' || f === 'amgdt';
}

export function gdtText(text) {
  return String(text ?? '').replace(/[a-z]/g, (c) => GDT_MAP[c] ?? c);
}

export function gdtModel(mt, styleIsGdt) {
  for (const p of mt.paras) {
    for (const r of p.runs) {
      if (r.text === undefined) continue;
      if (r.props.font ? isGdtFont(r.props.font) : styleIsGdt) r.text = gdtText(r.text);
    }
  }
  return mt;
}
