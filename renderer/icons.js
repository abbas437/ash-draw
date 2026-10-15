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
  block: p('M4 7.5v9l8 4 8-4v-9', 'M12 11.5v9') + a('M12 3.5l8 4-8 4-8-4z'),
  insert: p('M12 11l7 3.5v3.5l-7 3.5-7-3.5v-3.5z', 'M5 14.5l7 3.5 7-3.5', 'M12 18v3.5') + a('M12 2.5v7M8.8 6.3l3.2 3.2 3.2-3.2'),
  attdef: p('M3.5 12L7.5 7h13v10h-13z') + a('M11.5 14.5l2.5-5.5 2.5 5.5M12.4 12.6h3.2'),
  eattedit: p('M12 14H7L3 9.5 7 5h10.5v4.5', 'M7.5 9.5h5') + a('M12.5 20.5l.7-2.9 5.8-5.8 2.2 2.2-5.8 5.8z'),
  xattach: p('M5 21V3h8.5L18 7.5V11', 'M13.5 3v4.5H18', 'M5 21h5') + a('M14 20h-1a2.5 2.5 0 0 1 0-5h1M17 15h1a2.5 2.5 0 0 1 0 5h-1M14.5 17.5h2'),
  // dimensions and leaders: extension lines, a dimension line with open arrowheads; the accent is the text tick or the measured shape
  dimlinear: p('M4.5 20.5V5M19.5 20.5V5', 'M4.5 13h15', 'M7.5 10l-3 3 3 3M16.5 10l3 3-3 3') + a('M9.5 8.5h5'),
  dimaligned: p('M10.5 20.5L3 13M20.5 10.5L13 3', 'M5 15L15 5', 'M8 15H5v-3M12 5h3v3') + a('M5.8 9.2l3.4-3.4'),
  dimangular: p('M4 19.5h16.5M4 19.5l8.9-12.05', 'M15 19.5a11 11 0 0 0-4.46-8.84', 'M12.9 17.4l2.1 2.1 2.1-2.1M11 13.6l-.46-2.94 2.97-.44') + a('M16 11.2l1.8 3.6'),
  dimarc: p('M6.27 16.98L2.58 14.4M17.73 16.98l3.69-2.58', 'M3.4 14.97a10.5 10.5 0 0 1 17.2 0', 'M2.88 12.02l.52 2.95 2.95-.52M21.12 12.02l-.52 2.95-2.95-.52', 'M9.5 7.5a3 3 0 0 1 5 0') + a('M7.1 17.56a6 6 0 0 1 9.8 0'),
  dimradius: p('M10 14l8.5-8.5h3', 'M12 9.05h2.95V12') + dot(10, 14) + a(cp(10, 14, 7)),
  dimjogged: p('M15.67 7.83L11.5 12l2 2L8 19.5', 'M12.67 7.83h3v3') + dot(8, 19.5) + a('M10.97 4.55a16.5 16.5 0 0 1 8.53 9.31'),
  dimcenter: p('M10 12h4M12 10v4', 'M2.5 12H7M17 12h4.5M12 2.5V7M12 17v4.5') + a(cp(12, 12, 6.5)),
  dimdiameter: p('M6.34 17.66L17.66 6.34', 'M14.66 6.34h3v3M9.34 17.66h-3v-3') + a(cp(12, 12, 8)),
  dimordinate: p('M3.5 3.5v17h17', 'M9 15.5V6', 'M15.5 15.5V12l2.5-2.5V6') + a(cp(9, 15.5, 0.9) + cp(15.5, 15.5, 0.9), ' fill="currentColor"'),
  dimcontinue: p('M3.5 20.5V5M12 20.5V5M20.5 20.5V5', 'M3.5 12.5h17', 'M6 10l-2.5 2.5L6 15M9.5 10l2.5 2.5L9.5 15M14.5 10L12 12.5l2.5 2.5M18 10l2.5 2.5L18 15', 'M6 7h3.5') + a('M14.5 7H18'),
  dimbaseline: p('M3.5 20.5V3M11 20.5v-7M20.5 20.5V6', 'M3.5 16H11M3.5 8.5h17', 'M6 13.5L3.5 16 6 18.5M8.5 13.5L11 16l-2.5 2.5M6 6L3.5 8.5 6 11M18 6l2.5 2.5L18 11') + a('M10 4.5h4'),
  mleader: p('M4 20l7-10h3', 'M7.44 19.39L4 20l-.61-3.44') + a('M16.5 7H21M16.5 10H21M16.5 13h3'),
  dimstyle: p('M4 3.5v9M20 3.5v9', 'M4 8h16', 'M6.5 5.5L4 8l2.5 2.5M17.5 5.5L20 8l-2.5 2.5', 'M4 17.5h7.8M16.2 17.5H20') + a(cp(14, 17.5, 2.2)),
  // inquiry
  measure: p('M3.24 16.24l13-13 4.52 4.52-13 13z') + a('M5.84 13.64l1.77 1.77M8.44 11.04l1.06 1.06M11.04 8.44l1.77 1.77M13.64 5.84l1.06 1.06'),
  area: p('M3.5 18L6 5l10.5 1.5 4 8.5-8.5 5z') + a('M7.5 14l5.5-5.5M10.5 16.5l6-6'),
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
