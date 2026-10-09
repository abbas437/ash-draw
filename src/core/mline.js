// ASH Draw Studio - MLINE (multiline) entity and its MLINESTYLE objects: DXF read/write and display parts.
// Pure ES module. Model:
//   { type:'MLINE', styleH (340 handle), styleName (2), scale (40), just (70), flags (71), start:{x,y},
//     verts:[{ p:{x,y}, dir:{x,y}, miter:{x,y}, params:[[41...] per element], fills:[[42...] per element] }] }
// params[0] of an element is already in drawing units (style offset x scale, justification applied), so the
// element runs through p + miter x params[0]. MLINESTYLE objects are kept as read (tags) in doc.mlineStyles
// (handle -> { name, flags, elements:[{ offset, color, linetype }], tags }) and written back under their handles.

const P = (x, y) => ({ x: +x || 0, y: +y || 0 });

/** MLINESTYLE object tags -> style (raw tags kept for a lossless write) */
export function mlineStyleFromTags(tags) {
  const st = { name: 'Standard', flags: 0, elements: [], tags: tags.filter(([c]) => c !== 5 && c !== 330 && c !== 102) };
  let inEl = false;
  for (const [c, v] of tags) {
    if (c === 2) st.name = v;
    else if (c === 70) st.flags = parseInt(v, 10) || 0;
    else if (c === 71) inEl = true;
    else if (inEl && c === 49) st.elements.push({ offset: parseFloat(v) || 0, color: 256, linetype: 'BYLAYER' });
    else if (inEl && c === 62 && st.elements.length) st.elements[st.elements.length - 1].color = parseInt(v, 10);
    else if (inEl && c === 6 && st.elements.length) st.elements[st.elements.length - 1].linetype = v;
  }
  return st;
}

/** MLINE entity tags -> partial model (null when it has no vertices) */
export function mlineFromTags(tags) {
  const e = { styleH: '', styleName: 'Standard', scale: 1, just: 0, flags: 1, start: P(0, 0), verts: [] };
  let v = null, el = null, want = 0, kind = 0;
  for (const [c, raw] of tags) {
    const f = parseFloat(raw);
    switch (c) {
      case 340: e.styleH = raw; break;
      case 2: e.styleName = raw; break;
      case 40: e.scale = f; break;
      case 70: e.just = f | 0; break;
      case 71: e.flags = f | 0; break;
      case 10: e.start.x = f; break; case 20: e.start.y = f; break;
      case 11: v = { p: P(f, 0), dir: P(1, 0), miter: P(0, 1), params: [], fills: [] }; e.verts.push(v); break;
      case 21: if (v) v.p.y = f; break;
      case 12: if (v) v.dir.x = f; break; case 22: if (v) v.dir.y = f; break;
      case 13: if (v) v.miter.x = f; break; case 23: if (v) v.miter.y = f; break;
      case 74: if (v) { el = []; v.params.push(el); want = f | 0; kind = 41; } break;
      case 75: if (v) { el = []; v.fills.push(el); want = f | 0; kind = 42; } break;
      case 41: case 42: if (el && c === kind && want > 0) { el.push(f); want--; } break;
      default: break;
    }
  }
  return e.verts.length ? e : null;
}

const add = (a, b, k) => ({ x: a.x + b.x * k, y: a.y + b.y * k });

/** element polylines in world coordinates: [{ el, pts, closed }] (one per element, gaps split into pieces) */
export function mlineElementPaths(e) {
  const vs = e.verts || [], n = vs.length, closed = (e.flags & 2) === 2;
  const nEl = Math.max(0, ...vs.map((v) => v.params.length));
  const out = [];
  for (let i = 0; i < nEl; i++) {
    const at = (k) => add(vs[k].p, vs[k].miter, vs[k].params[i]?.[0] ?? 0);
    const segs = closed ? n : n - 1;
    const broken = vs.some((v) => (v.params[i]?.length ?? 0) > 2 || (v.params[i]?.[1] ?? 0) !== 0);
    if (!broken) { out.push({ el: i, pts: vs.map((_, k) => at(k)), closed }); continue; }
    // breaks: per segment, params after the first are distances along the segment direction from the element start
    for (let k = 0; k < segs; k++) {
      const a = at(k), b = at((k + 1) % n), d = vs[k].dir, len = Math.hypot(b.x - a.x, b.y - a.y);
      const q = vs[k].params[i] ?? [];
      const marks = q.length > 1 ? q.slice(1) : [0];
      for (let j = 0; j < marks.length; j += 2) {
        const s0 = marks[j], s1 = j + 1 < marks.length ? marks[j + 1] : len;
        if (s1 > s0) out.push({ el: i, pts: [add(a, d, s0), add(a, d, Math.min(s1, len))], closed: false });
      }
    }
  }
  return out;
}

/** Display parts (BYBLOCK so they take the MLINE's own properties; element colours / linetypes from the style). */
export function mlineParts(e, style = null) {
  const base = { id: 0, layer: '0', color: 0, linetype: 'BYBLOCK', lineweight: -2, ltscale: 1 };
  const own = (i) => {
    const el = style?.elements?.[i];
    const color = el && el.color !== 256 && el.color !== 0 ? el.color : 0;
    const lt = el && el.linetype && !/^by(layer|block)$/i.test(el.linetype) ? el.linetype : 'BYBLOCK';
    return { ...base, color, linetype: lt };
  };
  const out = mlineElementPaths(e).map(({ el, pts, closed }) => ({ ...own(el), type: 'LWPOLYLINE', closed, vertices: pts.map((p) => ({ ...p, bulge: 0 })) }));
  const vs = e.verts || [];
  const fl = style?.flags ?? 0;
  if (!(e.flags & 2) && vs.length > 1 && vs[0].params.length > 1) {
    const ends = (k) => { const ps = vs[k].params.map((q) => q[0] ?? 0); return [add(vs[k].p, vs[k].miter, Math.min(...ps)), add(vs[k].p, vs[k].miter, Math.max(...ps))]; };
    const cap = (k) => { const [a, b] = ends(k); out.push({ ...base, type: 'LINE', p1: a, p2: b }); };
    if ((fl & 16) && !(e.flags & 4)) cap(0);
    if ((fl & 256) && !(e.flags & 8)) cap(vs.length - 1);
  }
  return out;
}

/** move / rotate / scale / mirror: vertices by `apply`, directions and miters by its linear part, params by the scale */
export function transformMline(e, apply) {
  const c = structuredClone(e);
  const o = apply({ x: 0, y: 0 });
  const lin = (d) => { const q = apply(d); return { x: q.x - o.x, y: q.y - o.y }; };
  const s = Math.hypot(lin({ x: 1, y: 0 }).x, lin({ x: 1, y: 0 }).y) || 1;
  const unit = (d) => { const q = lin(d), l = Math.hypot(q.x, q.y) || 1; return { x: q.x / l, y: q.y / l }; };
  c.start = apply(e.start);
  c.scale = (e.scale ?? 1) * s;
  for (const v of c.verts) {
    v.p = apply(v.p); v.dir = unit(v.dir); v.miter = unit(v.miter);
    v.params = v.params.map((q) => q.map((x) => x * s));
    v.fills = v.fills.map((q) => q.map((x) => x * s));
  }
  return c;
}

/** MLINE entity body tags after AcDbEntity; `styleH` the MLINESTYLE handle it names */
export function mlineTags(e, styleH, styleName) {
  const t = [[100, 'AcDbMline'], [2, styleName], [340, styleH], [40, e.scale ?? 1], [70, e.just ?? 0], [71, e.flags ?? 1],
    [72, e.verts.length], [73, Math.max(0, ...e.verts.map((v) => v.params.length))], [10, e.start.x], [20, e.start.y], [30, 0], [210, 0], [220, 0], [230, 1]];
  for (const v of e.verts) {
    t.push([11, v.p.x], [21, v.p.y], [31, 0], [12, v.dir.x], [22, v.dir.y], [32, 0], [13, v.miter.x], [23, v.miter.y], [33, 0]);
    v.params.forEach((q, i) => {
      t.push([74, q.length]); for (const x of q) t.push([41, x]);
      const fq = v.fills[i] ?? []; t.push([75, fq.length]); for (const x of fq) t.push([42, x]);
    });
  }
  return t;
}
