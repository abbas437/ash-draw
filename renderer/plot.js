// ASH Draw Studio - Print / Plot to PDF: one dialog (paper, orientation, what to print, scale, centring) that builds a
// vector PDF with exportPdf, then either prints it (api.print -> system print dialog) or saves it.
import { plotScale, pageFit, placeOnPage, exportPdfPages } from '../src/core/exportPdf.js';
import { screenToWorld } from '../src/core/render.js';
import { layoutPage, layoutPlotRegion, layoutPlotWindow, layoutMmPerUnit } from '../src/core/layouts.js';
import { plotSettingsFrom, plotSettingsToStore, LAYOUT_PAPERS, layoutPlotStart } from '../src/core/plotSettings.js';
import { el, message, modal, toast } from './ui.js';
import { exportPdfBytes, unitsPerMm, unicodeFonts, plotPdfName } from './files.js';
import { bitmapRgba } from './images.js';
import { viewsIn, findView, restorable, viewBox } from '../src/core/views.js';

const options = (pairs) => pairs.map((s) => { const [v, l] = s.split('|'); return el('option', { value: v, text: l }); });
const fmt = (v) => String(+v.toPrecision(6));
const MONO = ' Monochrome (monochrome.ctb)';
const PAPER_LABELS = { layout: "Layout's own paper", Tabloid: 'Tabloid / ANSI B' };
const paperSelect = (value) => { const e = el('select', { name: 'paper' }, LAYOUT_PAPERS.map((v) => el('option', { value: v, text: PAPER_LABELS[v] ?? v }))); e.value = value; return e; };

/** the plot choices, loaded once from setting 'plot.settings' */
async function settings(app) {
  if (!app.plotSettings) {
    const v = await window.api?.settingsGet?.('plot.settings')?.catch?.(() => undefined);
    app.plotSettings ??= plotSettingsFrom(v);
  }
  return app.plotSettings;
}
const remember = (s) => window.api?.settingsSet?.('plot.settings', plotSettingsToStore(s))?.catch?.(() => {});

const AREA_LABELS = { layout: 'layout sheet', extents: 'extents', window: 'window' };
/** scale readout of a layout plot: `area` (layout | extents | window; `extents` the paper-space extents) on `paper`,
 *  fitted or at 1:n (paper : layout), as exportPdf plots it with layoutScale = layoutMmPerUnit / n */
export function sheetScaleText(layout, { paper, fit, area = 'layout', n = 1, extents = null }) {
  if (paper === 'layout' && area === 'layout') return 'Scale 1:1 on the layout\'s own paper';
  const lp = layoutPage(layout), reg = layoutPlotRegion(layout, area, extents), mm = layoutMmPerUnit(layout.plot), k0 = (mm / n) * (72 / 25.4);
  const w = (reg.maxx - reg.minx) * k0, h = (reg.maxy - reg.miny) * k0;
  const f = paper === 'layout' ? { ...placeOnPage(w, h, lp.pw, lp.ph, { fit }), orientation: '' } : pageFit(w, h, paper, { fit });
  const s = f.scale / n; // paper : layout
  const r = s <= 1 ? `1:${+(1 / s).toFixed(2)}` : `${+s.toFixed(2)}:1`;
  const on = paper === 'layout' ? 'the layout\'s own paper' : `${paper} ${f.orientation}`;
  return `${fit ? 'Fit' : 'Scale'}: ${r} of the layout, ${AREA_LABELS[area]} on ${on}${f.fits ? '' : ' (larger than the paper: edges cut off)'}`;
}
const rectOf = (a, b) => ({ minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y), maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y) });

/** Let the user pick the two corners of a plot window on the drawing; resolves with the rectangle, or null if cancelled. */
function pickWindow(app) {
  return new Promise((resolve) => {
    const vp = app.vp, prev = app.toolId ?? 'select', prevLast = app.lastTool;
    let a = null, settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    const leave = (r) => { settle(r); app.setTool(prev === 'plotwindow' ? 'select' : prev); app.lastTool = prevLast; };
    app.tools.plotwindow = {
      get prompt() { return a ? 'PLOT  opposite corner of the window' : 'PLOT  first corner of the window to print (Esc = cancel)'; },
      activate() { vp.preview = (c) => this.draw(c); },
      deactivate() { vp.preview = null; vp.lastPoint = null; settle(null); },
      cancel() { leave(null); },
      up(p, ev) { if (!ev.dragged) this.click(p); },
      click(p) {
        if (!a) { a = p; vp.lastPoint = p; return; }
        if (Math.abs(p.x - a.x) > 1e-12 && Math.abs(p.y - a.y) > 1e-12) leave(rectOf(a, p));
      },
      key(e) { if (e.key === 'Escape') { leave(null); return true; } return e.key === 'Enter'; },
      rightClick() { leave(null); },
      draw(c) {
        if (!a) return;
        const q = vp.cursor, P = [a, { x: q.x, y: a.y }, q, { x: a.x, y: q.y }].map((p) => vp.toScreen(p));
        c.strokeStyle = vp.inkColor; c.setLineDash([4, 3]); c.beginPath();
        P.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.stroke();
      },
    };
    app.setTool('plotwindow');
    app.lastTool = prevLast;
  });
}

/** The drawing area currently shown in the viewport. */
function viewRect(vp) { return rectOf(vp.toWorld(0, vp.view.height), vp.toWorld(vp.view.width, 0)); }

/** the model view a drawing tab shows: the live view of the active tab, the saved one of another (null: none known, plot the extents) */
function tabViewRect(app, tab) {
  const v = tab === app.active ? (app.vp.layout ? null : app.vp.view) : tab.view && { ...tab.view, width: app.vp.view.width, height: app.vp.view.height };
  return v ? rectOf(screenToWorld(v, 0, v.height), screenToWorld(v, v.width, 0)) : null;
}

/** mode 'print' (Print button, system print dialog) or 'pdf' (Save button, Plot to PDF). Options persist per session. */
export async function plotDialog(app, mode) {
  if (app.vp.layout) { await plotLayoutDialog(app, mode); return; }
  const s = await settings(app);
  const cmp = !!app.active?.compare, storedMono = s.monochrome; // a comparison plots in colour; the remembered choice is kept for other tabs
  let monoNow = false;
  for (;;) {
    const size = el('select', { name: 'pageSize' }, options(['fit|Fit to drawing', 'A4|A4', 'A3|A3', 'A2|A2', 'A1|A1', 'A0|A0', 'Letter|Letter']));
    const ori = el('select', { name: 'orientation' }, options(['auto|Automatic', 'landscape|Landscape', 'portrait|Portrait']));
    const what = el('select', { name: 'what' }, options(['extents|Extents', 'view|Current view', 'window|Window', 'named|Named view']));
    const named = viewsIn(app.doc, 'model').filter(restorable);
    const viewSel = el('select', { name: 'namedView', disabled: !named.length }, named.length ? named.map((v) => el('option', { value: v.name, text: v.name })) : el('option', { value: '', text: '(no named views)' }));
    if (named.some((v) => v.name === s.namedView)) viewSel.value = s.namedView;
    [size.value, ori.value, what.value] = [s.pageSize, s.orientation, s.what];
    const fit = el('input', { type: 'checkbox', name: 'fit', checked: s.fit });
    const n = el('input', { type: 'number', name: 'scale', min: '0.000001', step: 'any', value: String(s.n), style: 'width:7em' });
    const centre = el('input', { type: 'checkbox', name: 'centre', checked: s.centre });
    const mono = el('input', { type: 'checkbox', name: 'monochrome', checked: cmp ? false : s.monochrome }), lw = el('input', { type: 'checkbox', name: 'lineweights', checked: s.lineweights }), tp = el('input', { type: 'checkbox', name: 'transparency', checked: s.transparency });
    const winText = s.window ? `Window: (${fmt(s.window.minx)}, ${fmt(s.window.miny)}) to (${fmt(s.window.maxx)}, ${fmt(s.window.maxy)})` : 'Window: not picked yet';
    const r = await modal(mode === 'print' ? 'Print' : 'Plot to PDF', [
      el('label', {}, 'Page size'), size, el('label', {}, 'Orientation'), ori,
      el('label', {}, 'What to print'), what, el('p', { class: 'plot-window', text: winText }), el('label', {}, 'Named view ', viewSel),
      el('label', {}, fit, ' Fit to paper'), el('label', {}, 'Scale (paper : drawing)  1 : ', n),
      el('label', {}, centre, ' Centre the plot'),
      el('label', {}, mono, MONO), el('label', {}, lw, ' Use lineweights'), el('label', {}, tp, ' Plot transparency'),
      el('p', { text: 'The drawing is plotted as vector graphics. A 1 : N scale uses the drawing units (unitless drawings are taken as millimetres). Latin, Greek, Cyrillic and Arabic text is drawn with the bundled Noto fonts; Chinese, Japanese and Korean text cannot be drawn in this version.' })],
    [{ label: mode === 'print' ? 'Print' : 'Save', value: 'ok', primary: true }, { label: 'Pick window…', value: 'pick' }, { label: 'Cancel', value: null }]);
    if (r == null) return;
    const nv = Number(n.value);
    monoNow = mono.checked;
    Object.assign(s, { pageSize: size.value, orientation: ori.value, what: what.value, fit: fit.checked, centre: centre.checked, monochrome: cmp ? storedMono : mono.checked, lineweights: lw.checked, transparency: tp.checked });
    if (!s.fit && !(nv > 0)) { await message('Invalid scale', 'Enter a scale greater than zero, for example 1 : 50.'); continue; }
    if (nv > 0) s.n = nv;
    s.namedView = viewSel.value || null; // this session only, like a picked window
    if (s.what === 'named' && !findView(app.doc, s.namedView ?? '')) { await message('No named view', 'Choose a named view, or save one first with VIEW.'); continue; }
    if (r === 'pick' || (s.what === 'window' && !s.window)) {
      const w = await pickWindow(app);
      if (w) Object.assign(s, { window: w, what: 'window' });
      continue;
    }
    break;
  }
  remember(s);
  const region = s.what === 'window' ? s.window : s.what === 'view' ? viewRect(app.vp) : s.what === 'named' ? viewBox(findView(app.doc, s.namedView)) : null;
  try {
    const out = await exportPdfBytes(app.fileDoc, app.scene(), {
      pageSize: s.pageSize, orientation: s.orientation, monochrome: monoNow, lineweights: s.lineweights, transparency: s.transparency,
      region, centre: s.centre, scale: s.fit ? null : plotScale(s.n, 1 / unitsPerMm(app.fileDoc)),
    });
    if (mode === 'pdf') await app.saveBytes(out.bytes, 'pdf', 'PDF document');
    else {
      const res = await window.api.print(out.bytes);
      if (res && !res.ok && res.reason && !/cancel/i.test(res.reason)) await message('Print failed', res.reason);
    }
    if (out.warnings.length) await message(mode === 'pdf' ? 'PDF exported with warnings' : 'Printed with warnings', out.warnings.join('\n'));
  } catch (err) { await message(mode === 'pdf' ? 'Export failed' : 'Print failed', err.message || String(err)); }
}

/** a layout tab plots its page setup: the sheet, extents or plot window, fitted or at 1:N, on the layout's own paper or
 *  another (the sheet on its own paper is always 1:1) */
async function plotLayoutDialog(app, mode) {
  const s = await settings(app);
  const cmp = !!app.active?.compare, storedMono = s.monochrome;
  const layout = app.vp.layout, p = layout.plot, swap = p.rotation === 1 || p.rotation === 3;
  const extents = (app.vp.mspace?.paperScene ?? app.vp.scene)?.bbox ?? null, hasWindow = !!layoutPlotWindow(p);
  const area = el('select', { name: 'area' }, options(['layout|Layout', 'extents|Extents', 'window|Window']));
  area.querySelector('option[value=window]').disabled = !hasWindow;
  area.value = p.plotType === 1 ? 'extents' : p.plotType === 4 && hasWindow ? 'window' : 'layout';
  const start = layoutPlotStart(p, s);
  const paperSel = paperSelect(start.paper), fit = el('input', { type: 'checkbox', name: 'fit', checked: start.fit });
  const n0 = p.scaleNum > 0 && p.scaleDen > 0 ? p.scaleDen / p.scaleNum : 1;
  const n = el('input', { type: 'number', name: 'scale', min: '0.000001', step: 'any', value: String(+n0.toPrecision(6)), style: 'width:7em' });
  const mono = el('input', { type: 'checkbox', name: 'monochrome', checked: cmp ? false : s.monochrome }), lw = el('input', { type: 'checkbox', name: 'lineweights', checked: s.lineweights }), tp = el('input', { type: 'checkbox', name: 'transparency', checked: s.transparency });
  const own = `${p.paperName || 'Paper'}: ${fmt(swap ? p.paperH : p.paperW)} × ${fmt(swap ? p.paperW : p.paperH)} mm (${p.units === 0 ? 'inches' : 'millimetres'})`;
  const readout = el('p', { class: 'plot-scale' });
  const update = () => {
    const sheet11 = area.value === 'layout' && paperSel.value === 'layout';
    fit.disabled = sheet11; n.disabled = sheet11 || fit.checked;
    const nv = Number(n.value);
    readout.textContent = sheetScaleText(layout, { paper: paperSel.value, fit: fit.checked || !(nv > 0), area: area.value, n: nv > 0 ? nv : 1, extents });
  };
  area.onchange = update; paperSel.onchange = update; fit.onchange = update; n.oninput = update; update();
  let r;
  for (;;) {
    r = await modal(mode === 'print' ? `Print ${layout.name}` : `Plot ${layout.name} to PDF`, [
      el('label', {}, 'Plot area'), area, el('p', { class: 'plot-paper', text: own }),
      el('label', {}, 'Paper'), paperSel, el('label', {}, fit, ' Fit to paper'), el('label', {}, 'Scale (paper : layout)  1 : ', n), readout,
      el('label', {}, mono, MONO), el('label', {}, lw, ' Use lineweights'), el('label', {}, tp, ' Plot transparency'),
      el('p', { text: 'The layout is plotted as vector graphics; viewports are clipped to their boundaries. Line weights keep their plotted width on any paper. The plot area, fit and scale start from the layout\'s page setup (a new layout without one starts from the paper and fit last used).' })],
    [{ label: mode === 'print' ? 'Print' : 'Save', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
    if (r == null) return;
    if (fit.disabled || fit.checked || Number(n.value) > 0) break;
    await message('Invalid scale', 'Enter a scale greater than zero, for example 1 : 1.');
  }
  const monoNow = mono.checked, sheet11 = fit.disabled, fitNow = !sheet11 && fit.checked;
  const layoutScale = sheet11 || fitNow ? null : layoutMmPerUnit(p) / Number(n.value);
  Object.assign(s, { layoutPaper: paperSel.value, layoutFit: fit.checked, monochrome: cmp ? storedMono : monoNow, lineweights: lw.checked, transparency: tp.checked });
  remember(s);
  try {
    const out = await exportPdfBytes(app.fileDoc, null, { layout, modelScene: app.vp.modelScene, paper: paperSel.value, area: area.value, fit: fitNow, layoutScale, monochrome: monoNow, lineweights: s.lineweights, transparency: s.transparency });
    if (mode === 'pdf') await app.saveBytes(out.bytes, 'pdf', 'PDF document', plotPdfName(app.file.name, layout.name));
    else {
      const res = await window.api.print(out.bytes);
      if (res && !res.ok && res.reason && !/cancel/i.test(res.reason)) await message('Print failed', res.reason);
    }
    if (out.warnings.length) await message(mode === 'pdf' ? 'PDF exported with warnings' : 'Printed with warnings', out.warnings.join('\n'));
  } catch (err) { await message(mode === 'pdf' ? 'Export failed' : 'Print failed', err.message || String(err)); }
}

/** PUBLISH (File > Publish to PDF…): the chosen sheets of every open drawing, one page each in list order, in one PDF */
export async function publishDialog(app) {
  const s = await settings(app);
  const cmp = !!app.active?.compare, storedMono = s.monochrome;
  const rows = [];
  for (const tab of app.tabs) {
    const name = tab.file.name;
    rows.push({ tab, doc: tab.doc, layout: null, label: `${name} — Model`, on: s.publishModel });
    for (const lo of [...(tab.doc.layouts ?? [])].sort((a, b) => a.tab - b.tab)) rows.push({ doc: tab.doc, layout: lo, label: `${name} — ${lo.name}`, on: true });
  }
  for (const r of rows) r.box = el('input', { type: 'checkbox', name: 'sheet', checked: r.on });
  const list = el('div', { class: 'publish-list', style: 'max-height:40vh;overflow:auto;border:1px solid var(--line);padding:4px 8px;margin-bottom:8px' }, rows.map((r) => el('label', { style: 'display:block' }, r.box, ` ${r.label}`)));
  const paperSel = paperSelect(s.layoutPaper), fit = el('input', { type: 'checkbox', name: 'fit', checked: s.layoutFit });
  const area = el('select', { name: 'area' }, options(['extents|Extents', 'view|Current view'])); area.value = s.publishArea;
  fit.disabled = paperSel.value === 'layout'; paperSel.onchange = () => { fit.disabled = paperSel.value === 'layout'; };
  const mono = el('input', { type: 'checkbox', name: 'monochrome', checked: cmp ? false : s.monochrome }), lw = el('input', { type: 'checkbox', name: 'lineweights', checked: s.lineweights }), tp = el('input', { type: 'checkbox', name: 'transparency', checked: s.transparency });
  for (;;) {
    const r = await modal('Publish to PDF', [
      el('label', {}, 'Sheets (one page each, in this order)'), list,
      el('label', {}, 'Paper'), paperSel, el('label', {}, fit, ' Fit to paper'),
      el('label', {}, 'Plot area of model sheets'), area,
      el('label', {}, mono, MONO), el('label', {}, lw, ' Use lineweights'), el('label', {}, tp, ' Plot transparency'),
      el('p', { text: "Model sheets are fitted to the plot area on the chosen paper (A3 with the layout's own paper). Current view is the part of the model each drawing tab shows now; anything outside it is not plotted." })],
    [{ label: 'Publish', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
    if (r == null) return;
    const monoNow = mono.checked;
    Object.assign(s, { layoutPaper: paperSel.value, layoutFit: fit.checked, monochrome: cmp ? storedMono : monoNow, lineweights: lw.checked, transparency: tp.checked, publishArea: area.value });
    const model = rows.filter((x) => !x.layout);
    if (model.length) s.publishModel = model.some((x) => x.box.checked);
    remember(s);
    const sheets = rows.filter((x) => x.box.checked);
    if (!sheets.length) { await message('Nothing to publish', 'Tick at least one sheet.'); continue; }
    try {
      toast(`Publishing ${sheets.length} sheet${sheets.length > 1 ? 's' : ''}…`, 60000);
      const out = await exportPdfPages(sheets.map((x) => ({ doc: x.doc, layout: x.layout, label: x.label, region: !x.layout && s.publishArea === 'view' ? tabViewRect(app, x.tab) : null })), {
        paper: s.layoutPaper, fit: s.layoutFit, pageSize: s.layoutPaper === 'layout' ? 'A3' : s.layoutPaper, orientation: 'auto', margin: 10, scale: null, centre: true,
        monochrome: monoNow, lineweights: s.lineweights, transparency: s.transparency, unicodeFonts, imageRgba: bitmapRgba,
      });
      toast(`Published ${sheets.length} sheet${sheets.length > 1 ? 's' : ''}`, 1500);
      await app.saveBytes(out.bytes, 'pdf', 'PDF document');
      if (out.warnings.length) await message('PDF published with warnings', out.warnings.join('\n'));
    } catch (err) { toast('', 1); await message('Publish failed', err.message || String(err)); }
    return;
  }
}
