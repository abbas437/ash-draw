// ASH Draw Studio - a compact form of a batch of entities for the DXF worker -> window hand-off (docBatches.js).
// A structured clone writes every key and string of every entity again; here each distinct object shape (its keys in
// order, and how each value is carried) is sent once per batch, strings once per batch in a table, and the numbers of
// all entities in one Float64Array, which is transferred (no copy). decodeEnts rebuilds the same objects, keys in the
// same order, -0 and NaN kept. Values of any other kind (Maps, typed arrays, arrays of mixed things) go in `rest` and
// are cloned as before. Like a structured clone of the whole batch, the result shares no objects with the input; it
// does not keep an object referenced twice inside one entity shared (the reader never builds one: docBatches.js).
import { makeLine } from './model.js';

// how a value is carried: N a number, S a string (index into the string table), D the property's default (DEFAULTS),
// T/F/Z/U true/false/null/undefined, V as is (in rest), O a plain object (sub-shape), R an array of plain objects of
// one shape with only numbers (count, then the numbers row by row), A an array of numbers (count, then the numbers)
const N = 0, S = 1, D = 2, T = 3, F = 4, Z = 5, U = 6, V = 7, O = 8, R = 9, A = 10;

/** the defaults of an entity's common properties: what model.js gives an entity made without them */
const DEFAULTS = (() => { const { layer, color, linetype, lineweight, ltscale } = makeLine({ x: 0, y: 0 }, { x: 0, y: 0 }); return { layer, color, linetype, lineweight, ltscale }; })();
const hasDefault = (k) => k === 'layer' || k === 'color' || k === 'linetype' || k === 'lineweight' || k === 'ltscale';

const isPlain = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

/** ents (plain objects) -> { packet, transfer }: post packet with the transfer list */
export function encodeEnts(ents) {
  const shapes = [], strs = [], strIds = new Map(), rest = [];
  let nums = new Float64Array(Math.max(64, ents.length * 12)), n = 0;
  const put = (x) => { if (n === nums.length) { const b = new Float64Array(nums.length * 2); b.set(nums); nums = b; } nums[n++] = x; };
  const str = (s) => { let i = strIds.get(s); if (i === undefined) { i = strs.length; strs.push(s); strIds.set(s, i); } return i; };
  // the shapes met so far as a trie: a node per (key, code, sub-shape) path from the root; a shape is given its id
  // (and written to the table) the first time an object ends on its node
  const root = { next: new Map(), parent: null, k: '', c: 0, s: 0, id: -1 };
  const step = (node, k, c, s) => {
    let kids = node.next.get(k);
    if (kids === undefined) node.next.set(k, (kids = []));
    for (let i = 0; i < kids.length; i++) { const x = kids[i]; if (x.c === c && x.s === s) return x; }
    const x = { next: new Map(), parent: node, k, c, s, id: -1 };
    kids.push(x);
    return x;
  };
  const idOf = (node) => {
    if (node.id < 0) {
      const keys = [], codes = [], subs = [];
      for (let x = node; x !== root; x = x.parent) { keys.push(x.k); codes.push(x.c); subs.push(x.s); }
      node.id = shapes.length;
      shapes.push([keys.reverse(), codes.reverse(), subs.reverse()]);
    }
    return node.id;
  };
  const shapeOf = (keys, codes, subs) => { let x = root; for (let i = 0; i < keys.length; i++) x = step(x, keys[i], codes[i], subs[i]); return idOf(x); };
  let xy = -1; // the shape {x: number, y: number}, registered on first use
  const xyShape = () => (xy >= 0 ? xy : (xy = shapeOf(['x', 'y'], [N, N], [-1, -1])));
  const isXY = (v, keys) => keys.length === 2 && keys[0] === 'x' && keys[1] === 'y' && typeof v.x === 'number' && typeof v.y === 'number';

  // an array: writes it (A, R: its count, then its numbers) and returns [code, sub-shape]; [V, -1] writes nothing
  function arrayCode(a) {
    const len = a.length, at = n;
    if (Object.keys(a).length !== len) return [V, -1]; // holes or extra properties
    if (len === 0) { put(0); return [A, -1]; }
    const first = a[0];
    put(len);
    if (typeof first === 'number') {
      for (let i = 0; i < len; i++) { const x = a[i]; if (typeof x !== 'number') { n = at; return [V, -1]; } put(x); }
      return [A, -1];
    }
    if (first === null || typeof first !== 'object' || Array.isArray(first) || !isPlain(first)) { n = at; return [V, -1]; }
    const keys = Object.keys(first), kn = keys.length;
    for (let i = 0; i < len; i++) {
      const el = a[i];
      if (el === null || typeof el !== 'object' || Array.isArray(el) || !isPlain(el)) { n = at; return [V, -1]; }
      let j = 0;
      for (const k in el) { const x = el[k]; if (j >= kn || k !== keys[j] || typeof x !== 'number') { n = at; return [V, -1]; } put(x); j++; }
      if (j !== kn) { n = at; return [V, -1]; }
    }
    return [R, kn === 2 && keys[0] === 'x' && keys[1] === 'y' ? xyShape() : shapeOf(keys, keys.map(() => N), keys.map(() => -1))];
  }

  // writes object o's values; returns its shape (or -1: o goes in rest as is)
  function obj(o, top) {
    const keys = Object.keys(o);
    if (!top && isXY(o, keys)) { put(o.x); put(o.y); return xyShape(); }
    let node = root;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], v = o[k];
      let c, s = -1;
      if (top && hasDefault(k) && Object.is(v, DEFAULTS[k])) c = D;
      else if (typeof v === 'number') { c = N; put(v); }
      else if (typeof v === 'string') { c = S; put(str(v)); }
      else if (v === true) c = T;
      else if (v === false) c = F;
      else if (v === null) c = Z;
      else if (v === undefined) c = U;
      else if (Array.isArray(v)) {
        [c, s] = arrayCode(v);
        if (c === V) rest.push(v);
      } else if (typeof v === 'object' && isPlain(v)) { s = obj(v, false); c = O; }
      else { c = V; rest.push(v); }
      node = step(node, k, c, s);
    }
    return idOf(node);
  }

  for (const e of ents) {
    if (e === null || typeof e !== 'object' || Array.isArray(e) || !isPlain(e)) { put(-1); rest.push(e); continue; }
    const at = n; put(0);
    const shape = obj(e, true); // (obj may grow nums: read it after)
    nums[at] = shape;
  }
  const out = nums.slice(0, n);
  return { packet: { count: ents.length, shapes, strs, nums: out, rest }, transfer: [out.buffer] };
}

/** the entities of an encodeEnts packet (after the clone), each the same as the one encoded */
export function decodeEnts({ count, shapes, strs, nums, rest }) {
  let p = 0, r = 0;
  const allN = (codes) => codes.every((c) => c === N);
  const progs = shapes.map(([keys, codes, subs]) => ({ keys, codes, subs,
    xy: keys.length === 2 && keys[0] === 'x' && keys[1] === 'y' && allN(codes),
    xyb: keys.length === 3 && keys[0] === 'x' && keys[1] === 'y' && keys[2] === 'bulge' && allN(codes) }));
  function obj(prog) {
    if (prog.xy) { const o = { x: nums[p], y: nums[p + 1] }; p += 2; return o; }
    const { keys, codes, subs } = prog, o = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      switch (codes[i]) {
        case N: o[k] = nums[p++]; break;
        case S: o[k] = strs[nums[p++]]; break;
        case D: o[k] = DEFAULTS[k]; break;
        case T: o[k] = true; break;
        case F: o[k] = false; break;
        case Z: o[k] = null; break;
        case U: o[k] = undefined; break;
        case V: o[k] = rest[r++]; break;
        case O: o[k] = obj(progs[subs[i]]); break;
        case A: { const len = nums[p++], a = new Array(len); for (let j = 0; j < len; j++) a[j] = nums[p++]; o[k] = a; break; }
        case R: { const len = nums[p++], a = new Array(len), sp = progs[subs[i]]; for (let j = 0; j < len; j++) a[j] = row(sp); o[k] = a; break; }
        default: throw new Error(`entity transfer: unknown code ${codes[i]}`);
      }
    }
    return o;
  }
  function row(sp) {
    if (sp.xy) { const o = { x: nums[p], y: nums[p + 1] }; p += 2; return o; }
    if (sp.xyb) { const o = { x: nums[p], y: nums[p + 1], bulge: nums[p + 2] }; p += 3; return o; }
    const o = {};
    for (const k of sp.keys) o[k] = nums[p++];
    return o;
  }
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const s = nums[p++];
    out[i] = s < 0 ? rest[r++] : obj(progs[s]);
  }
  return out;
}
