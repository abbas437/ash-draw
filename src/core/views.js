// ASH Draw Studio - named views (AutoCAD VIEW table). Pure ES module (no DOM).
// A view is { name, center:{x,y} (world), width, height, twist (degrees), space: 'model' | layout name, layerState? },
// kept in doc.views, a Map keyed by the upper-cased name. Plan views only can be restored; a 3D view read from a file
// (view direction other than 0,0,1) is kept as read (view.dxf) and saved back, but `restorable` says false.

/** the whole drawing behind a session's doc (a layout's space doc forwards to it) */
const rootOf = (doc) => doc.modelDoc ?? doc;
/** the drawing's named views (created empty on first use) */
export const viewsOf = (doc) => (rootOf(doc).views ??= new Map());
export const viewKey = (name) => String(name).trim().toUpperCase();
/** a plan view (view direction 0,0,1) can be shown; others are kept for saving only */
export const restorable = (v) => !v.dxf?.dir || (Math.abs(v.dxf.dir.x) < 1e-12 && Math.abs(v.dxf.dir.y) < 1e-12 && v.dxf.dir.z > 0);
/** the views of one space ('model' or a layout name), sorted by name */
export const viewsIn = (doc, space) => [...viewsOf(doc).values()].filter((v) => v.space === space).sort((a, b) => a.name.localeCompare(b.name));
export const findView = (doc, name) => viewsOf(doc).get(viewKey(name)) ?? null;
/** a name AutoCAD accepts: not empty, at most 255 characters, none of <>/\":;?*|,=` */
export const validViewName = (name) => { const s = String(name ?? '').trim(); return s.length > 0 && s.length <= 255 && !/[<>/\\":;?*|,=`]/.test(s); };

/** the view shown by a viewport view { cx, cy, zoom, width, height } (pixels) as a view record */
export const viewFromScreen = (name, v, space = 'model') => ({ name: String(name).trim(), center: { x: v.cx, y: v.cy }, width: v.width / v.zoom, height: v.height / v.zoom, twist: 0, space });
/** the view of a world rectangle {minx, miny, maxx, maxy} */
export const viewFromBox = (name, b, space = 'model') => ({ name: String(name).trim(), center: { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2 }, width: Math.abs(b.maxx - b.minx), height: Math.abs(b.maxy - b.miny), twist: 0, space });
/** the world rectangle a view shows (twist ignored) */
export const viewBox = (v) => ({ minx: v.center.x - v.width / 2, maxx: v.center.x + v.width / 2, miny: v.center.y - v.height / 2, maxy: v.center.y + v.height / 2 });
/** the viewport view { cx, cy, zoom } that shows view `v` whole in a canvas of width x height pixels */
export const screenFromView = (v, width, height) => ({ cx: v.center.x, cy: v.center.y, zoom: Math.min(width / v.width, height / v.height) });

/** save (create or replace) a named view: one undo step. Returns the stored view. */
export function saveView(s, view) {
  if (!validViewName(view.name)) throw new Error(`"${view.name}" is not a valid view name.`);
  if (!(view.width > 0 && view.height > 0)) throw new Error('A view needs a width and a height.');
  const m = viewsOf(s.doc), v = { twist: 0, space: 'model', ...view, name: String(view.name).trim(), center: { ...view.center } };
  s.transact(`Save view ${v.name}`, (tx) => tx.set(m, viewKey(v.name), v, false));
  return v;
}
/** delete a named view: one undo step. Returns false when there is none by that name. */
export function deleteView(s, name) {
  const m = viewsOf(s.doc), k = viewKey(name);
  if (!m.has(k)) return false;
  s.transact(`Delete view ${m.get(k).name}`, (tx) => tx.set(m, k, undefined, false));
  return true;
}
/** rename a named view: one undo step. Throws on an invalid name or a name another view has. */
export function renameView(s, from, to) {
  const m = viewsOf(s.doc), k = viewKey(from), k2 = viewKey(to), v = m.get(k);
  if (!v) throw new Error(`There is no view "${from}".`);
  if (!validViewName(to)) throw new Error(`"${to}" is not a valid view name.`);
  if (k2 !== k && m.has(k2)) throw new Error(`A view named "${String(to).trim()}" already exists.`);
  s.transact(`Rename view ${v.name}`, (tx) => { tx.set(m, k, undefined, false); tx.set(m, k2, { ...v, name: String(to).trim() }, false); });
  return m.get(k2);
}
/** the viewport view to show for named view `name` in a width x height canvas, or null (no such view, or a 3D view).
 *  Restoring changes only the viewport, so it is not an undo step on the drawing (ZOOM Previous goes back). */
export function restoreView(doc, name, width, height) {
  const v = findView(doc, name);
  return v && restorable(v) ? screenFromView(v, width, height) : null;
}

// ---- DXF (VIEW table record, AcDbViewTableRecord) ------------------------------------------------------------------
const XD_APP = 'ASHDRAW'; // XDATA on a paper-space view: 1000 = the layout it belongs to (DXF has no field for it)

/** a view from the group codes of a VIEW table record ([code, value] pairs); layouts: the drawing's layouts */
export function viewFromDxf(tags, layouts = []) {
  const g = new Map();
  let xdLayout = null;
  for (let i = 0; i < tags.length; i++) {
    const [c, v] = tags[i];
    if (c === 1001) { if (v === XD_APP && tags[i + 1]?.[0] === 1000) xdLayout = String(tags[i + 1][1]); break; }
    if (!g.has(c)) g.set(c, v);
  }
  const num = (c, d = 0) => { const x = Number(g.get(c)); return g.has(c) && Number.isFinite(x) ? x : d; };
  const name = String(g.get(2) ?? '').trim();
  if (!name || !(num(40) > 0) || !(num(41) > 0)) return null;
  const flags = num(70) | 0, twist = num(50);
  const dir = { x: num(11), y: num(21), z: num(31, 1) }, target = { x: num(12), y: num(22), z: num(32) };
  const tw = twist * Math.PI / 180, ct = Math.cos(tw), st = Math.sin(tw), dx = num(10), dy = num(20);
  const center = { x: target.x + ct * dx + st * dy, y: target.y - st * dx + ct * dy }; // display coordinates -> world (plan view)
  const space = flags & 1 ? (xdLayout ?? [...layouts].sort((a, b) => a.tab - b.tab)[0]?.name ?? 'Layout1') : 'model';
  return { name, center, width: num(41), height: num(40), twist, space,
    dxf: { flags, dir, target, dcs: { x: dx, y: dy }, lens: num(42, 50), front: num(43), back: num(44), mode: num(71) | 0, render: num(281) | 0 } };
}
/** the group codes of a VIEW table record after the name (code 2), XDATA last; addApp(name) registers an XDATA app */
export function viewToDxf(v, addApp = () => {}) {
  const d = v.dxf ?? {}, dir = d.dir ?? { x: 0, y: 0, z: 1 }, t = d.target ?? { x: 0, y: 0, z: 0 };
  const paper = v.space !== 'model', tw = (v.twist || 0) * Math.PI / 180, ct = Math.cos(tw), st = Math.sin(tw);
  const wx = v.center.x - t.x, wy = v.center.y - t.y;
  const back = { x: t.x + ct * (d.dcs?.x ?? NaN) + st * (d.dcs?.y ?? NaN), y: t.y - st * (d.dcs?.x ?? NaN) + ct * (d.dcs?.y ?? NaN) };
  const dcs = back.x === v.center.x && back.y === v.center.y ? d.dcs : { x: ct * wx - st * wy, y: st * wx + ct * wy }; // as read, unless moved
  const out = [[70, ((d.flags ?? 0) & ~1) | (paper ? 1 : 0)], [40, v.height], [10, dcs.x], [20, dcs.y], [41, v.width],
    [11, dir.x], [21, dir.y], [31, dir.z], [12, t.x], [22, t.y], [32, t.z ?? 0], [42, d.lens ?? 50], [43, d.front ?? 0], [44, d.back ?? 0],
    [50, v.twist || 0], [71, d.mode ?? 0], [281, d.render ?? 0], [72, 0]];
  if (paper) { addApp(XD_APP); out.push([1001, XD_APP], [1000, v.space]); }
  return out;
}
