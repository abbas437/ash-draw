// ASH Draw Studio - the layer combo in the Quick Access row (AutoCAD's Layer drop-down), beside the Layers button.
// It shows the current layer, or the selection's common layer ("(varies)" when mixed). Its list uses the Layers panel's
// order, filter match and operations (ui.js layerOps), and picking a layer with objects selected moves them like
// Properties > Layer (ui.js applyProps, one undo step). app.refreshPanels() refreshes it with the Layers panel.
import { el, sortedLayers, layerMatches, layerCss, layerOps, applyProps } from './ui.js';

const ROW_H = 22; // px, fixed so only the rows in view are built (thousands of layers)
const OVERSCAN = 6;

/** the combo's state icons and toggles: [class, title when set, title when not, glyph set, glyph not, is set, operation] */
const FLAGS = [
  ['lc-on', 'Turn layer off', 'Turn layer on', '◉', '○', (l) => l.visible !== false, layerOps.toggleOn],
  ['lc-frz', 'Thaw layer', 'Freeze layer', '❄', '☀', (l) => !!l.frozen, layerOps.toggleFreeze],
  ['lc-lock', 'Unlock layer', 'Lock layer', '🔒', '🔓', (l) => !!l.locked, layerOps.toggleLock],
];

/** build the combo; returns { el, refresh() }. app.renderQuickAccess() places el after the Layers button. */
export function initLayerCombo(app) {
  const head = el('button', { type: 'button', class: 'lc-head', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const box = el('div', { id: 'layer-combo' }, head);
  const filter = el('input', { type: 'search', class: 'lc-filter', placeholder: 'Filter layers', 'aria-label': 'Filter layers by name', spellcheck: 'false' });
  const spacer = el('div', { class: 'lc-spacer' });
  const scroller = el('div', { class: 'lc-scroll', role: 'listbox', 'aria-label': 'Layers' }, spacer);
  const list = el('div', { id: 'layer-combo-list', hidden: true }, filter, scroller);
  let rows = [], active = 0;

  /** the layer the combo shows: the selection's common layer, null when it varies, else the current layer */
  const shown = () => {
    const ents = app.vp.selectedEntities();
    if (!ents.length) return app.state.layer;
    return ents.every((e) => e.layer === ents[0].layer) ? ents[0].layer : null;
  };
  const icons = (l, live) => FLAGS.map(([cls, tOn, tOff, gOn, gOff, isSet, op]) => {
    const on = isSet(l), attrs = { class: `${cls}${on ? ' set' : ''}`, title: on ? tOn : tOff, text: on ? gOn : gOff };
    if (!live) return el('span', { ...attrs, title: null, 'aria-hidden': 'true' });
    return el('button', { ...attrs, type: 'button', tabindex: '-1', onclick: () => op(app, app.doc.layers.get(l.name) ?? l) });
  });

  function renderHead() {
    const name = shown(), l = name == null ? null : app.doc.layers.get(name);
    const text = name == null ? '(varies)' : name;
    head.replaceChildren(...(l ? icons(l, false) : []), el('span', { class: 'swatch', style: l ? `background:${layerCss(l)}` : 'visibility:hidden' }),
      el('span', { class: 'lc-name', text }), el('span', { class: 'lc-arrow', text: '▾', 'aria-hidden': 'true' }));
    const sel = app.vp.selection.size;
    head.title = sel ? `Layer of the selected objects: ${text}\nPick a layer to move them to it` : `Current layer: ${text}\nPick a layer to make it current`;
  }

  /** build only the rows in view (absolutely placed in a spacer as tall as the whole list) */
  function renderRows() {
    spacer.style.height = `${rows.length * ROW_H}px`;
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_H) + OVERSCAN);
    const cur = shown(), kids = [];
    for (let i = first; i < last; i++) {
      const l = rows[i];
      kids.push(el('div', { class: `lc-row${i === active ? ' active' : ''}${l.name === cur ? ' current' : ''}`, role: 'option', 'aria-selected': String(i === active), 'data-layer': l.name, style: `top:${i * ROW_H}px` },
        ...icons(l, true), el('span', { class: 'swatch', style: `background:${layerCss(l)}` }),
        el('span', { class: 'lc-name', text: l.name, title: l.name, onclick: () => pick(l.name) })));
    }
    if (!rows.length) kids.push(el('div', { class: 'lc-none', text: `No layer matches "${filter.value.trim()}".` }));
    spacer.replaceChildren(...kids);
  }
  function renderList(keepActive = true) {
    const name = keepActive ? rows[active]?.name : shown();
    const f = filter.value.trim(), all = sortedLayers(app.doc);
    rows = f ? all.filter((l) => layerMatches(l, f)) : all;
    const i = rows.findIndex((l) => l.name === name);
    active = i >= 0 ? i : 0;
    renderRows();
  }
  const scrollToActive = () => {
    const top = active * ROW_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_H - scroller.clientHeight;
  };

  function open() {
    if (!list.hidden) return;
    filter.value = '';
    const b = head.getBoundingClientRect();
    list.style.left = `${Math.max(4, Math.min(b.left, innerWidth - 320))}px`;
    list.style.top = `${b.bottom + 2}px`;
    list.hidden = false; head.setAttribute('aria-expanded', 'true');
    scroller.style.maxHeight = `${Math.max(ROW_H * 4, Math.min(ROW_H * 18, innerHeight - b.bottom - 60))}px`;
    scroller.scrollTop = 0;
    renderList(false);
    scroller.scrollTop = Math.max(0, active * ROW_H - scroller.clientHeight / 2);
    renderRows();
    filter.focus();
    document.addEventListener('pointerdown', away, true); window.addEventListener('blur', close);
  }
  function close(refocus = false) {
    if (list.hidden) return;
    list.hidden = true; head.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', close);
    if (refocus === true) head.focus();
  }
  const away = (e) => { if (!list.contains(e.target) && !head.contains(e.target)) close(); };
  /** the row's name: with objects selected, move them to the layer (Properties > Layer); otherwise make it current */
  function pick(name) {
    close(true);
    if (app.vp.selection.size) applyProps(app, { layer: name }); else layerOps.makeCurrent(app, name);
  }

  head.addEventListener('click', () => (list.hidden ? open() : close()));
  head.addEventListener('keydown', (e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.hidden) { e.preventDefault(); e.stopPropagation(); open(); } });
  filter.addEventListener('input', () => { renderList(false); scroller.scrollTop = 0; renderRows(); });
  filter.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the canvas shortcuts stay out of the filter
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
      const step = e.key.startsWith('Page') ? Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1) : 1;
      active = Math.max(0, Math.min(rows.length - 1, active + (e.key.endsWith('Down') ? step : -step)));
      scrollToActive(); renderRows();
    } else if (e.key === 'Enter') { if (rows[active]) pick(rows[active].name); } else if (e.key === 'Escape') close(true);
    else return;
    e.preventDefault();
  });
  scroller.addEventListener('scroll', renderRows);
  list.addEventListener('mousedown', (e) => { if (e.target !== filter) e.preventDefault(); }); // a toggle keeps the typing focus in the filter
  document.body.append(list); // outside #qat, which scrolls and would clip it

  return {
    el: box,
    refresh() { renderHead(); if (!list.hidden) renderList(); },
    close,
  };
}
