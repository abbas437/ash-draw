// ASH Draw Studio - original 20x20 line icons for the tool panel and toolbars (inline SVG, drawn in currentColor).
// Every icon is the inner markup of a <svg viewBox="0 0 20 20"> whose stroke (1.5 px, round caps and joins) is set once by
// iconSvg(); a shape that needs its own look (dotted markup outlines, a filled dot) says so on the element.
// The module has no DOM access at import time, so tests can check the set from Node.

const p = (...d) => d.map((x) => `<path d="${x}"/>`).join('');
const c = (cx, cy, r, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}"${extra}/>`;
const dot = (cx, cy) => c(cx, cy, 1.1, ' fill="currentColor" stroke="none"');
const DOTTED = ' stroke-dasharray="2 2.4"';

/** command id -> SVG inner markup (viewBox 0 0 20 20) */
export const ICONS = {
  // select
  select: p('M5 3l10 6.5-4.6 1.1L8.4 15z', 'M10.4 10.6l3.4 5.4'),
  // draw
  line: p('M4.5 15.5l11-11') + dot(4.5, 15.5) + dot(15.5, 4.5),
  pline: p('M3 15l4-8 5 5 5-8'),
  rect: p('M3 5h14v10H3z'),
  circle: c(10, 10, 7) + dot(10, 10),
  arc: p('M3 15a7.5 7.5 0 0 1 14 0') + dot(10, 15),
  ellipse: '<ellipse cx="10" cy="10" rx="8" ry="5"/>',
  point: c(10, 10, 2.5) + p('M10 3v4M10 13v4M3 10h4M13 10h4'),
  text: p('M4 5V4h12v1', 'M10 4v12', 'M7.5 16h5'),
  mtext: p('M3 5V4h8v1', 'M7 4v10', 'M5 14h4', 'M13 8h4M13 11h4M13 14h4'),
  hatch: p('M3 3h14v14H3z', 'M3 9l6-6M3 15L15 3M9 17l8-8'),
  // modify
  move: p('M10 2.5v15M2.5 10h15', 'M7.5 5L10 2.5 12.5 5M7.5 15l2.5 2.5 2.5-2.5M5 7.5L2.5 10 5 12.5M15 7.5l2.5 2.5-2.5 2.5'),
  copy: p('M3 7h9v10H3z', 'M8 7V3h9v10h-5'),
  rotate: p('M16 10a6 6 0 1 1-1.8-4.3', 'M14.5 2.5v3.6h-3.6') + dot(10, 10),
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
  dimradius: c(10, 10, 7) + p('M10 10l4.9-4.9', 'M12.5 5.1l2.4 0 0 2.4') + dot(10, 10),
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
  zoomin: c(8.5, 8.5, 5.5) + p('M12.5 12.5l5 5', 'M6 8.5h5M8.5 6v5'),
  zoomout: c(8.5, 8.5, 5.5) + p('M12.5 12.5l5 5', 'M6 8.5h5'),
  zoomfit: p('M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4', 'M7.5 7.5h5v5h-5z'),
};

/** shown for a command without its own icon: a framed question mark */
export const FALLBACK_ICON = p('M4 4h12v12H4z', 'M8.2 8.2a1.9 1.9 0 1 1 2.6 1.7c-.5.3-.8.7-.8 1.2', 'M10 13.6h.01');

/** inner markup for a command id (the fallback when the set has none) */
export function iconMarkup(id) { return Object.hasOwn(ICONS, id) ? ICONS[id] : FALLBACK_ICON; }

/** a 20x20 <svg> element for a command id, stroked in currentColor; decorative (the button carries the name) */
export function iconSvg(id, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({
    class: 'ti', width: size, height: size, viewBox: '0 0 20 20', 'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  })) svg.setAttribute(k, v);
  if (!Object.hasOwn(ICONS, id)) svg.dataset.fallback = '';
  svg.innerHTML = iconMarkup(id);
  return svg;
}
