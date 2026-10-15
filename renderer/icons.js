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
  line: p('M4.5 15.5l11-11') + dot(4.5, 15.5) + dot(15.5, 4.5),
  xline: p('M2 16L18 4') + dot(10, 10),
  ray: p('M5 15L18 5') + dot(5, 15),
  pline: p('M3 15l4-8 5 5 5-8'),
  rect: p('M3 5h14v10H3z'),
  circle: c(10, 10, 7) + dot(10, 10),
  arc: p('M3 15a7.5 7.5 0 0 1 14 0') + dot(10, 15),
  ellipse: '<ellipse cx="10" cy="10" rx="8" ry="5"/>',
  polygon: p('M10 2.5l7.1 5.2-2.7 8.3H5.6L2.9 7.7z') + dot(10, 10),
  spline: p('M3 14c2-8 5-8 7-4s5 4 7-4') + dot(3, 14) + dot(10, 10) + dot(17, 6),
  donut: c(10, 10, 7) + c(10, 10, 3.5),
  divide: p('M2 13c4-6 12-6 16 0') + dot(6, 9.6) + dot(10, 8.5) + dot(14, 9.6),
  point: c(10, 10, 2.5) + p('M10 3v4M10 13v4M3 10h4M13 10h4'),
  text: p('M4 5V4h12v1', 'M10 4v12', 'M7.5 16h5'),
  mtext: p('M3 5V4h8v1', 'M7 4v10', 'M5 14h4', 'M13 8h4M13 11h4M13 14h4'),
  hatch: p('M3 3h14v14H3z', 'M3 9l6-6M3 15L15 3M9 17l8-8'),
  // modify
  move: `<path d="M3.5 14.5h6v6h-6z"${DOTTED}/>` + p('M10.5 13.5l3-3', 'M11 10.5h2.5V13') + a('M14.5 3.5h6v6h-6z'),
  copy: p('M9.5 14.5h-6v-11h11v6') + a('M9.5 9.5h11v11h-11z'),
  rotate: p('M19.5 12A7.5 7.5 0 1 1 17.3 6.7') + a('M17.3 3.5v3.2h-3.2') + dot(12, 12),
  align: p('M3.5 19.5V9.5h8v10') + a('M14 19.5V14h6.5v5.5') + `<path d="M2.5 19.5h19"${DOTTED}/>`,
  scale: p('M3.5 13.5h7v7h-7z', 'M12 12l5-5', 'M13.5 7H17v3.5') + a('M3.5 10.5v-7h17v17h-7'),
  mirror: `<path d="M12 2.5v19"${DOTTED}/>` + p('M9.5 6L3.5 18h6z') + a('M14.5 6l6 12h-6z'),
  offset: p('M10.5 20.5A10 10 0 0 1 20.5 10.5') + a('M4.5 20.5A16 16 0 0 1 20.5 4.5'),
  trim: p('M11 3.5v17', 'M3.5 9H11') + `<path d="M13.3 9h7.2"${DOTTED}/>` + a('M14.5 13l4 4M18.5 13l-4 4'),
  extend: p('M20.5 3.5v17', 'M3.5 12H11') + a('M11 12h7.5M15.5 9l3 3-3 3'),
  explode: p('M8.5 6.1L3.5 15', 'M15.5 6.1l5 8.9', 'M7 21h10') + adot(12, 14),
  erase: p('M15.3 3.2l5 5-7.1 7-4.9-4.9z', 'M12 20.5h8.5') + a('M8.3 10.3l-3.6 3.5 5 5 3.5-3.6'),
  fillet: `<path d="M4.5 12.5v-8h8"${DOTTED}/>` + p('M4.5 20.5v-8', 'M12.5 4.5h8') + a('M4.5 12.5a8 8 0 0 1 8-8'),
  chamfer: `<path d="M4.5 12.5v-8h8"${DOTTED}/>` + p('M4.5 20.5v-8', 'M12.5 4.5h8') + a('M4.5 12.5l8-8'),
  break: p('M3 12h7', 'M14 12h7') + a('M9 15l2-6M13 15l2-6'),
  breakatpoint: p('M3 12h7', 'M14 12h7') + a(cp(12, 12, 2)),
  pedit: p('M3.5 18l5-10 3.9 4.5', 'M16.2 12.5l4.3-6.5') + a('M12 12.5h5v5h-5z'),
  join: p('M3 12h7', 'M14 12h7') + a('M7.5 9.5L10 12l-2.5 2.5M16.5 9.5L14 12l2.5 2.5'),
  lengthen: p('M3.5 16H13', 'M3.5 6.5v6', 'M3.5 9.5H20', 'M17.5 7L20 9.5 17.5 12') + a('M13 16h7.5'),
  stretch: `<path d="M3.5 10.5h10v10"${DOTTED}/>` + p('M3.5 10.5v10h10') + a('M3.5 10.5L20 4l-6.5 16.5'),
  arrayrect: p('M14 3.5h6.5V10H14z', 'M3.5 14H10v6.5H3.5z', 'M14 14h6.5v6.5H14z') + a('M3.5 3.5H10V10H3.5z'),
  arraypolar: c(18.7, 9.8, 2) + c(16.1, 17.7, 2) + c(7.9, 17.7, 2) + c(5.3, 9.8, 2) + a(cp(12, 5, 2)) + dot(12, 12),
  arraypath: p('M2.5 20C11 21 13 3 21.5 4', 'M10 10h4v4h-4z', 'M14.75 3.75h4v4h-4z') + a('M5.25 16.25h4v4h-4z'),
  matchprop: p('M20.5 3.5l-6 6', 'M12.7 7.7l3.6 3.6-2.5 2.5-3.6-3.6z') + a('M10.2 10.2l-6.1 5.2a3.2 3.2 0 0 0 4.5 4.5l5.2-6.1'),
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
  mkc: c(10, 10, 7, DOTTED) + p('M10 10h.01'),
  mkr: `<path d="M3 4h14v12H3z"${DOTTED}/>` + p('M10 10h.01'),
  mkt: p('M3 4h14v9H9l-4 3.5V13H3z', 'M6 7.5h8M6 10h5'),
  // layouts, files
  layout: p('M4 2h9l3 3v13H4z', 'M13 2v3h3', 'M7 9h6v5H7z'),
  viewport: p('M2 4h16v12H2z', 'M5 7h6v6H5z'),
  compare: p('M3 3h6v14H3z', 'M11 3h6v14h-6z', 'M5 7h2M13 9h2M5 11h2M13 13h2'),
  xref: p('M13 6.5l-5.5 5.5a1.8 1.8 0 0 0 2.5 2.5l6-6a3.5 3.5 0 0 0-5-5l-6 6a5.2 5.2 0 0 0 7.4 7.4l5-5'),
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
  'line',
  'xline',
  'ray',
  'pline',
  'rect',
  'circle',
  'arc',
  'ellipse',
  'polygon',
  'spline',
  'donut',
  'divide',
  'point',
  'text',
  'mtext',
  'hatch',
  'mkc',
  'mkr',
  'mkt',
  'layout',
  'viewport',
  'compare',
  'xref',
  // --- group B: modify (one id per line; remove an id when its icon is redrawn on the 24 grid)
  // ---
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
