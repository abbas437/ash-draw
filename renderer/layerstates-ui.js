// ASH Draw Studio - LAYERSTATE / LAS / LMAN: the Layer States Manager. Save the layers' settings under a name, restore
// them later (each action is one undo step, see src/core/layerstates.js), import and export AutoCAD .las files.
// Setting 'layerstates.restoreMask': the LS bits Restore applies (the "Restore these properties" checkboxes).
import { LS, LS_ALL, LS_PROPS, listLayerStates, getLayerState, stateMatches, saveLayerState, restoreLayerState, deleteLayerState, renameLayerState, exportLas, parseLas, importLayerStates } from '../src/core/layerstates.js';
import { savePathIn } from './files.js';
import { el, modal, message, promptDialog, toast } from './ui.js';

const MASK_KEY = 'layerstates.restoreMask';
const LABELS = { on: 'On / off', frozen: 'Frozen / thawed', locked: 'Locked / unlocked', plot: 'Plot / no plot', color: 'Colour', linetype: 'Linetype', lineweight: 'Lineweight', transparency: 'Transparency' };
let offMissing = false; // "Turn off layers not found in the state", kept for the session

/** Yes / No question; Esc counts as No */
const ask = async (title, text) => (await modal(title, el('p', { text }), [{ label: 'Yes', value: true, primary: true }, { label: 'No', value: false }])) === true;

/** name + description form; null on Cancel / Esc or an empty name */
async function nameDialog(title, name = '', description = '') {
  const n = el('input', { type: 'text', id: 'ls-name', value: name, style: 'width:100%' });
  const d = el('input', { type: 'text', id: 'ls-desc', value: description, style: 'width:100%' });
  const r = await modal(title, el('div', { class: 'ls-form' }, el('label', {}, 'Name', n), el('label', {}, 'Description', d)), [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  const v = n.value.trim();
  return r === 'ok' && v ? { name: v, description: d.value.trim() } : null;
}

/** New…: save the current layers under a new name (an existing name is replaced after asking); returns the name or null */
async function newState(app) {
  const r = await nameDialog('New layer state');
  if (!r) return null;
  if (getLayerState(app.doc, r.name) && !(await ask('Layer state exists', `A layer state named "${r.name}" already exists. Replace it?`))) return null;
  return saveLayerState(app.session, r.name, r.description).name;
}

/** Import .las…: states that clash with an existing name are taken only when the user says so; returns the first name added */
async function importLas(app) {
  const files = await window.api.openFiles({ filters: [{ name: 'Layer states (*.las)', extensions: ['las'] }], multiple: false });
  if (!files?.length) return null;
  let states;
  try { states = parseLas(new TextDecoder('utf-8').decode(files[0].bytes)); } catch (err) { await message('Import layer states', err.message); return null; }
  if (!states.length) { toast('The file has no layer states.'); return null; }
  const replace = new Set();
  for (const st of states) {
    if (getLayerState(app.doc, st.name) && (await ask('Layer state exists', `A layer state named "${st.name}" already exists. Replace it with the imported one?`))) replace.add(st.name);
  }
  const added = importLayerStates(app.session, states, (n) => replace.has(n));
  toast(added.length ? `Imported: ${added.join(', ')}` : 'No layer states were imported.', 3000);
  return added[0] ?? null;
}

/** Export .las…: the selected state, in a file named after it */
async function exportState(app, st) {
  const file = `${st.name.replace(/[\\/:*?"<>|]/g, '_')}.las`;
  await window.api.saveFile({ defaultPath: savePathIn(app.file?.path, file), filters: [{ name: 'Layer states', extensions: ['las'] }], bytes: new TextEncoder().encode(exportLas([st])) });
}

/** the Layer States Manager. Actions that ask a question close it and open it again afterwards; Restore closes it. */
export async function layerStatesDialog(app) {
  let mask = LS_ALL;
  try { const v = await window.api.settingsGet?.(MASK_KEY); if (Number.isInteger(v)) mask = v & LS_ALL; } catch { /* default: all */ }
  let sel = listLayerStates(app.doc)[0]?.name ?? null;
  for (;;) {
    const s = app.session, doc = app.doc;
    let action = null;
    const close = (a) => { action = a; document.getElementById('dlg').close(); };
    const list = el('div', { class: 'ls-list', role: 'listbox', 'aria-label': 'Layer states' });
    const render = () => {
      const all = listLayerStates(doc);
      if (!all.some((st) => st.name === sel)) sel = all[0]?.name ?? null;
      list.replaceChildren(...(all.length ? all.map((st) => el('div', {
        class: `ls-row${st.name === sel ? ' cur' : ''}`, role: 'option', 'data-name': st.name, title: 'Double-click to restore',
        onclick: () => { sel = st.name; render(); }, ondblclick: () => { sel = st.name; close('restore'); },
      }, el('span', { class: 'ls-name', text: st.name }), el('span', { class: 'ls-desc', text: st.description ?? '' }),
      el('span', { class: 'ls-match', title: 'Matches the current layers', text: stateMatches(doc, st) ? '✓' : '' }))) : [el('div', { class: 'ls-none', text: 'No layer states saved in this drawing.' })]));
      for (const b of needSel) b.disabled = !sel;
    };
    const btn = (id, label, title, onclick) => el('button', { type: 'button', id, title, onclick }, label);
    const needSel = [
      btn('ls-update', 'Update', 'Save the current layers under the selected name', () => { saveLayerState(s, sel); toast(`Layer state ${sel} updated.`, 2000); render(); }),
      btn('ls-rename', 'Rename…', 'Rename the selected layer state', () => close('rename')),
      btn('ls-delete', 'Delete', 'Delete the selected layer state', () => { deleteLayerState(s, sel); sel = null; render(); }),
      btn('ls-export', 'Export .las…', 'Save the selected layer state as an AutoCAD .las file', () => exportState(app, getLayerState(doc, sel))),
    ];
    const boxes = LS_PROPS.map((p) => el('input', { type: 'checkbox', 'data-prop': p, checked: !!(mask & LS[p]) }));
    const off = el('input', { type: 'checkbox', id: 'ls-offmissing', checked: offMissing });
    render();
    const body = el('div', { class: 'ls' },
      el('div', { class: 'ls-main' }, list, el('div', { class: 'ls-btns' },
        btn('ls-new', 'New…', 'Save the current layers as a new layer state', () => close('new')), ...needSel.slice(0, 3),
        btn('ls-import', 'Import .las…', 'Add layer states from an AutoCAD .las file', () => close('import')), needSel[3])),
      el('fieldset', { class: 'ls-opts' }, el('legend', { text: 'Restore these properties' }),
        boxes.map((b) => el('label', {}, b, ` ${LABELS[b.dataset.prop]}`))),
      el('label', { class: 'ls-off' }, off, ' Turn off layers not found in the state'));
    const r = await modal('Layer states', body, [{ label: 'Restore', value: 'restore', primary: true }, { label: 'Close', value: null }]);
    action ??= r;
    const m = boxes.reduce((acc, b) => (b.checked ? acc : acc & ~LS[b.dataset.prop]), LS_ALL);
    offMissing = off.checked;
    if (m !== mask) { mask = m; window.api.settingsSet?.(MASK_KEY, m)?.catch?.(() => {}); }
    if (!action) return;
    if (action === 'restore') {
      if (!sel) { toast('Select a layer state to restore.'); continue; }
      const n = restoreLayerState(s, sel, { mask, offMissing });
      app.refreshPanels(); app.vp.requestRender();
      toast(n > 0 ? `Layer state ${sel} restored (${n} layer${n === 1 ? '' : 's'} changed).` : `Layer state ${sel}: the layers already match.`, 2500);
      return;
    }
    if (action === 'new') sel = (await newState(app)) ?? sel;
    else if (action === 'import') sel = (await importLas(app)) ?? sel;
    else if (action === 'rename') {
      const to = (await promptDialog(`Rename layer state ${sel}`, sel))?.trim();
      if (to && to !== sel) { if (renameLayerState(s, sel, to)) sel = to; else toast(`A layer state named "${to}" already exists.`); }
    }
  }
}
