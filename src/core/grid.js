// ASH Draw Studio - drawing grid (AutoCAD GRID / F7): adaptive spacing, the grid points or lines over the visible
// area, and drawing them behind the scene (renderer/viewport.js). Display only: plots and exports never draw it.

/** settings defaults: model space in drawing units, layouts in paper millimetres */
export const GRID_DEFAULTS = { on: false, spacing: 10, major: 5, style: 'lines', paperSpacing: 10, snap: false };
export const GRID_STYLES = ['lines', 'dots'];
/** below this on-screen spacing (CSS px) the grid coarsens */
export const GRID_MIN_PX = 8;
/** never more dots, or lines, than this per frame */
export const GRID_MAX = 10000;

/** a positive finite spacing, a whole major count 1..100 and a known style, or null */
export const cleanSpacing = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
export const cleanMajor = (v) => (Number.isInteger(v) && v >= 1 && v <= 100 ? v : null);
export const cleanStyle = (v) => (GRID_STYLES.includes(v) ? v : null);

const counts = (view, step) => [Math.floor(view.width / (step * view.zoom)) + 2, Math.floor(view.height / (step * view.zoom)) + 2];

/**
 * The spacing drawn at this view: `spacing`, multiplied by the major count (by 10 when there is none) until it is
 * at least GRID_MIN_PX on screen and the frame holds at most `max` dots (style 'dots') or lines. Each coarser grid
 * keeps the major lines of the finer one. Returns { step, major } in world units, or null for an unusable view.
 */
export function gridStep(spacing, major, view, style = 'lines', max = GRID_MAX) {
  if (!(spacing > 0) || !(view.zoom > 0) || !(view.width > 0) || !(view.height > 0)) return null;
  const k = major >= 2 ? major : 10;
  let step = spacing;
  for (let i = 0; i < 64; i++) {
    const [nx, ny] = counts(view, step);
    if (step * view.zoom >= GRID_MIN_PX && (style === 'dots' ? nx * ny : nx + ny) <= max) return { step, major: Math.max(1, major | 0) };
    step *= k;
  }
  return null;
}

/** grid positions along one axis inside [lo, hi]: [{ v, major }] at multiples of step */
export function axisPositions(lo, hi, step, major) {
  const out = [];
  const i0 = Math.ceil(lo / step), i1 = Math.floor(hi / step);
  for (let i = i0; i <= i1; i++) out.push({ v: i * step, major: major > 1 && i % major === 0 });
  return out;
}

/** a point rounded to the nearest grid point of `spacing` (world units; the grid origin is 0,0) */
export const snapToGrid = (p, spacing) => (spacing > 0 ? { x: Math.round(p.x / spacing) * spacing + 0, y: Math.round(p.y / spacing) * spacing + 0 } : { x: p.x, y: p.y });

/** the visible grid of a view: { step, xs, ys } (world positions), or null; dots are every (x, y) pair */
export function gridLayout(view, { spacing, major, style }, max = GRID_MAX) {
  const g = gridStep(spacing, major, view, style, max);
  if (!g) return null;
  const hw = view.width / 2 / view.zoom, hh = view.height / 2 / view.zoom;
  return { step: g.step, xs: axisPositions(view.cx - hw, view.cx + hw, g.step, g.major), ys: axisPositions(view.cy - hh, view.cy + hh, g.step, g.major) };
}

/** low-contrast grid colours per background: minor, major, dot */
export function gridColours(dark) {
  return dark ? { minor: 'rgba(255,255,255,0.055)', major: 'rgba(255,255,255,0.12)', dot: 'rgba(255,255,255,0.22)', majorDot: 'rgba(255,255,255,0.38)' }
    : { minor: 'rgba(0,0,0,0.05)', major: 'rgba(0,0,0,0.11)', dot: 'rgba(0,0,0,0.2)', majorDot: 'rgba(0,0,0,0.34)' };
}

/** draw the grid of `view` (CSS-pixel transform already set on ctx); returns the number of dots or lines drawn */
export function drawGrid(ctx, view, grid, dark) {
  const L = gridLayout(view, grid);
  if (!L) return 0;
  const col = gridColours(dark), W = view.width, H = view.height, z = view.zoom;
  const sx = (x) => Math.round((x - view.cx) * z + W / 2) + 0.5, sy = (y) => Math.round(H / 2 - (y - view.cy) * z) + 0.5;
  ctx.save();
  ctx.lineWidth = 1; ctx.setLineDash?.([]);
  if (grid.style === 'dots') {
    for (const major of [false, true]) {
      ctx.fillStyle = major ? col.majorDot : col.dot; ctx.beginPath();
      for (const a of L.xs) { const x = sx(a.v) - 1.5; for (const b of L.ys) if ((a.major && b.major) === major) ctx.rect(x, sy(b.v) - 1.5, 2, 2); }
      ctx.fill();
    }
    ctx.restore();
    return L.xs.length * L.ys.length;
  }
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? col.major : col.minor; ctx.beginPath();
    for (const a of L.xs) if (a.major === major) { const x = sx(a.v); ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (const b of L.ys) if (b.major === major) { const y = sy(b.v); ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }
  ctx.restore();
  return L.xs.length + L.ys.length;
}
