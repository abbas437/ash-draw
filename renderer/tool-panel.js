// ASH Draw Studio - the left tool panel: its command buttons (by group) and how it is built. DOM-free at import time.
import { iconSvg } from './icons.js';

/** [group, colour key, [[command id, label, alias?], ...]]; the colour key picks the group's icon colour in styles.css */
export const TOOL_BUTTONS = [
  ['Select', 'select', [['select', 'Select']]],
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

/** tooltip of a command button: "Line (L)" */
export const toolTitle = (label, alias) => (alias ? `${label} (${alias})` : label);

/** an icon + label button; the label can be hidden by the panel's no-labels class, the name stays in title and aria-label */
export function iconButton(el, icon, label, attrs) {
  return el('button', { ...attrs, 'aria-label': label }, iconSvg(icon), el('span', { class: 'lbl', text: label }));
}

/**
 * Fill the tool panel. `extras(group, box)` lets the caller append non-command controls after a group (dimension style list).
 * Returns nothing; buttons carry data-tool and data-group.
 */
export function buildToolPanel(box, el, setTool, extras = () => {}) {
  for (const [group, key, items] of TOOL_BUTTONS) {
    box.append(el('div', { class: `group g-${key}`, text: group }));
    for (const [id, label, alias] of items) {
      box.append(iconButton(el, id, label, { 'data-tool': id, 'data-group': key, class: `g-${key}`, title: toolTitle(label, alias), onclick: () => setTool(id) }));
    }
    extras(group, box);
  }
}
