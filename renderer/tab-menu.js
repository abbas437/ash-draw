// Right-click menu on a document tab: Close, Close other tabs, Close tabs to the left / right, Close all tabs.
// Same look as the toolbar right-click menu (.popmenu.tb-menu).
import { el } from './ui.js';
import { tabsToClose } from './tabs.js';

let ctx = null;
function closeMenu(refocus) {
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
function onAway() { closeMenu(); }
function onDown(e) { if (ctx && !ctx.m.contains(e.target)) closeMenu(); }
function onKey(e) {
  if (!ctx) return;
  const list = [...ctx.m.querySelectorAll('button:not(:disabled)')];
  const k = list.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'Tab') closeMenu(true);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') list[(k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  else if (e.key === 'Home' || e.key === 'End') list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
  else if ((e.key === 'Enter' || e.key === ' ') && k >= 0) list[k].click();
  else return;
  e.preventDefault(); e.stopPropagation();
}

/** close `tabs` one by one through app.closeTab; a cancelled save prompt stops the rest */
export async function closeTabs(app, tabs) {
  for (const t of tabs) {
    if (!app.tabs.includes(t)) continue;
    if (!(await app.closeTab(t)) && app.tabs.includes(t)) return false;
  }
  return true;
}

/** open the menu for `tab` at the pointer, or beside the tab element for a keyboard event */
export function openTabMenu(app, tab, e) {
  e.preventDefault();
  if (e.type === 'keydown') e.stopImmediatePropagation(); // Shift+F10 is not also Polar (F10)
  closeMenu();
  const ids = app.tabs.map((t) => t.id);
  const item = (which, text, kbd) => {
    const n = tabsToClose(ids, tab.id, which).length;
    return el('button', { type: 'button', role: 'menuitem', tabindex: '-1', disabled: !n, 'data-act': which,
      onclick: () => { closeMenu(true); closeTabs(app, tabsToClose(ids, tab.id, which).map((id) => app.tabs.find((t) => t.id === id))); } },
    el('span', {}, text), el('kbd', { text: kbd ?? '' }));
  };
  const m = el('div', { class: 'popmenu tb-menu tab-menu', role: 'menu', 'aria-label': 'Tab' },
    item('this', 'Close', 'Ctrl+W'), item('others', 'Close other tabs'), item('left', 'Close tabs to the left'), item('right', 'Close tabs to the right'),
    el('hr'), item('all', 'Close all tabs'));
  document.body.append(m);
  let x = e.clientX, y = e.clientY;
  if (e.type === 'keydown' || (!x && !y)) { const r = e.currentTarget.getBoundingClientRect(); x = r.left + 10; y = r.bottom; }
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  ctx = { m, origin: document.activeElement };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onAway);
  window.addEventListener('resize', onAway);
  m.addEventListener('focusout', (ev) => { if (!m.contains(ev.relatedTarget)) closeMenu(); });
  m.querySelector('button:not(:disabled)')?.focus();
}
