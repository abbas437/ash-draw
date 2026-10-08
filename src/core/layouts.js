// ASH Draw Studio - paper-space layouts and viewports (pure data; no DOM).
//
// doc.layouts = [{ name, tab, block, plot, limMin, limMax, entities }] in tab order.
//   block: '*Paper_Space' for the active layout (its entities live in ENTITIES with 67=1),
//          '*Paper_Space0..n' for the others (entities live in those blocks).
//   plot:  { pageName, printer, paperName, margins:{l,b,r,t}, paperW, paperH, origin:{x,y}, scaleNum, scaleDen,
//            units (0 in, 1 mm, 2 px), rotation (0..3), plotType (74), flags (70) }
//   entities: paper-space entities, including { type:'VIEWPORT', ... } (see readViewport).

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
    },
  };
}

/** VIEWPORT entity record -> { type:'VIEWPORT', c, width, height, vpId, status, viewCenter, viewHeight, twist, frozen, on, locked, clipHandle } */
export function readViewport(rec, layerByHandle) {
  const t = rec.tags();
  const flags = rec.int(90);
  return {
    type: 'VIEWPORT', id: 0, layer: rec.str(8, '0'), color: rec.int(62, 256), linetype: 'BYLAYER', lineweight: -1, ltscale: 1,
    c: { x: rec.num(10), y: rec.num(20) }, width: rec.num(40), height: rec.num(41),
    status: rec.int(68), vpId: rec.int(69),
    viewCenter: { x: rec.num(12), y: rec.num(22) }, target: { x: rec.num(17), y: rec.num(27) }, viewHeight: rec.num(45, 1), twist: rec.num(51),
    frozen: t.filter(([c]) => c === 331).map(([, h]) => layerByHandle.get(h)).filter(Boolean),
    flags, on: rec.int(68) !== 0 && !(flags & VP_OFF), locked: !!(flags & VP_LOCKED),
    clipHandle: flags & VP_CLIP ? rec.str(340, '') || null : null,
  };
}

/** VIEWPORT body tags after AcDbEntity (R2000), frozen layer handles resolved through `layerHandle(name)` */
export function viewportTags(vp, layerHandle) {
  let flags = vp.flags ?? 32768;
  flags = vp.locked ? flags | VP_LOCKED : flags & ~VP_LOCKED;
  flags = vp.on === false ? flags | VP_OFF : flags & ~VP_OFF;
  flags &= ~VP_CLIP; // clip boundary entities are not written back (rectangular clip is kept)
  const out = [[100, 'AcDbViewport'], [10, vp.c.x], [20, vp.c.y], [30, 0], [40, vp.width], [41, vp.height],
    [68, vp.on === false ? 0 : (vp.status || 1)], [69, vp.vpId || 2],
    [12, vp.viewCenter.x], [22, vp.viewCenter.y], [13, 0], [23, 0], [14, 10], [24, 10], [15, 10], [25, 10],
    [16, 0], [26, 0], [36, 1], [17, vp.target?.x ?? 0], [27, vp.target?.y ?? 0], [37, 0],
    [42, 50], [43, 0], [44, 0], [45, vp.viewHeight], [50, 0], [51, vp.twist || 0], [72, 1000]];
  for (const n of vp.frozen ?? []) { const h = layerHandle(n); if (h) out.push([331, h]); }
  out.push([90, flags], [1, ''], [281, 0], [71, 1], [74, 0], [110, 0], [120, 0], [130, 0], [111, 1], [121, 0], [131, 0],
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

/** paper sheet and printable area in layout coordinates (printable lower-left at 0,0, the AutoCAD convention) */
export function paperRects(layout) {
  const p = layout.plot;
  const swap = p.rotation === 1 || p.rotation === 3, u = p.units === 0 ? 25.4 : 1; // paper size and margins are mm; inch layouts draw in inches
  const w = ((swap ? p.paperH : p.paperW) || 420) / u, h = ((swap ? p.paperW : p.paperH) || 297) / u;
  const m = { l: p.margins.l / u, b: p.margins.b / u, r: p.margins.r / u, t: p.margins.t / u };
  const sheet = { minx: -m.l, miny: -m.b, maxx: w - m.l, maxy: h - m.b };
  const printable = { minx: 0, miny: 0, maxx: w - m.l - m.r, maxy: h - m.b - m.t };
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
export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];

/** the topmost (last drawn) usable viewport containing paper point p, or null */
export function viewportAt(entities, p) {
  for (let i = entities.length - 1; i >= 0; i--) {
    const v = entities[i];
    if (v.type !== 'VIEWPORT' || v.vpId === 1 || v.on === false || !(v.width > 0 && v.height > 0)) continue;
    if (Math.abs(p.x - v.c.x) <= v.width / 2 && Math.abs(p.y - v.c.y) <= v.height / 2) return v;
  }
  return null;
}

/** PDF page for plotting a layout at 1:1: page size in points = the paper, k = points per paper unit (mm or inch),
 *  sheet = the paper in layout coordinates (page = (layout - sheet.min) * k) */
export function layoutPage(layout) {
  const { sheet } = paperRects(layout), k = layout.plot.units === 0 ? 72 : 72 / 25.4;
  return { pw: (sheet.maxx - sheet.minx) * k, ph: (sheet.maxy - sheet.miny) * k, k, sheet };
}
