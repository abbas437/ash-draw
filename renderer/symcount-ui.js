// ASH Draw Studio - SYMCOUNT / BCOUNT and the Symbols panel's "Count…" button: how many times each symbol (block) is
// inserted in the selection or the current space, as a dialog with Excel / CSV export and a symbol schedule placed in
// the drawing (lines, text and one INSERT per symbol on layer SYMBOL-SCHEDULE, one undo step). Counting is in
// src/core/symcount.js.
import { countSymbols, symcountCsv, symcountSheet } from '../src/core/symcount.js';
export { symcountSheet };
import { xlsxBytes } from '../src/core/xlsx.js';
import { unitScale } from '../src/core/clipboard.js';
import { bboxOf, unionBox } from '../src/core/geom.js';
import { makeLine, makeText, makeInsert } from '../src/core/model.js';
import { savePathIn } from './files.js';
import { pickPoint } from './clipboard-ui.js';
import { el, modal, toast } from './ui.js';

export const SCHEDULE_LAYER = 'SYMBOL-SCHEDULE';
const U = (s) => String(s ?? '').toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);
const drawingName = (app) => String(app.file?.name ?? 'drawing').replace(/\.[^.]*$/, '');

/** what SYMCOUNT counts: the selected objects, else the current space (model or the active layout) */
function countScope(app) {
  const ids = app.vp.selection;
  if (ids.size) return { entities: app.doc.entities.filter((e) => ids.has(e.id)), label: `${ids.size} selected object${ids.size === 1 ? '' : 's'}` };
  const space = app.vp.mspace ? 'Model' : (app.active?.spaces?.cur ?? 'Model'); // MSPACE in a layout viewport edits model space
  return { space, label: U(space) === 'MODEL' ? 'Model space' : `Layout ${space}` };
}

/** default text height of the placed schedule: 2.5 mm on paper at the Symbols panel's drawing scale, in drawing units */
export const scheduleTextHeight = (units, drawingScale = 1) => 2.5 * (drawingScale > 0 ? drawingScale : 1) * unitScale(4, units ?? 0);

/** the schedule's entities with its top-left corner at `at`: grid LINEs, TEXT (title, header, cells) and one INSERT of
 *  each symbol scaled to about 80 % of the row height, centred in the picture cell (none without a block extent) */
export function scheduleEntities(doc, rows, total, at, th, layer = SCHEDULE_LAYER) {
  const rh = 2.4 * th, pad = 0.5 * th, o = { layer };
  const wPic = 1.6 * rh, wQty = 5 * th;
  const wDesc = Math.max(12 * th, ...rows.map((r) => String(r.name).length * 0.6 * th + 2 * pad));
  const W = wPic + wDesc + wQty, xs = [at.x, at.x + wPic, at.x + wPic + wDesc, at.x + W];
  const n = rows.length + 3; // title, header, symbols, total
  const yAt = (i) => at.y - i * rh, bottom = yAt(n);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(makeLine({ x: at.x, y: yAt(i) }, { x: at.x + W, y: yAt(i) }, o));
  out.push(makeLine({ x: at.x, y: yAt(0) }, { x: at.x, y: bottom }, o), makeLine({ x: at.x + W, y: yAt(0) }, { x: at.x + W, y: bottom }, o));
  for (const x of xs.slice(1, 3)) out.push(makeLine({ x, y: yAt(1) }, { x, y: bottom }, o));
  const text = (col, i, s, h = th) => out.push(makeText({ x: xs[col] + pad, y: yAt(i + 1) + (rh - h) / 2 }, h, String(s), o));
  text(0, 0, 'SYMBOL SCHEDULE', Math.min(1.2 * th, rh * 0.6));
  text(0, 1, 'Symbol'); text(1, 1, 'Description'); text(2, 1, 'Qty');
  rows.forEach((r, k) => {
    const i = k + 2;
    text(1, i, r.name); text(2, i, r.count);
    const pic = picture(doc, r.name, { x: xs[0] + wPic / 2, y: yAt(i) - rh / 2 }, Math.min(0.8 * rh, 0.8 * wPic), 0.8 * rh, layer);
    if (pic) out.push(pic);
  });
  text(1, n - 1, 'Total'); text(2, n - 1, total);
  return out;
}

/** an INSERT of block `name` fitted into a w x h box centred on c; null when the block has no definition or extent */
function picture(doc, name, c, w, h, layer) {
  const blk = doc.blocks?.get(name);
  if (!blk) return null;
  let b = null;
  for (const e of blk.entities ?? []) { try { b = unionBox(b, bboxOf(e, doc)); } catch { /* an unboxable part */ } }
  if (!b) return null;
  const bw = b.maxx - b.minx, bh = b.maxy - b.miny;
  const k = Math.min(bw > 0 ? w / bw : Infinity, bh > 0 ? h / bh : Infinity);
  if (!Number.isFinite(k) || !(k > 0)) return null;
  const base = blk.base ?? { x: 0, y: 0 }, mx = (b.minx + b.maxx) / 2, my = (b.miny + b.maxy) / 2;
  return makeInsert(name, { x: c.x - k * (mx - base.x), y: c.y - k * (my - base.y) }, { layer, sx: k, sy: k });
}

/** place the schedule at `at` as one undo step; returns the added entities */
export function placeSchedule(s, doc, rows, total, at, th) {
  const existing = [...s.doc.layers.keys()].find((k) => U(k) === SCHEDULE_LAYER); // keep the drawing's own spelling
  const ents = scheduleEntities(doc, rows, total, at, th, existing ?? SCHEDULE_LAYER);
  return s.transact('Symbol schedule', (tx) => {
    if (existing == null) tx.layer(SCHEDULE_LAYER, { color: 7 });
    return ents.map((e) => tx.add(e));
  });
}

/** SYMCOUNT / BCOUNT: the count dialog */
export async function symcountDialog(app) {
  const doc = app.fileDoc, scope = countScope(app), name = drawingName(app);
  const nested = el('input', { type: 'checkbox', id: 'symc-nested' });
  const table = el('table', { class: 'symc-table' }), totalLine = el('div', { class: 'symc-total', role: 'status' });
  const thIn = el('input', { id: 'symc-th', type: 'number', step: 'any', min: '0', style: 'width:7em', title: 'Text height of the schedule placed in the drawing (drawing units)' });
  const drawingScale = () => (app.vp.layout && !app.vp.mspace ? 1 : app.symbolsPanel?.drawingScale ?? 1); // paper space is already at plot scale
  thIn.value = String(+scheduleTextHeight(doc.units, drawingScale()).toPrecision(6));
  thIn.addEventListener('keydown', (e) => e.stopPropagation());
  let res;
  const recount = () => {
    res = countSymbols(doc, { entities: scope.entities ?? null, nested: nested.checked, space: scope.space });
    table.replaceChildren(el('thead', {}, el('tr', {}, el('th', { text: 'Symbol' }), el('th', { text: 'Count' }), el('th', { text: 'Layers' }))),
      el('tbody', {}, res.rows.length ? res.rows.map((r) => el('tr', {}, el('td', { text: r.name }), el('td', { class: 'num', text: String(r.count) }), el('td', { text: r.layers.join(', ') })))
        : el('tr', {}, el('td', { colspan: '3', text: 'No symbols found.' }))));
    totalLine.textContent = `Total: ${res.total} in ${res.rows.length} symbol${res.rows.length === 1 ? '' : 's'}`;
  };
  nested.onchange = recount;
  recount();
  const save = async (ext, label, bytes) => {
    if (!res.rows.length) { toast('Nothing to export: no symbols found.'); return; }
    await window.api.saveFile({ defaultPath: savePathIn(app.file?.path, `${name}-symbol-count.${ext}`), filters: [{ name: label, extensions: [ext] }], bytes: bytes() });
  };
  const xlsx = el('button', { type: 'button', id: 'symc-xlsx', onclick: () => save('xlsx', 'Excel workbook', () => xlsxBytes([symcountSheet(res.rows, res.total, `Symbol count - ${name} - ${today()}`)])) }, 'Excel (.xlsx)…');
  const csv = el('button', { type: 'button', id: 'symc-csv', onclick: () => save('csv', 'CSV', () => new TextEncoder().encode(symcountCsv(res.rows))) }, 'CSV…');
  const r = await modal('Symbol count', el('div', { class: 'symc' },
    el('div', { class: 'symc-scope', text: `Counting: ${scope.label}` }),
    el('label', { class: 'cmp-opt', title: 'Also count the symbols inside other symbols' }, nested, ' Include nested blocks'),
    el('div', { class: 'symc-list' }, table), totalLine,
    el('div', { class: 'cmp-btns' }, xlsx, csv),
    el('label', {}, 'Schedule text height ', thIn)),
  [{ label: 'Place in drawing', value: 'place', primary: true }, { label: 'Close', value: null }]);
  if (r !== 'place') return;
  if (!res.rows.length) { toast('Nothing to place: no symbols found.'); return; }
  const th = Number(thIn.value) > 0 ? Number(thIn.value) : scheduleTextHeight(doc.units, drawingScale());
  const { rows, total } = res;
  pickPoint(app, 'SYMCOUNT  Specify top-left corner of the schedule:', (at) => {
    const added = placeSchedule(app.session, doc, rows, total, at, th);
    toast(`Symbol schedule placed (${rows.length} symbol${rows.length === 1 ? '' : 's'}, layer ${SCHEDULE_LAYER}).`, 2500);
    app.vp.setSelection(added.map((e) => e.id));
  });
}
