// ASH Draw Studio - the plot / publish dialog choices remembered between sessions (setting 'plot.settings').
// Pure ES module: plotSettingsFrom() keeps the defaults for anything missing or invalid in a stored value.

/** ANSI and ARCH page sizes added to the ISO ones: [name, label, width mm, height mm] (portrait; inches x 25.4) */
const IN = 25.4;
export const EXTRA_PAPERS = [
  ['ANSI C', 'ANSI C (17×22 in)', 17 * IN, 22 * IN], ['ANSI D', 'ANSI D (22×34 in)', 22 * IN, 34 * IN], ['ANSI E', 'ANSI E (34×44 in)', 34 * IN, 44 * IN],
  ['ARCH A', 'ARCH A (9×12 in)', 9 * IN, 12 * IN], ['ARCH B', 'ARCH B (12×18 in)', 12 * IN, 18 * IN], ['ARCH C', 'ARCH C (18×24 in)', 18 * IN, 24 * IN],
  ['ARCH D', 'ARCH D (24×36 in)', 24 * IN, 36 * IN], ['ARCH E', 'ARCH E (36×48 in)', 36 * IN, 48 * IN], ['ARCH E1', 'ARCH E1 (30×42 in)', 30 * IN, 42 * IN],
];
/** page size names (the existing ones first), then ANSI/ARCH, then 'Custom' (width x height from the settings) */
export const PAGE_SIZES = ['A4', 'A3', 'A2', 'A1', 'A0', 'Letter', 'Tabloid', ...EXTRA_PAPERS.map((e) => e[0]), 'Custom'];
/** option labels of the page sizes that are not just their name */
export const PAPER_LABELS = { Letter: 'Letter / ANSI A (8.5×11 in)', Tabloid: 'Tabloid / ANSI B (11×17 in)', Custom: 'Custom…', ...Object.fromEntries(EXTRA_PAPERS.map((e) => [e[0], e[1]])) };
export const CUSTOM_MIN_MM = 10, CUSTOM_MAX_MM = 5000;
/** a custom page side in mm is valid when it is a number from 10 to 5000 */
export const validCustomMm = (x) => Number.isFinite(x) && x >= CUSTOM_MIN_MM && x <= CUSTOM_MAX_MM;

/** layout plot papers: the layout's own paper at 1:1, or a page size the sheet is put on */
export const LAYOUT_PAPERS = ['layout', ...PAGE_SIZES];

export const PLOT_DEFAULTS = Object.freeze({
  pageSize: 'A3', orientation: 'auto', monochrome: false, keepGreys: false, lineweights: true, transparency: true, what: 'extents', fit: true, n: 100, centre: true,
  layoutPaper: 'layout', layoutFit: true, customW: 420, customH: 297, publishModel: false, publishArea: 'extents', styleTable: '',
});
const CHOICES = { pageSize: ['fit', ...PAGE_SIZES], orientation: ['auto', 'landscape', 'portrait'], what: ['extents', 'view', 'window'], publishArea: ['extents', 'view'], layoutPaper: LAYOUT_PAPERS };

/** a stored settings value -> full plot settings (window: none picked yet; a picked window is not remembered) */
export function plotSettingsFrom(v) {
  const s = { ...PLOT_DEFAULTS, window: null };
  if (!v || typeof v !== 'object') return s;
  for (const [key, def] of Object.entries(PLOT_DEFAULTS)) {
    const x = v[key];
    if (typeof x !== typeof def) continue;
    if (CHOICES[key] && !CHOICES[key].includes(x)) continue;
    if ((key === 'customW' || key === 'customH') && !validCustomMm(x)) continue;
    if (key === 'n' && !(Number.isFinite(x) && x > 0)) continue;
    if (key === 'styleTable' && x !== '' && !validStyleTableName(x)) continue;
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

// ---- plot style tables loaded from .ctb files (setting 'plot.styleTables') ----------------------------------------------
// The original file bytes (base64) are kept, not the parsed table (255 pens of a dozen fields each are many times larger
// than a compressed .ctb). The list is oldest first: [{ name, data }].
export const STYLE_TABLES_KEY = 'plot.styleTables';
export const STYLE_TABLES_MAX = 5;
export const STYLE_TABLES_MAX_CHARS = 60000; // the desktop settings store refuses a value over 64 KB (as JSON)

/** a table name as remembered / listed: a file name (no folder) of 1..255 characters ending in .ctb */
export const validStyleTableName = (n) => typeof n === 'string' && n.length <= 255 && /^[^\\/\u0000-\u001f]+\.ctb$/i.test(n) && n.trim() === n;
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
/** the name in `names` that is `name` ignoring case, or null */
export const findStyleTableName = (names, name) => (typeof name === 'string' && name ? names.find((n) => sameName(n, name)) ?? null : null);
const storedSize = (list) => JSON.stringify(list).length;
const validEntry = (e) => e && validStyleTableName(e.name) && typeof e.data === 'string' && e.data.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(e.data);

/** add `entry` ({ name, data }) to the stored list: a table of the same name (any case) is replaced, then the oldest are
 *  dropped until at most STYLE_TABLES_MAX remain and the list is within STYLE_TABLES_MAX_CHARS. A table that alone is
 *  over the size limit is not stored (stored: false; the list is unchanged). -> { list, dropped (names), stored } */
export function addStyleTable(list, entry, { max = STYLE_TABLES_MAX, maxChars = STYLE_TABLES_MAX_CHARS } = {}) {
  if (storedSize([entry]) > maxChars) return { list: [...list], dropped: [], stored: false };
  const out = [...list.filter((e) => !sameName(e.name, entry.name)), { name: entry.name, data: entry.data }], dropped = [];
  while (out.length > max || storedSize(out) > maxChars) dropped.push(out.shift().name);
  return { list: out, dropped, stored: true };
}

/** a stored value -> the list (entries checked; a hand-edited settings file can hold anything), within the same caps */
export function styleTablesFrom(v) {
  if (!Array.isArray(v)) return [];
  let list = [];
  for (const e of v) if (validEntry(e)) list = addStyleTable(list, { name: e.name, data: e.data }).list;
  return list;
}
