// ASH Draw Studio - named layer states (AutoCAD LAYERSTATE / LAS). Pure ES module.
// doc.layerStates: Map(UPPER-CASE name -> { name, description, mask, currentLayer, layers: Map(name -> entry), extra })
//   entry = { on, frozen, locked, plot, color, linetype, lineweight, transparency, flags?, plotStyle?, extra? }
//   transparency is the alpha byte (255 opaque); lineweight as in the model (mm, or -1/-2/-3).
// Stored in DXF as AutoCAD does: LAYER table extension dictionary -> ACAD_LAYERSTATES dictionary -> one XRECORD per
// state. The same group codes make up the .las file of AutoCAD's Layer States Manager.
// Group codes: header 91 mask, 301 description, 290 flag, 302 current layer; per layer 8 name, 90 flags (1 off, 2 frozen,
// 4 locked, 8 plot), 62 ACI, 92 true colour, 370 lineweight, 6 linetype, 2 plot style, 440 transparency (0 = opaque).
// The per-layer codes 2 (plot style, e.g. "Color_2") and 440 = 0 for an opaque layer follow a .las written by AutoCAD
// (Autodesk forum sample, "Deciphering the Layer State File (.las)"); in a .las code 1 is the state's name. Earlier ASH
// versions wrote the plot style as code 1: read back only when it is the layer's single plot-style code.
// Unknown codes are kept and written back.
// A layout tab's session doc is a space doc (renderer/layouts-ui.js spaceDoc) that forwards only some properties, so
// the states are always read and written on the drawing behind it (rootOf).

/** mask bits, as AutoCAD's LayerStateMasks */
export const LS = { on: 1, frozen: 2, locked: 4, plot: 8, newVp: 16, color: 32, linetype: 64, lineweight: 128, plotStyle: 256, currentVp: 512, transparency: 1024 };
export const LS_ALL = 2047;
/** the properties ASH restores, in UI order */
export const LS_PROPS = ['on', 'frozen', 'locked', 'plot', 'color', 'linetype', 'lineweight', 'transparency'];

const key = (n) => String(n).toUpperCase();
/** the whole drawing behind a session's doc (a layout's space doc forwards to it) */
const rootOf = (doc) => doc.modelDoc ?? doc;
const sameColor = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** a layer's current settings as a state entry */
export const layerEntry = (l) => ({
  on: l.visible !== false, frozen: !!l.frozen, locked: !!l.locked, plot: l.plot !== false,
  color: typeof l.color === 'object' ? { ...l.color } : l.color, linetype: l.linetype, lineweight: l.lineweight, transparency: l.alpha ?? 255,
});

/** snapshot every layer of doc (xref layers excluded); currentLayer: the drawing's current layer (the renderer's app.state.layer) */
export function snapshot(doc, name, description = '', currentLayer) {
  const layers = new Map();
  for (const l of doc.layers.values()) if (!l.xrefDep) layers.set(l.name, layerEntry(l));
  return { name: String(name), description, mask: LS_ALL, currentLayer: currentLayer ?? doc.header?.clayer ?? '0', layers };
}

export const getLayerState = (doc, name) => rootOf(doc).layerStates?.get(key(name)) ?? null;
export const listLayerStates = (doc) => [...(rootOf(doc).layerStates?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name));

/** the entry of layer `name` in state (exact, else case-insensitive) */
function entryFor(st, name) {
  const e = st.layers.get(name);
  if (e) return e;
  const u = key(name);
  for (const [n, x] of st.layers) if (key(n) === u) return x;
  return null;
}

/** the layer properties that restoring entry `e` under `mask` would set (only those that differ from l) */
function changes(doc, l, e, mask) {
  const p = {};
  if (mask & LS.on && (l.visible !== false) !== e.on) p.visible = e.on;
  if (mask & LS.frozen && !!l.frozen !== e.frozen) p.frozen = e.frozen;
  if (mask & LS.locked && !!l.locked !== e.locked) p.locked = e.locked;
  if (mask & LS.plot && (l.plot !== false) !== e.plot) p.plot = e.plot;
  if (mask & LS.color && e.color != null && !sameColor(l.color, e.color)) p.color = typeof e.color === 'object' ? { ...e.color } : e.color;
  if (mask & LS.linetype && e.linetype && key(l.linetype) !== key(e.linetype)) {
    const lt = /^continuous$/i.test(e.linetype) ? 'CONTINUOUS' : [...doc.linetypes.keys()].find((n) => key(n) === key(e.linetype));
    if (lt) p.linetype = lt; // a linetype the drawing does not define is left alone
  }
  if (mask & LS.lineweight && e.lineweight != null && l.lineweight !== e.lineweight) p.lineweight = e.lineweight;
  if (mask & LS.transparency && (l.alpha ?? 255) !== (e.transparency ?? 255)) p.alpha = e.transparency >= 255 ? undefined : e.transparency;
  return p;
}

/** does the drawing's layer set-up match the state (under its mask)? Layers the state does not list are ignored. */
export function stateMatches(doc, st, mask = st.mask) {
  for (const l of doc.layers.values()) {
    if (l.xrefDep) continue;
    const e = entryFor(st, l.name);
    if (e && Object.keys(changes(doc, l, e, mask & st.mask)).length) return false;
  }
  return true;
}

/** save (or overwrite) a state from the current layers: one undo step. An overwrite keeps the description unless given.
 *  opts.currentLayer: the current layer, stored as the state's current layer (code 302). */
export function saveLayerState(s, name, description, { currentLayer } = {}) {
  const doc = rootOf(s.doc), old = getLayerState(doc, name);
  const st = snapshot(doc, old?.name ?? name, description ?? old?.description ?? '', currentLayer);
  s.transact(old ? `Update layer state ${st.name}` : `Save layer state ${st.name}`, (tx) => {
    if (!doc.layerStates) tx.set(doc, 'layerStates', new Map());
    tx.set(doc.layerStates, key(name), st);
  });
  return st;
}

/** the current layer when restoring `name` under `mask` would freeze it (restore leaves it thawed, as AutoCAD does), else null */
export function frozenCurrent(doc, name, { mask = LS_ALL, currentLayer } = {}) {
  const st = getLayerState(doc, name), l = currentLayer != null && rootOf(doc).layers.get(currentLayer);
  if (!st || !l || l.xrefDep || !(mask & st.mask & LS.frozen)) return null;
  const e = entryFor(st, l.name);
  return e?.frozen && !l.frozen ? l.name : null;
}

/** restore a state: one undo step. opts.mask: LS bits to apply (default all the state saved);
 *  opts.offMissing: turn off layers the state does not list; opts.currentLayer: the current layer, never frozen
 *  (see frozenCurrent). Returns the number of layers changed, or -1 when unknown. */
export function restoreLayerState(s, name, { mask = LS_ALL, offMissing = false, currentLayer } = {}) {
  const doc = rootOf(s.doc), st = getLayerState(doc, name);
  if (!st) return -1;
  const m = mask & st.mask;
  return s.transact(`Restore layer state ${st.name}`, (tx) => {
    let n = 0;
    for (const l of [...doc.layers.values()]) {
      if (l.xrefDep) continue;
      const e = entryFor(st, l.name);
      const p = e ? changes(doc, l, e, m) : offMissing && l.visible !== false ? { visible: false } : {};
      if (p.frozen && l.name === currentLayer) delete p.frozen; // AutoCAD cannot freeze the current layer
      if (Object.keys(p).length) { tx.layer(l.name, p); n++; }
    }
    return n;
  });
}

export function deleteLayerState(s, name) {
  const doc = rootOf(s.doc), st = getLayerState(doc, name);
  if (!st) return false;
  s.transact(`Delete layer state ${st.name}`, (tx) => tx.set(doc.layerStates, key(name), undefined));
  return true;
}

/** rename a state; false when it is unknown or the new name is taken by another state */
export function renameLayerState(s, name, to) {
  const doc = rootOf(s.doc), st = getLayerState(doc, name);
  to = String(to).trim();
  if (!st || !to || (key(to) !== key(name) && getLayerState(doc, to))) return false;
  s.transact(`Rename layer state ${st.name}`, (tx) => {
    tx.set(doc.layerStates, key(name), undefined);
    tx.set(doc.layerStates, key(to), { ...st, name: to });
  });
  return true;
}

// ---- group codes (XRECORD body and .las) ------------------------------------------------------
const HEAD = new Set([91, 301, 290, 302]);
const LAYER = new Set([90, 62, 92, 370, 6, 2, 440]);

/** [code, value] pairs of a state (after the XRECORD's 100/280 tags) */
export function layerStateTags(st) {
  const t = [[91, st.mask ?? LS_ALL], [301, st.description ?? ''], [290, st.vpFlag ?? 0], [302, st.currentLayer ?? '0'], ...(st.extra ?? [])];
  for (const [name, e] of st.layers) {
    const rgb = e.color && typeof e.color === 'object';
    const flags = (e.flags ?? 0) & ~15 | (e.on ? 0 : 1) | (e.frozen ? 2 : 0) | (e.locked ? 4 : 0) | (e.plot ? 8 : 0);
    t.push([8, name], [90, flags], [62, rgb ? 7 : Math.abs(e.color ?? 7) % 256 || 7]);
    if (rgb) t.push([92, (e.color.r << 16) | (e.color.g << 8) | e.color.b]);
    t.push([370, e.lineweight >= 0 ? Math.round(e.lineweight * 100) : (e.lineweight ?? -3)], [6, e.linetype ?? 'Continuous'],
      [2, e.plotStyle ?? `Color_${rgb ? 7 : Math.abs(e.color ?? 7) % 256 || 7}`], [440, (e.transparency ?? 255) >= 255 ? 0 : 0x02000000 | e.transparency], ...(e.extra ?? []));
  }
  return t;
}

/** a state from [code, value] pairs (values may be strings, as read from DXF) */
export function layerStateFromTags(name, tags) {
  const st = { name: String(name), description: '', mask: LS_ALL, currentLayer: '0', layers: new Map() };
  let e = null;
  const int = (v) => parseInt(v, 10) || 0;
  const legacy = new Map(); // layer entry -> its code-1 values (plot style as earlier ASH versions wrote it)
  for (const [c, v] of tags) {
    if (c === 8) { e = { on: true, frozen: false, locked: false, plot: true, color: 7, linetype: 'Continuous', lineweight: -3, transparency: 255 }; st.layers.set(String(v), e); continue; }
    if (!e) {
      if (c === 91) st.mask = int(v); else if (c === 301) st.description = String(v); else if (c === 302) st.currentLayer = String(v);
      else if (c === 290) st.vpFlag = int(v); else (st.extra ??= []).push([c, v]);
      continue;
    }
    if (c === 90) { const f = int(v); Object.assign(e, { on: !(f & 1), frozen: !!(f & 2), locked: !!(f & 4), plot: !!(f & 8) }); if (f & ~15) e.flags = f & ~15; }
    else if (c === 62) { if (typeof e.color !== 'object') e.color = Math.abs(int(v)) % 256 || 7; }
    else if (c === 92) { const x = int(v); e.color = { r: (x >> 16) & 255, g: (x >> 8) & 255, b: x & 255 }; }
    else if (c === 370) { const x = int(v); e.lineweight = x >= 0 ? x / 100 : x; }
    else if (c === 6) e.linetype = String(v);
    else if (c === 2) { if (e.plotStyle === undefined || legacy.has(e)) { e.plotStyle = String(v); legacy.delete(e); } else (e.extra ??= []).push([c, v]); }
    else if (c === 1) { if (e.plotStyle === undefined || legacy.has(e)) legacy.set(e, [...(legacy.get(e) ?? []), String(v)]); }
    else if (c === 440) { const x = int(v); e.transparency = x & 0x02000000 ? x & 255 : 255; }
    else (e.extra ??= []).push([c, v]);
  }
  for (const [x, vals] of legacy) if (vals.length === 1) x.plotStyle = vals[0]; // ambiguous (several code 1s) -> dropped
  return st;
}

/** read doc.layerStates from the LAYER table's extension dictionary; get(handle) -> [code, value] pairs of an object */
export function readLayerStates(xdictHandle, get) {
  const entries = (tags) => { const out = []; for (let i = 0; i < tags.length; i++) if (tags[i][0] === 3 && (tags[i + 1]?.[0] === 350 || tags[i + 1]?.[0] === 360)) out.push([tags[i][1], norm(tags[i + 1][1])]); return out; };
  const xd = xdictHandle && get(norm(xdictHandle));
  const dh = xd && entries(xd).find(([k]) => key(k) === 'ACAD_LAYERSTATES')?.[1];
  const dict = dh && get(dh);
  if (!dict) return null;
  const m = new Map();
  for (const [name, h] of entries(dict)) {
    const tags = get(h);
    if (!tags) continue;
    const i = tags.findIndex(([c, v]) => c === 100 && v === 'AcDbXrecord');
    let body = tags.slice(i + 1);
    if (body[0]?.[0] === 280) body = body.slice(1); // duplicate-record cloning flag
    m.set(key(name), layerStateFromTags(name, body));
  }
  return m;
}
const norm = (h) => String(h ?? '').trim().toUpperCase().replace(/^0+(?=.)/, '');

// ---- .las file -------------------------------------------------------------------------------
const pad = (c) => String(c).padStart(3);
/** .las text (UTF-8 with BOM, CRLF, as AutoCAD writes it) of the given states */
export function exportLas(states) {
  const lines = [pad(0), 'LAYERSTATEDICTIONARY'];
  for (const st of states) {
    lines.push(pad(0), 'LAYERSTATE', pad(1), st.name);
    for (const [c, v] of layerStateTags(st)) lines.push(pad(c), String(v));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** states in a .las text */
export function parseLas(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const recs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i], 10), v = lines[i + 1];
    if (!Number.isFinite(c)) throw new Error('This is not a layer states (.las) file.');
    if (c === 0) recs.push({ type: v.trim(), tags: [] }); else recs.at(-1)?.tags.push([c, v]);
  }
  if (recs[0]?.type !== 'LAYERSTATEDICTIONARY') throw new Error('This is not a layer states (.las) file.');
  return recs.filter((r) => r.type === 'LAYERSTATE').map((r) => {
    const i = r.tags.findIndex(([c]) => c === 1);
    const name = i >= 0 ? r.tags[i][1] : 'Imported';
    return layerStateFromTags(name, r.tags.filter((_, j) => j !== i));
  });
}

/** merge imported states in one undo step; overwrite(name) -> boolean decides on a clash. Returns the names added. */
export function importLayerStates(s, states, overwrite = () => false) {
  const doc = rootOf(s.doc), take = states.filter((st) => !getLayerState(doc, st.name) || overwrite(st.name));
  if (!take.length) return [];
  s.transact('Import layer states', (tx) => {
    if (!doc.layerStates) tx.set(doc, 'layerStates', new Map());
    for (const st of take) tx.set(doc.layerStates, key(st.name), st);
  });
  return take.map((st) => st.name);
}
