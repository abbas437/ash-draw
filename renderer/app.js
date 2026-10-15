// ASH Draw Studio - application controller: wires the viewport, tools, panels, menus and files together.
import { newDocument } from '../src/core/model.js';
import { eraseEntities, setDrawingUnits } from '../src/core/edit.js';
import { copyClip, pasteClip } from './clipboard-ui.js';
import { INSUNITS, unitLabel, lengthPrecision, looksLikeMapMetres } from '../src/core/measure.js';
import { setShowLegs, refreshMeasureResults, clearMeasureResults } from './tools-measure.js';
import { parseCoordinate } from '../src/core/coords.js';
import { PATTERN_NAMES } from '../src/core/patterns.js';
import { loadPatFile, patternsDialog, loadSavedPatterns, refreshPatternSelect } from './patterns-ui.js';
import { layIsolate, layUnisolate, layFreeze, layOn, layThaw } from '../src/core/layers.js';
import { Viewport, CANVAS_BG } from './viewport.js';
import { createDocState, findTabByPath, indexAfterClose, cycleIndex, isBlankTab } from './tabs.js';
import { createTools, TOOL_ALIASES } from './tools.js';
import { DWG_SAVE_PREF_KEY, DWG_SAVE_PREF_LABEL, DWG_SAVE_DISABLED_TEXT, dwgSaveAllowed, dwgOriginSaveText, ODA_SAVE_HINT, ODA_NEEDED_TEXT, ODA_OPTIONAL_NOTE, ODA_GET_LABEL, odaStatusText, odaMissing, DWG_SAVE_VERSION_KEY, DWG_SAVE_VERSIONS, dwgSaveVersionFrom, ctrlSaveRoute } from '../src/core/dwgpref.js';
import { ViewHistory, parseZoomFactor, ZOOMFACTOR_MIN, ZOOMFACTOR_MAX } from '../src/core/cmdline.js';
import { dimStyleManager, dimStyleNames, dimVarsOf, setCurrentDimStyle } from './tools-dims.js';
import { blockDoubleClick } from './tools-blocks.js';
import { initSession } from './session.js';
import { initAutosave } from './autosave.js';
import { AUTOSAVE_CHOICES, shouldDiscardAutosave } from '../src/core/autosave.js';
import { FindPanel } from './find.js';
import { plotDialog, publishDialog } from './plot.js';
import { initBlockEditor, blockedByEditor, settleBlockEdit, blockEditPending } from './bedit-ui.js';
import { initLayouts, restoreSpace, renderSpaceBar, layoutDoubleClick, exitMspace, renderVpScale, commitViewportView } from './layouts-ui.js';
import { ComparePanel, runCompare, compareUses } from './compare.js';
import { viewCommands, viewMenuItems } from './views-ui.js';
import { MarkupPanel, toggleMarkups, markupsShown } from './markup.js';
import { loadDrawingXrefs, xrefPanel } from './xref-panel.js';
import { TOOL_BUTTONS, buildToolPanel, iconButton, quickCommand, canvasDarkFrom, labelsFrom, placementFrom, PLACEMENTS, collapsedFrom, applyCollapsed, toolTitle, moreButton, fitToolBand, initToolBand } from './tool-panel.js';
import { iconSvg } from './icons.js';
import { initToolModes, TOOL_MODES, MODE_LABELS } from './tool-rail.js';
import { initSidePanel, applySide, markHead, windowTitle } from './side-panel.js';
import { initSymbolsPanel } from './symbols-ui.js';
import { symcountDialog } from './symcount-ui.js';
import { layerStatesDialog } from './layerstates-ui.js';
import { defaultLayout, cleanLayout, panelGroups, samePanel, quickRow, setQuickRow, compactKeys, foldMode, SEP } from './tool-layout.js';
import { openCustomize, initToolContextMenu } from './tool-custom.js';
import { loadDrawingImages } from './images.js';
import { CommandHistory } from '../src/core/cmdhist.js';
import { CmdHistView } from './cmdhist-view.js';
import { qselectDialog, selectSimilarCommand, purgeDialog } from './selclean.js';
import { draftingSettings, loadDraftingSettings } from './osnap-ui.js';
import { loadGridSettings } from './grid-ui.js';
import { initLayerCombo } from './layer-combo.js';
import { el, message, modal, confirmDialog, textDialog, listDialog, toast, progressToast, renderLayers, renderProperties } from './ui.js';
import {
  OPEN_FILTERS, loadDrawing, conversionSummary, saveDxf, saveDwg, verificationMessage, exportSvgBytes, exportPngBytes, buildScene, prepareView, baseName, savePathIn, extOf, UNIT_NAMES,
} from './files.js';

const api = window.api;
/** the drawing's saved model view (VPORT *Active) as a world box, or null */
const savedViewBox = (doc) => {
  const v = doc.activeView;
  if (!v) return null;
  const hw = v.height * v.aspect / 2, hh = v.height / 2;
  return { minx: v.cx - hw, maxx: v.cx + hw, miny: v.cy - hh, maxy: v.cy + hh };
};

class App {
  constructor() {
    this.tabs = [];              // open drawings (file tabs); see tabs.js createDocState
    this.active = null;          // the tab shown
    this.defaults = { textHeight: null, hatchPattern: 'ANSI31', hatchScale: 1, hatchAngle: 0 };
    this.clip = null;            // the last copied fragment (DXF text), for hosts without a system clipboard
    this.clipLocal = false;      // true while this.clip is newer than the last successful system clipboard write
    this.lastTool = 'line';
    this.theme = 'light';        // UI theme; light by default, the choice is saved as setting 'theme'
    this.vp = new Viewport(document.getElementById('cv'));
    this.tools = createTools(this);
    this.toolId = null;
    this.sessionStore = initSession(this); // last session and recent files
    this.autosave = initAutosave(this); // timed copies of unsaved drawings, recovered at the next start
    this.buildMenus();
    this.buildToolbar();
    this.toolModes = initToolModes(this, api, el); // tool panel layout: Full / Compact rail / Floating (tool-rail.js)
    this.buildStatus();
    this.bindKeys();
    this.bindDrop();
    this.find = new FindPanel(this);
    initLayouts(this);
    initBlockEditor(this);
    this.history = new CommandHistory(); // one per window, shared by all tabs
    this.histView = new CmdHistView(this.history);
    this.comparePanel = new ComparePanel(this);
    this.markupPanel = new MarkupPanel(this);
    initSidePanel(this, api);
    this.symbolsPanel = initSymbolsPanel(this, api);
    document.getElementById('sym-count').onclick = () => symcountDialog(this);
    document.getElementById('layer-states').onclick = () => layerStatesDialog(this);
    this.cmd = document.getElementById('cmd');
    this.cmd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const v = this.cmd.value; this.cmd.value = ''; this.vp.canvas.focus(); this.submit(v); }
      else if (e.key === 'Escape' && this.histView.open) { e.preventDefault(); this.toggleHistory(false); }
      else if (e.key === 'Escape') { this.cmd.value = ''; this.cmd.blur(); this.vp.canvas.focus(); this.tool?.key({ key: 'Escape' }); }
      else if (e.key === 'F2') { e.preventDefault(); this.toggleHistory(); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (!this.cmd.value || this.cmd.value === this.history.recalled)) { // AutoCAD: recall earlier inputs
        e.preventDefault();
        const v = e.key === 'ArrowUp' ? this.history.older() : this.history.newer();
        if (v != null) { this.cmd.value = v; this.cmd.setSelectionRange(v.length, v.length); }
      }
      else if (e.key === ' ' && !this.cmd.value.trim() && this.tool?.key?.({ key: ' ' })) { e.preventDefault(); this.cmd.value = ''; this.refreshPrompt(); } // Space = Enter (grip modes)
      e.stopPropagation();
    });
    document.getElementById('z-in').onclick = () => this.vp.zoomBy(1.4);
    document.getElementById('z-out').onclick = () => this.vp.zoomBy(1 / 1.4);
    document.getElementById('z-fit').onclick = () => this.vp.zoomExtents();
    this.vp.on('selection', () => { this.refreshPanels(true); this.refreshStatus(); });
    this.vp.on('change', () => { this.refreshPanels(); this.refreshStatus(); this.updateTitle(); this.refreshDimStyles(); });
    this.vp.on('cursor', (p) => this.showCursor(p));
    this.viewHistory = new ViewHistory();
    this.vp.on('view', () => this.viewHistory.observe(this.viewKey(), this.vp.view, performance.now()));
    this.vp.canvas.addEventListener('dblclick', (e) => { if (this.toolId === 'select' && !layoutDoubleClick(this, e)) blockDoubleClick(this, e); });
    window.addEventListener('beforeunload', (e) => { if (!this.closeConfirmed && this.tabs.some((t) => t.session.dirty || blockEditPending(t))) { e.preventDefault(); e.returnValue = ''; } });
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
    api.settingsGet?.('tools.collapsed').then((v) => { this.collapsed = collapsedFrom(v); applyCollapsed(document.getElementById('tools'), this.collapsed); this.fitBand(); }).catch(() => {});
    api.settingsGet?.('tools.layout').then((v) => { if (v != null) this.setToolLayout(cleanLayout(v), false); }).catch(() => {});
    api.settingsGet?.(DWG_SAVE_PREF_KEY).then((v) => { this.allowDwgSave = dwgSaveAllowed(v); }).catch(() => {});
    this.odaWrite = false; this.refreshDwgWrite();
    api.settingsGet?.('view.zoomFactor').then((v) => { const n = parseZoomFactor(v); if (n !== null) this.setZoomFactor(n, false); }).catch(() => {});
    api.settingsGet?.('theme').then((t) => { if (t === 'dark') this.setTheme('dark', false); }).catch(() => {});
    api.version?.().then((v) => { this.version = v; this.refreshWindowTitle(); }).catch(() => {});
    loadDraftingSettings(this).catch(() => {});
    loadGridSettings(this).catch(() => {});
    api.settingsGet?.('measure.showLegs').then((v) => setShowLegs(v)).catch(() => {});
    loadSavedPatterns(this, api).catch(() => {});
    api.onOpenFile?.((f) => this.openFromFile(f));
    // files given at start-up open first; then autosaved drawings are offered for recovery; then the previous session
    // is offered (or reopened, per startup.mode) - without the files just recovered
    api.getLaunchFiles?.().then(async (files) => { for (const f of files ?? []) await this.openFromFile(f); }).catch(() => {})
      .then(() => this.autosave.recover()).catch(() => {})
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
  listDialog(text) { return listDialog(text); }
  /** ZOOMFACTOR (3..100): mouse wheel zoom speed, saved as setting 'view.zoomFactor' */
  setZoomFactor(n, save = true) {
    this.vp.settings.zoomFactor = n;
    if (save) api.settingsSet?.('view.zoomFactor', n)?.catch?.(() => {});
  }
  refreshPrompt() { document.getElementById('prompt').textContent = this.tool?.prompt ?? ''; }
  /** add a message to the command history (ID result, LIST, errors) */
  log(text) { this.history.message(text); this.histView.update(); }
  /** F2 / View > Command history: expand or collapse the history (closing gives the keyboard back to the canvas) */
  toggleHistory(on) { this.histView.toggle(on); if (!this.histView.open) this.vp.canvas.focus(); }
  refreshPanels(selectionOnly = false) {
    if (!selectionOnly) renderLayers(this);
    renderProperties(this);
    this.layerCombo?.refresh(); // the Quick Access layer combo shows the current layer or the selection's
    markHead(document.querySelector('#side .panel[data-sec="props"]')); // its header is rebuilt on each render
  }
  /** the side panel shown or collapsed to its strip (View > Side panel, Ctrl+3, the strip's button), saved as 'side.shown' */
  setSidePanel(shown, save = true) {
    this.sideShown = !!shown;
    applySide(this);
    if (save) api.settingsSet?.('side.shown', this.sideShown)?.catch?.(() => {});
  }
  /** fold or unfold one side panel section ('layers', 'markups', 'symbols', 'props'), saved as 'side.folded' */
  foldSideSection(key, folded = !this.sideFolded.includes(key)) {
    this.sideFolded = folded ? [...new Set([...this.sideFolded, key])] : this.sideFolded.filter((k) => k !== key);
    applySide(this);
    api.settingsSet?.('side.folded', this.sideFolded)?.catch?.(() => {});
  }

  setTool(id) {
    if (blockedByEditor(this, id)) id = 'select';
    this.vp.preview = null;
    if (this.toolId && this.tool) this.tool.deactivate(); // may leave a preview behind (Measure keeps its markers)
    const kept = id === 'select' ? this.vp.preview : null; // back to Select: the markers stay beside its own preview
    if (id !== 'select') this.lastTool = id;
    this.toolId = id;
    this.vp.tool = this.tool;
    this.vp.clearTracking();
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
    this.history.input(this.toolId === 'select' && !t.hot ? '' : t.prompt, s); // idle select shows as "Command:"
    this.histView.update();
    if (!s) { // Enter: finish the tool, or repeat the last command from idle
      if (this.pendingEnter && this.toolId === 'select') { this.pendingEnter(); this.refreshPrompt(); return; } // select, then Enter (SELECTSIMILAR)
      if (this.toolId === 'select' && !t.hot) this.setTool(this.lastTool); else t.key({ key: 'Enter' });
      this.refreshPrompt(); return;
    }
    if (t.text?.(s)) { this.refreshPrompt(); return; }
    const low = s.toLowerCase();
    if (blockedByEditor(this, low)) return;
    if (TOOL_ALIASES[low]) { this.setTool(TOOL_ALIASES[low]); return; }
    const sys = { u: () => this.undo(), undo: () => this.undo(), redo: () => this.redo(), ze: () => { this.viewHistory.breakGesture(this.viewKey()); this.vp.zoomExtents(); }, all: () => this.selectAll(), new: () => this.newDrawing(), open: () => this.open(), save: () => this.save(), saveas: () => this.saveAs('dxf'), pdf: () => this.exportPdf(), plot: () => this.print(), print: () => this.print(), publish: () => this.publish(), find: () => this.find.open(), compare: () => this.compare(), symcount: () => symcountDialog(this), bcount: () => symcountDialog(this), d: () => this.dimStyles(), dimstyle: () => this.dimStyles(), ddim: () => this.dimStyles(), copyclip: () => this.copySel(), copybase: () => this.copySel(true), pasteclip: () => this.paste(), pasteblock: () => this.paste('block'), pasteorig: () => this.paste('orig'), units: () => this.unitsDialog(), un: () => this.unitsDialog(), ddunits: () => this.unitsDialog(), xref: () => xrefPanel(this), xr: () => xrefPanel(this), qselect: () => qselectDialog(this), selectsimilar: () => selectSimilarCommand(this), purge: () => purgeDialog(this), pu: () => purgeDialog(this), osnap: () => draftingSettings(this), os: () => draftingSettings(this), dsettings: () => draftingSettings(this), ds: () => draftingSettings(this), ...this.panelCommands(), ...this.layerCommands(), ...this.layoutCommands, ...viewCommands(this) };
    if (sys[low]) { sys[low](); return; }
    const last = this.vp.lastPoint ?? { x: 0, y: 0 };
    const dir = this.vp.lastPoint ? { x: this.vp.cursor.x - last.x, y: this.vp.cursor.y - last.y } : null;
    const tr = this.vp.snapMarker?.track, td = tr && parseCoordinate(s, tr.from, tr.dir); // a distance typed on a tracking line goes along it
    const pt = td?.distance !== undefined ? td : parseCoordinate(s, last, dir);
    if (pt && Number.isFinite(pt.x) && (this.toolId !== 'select' || t.hot)) { this.vp.cursor = { x: pt.x, y: pt.y }; t.click({ x: pt.x, y: pt.y }); this.refreshPrompt(); this.vp.requestRender(); return; }
    toast(`Unknown command "${s}".`);
    this.log(`Unknown command "${s}".`);
  }

  /** PR / LA: show the side panel (Quick Access 'layers' toggles it) and bring Properties or Layers into view; RE: rebuild the scene */
  panelCommands() {
    const show = (id) => () => {
      const panel = document.getElementById(id).closest('.panel');
      this.setSidePanel(true);
      if (this.sideFolded.includes(panel.dataset.sec)) this.foldSideSection(panel.dataset.sec, false);
      panel.scrollIntoView({ block: 'nearest' });
    };
    const regen = () => { this.vp.refreshStructure(); this.vp.invalidate(); toast('Regenerating model.', 1500); };
    const symbols = () => { show('sym-grid')(); this.symbolsPanel.focus(); };
    return { pr: show('props'), properties: show('props'), ch: show('props'), mo: show('props'), la: show('layers'), layer: show('layers'), symbols,
      re: regen, regen, regenall: regen, redraw: regen, r: regen };
  }
  layerCommands() {
    const sel = () => [...this.vp.selection];
    const need = (f) => () => { if (!this.vp.selection.size) { toast('Select objects first, then run the command.'); return; } f(); };
    return {
      layiso: need(() => { this.isoSaved = layIsolate(this.session, sel()); toast('Layers isolated (LAYUNISO restores)', 2500); }),
      layuniso: () => { if (layUnisolate(this.session, this.isoSaved)) { this.isoSaved = null; toast('Layers restored', 1500); } else toast('Nothing isolated.'); },
      layfrz: need(() => { const n = layFreeze(this.session, sel()); this.vp.setSelection([]); toast(`Frozen: ${n.join(', ')}`, 2500); }),
      laymcur: need(() => {
        if (this.vp.selection.size !== 1) { toast('Select one object to make its layer current.'); return; }
        const e = this.doc.entities.find((x) => x.id === sel()[0]); if (!e) return;
        const keys = [...this.doc.layers.keys()], name = keys.includes(e.layer) ? e.layer : (keys.find((k) => k.toUpperCase() === String(e.layer).toUpperCase()) ?? e.layer);
        this.state.layer = name; this.refreshPanels(); toast(`Current layer: ${name}`, 2500);
      }),
      layon: () => layOn(this.session), laythw: () => layThaw(this.session),
      layerstate: () => layerStatesDialog(this), las: () => layerStatesDialog(this), lman: () => layerStatesDialog(this),
    };
  }
  /** ZOOM Previous keeps one view stack per tab and space (model, each layout, each viewport entered from a layout) */
  viewKey() { const tab = this.active; return `${tab?.id}:${tab?.spaces?.cur ?? 'Model'}${this.vp.mspace ? ':' + this.vp.mspace.vp.id : ''}`; }
  /** ZOOM Previous: show the earlier view of the current space; false = none left */
  zoomPrevious() {
    const vp = this.vp, v = this.viewHistory.previous(this.viewKey(), performance.now());
    if (!v) return false;
    vp.view = { ...vp.view, cx: v.cx, cy: v.cy, zoom: v.zoom };
    vp.requestRender(); vp.emit('view');
    return true;
  }
  undo() { commitViewportView(this); if (this.session.undo()) toast(`Undo`, 1200); }
  redo() { commitViewportView(this); if (this.session.redo()) toast(`Redo`, 1200); }
  selectAll() { this.vp.setSelection(this.doc.entities.filter((e) => this.vp.index.bboxOf(e)).map((e) => e.id)); }
  deleteSelection() { if (this.vp.selection.size) { eraseEntities(this.session, [...this.vp.selection]); } }
  copySel(base = false) { copyClip(this, { base }); }
  paste(mode = 'clip') { pasteClip(this, mode); }

  // ---- new / open / save -------------------------------------------------------------------------
  /** asks to save a drawing with unsaved changes (shown first). The choice: 'clean' (nothing to save), 'save' (saved -
   *  a DWG that differs from the drawing leaves it unsaved), 'dont-save'; null = cancelled, or the save failed */
  async confirmDiscard(tab = this.active) {
    if (!(await settleBlockEdit(this, tab))) return null; // unsaved block-editor changes first: Save / Discard / Cancel
    if (!tab?.session.dirty) return 'clean';
    if (tab !== this.active) this.switchTo(tab);
    const r = await confirmDialog('Unsaved changes', `Save changes to ${tab.file.name}?`, 'Save', "Don't save", 'Cancel');
    if (r === 'yes') return (await this.save()) ? 'save' : null;
    return r === 'no' ? 'dont-save' : null;
  }
  /** show a drawing in a new tab; a blank, untouched Untitled tab is replaced instead */
  /** prepared: {scene, index} built ahead (prepareView) so showing the tab does no long synchronous work */
  installDoc(doc, file, { replaceBlank = false, prepared = null, firstView = false } = {}) {
    const tab = createDocState(doc, file);
    if (prepared) { tab.scene = prepared.scene; tab.index = prepared.index; }
    const blank = replaceBlank && isBlankTab(this.active) ? this.active : null;
    if (blank) this.tabs.splice(this.tabs.indexOf(blank), 1, tab); else this.tabs.push(tab);
    this.switchTo(tab, { fit: true, firstView });
  }
  /** bring a tab to the front: the shown tab keeps its view, selection and caches for when it comes back */
  switchTo(tab, { fit = false, firstView = false } = {}) {
    const cur = this.active;
    if (cur && cur !== tab) { exitMspace(this); clearMeasureResults(); }
    if (cur && cur !== tab && this.tabs.includes(cur)) {
      cur.view = { cx: this.vp.view.cx, cy: this.vp.view.cy, zoom: this.vp.view.zoom };
      cur.selection = [...this.vp.selection]; cur.lastPoint = this.vp.lastPoint;
      cur.scene = this.vp.scene; cur.index = this.vp.index;
    }
    if (cur !== tab && this.toolId) this.setTool(this.toolId === 'select' ? 'select' : this.toolId); // drop a half-done command
    this.active = tab;
    restoreSpace(this, tab);
    this.vp.setSession(tab.bedit?.edit.session ?? tab.session, { fit: fit || !tab.view, view: fit ? null : tab.view, selection: tab.selection, scene: tab.scene, index: tab.index, lastPoint: tab.lastPoint, initialView: firstView ? savedViewBox(tab.session.doc) : null });
    tab.scene = tab.index = null;
    renderSpaceBar(this);
    this.refreshPanels(); this.refreshStatus(); this.updateTitle(); this.refreshDimStyles();
    this.comparePanel?.sync();
  }
  activateIndex(i) { if (this.tabs[i] && this.tabs[i] !== this.active) this.switchTo(this.tabs[i]); }
  cycleTab(step) { this.activateIndex(cycleIndex(this.tabs.length, this.tabs.indexOf(this.active), step)); }
  /** close a tab after the save prompt; closing the last tab leaves a new blank drawing. Returns false if cancelled. */
  async closeTab(tab = this.active) {
    if (tab && compareUses(tab.doc)) { toast('A compare is running on this drawing: wait for it or cancel it first.'); return false; }
    const choice = await this.confirmDiscard(tab);
    if (!choice) return false;
    // saved or "Don't save": its autosave copy goes (a save that left it unsaved keeps the copy for the next start)
    if (shouldDiscardAutosave({ choice, dirtyAfter: tab.session.dirty })) await this.autosave.discard(tab);
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    if (this.active === tab) clearMeasureResults();
    const next = indexAfterClose(this.tabs.length, i, this.tabs.indexOf(this.active));
    this.tabs.splice(i, 1);
    if (this.active === tab) this.active = null;
    if (next < 0) { this.newDrawing(); return true; }
    if (!this.active) this.switchTo(this.tabs[next]); else this.updateTitle();
    return true;
  }
  /** window close / quit: one save prompt per drawing with unsaved changes, then close */
  async closeAll() {
    const choices = new Map();
    for (const tab of this.tabs.filter((t) => t.session.dirty || blockEditPending(t))) {
      const choice = await this.confirmDiscard(tab);
      if (!choice) return false;
      choices.set(tab, choice);
    }
    this.autosave.stop(); // no autosave may start (and outlive the window) from here
    // saved or "Don't save": no copy is offered next time (a save that left a drawing unsaved keeps its copy)
    for (const tab of this.tabs) if (shouldDiscardAutosave({ choice: choices.get(tab) ?? 'clean', dirtyAfter: tab.session.dirty })) await this.autosave.discard(tab);
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
      // DWG conversion runs in main with no progress of its own: show the elapsed time (ODA can take minutes)
      let clock = null;
      const onStage = (stage) => {
        clearInterval(clock); clock = null;
        if (stage !== 'convert') { pt.text('Reading…'); return; }
        const t0 = Date.now();
        const tick = () => { const s = Math.round((Date.now() - t0) / 1000); pt.text(`Converting DWG… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${s >= 30 ? ' (large drawings can take a few minutes)' : ''}`); };
        tick(); clock = setInterval(tick, 1000);
      };
      let loaded;
      try { loaded = await loadDrawing(api, f.name, f.bytes, { onProgress: (x) => pt.set(x), signal: ac.signal, path: f.path ?? null, onStage }); } finally { clearInterval(clock); }
      const { doc, format, notes, warnings, conversion } = loaded;
      toast(`Opening ${f.name} …`, 60000); // read: now the view is built
      await loadDrawingXrefs(api, doc, f.path ?? null); // before the scene is built: it is built once, with the xrefs
      const missing = await loadDrawingImages(api, doc, f.path ?? null);
      if (missing.length) notes.push(`Raster images not found (shown as a red frame with the file name): ${missing.join(', ')}.`);
      const pp = progressToast('Preparing drawing…', () => ac.abort());
      const prepared = await prepareView(doc, { signal: ac.signal, onProgress: (x) => pp.set(x) });
      this.installDoc(doc, { path: f.path ?? null, name: f.name, format }, { replaceBlank: true, prepared, firstView: true });
      this.active.conversion = conversion ?? null; // the status-bar conversion item and Help > Converter log
      this.refreshStatus();
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
    if (blockedByEditor(this, 'units')) return;
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
  /** whether DWG can be written by the ODA File Converter now (installed, and the converter preference allows it); cached in this.odaWrite for the File menu */
  async refreshDwgWrite() {
    try { this.odaWrite = !!(await api.dwgAvailable?.())?.write?.oda; } catch { this.odaWrite = false; }
    return this.odaWrite;
  }
  // Every save applies its result to the tab it started on (captured before the first await), never to this.active or
  // this.file read after an await: a slow DWG conversion must not rename or mark saved a tab the user switched to.
  // One save at a time per tab: a second Save / Save As on a tab while its save runs is refused.
  /** run `fn(tab)` as the save of the shown tab; false (and a toast) when that tab is already being saved */
  async guardedSave(fn) {
    if (!(await settleBlockEdit(this))) return false; // unsaved block-editor changes first: Save / Discard / Cancel
    const tab = this.active;
    if (!tab) return false;
    if (tab.saving) { toast('Still saving…', 2000); return false; }
    commitViewportView(this); // a viewport view changed in MSPACE becomes its undo step before the save point
    tab.saving = { step: tab.session.undoStack.at(-1)?.id ?? 0 }; // the save point: edits made while saving stay unsaved
    try { return await fn(tab); } finally { tab.saving = null; }
  }
  save() { return this.guardedSave((tab) => this.saveTab(tab)); }
  /** autosave the due drawings now (also used by the e2e test); the number of copies written */
  autosaveNow() { return this.autosave.now(); }
  saveAs(kind) { return this.guardedSave((tab) => this.saveTabAs(tab, kind)); }
  async saveTab(tab) {
    const dropped = this.droppedContent(); // before any await: the tab is still the shown one
    // a drawing opened from (or saved as) DWG goes back to its .dwg in the same DWG version when ODA can write it
    const odaWrite = tab.file.format === 'dwg' && !!tab.file.path && (await this.refreshDwgWrite());
    const route = tab.file.path ? ctrlSaveRoute({ format: tab.file.format, odaWrite, tabVersion: tab.dwgVersion, header: tab.conversion?.dwgHeader }) : null;
    if (route?.action === 'dxf-overwrite' || route?.action === 'dwg-writeback') {
      const dwgBack = route.action === 'dwg-writeback';
      if (dropped.length) {
        const r = await modal('Overwrite the original file?', el('div', {},
          el('p', { text: `${tab.file.name} contains objects this program cannot keep: ${dropped.join(', ')}.` }),
          el('p', { text: 'Overwriting the original would remove them from the file. Save a new copy instead to keep the original intact.' })),
        [{ label: 'Save as new file…', value: 'copy', primary: true }, { label: 'Overwrite original', value: 'over' }, { label: 'Cancel', value: null }]);
        if (r === 'copy') return this.saveTabAs(tab, dwgBack ? 'dwg' : 'dxf');
        if (r !== 'over') return false;
      }
      if (dwgBack) return this.writeDwg(tab, { version: route.version, path: tab.file.path });
      return this.writeDxfTo(tab, tab.file.path);
    }
    // a drawing opened from DWG is saved as DXF: say so once per drawing (the save dialog then names the .dxf file)
    if (tab.file.format === 'dwg' && !tab.dwgSaveAcked) {
      const ok = await this.modalWithOdaLink('Save as DXF', [el('p', { text: dwgOriginSaveText(tab.file.name) }), el('p', { text: ODA_NEEDED_TEXT })],
        [{ label: 'Save as DXF', value: 'yes', primary: true }, { label: 'Cancel', value: null }]);
      if (ok !== 'yes') return false;
      tab.dwgSaveAcked = true;
    }
    return this.saveTabAs(tab, 'dxf');
  }
  /** a modal that also offers "Get ODA File Converter" (desktop app only); that choice opens the download page and shows the modal again */
  async modalWithOdaLink(title, body, buttons) {
    const withLink = api.openOdaDownload ? [...buttons.slice(0, -1), { label: ODA_GET_LABEL, value: 'oda' }, buttons.at(-1)] : buttons;
    for (;;) {
      const r = await modal(title, body, withLink);
      if (r !== 'oda') return r;
      await api.openOdaDownload().catch(() => {});
    }
  }
  async writeDxfTo(tab, path) {
    try {
      const r = await saveDxf(api, tab.doc, { path, name: tab.file.name, fromPath: tab.file.path });
      if (!r) return false;
      this.afterSave(tab, r.path ?? path, 'dxf');
      this.writeReport(r.report);
      return true;
    } catch (err) { await message('Save failed', err.message || String(err)); return false; }
  }
  writeReport(rep) {
    if (rep?.skipped && Object.keys(rep.skipped).length) toast(`Saved. Not written: ${Object.entries(rep.skipped).map(([k, v]) => `${v} ${k}`).join(', ')}`, 6000);
    else toast('Saved', 1500);
  }
  /** a finished save of `tab` (captured when the save started): its new file, and the save point recorded at the start */
  afterSave(tab, path, format, { clean = true } = {}) {
    if (!this.tabs.includes(tab)) return; // closed while it was being saved
    tab.file = { path, name: path ? path.replace(/^.*[\\/]/, '') : `${baseName(tab.file.name)}.${format}`, format };
    if (clean) { tab.session.markSaved(tab.saving?.step); tab.recoveredFrom = null; this.autosave.discard(tab); }
    this.updateTitle();
  }
  /** Save as DWG with ODA: the DWG version to write (the last choice is remembered), or null when cancelled */
  async chooseDwgVersion() {
    const sel = el('select', { id: 'dwg-save-version' }, DWG_SAVE_VERSIONS.map((v) => el('option', { value: v.id, text: v.label })));
    sel.value = dwgSaveVersionFrom(await api.settingsGet?.(DWG_SAVE_VERSION_KEY)?.catch?.(() => undefined));
    const r = await modal('Save as DWG', el('div', {}, el('p', {}, el('label', { text: 'DWG version: ' }, sel)),
      el('p', { text: 'The DWG is written by the ODA File Converter. AutoCAD 2018 opens in AutoCAD 2018 and later; choose an older version for older programs.' })),
    [{ label: 'Save', value: 'save', primary: true }, { label: 'Cancel', value: null }]);
    if (r !== 'save') return null;
    api.settingsSet?.(DWG_SAVE_VERSION_KEY, sel.value)?.catch?.(() => {});
    return sel.value;
  }
  /** write `tab` as DWG through ODA (`path`: overwrite that file, after its .bak copy; null: the save dialog) */
  async writeDwg(tab, { version, path = null }) {
    try {
      const r = await saveDwg(api, tab.doc, {
        name: tab.recoveredFrom?.name ?? tab.file.name, fromPath: tab.file.path ?? tab.recoveredFrom?.path ?? null, version, path,
        confirmDifferences: async (v) => (await confirmDialog('The DWG does not match your drawing', `${verificationMessage(v, { oda: true })}\n\nSave this DWG anyway? (Your drawing stays open and unsaved, so you can still save it as DXF.)`, 'Save DWG anyway', 'Cancel', null)) === 'yes',
      });
      if (!r) return false;
      tab.dwgVersion = version;
      this.afterSave(tab, r.path, 'dwg', { clean: !!r.verification.ok });
      const label = DWG_SAVE_VERSIONS.find((v) => v.id === version)?.label ?? 'DWG';
      if (r.verification.ok) toast(`Saved as ${label}${r.backup ? ` (previous file kept as ${r.backup.replace(/^.*[\\/]/, '')})` : ''}`, 3000);
      else await message('DWG saved — please check', verificationMessage(r.verification, { oda: true }));
      return true;
    } catch (err) { await message('Save failed', err.message || String(err)); return false; }
  }
  async saveTabAs(tab, kind) {
    try {
      if (kind === 'dwg') {
        if (await this.refreshDwgWrite()) {
          const version = await this.chooseDwgVersion();
          return version ? this.writeDwg(tab, { version }) : false;
        }
        if (!this.allowDwgSave) { await this.modalWithOdaLink('Save as DWG is turned off', [el('p', { text: DWG_SAVE_DISABLED_TEXT }), el('p', { text: ODA_NEEDED_TEXT })], [{ label: 'OK', value: true, primary: true }]); return false; }
        const ok = await this.modalWithOdaLink('Save as DWG (experimental)', el('p', { text:
          `DWG is written through the free LibreDWG converter. Layouts and viewports may appear empty when the file is opened in AutoCAD, and text rotation and some hatch details can be lost. The program re-reads the saved file and tells you if anything differs. DXF keeps everything this program supports. ${ODA_SAVE_HINT} Save as DWG anyway?` }),
          [{ label: 'Save as DWG', value: 'yes', primary: true }, { label: 'Cancel', value: 'no' }]);
        if (ok !== 'yes') return false;
        const r = await saveDwg(api, tab.doc, {
          name: tab.recoveredFrom?.name ?? tab.file.name, fromPath: tab.file.path ?? tab.recoveredFrom?.path ?? null,
          confirmDifferences: async (v) => (await confirmDialog('The DWG does not match your drawing', `${verificationMessage(v)}\n\nSave this DWG anyway? (Your drawing stays open and unsaved, so you can still save it as DXF.)`, 'Save DWG anyway', 'Cancel', null)) === 'yes',
        });
        if (!r) return false;
        tab.dwgVersion = r.version; // LibreDWG's 'r2000': a later Ctrl+S with ODA keeps the 2000 family (ctrlSaveRoute)
        // a DWG that differs from the drawing is not a faithful save: keep the document marked as having unsaved changes
        this.afterSave(tab, r.path, 'dwg', { clean: !!r.verification.ok });
        await message(r.verification.ok ? 'DWG saved' : 'DWG saved — please check', verificationMessage(r.verification));
        return true;
      }
      const r = await saveDxf(api, tab.doc, { path: null, name: tab.recoveredFrom?.name ?? tab.file.name, fromPath: tab.file.path ?? tab.recoveredFrom?.path ?? null });
      if (!r) return false;
      this.afterSave(tab, r.path, 'dxf'); this.writeReport(r.report);
      return true;
    } catch (err) { await message('Save failed', err.message || String(err)); return false; }
  }

  // ---- exports ---------------------------------------------------------------------------------
  scene() { return buildScene(this.fileDoc); }
  async saveBytes(bytes, ext, label) {
    const r = await api.saveFile({ defaultPath: savePathIn(this.file.path, `${baseName(this.file.name)}.${ext}`), filters: [{ name: label, extensions: [ext] }], bytes });
    if (r) toast(`Exported ${ext.toUpperCase()}`, 2000);
  }
  /** Plot to PDF (the Print dialog with a Save button) */
  exportPdf() { return plotDialog(this, 'pdf'); }
  print() { return plotDialog(this, 'print'); }
  /** File > Publish to PDF… (PUBLISH): sheets of all open drawings in one PDF */
  publish() { return publishDialog(this); }
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
    const zf = el('input', { id: 'pref-zoomfactor', type: 'number', min: String(ZOOMFACTOR_MIN), max: String(ZOOMFACTOR_MAX), step: '1', value: String(this.vp.settings.zoomFactor), style: 'width:5em' });
    const zoomRow = el('p', {}, el('label', { text: `Mouse wheel zoom speed (ZOOMFACTOR, ${ZOOMFACTOR_MIN} to ${ZOOMFACTOR_MAX}): ` }), zf);
    const dwgSave = el('input', { id: 'pref-dwg-save', type: 'checkbox' });
    dwgSave.checked = !!this.allowDwgSave;
    const dwgSaveRow = el('p', {}, el('label', {}, dwgSave, ` ${DWG_SAVE_PREF_LABEL}`));
    const applyDwgSave = () => { this.allowDwgSave = dwgSave.checked; api.settingsSet?.(DWG_SAVE_PREF_KEY, this.allowDwgSave)?.catch?.(() => {}); };
    const autoSel = el('select', { id: 'pref-autosave' }, AUTOSAVE_CHOICES.map((m) => el('option', { value: String(m), text: m ? `Every ${m} minutes` : 'Off' })));
    await this.autosave.ready; // the saved interval, not the default shown before it has loaded
    autoSel.value = String(this.autosave.minutes);
    autoSel.disabled = !this.autosave.enabled;
    const autosaveRow = el('p', {}, el('label', { text: 'Autosave unsaved drawings (recovered after a crash): ' }), autoSel);
    const applyAutosave = () => { if (this.autosave.enabled) this.autosave.setMinutes(Number(autoSel.value)); };
    if (!api.dwgConfig) {
      const r0 = await modal('Preferences', el('div', {}, zoomRow, dwgSaveRow, autosaveRow, el('p', { text: 'The DWG converter settings and autosave need the desktop app.' })), [{ label: 'Save', value: 'save', primary: true }, { label: 'Cancel', value: null }]);
      if (r0 !== 'save') return;
      applyDwgSave(); applyAutosave();
      const n0 = parseZoomFactor(zf.value);
      if (n0 === null) await message('Preferences not saved', `ZOOMFACTOR must be a whole number from ${ZOOMFACTOR_MIN} to ${ZOOMFACTOR_MAX}.`); else { this.setZoomFactor(n0); toast('Preferences saved', 2000); }
      return;
    }
    const cfg = await api.dwgConfig();
    const av = await api.dwgAvailable().catch(() => null);
    const mode = el('select', { id: 'pref-dwg-mode' }, [['auto', 'Automatic (built-in LibreDWG; ODA when it cannot read the file)'], ['oda', 'ODA File Converter'], ['libredwg', 'Built-in (LibreDWG)']].map(([v, t]) => el('option', { value: v, text: t })));
    mode.value = cfg.mode;
    const odaPath = el('input', { id: 'pref-oda-path', type: 'text', value: cfg.odaPath, placeholder: av?.oda?.source === 'auto' ? av.oda.path : 'Detected automatically in C:\\Program Files\\ODA', style: 'width:100%' });
    const browse = el('button', { type: 'button', text: 'Browse…', onclick: async () => { const p = await api.dwgBrowseOda(); if (p) odaPath.value = p; } });
    const status = av ? `In use: ${av.available ? av.version : `none (${av.reason})`}. ${odaStatusText(av)}` : '';
    const odaNote = odaMissing(av) ? el('p', { id: 'pref-oda-note' }, [ODA_OPTIONAL_NOTE, ' ',
      ...(api.openOdaDownload ? [el('button', { type: 'button', id: 'pref-oda-get', text: ODA_GET_LABEL, onclick: () => api.openOdaDownload().catch(() => {}) })] : [])]) : null;
    // converted-drawing cache (electron/dwgCache.js): its limit (setting 'dwg.cacheMaxMB') and a Clear button
    const ci = await api.dwgCacheInfo?.().catch(() => null);
    const gb = (n) => `${(n / 1073741824).toFixed(n < 1073741824 ? 2 : 1)} GB`;
    const cacheSel = el('select', { id: 'pref-dwg-cache' }, [[0, 'Off'], [1024, '1 GB'], [2048, '2 GB'], [5120, '5 GB'], [10240, '10 GB']].map(([v, t]) => el('option', { value: String(v), text: t })));
    const curMB = ci ? Math.round(ci.limitBytes / 1048576) : 2048;
    if (![...cacheSel.options].some((o) => o.value === String(curMB))) cacheSel.append(el('option', { value: String(curMB), text: `${curMB} MB` }));
    cacheSel.value = String(curMB);
    const cacheUse = el('span', { id: 'pref-dwg-cache-use', text: ci ? ` ${gb(ci.bytes)} used by ${ci.entries} drawing${ci.entries === 1 ? '' : 's'} ` : ' ' });
    const cacheClear = el('button', { type: 'button', id: 'pref-dwg-cache-clear', text: 'Clear converted-drawing cache', onclick: async () => {
      try { const n = await api.dwgCacheClear(); cacheUse.textContent = ' 0.00 GB used by 0 drawings '; toast(`Converted-drawing cache cleared (${n} drawing${n === 1 ? '' : 's'})`, 2500); } catch (err) { toast(`The cache could not be cleared: ${err.message || err}`, 4000); }
    } });
    const cacheRow = ci ? el('p', {}, el('label', { text: 'Keep converted DWG drawings (reopening an unchanged DWG skips the conversion), up to ' }), cacheSel, cacheUse, cacheClear) : null;
    const r = await modal('Preferences', el('div', {}, zoomRow, dwgSaveRow, autosaveRow,
      el('label', { text: 'DWG converter ' }, mode),
      el('p', {}, el('label', { text: 'ODA File Converter (ODAFileConverter.exe), leave empty to detect it: ' }), odaPath, browse),
      el('p', { id: 'pref-dwg-status', text: status }), odaNote, cacheRow),
    [{ label: 'Save', value: 'save', primary: true }, { label: 'Cancel', value: null }]);
    if (r !== 'save') return;
    applyDwgSave(); applyAutosave();
    if (ci && Number(cacheSel.value) !== curMB) api.settingsSet?.('dwg.cacheMaxMB', Number(cacheSel.value))?.catch?.(() => {});
    const nz = parseZoomFactor(zf.value);
    if (nz !== null) this.setZoomFactor(nz); else toast(`ZOOMFACTOR not changed: it must be a whole number from ${ZOOMFACTOR_MIN} to ${ZOOMFACTOR_MAX}.`, 4000);
    try { await api.dwgSetConfig({ mode: mode.value, odaPath: odaPath.value.trim() }); this.refreshDwgWrite(); toast('Preferences saved', 2000); } catch (err) { await message('Preferences not saved', String(err.message || err).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '')); }
  }
  async limitations() {
    await message('What this program does and does not do', 'Please read before relying on it for important work:', el('ul', {},
      ['Paper-space layouts, their objects and viewports are read and saved back; viewport clip boundaries other than the rectangle are not kept.',
        'Supported objects: lines, polylines, circles, arcs, ellipses, splines, xlines and rays, text, multiline text, points, solids, 3D faces, hatches, blocks and attributes, dimensions (as drawn), leaders, multileaders, multilines, images, wipeouts and external references.',
        'Not shown: 3D solids (3DSOLID), BODY, REGION and proxy objects (ACAD_PROXY_ENTITY, for example Civil 3D objects); OLE objects are drawn from their saved preview picture (a frame only when there is none it can show). Any other object type this program does not know is skipped too. Skipped objects are reported when you open the file, and they are not written when you save.',
        'Dimensions are displayed from their stored drawing, but cannot be edited as dimensions; they can be moved, copied or exploded.',
        'Saving as DXF is the reliable option. With the free ODA File Converter installed, DWG is saved in AutoCAD 2018 format (or an older version you choose), and Save writes a drawing opened from DWG back to its file in its own version, keeping the previous file as a .bak copy. Without it, saving as DWG is experimental and off by default (Edit > Preferences); layouts and viewports may appear empty in AutoCAD, and text rotation and some hatches can be lost.',
        'The ODA File Converter is optional and installed separately: it adds saving to DWG (2000 to 2018) and opening drawings the built-in converter cannot read. Everything else works without it.',
        'Fonts: text is drawn with a system font, so widths differ slightly from the original CAD fonts.',
      ].map((t) => el('li', { text: t }))));
  }

  // ---- menus --------------------------------------------------------------------------------------
  buildMenus() {
    const vp = this.vp;
    const M = [
      ['File', [['New', 'Ctrl+N', () => this.newDrawing()], ['Open…', 'Ctrl+O', () => this.open()], ['Recent files…', '', () => this.sessionStore.showRecent().catch((err) => message('Could not open the file', err.message || String(err)))], ['Close', 'Ctrl+W', () => this.closeTab()], '-', ['Compare…', 'COMPARE', () => this.compare()], '-', ['Save', 'Ctrl+S', () => this.save()], ['Save as DXF…', '', () => this.saveAs('dxf')], [() => (this.odaWrite ? 'Save as DWG…' : 'Save as DWG… (experimental)'), '', () => this.saveAs('dwg'), null, () => this.allowDwgSave || this.odaWrite], '-',
        ['Print…', 'Ctrl+P', () => this.print()], ['Plot to PDF…', '', () => this.exportPdf()], ['Publish to PDF…', 'PUBLISH', () => this.publish()], ['Export SVG…', '', () => this.exportSvg()], ['Export PNG image…', '', () => this.exportPng()]]],
      ['Edit', [['Undo', 'Ctrl+Z', () => this.undo()], ['Redo', 'Ctrl+Y', () => this.redo()], '-', ['Copy', 'Ctrl+C', () => this.copySel()], ['Copy with Base Point', 'Ctrl+Shift+C', () => this.copySel(true)], ['Paste', 'Ctrl+V', () => this.paste()], ['Paste as Block', 'Ctrl+Shift+V', () => this.paste('block')], ['Paste to Original Coordinates', 'PASTEORIG', () => this.paste('orig')], ['Delete', 'Del', () => this.deleteSelection()], '-', ['Select all', 'Ctrl+A', () => this.selectAll()], ['Quick Select…', 'QSELECT', () => qselectDialog(this)], ['Select Similar', 'SELECTSIMILAR', () => selectSimilarCommand(this)], ['Find and replace…', 'Ctrl+F', () => this.find.open()], '-', ['Preferences…', '', () => this.preferences()]]],
      ['View', [['Zoom to fit', 'Z, E', () => vp.zoomExtents()], ['Zoom in', '', () => vp.zoomBy(1.4)], ['Zoom out', '', () => vp.zoomBy(1 / 1.4)], '-', ...viewMenuItems(this), '-',
        ['Command history', 'F2', () => this.toggleHistory(), () => this.histView.open],
        ['Side panel', 'Ctrl+3', () => this.setSidePanel(!this.sideShown), () => this.sideShown], '-',
        ['Grid', 'F7', () => this.toggle('grid'), () => this.vp.settings.grid], ['Show lineweights', 'F9', () => this.toggle('lineweights')], ['Model space background: dark', '', () => this.toggle('dark'), () => this.vp.settings.dark], '-',
        ['Dark theme', '', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'), () => this.theme === 'dark'],
        ...PLACEMENTS.map((p) => [`Tool panel: ${p[0].toUpperCase()}${p.slice(1)}`, '', () => this.setToolPlacement(p), () => this.toolPlacement === p]),
        ...TOOL_MODES.map((m) => [`Tool panel layout: ${MODE_LABELS[m]}`, '', () => this.toolModes.setMode(m), () => this.toolModes.mode === m]),
        ['Tool labels', '', () => this.setToolPanel('labels', !this.panelOpts.labels), () => this.panelOpts.labels],
        ['Tool group colours', '', () => this.setToolPanel('colours', !this.panelOpts.colours), () => this.panelOpts.colours],
        ['Tools: Compact', '', () => this.setFolded(compactKeys()), () => foldMode(this.collapsed) === 'compact'],
        ['Tools: Expanded', '', () => this.setFolded([]), () => foldMode(this.collapsed) === 'expanded'],
        ['Customize tools…', '', () => openCustomize(this)],
        ['Quick Access row', '', () => this.setToolLayout(setQuickRow(this.toolLayout, !this.toolLayout.quickRow)), () => this.toolLayout.quickRow], '-',
        ['Show markups', '', () => toggleMarkups(this), () => markupsShown(this.doc)], '-',
        ['External references…', 'XREF', () => xrefPanel(this)]]],
      ['Format', [['Units…', 'UNITS', () => this.unitsDialog()], ['Drafting settings…', 'DSETTINGS', () => draftingSettings(this)], ['Purge…', 'PURGE', () => blockedByEditor(this, 'purge') || purgeDialog(this)], '-',
        ['Load patterns from .pat file…', '', () => this.loadPatterns()], ['Hatch patterns…', '', () => patternsDialog(this, api)]]],
      ['Dimension', [...TOOL_BUTTONS.find(([g]) => g === 'Dimension')[2].map(([id, label, alias]) => [label, alias, () => this.setTool(id)]), '-', ['Dimension style…', 'D', () => this.dimStyles()]]],
      ['Help', [['What this program can and cannot do', '', () => this.limitations()], ['Converter log…', '', () => this.converterLog()], ['About', '', () => this.about()]]],
    ];
    const bar = document.getElementById('menubar');
    for (const [label, items] of M) {
      // an item's optional 4th element makes it a checkable item: () => checked; a label given as a function is read when the menu opens
      const checks = [];
      const item = (it) => {
        const chk = it[3] ? el('span', { class: 'chk' }) : null;
        const text = document.createTextNode(typeof it[0] === 'function' ? it[0]() : it[0]);
        if (typeof it[0] === 'function') checks.push(() => { text.data = it[0](); });
        const b = el('button', { role: it[3] ? 'menuitemcheckbox' : null, onclick: () => { closeMenus(); it[2](); } }, el('span', {}, chk, text), el('kbd', { text: it[1] }));
        if (it[4]) checks.push(() => { b.hidden = !it[4](); });
        if (chk) checks.push(() => { const on = !!it[3](); chk.textContent = on ? '\u2713' : ''; b.setAttribute('aria-checked', String(on)); });
        return b;
      };
      // opens on pointerdown, so the click that only re-focuses the window is not lost; click with detail 0 = keyboard (Enter / Space)
      const toggle = () => { const open = menu.classList.contains('open'); closeMenus(); if (!open) { checks.forEach((f) => f()); menu.classList.add('open'); } };
      const menu = el('div', { class: 'menu' }, el('button', { 'aria-haspopup': 'true', onpointerdown: (e) => { if (e.button === 0) { e.preventDefault(); toggle(); } }, onclick: (e) => { e.stopPropagation(); if (e.detail === 0) toggle(); } }, label),
        el('div', { class: 'drop' }, items.map((it) => (it === '-' ? el('hr') : item(it)))));
      bar.append(menu);
    }
    bar.append(el('span', { class: 'title', id: 'title' }));
    const closeMenus = () => document.querySelectorAll('#menubar .menu.open').forEach((m) => m.classList.remove('open'));
    document.addEventListener('click', closeMenus);
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('#menubar .menu')) closeMenus(); });
  }

  /** fill the toolbar's dimension-style list from the active drawing (only when it changed) */
  refreshDimStyles() {
    const sel = this.dimStyleSel; if (!sel || !this.doc) return;
    const names = dimStyleNames(this.doc), cur = dimVarsOf(this.doc).style;
    if (sel.dataset.names !== names.join('\n')) { sel.replaceChildren(...names.map((n) => el('option', { value: n, text: n }))); sel.dataset.names = names.join('\n'); }
    sel.value = names.find((n) => n.toLowerCase() === cur.toLowerCase()) ?? cur;
  }
  async loadPatterns() { try { await loadPatFile(this, api); } catch (err) { await message('Load hatch patterns', err.message || String(err)); } }
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
    this.patternSel = pat;
    refreshPatternSelect(this);
    const sc = el('input', { type: 'number', step: 'any', min: '0', value: '1', title: 'Hatch scale', style: 'width:100%', onchange: (e) => { const v = Number(e.target.value); if (v > 0) this.defaults.hatchScale = v; } });
    box.append(el('div', { class: 'tgroup', 'data-extra': 'hatch' }, el('div', { class: 'group g-draw', text: 'Hatch' }), el('div', { class: 'xbody' }, pat, sc), moreButton(el, 'Hatch', 'draw')));
    initToolBand(box, () => this.toolPlacement === 'top');
    for (const [id, icon] of [['z-in', 'zoomin'], ['z-out', 'zoomout'], ['z-fit', 'zoomfit']]) { const b = document.getElementById(id); b.setAttribute('aria-label', b.title); b.replaceChildren(iconSvg(icon, 18)); }
  }
  /** (re)build the tool panel's groups from the customized layout (View > Customize tools…), before the Hatch group */
  renderToolPanel() {
    const box = document.getElementById('tools');
    this.toolModes?.close(); // a Compact rail flyout gives its group's tools back first
    for (const g of box.querySelectorAll('.tgroup[data-group]')) g.remove();
    const frag = document.createDocumentFragment();
    buildToolPanel(frag, el, (id) => this.setTool(id), (group, body) => {
      if (group !== 'Dimension') return;
      this.dimStyleSel = el('select', { id: 'dimstyle', title: 'Current dimension style (DIMSTYLE)', onchange: (e) => setCurrentDimStyle(this.doc, e.target.value) });
      body.append(el('div', { class: 'gextra' }, this.dimStyleSel, iconButton(el, 'dimstyle', 'Dim styles…', { class: 'g-annotate', title: 'Dimension Style Manager (D)', onclick: () => this.dimStyles() })));
    }, (key, folded) => {
      this.collapsed = folded ? [...new Set([...this.collapsed, key])] : this.collapsed.filter((k) => k !== key);
      api.settingsSet?.('tools.collapsed', this.collapsed)?.catch?.(() => {});
      this.fitBand();
    }, panelGroups(this.toolLayout));
    box.querySelector('.lbl-toggle').after(frag);
    applyCollapsed(box, this.collapsed);
    for (const b of box.querySelectorAll('button[data-tool]')) b.classList.toggle('active', b.dataset.tool === this.toolId);
    this.refreshDimStyles();
    this.fitBand();
    this.toolModes?.refresh();
  }
  /** Top band: push the groups that do not fit out to "Group ▾" buttons (tool-panel.js fitToolBand) */
  fitBand() { fitToolBand(document.getElementById('tools'), this.toolPlacement === 'top'); }
  /** the Quick Access row under the menu bar: the chosen commands as icon buttons, coloured by group */
  buildQuickAccess() {
    document.getElementById('menubar').after(el('div', { id: 'qat', role: 'toolbar', 'aria-label': 'Quick Access' }));
    this.layerCombo = initLayerCombo(this);
    this.renderQuickAccess();
  }
  renderQuickAccess() {
    const run = { new: () => this.newDrawing(), open: () => this.open(), save: () => this.save(), undo: () => this.undo(), redo: () => this.redo(), zoomfit: () => this.vp.zoomExtents(), layers: () => this.setSidePanel(!this.sideShown) };
    document.getElementById('qat').replaceChildren(...quickRow(this.toolLayout).map((it) => {
      if (it === SEP) return el('span', { class: 'sep' });
      const [key, id] = it, [label, alias] = quickCommand(id);
      return el('button', { class: `g-${key}`, 'data-cmd': id, title: toolTitle(label, alias), 'aria-label': label, onclick: () => (run[id] ? run[id]() : this.setTool(id)) }, iconSvg(id, 18));
    }));
    // the layer combo sits right after the Layers button, or at the end of the row without one
    const qat = document.getElementById('qat'), lb = qat.querySelector('button[data-cmd="layers"]');
    this.layerCombo.close(); if (lb) lb.after(this.layerCombo.el); else qat.append(this.layerCombo.el);
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
    this.fitBand();
    api.settingsSet?.('tools.collapsed', this.collapsed)?.catch?.(() => {});
  }
  /** View > Tool labels / Tool group colours: classes on the panel, saved as settings 'tools.labels' and 'tools.colours' */
  setToolPanel(opt, on, save = true) {
    this.panelOpts = { labels: true, colours: true, ...this.panelOpts, [opt]: !!on };
    document.getElementById('app').classList.toggle('no-tool-labels', !this.panelOpts.labels);
    document.getElementById('tools').classList.toggle('no-colours', !this.panelOpts.colours);
    this.fitBand();
    if (save) api.settingsSet?.(`tools.${opt}`, !!on)?.catch?.(() => {});
  }

  /** View > Tool panel: 'left' (column), 'top' (band above the canvas) or 'hidden'; a class on #app, saved as 'tools.placement' */
  setToolPlacement(place, save = true) {
    this.toolPlacement = place = placementFrom(place);
    if (save && place !== 'left' && this.toolModes && this.toolModes.mode !== 'full') this.toolModes.setMode('full'); // Top band / hidden: a Full panel
    const app = document.getElementById('app');
    for (const p of PLACEMENTS) app.classList.toggle(`tools-${p}`, p === place);
    this.fitBand();
    if (save) api.settingsSet?.('tools.placement', place)?.catch?.(() => {});
  }

  buildStatus() {
    const s = document.getElementById('status');
    const tog = (label, key, title, settings) => {
      const b = el('button', { title, onclick: () => this.toggle(key) }, label); b.dataset.key = key;
      if (settings) b.addEventListener('contextmenu', (e) => { e.preventDefault(); draftingSettings(this); });
      return b;
    };
    s.append(el('span', { class: 'coord', id: 'coord' }), tog('SNAP', 'snap', 'Object snap (F3); right-click: snap settings', true), tog('ORTHO', 'ortho', 'Ortho (F8)'), tog('POLAR', 'polar', 'Polar tracking (F10); right-click: settings', true), tog('OTRACK', 'otrack', 'Object snap tracking (F11)'), tog('GRID', 'grid', 'Drawing grid (F7); settings: GRID command'), tog('LWT', 'lineweights', 'Show lineweights (F9)'), tog('TPY', 'transparency', 'Show transparency'),
      el('span', { class: 'spacer' }),
      el('span', { id: 'conv', hidden: true, role: 'button', tabindex: '0', style: 'margin-right:12px;cursor:pointer', onclick: () => this.converterLog(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.converterLog(); } } }),
      el('span', { id: 'sel' }), el('span', { id: 'units', style: 'margin-left:12px', role: 'button', tabindex: '0', title: 'Drawing units (Format > Units…)', onclick: () => this.unitsDialog(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.unitsDialog(); } } }),
      el('button', { id: 'theme-btn', title: 'Dark theme (View menu)', onclick: () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark') }, 'DARK'));
    this.refreshToggles();
  }
  toggle(key) {
    const st = this.vp.settings;
    if (key === 'dark') { this.setCanvasDark(!st.dark); api.settingsSet?.('canvas.background', st.dark ? 'dark' : 'light')?.catch?.(() => {}); return; }
    st[key] = !st[key];
    if (key === 'transparency') api.settingsSet?.('canvas.transparency', st[key])?.catch?.(() => {});
    if (key === 'snap') api.settingsSet?.('osnap.on', st.snap)?.catch?.(() => {});
    if (key === 'otrack') api.settingsSet?.('otrack.on', st.otrack)?.catch?.(() => {});
    if (key === 'grid') api.settingsSet?.('grid.on', st.grid)?.catch?.(() => {});
    if (key === 'ortho' && st.ortho) st.polar = false;
    if (key === 'polar' && st.polar) st.ortho = false;
    this.refreshToggles(); this.vp.requestRender();
  }
  refreshToggles() {
    for (const b of document.querySelectorAll('#status button[data-key]')) b.classList.toggle('on', !!this.vp.settings[b.dataset.key]);
    const pb = document.querySelector('#status button[data-key="polar"]');
    if (pb) pb.title = `Polar tracking ${this.vp.settings.polarStep}° (F10); right-click: settings`;
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
    document.getElementById('stage').dataset.canvas = dark ? 'dark' : 'light'; // the command history strip reads it
    this.vp.requestRender();
  }
  showCursor(p) { document.getElementById('coord').textContent = p ? `X ${p.x.toFixed(3)}   Y ${p.y.toFixed(3)}` : ''; }
  refreshStatus() {
    document.getElementById('sel').textContent = this.vp.selection.size ? `${this.vp.selection.size} selected` : `${this.doc.entities.length.toLocaleString()} objects`;
    document.getElementById('stage').classList.toggle('empty', this.doc.entities.length === 0);
    const u = (this.active?.doc ?? this.doc).units;
    document.getElementById('units').textContent = `Units: ${UNIT_NAMES[u] ?? (unitLabel(u) || u)}`;
    const conv = this.active?.conversion, ci = document.getElementById('conv');
    if (ci) {
      ci.hidden = !conv;
      if (conv) { const { text, title } = conversionSummary(conv); ci.textContent = text; ci.title = title; }
    }
    refreshMeasureResults();
    renderVpScale(this);
  }
  /** Help > Converter log… (and the status-bar conversion item): how the shown DWG was converted, with the kept log */
  async converterLog() {
    const c = this.active?.conversion;
    if (!c) { await message('Converter log', 'The drawing shown was not converted from a DWG file (DXF files are read directly), so there is no converter log.'); return; }
    const sk = Object.entries(c.skipped ?? {});
    const n = (v) => v.toLocaleString('en-US');
    await message('Converter log', `${this.file.name} was converted from DWG with ${c.converter === 'ODA' ? 'the ODA File Converter' : 'LibreDWG (built-in)'}.`, el('div', {}, [
      el('ul', {}, [`Objects read: ${n(c.objects)}`, `Object types not shown: ${sk.length ? sk.map(([k, v]) => `${n(v)} ${k}`).join(', ') : 'none'}`,
        ...(c.converter === 'ODA' ? [] : [`Converter errors: ${n(c.errorCount)}`])].map((t) => el('li', { text: t }))),
      c.log ? el('pre', { id: 'conv-log', style: 'max-height:50vh;overflow:auto;white-space:pre-wrap', text: c.log }) : el('p', { text: 'The converter wrote no messages.' }),
      c.log && c.log.length >= 256 * 1024 - 4 ? el('p', { style: 'color:var(--dim)', text: 'Only the beginning of the log is kept.' }) : null,
    ]));
  }
  updateTitle() {
    document.getElementById('title').textContent = `${this.session?.dirty ? '• ' : ''}${this.file.name}`;
    this.refreshWindowTitle();
    this.renderTabs();
    this.sessionStore.changed();
  }
  /** window title with the build version (api.version: 0.2.0-beta.N in test builds), so side-by-side builds can be told apart */
  refreshWindowTitle() { if (this.active) api.setTitle?.(windowTitle(this.file.name, this.session?.dirty, this.version)); }
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
        const map = { z: () => this.undo(), y: () => this.redo(), a: () => this.selectAll(), c: () => this.copySel(e.shiftKey), v: () => this.paste(e.shiftKey ? 'block' : 'clip'), s: () => this.save(), o: () => this.open(), n: () => this.newDrawing(), w: () => this.closeTab(), f: () => this.find.open(), p: () => this.print(), 3: () => this.setSidePanel(!this.sideShown) };
        if (map[k]) { e.preventDefault(); map[k](); }
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('#menubar')) return; // let a focused menu button / item activate by keyboard
      if (e.key === 'F2') { if (e.target.closest?.('#layers')) return; e.preventDefault(); this.toggleHistory(); return; }
      if (e.key === 'F3') { e.preventDefault(); this.toggle('snap'); return; }
      if (e.key === 'F7') { e.preventDefault(); this.toggle('grid'); return; }
      if (e.key === 'F8') { e.preventDefault(); this.toggle('ortho'); return; }
      if (e.key === 'F9') { e.preventDefault(); this.toggle('lineweights'); return; }
      if (e.key === 'F10') { e.preventDefault(); this.toggle('polar'); return; }
      if (e.key === 'F11') { e.preventDefault(); this.toggle('otrack'); return; }
      if (e.key === 'Escape' && this.histView.open) { e.preventDefault(); this.toggleHistory(false); return; }
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
