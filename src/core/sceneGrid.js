// ASH Draw Studio - uniform-grid spatial index over scene items (world bboxes), used by drawScene to visit only
// the items whose cells intersect the view. Boxes outside the grid extent are clamped to the edge cells, which keeps
// box/box overlap monotone, so a query never misses an item (callers still test the exact bbox).
const MAX_CELLS_AXIS = 512;
const OVERSIZE_CELLS = 1024; // an item spanning more cells than this goes to the oversize set

export class SceneGrid {
  /** ext: world box to lay the grid over; n: expected item count (sets the cell size) */
  constructor(ext, n) {
    if (!ext) ext = { minx: 0, miny: 0, maxx: 1, maxy: 1 };
    const w = ext.maxx - ext.minx, h = ext.maxy - ext.miny, big = Math.max(w, h, 1e-9);
    let cell = Math.sqrt(Math.max(w * h, 0) / Math.max(n, 1)) * 2;
    cell = Math.max(cell, big / MAX_CELLS_AXIS, big * 1e-12);
    this.ox = ext.minx; this.oy = ext.miny; this.cell = cell;
    this.cols = Math.min(MAX_CELLS_AXIS, Math.floor(w / cell) + 1);
    this.rows = Math.min(MAX_CELLS_AXIS, Math.floor(h / cell) + 1);
    this.cells = new Array(this.cols * this.rows);
    this.oversize = new Set(); // huge items and items without a bbox
    this.size = 0;
    this._stamp = 0;
  }

  _range(b) {
    const k = this.cell, cl = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    return [cl(Math.floor((b.minx - this.ox) / k), this.cols), cl(Math.floor((b.miny - this.oy) / k), this.rows),
      cl(Math.floor((b.maxx - this.ox) / k), this.cols), cl(Math.floor((b.maxy - this.oy) / k), this.rows)];
  }

  insert(it) {
    this.size++;
    const b = it.bbox;
    const r = b && Number.isFinite(b.minx) && Number.isFinite(b.maxx) && Number.isFinite(b.miny) && Number.isFinite(b.maxy) ? this._range(b) : null;
    if (!r || (r[2] - r[0] + 1) * (r[3] - r[1] + 1) > OVERSIZE_CELLS) { it._cells = null; this.oversize.add(it); return; }
    it._cells = r;
    for (let y = r[1]; y <= r[3]; y++) {
      for (let x = r[0]; x <= r[2]; x++) { const i = y * this.cols + x; (this.cells[i] ??= []).push(it); }
    }
  }

  remove(it) {
    this.size--;
    const r = it._cells;
    if (!r) { this.oversize.delete(it); return; }
    for (let y = r[1]; y <= r[3]; y++) {
      for (let x = r[0]; x <= r[2]; x++) {
        const c = this.cells[y * this.cols + x], j = c ? c.indexOf(it) : -1;
        if (j >= 0) { c[j] = c[c.length - 1]; c.pop(); }
      }
    }
    it._cells = null;
  }

  /** items whose cells intersect `box` (each once, unordered; a superset of the items whose bbox touches it) */
  query(box) {
    const out = [], s = ++this._stamp;
    for (const it of this.oversize) { it._qs = s; out.push(it); }
    const r = this._range(box);
    for (let y = r[1]; y <= r[3]; y++) {
      for (let x = r[0]; x <= r[2]; x++) {
        const c = this.cells[y * this.cols + x];
        if (!c) continue;
        for (let j = 0; j < c.length; j++) { const it = c[j]; if (it._qs !== s) { it._qs = s; out.push(it); } }
      }
    }
    return out;
  }
}
