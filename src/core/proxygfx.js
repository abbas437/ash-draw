// ASH Draw Studio - proxy graphics: the saved picture of an object this program cannot read (ACAD_PROXY_ENTITY, and
// custom objects such as Civil 3D AECC_* that carry their graphics in group 310). Pure ES module.
//
//   proxyGraphicsBytes(tags)                 -> Uint8Array | null   (the 92 / 160 size followed by 310 hex chunks)
//   parseProxyGraphics(bytes, opts)          -> [entity]            read-only geometry in plan (XY)
//     opts: { unicode, layers: [names in table order], linetypes: [names in table order], layer, color, linetype }
//
// Stream layout (ODA "Open Design Specification for .dwg files", Proxy Entity Graphics): RL total size, RL record
// count, then records of RL size (bytes, including these 8), RL type, data; little-endian, 4-byte aligned.
// Types read here: 2 circle, 3 circle (3 points), 4 arc, 5 arc (3 points), 6 polyline, 7 polygon, 8 mesh, 9 shell,
// 10 / 11 text, 14 colour, 16 layer, 18 linetype, 22 true colour, 23 lineweight, 24 linetype scale, 29 / 30 push
// transform, 31 pop transform, 32 polyline with normals, 33 lightweight polyline, 36 / 38 Unicode text.
// Anything else (extents, xlines, clips, markers, fills, materials) is skipped by its size.
import { makeCircle, makeArc, makePolyline, makeText } from './model.js';
import { decodeColor } from './aci.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
export const MAX_POINTS = 200000; // points in all the parts of one proxy
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** concatenated binary of the first run of 310 chunks that follows a 92 / 160 size, cut to that size */
export function proxyGraphicsBytes(tags) {
  for (let i = 0; i + 1 < tags.length; i++) {
    const [c, v] = tags[i];
    if ((c !== 92 && c !== 160) || tags[i + 1][0] !== 310) continue;
    const size = Number(String(v).trim());
    let hex = '';
    for (let j = i + 1; j < tags.length && tags[j][0] === 310; j++) hex += String(tags[j][1]).trim();
    const n = Math.min(hex.length >> 1, size > 0 ? size : Infinity);
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
    return n >= 8 ? out : null;
  }
  return null;
}

const mul = (a, b) => { // 4x4 row-major, a * b
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return r;
};
const xf = (m, p) => ({ x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3], y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7], z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11] });
const xv = (m, p) => ({ x: m[0] * p.x + m[1] * p.y + m[2] * p.z, y: m[4] * p.x + m[5] * p.y + m[6] * p.z, z: m[8] * p.x + m[9] * p.y + m[10] * p.z });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const unit = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
/** an axis perpendicular to n (AutoCAD's arbitrary axis rule) */
const perp = (n) => unit(Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64 ? cross({ x: 0, y: 1, z: 0 }, n) : cross({ x: 0, y: 0, z: 1 }, n));

/** bit-coded reader (DWG bitstream) for the lightweight polyline record */
class Bits {
  constructor(u8) { this.u = u8; this.bit = 0; }
  b() { const i = this.bit >> 3; if (i >= this.u.length) throw new Error('end of data'); const v = (this.u[i] >> (7 - (this.bit & 7))) & 1; this.bit++; return v; }
  bb() { return (this.b() << 1) | this.b(); }
  rc() { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | this.b(); return v; }
  bytes(n) { const a = new Uint8Array(n); for (let k = 0; k < n; k++) a[k] = this.rc(); return a; }
  rs() { const a = this.bytes(2); return a[0] | (a[1] << 8); }
  rl() { const a = this.bytes(4); return (a[0] | (a[1] << 8) | (a[2] << 16) | (a[3] << 24)) >>> 0; }
  rd() { return new DataView(this.bytes(8).buffer).getFloat64(0, true); }
  bs() { const k = this.bb(); return k === 0 ? this.rs() : k === 1 ? this.rc() : k === 2 ? 0 : 256; }
  bl() { const k = this.bb(); if (k === 3) throw new Error('bad BL'); return k === 0 ? this.rl() : k === 1 ? this.rc() : 0; }
  bd() { const k = this.bb(); if (k === 3) throw new Error('bad BD'); return k === 0 ? this.rd() : k === 1 ? 1 : 0; }
  dd(def) {
    const k = this.bb();
    if (k === 0) return def;
    if (k === 3) return this.rd();
    const a = new Uint8Array(new Float64Array([def]).buffer);
    if (k === 1) a.set(this.bytes(4), 0);
    else { const x = this.bytes(6); a[4] = x[0]; a[5] = x[1]; a.set(x.subarray(2), 0); }
    return new DataView(a.buffer).getFloat64(0, true);
  }
}

function lwpolylinePoints(u8, version) {
  const r = new Bits(u8);
  const flag = r.bs();
  if (flag & 4) r.bd();
  if (flag & 8) r.bd();
  if (flag & 2) r.bd();
  if (flag & 1) { if (!r.b()) { r.bd(); r.bd(); r.bd(); } }
  const n = r.bl(), nb = flag & 16 ? r.bl() : 0, nid = version >= 'AC1024' && (flag & 1024) ? r.bl() : 0, nw = flag & 32 ? r.bl() : 0;
  if (n > 1e6 || nb > 1e6 || nid > 1e6 || nw > 1e6) throw new Error('bad count');
  const pts = [];
  for (let k = 0; k < n; k++) {
    if (k === 0) pts.push({ x: r.rd(), y: r.rd(), bulge: 0 });
    else { const p = pts[k - 1]; const x = r.dd(p.x); pts.push({ x, y: r.dd(p.y), bulge: 0 }); }
  }
  for (let k = 0; k < nb; k++) { const v = r.bd(); if (pts[k]) pts[k].bulge = v; }
  for (let k = 0; k < nid; k++) r.bl();
  for (let k = 0; k < nw; k++) { r.bd(); r.bd(); }
  return { pts, closed: (flag & 512) !== 0 };
}

/** the proxy graphics stream -> plan geometry (LINE / LWPOLYLINE / CIRCLE / ARC / TEXT entities, not in any document) */
export function parseProxyGraphics(u8, opts = {}) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  const own = { layer: opts.layer ?? '0', color: opts.color ?? 256, linetype: opts.linetype ?? 'BYLAYER' };
  const attr = { ...own, lineweight: -1, ltscale: 1 };
  let m = IDENT;
  const stack = [];
  // a part with a non-finite coordinate, radius or angle is dropped; past MAX_POINTS in all the parts the parse stops (truncated)
  const finiteIn = (v) => (typeof v === 'number' ? Number.isFinite(v) : Array.isArray(v) ? v.every(finiteIn) : v && typeof v === 'object' ? Object.values(v).every(finiteIn) : true);
  let npts = 0, stop = false;
  const add = (part) => {
    if (!finiteIn(part)) return;
    npts += part.vertices?.length ?? 1;
    if (npts > MAX_POINTS) { out.truncated = true; stop = true; return; }
    out.push(part);
  };
  const o = () => ({ layer: attr.layer, color: attr.color, linetype: attr.linetype, lineweight: attr.lineweight, ...(attr.ltscale !== 1 ? { ltscale: attr.ltscale } : {}) });
  const total = Math.min(dv.byteLength, dv.getUint32(0, true) || dv.byteLength);
  for (let at = 8; at + 8 <= total && !stop;) {
    const size = dv.getUint32(at, true), type = dv.getUint32(at + 4, true);
    if (size < 8 || at + size > dv.byteLength) break;
    const d = at + 8, end = at + size;
    at += size;
    let q = d;
    const rl = () => { if (q + 4 > end) throw new Error('short'); const v = dv.getInt32(q, true); q += 4; return v; };
    const rd = () => { if (q + 8 > end) throw new Error('short'); const v = dv.getFloat64(q, true); q += 8; return v; };
    const v3 = () => ({ x: rd(), y: rd(), z: rd() });
    const str = (wide) => {
      let s = '';
      if (wide) { for (; q + 1 < end; q += 2) { const c = dv.getUint16(q, true); if (!c) { q += 2; break; } s += String.fromCharCode(c); } }
      else { const a = q; while (q < end && u8[q]) q++; s = new TextDecoder('windows-1252').decode(u8.subarray(a, q)); q++; }
      q = d + Math.ceil((q - d) / 4) * 4;
      return s;
    };
    const P = (p) => { const w = xf(m, p); return { x: w.x, y: w.y }; };
    const poly = (pts, closed) => { if (pts.length >= 2) add(makePolyline(pts.map(P), closed, o())); };
    // circle / arc around c with normal n, starting along sv for `sweep` radians: native when it stays a plan circle
    const circ = (c, r, n, sv, sweep) => {
      const u = unit(sv ?? perp(n)), v = cross(unit(n), u);
      const U = xv(m, { x: u.x * r, y: u.y * r, z: u.z * r }), V = xv(m, { x: v.x * r, y: v.y * r, z: v.z * r }), C = P(c);
      const ru = Math.hypot(U.x, U.y), tol = 1e-9 * Math.max(ru, 1e-12);
      if (Math.abs(U.z) < tol && Math.abs(V.z) < tol && Math.abs(ru - Math.hypot(V.x, V.y)) < tol * 1e3 && Math.abs(U.x * V.x + U.y * V.y) < tol * ru * 1e3) {
        if (sweep >= TAU - 1e-12) { add(makeCircle(C, ru, o())); return; }
        const a = Math.atan2(U.y, U.x) / DEG, s = sweep / DEG;
        add(U.x * V.y - U.y * V.x > 0 ? makeArc(C, ru, a, a + s, o()) : makeArc(C, ru, a - s, a, o()));
        return;
      }
      const k = Math.max(8, Math.ceil(48 * sweep / TAU)), pts = [];
      for (let i = 0; i <= k; i++) { const t = sweep * i / k; pts.push({ x: c.x + Math.cos(t) * u.x * r + Math.sin(t) * v.x * r, y: c.y + Math.cos(t) * u.y * r + Math.sin(t) * v.y * r, z: c.z + Math.cos(t) * u.z * r + Math.sin(t) * v.z * r }); }
      poly(pts, false);
    };
    // circle through three points (in 3D), as centre / normal / start vector / sweep from the first to the third
    const circ3 = (p1, p2, p3, whole) => {
      const a = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z }, b = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };
      const n = cross(a, b), nn = len(n) ** 2;
      if (nn < 1e-24) { poly([p1, p3], false); return; }
      const t1 = cross(n, a), t2 = cross(b, n), la = len(a) ** 2, lb = len(b) ** 2;
      const c = { x: p1.x + (lb * t1.x + la * t2.x) / (2 * nn), y: p1.y + (lb * t1.y + la * t2.y) / (2 * nn), z: p1.z + (lb * t1.z + la * t2.z) / (2 * nn) };
      const s = { x: p1.x - c.x, y: p1.y - c.y, z: p1.z - c.z }, e = { x: p3.x - c.x, y: p3.y - c.y, z: p3.z - c.z };
      const nu = unit(n), r = len(s);
      let sweep = Math.atan2(cross(s, e).x * nu.x + cross(s, e).y * nu.y + cross(s, e).z * nu.z, s.x * e.x + s.y * e.y + s.z * e.z);
      if (sweep <= 0) sweep += TAU;
      circ(c, r, nu, whole ? null : s, whole ? TAU : sweep);
    };
    const text = (p, n, dir, h, wf, obl, s) => {
      if (!s) return;
      const up = cross(unit(n), unit(dir));
      const D = xv(m, dir), H = xv(m, { x: up.x * h, y: up.y * h, z: up.z * h });
      const height = Math.hypot(H.x, H.y);
      if (!(height > 0)) return;
      add(makeText(P(p), height, s, { ...o(), rot: Math.atan2(D.y, D.x) / DEG, widthFactor: wf || 1, ...(obl ? { oblique: obl / DEG } : {}) }));
    };
    try {
      switch (type) {
        case 2: { const c = v3(), r = rd(), n = v3(); circ(c, r, n, null, TAU); break; }
        case 3: circ3(v3(), v3(), v3(), true); break;
        case 4: { const c = v3(), r = rd(), n = v3(), sv = v3(), sweep = rd(); circ(c, r, n, sv, Math.min(Math.abs(sweep), TAU)); break; }
        case 5: circ3(v3(), v3(), v3(), false); break;
        case 6: case 7: case 32: { const n = rl(); if (n < 0 || q + n * 24 > end) break; const pts = []; for (let k = 0; k < n; k++) pts.push(v3()); poly(pts, type === 7); break; }
        case 8: {
          const rows = rl(), cols = rl();
          if (rows < 1 || cols < 1 || q + rows * cols * 24 > end) break;
          const g = []; for (let k = 0; k < rows * cols; k++) g.push(v3());
          for (let i = 0; i < rows; i++) poly(g.slice(i * cols, i * cols + cols), false);
          if (rows >= 2) for (let j = 0; j < cols; j++) { const col = []; for (let i = 0; i < rows; i++) col.push(g[i * cols + j]); poly(col, false); }
          break;
        }
        case 9: {
          const nv = rl(); if (nv < 0 || q + nv * 24 > end) break;
          const vs = []; for (let k = 0; k < nv; k++) vs.push(v3());
          const nf = rl();
          for (let k = 0; k < nf && q + 4 <= end;) {
            const cnt = Math.abs(rl()); k++;
            const loop = [];
            for (let j = 0; j < cnt && q + 4 <= end; j++, k++) { const ix = rl(); if (vs[ix]) loop.push(vs[ix]); }
            poly(loop, true);
          }
          break;
        }
        case 10: case 36: { const p = v3(), n = v3(), dir = v3(), h = rd(), wf = rd(), obl = rd(); text(p, n, dir, h, wf, obl, str(type === 36 || !!opts.unicode)); break; }
        case 11: case 38: {
          const p = v3(), n = v3(), dir = v3(), s = str(type === 38 || !!opts.unicode);
          rl(); rl();
          const h = rd(), wf = rd(), obl = rd();
          text(p, n, dir, h, wf, obl, s);
          break;
        }
        case 14: { const c = rl(); attr.color = c === 0 ? own.color : c; break; }
        case 16: { const n = opts.layers?.[rl()]; if (n !== undefined) attr.layer = n; break; }
        case 18: { const k = rl(); attr.linetype = k === 32767 ? 'BYLAYER' : k === 32766 ? own.linetype : (opts.linetypes?.[k] ?? attr.linetype); break; }
        case 22: { const c = decodeColor(rl()); if (c !== undefined) attr.color = c === 0 ? own.color : c; break; }
        case 23: { const w = rl(); attr.lineweight = w >= 0 ? w / 100 : w; break; }
        case 24: attr.ltscale = rd(); break;
        case 29: case 30: {
          stack.push(m);
          if (end - d >= 128) { const t = []; for (let k = 0; k < 16; k++) t.push(rd()); m = mul(m, t); }
          break;
        }
        case 31: if (stack.length) m = stack.pop(); break;
        case 33: {
          const n = rl();
          const { pts, closed } = lwpolylinePoints(u8.subarray(q, Math.min(end, q + n)), opts.version ?? '');
          // its points are in the polyline's own plane: the transform still applies
          if (pts.length >= 2) add(makePolyline(pts.map((p) => ({ ...P({ x: p.x, y: p.y, z: 0 }), bulge: m[0] * m[5] - m[1] * m[4] < 0 ? -p.bulge : p.bulge })), closed, o()));
          break;
        }
        default: break;
      }
    } catch { /* a record that runs past its own size is skipped */ }
  }
  return out;
}
