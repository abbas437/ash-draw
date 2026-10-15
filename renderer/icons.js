// ASH Draw Studio - the app's own line icon set for the tool panel, toolbars and panels (inline SVG, drawn in currentColor).
// The module has no DOM access at import time, so tests can check the set from Node.
//
// Design rules (every icon follows them; check new ones on the contact sheet, scripts/icon-sheet.mjs):
// - One 24x24 grid, drawn at 20 px (16 px in menus, 14 px in layer rows). Keep shapes inside 2.5 .. 21.5.
// - Stroke 1.75, round caps and joins, set once by the renderer (iconSvg / iconHtml); shapes never set their own stroke width.
// - Open geometric forms (lines, arcs, circles, plain polygons) with one optical size: a full-width shape spans about
//   16-17 units, a round one about 16. No fills except small grip dots; details at least 3 units apart so they read at 16 px.
// - CAD meaning first: the icon shows what the command does to the drawing. Dotted = the original or a ghost (move,
//   trim, stretch) or a markup outline; arrowheads are open 90-degree V's.
// - At most one small accent mark per icon, class="ac" (styles.css draws it in the tool group's hue, also on active
//   buttons): the moved part of move, the trimmed piece's cross, the fillet arc, a dimension's text dot. All else currentColor.

const p = (...d) => d.map((x) => `<path d="${x}"/>`).join('');
/** the accent mark (one per icon) */
const a = (d, extra = '') => `<path class="ac" d="${d}"${extra}/>`;
const c = (cx, cy, r, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}"${extra}/>`;
/** a small grip dot (fill plus the shared stroke: about 3.5 units across) */
const dot = (cx, cy) => c(cx, cy, 0.9, ' fill="currentColor"');
const adot = (cx, cy) => `<circle class="ac" cx="${cx}" cy="${cy}" r="0.9" fill="currentColor"/>`;
/** a circle as path data, so several circles can share one accent element */
const cp = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const DOTTED = ' stroke-dasharray="2.2 2.8"';

/** command id -> SVG inner markup (viewBox 0 0 24 24) */
export const ICONS = {
  // select
  select: p('M6.5 3.5L17.5 13.7 12.7 14.2 15.4 19.6 13.2 20.7 10.5 15.3 6.5 18.9z'),
  pan: p('M8.5 12.5V5.5a1.5 1.5 0 0 1 3 0v5', 'M11.5 10V4a1.5 1.5 0 0 1 3 0v6', 'M14.5 10V5.5a1.5 1.5 0 0 1 3 0V13c0 4.2-2.6 7.5-6.3 7.5-2.5 0-3.8-1-5.3-3.2l-1.3-4.7a1.5 1.5 0 0 1 2.6-1.4L8.5 13'),
  // draw
  line: p('M5 19L19 5') + a(cp(5, 19, 0.9) + cp(19, 5, 0.9), ' fill="currentColor"'),
  xline: p('M4 20L20 4', 'M4 15.5V20h4.5', 'M15.5 4H20v4.5') + adot(12, 12),
  ray: p('M5 19L20 4', 'M15.5 4H20v4.5') + adot(5, 19),
  pline: p('M3.5 18.5L8.5 7l6 8.5 6-10') + a(cp(8.5, 7, 0.9) + cp(14.5, 15.5, 0.9), ' fill="currentColor"'),
  rect: p('M4 6h16v12H4z') + a(cp(4, 18, 0.9) + cp(20, 6, 0.9), ' fill="currentColor"'),
  circle: c(12, 12, 8) + adot(12, 12),
  arc: p('M4 15.5a8 8 0 0 1 16 0') + a(cp(4, 15.5, 0.9) + cp(12, 7.5, 0.9) + cp(20, 15.5, 0.9), ' fill="currentColor"'),
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="5.5"/>' + adot(12, 12),
  polygon: p('M12 4l8.1 5.9-3.1 9.5H7l-3.1-9.5z') + adot(12, 12.5),
  spline: p('M3.5 17C6 7 10 6 12 12s6 5 8.5-5') + a(cp(3.5, 17, 0.9) + cp(12, 12, 0.9) + cp(20.5, 7, 0.9), ' fill="currentColor"'),
  donut: c(12, 12, 8) + a(cp(12, 12, 4)),
  divide: p('M3.5 17C7 7 17 7 20.5 17') + a('M5.9 9.9l2.5 3M12 7.5v4M18.1 9.9l-2.5 3'),
  point: p('M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5') + a(cp(12, 12, 1.3), ' fill="currentColor"'),
  text: p('M12 5v14', 'M9.5 19h5') + a('M5.5 7V5h13v2'),
  mtext: p('M7.5 5v12', 'M5.5 17h4', 'M14 9h6.5M14 13h6.5M14 17h6.5') + a('M3.5 6.5V5h8v1.5'),
  hatch: p('M4 4h16v16H4z') + a('M4 12l8-8M4 20L20 4M12 20l8-8'),
  // modify
  move: p('M10 2.5v15M2.5 10h15', 'M7.5 5L10 2.5 12.5 5M7.5 15l2.5 2.5 2.5-2.5M5 7.5L2.5 10 5 12.5M15 7.5l2.5 2.5-2.5 2.5'),
  copy: p('M3 7h9v10H3z', 'M8 7V3h9v10h-5'),
  rotate: p('M16 10a6 6 0 1 1-1.8-4.3', 'M14.5 2.5v3.6h-3.6') + dot(10, 10),
  align: p('M3 11h5v5H3z', 'M14 3l3.5 3.5-3.5 3.5-3.5-3.5z', 'M8 11l3.5-3.5', 'M8.5 8h3v3') + dot(3, 16) + dot(14, 10),
  scale: p('M3 12h5v5H3z', 'M3 9V3h14v14h-6', 'M10 10l6-6', 'M12 4h4v4'),
  mirror: `<path d="M10 2v16"${DOTTED}/>` + p('M7.5 5L3 15h4.5z', 'M12.5 5L17 15h-4.5z'),
  offset: p('M3 16c0-6.6 5.4-12 12-12', 'M7 17c0-4.4 3.6-8 8-8'),
  trim: p('M12 2.5v15', 'M3 10h9') + `<path d="M12 10h5.5"${DOTTED}/>` + p('M15 6.5l2.5-2M15 4.5l2.5 2'),
  extend: p('M16.5 3v14', 'M3 10h6.5', 'M8 7l3 3-3 3') + `<path d="M11 10h5.5"${DOTTED}/>`,
  explode: p('M10 2.5v4M10 13.5v4M2.5 10h4M13.5 10h4', 'M4.7 4.7l2.5 2.5M12.8 12.8l2.5 2.5M15.3 4.7l-2.5 2.5M7.2 12.8l-2.5 2.5'),
  erase: p('M7.5 16.5L3.5 12.5l8-8 6 6-6 6z', 'M6.5 9.5l6 6', 'M11.5 16.5h5'),
  fillet: p('M3 17V10a6 6 0 0 1 6-6h8'),
  chamfer: p('M3 17V9l5-5h9'),
  break: p('M2 10h5.5M12.5 10H18', 'M7.5 6v8M12.5 6v8'),
  breakatpoint: p('M2 10h7M11 10h7', 'M10 6.5v7'),
  pedit: p('M2 16l5-8 5 5 6-9', 'M11 17l6-6'),
  join: p('M2 10h5M13 10h5', 'M6 7l3 3-3 3M14 7l-3 3 3 3'),
  lengthen: p('M2 7v6', 'M2 10h13', 'M13 6.5l3.5 3.5-3.5 3.5'),
  stretch: `<path d="M2 4h8v12H2"${DOTTED}/>` + p('M10 10h7', 'M14 7l3 3-3 3'),
  arrayrect: p('M3 3h5v5H3z', 'M12 3h5v5h-5z', 'M3 12h5v5H3z', 'M12 12h5v5h-5z'),
  arraypolar: c(10, 3.5, 1.8) + c(16.5, 10, 1.8) + c(10, 16.5, 1.8) + c(3.5, 10, 1.8) + dot(10, 10),
  arraypath: p('M2 17C8 17 10 4 18 4', 'M3 14h3v3H3z', 'M8.5 8.5h3v3h-3z', 'M14.5 2.5h3v3h-3z'),
  matchprop: p('M11 3l6 6-5 5-6-6z', 'M7.5 9.5L3 14v3h3l4.5-4.5'),
  // blocks and references
  block: p('M3 6l7-3 7 3v8l-7 3-7-3z', 'M3 6l7 3 7-3', 'M10 9v8'),
  insert: p('M10 2v8', 'M7 7l3 3 3-3', 'M3 12.5l7 4 7-4', 'M6.5 10.5L3 12.5'),
  attdef: p('M3 4h7l7 7-6 6-8-8z') + c(7, 8, 1.2),
  eattedit: p('M3 4h6l4 4', 'M3 4v5l5 5') + c(6.5, 7.5, 1.1) + p('M10 17.5l.8-3 6-6 2.2 2.2-6 6z'),
  xattach: p('M13 6.5l-5.5 5.5a1.8 1.8 0 0 0 2.5 2.5l6-6a3.5 3.5 0 0 0-5-5l-6 6a5.2 5.2 0 0 0 7.4 7.4l5-5'),
  // dimensions and leaders
  dimlinear: p('M3 4v12M17 4v12', 'M3 10h14', 'M6 8l-3 2 3 2M14 8l3 2-3 2'),
  dimaligned: p('M2.5 13L13 2.5M7 17.5L17.5 7', 'M5 15l10-10', 'M5 11.5V15h3.5M15 8.5V5h-3.5'),
  dimangular: p('M3 17h14', 'M3 17L12 4', 'M11 17a8 8 0 0 0-3.5-6.6'),
  dimarc: p('M4 15a7 7 0 0 1 12 0', 'M2 12.5a10 10 0 0 1 16 0', 'M4 15l-1.6-2M16 15l1.6-2', 'M7.5 6.5a3 3 0 0 1 5 0'),
  dimradius: c(10, 10, 7) + p('M10 10l4.9-4.9', 'M12.5 5.1l2.4 0 0 2.4') + dot(10, 10),
  dimjogged: c(10, 10, 7) + p('M14.9 5.1L11 9l1.5 1.5L8 15', 'M12.5 5.1h2.4v2.4'),
  dimcenter: c(10, 10, 6) + p('M7.5 10h5M10 7.5v5', 'M14 10h4.5M1.5 10H6M10 1.5V6M10 14v4.5'),
  dimdiameter: c(10, 10, 7) + p('M5.1 14.9l9.8-9.8', 'M12.5 5.1h2.4v2.4M7.5 14.9H5.1v-2.4'),
  dimordinate: p('M4 2.5v15h13.5', 'M4 7h4M4 12.5h7', 'M8 7l2-3M11 12.5l2-3'),
  dimcontinue: p('M2 5v10M10 5v10M18 5v10', 'M2 10h16'),
  dimbaseline: p('M2 3v14M10 9v8M18 3v14', 'M2 13h8M2 6h16'),
  mleader: p('M3 17L9 9h8', 'M3 17l.5-3M3 17l3-.8', 'M11 5h6'),
  dimstyle: p('M3 6h14M3 14h14') + c(7, 6, 2) + c(13, 14, 2),
  // inquiry
  measure: p('M2.5 13.5l11-11 4 4-11 11z', 'M6 10l2 2M8.5 7.5l1.5 1.5M11 5l2 2'),
  area: p('M3 15l4-11 10 4-3 9z', 'M6 13l6-6M9 15l5-5'),
  // markups (dotted outline, like the markup the tool draws)
  mkc: a(cp(12, 12, 8), DOTTED),
  mkr: a('M4.5 6.5h15v11h-15z', DOTTED),
  mkt: p('M7.5 8.5h9M7.5 12h6') + a('M3.5 4.5h17V16H11l-4.5 4v-4h-3z'),
  // layouts, files
  layout: p('M3 5h18v14H3z') + a('M12 19v-4h9'),
  viewport: p('M3 5h18v14H3z') + a('M6.5 8.5h11v7h-11z'),
  compare: p('M8.5 7V3.5h11V17H16', 'M4.5 7H16v13.5H4.5z') + a('M10.25 10.5l3.25 6h-6.5z'),
  xref: p('M4.5 3h8l4 4v4.5', 'M4.5 3v17.5h2', 'M12.5 3v4h4') + a('M13 20.5h-1a3 3 0 0 1 0-6h1M17 14.5h1a3 3 0 0 1 0 6h-1M12 17.5h6'),
  // view
  new: p('M6 3h8l4 4v14H6z', 'M14 3v4h4') + a('M12 10.5v7M8.5 14h7'),
  open: p('M3 19V5h6l2 2.5h8V11', 'M3 19l3.2-8H21.5l-3.2 8z'),
  save: p('M4 4h12.5L20 7.5V20H4z', 'M8 4v5h7V4') + a('M8 20v-6h8v6'),
  undo: p('M4 9.5h10a5.5 5.5 0 0 1 0 11h-4') + a('M8.5 5L4 9.5 8.5 14'),
  redo: p('M20 9.5H10a5.5 5.5 0 0 0 0 11h4') + a('M15.5 5L20 9.5 15.5 14'),
  layers: p('M3 12l9 4.5 9-4.5', 'M3 16l9 4.5 9-4.5') + a('M12 3.5l9 4.5-9 4.5L3 8z'),
  zoomin: c(10.5, 10.5, 6.5) + p('M15.2 15.2l5.3 5.3') + a('M8 10.5h5M10.5 8v5'),
  zoomout: c(10.5, 10.5, 6.5) + p('M15.2 15.2l5.3 5.3') + a('M8 10.5h5'),
  zoomfit: p('M3.5 8.5v-5h5M15.5 3.5h5v5M20.5 15.5v5h-5M8.5 20.5h-5v-5') + a('M8.5 8.5h7v7h-7z'),
};

/** ids still drawn on the old 20x20 grid (redraw in progress): rendered with that viewBox and a matching stroke until redrawn */
export const LEGACY_20 = new Set([
  // --- group A: draw, markup, layouts/files (one id per line; remove an id when its icon is redrawn on the 24 grid)
  // ---
  // --- group B: modify (one id per line; remove an id when its icon is redrawn on the 24 grid)
  // ---
  'move',
  'copy',
  'rotate',
  'align',
  'scale',
  'mirror',
  'offset',
  'trim',
  'extend',
  'explode',
  'erase',
  'fillet',
  'chamfer',
  'break',
  'breakatpoint',
  'pedit',
  'join',
  'lengthen',
  'stretch',
  'arrayrect',
  'arraypolar',
  'arraypath',
  'matchprop',
  // --- group C: block, annotate, inquiry (one id per line; remove an id when its icon is redrawn on the 24 grid)
  // ---
  'block',
  'insert',
  'attdef',
  'eattedit',
  'xattach',
  'dimlinear',
  'dimaligned',
  'dimangular',
  'dimarc',
  'dimradius',
  'dimjogged',
  'dimcenter',
  'dimdiameter',
  'dimordinate',
  'dimcontinue',
  'dimbaseline',
  'mleader',
  'dimstyle',
  'measure',
  'area',
]);
const LEGACY_ATTRS = { viewBox: '0 0 20 20', 'stroke-width': '1.46' };

/** shown for a command without its own icon: a framed question mark */
export const FALLBACK_ICON = p('M5 5h14v14H5z', 'M9.7 9.8a2.3 2.3 0 1 1 3.1 2.1c-.6.3-.8.8-.8 1.4', 'M12 16.2h.01');

/** inner markup for a command id (the fallback when the set has none) */
export function iconMarkup(id) { return Object.hasOwn(ICONS, id) ? ICONS[id] : FALLBACK_ICON; }

/** the shared <svg> attributes: one grid, one stroke for every icon in the app */
const SVG_ATTRS = { class: 'ti', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
  fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** an <svg> element (size px, default 20) for a command id, stroked in currentColor; decorative (the button carries the name) */
export function iconSvg(id, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ ...SVG_ATTRS, ...(LEGACY_20.has(id) ? LEGACY_ATTRS : {}), width: size, height: size })) svg.setAttribute(k, v);
  if (!Object.hasOwn(ICONS, id)) svg.dataset.fallback = '';
  svg.innerHTML = iconMarkup(id);
  return svg;
}

/** the same icon as an HTML string, for markup built as text; w x h px (a non-square box centres the 24x24 grid) */
export function iconHtml(id, w = 20, h = w) {
  const attrs = Object.entries({ ...SVG_ATTRS, ...(LEGACY_20.has(id) ? LEGACY_ATTRS : {}), width: w, height: h }).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<svg ${attrs}>${iconMarkup(id)}</svg>`;
}
