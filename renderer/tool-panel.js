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
    box.append(el('div', { class: 'tgroup', 'data-group': key }, head, body)); // .tgroup is transparent in the Left panel, a column in the Top band
  }
}

/** fold the named groups (saved state) and unfold the others */
export function applyCollapsed(box, keys) {
  for (const body of box.querySelectorAll('.gbody[data-body]')) {
    body.hidden = keys.includes(body.dataset.body);
    box.querySelector(`[data-head="${body.dataset.body}"]`)?.setAttribute('aria-expanded', String(!body.hidden));
  }
}
