// ASH Draw Studio - the "Symbols ▾" drop-down in the Quick Access row, after the layer combo: a palette (on <body>, like
// the layer combo's list) with a source select, a search box and a compact thumbnail grid, plus a Recent row (setting
// 'symbols.recent', shared with the Symbols panel). It works wherever the Symbols panel is, hidden included: it shares
// the panel's symbol source (app.symbolsPanel.src) and its insert path (symbols-ui.js pickSymbol).
import { el } from './ui.js';
import { BUILTIN_SOURCE } from './symbols-source.js';
import { SYMBOL_GRID_MAX, filterSymbols, lazyThumbs, symbolCell, pickSymbol } from './symbols-ui.js';

const W = 340; // px

/** build the drop-down; returns { el, close() }. app.renderQuickAccess() places el after the layer combo. */
export function initSymbolPalette(app, api) {
  const head = el('button', { type: 'button', class: 'sp-head', title: 'Insert a symbol', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    el('span', { text: 'Symbols' }), el('span', { class: 'sp-arrow', text: '▾', 'aria-hidden': 'true' }));
  const box = el('div', { id: 'sym-combo' }, head);
  const srcSel = el('select', { class: 'sp-source', 'aria-label': 'Symbol source' });
  const search = el('input', { type: 'search', class: 'sp-search', placeholder: 'Search symbols', 'aria-label': 'Search symbols by name', spellcheck: 'false' });
  const recent = el('div', { class: 'sp-recent', role: 'group', 'aria-label': 'Recent symbols' });
  const recentBox = el('div', { class: 'sp-recent-box', hidden: true }, el('div', { class: 'sp-label', text: 'Recent' }), recent);
  const grid = el('div', { class: 'sp-grid', role: 'group', 'aria-label': 'Symbols' });
  const status = el('div', { class: 'sp-status' });
  const pal = el('div', { id: 'sym-palette', role: 'dialog', 'aria-label': 'Insert a symbol', hidden: true },
    el('div', { class: 'sp-bar' }, srcSel, search), recentBox, grid, status);
  const st = { sources: [BUILTIN_SOURCE], source: BUILTIN_SOURCE, items: [], seq: 0, opens: 0 };
  let thumbs = null, recentThumbs = null; // made on first open: the panel's source exists by then
  const src = () => app.symbolsPanel.src;

  const insert = (source, item) => { close(); pickSymbol(app, api, src(), source, item); };
  function renderGrid() {
    thumbs.reset();
    const shown = filterSymbols(st.items, '', search.value), source = st.source;
    const cells = shown.slice(0, SYMBOL_GRID_MAX).map((item) => symbolCell(source, item, () => insert(source, item)));
    grid.replaceChildren(...cells);
    for (const c of cells) thumbs.observe(c);
    if (!cells.length) grid.append(el('div', { class: 'sp-none', text: st.items.length ? `No symbol matches "${search.value.trim()}".` : 'No symbols here.' }));
    status.textContent = shown.length > SYMBOL_GRID_MAX ? `First ${SYMBOL_GRID_MAX} of ${shown.length} shown, refine the search` : `${shown.length} symbol${shown.length === 1 ? '' : 's'}`;
  }
  async function showSource(source) {
    st.source = source; srcSel.value = source.id;
    const seq = ++st.seq;
    status.textContent = 'Loading…';
    let items = [];
    try { items = await src().listSymbols(source); } catch (err) { app.toast(`Symbols: ${err.message}`); }
    if (seq !== st.seq) return;
    st.items = items;
    renderGrid();
  }
  /** the Recent row: 'symbols.recent' entries whose source and file still resolve */
  async function renderRecent(n) {
    const list = await api.settingsGet?.('symbols.recent')?.catch?.(() => undefined);
    const lists = new Map(), cells = [];
    for (const r of Array.isArray(list) ? list : []) {
      const source = st.sources.find((s) => s.id === r?.sourceId);
      if (!source) continue;
      if (!lists.has(source.id)) lists.set(source.id, src().listSymbols(source).catch(() => []));
      const item = (await lists.get(source.id)).find((it) => it.key === r.file);
      if (item) cells.push(symbolCell(source, item, () => insert(source, item)));
    }
    if (n !== st.opens) return;
    recentThumbs.reset();
    recent.replaceChildren(...cells);
    recentBox.hidden = !cells.length;
    for (const c of cells) recentThumbs.observe(c);
  }

  async function open() {
    if (!pal.hidden) return;
    st.opens++;
    thumbs ??= lazyThumbs(src(), grid);
    recentThumbs ??= lazyThumbs(src(), pal);
    search.value = '';
    const b = head.getBoundingClientRect();
    pal.style.left = `${Math.max(4, Math.min(b.left, innerWidth - W - 4))}px`;
    pal.style.top = `${b.bottom + 2}px`;
    grid.style.maxHeight = `${Math.max(120, Math.min(360, innerHeight - b.bottom - 170))}px`;
    pal.hidden = false; head.setAttribute('aria-expanded', 'true');
    search.focus();
    document.addEventListener('pointerdown', away, true); window.addEventListener('blur', close);
    st.sources = await src().listSources().catch(() => [BUILTIN_SOURCE]);
    srcSel.replaceChildren(...st.sources.map((s) => el('option', { value: s.id, text: s.kind === 'builtin' ? s.name : `Folder: ${s.name}` })));
    const n = st.opens;
    renderRecent(n);
    await showSource(st.sources.find((s) => s.id === st.source.id) ?? st.sources[0]);
  }
  function close(refocus = false) {
    if (pal.hidden) return;
    pal.hidden = true; head.setAttribute('aria-expanded', 'false');
    st.seq++; st.opens++;
    document.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', close);
    if (refocus === true) head.focus();
  }
  const away = (e) => { if (!pal.contains(e.target) && !head.contains(e.target)) close(); };

  /** the cell an arrow key moves to from `cur`: left / right in reading order (Recent row, then the grid), up / down the
   * nearest cell in the next row that way; up from the top row goes back to the search box */
  function nextCell(cur, key) {
    const cells = [...pal.querySelectorAll('.sym-cell')], i = cells.indexOf(cur);
    if (key === 'ArrowLeft') return cells[i - 1] ?? null;
    if (key === 'ArrowRight') return cells[i + 1] ?? null;
    const r = cur.getBoundingClientRect(), down = key === 'ArrowDown', cx = r.left + r.width / 2;
    let row = Infinity, best = null, bestDx = Infinity;
    const rowOf = (q) => (down ? q.top - r.bottom : r.top - q.bottom);
    for (const c of cells) { const d = rowOf(c.getBoundingClientRect()); if (d > -2 && d < row) row = d; }
    for (const c of cells) {
      const q = c.getBoundingClientRect();
      if (Math.abs(rowOf(q) - row) > 2) continue;
      const dx = Math.abs(q.left + q.width / 2 - cx);
      if (dx < bestDx) { bestDx = dx; best = c; }
    }
    return best ?? (down ? null : search);
  }
  head.addEventListener('click', () => (pal.hidden ? open() : close()));
  head.addEventListener('keydown', (e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pal.hidden) { e.preventDefault(); e.stopPropagation(); open(); } });
  srcSel.onchange = () => showSource(st.sources.find((s) => s.id === srcSel.value) ?? BUILTIN_SOURCE);
  search.addEventListener('input', renderGrid);
  pal.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the canvas shortcuts stay out of the palette
    const cell = e.target.closest?.('.sym-cell');
    if (e.key === 'Escape') close(true);
    else if (e.key === 'Enter' && cell) cell.click();
    else if (e.key === 'Enter' && e.target === search) grid.querySelector('.sym-cell')?.click(); // the first match
    else if (e.key === 'ArrowDown' && e.target === search) pal.querySelector('.sym-cell')?.focus();
    else if (cell && e.key.startsWith('Arrow')) nextCell(cell, e.key)?.focus();
    else return;
    e.preventDefault();
  });
  document.body.append(pal); // outside #qat, which scrolls and would clip it

  return { el: box, close };
}
