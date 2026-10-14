// ASH Draw Studio - the plot / publish dialog choices remembered between sessions (setting 'plot.settings').
// Pure ES module: plotSettingsFrom() keeps the defaults for anything missing or invalid in a stored value.

/** layout plot papers: the layout's own paper at 1:1, or a page size the sheet is put on */
export const LAYOUT_PAPERS = ['layout', 'A4', 'A3', 'A2', 'A1', 'A0', 'Letter', 'Tabloid'];

export const PLOT_DEFAULTS = Object.freeze({
  pageSize: 'A3', orientation: 'auto', monochrome: false, lineweights: true, transparency: true, what: 'extents', fit: true, n: 100, centre: true,
  layoutPaper: 'layout', layoutFit: true, publishModel: false, publishArea: 'extents',
});
const CHOICES = { pageSize: ['fit', 'A4', 'A3', 'A2', 'A1', 'A0', 'Letter'], orientation: ['auto', 'landscape', 'portrait'], what: ['extents', 'view', 'window'], publishArea: ['extents', 'view'], layoutPaper: LAYOUT_PAPERS };

/** a stored settings value -> full plot settings (window: none picked yet; a picked window is not remembered) */
export function plotSettingsFrom(v) {
  const s = { ...PLOT_DEFAULTS, window: null };
  if (!v || typeof v !== 'object') return s;
  for (const [key, def] of Object.entries(PLOT_DEFAULTS)) {
    const x = v[key];
    if (typeof x !== typeof def) continue;
    if (CHOICES[key] && !CHOICES[key].includes(x)) continue;
    if (key === 'n' && !(Number.isFinite(x) && x > 0)) continue;
    s[key] = x;
  }
  if (s.what === 'window') s.what = 'extents';
  return s;
}

/** the settings to store (without the picked window) */
/** where the layout Plot dialog starts ({ paper, fit }). A page setup with a standard-scale choice (group 75: every AutoCAD
 *  file, and PAGESETUP) is followed: the layout's own paper, fitted when its scale is "fit". A new ASH layout has none
 *  (its paperName is only the default A3), so the paper and fit the user last plotted a layout with (`s`) are used. */
export function layoutPlotStart(plot, s) {
  return plot?.stdScale != null ? { paper: 'layout', fit: plot.stdScale === 0 } : { paper: s.layoutPaper, fit: s.layoutFit };
}

export const plotSettingsToStore = (s) => Object.fromEntries(Object.keys(PLOT_DEFAULTS).map((k) => [k, s[k]]));
