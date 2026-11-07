// ASH Draw Studio - the "Plot style table" field of the Plot / Print / Publish dialogs and PAGESETUP: None, the built-in
// .ctb tables, the tables loaded from .ctb files (setting 'plot.styleTables': the original file bytes, base64) and "Load .ctb…".
import { parsePlotStyleTable, BUILTIN_TABLES } from '../src/core/plotStyle.js';
import { STYLE_TABLES_KEY, addStyleTable, styleTablesFrom, findStyleTableName, validStyleTableName } from '../src/core/plotSettings.js';
import { el } from './ui.js';

const LOAD = '\u0000load';
const STB_TEXT = 'Named plot style tables (.stb) are not supported yet.';
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** the loaded tables ([{ name, data, table }], oldest first), read once from the setting; entries that no longer parse are skipped */
export async function loadedStyleTables(app) {
  if (!app.styleTables) {
    const v = await window.api?.settingsGet?.(STYLE_TABLES_KEY)?.catch?.(() => undefined);
    const list = [];
    for (const e of styleTablesFrom(v)) { try { const t = parsePlotStyleTable(unb64(e.data)); if (t.kind === 'ctb') list.push({ ...e, table: t }); } catch { /* damaged entry */ } }
    app.styleTables ??= list;
  }
  return app.styleTables;
}

const builtinNames = () => Object.keys(BUILTIN_TABLES);
/** every table name offered (built-ins, then the loaded ones not named as a built-in) */
const allNames = (app) => [...builtinNames(), ...(app.styleTables ?? []).map((e) => e.name).filter((n) => !findStyleTableName(builtinNames(), n))];
/** the offered name that is `name` ignoring case, or null */
export const styleTableName = (app, name) => findStyleTableName(allNames(app), name);
/** the parsed table of `name` (a loaded table first, then a built-in), or null (None, or not available) */
export function styleTableFor(app, name) {
  if (!name) return null;
  const e = (app.styleTables ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return e ? e.table : BUILTIN_TABLES[findStyleTableName(builtinNames(), name)] ?? null;
}

/** Load .ctb…: pick a file, parse it, store its bytes -> { name, note } (note: '' or what was not remembered), { error }
 *  (refused: the text to show), or null (cancelled). The texts are shown in the dialog itself: there is one modal at a time. */
export async function loadCtbFile(app) {
  await loadedStyleTables(app);
  const files = await window.api.openFiles({ filters: [{ name: 'Plot style tables (*.ctb)', extensions: ['ctb', 'stb'] }], multiple: false });
  const f = files?.[0];
  if (!f) return null;
  if (/\.stb$/i.test(f.name)) return { error: STB_TEXT };
  let table;
  try { table = parsePlotStyleTable(f.bytes); } catch (err) { return { error: `${f.name} cannot be used: ${err.message}.` }; }
  if (table.kind !== 'ctb') return { error: `${f.name}: ${STB_TEXT}` };
  const name = validStyleTableName(f.name) ? f.name : `${f.name.replace(/[\\/\u0000-\u001f]/g, '_').replace(/\.[^.]*$/, '').trim() || 'table'}.ctb`;
  const data = b64(f.bytes);
  const stored = app.styleTables.map(({ name: n, data: d }) => ({ name: n, data: d }));
  const r = addStyleTable(stored, { name, data });
  const keep = new Set(r.list.map((e) => e.name));
  app.styleTables = [...app.styleTables.filter((e) => keep.has(e.name) && e.name.toLowerCase() !== name.toLowerCase()), { name, data, table }];
  let saved = r.stored;
  if (saved) { try { await window.api.settingsSet(STYLE_TABLES_KEY, r.list); } catch { saved = false; } }
  const note = !r.stored ? `${name} is too large to be remembered (${Math.round(data.length / 1024)} KB); it can be used until the program is closed.`
    : !saved ? `${name} could not be remembered (the settings could not be saved); it can be used until the program is closed.`
    : r.dropped.length ? `To keep the remembered tables within the limit (5 tables, 60 KB), ${r.dropped.join(', ')} ${r.dropped.length === 1 ? 'was' : 'were'} removed from the list.` : '';
  return { name, note };
}

/** the Plot style table select (name 'styleTable', values '' / a table name). `initial` the name to show; `mono`/`greys`
 *  the dialog's Monochrome and Keep greys boxes (disabled while a table is chosen); `sheet` a layout's own style sheet name:
 *  preselected when available, else a line "This layout uses '<name>'" with Load…. -> { rows, value(), table(), changed() } */
export function styleTableField(app, initial, { mono = null, greys = null, sheet = '', keepUnknown = false } = {}) {
  const sel = el('select', { name: 'styleTable' });
  const note = el('p', { class: 'plot-style-note', text: 'The plot style table sets the colours.' });
  const sheetName = typeof sheet === 'string' ? sheet.trim() : '';
  const sheetLoad = el('button', { type: 'button', 'data-act': 'load-sheet' }, 'Load…');
  const msg = el('p', { class: 'plot-style-msg', role: 'status' });
  const sheetRow = el('p', { class: 'plot-style-sheet' }, el('span', { text: `This layout uses '${sheetName}' ` }), sheetLoad);
  const fill = (value) => {
    const names = allNames(app), loaded = names.filter((n) => !builtinNames().includes(n));
    const unknown = keepUnknown && value && !styleTableName(app, value) ? [el('option', { value, text: `${value} (not loaded)` })] : [];
    sel.replaceChildren(el('option', { value: '', text: 'None' }), ...builtinNames().map((n) => el('option', { value: n, text: n })), ...unknown,
      ...(loaded.length ? [el('optgroup', { label: 'Loaded' }, loaded.map((n) => el('option', { value: n, text: n })))] : []), el('option', { value: LOAD, text: 'Load .ctb…' }));
    sel.value = (unknown.length ? value : styleTableName(app, value)) ?? '';
  };
  const sync = () => {
    const on = sel.value !== '' && sel.value !== LOAD;
    note.style.display = on && mono ? '' : 'none';
    if (mono) mono.disabled = on;
    if (greys) greys.disabled = on || !mono?.checked;
    sheetRow.style.display = sheetName && !styleTableName(app, sheetName) ? '' : 'none';
  };
  const sheetFound = sheetName && styleTableName(app, sheetName);
  fill(sheetFound || initial);
  const start = sel.value;
  let prev = sel.value;
  const load = async (pick) => {
    const got = await loadCtbFile(app), n = got?.name ?? null;
    msg.textContent = got?.error ?? got?.note ?? '';
    fill(n ?? prev);
    if (n && pick) sel.value = styleTableName(app, n) ?? '';
    prev = sel.value; sync();
  };
  sel.addEventListener('change', () => { if (sel.value === LOAD) load(true); else { prev = sel.value; sync(); } });
  sheetLoad.addEventListener('click', () => load(true));
  sync();
  return {
    rows: [el('label', {}, 'Plot style table '), sel, msg, sheetRow, note],
    value: () => (sel.value === LOAD ? prev : sel.value),
    table: () => styleTableFor(app, sel.value === LOAD ? prev : sel.value),
    changed: () => (sel.value === LOAD ? prev : sel.value) !== start,
  };
}
