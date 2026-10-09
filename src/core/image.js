// ASH Draw Studio - raster IMAGE entities (with their IMAGEDEF object data kept on the entity).
// An IMAGE places `size` pixels: its insertion point `p` is the lower-left corner, `u` / `v` are the drawing-space
// vectors of one pixel along the image's width and height (they carry rotation, scale and non-uniform scale).
// The IMAGEDEF data (file path, pixel size, resolution units) is copied onto the entity as `def`; the writer makes one
// IMAGEDEF per distinct path again. Clip boundary vertices are in pixel coordinates (as in DXF).

const v2 = (x, y) => ({ x: +x || 0, y: +y || 0 });

/** IMAGEDEF object tags -> { path, size:{x,y} pixels, pixel:{x,y} size of one pixel in AutoCAD units, units } */
export function imageDefFromTags(tags) {
  const d = { path: '', size: v2(0, 0), pixel: v2(1, 1), units: 0, loaded: 1 };
  for (const [c, v] of tags) {
    if (c === 1) d.path = v;
    else if (c === 10) d.size.x = +v; else if (c === 20) d.size.y = +v;
    else if (c === 11) d.pixel.x = +v; else if (c === 21) d.pixel.y = +v;
    else if (c === 281) d.units = parseInt(v, 10) || 0;
    else if (c === 280) d.loaded = parseInt(v, 10) || 0;
  }
  return d;
}

/** IMAGE entity tags (+ the IMAGEDEF it names, or null) -> entity geometry fields */
export function imageFromTags(tags, def) {
  const e = { p: v2(0, 0), u: v2(1, 0), v: v2(0, 1), size: v2(1, 1), flags: 7, clip: { on: false, type: 1, pts: [] }, brightness: 50, contrast: 50, fade: 0 };
  let cur = null;
  for (const [c, val] of tags) {
    switch (c) {
      case 10: e.p.x = +val; break; case 20: e.p.y = +val; break;
      case 11: e.u.x = +val; break; case 21: e.u.y = +val; break;
      case 12: e.v.x = +val; break; case 22: e.v.y = +val; break;
      case 13: e.size.x = +val; break; case 23: e.size.y = +val; break;
      case 14: cur = v2(val, 0); e.clip.pts.push(cur); break;
      case 24: if (cur) cur.y = +val; break;
      case 70: e.flags = parseInt(val, 10) || 0; break;
      case 71: e.clip.type = parseInt(val, 10) || 1; break;
      case 280: e.clip.on = parseInt(val, 10) === 1; break;
      case 281: e.brightness = parseInt(val, 10); break;
      case 282: e.contrast = parseInt(val, 10); break;
      case 283: e.fade = parseInt(val, 10) || 0; break;
      default:
    }
  }
  e.def = def ? structuredClone(def) : null;
  e.path = def?.path ?? '';
  return e;
}

/** IMAGE entity body tags after AcDbEntity (`defH` IMAGEDEF handle) */
export function imageTags(e, defH) {
  const t = [[100, 'AcDbRasterImage'], [90, 0], [10, e.p.x], [20, e.p.y], [30, 0], [11, e.u.x], [21, e.u.y], [31, 0],
    [12, e.v.x], [22, e.v.y], [32, 0], [13, e.size.x], [23, e.size.y], [340, defH], [70, e.flags ?? 7],
    [280, e.clip?.on ? 1 : 0], [281, e.brightness ?? 50], [282, e.contrast ?? 50], [283, e.fade ?? 0]];
  const pts = e.clip?.pts ?? [];
  if (pts.length >= 2) {
    t.push([71, e.clip.type ?? 1], [91, pts.length]);
    for (const q of pts) t.push([14, q.x], [24, q.y]);
  }
  return t;
}

/** IMAGEDEF object body tags after its handle / owner */
export function imageDefTags(d) {
  return [[100, 'AcDbRasterImageDef'], [90, 0], [1, d.path ?? ''], [10, d.size?.x ?? 1], [20, d.size?.y ?? 1],
    [11, d.pixel?.x ?? 1], [21, d.pixel?.y ?? 1], [280, d.loaded ?? 1], [281, d.units ?? 0]];
}

/** the four corners of the image frame in drawing units (lower-left, lower-right, upper-right, upper-left) */
export function imageCorners(e) {
  const W = { x: e.u.x * e.size.x, y: e.u.y * e.size.x }, H = { x: e.v.x * e.size.y, y: e.v.y * e.size.y };
  return [e.p, { x: e.p.x + W.x, y: e.p.y + W.y }, { x: e.p.x + W.x + H.x, y: e.p.y + W.y + H.y }, { x: e.p.x + H.x, y: e.p.y + H.y }];
}

/** apply the affine matrix [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f) to an image (copy) */
export function transformImage(img, m) {
  const c = structuredClone(img);
  const lin = (q) => ({ x: m[0] * q.x + m[2] * q.y, y: m[1] * q.x + m[3] * q.y });
  c.p = { x: m[0] * img.p.x + m[2] * img.p.y + m[4], y: m[1] * img.p.x + m[3] * img.p.y + m[5] };
  c.u = lin(img.u);
  c.v = lin(img.v);
  return c;
}

/** the clip boundary of an image in drawing units (pixel coordinates: origin at the top-left pixel's centre, y down);
 *  a two-point (rectangular) boundary gives its four corners; null when there is none */
export function imageClipWorld(e) {
  const pts = e.clip?.pts ?? [];
  if (pts.length < 2) return null;
  const ring = pts.length === 2 ? [pts[0], { x: pts[1].x, y: pts[0].y }, pts[1], { x: pts[0].x, y: pts[1].y }] : pts;
  return ring.map((q) => {
    const a = q.x + 0.5, b = e.size.y - q.y - 0.5;
    return { x: e.p.x + e.u.x * a + e.v.x * b, y: e.p.y + e.u.y * a + e.v.y * b };
  });
}
