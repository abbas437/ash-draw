// Menu items for the menu bar and the toolbar right-click menu: one renderer, so both show the same items.
// An item is [label, shortcut, action, checked?, visible?] (label and checked/visible are functions read when the menu opens),
// '-' a separator, or { sub: 'Toolbars', items: [...] } a submenu that opens to the right (left without room) on hover, click or ArrowRight.
import { el } from './ui.js';

const HOVER_MS = 200; // a pointer crossing a sibling on its way into an open submenu does not switch it at once

/** shown buttons of one menu level (not those of its submenus) */
const levelButtons = (drop) => [...drop.querySelectorAll(':scope > button, :scope > .sub > button')].filter((b) => !b.hidden && b.getClientRects().length);

function closeSub(sub) {
  if (!sub.classList.contains('open')) return;
  for (const s of sub.querySelectorAll('.sub.open')) closeSub(s);
  sub.classList.remove('open', 'left');
  sub.firstElementChild.setAttribute('aria-expanded', 'false');
}
/** close every open submenu inside `root` (a closed top menu or the right-click menu) */
export function closeSubmenus(root) { for (const s of root.querySelectorAll('.sub.open')) closeSub(s); }

/** render `items`; close() runs before an item's action. Returns { nodes, refresh } - refresh() updates labels, ticks and shown items */
export function renderMenu(items, { close }) {
  const checks = [];
  let timer = 0;
  const later = (fn) => { clearTimeout(timer); timer = setTimeout(fn, HOVER_MS); };
  const siblingsClose = (node) => { for (const s of node.parentElement?.querySelectorAll(':scope > .sub.open') ?? []) if (s !== node) closeSub(s); };
  const item = (it) => {
    const chk = it[3] ? el('span', { class: 'chk' }) : null;
    const text = document.createTextNode(typeof it[0] === 'function' ? it[0]() : it[0]);
    if (typeof it[0] === 'function') checks.push(() => { text.data = it[0](); });
    const b = el('button', { type: 'button', role: it[3] ? 'menuitemcheckbox' : 'menuitem', onclick: (e) => { e.stopPropagation(); close(); it[2](); },
      onpointerenter: () => later(() => siblingsClose(b)) }, el('span', {}, chk, text), el('kbd', { text: it[1] }));
    if (it[4]) checks.push(() => { b.hidden = !it[4](); });
    if (chk) checks.push(() => { const on = !!it[3](); chk.textContent = on ? '✓' : ''; b.setAttribute('aria-checked', String(on)); });
    return b;
  };
  const submenu = (it) => {
    const inner = renderMenu(it.items, { close });
    checks.push(inner.refresh); // with its menu, and again when it opens
    const drop = el('div', { class: 'drop', role: 'menu', 'aria-label': it.sub }, inner.nodes);
    const btn = el('button', { type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', class: 'sub-btn',
      onclick: (e) => { e.stopPropagation(); clearTimeout(timer); if (sub.classList.contains('open')) closeSub(sub); else { open(); if (e.detail === 0) levelButtons(drop)[0]?.focus(); } } },
    el('span', {}, el('span', { class: 'chk' }), it.sub), el('kbd', { text: '▸', 'aria-hidden': 'true' }));
    const sub = el('div', { class: 'sub', onpointerenter: () => later(() => { siblingsClose(sub); open(); }) }, btn, drop);
    const open = () => {
      if (sub.classList.contains('open')) return;
      siblingsClose(sub);
      inner.refresh();
      sub.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      const r = drop.getBoundingClientRect();
      if (r.right > innerWidth - 4) sub.classList.add('left'); // no room on the right: open to the left
      if (r.bottom > innerHeight - 4) drop.style.top = `${Math.min(0, innerHeight - 4 - r.bottom)}px`; else drop.style.top = '';
    };
    sub.openSub = open;
    return sub;
  };
  const nodes = items.map((it) => (it === '-' ? el('hr') : it.sub ? submenu(it) : item(it)));
  return { nodes, refresh: () => checks.forEach((f) => f()) };
}

/** keyboard inside a menu: ArrowUp / ArrowDown / Home / End move through one level, ArrowRight (Enter / Space) opens a submenu,
 *  ArrowLeft / Escape close it; Escape on the top level calls closeTop(). Returns true when it handled the key. */
export function menuKey(e, top, closeTop) {
  const a = document.activeElement;
  const drop = a && top.contains(a) && a.closest('.drop, .popmenu');
  if (!drop || !top.contains(drop)) return false;
  const list = levelButtons(drop), k = list.indexOf(a);
  const parentSub = drop.parentElement?.classList.contains('sub') ? drop.parentElement : null;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') list[(k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  else if (e.key === 'Home' || e.key === 'End') list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
  else if (e.key === 'ArrowRight' && a.classList.contains('sub-btn')) { a.parentElement.openSub(); levelButtons(a.nextElementSibling)[0]?.focus(); }
  else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && parentSub) { closeSub(parentSub); parentSub.firstElementChild.focus(); }
  else if (e.key === 'Escape') closeTop();
  else return false;
  e.preventDefault(); e.stopPropagation();
  return true;
}
