// ASH Draw Studio - application controller: wires the viewport, tools, panels, menus and files together.
import { newDocument } from '../src/core/model.js';
import { Session, eraseEntities, copyToClipboard, pasteEntities } from '../src/core/edit.js';
import { parseCoordinate } from '../src/core/coords.js';
import { PATTERN_NAMES } from '../src/core/patterns.js';
import { layIsolate, layUnisolate, layFreeze, layOn, layThaw } from '../src/core/layers.js';
import { Viewport, CANVAS_BG } from './viewport.js';
import { createTools, TOOL_ALIASES } from './tools.js';
import { el, message, modal, confirmDialog, textDialog, toast, renderLayers, renderProperties } from './ui.js';
import {
  OPEN_FILTERS, loadDrawing, saveDxf, saveDwg, verificationMessage, exportSvgBytes, exportPdfBytes, exportPngBytes, buildScene, baseName, extOf, UNIT_NAMES,
} from './files.js';

const api = window.api;

const TOOL_BUTTONS = [
  ['Select', [['select', 'Select']]],
  ['Draw', [['line', 'Line', 'L'], ['pline', 'Polyline', 'PL'], ['rect', 'Rectangle', 'REC'], ['circle', 'Circle', 'C'], ['arc', 'Arc', 'A'], ['ellipse', 'Ellipse', 'EL'], ['point', 'Point', 'PO'], ['text', 'Text', 'T'], ['hatch', 'Hatch', 'H']]],
  ['Modify', [['move', 'Move', 'M'], ['copy', 'Copy', 'CO'], ['rotate', 'Rotate', 'RO'], ['scale', 'Scale', 'SC'], ['mirror', 'Mirror', 'MI'], ['offset', 'Offset', 'O'], ['trim', 'Trim', 'TR'], ['extend', 'Extend', 'EX'], ['explode', 'Explode', 'X'], ['erase', 'Erase', 'E']]],
  ['Inquiry', [['measure', 'Measure', 'DI']]],
];

class App {
  constructor() {
    this.state = { layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1 };
    this.defaults = { textHeight: null, hatchPattern: 'ANSI31', hatchScale: 1, hatchAngle: 0 };
    this.file = { path: null, name: 'Untitled.dxf', format: 'dxf' };
    this.clip = [];
    this.lastTool = 'line';
    this.theme = 'light';        // UI theme; light by default, the choice is saved as setting 'theme'
    this.canvasOverride = false; // true once View > Light / dark background makes the canvas differ from the theme
    this.vp = new Viewport(document.getElementById('cv'));
    this.tools = createTools(this);
    this.toolId = null;
    this.buildMenus();
    this.buildToolbar();
    this.buildStatus();
    this.bindKeys();
    this.bindDrop();
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
    window.addEventListener('beforeunload', (e) => { if (this.session?.dirty) { e.preventDefault(); e.returnValue = ''; } });
    this.newDrawing(true);
    this.setTool('select');
    this.setTheme('light', false);
    api.settingsGet?.('theme').then((t) => { if (t === 'dark') this.setTheme('dark', false); }).catch(() => {});
    api.onOpenFile?.((f) => this.openFromFile(f));
    api.getLaunchFiles?.().then((files) => { if (files?.[0]) this.openFromFile(files[0]); }).catch(() => {});
  }

  // ---- host interface for tools ---------------------------------------------------------------
  get session() { return this.vp.session; }
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
    const sys = { u: () => this.undo(), undo: () => this.undo(), redo: () => this.redo(), ze: () => this.vp.zoomExtents(), z: () => this.vp.zoomExtents(), 'zoom': () => this.vp.zoomExtents(), all: () => this.selectAll(), new: () => this.newDrawing(), open: () => this.open(), save: () => this.save(), saveas: () => this.saveAs('dxf'), pdf: () => this.exportPdf(), ...this.layerCommands() };
    if (sys[low]) { sys[low](); return; }
    const last = this.vp.lastPoint ?? { x: 0, y: 0 };
    const dir = this.vp.lastPoint ? { x: this.vp.cursor.x - last.x, y: this.vp.cursor.y - last.y } : null;
    const pt = parseCoordinate(s, last, dir);
    if (pt && Number.isFinite(pt.x) && this.toolId !== 'select') { this.vp.cursor = { x: pt.x, y: pt.y }; t.click({ x: pt.x, y: pt.y }); this.refreshPrompt(); this.vp.requestRender(); return; }
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
  async confirmDiscard() {
    if (!this.session?.dirty) return true;
    const r = await confirmDialog('Unsaved changes', `Save changes to ${this.file.name}?`, 'Save', "Don't save", 'Cancel');
    if (r === 'yes') return this.save();
    return r === 'no';
  }
  installDoc(doc, file) {
    const session = new Session(doc);
    this.state.layer = doc.layers.has('0') ? '0' : [...doc.layers.keys()][0];
    this.file = file;
    this.vp.setSession(session);
    this.refreshPanels(); this.refreshStatus(); this.updateTitle();
  }
  async newDrawing(silent = false) {
    if (!silent && !(await this.confirmDiscard())) return;
    const doc = newDocument(); doc.units = 4;
    this.installDoc(doc, { path: null, name: 'Untitled.dxf', format: 'dxf' });
  }
  async open() {
    if (!(await this.confirmDiscard())) return;
    let files;
    try { files = await api.openFiles({ filters: OPEN_FILTERS }); } catch (err) { toast(`Could not open: ${err.message}`); return; }
    if (files?.[0]) await this.loadFile(files[0]);
  }
  /** a file handed over by the desktop shell (double-click, "Open with", second launch): {path, name} without bytes */
  async openFromFile(f) {
    if (!(await this.confirmDiscard())) return;
    try { if (!f.bytes) f = { ...f, bytes: await api.readFile(f.path) }; } catch (err) { await message('Cannot open this file', err.message || String(err)); return; }
    await this.loadFile(f);
  }
  async loadFile(f) {
    toast(`Opening ${f.name} …`, 60000);
    try {
      const { doc, format, notes } = await loadDrawing(api, f.name, f.bytes);
      this.installDoc(doc, { path: f.path ?? null, name: f.name, format });
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
  async exportPdf() {
    const size = el('select', {}, ['fit|Fit to drawing', 'A4|A4', 'A3|A3', 'A2|A2', 'A1|A1', 'A0|A0', 'Letter|Letter'].map((s) => { const [v, l] = s.split('|'); return el('option', { value: v, text: l }); }));
    size.value = 'A3';
    const ori = el('select', {}, ['auto|Automatic', 'landscape|Landscape', 'portrait|Portrait'].map((s) => { const [v, l] = s.split('|'); return el('option', { value: v, text: l }); }));
    const mono = el('input', { type: 'checkbox' }), lw = el('input', { type: 'checkbox', checked: true });
    const r = await modal('Export PDF', [el('label', {}, 'Page size'), size, el('label', {}, 'Orientation'), ori,
      el('label', {}, mono, ' Black and white'), el('label', {}, lw, ' Use lineweights'),
      el('p', { text: 'The drawing is exported as vector graphics, scaled to fit the page. Text outside the Western Latin character set (for example Arabic) cannot be drawn in this version.' })],
    [{ label: 'Export', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
    if (r !== 'ok') return;
    try {
      const out = await exportPdfBytes(this.doc, this.scene(), { pageSize: size.value, orientation: ori.value, monochrome: mono.checked, lineweights: lw.checked });
      await this.saveBytes(out.bytes, 'pdf', 'PDF document');
      if (out.warnings.length) await message('PDF exported with warnings', out.warnings.join('\n'));
    } catch (err) { await message('Export failed', err.message || String(err)); }
  }
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
      ['File', [['New', 'Ctrl+N', () => this.newDrawing()], ['Open…', 'Ctrl+O', () => this.open()], '-', ['Save', 'Ctrl+S', () => this.save()], ['Save as DXF…', '', () => this.saveAs('dxf')], ['Save as DWG… (experimental)', '', () => this.saveAs('dwg')], '-',
        ['Export PDF…', '', () => this.exportPdf()], ['Export SVG…', '', () => this.exportSvg()], ['Export PNG image…', '', () => this.exportPng()]]],
      ['Edit', [['Undo', 'Ctrl+Z', () => this.undo()], ['Redo', 'Ctrl+Y', () => this.redo()], '-', ['Copy', 'Ctrl+C', () => this.copySel()], ['Paste', 'Ctrl+V', () => this.paste()], ['Delete', 'Del', () => this.deleteSelection()], '-', ['Select all', 'Ctrl+A', () => this.selectAll()]]],
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
      for (const [id, label, alias] of items) box.append(el('button', { 'data-tool': id, title: alias ? `${label} (${alias})` : label, onclick: () => this.setTool(id) }, label));
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
  }

  // ---- keyboard / drop ------------------------------------------------------------------------------
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (document.getElementById('dlg').open) return;
      const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (ctrl) {
        if (typing && !['s', 'o', 'n'].includes(k)) return;
        const map = { z: () => this.undo(), y: () => this.redo(), a: () => this.selectAll(), c: () => this.copySel(), v: () => this.paste(), s: () => this.save(), o: () => this.open(), n: () => this.newDrawing() };
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
      if (await this.confirmDiscard()) await this.loadFile({ path: null, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    });
  }
}

window.app = new App();
