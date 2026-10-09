// ASH Draw Studio - the left tool panel: its command buttons (by group) and how it is built. DOM-free at import time.
import { iconSvg } from './icons.js';

/** [group, colour key, [[command id, label, alias?], ...]]; the colour key picks the group's icon colour in styles.css */
export const TOOL_BUTTONS = [
  ['Select', 'select', [['select', 'Select'], ['pan', 'Pan', 'P']]],
  ['Draw', 'draw', [['line', 'Line', 'L'], ['pline', 'Polyline', 'PL'], ['rect', 'Rectangle', 'REC'], ['circle', 'Circle', 'C'], ['arc', 'Arc', 'A'], ['ellipse', 'Ellipse', 'EL'], ['point', 'Point', 'PO'], ['text', 'Text', 'T'], ['hatch', 'Hatch', 'H']]],
  ['Modify', 'modify', [['move', 'Move', 'M'], ['copy', 'Copy', 'CO'], ['rotate', 'Rotate', 'RO'], ['scale', 'Scale', 'SC'], ['mirror', 'Mirror', 'MI'], ['offset', 'Offset', 'O'], ['trim', 'Trim', 'TR'], ['extend', 'Extend', 'EX'], ['explode', 'Explode', 'X'], ['erase', 'Erase', 'E'],
    ['fillet', 'Fillet', 'F'], ['chamfer', 'Chamfer', 'CHA'], ['break', 'Break', 'BR'], ['join', 'Join', 'J'], ['lengthen', 'Lengthen', 'LEN'], ['stretch', 'Stretch', 'STR'],
    ['arrayrect', 'Array rect', 'AR'], ['arraypolar', 'Array polar', 'ARRAYPOLAR'], ['arraypath', 'Array path', 'ARRAYPATH']]],
  ['Block', 'block', [['block', 'Create block', 'B'], ['insert', 'Insert', 'I'], ['attdef', 'Attribute', 'ATT'], ['eattedit', 'Edit attributes', 'ATE']]],
  ['Dimension', 'annotate', [['dimlinear', 'Linear', 'DLI'], ['dimaligned', 'Aligned', 'DAL'], ['dimangular', 'Angular', 'DAN'], ['dimradius', 'Radius', 'DRA'], ['dimdiameter', 'Diameter', 'DDI'],
    ['mleader', 'Multileader', 'MLD'], ['dimcontinue', 'Continue', 'DCO'], ['dimbaseline', 'Baseline', 'DBA']]],
  ['Inquiry', 'inquiry', [['measure', 'Measure', 'MEA'], ['area', 'Area', 'AREA']]],
  ['Markup', 'markup', [['mkc', 'Markup circle', 'MKC'], ['mkr', 'Markup rectangle', 'MKR'], ['mkt', 'Markup note', 'MKT']]],
];

/** commands of the Quick Access row that are not drawing tools: id -> [label, shortcut]; app.js runs them */
export const APP_COMMANDS = { new: ['New', 'Ctrl+N'], open: ['Open', 'Ctrl+O'], save: ['Save', 'Ctrl+S'], undo: ['Undo', 'Ctrl+Z'], redo: ['Redo', 'Ctrl+Y'], zoomfit: ['Zoom extents', 'Z, E'], layers: ['Layers panel', ''] };

/** the Quick Access row under the menu bar: [colour key, [command id ...]]; ids are panel tools or APP_COMMANDS */
export const QUICK_ACCESS = [
  ['file', ['new', 'open', 'save', 'undo', 'redo']],
  ['select', ['select', 'pan', 'zoomfit']],
  ['draw', ['line', 'pline', 'circle', 'text']],
  ['modify', ['move', 'copy', 'trim', 'erase']],
  ['annotate', ['dimlinear']], ['inquiry', ['measure']],
  ['markup', ['mkc', 'mkr']],
  ['file', ['layers']],
];

/** [label, alias] of a Quick Access command, or null if it is neither a panel tool nor an app command */
export function quickCommand(id) {
  if (Object.hasOwn(APP_COMMANDS, id)) return APP_COMMANDS[id];
  for (const [, , items] of TOOL_BUTTONS) for (const [tid, label, alias] of items) if (tid === id) return [label, alias];
  return null;
}

/** saved settings -> layout. Never-set values take the beta.10 defaults: model space dark, tool labels off (compact panel). */
export const canvasDarkFrom = (saved) => saved !== 'light';
export const labelsFrom = (saved) => saved === true;
export const PLACEMENTS = ['left', 'top', 'hidden'];
export const placementFrom = (saved) => (PLACEMENTS.includes(saved) ? saved : 'left');
export const collapsedFrom = (saved) => (Array.isArray(saved) ? saved.filter((k) => typeof k === 'string') : []);

/** tooltip of a command button: "Line (L)" */
export const toolTitle = (label, alias) => (alias ? `${label} (${alias})` : label);

/** an icon + label button; the label can be hidden by the panel's no-labels class, the name stays in title and aria-label */
export function iconButton(el, icon, label, attrs) {
  return el('button', { ...attrs, 'aria-label': label }, iconSvg(icon), el('span', { class: 'lbl', text: label }));
}

/**
 * Fill the tool panel. `extras(group, box)` lets the caller append non-command controls after a group (dimension style list).
 * `groups` is TOOL_BUTTONS or the customized panel (tool-layout.js panelGroups). Returns nothing; buttons carry data-tool and data-group.
 */
export function buildToolPanel(box, el, setTool, extras = () => {}, onToggle = () => {}, groups = TOOL_BUTTONS) {
  for (const [group, key, items] of groups) {
    const body = el('div', { class: 'gbody', 'data-body': key, style: `--cols:${Math.max(1, Math.min(items.length, Math.max(2, Math.ceil(items.length / 2))))}` }); // --cols: icons per row in the Top band (two rows)
    // the group header folds its buttons away (click or Enter/Space); onToggle(key, collapsed) saves the state
    const toggle = () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', String(!body.hidden)); onToggle(key, body.hidden); };
    const head = el('div', { class: `group g-${key}`, role: 'button', tabindex: '0', 'aria-expanded': 'true', 'data-head': key, title: `${group}: click to show or hide`, text: group, onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } });
    for (const [id, label, alias] of items) {
      body.append(iconButton(el, id, label, { 'data-tool': id, 'data-group': key, class: `g-${key}`, title: toolTitle(label, alias), onclick: () => setTool(id) }));
    }
    extras(group, body);
    box.append(el('div', { class: 'tgroup', 'data-group': key }, head, body, moreButton(el, group, key))); // .tgroup is transparent in the Left panel, a column in the Top band
  }
}

/** the "Group ▾" button that stands in for a group pushed out of the Top band (shown only then); it opens the group's body as a dropdown */
export function moreButton(el, group, key) {
  return el('button', { type: 'button', class: `gmore g-${key}`, 'aria-haspopup': 'true', 'aria-expanded': 'false', title: `${group} tools`, 'aria-label': `${group} tools`, text: `${group} \u25BE` });
}

/** the group's body: its tool buttons (.gbody) or the Hatch controls (.xbody) */
const bodyOf = (tg) => tg.querySelector(':scope > .gbody, :scope > .xbody');
let pop = null; // the open dropdown: { tg, body, btn, off }

/** close the open group dropdown; `refocus` returns focus to its "Group ▾" button */
export function closeGroupMenu(refocus = false) {
  if (!pop) return;
  const { body, btn, off } = pop; pop = null;
  off();
  body.classList.remove('gpop'); body.style.left = body.style.top = body.style.maxHeight = '';
  btn.setAttribute('aria-expanded', 'false');
  if (refocus && btn.isConnected) btn.focus();
}

/** open a pushed-out group's tools under its "Group ▾" button; arrow keys move, Escape / Tab / outside click / choosing a tool close it */
function openGroupMenu(tg, btn) {
  closeGroupMenu();
  const body = bodyOf(tg); if (!body) return;
  body.classList.add('gpop');
  const b = btn.getBoundingClientRect(), r = body.getBoundingClientRect();
  body.style.left = `${Math.max(4, Math.min(b.left, innerWidth - r.width - 4))}px`;
  body.style.top = `${b.bottom + 2}px`; body.style.maxHeight = `${innerHeight - b.bottom - 8}px`;
  btn.setAttribute('aria-expanded', 'true');
  const items = () => [...body.querySelectorAll('button, select, input')].filter((n) => !n.disabled && n.getClientRects().length);
  const onKey = (e) => {
    const list = items(), k = list.indexOf(document.activeElement);
    if (e.key === 'Escape') closeGroupMenu(true);
    else if (k < 0) return;
    else if (e.key === 'Tab') { closeGroupMenu(); return; }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !['SELECT', 'INPUT'].includes(document.activeElement.tagName)) list[(k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  const onDown = (e) => { if (!body.contains(e.target) && !btn.contains(e.target)) closeGroupMenu(); };
  const onPick = (e) => { if (e.target.closest('button')) closeGroupMenu(); };
  const onAway = () => closeGroupMenu();
  document.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', onDown, true);
  body.addEventListener('click', onPick); window.addEventListener('blur', onAway);
  pop = { tg, body, btn, off: () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true); body.removeEventListener('click', onPick); window.removeEventListener('blur', onAway); } };
  items()[0]?.focus();
}

/**
 * Top band: show every group, then push groups out from the right (each becomes its "Group ▾" button) until the band no longer
 * overflows. Any other placement shows every group. `box` is #tools; `top` is true for the Top band.
 */
export function fitToolBand(box, top) {
  closeGroupMenu();
  const groups = [...box.querySelectorAll(':scope > .tgroup')];
  for (const g of groups) g.classList.remove('ovf');
  if (!top) return;
  for (let i = groups.length - 1; i >= 0 && box.scrollWidth > box.clientWidth; i--) groups[i].classList.add('ovf');
}

/** wire the "Group ▾" buttons (one delegated listener) and refit the band when its width changes */
export function initToolBand(box, isTop) {
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.gmore'); if (!btn) return;
    if (pop?.btn === btn) closeGroupMenu(); else openGroupMenu(btn.closest('.tgroup'), btn);
  });
  let w = -1;
  new ResizeObserver(() => { if (box.clientWidth !== w) { w = box.clientWidth; fitToolBand(box, isTop()); } }).observe(box);
}

/** fold the named groups (saved state) and unfold the others */
export function applyCollapsed(box, keys) {
  for (const body of box.querySelectorAll('.gbody[data-body]')) {
    body.hidden = keys.includes(body.dataset.body);
    box.querySelector(`[data-head="${body.dataset.body}"]`)?.setAttribute('aria-expanded', String(!body.hidden));
  }
}
