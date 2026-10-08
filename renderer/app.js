// ASH Draw Studio - application controller: wires the viewport, tools, panels, menus and files together.
import { newDocument } from '../src/core/model.js';
import { eraseEntities, copyToClipboard, pasteEntities } from '../src/core/edit.js';
import { parseCoordinate } from '../src/core/coords.js';
import { PATTERN_NAMES } from '../src/core/patterns.js';
import { layIsolate, layUnisolate, layFreeze, layOn, layThaw } from '../src/core/layers.js';
import { Viewport, CANVAS_BG } from './viewport.js';
import { createDocState, findTabByPath, indexAfterClose, cycleIndex, isBlankTab } from './tabs.js';
import { createTools, TOOL_ALIASES } from './tools.js';
import { initSession } from './session.js';
import { FindPanel } from './find.js';
import { plotDialog } from './plot.js';
import { el, message, modal, confirmDialog, textDialog, toast, renderLayers, renderProperties } from './ui.js';
import {
  OPEN_FILTERS, loadDrawing, saveDxf, saveDwg, verificationMessage, exportSvgBytes, exportPngBytes, buildScene, baseName, extOf, UNIT_NAMES,
} from './files.js';

const api = window.api;

const TOOL_BUTTONS = [
  ['Select', [['select', 'Select']]],
  ['Draw', [['line', 'Line', 'L'], ['pline', 'Polyline', 'PL'], ['rect', 'Rectangle', 'REC'], ['circle', 'Circle', 'C'], ['arc', 'Arc', 'A'], ['ellipse', 'Ellipse', 'EL'], ['point', 'Point', 'PO'], ['text', 'Text', 'T'], ['hatch', 'Hatch', 'H']]],
  ['Modify', [['move', 'Move', 'M'], ['copy', 'Copy', 'CO'], ['rotate', 'Rotate', 'RO'], ['scale', 'Scale', 'SC'], ['mirror', 'Mirror', 'MI'], ['offset', 'Offset', 'O'], ['trim', 'Trim', 'TR'], ['extend', 'Extend', 'EX'], ['explode', 'Explode', 'X'], ['erase', 'Erase', 'E'],
    ['fillet', 'Fillet', 'F', 'M2 14V8a5 5 0 0 1 5-5h7'], ['chamfer', 'Chamfer', 'CHA', 'M2 14V7l4-4h8'],
    ['break', 'Break', 'BR', 'M1 8h5M10 8h5M6 5v6M10 5v6'], ['join', 'Join', 'J', 'M1 8h5M10 8h5M5 5l3 3-3 3M11 5 8 8l3 3'],
    ['lengthen', 'Lengthen', 'LEN', 'M1 8h10M11 5l4 3-4 3'], ['stretch', 'Stretch', 'STR', 'M1 4h7v8H1M8 8h7M12 5l3 3-3 3'],
    ['arrayrect', 'Array rect', 'AR', 'M2 2h4v4H2zM10 2h4v4h-4zM2 10h4v4H2zM10 10h4v4h-4z'],
    ['arraypolar', 'Array polar', 'ARRAYPOLAR', 'M7 1h2v2H7zM13 7h2v2h-2zM7 13h2v2H7zM1 7h2v2H1zM7.5 7.5h1v1h-1z'],
    ['arraypath', 'Array path', 'ARRAYPATH', 'M1 14C6 14 6 3 15 3M2 11h2v2H2zM7 6h2v2H7zM12 1h2v2h-2z']]],
  ['Inquiry', [['measure', 'Measure', 'MEA'], ['area', 'Area', 'AREA']]],
];

/** 16 px line icon for a toolbar button (one SVG path, drawn in the button's text colour). */
function toolIcon(d) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({ width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: 'vertical-align:-2px;margin-right:4px' })) svg.setAttribute(k, v);
  for (const [k, v] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

class App {
  constructor() {
    this.tabs = [];              // open drawings (file tabs); see tabs.js createDocState
    this.active = null;          // the tab shown
    this.defaults = { textHeight: null, hatchPattern: 'ANSI31', hatchScale: 1, hatchAngle: 0 };
    this.clip = [];
    this.lastTool = 'line';
    this.theme = 'light';        // UI theme; light by default, the choice is saved as setting 'theme'
    this.canvasOverride = false; // true once View > Light / dark background makes the canvas differ from the theme
    this.vp = new Viewport(document.getElementById('cv'));
    this.tools = createTools(this);
    this.toolId = null;
    this.sessionStore = initSession(this); // last session and recent files
    this.buildMenus();
    this.buildToolbar();
    this.buildStatus();
    this.bindKeys();
    this.bindDrop();
    this.find = new FindPanel(this);
    this.cmd = document.getElementById('cmd');
    this.cmd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const v = this.cmd.value; this.cmd.value = ''; this.vp.canvas.focus(); this.submit(v); }
      else if (e.key === 'Escape') { this.cmd.value = ''; this.cmd.blur(); this.vp.canvas.focus(); this.tool?.key({ key: 'Escape' }); }
      e.stopPropagation();
    });
    document.getElementById('z-in').onclick = () => this.vp.zoomBy(1.4);
    document.getElementById('z-out').onclick = () => this.vp.zoomBy(1 / 1.4);
    document.getElementById('z-fit').onclick = () => this.vp.zoomExtents();
    this.vp.on('selection', () => { this.refreshPanels(true); this.refreshStatus(); });
    this.vp.on('change', () => { this.refreshPanels(); this.refreshStatus(); this.updateTitle(); });
    this.vp.on('cursor', (p) => this.showCursor(p));
    window.addEventListener('beforeunload', (e) => { if (!this.closeConfirmed && this.tabs.some((t) => t.session.dirty)) { e.preventDefault(); e.returnValue = ''; } });
    api.onCloseRequest?.(() => this.closeAll());
    this.newDrawing();
    this.setTool('select');
    this.setTheme('light', false);
    api.settingsGet?.('theme').then((t) => { if (t === 'dark') this.setTheme('dark', false); }).catch(() => {});
    api.onOpenFile?.((f) => this.openFromFile(f));
    // files given at start-up open first; then the previous session is offered (or reopened, per startup.mode)
    api.getLaunchFiles?.().then(async (files) => { for (const f of files ?? []) await this.openFromFile(f); }).catch(() => {})
      .then(() => this.sessionStore.start());
  }

  // ---- host interface for tools ---------------------------------------------------------------
  get session() { return this.vp.session; }
  /** current layer and new-object properties of the shown drawing */
  get state() { return this.active.state; }
  get file() { return this.active.file; }
  set file(f) { this.active.file = f; }
  get doc() { return this.vp.doc; }
  get tool() { return this.tools[this.toolId]; }
  newProps() { return { layer: this.state.layer, color: this.state.color, linetype: this.state.linetype, lineweight: this.state.lineweight }; }
  toast(t, ms) { toast(t, ms); }
  askText(o) { return textDialog(o); }
  refreshPrompt() { document.getElementById('prompt').textContent = this.tool?.prompt ?? ''; }
  refreshPanels(selectionOnly = false) {
    if (!selectionOnly) renderLayers(this);
    renderProperties(this);
  }

  setTool(id) {
    if (this.toolId && this.tool) this.tool.deactivate();
    if (id !== 'select') this.lastTool = id;
    this.toolId = id;
    this.vp.tool = this.tool;
    this.vp.preview = null;
    this.tool.activate();
    for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === id);
    this.refreshPrompt();
    this.vp.requestRender();
    this.vp.canvas.focus();
  }

  // ---- commands ---------------------------------------------------------------------------------
  submit(raw) {
    const s = raw.trim();
    const t = this.tool;
    if (!s) { // Enter: finish the tool, or repeat the last command from idle
      if (this.toolId === 'select') this.setTool(this.lastTool); else t.key({ key: 'Enter' });
      this.refreshPrompt(); return;
    }
    if (t.text?.(s)) { this.refreshPrompt(); return; }
    const low = s.toLowerCase();
    if (TOOL_ALIASES[low]) { this.setTool(TOOL_ALIASES[low]); return; }
    const sys = { u: () => this.undo(), undo: () => this.undo(), redo: () => this.redo(), ze: () => this.vp.zoomExtents(), z: () => this.vp.zoomExtents(), 'zoom': () => this.vp.zoomExtents(), all: () => this.selectAll(), new: () => this.newDrawing(), open: () => this.open(), save: () => this.save(), saveas: () => this.saveAs('dxf'), pdf: () => this.exportPdf(), plot: () => this.print(), print: () => this.print(), find: () => this.find.open(), ...this.layerCommands() };
    if (sys[low]) { sys[low](); return; }
    const last = this.vp.lastPoint ?? { x: 0, y: 0 };
    const dir = this.vp.lastPoint ? { x: this.vp.cursor.x - last.x, y: this.vp.cursor.y - last.y } : null;
    const pt = parseCoordinate(s, last, dir);
    if (pt && Number.isFinite(pt.x) && (this.toolId !== 'select' || t.hot)) { this.vp.cursor = { x: pt.x, y: pt.y }; t.click({ x: pt.x, y: pt.y }); this.refreshPrompt(); this.vp.requestRender(); return; }
    toast(`Unknown command "${s}".`);
  }

  layerCommands() {
    const sel = () => [...this.vp.selection];
    const need = (f) => () => { if (!this.vp.selection.size) { toast('Select objects first, then run the command.'); return; } f(); };
    return {
      layiso: need(() => { this.isoSaved = layIsolate(this.session, sel()); toast('Layers isolated (LAYUNISO restores)', 2500); }),
      layuniso: () => { if (layUnisolate(this.session, this.isoSaved)) { this.isoSaved = null; toast('Layers restored', 1500); } else toast('Nothing isolated.'); },
      layfrz: need(() => { const n = layFreeze(this.session, sel()); this.vp.setSelection([]); toast(`Frozen: ${n.join(', ')}`, 2500); }),
      layon: () => layOn(this.session), laythw: () => layThaw(this.session),
    };
  }
  undo() { if (this.session.undo()) toast(`Undo`, 1200); }
  redo() { if (this.session.redo()) toast(`Redo`, 1200); }
  selectAll() { this.vp.setSelection(this.doc.entities.filter((e) => this.vp.index.bboxOf(e)).map((e) => e.id)); }
  deleteSelection() { if (this.vp.selection.size) { eraseEntities(this.session, [...this.vp.selection]); } }
  copySel() { this.clip = copyToClipboard(this.doc, [...this.vp.selection]); if (this.clip.length) toast(`${this.clip.length} object(s) copied`, 1500); }
  paste() {
    if (!this.clip.length) return;
    const k = this.vp.view.zoom;
    const made = pasteEntities(this.session, this.clip, 20 / k, -20 / k);
    this.vp.setSelection(made.map((e) => e.id));
  }

  // ---- new / open / save -------------------------------------------------------------------------
  /** asks to save a drawing with unsaved changes (shown first); false = the user cancelled */
  async confirmDiscard(tab = this.active) {
    if (!tab?.session.dirty) return true;
    if (tab !== this.active) this.switchTo(tab);
    const r = await confirmDialog('Unsaved changes', `Save changes to ${tab.file.name}?`, 'Save', "Don't save", 'Cancel');
    if (r === 'yes') return this.save();
    return r === 'no';
  }
  /** show a drawing in a new tab; a blank, untouched Untitled tab is replaced instead */
  installDoc(doc, file, { replaceBlank = false } = {}) {
    const tab = createDocState(doc, file);
    const blank = replaceBlank && isBlankTab(this.active) ? this.active : null;
    if (blank) this.tabs.splice(this.tabs.indexOf(blank), 1, tab); else this.tabs.push(tab);
    this.switchTo(tab, { fit: true });
  }
  /** bring a tab to the front: the shown tab keeps its view, selection and caches for when it comes back */
  switchTo(tab, { fit = false } = {}) {
    const cur = this.active;
    if (cur && cur !== tab && this.tabs.includes(cur)) {
      cur.view = { cx: this.vp.view.cx, cy: this.vp.view.cy, zoom: this.vp.view.zoom };
      cur.selection = [...this.vp.selection]; cur.lastPoint = this.vp.lastPoint;
      cur.scene = this.vp.scene; cur.index = this.vp.index;
    }
    if (cur !== tab && this.toolId) this.setTool(this.toolId === 'select' ? 'select' : this.toolId); // drop a half-done command
    this.active = tab;
    this.vp.setSession(tab.session, { fit: fit || !tab.view, view: fit ? null : tab.view, selection: tab.selection, scene: tab.scene, index: tab.index, lastPoint: tab.lastPoint });
    tab.scene = tab.index = null;
    this.refreshPanels(); this.refreshStatus(); this.updateTitle();
  }
  activateIndex(i) { if (this.tabs[i] && this.tabs[i] !== this.active) this.switchTo(this.tabs[i]); }
  cycleTab(step) { this.activateIndex(cycleIndex(this.tabs.length, this.tabs.indexOf(this.active), step)); }
  /** close a tab after the save prompt; closing the last tab leaves a new blank drawing. Returns false if cancelled. */
  async closeTab(tab = this.active) {
    if (!(await this.confirmDiscard(tab))) return false;
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    const next = indexAfterClose(this.tabs.length, i, this.tabs.indexOf(this.active));
    this.tabs.splice(i, 1);
    if (this.active === tab) this.active = null;
    if (next < 0) { this.newDrawing(); return true; }
    if (!this.active) this.switchTo(this.tabs[next]); else this.updateTitle();
    return true;
  }
  /** window close / quit: one save prompt per drawing with unsaved changes, then close */
  async closeAll() {
    for (const tab of this.tabs.filter((t) => t.session.dirty)) if (!(await this.confirmDiscard(tab))) return false;
    this.closeConfirmed = true;
    api.closeWindow?.();
    return true;
  }
  newDrawing() {
    const doc = newDocument(); doc.units = 4;
    const n = this.tabs.filter((t) => /^Drawing\d+\.dxf$/.test(t.file.name)).length;
    this.installDoc(doc, { path: null, name: this.tabs.length ? `Drawing${n + 1}.dxf` : 'Untitled.dxf', format: 'dxf' });
  }
  async open() {
    let files;
    try { files = await api.openFiles({ filters: OPEN_FILTERS, multiple: true }); } catch (err) { toast(`Could not open: ${err.message}`); return; }
    for (const f of files ?? []) await this.loadFile(f);
  }
  /** a file handed over by the desktop shell (double-click, "Open with", second launch): {path, name} without bytes */
  async openFromFile(f) {
    const open = findTabByPath(this.tabs, f.path);
    if (open) { this.switchTo(open); return; }
    try { if (!f.bytes) f = { ...f, bytes: await api.readFile(f.path) }; } catch (err) { await message('Cannot open this file', err.message || String(err)); return; }
    await this.loadFile(f);
  }
  async loadFile(f) {
    const open = findTabByPath(this.tabs, f.path);
    if (open) { this.switchTo(open); return; } // already open: show its tab
    toast(`Opening ${f.name} …`, 60000);
    try {
      const { doc, format, notes } = await loadDrawing(api, f.name, f.bytes);
      this.installDoc(doc, { path: f.path ?? null, name: f.name, format }, { replaceBlank: true });
      toast(`${f.name}: ${doc.entities.length.toLocaleString()} objects`, 2500);
      if (notes.length) await message('Opened with limitations', `${f.name} was opened, but:`, el('ul', {}, notes.map((n) => el('li', { text: n }))));
    } catch (err) {
      toast('', 1);
      await message('Cannot open this file', err.message || String(err));
    }
  }
  /** objects that were read but cannot be written back (they would vanish from an overwritten file) */
  droppedContent() {
    const sk = Object.entries(this.doc.skipped || {}).map(([k, v]) => `${v} ${k}`);
    const ps = this.doc.header?.paperSpaceEntities;
    if (ps) sk.push(`${ps} paper-space (layout) object(s)`);
    return sk;
  }
  async save() {
    if (this.file.format === 'dxf' && this.file.path) {
      const dropped = this.droppedContent();
      if (dropped.length) {
        const r = await modal('Overwrite the original file?', el('div', {},
          el('p', { text: `${this.file.name} contains objects this program cannot keep: ${dropped.join(', ')}.` }),
          el('p', { text: 'Overwriting the original would remove them from the file. Save a new copy instead to keep the original intact.' })),
        [{ label: 'Save as new file…', value: 'copy', primary: true }, { label: 'Overwrite original', value: 'over' }, { label: 'Cancel', value: null }]);
        if (r === 'copy') return this.saveAs('dxf');
        if (r !== 'over') return false;
      }
      return this.writeDxfTo(this.file.path);
    }
    return this.saveAs('dxf');
  }
  async writeDxfTo(path) {
    try {
      const r = await saveDxf(api, this.doc, { path, name: this.file.name });
      if (!r) return false;
      this.afterSave(r.path ?? path, 'dxf');
      this.writeReport(r.report);
      return true;
    } catch (err) { await message('Save failed', err.message || String(err)); return false; }
  }
  writeReport(rep) {
    if (rep?.skipped && Object.keys(rep.skipped).length) toast(`Saved. Not written: ${Object.entries(rep.skipped).map(([k, v]) => `${v} ${k}`).join(', ')}`, 6000);
    else toast('Saved', 1500);
  }
  afterSave(path, format, { clean = true } = {}) {
    this.file = { path, name: path ? path.replace(/^.*[\\/]/, '') : `${baseName(this.file.name)}.${format}`, format };
    if (clean) this.session.markSaved();
    this.updateTitle();
  }
  async saveAs(kind) {
    try {
      if (kind === 'dwg') {
        const ok = await confirmDialog('Save as DWG (experimental)',
          'DWG is written through the free LibreDWG converter. Text rotation and some hatch details can be lost, so the program re-reads the saved file and tells you if anything differs. DXF keeps everything this program supports. Save as DWG anyway?', 'Save as DWG', 'Cancel', null);
        if (ok !== 'yes') return false;
        const r = await saveDwg(api, this.doc, {
          name: this.file.name,
          confirmDifferences: async (v) => (await confirmDialog('The DWG does not match your drawing', `${verificationMessage(v)}\n\nSave this DWG anyway? (Your drawing stays open and unsaved, so you can still save it as DXF.)`, 'Save DWG anyway', 'Cancel', null)) === 'yes',
        });
        if (!r) return false;
        // a DWG that differs from the drawing is not a faithful save: keep the document marked as having unsaved changes
        this.afterSave(r.path, 'dwg', { clean: !!r.verification.ok });
        await message(r.verification.ok ? 'DWG saved' : 'DWG saved — please check', verificationMessage(r.verification));
        return true;
      }
      const r = await saveDxf(api, this.doc, { path: null, name: this.file.name });
      if (!r) return false;
      this.afterSave(r.path, 'dxf'); this.writeReport(r.report);
      return true;
    } catch (err) { await message('Save failed', err.message || String(err)); return false; }
  }

  // ---- exports ---------------------------------------------------------------------------------
  scene() { return buildScene(this.doc); }
  async saveBytes(bytes, ext, label) {
    const r = await api.saveFile({ defaultPath: `${baseName(this.file.name)}.${ext}`, filters: [{ name: label, extensions: [ext] }], bytes });
    if (r) toast(`Exported ${ext.toUpperCase()}`, 2000);
  }
  /** Plot to PDF (the Print dialog with a Save button) */
  exportPdf() { return plotDialog(this, 'pdf'); }
  print() { return plotDialog(this, 'print'); }
  async exportSvg() {
    try { await this.saveBytes(await exportSvgBytes(this.doc, this.scene(), {}), 'svg', 'SVG image'); } catch (err) { await message('Export failed', err.message || String(err)); }
  }
  async exportPng() {
    try { await this.saveBytes(await exportPngBytes(this.doc, this.scene(), { dark: this.vp.settings.dark, lineweights: this.vp.settings.lineweights }), 'png', 'PNG image'); } catch (err) { await message('Export failed', err.message || String(err)); }
  }

  // ---- help ---------------------------------------------------------------------------------------
  async about() {
    const v = await api.version().catch(() => '?');
    let dwg = 'not available in this browser preview';
    try { const a = await api.dwgAvailable(); dwg = a.available ? `LibreDWG ${a.version}` : `not available (${a.reason})`; } catch { /* ignore */ }
    await message('About ASH Draw Studio', `Version ${v}. Free drawing viewer and editor for DXF and DWG files.`, el('div', {},
      el('img', { class: 'brand-logo lt about-logo', src: 'assets/brand/ash-logo-horizontal.svg', alt: 'ASH Technical & Project Management Services' }),
      el('img', { class: 'brand-logo rev about-logo', src: 'assets/brand/ash-logo-horizontal-reversed.svg', alt: '' }),
      el('p', { text: 'Copyright © 2026 ASH Technical & Project Management Services (ASH PMCS). Released under the MIT licence.' }),
      el('p', { text: `DWG converter: ${dwg}. LibreDWG is free software under the GNU GPL v3 and runs as a separate program; its source is available from https://www.gnu.org/software/libredwg/ .` }),
      el('p', { text: 'Not affiliated with or endorsed by Autodesk. “AutoCAD”, “DWG” and “DXF” are trademarks of Autodesk, Inc. and are used only to describe file compatibility.' }),
      el('p', { class: 'about-tm', text: 'The ASH logo and icon are trademarks of ASH Technical & Project Management Services and are not covered by the MIT licence.' }),
      el('p', { text: 'Source code and licence notices: https://github.com/abbas437/ash-draw' })));
  }
  async limitations() {
    await message('What this program does and does not do', 'Please read before relying on it for important work:', el('ul', {},
      ['Only model space is shown and saved. Paper-space layouts are ignored.',
        'Supported objects: lines, polylines, circles, arcs, ellipses, splines, text, multiline text, points, solids, hatches, blocks, dimensions (as drawn) and leaders. Other objects (3D solids, regions, xlines, multileaders …) are skipped and reported when you open the file.',
        'Dimensions are displayed from their stored drawing, but cannot be edited as dimensions; they can be moved, copied or exploded.',
        'Saving as DXF is the reliable option. Saving as DWG is experimental and is checked after saving; text rotation and some hatches can be lost.',
        'Fonts: text is drawn with a system font, so widths differ slightly from the original CAD fonts.',
      ].map((t) => el('li', { text: t }))));
  }

  // ---- menus --------------------------------------------------------------------------------------
  buildMenus() {
    const vp = this.vp;
    const M = [
      ['File', [['New', 'Ctrl+N', () => this.newDrawing()], ['Open…', 'Ctrl+O', () => this.open()], ['Recent files…', '', () => this.sessionStore.showRecent().catch((err) => message('Could not open the file', err.message || String(err)))], ['Close', 'Ctrl+W', () => this.closeTab()], '-', ['Save', 'Ctrl+S', () => this.save()], ['Save as DXF…', '', () => this.saveAs('dxf')], ['Save as DWG… (experimental)', '', () => this.saveAs('dwg')], '-',
        ['Print…', 'Ctrl+P', () => this.print()], ['Plot to PDF…', '', () => this.exportPdf()], ['Export SVG…', '', () => this.exportSvg()], ['Export PNG image…', '', () => this.exportPng()]]],
      ['Edit', [['Undo', 'Ctrl+Z', () => this.undo()], ['Redo', 'Ctrl+Y', () => this.redo()], '-', ['Copy', 'Ctrl+C', () => this.copySel()], ['Paste', 'Ctrl+V', () => this.paste()], ['Delete', 'Del', () => this.deleteSelection()], '-', ['Select all', 'Ctrl+A', () => this.selectAll()], ['Find and replace…', 'Ctrl+F', () => this.find.open()]]],
      ['View', [['Zoom to fit', 'Z, E', () => vp.zoomExtents()], ['Zoom in', '', () => vp.zoomBy(1.4)], ['Zoom out', '', () => vp.zoomBy(1 / 1.4)], '-',
        ['Show lineweights', 'F9', () => this.toggle('lineweights')], ['Light / dark background', '', () => this.toggle('dark')], '-',
        ['Dark theme', '', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'), () => this.theme === 'dark']]],
      ['Help', [['What this program can and cannot do', '', () => this.limitations()], ['About', '', () => this.about()]]],
    ];
    const bar = document.getElementById('menubar');
    for (const [label, items] of M) {
      // an item's optional 4th element makes it a checkable item: () => checked
      const checks = [];
      const item = (it) => {
        const chk = it[3] ? el('span', { class: 'chk' }) : null;
        const b = el('button', { role: it[3] ? 'menuitemcheckbox' : null, onclick: () => { closeMenus(); it[2](); } }, el('span', {}, chk, it[0]), el('kbd', { text: it[1] }));
        if (chk) checks.push(() => { const on = !!it[3](); chk.textContent = on ? '\u2713' : ''; b.setAttribute('aria-checked', String(on)); });
        return b;
      };
      const menu = el('div', { class: 'menu' }, el('button', { onclick: (e) => { e.stopPropagation(); const open = menu.classList.contains('open'); closeMenus(); if (!open) { checks.forEach((f) => f()); menu.classList.add('open'); } } }, label),
        el('div', { class: 'drop' }, items.map((it) => (it === '-' ? el('hr') : item(it)))));
      bar.append(menu);
    }
    bar.append(el('span', { class: 'title', id: 'title' }));
    const closeMenus = () => document.querySelectorAll('#menubar .menu.open').forEach((m) => m.classList.remove('open'));
    document.addEventListener('click', closeMenus);
  }

  buildToolbar() {
    const box = document.getElementById('tools');
    for (const [group, items] of TOOL_BUTTONS) {
      box.append(el('div', { class: 'group', text: group }));
      for (const [id, label, alias, icon] of items) box.append(el('button', { 'data-tool': id, title: alias ? `${label} (${alias})` : label, onclick: () => this.setTool(id) }, icon ? toolIcon(icon) : null, label));
    }
    box.append(el('div', { class: 'group', text: 'Hatch' }));
    const pat = el('select', { title: 'Hatch pattern', onchange: (e) => { this.defaults.hatchPattern = e.target.value; } }, PATTERN_NAMES.map((n) => el('option', { value: n, text: n })));
    pat.value = this.defaults.hatchPattern;
    const sc = el('input', { type: 'number', step: 'any', min: '0', value: '1', title: 'Hatch scale', style: 'width:100%', onchange: (e) => { const v = Number(e.target.value); if (v > 0) this.defaults.hatchScale = v; } });
    box.append(pat, sc);
  }

  buildStatus() {
    const s = document.getElementById('status');
    const tog = (label, key, title) => { const b = el('button', { title, onclick: () => this.toggle(key) }, label); b.dataset.key = key; return b; };
    s.append(el('span', { class: 'coord', id: 'coord' }), tog('SNAP', 'snap', 'Object snap (F3)'), tog('ORTHO', 'ortho', 'Ortho (F8)'), tog('POLAR', 'polar', 'Polar tracking 45° (F10)'), tog('LWT', 'lineweights', 'Show lineweights (F9)'),
      el('span', { class: 'spacer' }), el('span', { id: 'sel' }), el('span', { id: 'units', style: 'margin-left:12px' }),
      el('button', { id: 'theme-btn', title: 'Dark theme (View menu)', onclick: () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark') }, 'DARK'));
    this.refreshToggles();
  }
  toggle(key) {
    const st = this.vp.settings;
    if (key === 'dark') { this.setCanvasDark(!st.dark); this.canvasOverride = st.dark !== (this.theme === 'dark'); return; }
    st[key] = !st[key];
    if (key === 'ortho' && st.ortho) st.polar = false;
    if (key === 'polar' && st.polar) st.ortho = false;
    this.refreshToggles(); this.vp.requestRender();
  }
  refreshToggles() {
    for (const b of document.querySelectorAll('#status button[data-key]')) b.classList.toggle('on', !!this.vp.settings[b.dataset.key]);
    document.getElementById('theme-btn')?.classList.toggle('on', this.theme === 'dark');
  }
  /** switch the UI theme; the drawing canvas follows it unless the user has overridden the canvas background */
  setTheme(theme, save = true) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    if (this.theme === 'dark') document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
    if (this.canvasOverride && this.vp.settings.dark === (this.theme === 'dark')) this.canvasOverride = false;
    if (!this.canvasOverride) this.setCanvasDark(this.theme === 'dark');
    this.refreshToggles();
    if (save) api.settingsSet?.('theme', this.theme)?.catch?.(() => {});
  }
  setCanvasDark(dark) {
    this.vp.settings.dark = dark;
    document.getElementById('stage').style.background = dark ? CANVAS_BG.dark : CANVAS_BG.light;
    this.vp.requestRender();
  }
  showCursor(p) { document.getElementById('coord').textContent = p ? `X ${p.x.toFixed(3)}   Y ${p.y.toFixed(3)}` : ''; }
  refreshStatus() {
    document.getElementById('sel').textContent = this.vp.selection.size ? `${this.vp.selection.size} selected` : `${this.doc.entities.length.toLocaleString()} objects`;
    document.getElementById('stage').classList.toggle('empty', this.doc.entities.length === 0);
    document.getElementById('units').textContent = `Units: ${UNIT_NAMES[this.doc.units] ?? this.doc.units}`;
  }
  updateTitle() {
    const t = `${this.session?.dirty ? '• ' : ''}${this.file.name}`;
    document.getElementById('title').textContent = t;
    api.setTitle?.(`${t} — ASH Draw Studio`);
    this.renderTabs();
    this.sessionStore.changed();
  }
  /** the file tab strip above the drawing area: name, unsaved-changes dot, close button; middle-click closes */
  renderTabs() {
    const bar = document.getElementById('tabbar');
    bar.replaceChildren(...this.tabs.map((t) => el('div', {
      class: `tab${t === this.active ? ' active' : ''}${t.session.dirty ? ' dirty' : ''}`, role: 'tab', 'aria-selected': String(t === this.active), title: t.file.path ?? t.file.name, 'data-tab': String(t.id),
      onclick: () => { if (this.active !== t) this.switchTo(t); },
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(t); } },
      onmousedown: (e) => { if (e.button === 1) e.preventDefault(); }, // no auto-scroll
    }, el('span', { class: 'dot', text: t.session.dirty ? '\u25CF' : '', title: t.session.dirty ? 'Unsaved changes' : '' }), el('span', { class: 'name', text: t.file.name }),
    el('button', { class: 'x', title: 'Close (Ctrl+W)', 'aria-label': `Close ${t.file.name}`, onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, '\u00D7'))));
  }

  // ---- keyboard / drop ------------------------------------------------------------------------------
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (document.getElementById('dlg').open) return;
      const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (ctrl) {
        if (e.key === 'Tab') { e.preventDefault(); this.cycleTab(e.shiftKey ? -1 : 1); return; }
        if (e.key === 'F4') { e.preventDefault(); this.closeTab(); return; }
        if (typing && !['s', 'o', 'n', 'w', 'f', 'p'].includes(k)) return;
        const map = { z: () => this.undo(), y: () => this.redo(), a: () => this.selectAll(), c: () => this.copySel(), v: () => this.paste(), s: () => this.save(), o: () => this.open(), n: () => this.newDrawing(), w: () => this.closeTab(), f: () => this.find.open(), p: () => this.print() };
        if (map[k]) { e.preventDefault(); map[k](); }
        return;
      }
      if (e.key === 'F3') { e.preventDefault(); this.toggle('snap'); return; }
      if (e.key === 'F8') { e.preventDefault(); this.toggle('ortho'); return; }
      if (e.key === 'F9') { e.preventDefault(); this.toggle('lineweights'); return; }
      if (e.key === 'F10') { e.preventDefault(); this.toggle('polar'); return; }
      if (typing) return;
      if (e.key === 'Escape') { e.preventDefault(); this.tool.key(e) || this.tool.cancel(); this.refreshPrompt(); return; }
      if (e.key === 'Enter') { e.preventDefault(); this.submit(''); return; }
      if (e.key === 'Delete' && this.toolId === 'select') { this.deleteSelection(); return; }
      if (e.key.length === 1 && !e.altKey) { this.cmd.focus(); } // start typing a command
    });
    // keep the prompt fresh after any pointer action
    document.getElementById('cv').addEventListener('pointerup', () => setTimeout(() => this.refreshPrompt(), 0));
  }
  bindDrop() {
    const stage = document.getElementById('stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
    stage.addEventListener('drop', async (e) => {
      e.preventDefault(); stage.classList.remove('dragover');
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (!['dwg', 'dxf'].includes(extOf(f.name))) { toast('Drop a DWG or DXF file.'); return; }
      await this.loadFile({ path: null, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    });
  }
}

window.app = new App();
