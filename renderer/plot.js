// ASH Draw Studio - Print / Plot to PDF: one dialog (paper, orientation, what to print, scale, centring) that builds a
// vector PDF with exportPdf, then either prints it (api.print -> system print dialog) or saves it.
import { plotScale } from '../src/core/exportPdf.js';
import { el, message, modal } from './ui.js';
import { exportPdfBytes, unitsPerMm } from './files.js';

const options = (pairs) => pairs.map((s) => { const [v, l] = s.split('|'); return el('option', { value: v, text: l }); });
const fmt = (v) => String(+v.toPrecision(6));
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

/** mode 'print' (Print button, system print dialog) or 'pdf' (Save button, Plot to PDF). Options persist per session. */
export async function plotDialog(app, mode) {
  const s = (app.plotSettings ??= { pageSize: 'A3', orientation: 'auto', monochrome: false, lineweights: true, what: 'extents', window: null, fit: true, n: 100, centre: true });
  for (;;) {
    const size = el('select', { name: 'pageSize' }, options(['fit|Fit to drawing', 'A4|A4', 'A3|A3', 'A2|A2', 'A1|A1', 'A0|A0', 'Letter|Letter']));
    const ori = el('select', { name: 'orientation' }, options(['auto|Automatic', 'landscape|Landscape', 'portrait|Portrait']));
    const what = el('select', { name: 'what' }, options(['extents|Extents', 'view|Current view', 'window|Window']));
    [size.value, ori.value, what.value] = [s.pageSize, s.orientation, s.what];
    const fit = el('input', { type: 'checkbox', name: 'fit', checked: s.fit });
    const n = el('input', { type: 'number', name: 'scale', min: '0.000001', step: 'any', value: String(s.n), style: 'width:7em' });
    const centre = el('input', { type: 'checkbox', name: 'centre', checked: s.centre });
    const mono = el('input', { type: 'checkbox', name: 'monochrome', checked: s.monochrome }), lw = el('input', { type: 'checkbox', name: 'lineweights', checked: s.lineweights });
    const winText = s.window ? `Window: (${fmt(s.window.minx)}, ${fmt(s.window.miny)}) to (${fmt(s.window.maxx)}, ${fmt(s.window.maxy)})` : 'Window: not picked yet';
    const r = await modal(mode === 'print' ? 'Print' : 'Plot to PDF', [
      el('label', {}, 'Page size'), size, el('label', {}, 'Orientation'), ori,
      el('label', {}, 'What to print'), what, el('p', { class: 'plot-window', text: winText }),
      el('label', {}, fit, ' Fit to paper'), el('label', {}, 'Scale (paper : drawing)  1 : ', n),
      el('label', {}, centre, ' Centre the plot'),
      el('label', {}, mono, ' Black and white'), el('label', {}, lw, ' Use lineweights'),
      el('p', { text: 'The drawing is plotted as vector graphics. A 1 : N scale uses the drawing units (unitless drawings are taken as millimetres). Text outside the Western Latin character set (for example Arabic) cannot be drawn in this version.' })],
    [{ label: mode === 'print' ? 'Print' : 'Save', value: 'ok', primary: true }, { label: 'Pick window…', value: 'pick' }, { label: 'Cancel', value: null }]);
    if (r == null) return;
    const nv = Number(n.value);
    Object.assign(s, { pageSize: size.value, orientation: ori.value, what: what.value, fit: fit.checked, centre: centre.checked, monochrome: mono.checked, lineweights: lw.checked });
    if (!s.fit && !(nv > 0)) { await message('Invalid scale', 'Enter a scale greater than zero, for example 1 : 50.'); continue; }
    if (nv > 0) s.n = nv;
    if (r === 'pick' || (s.what === 'window' && !s.window)) {
      const w = await pickWindow(app);
      if (w) Object.assign(s, { window: w, what: 'window' });
      continue;
    }
    break;
  }
  const region = s.what === 'window' ? s.window : s.what === 'view' ? viewRect(app.vp) : null;
  try {
    const out = await exportPdfBytes(app.fileDoc, app.scene(), {
      pageSize: s.pageSize, orientation: s.orientation, monochrome: s.monochrome, lineweights: s.lineweights,
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
