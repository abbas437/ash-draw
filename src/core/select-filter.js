// ASH Draw Studio - selection filters: QSELECT (Quick Select) and SELECTSIMILAR. Pure ES module (no DOM).
// Colour compares the STORED value, as AutoCAD does: ByLayer (256) and ByBlock (0) are values of their own, so
// "Color = Red" does not match an object that is ByLayer on a red layer.
import { transparencyText } from './model.js';

/** polyline segments with bulges: length and (closed) area */
function segs(e) {
  const v = e.vertices, n = v.length, out = [];
  for (let i = 0; i < (e.closed ? n : n - 1); i++) out.push([v[i], v[(i + 1) % n], v[i].bulge || 0]);
  return out;
}
function polyLength(e) {
  let L = 0;
  for (const [a, b, bu] of segs(e)) {
    const c = Math.hypot(b.x - a.x, b.y - a.y), t = 4 * Math.atan(Math.abs(bu));
    L += bu ? (c * t) / (2 * Math.sin(t / 2)) : c;
  }
  return L;
}
function polyArea(e) {
  if (!e.closed) return undefined;
  let A = 0;
  for (const [a, b, bu] of segs(e)) {
    A += (a.x * b.y - b.x * a.y) / 2;
    if (bu) { const c = Math.hypot(b.x - a.x, b.y - a.y), t = 4 * Math.atan(bu), r = c / (2 * Math.sin(Math.abs(t) / 2)); A += Math.sign(bu) * (r * r * (Math.abs(t) - Math.sin(Math.abs(t)))) / 2; }
  }
  return Math.abs(A);
}

/** properties offered for every type, then the type-specific ones */
export const COMMON_PROPS = ['Color', 'Layer', 'Linetype', 'Lineweight', 'Transparency'];
const TYPE_PROPS = {
  TEXT: ['Contents', 'Height', 'Style'], MTEXT: ['Contents', 'Height', 'Style'],
  INSERT: ['Name'], CIRCLE: ['Radius', 'Area'], ARC: ['Radius'], LINE: ['Length'],
  LWPOLYLINE: ['Closed', 'Area', 'Length'],
};
export const propsFor = (type) => [...COMMON_PROPS, ...(type && type !== '*' ? TYPE_PROPS[type] ?? [] : [])];
/** operators valid for a property: names and contents also take a wildcard */
export function operatorsFor(prop) {
  if (['Layer', 'Linetype', 'Contents', 'Name', 'Style'].includes(prop)) return ['=', '<>', '*'];
  if (prop === 'Closed') return ['=', '<>'];
  return ['=', '<>', '>', '<'];
}

/** stored value of a property, or undefined when the object does not have it */
export function propValue(e, prop) {
  switch (prop) {
    case 'Color': return e.color ?? 256;
    case 'Layer': return e.layer ?? '0';
    case 'Linetype': return e.linetype ?? 'BYLAYER';
    case 'Lineweight': return e.lineweight ?? -1;
    case 'Transparency': return transparencyText(e.alpha);
    case 'Contents': return e.text;
    case 'Height': return e.height;
    case 'Style': return e.style;
    case 'Name': return e.type === 'INSERT' ? e.block : undefined;
    case 'Radius': return e.r;
    case 'Length':
      if (e.type === 'LINE') return Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
      if (e.type === 'LWPOLYLINE') return polyLength(e);
      return undefined;
    case 'Area':
      if (e.type === 'CIRCLE') return Math.PI * e.r * e.r;
      if (e.type === 'LWPOLYLINE') return polyArea(e);
      return undefined;
    case 'Closed': return e.type === 'LWPOLYLINE' ? (e.closed ? 'Yes' : 'No') : undefined;
    default: return undefined;
  }
}

/** colour text -> stored value: ByLayer 256, ByBlock 0, ACI 1..255 (or a colour name), "r,g,b" true colour */
const COLOR_NAMES = { red: 1, yellow: 2, green: 3, cyan: 4, blue: 5, magenta: 6, white: 7 };
export function parseColor(text) {
  const t = String(text).trim().toLowerCase();
  if (t === 'bylayer') return 256;
  if (t === 'byblock') return 0;
  if (COLOR_NAMES[t]) return COLOR_NAMES[t];
  const rgb = t.match(/^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 256 ? n : null;
}
export function colorText(c) {
  if (c && typeof c === 'object') return `${c.r},${c.g},${c.b}`;
  if (c === 256) return 'ByLayer';
  if (c === 0) return 'ByBlock';
  return Object.keys(COLOR_NAMES).find((k) => COLOR_NAMES[k] === c)?.replace(/^./, (x) => x.toUpperCase()) ?? String(c);
}

/** AutoCAD wildcard: * any run, ? one character, # one digit, @ one letter, ~ at the start negates; case-insensitive */
export function wildcard(pattern, s) {
  let p = String(pattern), neg = false;
  if (p.startsWith('~')) { neg = true; p = p.slice(1); }
  const rx = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/#/g, '\\d').replace(/@/g, '[A-Za-z]')}$`, 'i');
  return rx.test(String(s ?? '')) !== neg;
}

const sameColor = (a, b) => (typeof a === 'object' || typeof b === 'object'
  ? !!a && !!b && typeof a === 'object' && typeof b === 'object' && a.r === b.r && a.g === b.g && a.b === b.b : a === b);
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** does entity e satisfy `prop op value`? (value as typed) */
export function matches(e, prop, op, value) {
  const v = propValue(e, prop);
  if (v === undefined || v === null) return false;
  if (prop === 'Color') {
    const want = parseColor(value);
    if (want === null) return false;
    if (op === '=') return sameColor(v, want);
    if (op === '<>') return !sameColor(v, want);
    if (typeof v === 'object' || typeof want === 'object') return false;
    return op === '>' ? v > want : op === '<' ? v < want : false;
  }
  if (typeof v === 'number' || prop === 'Transparency' || prop === 'Lineweight') {
    const tv = prop === 'Transparency' ? (/^by/i.test(v) ? v : Number(v)) : v;
    const lw = prop === 'Lineweight' ? { bylayer: -1, byblock: -2, default: -3 }[String(value).trim().toLowerCase()] : undefined;
    const w = lw ?? (prop === 'Transparency' && /^by/i.test(String(value).trim()) ? String(value).trim() : Number(value));
    if (typeof tv === 'string' || typeof w === 'string') {
      const eq = String(tv).toLowerCase() === String(w).toLowerCase();
      return op === '=' ? eq : op === '<>' ? !eq : false;
    }
    if (!Number.isFinite(w)) return false;
    return op === '=' ? near(tv, w) : op === '<>' ? !near(tv, w) : op === '>' ? tv > w && !near(tv, w) : op === '<' ? tv < w && !near(tv, w) : false;
  }
  const s = String(v), w = String(value);
  if (op === '*') return wildcard(w, s);
  const eq = s.toLowerCase() === w.toLowerCase();
  return op === '=' ? eq : op === '<>' ? !eq : false;
}

/** QSELECT. entities: the current space's list (model or the active layout's paper space).
 *  q = { applyTo:'all'|'selection', type:'*'|TYPE, prop, op, value, exclude:bool, append:bool }, selection: ids.
 *  Returns the ids of the new selection. */
export function quickSelect(entities, selection, q) {
  const sel = new Set(selection);
  const pool = entities.filter((e) => (q.applyTo === 'selection' ? sel.has(e.id) : true) && (!q.type || q.type === '*' || e.type === q.type));
  const hits = pool.filter((e) => (q.prop ? matches(e, q.prop, q.op ?? '=', q.value) : true) !== !!q.exclude).map((e) => e.id);
  if (!q.append) return hits;
  const out = [...sel];
  for (const id of hits) if (!sel.has(id)) out.push(id);
  return out;
}

/** object types present in the list (QSELECT "Object type") */
export const typesPresent = (entities) => [...new Set(entities.map((e) => e.type))].sort();

/** SELECTSIMILAR: same type and layer; block references also the same name, text the same style */
const similarKey = (e) => [e.type, e.layer, e.type === 'INSERT' ? e.block : '', /TEXT$/.test(e.type) ? String(e.style ?? '').toUpperCase() : ''].join('\u0001');
export function selectSimilar(entities, seedIds) {
  const seeds = new Set(seedIds), keys = new Set(entities.filter((e) => seeds.has(e.id)).map(similarKey));
  return entities.filter((e) => keys.has(similarKey(e))).map((e) => e.id);
}

/** values offered in the Value dropdown for a property */
export function valueChoices(doc, entities, prop) {
  if (prop === 'Layer') return [...doc.layers.keys()];
  if (prop === 'Linetype') return ['ByLayer', 'ByBlock', ...[...doc.linetypes.keys()]];
  if (prop === 'Name') return [...new Set(entities.filter((e) => e.type === 'INSERT').map((e) => e.block))].sort();
  if (prop === 'Color') return ['ByLayer', 'ByBlock', 'Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta', 'White'];
  if (prop === 'Closed') return ['Yes', 'No'];
  if (prop === 'Style') return [...doc.textStyles.keys()];
  return null;
}
