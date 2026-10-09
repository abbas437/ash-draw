// ASH Draw Studio - application controller: wires the viewport, tools, panels, menus and files together.
import { newDocument } from '../src/core/model.js';
import { eraseEntities, copyToClipboard, pasteEntities, setDrawingUnits } from '../src/core/edit.js';
import { INSUNITS, unitLabel, lengthPrecision, looksLikeMapMetres } from '../src/core/measure.js';
import { setShowLegs, refreshMeasureResults } from './tools-measure.js';
import { parseCoordinate } from '../src/core/coords.js';
import { PATTERN_NAMES } from '../src/core/patterns.js';
import { layIsolate, layUnisolate, layFreeze, layOn, layThaw } from '../src/core/layers.js';
import { Viewport, CANVAS_BG } from './viewport.js';
import { createDocState, findTabByPath, indexAfterClose, cycleIndex, isBlankTab } from './tabs.js';
import { createTools, TOOL_ALIASES } from './tools.js';
import { dimStyleManager, dimStyleNames, dimVarsOf, setCurrentDimStyle } from './tools-dims.js';
import { blockDoubleClick } from './tools-blocks.js';
import { initSession } from './session.js';
import { FindPanel } from './find.js';
import { plotDialog } from './plot.js';
import { initLayouts, restoreSpace, renderSpaceBar, layoutDoubleClick, exitMspace, renderVpScale } from './layouts-ui.js';
import { ComparePanel, runCompare } from './compare.js';
import { MarkupPanel, toggleMarkups, markupsShown } from './markup.js';
import { loadDrawingXrefs, xrefPanel } from './xref-panel.js';
import { TOOL_BUTTONS, buildToolPanel, iconButton, quickCommand, canvasDarkFrom, labelsFrom, placementFrom, PLACEMENTS, collapsedFrom, applyCollapsed, toolTitle } from './tool-panel.js';
import { iconSvg } from './icons.js';
import { defaultLayout, cleanLayout, panelGroups, samePanel, quickRow, setQuickRow, compactKeys, foldMode, SEP } from './tool-layout.js';
import { openCustomize, initToolContextMenu } from './tool-custom.js';
import { loadDrawingImages } from './images.js';
import { el, message, modal, confirmDialog, textDialog, toast, progressToast, renderLayers, renderProperties } from './ui.js';
import {
  OPEN_FILTERS, loadDrawing, saveDxf, saveDwg, verificationMessage, exportSvgBytes, exportPngBytes, buildScene, prepareView, baseName, extOf, UNIT_NAMES,
} from './files.js';

const api = window.api;

class App {
  constructor() {
    this.tabs = [];              // open drawings (file tabs); see tabs.js createDocState
    this.active = null;          // the tab shown
    this.defaults = { textHeight: null, hatchPattern: 'ANSI31', hatchScale: 1, hatchAngle: 0 };
    this.clip = [];
    this.lastTool = 'line';
    this.theme = 'light';        // UI theme; light by default, the choice is saved as setting 'theme'
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
    initLayouts(this);
    this.comparePanel = new ComparePanel(this);
    this.markupPanel = new MarkupPanel(this);
    this.cmd = document.getElementById('cmd');
    this.cmd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const v = this.cmd.value; this.cmd.value = ''; this.vp.canvas.focus(); this.submit(v); }
      else if (e.key === 'Escape') { this.cmd.value = ''; this.cmd.blur(); this.vp.canvas.focus(); this.tool?.key({ key: 'Escape' }); }
      else if (e.key === ' ' && !this.cmd.value.trim() && this.tool?.key?.({ key: ' ' })) { e.preventDefault(); this.cmd.value = ''; this.refreshPrompt(); } // Space = Enter (grip modes)
      e.stopPropagation();
    });
    document.getElementById('z-in').onclick = () => this.vp.zoomBy(1.4);
    document.getElementById('z-out').onclick = () => this.vp.zoomBy(1 / 1.4);
    document.getElementById('z-fit').onclick = () => this.vp.zoomExtents();
    this.vp.on('selection', () => { this.refreshPanels(true); this.refreshStatus(); });
    this.vp.on('change', () => { this.refreshPanels(); this.refreshStatus(); this.updateTitle(); this.refreshDimStyles(); });
    this.vp.on('cursor', (p) => this.showCursor(p));
    this.vp.canvas.addEventListener('dblclick', (e) => { if (this.toolId === 'select' && !layoutDoubleClick(this, e)) blockDoubleClick(this, e); });
    window.addEventListener('beforeunload', (e) => { if (!this.closeConfirmed && this.tabs.some((t) => t.session.dirty)) { e.preventDefault(); e.returnValue = ''; } });
    api.onCloseRequest?.(() => this.closeAll());
    this.newDrawing();
    this.setTool('select');
    this.setTheme('light', false);
    this.setCanvasDark(true); // model space is dark whatever the UI theme (View > Model space background)
    this.panelOpts = { labels: false, colours: true };
    this.setToolPlacement('left', false);
    this.setToolPanel('labels', false, false); // compact icon grid by default
    api.settingsGet?.('tools.labels').then((v) => this.setToolPanel('labels', labelsFrom(v), false)).catch(() => {});
    api.settingsGet?.('tools.placement').then((v) => this.setToolPlacement(placementFrom(v), false)).catch(() => {});
    api.settingsGet?.('tools.colours').then((v) => { if (v === false) this.setToolPanel('colours', false, false); }).catch(() => {});
    api.settingsGet?.('canvas.transparency').then((v) => { if (v === false) { this.vp.settings.transparency = false; this.refreshToggles(); this.vp.requestRender(); } }).catch(() => {});
    api.settingsGet?.('canvas.background').then((v) => this.setCanvasDark(canvasDarkFrom(v))).catch(() => {});
    api.settingsGet?.('tools.collapsed').then((v) => { this.collapsed = collapsedFrom(v); applyCollapsed(document.getElementById('tools'), this.collapsed); }).catch(() => {});
    api.settingsGet?.('tools.layout').then((v) => { if (v != null) this.setToolLayout(cleanLayout(v), false); }).catch(() => {});
    api.settingsGet?.('theme').then((t) => { if (t === 'dark') this.setTheme('dark', false); }).catch(() => {});
    api.settingsGet?.('measure.showLegs').then((v) => setShowLegs(v)).catch(() => {});
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
  /** the whole drawing (model space and layouts) whichever space is shown - for save and export */
  get fileDoc() { return this.active.doc; }
  get tool() { return this.tools[this.toolId]; }
  newProps() { return { layer: this.state.layer, color: this.state.color, linetype: this.state.linetype, lineweight: this.state.lineweight, alpha: this.state.alpha }; }
  toast(t, ms) { toast(t, ms); }
  askText(o) { return textDialog(o); }
  refreshPrompt() { document.getElementById('prompt').textContent = this.tool?.prompt ?? ''; }
  refreshPanels(selectionOnly = false) {
    if (!selectionOnly) renderLayers(this);
    renderProperties(this);
  }

  setTool(id) {
    this.vp.preview = null;
    if (this.toolId && this.tool) this.tool.deactivate(); // may leave a preview behind (Measure keeps its markers)
    const kept = id === 'select' ? this.vp.preview : null; // back to Select: the markers stay beside its own preview
    if (id !== 'select') this.lastTool = id;
    this.toolId = id;
    this.vp.tool = this.tool;
    this.tool.activate();
    if (kept) { const own = this.vp.preview; this.vp.preview = (c, v, vp) => { kept(c, v, vp); own?.(c, v, vp); }; }
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
      if (this.toolId === 'select' && !t.hot) this.setTool(this.lastTool); else t.key({ key: 'Enter' });
      this.refreshPrompt(); return;
    }
    if (t.text?.(s)) { this.refreshPrompt(); return; }
    const low = s.toLowerCase();
    if (TOOL_ALIASES[low]) { this.setTool(TOOL_ALIASES[low]); return; }
    const sys = { u: () => this.undo(), undo: () => this.undo(), redo: () => this.redo(), ze: () => this.vp.zoomExtents(), z: () => this.vp.zoomExtents(), 'zoom': () => this.vp.zoomExtents(), all: () => this.selectAll(), new: () => this.newDrawing(), open: () => this.open(), save: () => this.save(), saveas: () => this.saveAs('dxf'), pdf: () => this.exportPdf(), plot: () => this.print(), print: () => this.print(), find: () => this.find.open(), compare: () => this.compare(), d: () => this.dimStyles(), dimstyle: () => this.dimStyles(), ddim: () => this.dimStyles(), units: () => this.unitsDialog(), un: () => this.unitsDialog(), ddunits: () => this.unitsDialog(), xref: () => xrefPanel(this), xr: () => xrefPanel(this), ...this.layerCommands(), ...this.layoutCommands };
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
  /** prepared: {scene, index} built ahead (prepareView) so showing the tab does no long synchronous work */
  installDoc(doc, file, { replaceBlank = false, prepared = null } = {}) {
    const tab = createDocState(doc, file);
    if (prepared) { tab.scene = prepared.scene; tab.index = prepared.index; }
    const blank = replaceBlank && isBlankTab(this.active) ? this.active : null;
    if (blank) this.tabs.splice(this.tabs.indexOf(blank), 1, tab); else this.tabs.push(tab);
    this.switchTo(tab, { fit: true });
  }
  /** bring a tab to the front: the shown tab keeps its view, selection and caches for when it comes back */
  switchTo(tab, { fit = false } = {}) {
    const cur = this.active;
    if (cur && cur !== tab) exitMspace(this);
    if (cur && cur !== tab && this.tabs.includes(cur)) {
      cur.view = { cx: this.vp.view.cx, cy: this.vp.view.cy, zoom: this.vp.view.zoom };
      cur.selection = [...this.vp.selection]; cur.lastPoint = this.vp.lastPoint;
      cur.scene = this.vp.scene; cur.index = this.vp.index;
    }
    if (cur !== tab && this.toolId) this.setTool(this.toolId === 'select' ? 'select' : this.toolId); // drop a half-done command
    this.active = tab;
    restoreSpace(this, tab);
    this.vp.setSession(tab.session, { fit: fit || !tab.view, view: fit ? null : tab.view, selection: tab.selection, scene: tab.scene, index: tab.index, lastPoint: tab.lastPoint });
    tab.scene = tab.index = null;
    renderSpaceBar(this);
    this.refreshPanels(); this.refreshStatus(); this.updateTitle(); this.refreshDimStyles();
    this.comparePanel?.sync();
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
    // a DWG is read and converted by main (dwg:open), not passed through this thread
    try { if (!f.bytes && extOf(f.path) !== 'dwg') f = { ...f, bytes: await api.readFile(f.path) }; } catch (err) { await message('Cannot open this file', err.message || String(err)); return; }
    await this.loadFile(f);
  }
  async loadFile(f) {
    const open = findTabByPath(this.tabs, f.path);
    if (open) { this.switchTo(open); return; } // already open: show its tab
    const ac = new AbortController();
    const pt = progressToast('Reading…', () => ac.abort());
    this.vp.setBusy(true); // the system wait cursor over the canvas until the drawing is shown (no hidden pointer)
    try {
      const { doc, format, notes, warnings } = await loadDrawing(api, f.name, f.bytes, { onProgress: (x) => pt.set(x), signal: ac.signal, path: f.path ?? null });
      toast(`Opening ${f.name} …`, 60000); // read: now the view is built
      await loadDrawingXrefs(api, doc, f.path ?? null); // before the scene is built: it is built once, with the xrefs
      const missing = await loadDrawingImages(api, doc, f.path ?? null);
      if (missing.length) notes.push(`Raster images not found (shown as a red frame with the file name): ${missing.join(', ')}.`);
      const pp = progressToast('Preparing drawing…', () => ac.abort());
      const prepared = await prepareView(doc, { signal: ac.signal, onProgress: (x) => pp.set(x) });
      this.installDoc(doc, { path: f.path ?? null, name: f.name, format }, { replaceBlank: true, prepared });
      toast(`${f.name}: ${doc.entities.length.toLocaleString()} objects`, 2500);
      this.unitsHint(doc);
      if (notes.length) await message('Opened with limitations', `${f.name} was opened, but:`, el('div', {}, [el('ul', {}, notes.map((n) => el('li', { text: n }))), ...(warnings?.length ? [el('details', {}, [el('summary', { text: 'Converter messages' }), el('pre', { text: warnings.join('\n') })])] : [])]));
    } catch (err) {
      toast('', 1);
      if (err.code === 'CANCELLED') { toast(`Opening ${f.name} was cancelled.`, 2500); return; }
      if (err.odaHint) {
        const [text, detail] = String(err.message).split(/ \[(?=[^[]*\]$)/);
        const r = await modal('Cannot open this file', [el('p', { text }), detail ? el('details', {}, [el('summary', { text: 'Converter messages' }), el('pre', { text: detail.replace(/\]$/, '') })]) : null],
          [{ label: 'Open download page', value: 'dl', primary: true }, { label: 'OK', value: null }]);
        if (r === 'dl') api.openOdaDownload?.().catch(() => {});
      } else await message('Cannot open this file', err.message || String(err));
    } finally { this.vp.setBusy(false); }
  }
  /** Format > Units… (UNITS): how lengths are labelled - drawing units ($INSUNITS) and precision ($LUPREC) - as one
   *  undoable change of the whole drawing. `preset` preselects a unit (the map-grid hint offers Metres). */
  async unitsDialog(preset = null) {
    const doc = this.fileDoc;
    const units = el('select', { id: 'units-select' }, INSUNITS.map(([c, name, l]) => el('option', { value: String(c), text: l ? `${name} (${l})` : name })));
    units.value = String(preset ?? doc.units ?? 0);
    const prec = el('select', { id: 'units-precision' }, Array.from({ length: 9 }, (_, n) => el('option', { value: String(n), text: n ? (0).toFixed(n) : '0' })));
    prec.value = String(lengthPrecision(doc.header?.luprec));
    const row = (label, input) => el('label', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin:6px 0' }, label, input);
    const r = await modal('Drawing units', el('div', {},
      row('Drawing units', units), row('Precision', prec),
      el('p', { style: 'color:var(--dim);margin:8px 0 0', text: 'Changes how lengths are labelled; it does not scale the drawing.' })),
    [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
    if (r !== 'ok') return false;
    document.getElementById('units-hint')?.remove();
    const changed = setDrawingUnits(this.session, { units: Number(units.value), luprec: Number(prec.value) }, doc);
    this.refreshStatus();
    return changed;
  }
  /** a drawing that says millimetres but sits at map / survey grid coordinates in metres: offer the Units dialog
   *  (non-blocking, nothing is changed without the user) */
  unitsHint(doc) {
    document.getElementById('units-hint')?.remove();
    const h = doc.header ?? {};
    const ext = h.extmin && h.extmax && Math.abs(h.extmin.x) < 1e19 && h.extmax.x >= h.extmin.x
      ? { minx: h.extmin.x, miny: h.extmin.y, maxx: h.extmax.x, maxy: h.extmax.y } : this.vp.layout ? null : this.vp.scene?.bbox; // no extra pass over the objects
    if (!looksLikeMapMetres(doc.units, ext)) return false;
    const tab = this.active;
    const box = el('div', { id: 'units-hint', role: 'status' },
      el('span', { text: 'This drawing says millimetres, but its coordinates look like metres (map/survey grid).' }),
      el('button', { id: 'units-hint-open', onclick: () => { box.remove(); if (this.active === tab) this.unitsDialog(6); } }, 'Units…'),
      el('button', { title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => box.remove() }, '×'));
    document.getElementById('stage').append(box);
    return true;
  }
  /** objects that were read but cannot be written back (they would vanish from an overwritten file) */
  droppedContent() {
    const sk = Object.entries(this.doc.skipped || {}).map(([k, v]) => `${v} ${k}`);
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
      const r = await saveDxf(api, this.fileDoc, { path, name: this.file.name });
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
        const r = await saveDwg(api, this.fileDoc, {
          name: this.file.name,
          confirmDifferences: async (v) => (await confirmDialog('The DWG does not match your drawing', `${verificationMessage(v)}\n\nSave this DWG anyway? (Your drawing stays open and unsaved, so you can still save it as DXF.)`, 'Save DWG anyway', 'Cancel', null)) === 'yes',
        });
        if (!r) return false;
        // a DWG that differs from the drawing is not a faithful save: keep the document marked as having unsaved changes
        this.afterSave(r.path, 'dwg', { clean: !!r.verification.ok });
        await message(r.verification.ok ? 'DWG saved' : 'DWG saved — please check', verificationMessage(r.verification));
        return true;
      }
      const r = await saveDxf(api, this.fileDoc, { path: null, name: this.file.name });
      if (!r) return false;
      this.afterSave(r.path, 'dxf'); this.writeReport(r.report);
      return true;
    } catch (err) { await message('Save failed', err.message || String(err)); return false; }
  }

  // ---- exports ---------------------------------------------------------------------------------
  scene() { return buildScene(this.fileDoc); }
  async saveBytes(bytes, ext, label) {
    const r = await api.saveFile({ defaultPath: `${baseName(this.file.name)}.${ext}`, filters: [{ name: label, extensions: [ext] }], bytes });
    if (r) toast(`Exported ${ext.toUpperCase()}`, 2000);
  }
  /** Plot to PDF (the Print dialog with a Save button) */
  exportPdf() { return plotDialog(this, 'pdf'); }
  print() { return plotDialog(this, 'print'); }
  /** File > Compare… (COMPARE): differences between two drawings, shown in a new tab */
  compare() { return runCompare(this).catch((err) => message('Compare failed', err.message || String(err))); }
  async exportSvg() {
    try { await this.saveBytes(await exportSvgBytes(this.fileDoc, this.scene(), {}), 'svg', 'SVG image'); } catch (err) { await message('Export failed', err.message || String(err)); }
  }
  async exportPng() {
    try { await this.saveBytes(await exportPngBytes(this.fileDoc, this.scene(), { dark: this.vp.settings.dark, lineweights: this.vp.settings.lineweights }), 'png', 'PNG image'); } catch (err) { await message('Export failed', err.message || String(err)); }
  }

  // ---- help ---------------------------------------------------------------------------------------
  async about() {
    const v = await api.version().catch(() => '?');
    let dwg = 'not available in this browser preview';
    try { const a = await api.dwgAvailable(); dwg = a.available ? `${a.version}${a.mode === 'auto' ? ' (automatic)' : ''}` : `not available (${a.reason})`; } catch { /* ignore */ }
    await message('About ASH Draw Studio', `Version ${v}. Free drawing viewer and editor for DXF and DWG files.`, el('div', {},
      el('img', { class: 'brand-logo lt about-logo', src: 'assets/brand/ash-logo-horizontal.svg', alt: 'ASH Technical & Project Management Services' }),
      el('img', { class: 'brand-logo rev about-logo', src: 'assets/brand/ash-logo-horizontal-reversed.svg', alt: '' }),
      el('p', { text: 'Copyright © 2026 ASH Technical & Project Management Services (ASH PMCS). Released under the MIT licence.' }),
      el('p', { text: `DWG converter: ${dwg}. LibreDWG is free software under the GNU GPL v3 and runs as a separate program; its source is available from https://www.gnu.org/software/libredwg/ . The ODA File Converter, when installed by you, is a separate free program from the Open Design Alliance.` }),
      el('p', { text: 'Not affiliated with or endorsed by Autodesk. “AutoCAD”, “DWG” and “DXF” are trademarks of Autodesk, Inc. and are used only to describe file compatibility.' }),
      el('p', { class: 'about-tm', text: 'The ASH logo and icon are trademarks of ASH Technical & Project Management Services and are not covered by the MIT licence.' }),
      el('p', { text: 'Source code and licence notices: https://github.com/abbas437/ash-draw' })));
  }
  /** Edit > Preferences…: the DWG converter (Automatic / ODA File Converter / Built-in LibreDWG) and the ODA path */
  async preferences() {
    if (!api.dwgConfig) { await message('Preferences', 'The DWG converter settings need the desktop app.'); return; }
    const cfg = await api.dwgConfig();
    const av = await api.dwgAvailable().catch(() => null);
    const mode = el('select', { id: 'pref-dwg-mode' }, [['auto', 'Automatic (ODA if installed, else built-in LibreDWG)'], ['oda', 'ODA File Converter'], ['libredwg', 'Built-in (LibreDWG)']].map(([v, t]) => el('option', { value: v, text: t })));
    mode.value = cfg.mode;
    const odaPath = el('input', { id: 'pref-oda-path', type: 'text', value: cfg.odaPath, placeholder: av?.oda?.source === 'auto' ? av.oda.path : 'Detected automatically in C:\\Program Files\\ODA', style: 'width:100%' });
    const browse = el('button', { type: 'button', text: 'Browse…', onclick: async () => { const p = await api.dwgBrowseOda(); if (p) odaPath.value = p; } });
    const status = av ? `In use: ${av.available ? av.version : `none (${av.reason})`}. ODA File Converter: ${av.oda?.available ? `${av.oda.version} at ${av.oda.path}` : av.oda?.reason ?? 'not installed'}.` : '';
    const r = await modal('Preferences', el('div', {},
      el('label', { text: 'DWG converter ' }, mode),
      el('p', {}, el('label', { text: 'ODA File Converter (ODAFileConverter.exe), leave empty to detect it: ' }), odaPath, browse),
      el('p', { id: 'pref-dwg-status', text: status })),
    [{ label: 'Save', value: 'save', primary: true }, { label: 'Cancel', value: null }]);
    if (r !== 'save') return;
    try { await api.dwgSetConfig({ mode: mode.value, odaPath: odaPath.value.trim() }); toast('Preferences saved', 2000); } catch (err) { await message('Preferences not saved', String(err.message || err).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '')); }
  }
  async limitations() {
    await message('What this program does and does not do', 'Please read before relying on it for important work:', el('ul', {},
      ['Paper-space layouts, their objects and viewports are read and saved back; viewport clip boundaries other than the rectangle are not kept.',
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
      ['File', [['New', 'Ctrl+N', () => this.newDrawing()], ['Open…', 'Ctrl+O', () => this.open()], ['Recent files…', '', () => this.sessionStore.showRecent().catch((err) => message('Could not open the file', err.message || String(err)))], ['Close', 'Ctrl+W', () => this.closeTab()], '-', ['Compare…', 'COMPARE', () => this.compare()], '-', ['Save', 'Ctrl+S', () => this.save()], ['Save as DXF…', '', () => this.saveAs('dxf')], ['Save as DWG… (experimental)', '', () => this.saveAs('dwg')], '-',
        ['Print…', 'Ctrl+P', () => this.print()], ['Plot to PDF…', '', () => this.exportPdf()], ['Export SVG…', '', () => this.exportSvg()], ['Export PNG image…', '', () => this.exportPng()]]],
      ['Edit', [['Undo', 'Ctrl+Z', () => this.undo()], ['Redo', 'Ctrl+Y', () => this.redo()], '-', ['Copy', 'Ctrl+C', () => this.copySel()], ['Paste', 'Ctrl+V', () => this.paste()], ['Delete', 'Del', () => this.deleteSelection()], '-', ['Select all', 'Ctrl+A', () => this.selectAll()], ['Find and replace…', 'Ctrl+F', () => this.find.open()], '-', ['Preferences…', '', () => this.preferences()]]],
      ['View', [['Zoom to fit', 'Z, E', () => vp.zoomExtents()], ['Zoom in', '', () => vp.zoomBy(1.4)], ['Zoom out', '', () => vp.zoomBy(1 / 1.4)], '-',
        ['Show lineweights', 'F9', () => this.toggle('lineweights')], ['Model space background: dark', '', () => this.toggle('dark'), () => this.vp.settings.dark], '-',
        ['Dark theme', '', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'), () => this.theme === 'dark'],
        ...PLACEMENTS.map((p) => [`Tool panel: ${p[0].toUpperCase()}${p.slice(1)}`, '', () => this.setToolPlacement(p), () => this.toolPlacement === p]),
        ['Tool labels', '', () => this.setToolPanel('labels', !this.panelOpts.labels), () => this.panelOpts.labels],
        ['Tool group colours', '', () => this.setToolPanel('colours', !this.panelOpts.colours), () => this.panelOpts.colours],
        ['Tools: Compact', '', () => this.setFolded(compactKeys()), () => foldMode(this.collapsed) === 'compact'],
        ['Tools: Expanded', '', () => this.setFolded([]), () => foldMode(this.collapsed) === 'expanded'],
        ['Customize tools…', '', () => openCustomize(this)],
        ['Quick Access row', '', () => this.setToolLayout(setQuickRow(this.toolLayout, !this.toolLayout.quickRow)), () => this.toolLayout.quickRow], '-',
        ['Show markups', '', () => toggleMarkups(this), () => markupsShown(this.doc)], '-',
        ['External references…', 'XREF', () => xrefPanel(this)]]],
      ['Format', [['Units…', 'UNITS', () => this.unitsDialog()]]],
      ['Dimension', [...TOOL_BUTTONS.find(([g]) => g === 'Dimension')[2].map(([id, label, alias]) => [label, alias, () => this.setTool(id)]), '-', ['Dimension style…', 'D', () => this.dimStyles()]]],
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

  /** fill the toolbar's dimension-style list from the active drawing (only when it changed) */
  refreshDimStyles() {
    const sel = this.dimStyleSel; if (!sel || !this.doc) return;
    const names = dimStyleNames(this.doc), cur = dimVarsOf(this.doc).style;
    if (sel.dataset.names !== names.join('\n')) { sel.replaceChildren(...names.map((n) => el('option', { value: n, text: n }))); sel.dataset.names = names.join('\n'); }
    sel.value = names.find((n) => n.toLowerCase() === cur.toLowerCase()) ?? cur;
  }
  async dimStyles() { await dimStyleManager(this); this.refreshDimStyles(); }

  buildToolbar() {
    const box = document.getElementById('tools');
    this.collapsed = [];
    this.toolLayout = defaultLayout();
    box.append(el('div', { class: 'lbl-toggle', role: 'button', tabindex: '0', id: 'tool-labels-btn', title: 'Show or hide tool labels (View > Tool labels)', text: 'Aa', onclick: () => this.setToolPanel('labels', !this.panelOpts.labels) }));
    this.renderToolPanel();
    this.buildQuickAccess();
    // Order is load-bearing: buildToolbar() runs before bindKeys(), so this document keydown listener is registered first and its
    // stopImmediatePropagation on Shift+F10 / the menu key keeps bindKeys' plain F10 (Polar) from also firing. Do not move bindKeys() above it.
    initToolContextMenu(this);
    const pat = el('select', { title: 'Hatch pattern', onchange: (e) => { this.defaults.hatchPattern = e.target.value; } }, PATTERN_NAMES.map((n) => el('option', { value: n, text: n })));
    pat.value = this.defaults.hatchPattern;
    const sc = el('input', { type: 'number', step: 'any', min: '0', value: '1', title: 'Hatch scale', style: 'width:100%', onchange: (e) => { const v = Number(e.target.value); if (v > 0) this.defaults.hatchScale = v; } });
    box.append(el('div', { class: 'tgroup' }, el('div', { class: 'group g-draw', text: 'Hatch' }), pat, sc));
    for (const [id, icon] of [['z-in', 'zoomin'], ['z-out', 'zoomout'], ['z-fit', 'zoomfit']]) { const b = document.getElementById(id); b.setAttribute('aria-label', b.title); b.replaceChildren(iconSvg(icon, 18)); }
  }
  /** (re)build the tool panel's groups from the customized layout (View > Customize tools…), before the Hatch group */
  renderToolPanel() {
    const box = document.getElementById('tools');
    for (const g of box.querySelectorAll('.tgroup[data-group]')) g.remove();
    const frag = document.createDocumentFragment();
    buildToolPanel(frag, el, (id) => this.setTool(id), (group, body) => {
      if (group !== 'Dimension') return;
      this.dimStyleSel = el('select', { id: 'dimstyle', title: 'Current dimension style (DIMSTYLE)', onchange: (e) => setCurrentDimStyle(this.doc, e.target.value) });
      body.append(this.dimStyleSel, iconButton(el, 'dimstyle', 'Dim styles…', { class: 'g-annotate', title: 'Dimension Style Manager (D)', onclick: () => this.dimStyles() }));
    }, (key, folded) => {
      this.collapsed = folded ? [...new Set([...this.collapsed, key])] : this.collapsed.filter((k) => k !== key);
      api.settingsSet?.('tools.collapsed', this.collapsed)?.catch?.(() => {});
    }, panelGroups(this.toolLayout));
    box.querySelector('.lbl-toggle').after(frag);
    applyCollapsed(box, this.collapsed);
    for (const b of box.querySelectorAll('button[data-tool]')) b.classList.toggle('active', b.dataset.tool === this.toolId);
    this.refreshDimStyles();
  }
  /** the Quick Access row under the menu bar: the chosen commands as icon buttons, coloured by group */
  buildQuickAccess() {
    document.getElementById('menubar').after(el('div', { id: 'qat', role: 'toolbar', 'aria-label': 'Quick Access' }));
    this.renderQuickAccess();
  }
  renderQuickAccess() {
    const run = { new: () => this.newDrawing(), open: () => this.open(), save: () => this.save(), undo: () => this.undo(), redo: () => this.redo(), zoomfit: () => this.vp.zoomExtents(), layers: () => document.getElementById('app').classList.toggle('no-side') };
    document.getElementById('qat').replaceChildren(...quickRow(this.toolLayout).map((it) => {
      if (it === SEP) return el('span', { class: 'sep' });
      const [key, id] = it, [label, alias] = quickCommand(id);
      return el('button', { class: `g-${key}`, 'data-cmd': id, title: toolTitle(label, alias), 'aria-label': label, onclick: () => (run[id] ? run[id]() : this.setTool(id)) }, iconSvg(id, 18));
    }));
    document.getElementById('app').classList.toggle('no-qat', !this.toolLayout.quickRow);
  }
  /** a selector for the tool panel button or group header that has the focus (null elsewhere), to find its equivalent after a re-render */
  focusToken() {
    const a = document.activeElement;
    if (!a?.closest?.('#tools')) return null;
    if (a.dataset.tool) return `#tools button[data-tool="${CSS.escape(a.dataset.tool)}"]`;
    if (a.dataset.head) return `#tools [data-head="${CSS.escape(a.dataset.head)}"]`;
    return null;
  }
  /** focus the equivalent of a focusToken() element after the panel was rebuilt; its tool may be hidden now: then the first shown panel button, else the drawing */
  restoreFocus(token) {
    if (!token) return;
    const shown = (n) => n && n.getClientRects().length;
    const n = document.querySelector(token);
    const to = shown(n) ? n : [...document.querySelectorAll('#tools button[data-tool]')].find(shown);
    (to ?? this.vp.canvas).focus();
  }
  /** apply a tool panel / Quick Access layout (tool-layout.js), saved as setting 'tools.layout' */
  setToolLayout(layout, save = true) {
    const panelChanged = !samePanel(this.toolLayout, layout);
    this.toolLayout = layout;
    if (panelChanged) { const at = this.focusToken(); this.renderToolPanel(); this.restoreFocus(at); } // a Quick Access-only edit leaves the panel (and its focus) alone
    this.renderQuickAccess();
    if (save) api.settingsSet?.('tools.layout', layout)?.catch?.(() => {});
  }
  /** View > Tools: Compact / Expanded - the folded groups, saved as 'tools.collapsed' */
  setFolded(keys) {
    this.collapsed = [...keys];
    applyCollapsed(document.getElementById('tools'), this.collapsed);
    api.settingsSet?.('tools.collapsed', this.collapsed)?.catch?.(() => {});
  }
  /** View > Tool labels / Tool group colours: classes on the panel, saved as settings 'tools.labels' and 'tools.colours' */
  setToolPanel(opt, on, save = true) {
    this.panelOpts = { labels: true, colours: true, ...this.panelOpts, [opt]: !!on };
    document.getElementById('app').classList.toggle('no-tool-labels', !this.panelOpts.labels);
    document.getElementById('tools').classList.toggle('no-colours', !this.panelOpts.colours);
    if (save) api.settingsSet?.(`tools.${opt}`, !!on)?.catch?.(() => {});
  }

  /** View > Tool panel: 'left' (column), 'top' (band above the canvas) or 'hidden'; a class on #app, saved as 'tools.placement' */
  setToolPlacement(place, save = true) {
    this.toolPlacement = place = placementFrom(place);
    const app = document.getElementById('app');
    for (const p of PLACEMENTS) app.classList.toggle(`tools-${p}`, p === place);
    if (save) api.settingsSet?.('tools.placement', place)?.catch?.(() => {});
  }

  buildStatus() {
    const s = document.getElementById('status');
    const tog = (label, key, title) => { const b = el('button', { title, onclick: () => this.toggle(key) }, label); b.dataset.key = key; return b; };
    s.append(el('span', { class: 'coord', id: 'coord' }), tog('SNAP', 'snap', 'Object snap (F3)'), tog('ORTHO', 'ortho', 'Ortho (F8)'), tog('POLAR', 'polar', 'Polar tracking 45° (F10)'), tog('LWT', 'lineweights', 'Show lineweights (F9)'), tog('TPY', 'transparency', 'Show transparency'),
      el('span', { class: 'spacer' }), el('span', { id: 'sel' }), el('span', { id: 'units', style: 'margin-left:12px', role: 'button', tabindex: '0', title: 'Drawing units (Format > Units…)', onclick: () => this.unitsDialog(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.unitsDialog(); } } }),
      el('button', { id: 'theme-btn', title: 'Dark theme (View menu)', onclick: () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark') }, 'DARK'));
    this.refreshToggles();
  }
  toggle(key) {
    const st = this.vp.settings;
    if (key === 'dark') { this.setCanvasDark(!st.dark); api.settingsSet?.('canvas.background', st.dark ? 'dark' : 'light')?.catch?.(() => {}); return; }
    st[key] = !st[key];
    if (key === 'transparency') api.settingsSet?.('canvas.transparency', st[key])?.catch?.(() => {});
    if (key === 'ortho' && st.ortho) st.polar = false;
    if (key === 'polar' && st.polar) st.ortho = false;
    this.refreshToggles(); this.vp.requestRender();
  }
  refreshToggles() {
    for (const b of document.querySelectorAll('#status button[data-key]')) b.classList.toggle('on', !!this.vp.settings[b.dataset.key]);
    document.getElementById('theme-btn')?.classList.toggle('on', this.theme === 'dark');
  }
  /** switch the UI theme; the model space background is a separate setting (dark by default) */
  setTheme(theme, save = true) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    if (this.theme === 'dark') document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
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
    const u = (this.active?.doc ?? this.doc).units;
    document.getElementById('units').textContent = `Units: ${UNIT_NAMES[u] ?? (unitLabel(u) || u)}`;
    refreshMeasureResults();
    renderVpScale(this);
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
      if (e.key === ' ' && this.tool.key?.(e)) { e.preventDefault(); this.refreshPrompt(); return; } // Space = Enter where a tool takes it (grip modes)
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
