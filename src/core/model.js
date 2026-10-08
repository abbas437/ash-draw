// ASH Draw Studio - in-memory drawing model (2D, model space).
// Pure ES module: no Node built-ins, no DOM. Runs in Node and in the renderer.
//
// Conventions
//  - Coordinates are drawing units, Y axis points UP (CAD convention). The renderer flips Y.
//  - Angles: ARC a0/a1 are DEGREES counter-clockwise; ELLIPSE a0/a1 are RADIANS (parameter angles);
//    TEXT/MTEXT/INSERT `rot` are DEGREES CCW.
//  - color: integer ACI index (256 = BYLAYER, 0 = BYBLOCK) or {r,g,b} truecolor.
//  - lineweight: millimetres (>= 0), or -1 BYLAYER, -2 BYBLOCK, -3 DEFAULT.

export const SUPPORTED_TYPES = [
  'LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'TEXT', 'MTEXT',
  'POINT', 'SOLID', 'HATCH', 'INSERT', 'DIMENSION', 'LEADER', 'MLEADER',
];

export const BYLAYER = 256;
export const BYBLOCK = 0;

export function newDocument() {
  const doc = {
    units: 0, // $INSUNITS (0 = unitless, 1 = inch, 4 = mm, 5 = cm, 6 = m ...)
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    entities: [],
    skipped: {}, // { TYPE: count } entities that were read but are not representable
    header: {},  // misc header variables ($ACADVER etc.) and read-time notes
    nextId: 1,
    lastWriteReport: null,
  };
  addLayer(doc, { name: '0' });
  addLinetype(doc, { name: 'CONTINUOUS', description: 'Solid line', pattern: [] });
  addTextStyle(doc, { name: 'STANDARD', font: 'Arial', height: 0, widthFactor: 1 });
  return doc;
}

export function addLayer(doc, props) {
  const name = String(props.name);
  const key = name;
  const layer = {
    name,
    color: props.color ?? 7,
    linetype: props.linetype ?? 'CONTINUOUS',
    lineweight: props.lineweight ?? -3,
    visible: props.visible ?? true,
    frozen: props.frozen ?? false,
    locked: props.locked ?? false,
    plot: props.plot ?? true,
  };
  if (props.xrefDep) layer.xrefDep = props.xrefDep; // layer owned by an external reference: not written, dropped on unload
  doc.layers.set(key, layer);
  return layer;
}

export function getLayer(doc, name) {
  return doc.layers.get(name) ?? doc.layers.get(String(name)) ?? null;
}

/** Returns the layer, creating it (with defaults) if the name is unknown. */
export function ensureLayer(doc, name) {
  return getLayer(doc, name) ?? addLayer(doc, { name });
}

export function addLinetype(doc, props) {
  // pattern: dash lengths in drawing units, positive = dash, negative = gap, 0 = dot
  const lt = { name: String(props.name).toUpperCase(), description: props.description ?? '', pattern: props.pattern ?? [] };
  doc.linetypes.set(lt.name, lt);
  return lt;
}

export function addTextStyle(doc, props) {
  const st = {
    name: String(props.name).toUpperCase(),
    font: props.font ?? 'Arial',
    height: props.height ?? 0,
    widthFactor: props.widthFactor ?? 1,
    oblique: props.oblique ?? 0,
  };
  doc.textStyles.set(st.name, st);
  return st;
}

export function addBlock(doc, name, base = { x: 0, y: 0 }, entities = []) {
  const b = { name, base: { x: base.x, y: base.y }, entities };
  doc.blocks.set(name, b);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Entity factories. Every factory returns a fresh object WITHOUT an id; addEntity assigns one.
function base(type, o) {
  return {
    id: 0,
    type,
    layer: o.layer ?? '0',
    color: o.color ?? BYLAYER,
    linetype: o.linetype ?? 'BYLAYER',
    lineweight: o.lineweight ?? -1,
    ltscale: o.ltscale ?? 1,
  };
}
const pt = (p) => ({ x: p.x, y: p.y });

export const makeLine = (p1, p2, o = {}) => ({ ...base('LINE', o), p1: pt(p1), p2: pt(p2) });
export const makeCircle = (c, r, o = {}) => ({ ...base('CIRCLE', o), c: pt(c), r });
export const makeArc = (c, r, a0, a1, o = {}) => ({ ...base('ARC', o), c: pt(c), r, a0, a1 });
export const makeEllipse = (c, major, ratio, a0 = 0, a1 = Math.PI * 2, o = {}) =>
  ({ ...base('ELLIPSE', o), c: pt(c), major: pt(major), ratio, a0, a1 });
export const makePolyline = (vertices, closed = false, o = {}) =>
  ({ ...base('LWPOLYLINE', o), vertices: vertices.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge ?? 0 })), closed });
export const makeRect = (p1, p2, o = {}) => makePolyline(
  [{ x: p1.x, y: p1.y }, { x: p2.x, y: p1.y }, { x: p2.x, y: p2.y }, { x: p1.x, y: p2.y }], true, o);
export const makePoint = (p, o = {}) => ({ ...base('POINT', o), p: pt(p) });
export const makeText = (p, height, text, o = {}) => ({
  ...base('TEXT', o), p: pt(p), height, text, rot: o.rot ?? 0, widthFactor: o.widthFactor ?? 1,
  style: o.style ?? 'STANDARD', hAlign: o.hAlign ?? 0, vAlign: o.vAlign ?? 0, ...(o.oblique ? { oblique: o.oblique } : {}),
  ...(o.p2 ? { p2: pt(o.p2) } : {}), // Aligned / Fit: second alignment point (DXF 11); p is then DXF 10
});
export const makeMText = (p, height, text, o = {}) => ({
  ...base('MTEXT', o), p: pt(p), height, text, width: o.width ?? 0, rot: o.rot ?? 0,
  attach: o.attach ?? 1, style: o.style ?? 'STANDARD', lineSpacing: o.lineSpacing ?? 1,
});
export const makeSpline = (o = {}) => ({
  ...base('SPLINE', o), degree: o.degree ?? 3, ctrl: (o.ctrl ?? []).map(pt), knots: o.knots ?? [],
  weights: o.weights ?? null, fit: (o.fit ?? []).map(pt), closed: !!o.closed,
});
export const makeSolid = (pts, o = {}) => ({ ...base('SOLID', o), pts: pts.map(pt) });
export const makeInsert = (block, p, o = {}) => ({
  ...base('INSERT', o), block, p: pt(p), sx: o.sx ?? 1, sy: o.sy ?? 1, rot: o.rot ?? 0,
  cols: o.cols ?? 1, rows: o.rows ?? 1, colSp: o.colSp ?? 0, rowSp: o.rowSp ?? 0,
});
// HATCH: loops = [{ pts:[{x,y,bulge}], closed }] (polyline loops) or [{ segs:[{type:'line'|'arc'|'ellipse'|'spline',...}] }]
export const makeHatch = (loops, o = {}) => ({
  ...base('HATCH', o), loops, solid: o.solid ?? true, pattern: o.pattern ?? 'SOLID', angle: o.angle ?? 0, scale: o.scale ?? 1,
});
// DIMENSION is displayed through its anonymous block (block name e.g. '*D1').
export const makeDimension = (block, o = {}) => ({
  ...base('DIMENSION', o), block, dimType: o.dimType ?? 0, p: o.p ? pt(o.p) : null, text: o.text ?? '',
});
export const makeLeader = (pts, o = {}) => ({ ...base('LEADER', o), pts: pts.map(pt), arrow: o.arrow ?? true });

// ---------------------------------------------------------------------------------------------
export function addEntity(doc, e, list = doc.entities) {
  if (!e.id) e.id = doc.nextId++;
  else if (e.id >= doc.nextId) doc.nextId = e.id + 1;
  ensureLayer(doc, e.layer);
  list.push(e);
  return e;
}

export function getEntity(doc, id) {
  return doc.entities.find((e) => e.id === id) ?? null;
}

export function removeEntities(doc, ids) {
  const set = new Set(ids);
  const removed = [];
  doc.entities = doc.entities.filter((e) => {
    if (set.has(e.id)) { removed.push(e); return false; }
    return true;
  });
  return removed;
}

export function cloneEntity(e, doc = null) {
  const c = structuredClone(e);
  c.id = doc ? doc.nextId++ : 0;
  return c;
}

export function countByType(doc) {
  const out = {};
  for (const e of doc.entities) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}
