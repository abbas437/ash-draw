// ASH Draw Studio - paper-space layouts and viewports (pure data; no DOM).
//
// doc.layouts = [{ name, tab, block, plot, limMin, limMax, entities }] in tab order.
//   block: '*Paper_Space' for the active layout (its entities live in ENTITIES with 67=1),
//          '*Paper_Space0..n' for the others (entities live in those blocks).
//   plot:  { pageName, printer, paperName, margins:{l,b,r,t}, paperW, paperH, origin:{x,y}, scaleNum, scaleDen,
//            units (0 in, 1 mm, 2 px), rotation (0..3), plotType (74), flags (70), window, imageOrigin, styleSheet, stdScale }
//   entities: paper-space entities, including { type:'VIEWPORT', ... } (see readViewport).

import { mmPerUnit } from './model.js';
import { tessellate } from './geom.js';
import { insidePoly } from './xclip.js';

const VP_LOCKED = 16384, VP_OFF = 131072, VP_CLIP = 65536;

/** scale denominator N of "1:N" for a viewport (model units per paper unit) */
export const viewportScale = (vp) => (vp.height > 0 ? vp.viewHeight / vp.height : 1);

/** split [code, value] tags into { subclassName: [[code, value]...] } (tags before any 100 go under '') */
function bySubclass(tags) {
  const out = { '': [] };
  let cur = out[''];
  for (const [c, v] of tags) {
    if (c === 100) { cur = out[v] = []; continue; }
    cur.push([c, v]);
  }
  return out;
}
const first = (list, code, d) => { const t = list?.find(([c]) => c === code); return t ? t[1] : d; };
const f = (list, code, d = 0) => { const v = parseFloat(first(list, code)); return Number.isFinite(v) ? v : d; };

/** LAYOUT object (OBJECTS section) -> layout record without entities; `blockHandle` is the owner block record */
export function parseLayoutObject(tags) {
  const s = bySubclass(tags);
  const ps = s.AcDbPlotSettings ?? [], ly = s.AcDbLayout ?? [];
  return {
    name: first(ly, 1, 'Layout'),
    tab: parseInt(first(ly, 71, '1'), 10) || 0,
    blockHandle: first(ly, 330, ''),
    limMin: { x: f(ly, 10), y: f(ly, 20) },
    limMax: { x: f(ly, 11, 420), y: f(ly, 21, 297) },
    plot: {
      pageName: first(ps, 1, ''), printer: first(ps, 2, ''), paperName: first(ps, 4, ''),
      margins: { l: f(ps, 40), b: f(ps, 41), r: f(ps, 42), t: f(ps, 43) },
      paperW: f(ps, 44), paperH: f(ps, 45), origin: { x: f(ps, 46), y: f(ps, 47) },
      scaleNum: f(ps, 142, 1), scaleDen: f(ps, 143, 1),
      units: parseInt(first(ps, 72, '1'), 10) || 0, rotation: parseInt(first(ps, 73, '0'), 10) || 0,
      plotType: parseInt(first(ps, 74, '5'), 10) || 0, flags: parseInt(first(ps, 70, '0'), 10) || 0,
      // kept so a saved layout plots and sits on its paper as before: plot window (48/49 140/141), paper image origin
      // (148/149: where the paper lies in layout units), plot style table, standard scale type
      window: { x1: f(ps, 48), y1: f(ps, 49), x2: f(ps, 140), y2: f(ps, 141) }, imageOrigin: { x: f(ps, 148), y: f(ps, 149) },
      styleSheet: first(ps, 7, ''), stdScale: parseInt(first(ps, 75, '16'), 10) || 0,
    },
    layoutFlags: parseInt(first(ly, 70, '1'), 10) || 0,
  };
}

/** VIEWPORT entity record -> { type:'VIEWPORT', c, width, height, vpId, status, viewCenter, viewHeight, twist, frozen, on, locked, clipHandle } */
export function readViewport(rec, layerByHandle) {
  const t = rec.tags();
  const flags = rec.int(90);
  // DXF: 12/22 view centre is in DCS (origin at the target 17/27, turned by the twist), 51 twist in degrees. The model
  // keeps the centre in WCS and the twist in radians: WCS centre = target + R(-twist) . DCS centre
  const tw = rec.num(51) * Math.PI / 180, tx = rec.num(17), ty = rec.num(27), dx = rec.num(12), dy = rec.num(22);
  const ct = Math.cos(tw), st = Math.sin(tw);
  return {
    type: 'VIEWPORT', id: 0, layer: rec.str(8, '0'), color: rec.int(62, 256), linetype: 'BYLAYER', lineweight: -1, ltscale: 1,
    c: { x: rec.num(10), y: rec.num(20) }, width: rec.num(40), height: rec.num(41),
    status: rec.int(68), vpId: rec.int(69),
    viewCenter: { x: tx + ct * dx + st * dy, y: ty - st * dx + ct * dy }, target: { x: tx, y: ty }, viewHeight: rec.num(45, 1), twist: tw,
    frozen: t.filter(([c]) => c === 331).map(([, h]) => layerByHandle.get(h)).filter(Boolean),
    flags, on: rec.int(68) !== 0 && !(flags & VP_OFF), locked: !!(flags & VP_LOCKED),
    clipHandle: flags & VP_CLIP ? rec.str(340, '') || null : null,
  };
}

/** the layout's overall (paper-space) viewport: the one whose view is the paper itself (view centre = its centre, view
 *  height = its height, no twist). Viewport ID 1 is only a fallback: LibreDWG can number a model viewport 1 and the
 *  paper viewport 2. Sets `paper` true/false on every VIEWPORT of the list. */
export function markPaperViewport(entities) {
  const vps = entities.filter((e) => e.type === 'VIEWPORT');
  const near = (a, b, s) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(s));
  const self = vps.filter((v) => !v.twist && v.height > 0 && near(v.viewHeight, v.height, v.height)
    && near(v.viewCenter.x, v.c.x, v.height) && near(v.viewCenter.y, v.c.y, v.height));
  const paper = self.find((v) => v.vpId === 1) ?? self[0] ?? vps.find((v) => v.vpId === 1) ?? null;
  for (const v of vps) v.paper = v === paper;
  return paper;
}

/** true for a layout's overall paper viewport (see markPaperViewport; viewports never marked fall back to ID 1) */
export const isPaperViewport = (v) => v.paper ?? v.vpId === 1;

/** paper-space entity types a viewport can be clipped to (VPCLIP: a closed polyline, circle, ellipse or spline) */
const CLIP_TYPES = new Set(['LWPOLYLINE', 'CIRCLE', 'ELLIPSE', 'SPLINE']);

/** the clip boundary entity of a polygon-clipped viewport (flag 0x10000, 340 -> the entity; the reader links it as
 *  vp.clipId) among its layout's entities, or null for a rectangular viewport */
export function viewportClipEntity(vp, entities) {
  if (!vp.clipId) return null;
  return entities.find((e) => e.id === vp.clipId && CLIP_TYPES.has(e.type)) ?? null;
}

/** the clip boundary of a polygon-clipped viewport as a paper-space ring [{x,y}...] (curves tessellated), or null */
export function viewportClipRing(vp, entities) {
  const e = viewportClipEntity(vp, entities);
  const ring = e ? tessellate(e)[0] : null;
  return ring && ring.length >= 3 ? ring : null;
}

/** `ids` (a Set or array) widened to the clip partners: a polygon-clipped viewport brings its boundary entity and a
 *  boundary brings the viewports it clips, so the two select, copy, move and erase together (as in AutoCAD). A Set. */
export function withClipPartners(entities, ids) {
  const set = new Set(ids), vps = [];
  for (const e of entities) if (e.type === 'VIEWPORT' && e.clipId) vps.push(e);
  if (!vps.length) return set;
  const pairs = vps.map((v) => [v, viewportClipEntity(v, entities)]).filter(([, b]) => b);
  for (const [v, b] of pairs) if (set.has(v.id)) set.add(b.id);
  for (const [v, b] of pairs) if (set.has(b.id)) set.add(v.id);
  return set;
}

/** After copies are added (ids assigned): `pairs` [[source, copy]...] of ONE copy set (one array item, one COPY). A copied
 *  clipped viewport links to the copy of its boundary; one copied without its boundary is no longer clipped (its link
 *  would name the original's boundary). */
export function relinkClipCopies(pairs) {
  const copyOf = new Map(pairs.map(([s, c]) => [s.id, c]));
  for (const [s, c] of pairs) {
    if (c.type !== 'VIEWPORT' || !s.clipId) continue;
    const b = copyOf.get(s.clipId);
    if (b) c.clipId = b.id; else delete c.clipId;
  }
}

/** Re-fit a clipped viewport's rectangle (in place) to the extents of its boundary entity `b`, keeping what it shows: the
 *  paper -> model mapping (scale, twist, model point under every paper point) stays. Returns vp. */
export function fitViewportToBoundary(vp, b) {
  const ring = tessellate(b)[0];
  if (!ring?.length) return vp;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of ring) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
  const s = viewportScale(vp), c = { x: (minx + maxx) / 2, y: (miny + maxy) / 2 };
  vp.viewCenter = paperToModel(vp, c);
  vp.c = c; vp.width = maxx - minx; vp.height = maxy - miny; vp.viewHeight = s * vp.height;
  return vp;
}

/** a closed polyline through `ring` (paper points) on the viewport's layer and with its properties: the clip boundary a
 *  viewport turned off the axes gets (AutoCAD turns such a viewport into a clipped one) */
export const viewportBoundary = (vp, ring) => ({
  type: 'LWPOLYLINE', id: 0, layer: vp.layer ?? '0', color: vp.color ?? 256, linetype: vp.linetype ?? 'BYLAYER', lineweight: vp.lineweight ?? -1,
  ltscale: 1, closed: true, vertices: ring.map((p) => ({ x: p.x, y: p.y, bulge: 0 })),
});

/** VIEWPORT body tags after AcDbEntity (R2000), frozen layer handles resolved through `layerHandle(name)`; `clipH`
 *  the written handle of its clip boundary entity (polygon-clipped viewport), else null */
export function viewportTags(vp, layerHandle, clipH = null) {
  let flags = vp.flags ?? 32768;
  flags = vp.locked ? flags | VP_LOCKED : flags & ~VP_LOCKED;
  flags = vp.on === false ? flags | VP_OFF : flags & ~VP_OFF;
  flags = clipH ? flags | VP_CLIP : flags & ~VP_CLIP;
  const tw = vp.twist || 0, ct = Math.cos(tw), st = Math.sin(tw), tg = vp.target ?? { x: 0, y: 0 };
  const ox = vp.viewCenter.x - tg.x, oy = vp.viewCenter.y - tg.y; // back to DCS: R(twist) . (centre - target)
  const out = [[100, 'AcDbViewport'], [10, vp.c.x], [20, vp.c.y], [30, 0], [40, vp.width], [41, vp.height],
    [68, vp.on === false ? 0 : (vp.status || 1)], [69, vp.paper ? 1 : vp.vpId > 1 ? vp.vpId : 2],
    [12, ct * ox - st * oy], [22, st * ox + ct * oy], [13, 0], [23, 0], [14, 10], [24, 10], [15, 10], [25, 10],
    [16, 0], [26, 0], [36, 1], [17, tg.x], [27, tg.y], [37, 0],
    [42, 50], [43, 0], [44, 0], [45, vp.viewHeight], [50, 0], [51, tw * 180 / Math.PI], [72, 1000]];
  for (const n of vp.frozen ?? []) { const h = layerHandle(n); if (h) out.push([331, h]); }
  out.push([90, flags]);
  if (clipH) out.push([340, clipH]);
  out.push([1, ''], [281, 0], [71, 1], [74, 0], [110, 0], [120, 0], [130, 0], [111, 1], [121, 0], [131, 0],
    [112, 0], [122, 1], [132, 0], [79, 0], [146, 0]);
  return out;
}

/** a new layout record with an A3 landscape page (mm) */
export function newLayout(name, tab) {
  return {
    name, tab, block: null, limMin: { x: 0, y: 0 }, limMax: { x: 420, y: 297 }, entities: [],
    plot: { pageName: '', printer: '', paperName: 'ISO_A3_(420.00_x_297.00_MM)', margins: { l: 7.5, b: 20, r: 7.5, t: 20 }, paperW: 420, paperH: 297,
      origin: { x: 0, y: 0 }, scaleNum: 1, scaleDen: 1, units: 1, rotation: 0, plotType: 5, flags: 688 },
  };
}

/** paper millimetres per layout unit: inch layouts draw in inches, and a plot scale other than 1:1 (142 paper units =
 *  143 drawing units) scales the sheet as AutoCAD shows it (e.g. inches at 1:25.585 -> about 1 mm per unit) */
export function paperMmPerUnit(plot) {
  const n = plot.scaleNum, d = plot.scaleDen, s = n > 0 && d > 0 && Number.isFinite(n / d) ? n / d : 1;
  return (plot.units === 0 ? 25.4 : 1) * s;
}

/** paper sheet and printable area in layout coordinates. AutoCAD convention: printable lower-left at 0,0; but a plot of
 *  the extents / display / limits / a window (plotType != 5) places the paper around what it plots, and the layout's
 *  limits (LIMMIN/LIMMAX) then record where the sheet is: used when they are the sheet's size. */
export function paperRects(layout) {
  const p = layout.plot;
  const swap = p.rotation === 1 || p.rotation === 3, u = paperMmPerUnit(p); // paper size and margins are mm
  const w = ((swap ? p.paperH : p.paperW) || 420) / u, h = ((swap ? p.paperW : p.paperH) || 297) / u;
  const m = { l: p.margins.l / u, b: p.margins.b / u, r: p.margins.r / u, t: p.margins.t / u };
  const lo = layout.limMin, hi = layout.limMax, near = (a, b) => Math.abs(a - b) <= 0.01 * b;
  const o = p.plotType !== 5 && lo && hi && near(hi.x - lo.x, w) && near(hi.y - lo.y, h) ? { x: lo.x + m.l, y: lo.y + m.b } : { x: 0, y: 0 };
  const sheet = { minx: o.x - m.l, miny: o.y - m.b, maxx: o.x + w - m.l, maxy: o.y + h - m.b };
  const printable = { minx: o.x, miny: o.y, maxx: o.x + w - m.l - m.r, maxy: o.y + h - m.b - m.t };
  return { sheet, printable };
}

/** a rectangular viewport between paper corners a and b, fitted to the model box `fit` ({minx,miny,maxx,maxy}) */
export function makeViewport(a, b, fit, vpId = 2) {
  const width = Math.abs(b.x - a.x), height = Math.abs(b.y - a.y);
  const fw = fit ? fit.maxx - fit.minx : width, fh = fit ? fit.maxy - fit.miny : height;
  const viewHeight = Math.max(fh, (fw * height) / (width || 1), 1e-9) * 1.05;
  return {
    type: 'VIEWPORT', id: 0, layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1,
    c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, width, height, status: 1, vpId,
    viewCenter: fit ? { x: (fit.minx + fit.maxx) / 2, y: (fit.miny + fit.maxy) / 2 } : { x: 0, y: 0 }, target: { x: 0, y: 0 },
    viewHeight, twist: 0, frozen: [], flags: 32768, on: true, locked: false, clipHandle: null,
  };
}

/** paper point -> model point through a viewport (centre c on paper shows viewCenter; twist turns the model CCW) */
export function paperToModel(vp, p) {
  const s = viewportScale(vp), t = vp.twist || 0, dx = (p.x - vp.c.x) * s, dy = (p.y - vp.c.y) * s;
  return { x: vp.viewCenter.x + dx * Math.cos(t) + dy * Math.sin(t), y: vp.viewCenter.y - dx * Math.sin(t) + dy * Math.cos(t) };
}

/** the model-space view {cx, cy, zoom, width, height} that the paper view `pv` shows through the (untwisted) viewport */
export function modelViewThrough(pv, vp) {
  const s = viewportScale(vp), c = paperToModel(vp, { x: pv.cx, y: pv.cy });
  return { ...pv, cx: c.x, cy: c.y, zoom: pv.zoom / s };
}

/** viewport view centre / height that make the paper view `pv` show the model view `mv` (inverse of modelViewThrough) */
export function viewportFromModelView(pv, vp, mv) {
  const s = pv.zoom / mv.zoom;
  return { viewHeight: s * vp.height, viewCenter: { x: mv.cx + (vp.c.x - pv.cx) * s, y: mv.cy + (vp.c.y - pv.cy) * s } };
}

/** standard plot scales "1:N" offered for viewports */
export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** paper millimetres per layout unit as a viewport scale counts them: the layout's paper units alone (25.4 for an inch
 *  layout, else 1). Like AutoCAD, a viewport's 1:N ignores the page setup's plot scale (unlike paperMmPerUnit). */
export const layoutMmPerUnit = (plot) => (plot.units === 0 ? 25.4 : 1);

/** printed scale N of "1:N" of a viewport: model millimetres per layout millimetre. `plot` is its layout's (only its
 *  paper units count, see layoutMmPerUnit), `units` the drawing's $INSUNITS (unitless taken as mm) */
export const viewportPrintScale = (vp, plot, units) => (viewportScale(vp) * mmPerUnit(units)) / layoutMmPerUnit(plot);

/** the viewHeight that makes viewport `vp` print at 1:n (inverse of viewportPrintScale) */
export const viewHeightForScale = (vp, n, plot, units) => (vp.height * n * layoutMmPerUnit(plot)) / mmPerUnit(units);

/** the topmost (last drawn) usable viewport containing paper point p, or null. A polygon-clipped viewport contains only
 *  the points inside both its rectangle and its clip boundary (`entities` must hold the boundary: the layout's list). */
export function viewportAt(entities, p) {
  for (let i = entities.length - 1; i >= 0; i--) {
    const v = entities[i];
    if (v.type !== 'VIEWPORT' || isPaperViewport(v) || v.on === false || !(v.width > 0 && v.height > 0)) continue;
    if (!(Math.abs(p.x - v.c.x) <= v.width / 2 && Math.abs(p.y - v.c.y) <= v.height / 2)) continue;
    const ring = viewportClipRing(v, entities);
    if (!ring || insidePoly(p.x, p.y, ring)) return v;
  }
  return null;
}

/** the page setup's plot window of a layout, normalised {minx,miny,maxx,maxy} in layout units, or null when it has
 *  none (a DXF without one reads as all zeros) */
export function layoutPlotWindow(plot) {
  const w = plot.window;
  if (!w || !(w.x1 !== w.x2 && w.y1 !== w.y2)) return null;
  return { minx: Math.min(w.x1, w.x2), miny: Math.min(w.y1, w.y2), maxx: Math.max(w.x1, w.x2), maxy: Math.max(w.y1, w.y2) };
}

/** what a layout plot covers, in layout units {minx,miny,maxx,maxy}: area 'layout' the sheet, 'extents' the given
 *  paper-space extents (the sheet when there are none), 'window' the page setup's plot window (the sheet when unset) */
export function layoutPlotRegion(layout, area, extents) {
  const { sheet } = paperRects(layout);
  if (area === 'extents') return extents && extents.maxx >= extents.minx && extents.maxy >= extents.miny ? extents : sheet;
  if (area === 'window') return layoutPlotWindow(layout.plot) ?? sheet;
  return sheet;
}

/** PDF page for plotting a layout: page size in points = the paper, k = points per layout unit (paperMmPerUnit),
 *  sheet = the paper in layout coordinates (page = (layout - sheet.min) * k) */
export function layoutPage(layout) {
  const { sheet } = paperRects(layout), k = (72 / 25.4) * paperMmPerUnit(layout.plot);
  return { pw: (sheet.maxx - sheet.minx) * k, ph: (sheet.maxy - sheet.miny) * k, k, sheet };
}
