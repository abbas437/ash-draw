// ASH Draw Studio - the Symbols section of the side panel (source, category, search, lazy thumbnail grid, scales) and
// SYMBOLINSERT: the chosen symbol follows the cursor, click to place, then the rotation (typed angle, second click,
// Enter = 0); placement repeats until Esc / right-click. Each placement is one undo step (insertSymbol).
// Settings: 'symbols.scale' (overall symbol scale) and 'symbols.drawingScale' (N of 1:N, paper-size symbols only);
// 'symbols.view' (grid / list / float) and 'symbols.float' ({x, y, w, h} of the floating window).
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

export function initSymbolsPanel(app, api) {
  const src = createSymbolSource(api);
  const $ = (id) => document.getElementById(id);
  const srcSel = $('sym-source'), catSel = $('sym-cat'), search = $('sym-search'), grid = $('sym-grid'), status = $('sym-status');
  const scaleIn = $('sym-scale'), dscaleIn = $('sym-dscale'), addBtn = $('sym-add'), remBtn = $('sym-remove');
  const st = { sources: [BUILTIN_SOURCE], source: BUILTIN_SOURCE, items: [], truncated: false, gen: 0, scale: 1, drawingScale: 1 };

  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { observer.unobserve(en.target); loadThumb(en.target); }
  }, { root: grid, rootMargin: '120px' });

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result); r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  function loadThumb(cell) {
    const gen = st.gen, item = cell._item, source = st.source;
    src.thumbnail(source, item).then((blob) => {
      if (gen !== st.gen) return;
      cell.classList.remove('loading');
      if (!blob) { cell.classList.add('nothumb'); return; }
      // a data: URL (not a blob: URL) so a thumbnail whose cell is replaced mid-load (grid rebuilt) leaves no
      // aborted request and nothing to revoke
      return blobToDataUrl(blob).then((url) => {
        if (gen !== st.gen) return;
        const img = cell.querySelector('img');
        img.onload = () => cell.classList.add('ready');
        img.src = url;
      });
    }).catch(() => { if (gen === st.gen) { cell.classList.remove('loading'); cell.classList.add('nothumb'); } });
  }

  const catLabel = (c) => (c ? c.split('/').join(' › ') : '(top level)');
  function renderCats() {
    const cats = [...new Set(st.items.map((i) => i.category ?? ''))].sort((a, b) => a.localeCompare(b));
    const keep = catSel.value;
    catSel.replaceChildren(el('option', { value: '', text: 'All categories' }), ...cats.map((c) => el('option', { value: c, text: catLabel(c) })));
    catSel.value = cats.includes(keep) ? keep : '';
  }
  function renderGrid() {
    st.gen++;
    observer.disconnect();
    const shown = filterSymbols(st.items, catSel.value, search.value);
    const cells = shown.slice(0, SYMBOL_GRID_MAX).map((item) => {
      const cell = el('button', { type: 'button', class: 'sym-cell loading', title: item.file ?? item.name, 'data-key': item.key },
        el('span', { class: 'sym-pic' }, el('img', { class: 'sym-thumb', alt: '', draggable: 'false' })), el('span', { class: 'sym-name', text: item.name }));
      cell._item = item;
      cell.onclick = () => pick(item);
      return cell;
    });
    grid.replaceChildren(...cells);
    for (const c of cells) observer.observe(c);
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
  async function pick(item) {
    const source = st.source;
    let syms;
    try { syms = await src.loadSymbol(source, item); } catch (err) { app.toast(`Symbols: ${err.message}`); return; }
    const sym = syms.length > 1 ? await chooseSymbol(item.file ?? item.name, syms) : syms[0];
    if (!sym) { if (!syms.length) app.toast(`Symbols: ${item.name} has nothing to insert.`); return; }
    app.tools.symbolinsert.use(sym);
    app.setTool('symbolinsert');
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

  // layouts: grid / list docked in the side panel, or a floating window (drag its title strip, resize its corner)
  const panel = $('sym-panel'), home = panel.parentElement, closeBtn = $('sym-float-close');
  const box = el('div', { id: 'sym-float', role: 'dialog', 'aria-label': 'Symbols' });
  box.hidden = true;
  document.getElementById('app').append(box);
  let view = 'grid', docked = 'grid', rect = null, saveT = 0;
  const viewBtns = SYMBOL_VIEWS.map((v) => {
    const b = $(`sym-view-${v}`);
    b.innerHTML = iconHtml(`view-${v}`, 16);
    b.onclick = () => setView(v);
    return b;
  });
  const saveRect = () => { clearTimeout(saveT); saveT = setTimeout(() => api.settingsSet?.('symbols.float', rect)?.catch?.(() => {}), 300); };
  const place = () => {
    rect = floatRectClamp(rect, window.innerWidth, window.innerHeight);
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  };
  function setView(v, save = true) {
    view = symbolViewFrom(v);
    if (view !== 'float') docked = view;
    panel.classList.toggle('view-list', view === 'list');
    viewBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SYMBOL_VIEWS[i] === view)));
    closeBtn.hidden = view !== 'float';
    if (view === 'float') {
      if (app.sideFolded?.includes('symbols')) app.foldSideSection('symbols', false);
      if (app.sideFly === 'symbols') closeSideFly(app);
      panel.classList.remove('folded', 'fly');
      box.append(panel); box.hidden = false; place();
    } else if (panel.parentElement !== home) {
      home.insertBefore(panel, home.querySelector('.panel[data-sec="props"]'));
      box.hidden = true; applySide(app);
    }
    if (save) api.settingsSet?.('symbols.view', view)?.catch?.(() => {});
  }
  closeBtn.onclick = () => setView(docked);
  panel.querySelector('.phead').addEventListener('pointerdown', (e) => {
    if (view !== 'float' || e.button !== 0 || e.target.closest('button, select, input')) return;
    e.preventDefault();
    const head = e.currentTarget, dx = e.clientX - rect.x, dy = e.clientY - rect.y;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { rect = { ...rect, x: ev.clientX - dx, y: ev.clientY - dy }; place(); };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); saveRect(); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  new ResizeObserver(() => {
    if (view !== 'float' || box.hidden || !rect) return;
    const w = box.offsetWidth, h = box.offsetHeight;
    if (w !== rect.w || h !== rect.h) { rect = { ...rect, w, h }; saveRect(); }
  }).observe(box);
  window.addEventListener('resize', () => { if (view === 'float') { place(); saveRect(); } }); // snap back inside a smaller window
  setView('grid', false);
  Promise.all([api.settingsGet?.('symbols.float'), api.settingsGet?.('symbols.view')])
    .then(([r, v]) => { if (r && typeof r === 'object') rect = r; setView(v, false); }).catch(() => {});

  return {
    /** the INSERT scale of `sym` in the current drawing */
    scaleOf: (sym) => symbolScale(sym, app.doc.units, { scale: st.scale, drawingScale: st.drawingScale }),
    focus() { search.focus(); },
    /** the Symbols section is in its floating window (the rail and SYMBOLS focus it there) */
    get floating() { return view === 'float'; },
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
