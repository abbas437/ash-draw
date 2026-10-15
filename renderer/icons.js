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
  // layer state glyphs (Layers panel rows, layer combo; drawn at 14 px): the pair members share one outline
  'layer-on': p('M9.5 17c0-2.6-4-4.1-4-8a6.5 6.5 0 0 1 13 0c0 3.9-4 5.4-4 8z', 'M10 20.5h4') + a('M9 9a3 3 0 0 1 3-3'),
  'layer-off': p('M9.5 17c0-2.6-4-4.1-4-8a6.5 6.5 0 0 1 13 0c0 3.9-4 5.4-4 8z', 'M10 20.5h4') + a('M4 3.5l16 17'),
  'layer-freeze': p('M12 3.5v17M19.4 7.8L4.6 16.2M19.4 16.2L4.6 7.8') + a('M14.3 4L12 6.5 9.7 4M6.2 6L7.2 9.3 3.9 10M3.9 14L7.2 14.8 6.2 18M9.7 20L12 17.5 14.3 20M17.8 18L16.8 14.8 20.1 14M20.1 10L16.8 9.3 17.8 6'),
  'layer-thaw': p('M18 12h2.5M16.2 16.2L18 18M12 18v2.5M7.8 16.2L6 18M6 12H3.5M7.8 7.8L6 6M12 6V3.5M16.2 7.8L18 6') + a(cp(12, 12, 3.5)),
  'layer-lock': p('M5.5 11h13v9.5h-13z', 'M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11') + a('M12 14.5v2.5'),
  'layer-unlock': p('M5.5 11h13v9.5h-13z', 'M8.5 11V7.5a3.5 3.5 0 0 1 6.9-.8') + a('M12 14.5v2.5'),
  'layer-plot': p('M7 9V3.5h10V9', 'M7 17H4V9h16v8h-3') + a('M7 13.5h10v7H7z'),
  'layer-noplot': p('M7 9V3.5h10V9', 'M7 17H4V9h16v8h-3', 'M7 13.5h10') + a('M3.5 3.5l17 17'),
  // side panel rail, panel controls (pin, layout menu, flyout arrow), symbol library views
  'rail-symbols': c(7, 7, 3.5) + p('M13.5 3.5h7v7h-7z', 'M7 13.5l3.5 7h-7z') + a('M14 14l6 6M20 14l-6 6'),
  'rail-props': p('M3.5 6h3M11 6h9.5M3.5 12h9.5M17.5 12h3M3.5 18h5M13 18h7.5', 'M6.5 6a2.25 2.25 0 1 0 4.5 0a2.25 2.25 0 1 0-4.5 0M8.5 18a2.25 2.25 0 1 0 4.5 0a2.25 2.25 0 1 0-4.5 0') + a(cp(15.25, 12, 2.25)),
  pin: p('M8.5 3.5h7', 'M9.5 3.5V9L6 13h12l-3.5-4V3.5', 'M12 13v7.5'),
  dots: dot(5, 12) + dot(12, 12) + dot(19, 12),
  chevron: p('M9 5.5l6.5 6.5L9 18.5'),
  'view-grid': p('M4 4h6.5v6.5H4z', 'M13.5 4H20v6.5h-6.5z', 'M4 13.5h6.5V20H4z', 'M13.5 13.5H20V20h-6.5z'),
  'view-list': p('M4 5h4.5v4.5H4z', 'M4 14.5h4.5V19H4z', 'M12 7.25h8M12 16.75h8'),
  'view-float': p('M8 8.5V3.5h12.5V16h-4') + a('M3.5 8.5h13v12h-13z'),
};

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
  for (const [k, v] of Object.entries({ ...SVG_ATTRS, width: size, height: size })) svg.setAttribute(k, v);
  if (!Object.hasOwn(ICONS, id)) svg.dataset.fallback = '';
  svg.innerHTML = iconMarkup(id);
  return svg;
}

/** the same icon as an HTML string, for markup built as text; w x h px (a non-square box centres the 24x24 grid) */
export function iconHtml(id, w = 20, h = w) {
  const attrs = Object.entries({ ...SVG_ATTRS, width: w, height: h }).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<svg ${attrs}>${iconMarkup(id)}</svg>`;
}
