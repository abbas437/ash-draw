// ASH Draw Studio - the Symbols section of the side panel (source, category, search, lazy thumbnail grid, scales) and
// SYMBOLINSERT: the chosen symbol follows the cursor, click to place, then the rotation (typed angle, second click,
// Enter = 0); placement repeats until Esc / right-click. Each placement is one undo step (insertSymbol).
// Settings: 'symbols.scale' (overall symbol scale) and 'symbols.drawingScale' (N of 1:N, paper-size symbols only);
// 'symbols.view' (grid / list / float) and 'symbols.float' ({x, y, w, h} of the floating window); 'symbols.dock' (side / left /
// right / float / hidden), 'symbols.dockWidth' and 'symbols.dockFolded' (the column beside the canvas); 'symbols.recent'
// (the last RECENT_MAX symbols inserted from the panel or the Quick Access palette, symbol-palette.js).
import { createSymbolSource, BUILTIN_SOURCE } from './symbols-source.js';
import { symbolScale, symbolPolylines, insertSymbol } from '../src/core/symbols-lib.js';
import { attdefsOf, ATT_CONSTANT, ATT_PRESET } from '../src/core/blocks.js';
import { attribValuesDialog } from './tools-blocks.js';
import { el, modal } from './ui.js';
import { iconHtml } from './icons.js';
import { applySide, closeSideFly } from './side-panel.js';

/** cells drawn at most; the status line says when a filter would show more */
export const SYMBOL_GRID_MAX = 500;
const num = (s) => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) && String(s).trim() !== '' ? v : null; };
const posOr = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** items of `items` in `category` ('' = all) whose name contains `query` (case-insensitive) */
export const filterSymbols = (items, category, query) => {
  const q = String(query ?? '').trim().toLowerCase();
  return items.filter((it) => (!category || it.category === category) && (!q || it.name.toLowerCase().includes(q)));
};

/** Symbols layouts: grid (docked), list (docked, one row per symbol), float (own window inside the app) */
export const SYMBOL_VIEWS = ['grid', 'list', 'float'];
export const symbolViewFrom = (v) => (SYMBOL_VIEWS.includes(v) ? v : 'grid');
/** the floating window {x, y, w, h} kept inside a winW x winH window: size first (min 220 x 160), then position */
/** where the Symbols panel is (setting 'symbols.dock'): a section of the side panel, its own column left / right of the
 * canvas, the floating window, or hidden (SYMBOLS shows it again) */
export const SYMBOL_DOCKS = ['side', 'left', 'right', 'float', 'hidden'];
export const DOCK_LABELS = { side: 'Dock in side panel', left: 'Dock left', right: 'Dock right', float: 'Float', hidden: 'Hide' };
/** saved 'symbols.dock' and 'symbols.view' -> dock; never set: an older build's 'float' view floats, else the side panel */
export const symbolDockFrom = (dock, view) => (SYMBOL_DOCKS.includes(dock) ? dock : view === 'float' ? 'float' : 'side');
/** docked column width in px (setting 'symbols.dockWidth'): default 280, user range 180 .. half the window */
export const SYM_DOCK_W = 280, SYM_DOCK_MIN = 180;
export const symDockWidthClamp = (w, winW) => Math.round(Math.max(SYM_DOCK_MIN, Math.min(Number.isFinite(Number(w)) && w !== null && w !== '' ? Number(w) : SYM_DOCK_W, Math.max(SYM_DOCK_MIN, winW / 2))));
export const floatRectClamp = (r, winW, winH) => {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const w = Math.round(Math.min(Math.max(n(r?.w, 320), 220), winW)), h = Math.round(Math.min(Math.max(n(r?.h, 460), 160), winH));
  return { x: Math.round(Math.min(Math.max(n(r?.x, winW - w - 60), 0), winW - w)), y: Math.round(Math.min(Math.max(n(r?.y, 90), 0), winH - h)), w, h };
};

/** a library file with several symbols: pick one (null = cancelled) */
async function chooseSymbol(file, syms) {
  const list = el('select', { name: 'symbol', size: Math.min(10, Math.max(2, syms.length)), style: 'width:18em' }, syms.map((s, i) => el('option', { value: String(i), text: s.name })));
  list.value = '0';
  list.ondblclick = () => list.closest('dialog')?.querySelector('button')?.click();
  const r = await modal(`${file}: ${syms.length} symbols`, el('div', {}, list), [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  return r === 'ok' ? syms[Number(list.value)] ?? null : null;
}

/** 'symbols.recent' holds at most this many {sourceId, file, name}, most recent first; file is the item's key (the file's
 * path in its folder, or the built-in symbol's id) */
export const RECENT_MAX = 8;
/** `list` with `entry` moved (or added) to the front, at most RECENT_MAX */
export const recentWith = (list, entry) => [entry, ...(Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && !(r.sourceId === entry.sourceId && r.file === entry.file))].slice(0, RECENT_MAX);
let recentQ = Promise.resolve(); // one read-modify-write at a time
const recordRecent = (api, source, item) => {
  recentQ = recentQ.then(async () => {
    const cur = await api.settingsGet?.('symbols.recent');
    await api.settingsSet?.('symbols.recent', recentWith(cur, { sourceId: source.id, file: item.key, name: item.name }));
  }).catch(() => {});
  return recentQ;
};

/** insert the symbol of `item` (from `source`): SYMBOLINSERT with it, after a pick when the file holds several; adds it to
 * 'symbols.recent'. The panel's cells and the Quick Access palette's go through here. */
export async function pickSymbol(app, api, src, source, item) {
  let syms;
  try { syms = await src.loadSymbol(source, item); } catch (err) { app.toast(`Symbols: ${err.message}`); return; }
  const sym = syms.length > 1 ? await chooseSymbol(item.file ?? item.name, syms) : syms[0];
  if (!sym) { if (!syms.length) app.toast(`Symbols: ${item.name} has nothing to insert.`); return; }
  recordRecent(api, source, item);
  app.tools.symbolinsert.use(sym);
  app.setTool('symbolinsert');
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result); r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
/** lazy thumbnails for symbol cells (symbolCell): a cell's thumbnail loads when it comes within 120px of `root`'s view
 * (null = the window). reset() before rebuilding the cells drops the loads still pending. */
export function lazyThumbs(src, root) {
  let gen = 0;
  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { observer.unobserve(en.target); load(en.target); }
  }, { root, rootMargin: '120px' });
  function load(cell) {
    const g = gen;
    src.thumbnail(cell._source, cell._item).then((blob) => {
      if (g !== gen) return;
      cell.classList.remove('loading');
      if (!blob) { cell.classList.add('nothumb'); return; }
      // a data: URL (not a blob: URL) so a thumbnail whose cell is replaced mid-load (grid rebuilt) leaves no
      // aborted request and nothing to revoke
      return blobToDataUrl(blob).then((url) => {
        if (g !== gen) return;
        const img = cell.querySelector('img');
        img.onload = () => cell.classList.add('ready');
        img.src = url;
      });
    }).catch(() => { if (g === gen) { cell.classList.remove('loading'); cell.classList.add('nothumb'); } });
  }
  return { reset() { gen++; observer.disconnect(); }, observe(cell) { observer.observe(cell); } };
}
/** a thumbnail cell (button) for `item` of `source`; lazyThumbs(...).observe(cell) loads its picture */
export function symbolCell(source, item, onclick) {
  const cell = el('button', { type: 'button', class: 'sym-cell loading', title: item.file ?? item.name, 'data-key': item.key },
    el('span', { class: 'sym-pic' }, el('img', { class: 'sym-thumb', alt: '', draggable: 'false' })), el('span', { class: 'sym-name', text: item.name }));
  cell._item = item; cell._source = source;
  cell.onclick = onclick;
  return cell;
}

export function initSymbolsPanel(app, api) {
  const src = createSymbolSource(api);
  const $ = (id) => document.getElementById(id);
  const srcSel = $('sym-source'), catSel = $('sym-cat'), search = $('sym-search'), grid = $('sym-grid'), status = $('sym-status');
  const scaleIn = $('sym-scale'), dscaleIn = $('sym-dscale'), addBtn = $('sym-add'), remBtn = $('sym-remove');
  const st = { sources: [BUILTIN_SOURCE], source: BUILTIN_SOURCE, items: [], truncated: false, scale: 1, drawingScale: 1 };
  const thumbs = lazyThumbs(src, grid);

  const catLabel = (c) => (c ? c.split('/').join(' › ') : '(top level)');
  function renderCats() {
    const cats = [...new Set(st.items.map((i) => i.category ?? ''))].sort((a, b) => a.localeCompare(b));
    const keep = catSel.value;
    catSel.replaceChildren(el('option', { value: '', text: 'All categories' }), ...cats.map((c) => el('option', { value: c, text: catLabel(c) })));
    catSel.value = cats.includes(keep) ? keep : '';
  }
  function renderGrid() {
    thumbs.reset();
    const shown = filterSymbols(st.items, catSel.value, search.value), source = st.source;
    const cells = shown.slice(0, SYMBOL_GRID_MAX).map((item) => symbolCell(source, item, () => pickSymbol(app, api, src, source, item)));
    grid.replaceChildren(...cells);
    for (const c of cells) thumbs.observe(c);
    const total = st.items.length;
    let s = shown.length === total ? `${total} symbol${total === 1 ? '' : 's'}` : `${shown.length} of ${total} symbols`;
    if (shown.length > SYMBOL_GRID_MAX) s += ` — first ${SYMBOL_GRID_MAX} shown, refine the search`;
    if (st.truncated) s += ' — folder listing truncated (too many files)';
    status.textContent = s;
  }
  async function showSource(source) {
    st.source = source; srcSel.value = source.id; remBtn.disabled = source.kind === 'builtin';
    status.textContent = 'Loading…';
    try {
      const items = await src.listSymbols(source);
      if (st.source !== source) return;
      st.items = items; st.truncated = !!items.truncated;
    } catch (err) { st.items = []; st.truncated = false; app.toast(`Symbols: ${err.message}`); }
    renderCats(); renderGrid();
  }
  async function refreshSources(pickId) {
    st.sources = await src.listSources().catch(() => [BUILTIN_SOURCE]);
    srcSel.replaceChildren(...st.sources.map((s) => el('option', { value: s.id, text: s.kind === 'builtin' ? s.name : `Folder: ${s.name}` })));
    await showSource(st.sources.find((s) => s.id === pickId) ?? st.sources[0]);
  }
  srcSel.onchange = () => showSource(st.sources.find((s) => s.id === srcSel.value) ?? BUILTIN_SOURCE);
  catSel.onchange = renderGrid;
  search.oninput = renderGrid;
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; renderGrid(); } e.stopPropagation(); });
  addBtn.onclick = async () => {
    let f; try { f = await src.addFolder(); } catch (err) { app.toast(`Symbols: ${err.message}`); return; }
    if (f) await refreshSources(f.id);
  };
  remBtn.onclick = async () => {
    const s = st.source; if (s.kind === 'builtin') return;
    await src.removeFolder(s).catch((err) => app.toast(`Symbols: ${err.message}`));
    await refreshSources(BUILTIN_SOURCE.id);
  };
  const bindScale = (input, key, field) => {
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.onchange = () => {
      const v = num(input.value);
      if (!(v > 0)) { input.value = String(st[field]); app.toast('Symbols: the scale must be a number above 0.'); return; }
      st[field] = v; api.settingsSet?.(key, v)?.catch?.(() => {});
    };
    api.settingsGet?.(key).then((v) => { st[field] = posOr(v, 1); input.value = String(st[field]); }).catch(() => {});
  };
  scaleIn.value = '1'; dscaleIn.value = '1';
  bindScale(scaleIn, 'symbols.scale', 'scale');
  bindScale(dscaleIn, 'symbols.drawingScale', 'drawingScale');
  refreshSources(BUILTIN_SOURCE.id);

  // the ⋯ menu: Add folder… / Remove folder (keeps the source row on one line in a narrow panel)
  const more = $('sym-more'), menu = $('sym-menu');
  const showMenu = (on) => {
    menu.hidden = !on; more.setAttribute('aria-expanded', String(on));
    if (on) { const r = more.getBoundingClientRect(); menu.style.left = `${Math.max(0, r.right - 160)}px`; menu.style.top = `${r.bottom + 2}px`; menu.style.minWidth = '160px'; }
  };
  more.onclick = (e) => { e.stopPropagation(); showMenu(menu.hidden); };
  menu.addEventListener('click', () => showMenu(false));
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest?.('#sym-menu, #sym-more')) showMenu(false); }, true);
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); showMenu(false); more.focus(); } });

  // layouts: grid / list wherever the panel is. Where it is ('symbols.dock'): a section of the side panel, its own column
  // left or right of the canvas (#sym-dock: drag its inner edge, fold it to a strip), the floating window, or hidden.
  // The same #sym-panel element moves between them, so its listeners keep working.
  const panel = $('sym-panel'), home = panel.parentElement, closeBtn = $('sym-float-close'), appEl = $('app');
  const box = el('div', { id: 'sym-float', role: 'dialog', 'aria-label': 'Symbols' });
  box.hidden = true;
  appEl.append(box);
  const foldBtn = el('button', { type: 'button', id: 'sym-dock-fold' });
  const grip = el('div', { id: 'sym-dock-grip', title: 'Drag to resize the Symbols panel' });
  const dockEl = el('aside', { id: 'sym-dock', 'aria-label': 'Symbols' }, foldBtn, grip);
  $('main').append(dockEl);
  let view = 'grid', dock = 'side', lastDock = 'side', lastShown = 'side', folded = false, dockW = SYM_DOCK_W, rect = null, saveT = 0;
  const viewBtns = SYMBOL_VIEWS.map((v) => {
    const b = $(`sym-view-${v}`);
    b.innerHTML = iconHtml(`view-${v}`, 16);
    b.onclick = () => (v === 'float' ? setDock('float') : setView(v));
    return b;
  });
  const syncViewBtns = () => viewBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SYMBOL_VIEWS[i] === 'float' ? dock === 'float' : dock !== 'float' && SYMBOL_VIEWS[i] === view)));
  const saveRect = () => { clearTimeout(saveT); saveT = setTimeout(() => api.settingsSet?.('symbols.float', rect)?.catch?.(() => {}), 300); };
  const place = () => {
    rect = floatRectClamp(rect, window.innerWidth, window.innerHeight);
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  };
  /** grid / list (setting 'symbols.view'); 'float' (the older setting value) moves the panel to the floating window */
  function setView(v, save = true) {
    if (v === 'float') { setDock('float', save); return; }
    view = symbolViewFrom(v);
    panel.classList.toggle('view-list', view === 'list');
    syncViewBtns();
    if (save) api.settingsSet?.('symbols.view', view)?.catch?.(() => {});
  }
  const columned = () => dock === 'left' || dock === 'right';
  function renderFold() {
    appEl.classList.toggle('sym-dock-folded', folded && columned());
    foldBtn.textContent = (dock === 'left') === folded ? '»' : '«';
    foldBtn.title = folded ? 'Expand the Symbols panel' : 'Collapse the Symbols panel to a strip';
    foldBtn.setAttribute('aria-label', foldBtn.title);
    foldBtn.setAttribute('aria-expanded', String(!folded));
  }
  function setFolded(on, save = true) {
    folded = !!on; renderFold();
    if (save) api.settingsSet?.('symbols.dockFolded', folded)?.catch?.(() => {});
  }
  const setWidth = (w) => { dockW = symDockWidthClamp(w, window.innerWidth); appEl.style.setProperty('--symdock-user', `${dockW}px`); };
  /** side / left / right / float / hidden, saved as 'symbols.dock'; the canvas follows through the viewport's ResizeObserver */
  function setDock(d, save = true) {
    const prev = dock;
    dock = SYMBOL_DOCKS.includes(d) ? d : 'side';
    if (dock !== 'float' && dock !== 'hidden') lastDock = dock;
    if (dock !== 'hidden') lastShown = dock;
    if (dock !== 'side') {
      if (app.sideFolded?.includes('symbols')) app.foldSideSection('symbols', false);
      if (app.sideFly === 'symbols') closeSideFly(app);
      panel.classList.remove('folded', 'fly');
    }
    if (dock === 'float') { box.append(panel); box.hidden = false; place(); } else box.hidden = true;
    if (dock === 'side') { if (panel.parentElement !== home) home.insertBefore(panel, home.querySelector('.panel[data-sec="props"]')); } else if (dock !== 'float') dockEl.append(panel);
    appEl.classList.toggle('sym-dock-left', dock === 'left');
    appEl.classList.toggle('sym-dock-right', dock === 'right');
    renderFold(); syncViewBtns();
    closeBtn.hidden = !(dock === 'float' || columned());
    closeBtn.title = dock === 'float' ? `Close: dock the symbols back ${lastDock === 'side' ? 'in the side panel' : `on the ${lastDock}`}` : 'Close the Symbols panel (SYMBOLS opens it again)';
    for (const b of dockMenu.children) b.setAttribute('aria-checked', String(b.dataset.dock === dock));
    if (prev === 'side' || dock === 'side') applySide(app);
    if (!save) return;
    api.settingsSet?.('symbols.dock', dock)?.catch?.(() => {});
    // older builds read only 'symbols.view': 'float' there still floats the panel
    if (dock === 'float' || prev === 'float') api.settingsSet?.('symbols.view', dock === 'float' ? 'float' : view)?.catch?.(() => {});
  }
  closeBtn.onclick = () => setDock(dock === 'float' ? lastDock : 'hidden');
  foldBtn.onclick = () => setFolded(!folded);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
    const r = dockEl.getBoundingClientRect();
    const move = (ev) => setWidth(dock === 'left' ? ev.clientX - r.left : r.right - ev.clientX);
    const up = () => {
      grip.classList.remove('drag'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      api.settingsSet?.('symbols.dockWidth', dockW)?.catch?.(() => {});
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  // the header's ⋯ menu: Dock in side panel / Dock left / Dock right / Float / Hide
  const dockMore = el('button', { type: 'button', id: 'sym-dock-more', title: 'Where the Symbols panel goes: side panel, left, right, floating or hidden', 'aria-label': 'Symbols panel position', 'aria-haspopup': 'menu', 'aria-expanded': 'false', text: '⋯' });
  const dockMenu = el('div', { id: 'sym-dock-menu', class: 'popmenu', role: 'menu', hidden: true });
  const showDockMenu = (on) => {
    dockMenu.hidden = !on; dockMore.setAttribute('aria-expanded', String(on));
    if (on) { const r = dockMore.getBoundingClientRect(); dockMenu.style.left = `${Math.max(0, Math.min(r.right - 170, window.innerWidth - 174))}px`; dockMenu.style.top = `${r.bottom + 2}px`; dockMenu.style.minWidth = '170px'; }
  };
  dockMenu.append(...SYMBOL_DOCKS.map((d) => el('button', { type: 'button', role: 'menuitemradio', 'data-dock': d, text: DOCK_LABELS[d], onclick: () => { showDockMenu(false); setDock(d); if (d !== 'hidden') search.focus(); } })));
  closeBtn.before(dockMore);
  document.body.append(dockMenu);
  dockMore.onclick = (e) => { e.stopPropagation(); showDockMenu(dockMenu.hidden); };
  document.addEventListener('pointerdown', (e) => { if (!dockMenu.hidden && !e.target.closest?.('#sym-dock-menu, #sym-dock-more')) showDockMenu(false); }, true);
  dockMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); showDockMenu(false); dockMore.focus(); } });
  panel.querySelector('.phead').addEventListener('pointerdown', (e) => {
    if (dock !== 'float' || e.button !== 0 || e.target.closest('button, select, input')) return;
    e.preventDefault();
    const head = e.currentTarget, dx = e.clientX - rect.x, dy = e.clientY - rect.y;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { rect = { ...rect, x: ev.clientX - dx, y: ev.clientY - dy }; place(); };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); saveRect(); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  new ResizeObserver(() => {
    if (dock !== 'float' || box.hidden || !rect) return;
    const w = box.offsetWidth, h = box.offsetHeight;
    if (w !== rect.w || h !== rect.h) { rect = { ...rect, w, h }; saveRect(); }
  }).observe(box);
  window.addEventListener('resize', () => { setWidth(dockW); if (dock === 'float') { place(); saveRect(); } }); // snap back inside a smaller window
  setWidth(SYM_DOCK_W);
  setView('grid', false);
  setDock('side', false);
  Promise.all(['symbols.float', 'symbols.view', 'symbols.dock', 'symbols.dockWidth', 'symbols.dockFolded'].map((k) => api.settingsGet?.(k)))
    .then(([r, v, d, w, f]) => {
      if (r && typeof r === 'object') rect = r;
      if (w != null) setWidth(w);
      folded = f === true;
      setView(v === 'float' ? 'grid' : v, false);
      setDock(symbolDockFrom(d, v), false);
    }).catch(() => {});

  return {
    /** the symbol source (createSymbolSource) the panel lists from; the Quick Access palette shares it and its caches */
    src,
    /** the INSERT scale of `sym` in the current drawing */
    scaleOf: (sym) => symbolScale(sym, app.doc.units, { scale: st.scale, drawingScale: st.drawingScale }),
    focus() { search.focus(); },
    /** SYMBOLS / the rail when the panel is not in the side panel: show it where it was last (unfolded) and focus the search */
    show() { if (dock === 'hidden') setDock(lastShown); if (folded && columned()) setFolded(false); search.focus(); },
    /** side / left / right / float / hidden (setting 'symbols.dock') */
    get dock() { return dock; },
    setDock,
    /** the Symbols section is in its floating window */
    get floating() { return dock === 'float'; },
    /** N of the drawing scale 1:N (setting 'symbols.drawingScale') */
    get drawingScale() { return st.drawingScale; },
  };
}

/** SYMBOLINSERT (picked from the Symbols panel); `Tool` from tools.js (factory: this module does not import tools.js) */
export function createSymbolTools(h, { Tool }) {
  class SymbolInsertTool extends Tool {
    constructor(host) { super(host); this.sym = null; }
    /** the symbol the next activation places */
    use(sym) { this.sym = sym; this.pls = null; }
    get prompt() {
      if (!this.sym) return 'SYMBOLINSERT  pick a symbol in the Symbols panel';
      return this.at ? `SYMBOLINSERT  ${this.sym.name}: rotation angle <0>` : `SYMBOLINSERT  ${this.sym.name}: specify insertion point (Esc to end)`;
    }
    activate() {
      super.activate();
      this.at = null; this.cur = null; this.busy = false;
      if (!this.sym) { this.h.toast('Pick a symbol in the Symbols panel (SYMBOLS).'); this.cancel(); }
    }
    deactivate() { super.deactivate(); this.at = null; this.cur = null; }
    move(p) { if (this.sym) { this.cur = p; this.vp.requestRender(); } }
    rotFrom(p) { return this.at ? Math.atan2(p.y - this.at.y, p.x - this.at.x) * 180 / Math.PI : 0; }
    draw(c) {
      if (!this.sym || !this.cur) return;
      if (!this.pls) this.pls = symbolPolylines(this.sym, 0).slice(0, 2000);
      const at = this.at ?? this.cur, k = h.symbolsPanel?.scaleOf(this.sym) ?? 1;
      const a = (this.at ? this.rotFrom(this.cur) : 0) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
      const b = this.sym.base ?? { x: 0, y: 0 };
      const tf = (q) => { const x = (q.x - b.x) * k, y = (q.y - b.y) * k; return { x: at.x + x * cs - y * sn, y: at.y + x * sn + y * cs }; };
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); c.lineWidth = 1;
      for (const pl of this.pls) this.poly(c, pl.map(tf));
      c.setLineDash([]);
      if (this.at) this.line(c, this.at, this.cur);
    }
    click(p) {
      if (!this.sym || this.busy) return;
      if (!this.at) { this.at = { x: p.x, y: p.y }; this.vp.lastPoint = this.at; this.h.refreshPrompt(); return; }
      this.place(this.rotFrom(p));
    }
    text(s) {
      if (!this.at) return false;
      const v = num(s);
      if (v === null) { this.h.toast('SYMBOLINSERT: type the rotation angle in degrees (Enter = 0).'); return true; }
      this.place(v); return true;
    }
    key(e) {
      if (e.key === 'Escape') { this.cancel(); return true; }
      if (e.key === 'Enter' || e.key === ' ') { if (this.at) this.place(0); else this.cancel(); return true; }
      return false;
    }
    rightClick() { if (this.at) this.place(0); else this.cancel(); }
    async place(rot) {
      const sym = this.sym, at = this.at;
      if (!sym || !at || this.busy) return;
      const ask = attdefsOf(sym).filter((d) => !(d.attdef.flags & (ATT_CONSTANT | ATT_PRESET)));
      this.busy = true;
      const values = ask.length ? await attribValuesDialog(`Attributes — ${sym.name}`, ask) : {};
      this.busy = false;
      if (h.tool !== this) return; // ended while the dialog was open
      if (values) insertSymbol(h.session, sym, at, { ...this.props(), rot, scale: h.symbolsPanel?.scaleOf(sym) ?? 1, values });
      this.at = null; this.vp.lastPoint = null;
      this.h.refreshPrompt(); this.vp.requestRender();
    }
  }
  return { symbolinsert: new SymbolInsertTool(h) };
}
