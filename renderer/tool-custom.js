// ASH Draw Studio - View > Customize tools…: the dialog (tool panel and Quick Access tabs) and the right-click menu
// on tool panel and Quick Access buttons. The layout rules live in tool-layout.js; app.setToolLayout() applies and saves.
// Hidden tools keep their command line aliases and menu items: only the button goes.
import { el, modal } from './ui.js';
import { iconSvg } from './icons.js';
import { APP_COMMANDS, TOOL_BUTTONS, quickCommand } from './tool-panel.js';
import {
  SEP, defaultLayout, groupLabel, canHide, isHidden, inQuick, setHidden, setGroupShown, moveItem, moveToGroup, moveGroup,
  quickAdd, quickRemove, quickMove,
} from './tool-layout.js';

const nameOf = (id) => quickCommand(id)?.[0] ?? id;
const aliasOf = (id) => quickCommand(id)?.[1] ?? '';

// ---------------------------------------------------------------- dialog
function buildBody(get, set) {
  let tab = 'panel';
  const root = el('div', { class: 'tcz' });
  const mini = (text, label, key, disabled, fn) => el('button', { type: 'button', class: 'tcz-mini', 'aria-label': label, title: label, disabled, 'data-key': key, onclick: () => set(fn(), key) }, text);
  const cmd = (id) => [el('span', { class: 'tcz-icon', 'aria-hidden': 'true' }, iconSvg(id, 16)), el('span', { text: nameOf(id) }), aliasOf(id) ? el('kbd', { text: aliasOf(id) }) : null];

  const panelTab = (L) => L.groupOrder.map((g, gi) => {
    const name = groupLabel(g), ids = L.order[g];
    const head = el('div', { class: 'tcz-head' }, el('h3', { id: `tcz-g-${g}`, text: name }),
      mini('↑', `Move group ${name} up`, `gup:${g}`, gi === 0, () => moveGroup(get(), g, -1)),
      mini('↓', `Move group ${name} down`, `gdown:${g}`, gi === L.groupOrder.length - 1, () => moveGroup(get(), g, 1)),
      mini('All', `Show all ${name} tools`, `all:${g}`, !ids.length, () => setGroupShown(get(), g, true)),
      mini('None', `Hide all ${name} tools`, `none:${g}`, !ids.length, () => setGroupShown(get(), g, false)));
    const rows = ids.map((id, i) => el('li', { class: 'tcz-row', 'data-id': id },
      el('label', { class: 'tcz-check' }, el('input', { type: 'checkbox', checked: !isHidden(L, id), disabled: !canHide(id), title: canHide(id) ? null : 'Select is always shown', 'data-key': `show:${id}`, onchange: (e) => set(setHidden(get(), id, !e.target.checked), `show:${id}`) }), ...cmd(id)),
      mini('↑', `Move ${nameOf(id)} up`, `up:${id}`, i === 0, () => moveItem(get(), id, -1)),
      mini('↓', `Move ${nameOf(id)} down`, `down:${id}`, i === ids.length - 1, () => moveItem(get(), id, 1)),
      (() => { const s = el('select', { class: 'tcz-group', 'aria-label': `Group for ${nameOf(id)}`, 'data-key': `grp:${id}`, onchange: (e) => set(moveToGroup(get(), id, e.target.value), `grp:${id}`) }, L.groupOrder.map((k) => el('option', { value: k, text: groupLabel(k) }))); s.value = g; return s; })()));
    return el('section', { class: 'tcz-group-box', 'aria-labelledby': `tcz-g-${g}`, 'data-group': g }, head, rows.length ? el('ul', { class: 'tcz-list' }, rows) : el('p', { class: 'tcz-empty', text: 'No tools' }));
  });

  const quickTab = (L) => {
    const rows = L.quick.map((id, i) => el('li', { class: 'tcz-row', 'data-q': id },
      el('span', { class: 'tcz-check' }, ...(id === SEP ? [el('span', { class: 'tcz-sep', text: 'Separator' })] : cmd(id))),
      mini('↑', `Move ${id === SEP ? 'separator' : nameOf(id)} left`, `qup:${i}`, i === 0, () => quickMove(get(), i, -1)),
      mini('↓', `Move ${id === SEP ? 'separator' : nameOf(id)} right`, `qdown:${i}`, i === L.quick.length - 1, () => quickMove(get(), i, 1)),
      mini('Remove', `Remove ${id === SEP ? 'separator' : nameOf(id)} from Quick Access`, `qdel:${i}`, false, () => quickRemove(get(), i))));
    const free = [...TOOL_BUTTONS.map(([label, key]) => [label, L.order[key] ?? []]), ['Application', Object.keys(APP_COMMANDS)]]
      .map(([label, ids]) => [label, ids.filter((id) => !inQuick(L, id))]).filter(([, ids]) => ids.length);
    const pick = el('select', { 'aria-label': 'Command to add', 'data-key': 'qpick' }, free.map(([label, ids]) => el('optgroup', { label }, ids.map((id) => el('option', { value: id, text: nameOf(id) })))));
    return [rows.length ? el('ul', { class: 'tcz-list' }, rows) : el('p', { class: 'tcz-empty', text: 'The Quick Access row is empty' }),
      el('div', { class: 'tcz-add' }, pick,
        el('button', { type: 'button', 'data-key': 'qadd', disabled: !free.length, onclick: () => set(quickAdd(get(), pick.value), 'qpick') }, 'Add'),
        el('button', { type: 'button', 'data-key': 'qsep', onclick: () => set(quickAdd(get(), SEP), 'qsep') }, 'Add separator'))];
  };

  const render = (focusKey) => {
    const L = get();
    const tabBtn = (id, text) => el('button', { type: 'button', role: 'tab', id: `tcz-tab-${id}`, 'aria-selected': String(tab === id), tabindex: tab === id ? '0' : '-1', 'aria-controls': 'tcz-pane', 'data-key': `tab:${id}`, onclick: () => { tab = id; render(`tab:${id}`); } }, text);
    const tabs = el('div', { class: 'tcz-tabs', role: 'tablist', 'aria-label': 'Customize', onkeydown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault(); tab = tab === 'panel' ? 'quick' : 'panel'; if (e.key === 'Home') tab = 'panel'; if (e.key === 'End') tab = 'quick'; render(`tab:${tab}`);
    } }, tabBtn('panel', 'Tool panel'), tabBtn('quick', 'Quick Access'),
    el('button', { type: 'button', class: 'tcz-reset', 'data-key': 'reset', onclick: () => set(defaultLayout(), 'reset') }, 'Reset to default'));
    const hint = tab === 'panel' ? 'Untick a tool to hide its button; hidden tools still run from the command line and the menus.' : 'Commands shown in the row under the menu bar (View > Quick Access row shows or hides it).';
    root.replaceChildren(tabs, el('p', { class: 'tcz-hint', text: hint }),
      el('div', { class: 'tcz-pane', id: 'tcz-pane', role: 'tabpanel', 'aria-labelledby': `tcz-tab-${tab}` }, tab === 'panel' ? panelTab(L) : quickTab(L)));
    if (focusKey) {
      const f = root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      // a move button at the end of its list is disabled: keep the focus in its row
      (f && !f.disabled ? f : f?.closest('.tcz-row, .tcz-group-box')?.querySelector('input:not(:disabled), button:not(:disabled)') ?? root.querySelector('[role=tab][aria-selected=true]'))?.focus();
    }
  };
  render();
  return { root, render };
}

/** View > Customize tools…: edits a copy; OK applies and saves it */
export async function openCustomize(app) {
  let draft = app.toolLayout;
  let body = null;
  body = buildBody(() => draft, (l, key) => { draft = l; body.render(key); });
  const r = await modal('Customize tools', body.root, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  if (r === 'ok') app.setToolLayout(draft);
  return r === 'ok';
}

// ---------------------------------------------------------------- right-click menu
let ctx = null;
function closeContext(refocus) {
  if (!ctx) return;
  const { m, origin } = ctx;
  ctx = null;
  m.remove();
  document.removeEventListener('pointerdown', onDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', onAway);
  window.removeEventListener('resize', onAway);
  if (refocus && origin?.isConnected) origin.focus();
}
function onAway() { closeContext(); }
function onDown(e) { if (ctx && !ctx.m.contains(e.target)) closeContext(); }
function onKey(e) {
  if (!ctx) return;
  const list = [...ctx.m.querySelectorAll('button:not(:disabled)')];
  const k = list.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'Tab') closeContext(true);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') list[(k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  else if (e.key === 'Home' || e.key === 'End') list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
  else if ((e.key === 'Enter' || e.key === ' ') && k >= 0) list[k].click(); // here, before the drawing's own Enter/Space keys
  else return;
  e.preventDefault(); e.stopPropagation();
}

/** run an edit that removes `btn` from its bar, then focus the next shown button there (else the previous one) */
function removeAndFocus(app, btn, sel, attr, layout) {
  const ids = [...document.querySelectorAll(sel)].filter((b) => b.getClientRects().length).map((b) => b.getAttribute(attr));
  const i = ids.indexOf(btn.getAttribute(attr));
  app.setToolLayout(layout);
  for (const id of [...ids.slice(i + 1), ...ids.slice(0, Math.max(i, 0)).reverse()]) {
    const b = document.querySelector(`${sel}[${attr}="${CSS.escape(id)}"]`);
    if (b?.getClientRects().length) { b.focus(); return; }
  }
  app.vp.canvas.focus();
}

function openContext(app, e) {
  const tool = e.target.closest('#tools button[data-tool]'), quick = e.target.closest('#qat button[data-cmd]'), head = e.target.closest('#tools [data-head]');
  if (!tool && !quick && !head) return;
  e.preventDefault();
  if (e.type === 'keydown') e.stopImmediatePropagation(); // Shift+F10 is not also Polar (F10)
  closeContext();
  const L = app.toolLayout;
  const item = (key, text, action, disabled = false) => el('button', { type: 'button', role: 'menuitem', tabindex: '-1', disabled, 'data-act': key, onclick: () => { closeContext(true); action(); } }, text);
  const items = [];
  if (tool) {
    const id = tool.dataset.tool;
    items.push(item('hide', `Hide ${nameOf(id)}`, () => removeAndFocus(app, tool, '#tools button[data-tool]', 'data-tool', setHidden(app.toolLayout, id, true)), !canHide(id)));
    items.push(inQuick(L, id) ? item('qremove', 'Remove from Quick Access', () => app.setToolLayout(quickRemove(app.toolLayout, id)))
      : item('qadd', 'Add to Quick Access', () => app.setToolLayout(quickAdd(app.toolLayout, id))));
  }
  if (quick) items.push(item('qremove', 'Remove from Quick Access', () => removeAndFocus(app, quick, '#qat button[data-cmd]', 'data-cmd', quickRemove(app.toolLayout, quick.dataset.cmd))));
  items.push(item('customize', 'Customize tools…', () => openCustomize(app)));
  const m = el('div', { class: 'popmenu tcz-menu', role: 'menu', 'aria-label': tool ? nameOf(tool.dataset.tool) : quick ? 'Quick Access' : 'Tool panel' }, items);
  document.body.append(m);
  let x = e.clientX, y = e.clientY;
  if (!x && !y) { const r = e.target.getBoundingClientRect(); x = r.left + 10; y = r.bottom; } // keyboard (Shift+F10 / menu key)
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  ctx = { m, origin: document.activeElement };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onAway);
  window.addEventListener('resize', onAway);
  m.querySelector('button:not(:disabled)')?.focus();
}

/** right-click on the tool panel and the Quick Access row */
export function initToolContextMenu(app) {
  document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('#tools, #qat')) openContext(app, e); });
  // Shift+F10 / the menu key on a focused button (keydown, so the menu opens the same way everywhere; preventDefault stops the native event)
  document.addEventListener('keydown', (e) => { if (((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') && e.target.closest?.('#tools, #qat')) openContext(app, e); });
}
