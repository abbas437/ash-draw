// ASH Draw Studio - reuse rule for the viewport's cached scene bitmap (renderer/viewport.js).
// Pure: decides how the next frame is produced from the last full frame, its content key and the active gesture.

/** what the scene picture depends on besides the view; any difference forces a full render */
export function frameKey({ scene, dark, lineweights, transparency, selection, dpr, pxWidth, pxHeight }) {
  return { scene, version: scene?.version, dark: !!dark, lineweights: !!lineweights, transparency: transparency !== false, selection, selSize: selection?.size ?? 0, dpr, pxWidth, pxHeight };
}

export function sameKey(a, b) {
  if (!a || !b) return false;
  for (const k in a) if (a[k] !== b[k]) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
}

/**
 * How to produce the frame for `view` from the cached `frame` ({ key, view, exact }).
 *   full  - render the scene (no frame, content changed, no gesture and the view moved, or the cache is a gesture
 *           approximation and the gesture is over)
 *   blit  - the cached bitmap is the frame (same view)
 *   shift - same zoom during a gesture: move the bitmap by (dx, dy) device pixels and render the exposed strips;
 *           `view` is the frame's view moved by exactly that (within half a device pixel of the requested view)
 *   scale - zoom changed during a gesture: draw the bitmap scaled by s with its top-left at (ox, oy) CSS pixels
 * @param {string|null} gesture 'pan' | 'zoom' | null
 */
export function framePlan(frame, key, view, gesture) {
  if (!frame || !sameKey(frame.key, key)) return { mode: 'full' };
  const f = frame.view;
  if (view.width !== f.width || view.height !== f.height) return { mode: 'full' };
  if (view.zoom === f.zoom && view.cx === f.cx && view.cy === f.cy) return frame.exact || gesture ? { mode: 'blit' } : { mode: 'full' };
  if (!gesture) return { mode: 'full' };
  const z = view.zoom, dpr = key.dpr || 1;
  if (z === f.zoom) {
    const dx = Math.round((f.cx - view.cx) * z * dpr), dy = Math.round((view.cy - f.cy) * z * dpr);
    if (Math.abs(dx) >= key.pxWidth || Math.abs(dy) >= key.pxHeight) return { mode: 'full' };
    if (!dx && !dy) return { mode: 'blit' };
    return { mode: 'shift', dx, dy, view: { ...f, cx: f.cx - dx / dpr / z, cy: f.cy + dy / dpr / z } };
  }
  const s = z / f.zoom, W = view.width, H = view.height;
  return { mode: 'scale', s, ox: W / 2 - (W / 2) * s + (f.cx - view.cx) * z, oy: H / 2 - (H / 2) * s - (f.cy - view.cy) * z };
}

/** device-pixel rectangles [x, y, w, h] left uncovered after shifting a pxWidth x pxHeight bitmap by (dx, dy); disjoint */
export function exposedStrips(dx, dy, pxWidth, pxHeight) {
  const out = [];
  if (dx > 0) out.push([0, 0, dx, pxHeight]); else if (dx < 0) out.push([pxWidth + dx, 0, -dx, pxHeight]);
  const x0 = dx > 0 ? dx : 0, w = pxWidth - Math.abs(dx);
  if (w > 0) { if (dy > 0) out.push([x0, 0, w, dy]); else if (dy < 0) out.push([x0, pxHeight + dy, w, -dy]); }
  return out;
}
