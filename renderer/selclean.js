// ASH Draw Studio - QSELECT (Quick Select), SELECTSIMILAR and PURGE dialogs (logic in src/core/select-filter.js, purge.js).
import { quickSelect, selectSimilar, typesPresent, propsFor, operatorsFor, valueChoices } from '../src/core/select-filter.js';
import { purgeable, planPurge, applyPurge, zeroLengthCleanup, KINDS } from '../src/core/purge.js';
import { el, modal, toast } from './ui.js';

const OPS = { '=': '= Equals', '<>': '<> Not equal', '>': '> Greater than', '<': '< Less than', '*': '* Wildcard match' };
const opt = (value, text = value) => el('option', { value, text });
const row = (label, ctl) => el('label', { style: 'display:grid;grid-template-columns:9em 1fr;gap:8px;align-items:center;margin:4px 0' }, el('span', { text: label }), ctl);

/** QSELECT: filter the current space (model, or the shown layout's paper space) */
export async function qselectDialog(app) {
  const ents = app.doc.entities, selIds = [...app.vp.selection];
  const apply = el('select', { name: 'qs-apply' }, opt('all', 'Entire drawing'), selIds.length ? opt('selection', 'Current selection') : null);
  if (selIds.length) apply.value = 'selection';
  const type = el('select', { name: 'qs-type' }), prop = el('select', { name: 'qs-prop' }), op = el('select', { name: 'qs-op' });
  const valWrap = el('span'), note = el('p', { class: 'hint', style: 'margin:4px 0;font-size:12px;opacity:.8' });
  const fillValue = () => {
    const ch = op.value !== '*' && valueChoices(app.doc, ents, prop.value);
    valWrap.replaceChildren(ch ? el('select', { name: 'qs-value' }, ch.map((v) => opt(v))) : el('input', { name: 'qs-value', type: 'text' }));
    note.textContent = prop.value === 'Color' ? 'Colour compares the stored value: ByLayer is a value of its own (an object that is ByLayer on a red layer is not "Red").' : '';
  };
  const fillOps = () => { op.replaceChildren(...operatorsFor(prop.value).map((o) => opt(o, OPS[o]))); fillValue(); };
  const fillProps = () => { const cur = prop.value; prop.replaceChildren(...propsFor(type.value).map((p) => opt(p))); if (propsFor(type.value).includes(cur)) prop.value = cur; fillOps(); };
  const fillTypes = () => {
    const pool = apply.value === 'selection' ? ents.filter((e) => app.vp.selection.has(e.id)) : ents;
    type.replaceChildren(opt('*', 'Multiple'), ...typesPresent(pool).map((t) => opt(t))); fillProps();
  };
  apply.onchange = fillTypes; type.onchange = fillProps; prop.onchange = fillOps; op.onchange = fillValue;
  fillTypes();
  const inc = el('input', { type: 'radio', name: 'qs-mode', value: 'include', checked: true }), exc = el('input', { type: 'radio', name: 'qs-mode', value: 'exclude' });
  const append = el('input', { type: 'checkbox', name: 'qs-append' });
  const body = el('div', { class: 'qselect' }, row('Apply to', apply), row('Object type', type), row('Properties', prop), row('Operator', op), row('Value', valWrap), note,
    el('fieldset', { style: 'margin-top:6px' }, el('legend', { text: 'How to apply' }), el('label', {}, inc, ' Include in new selection set'), el('br'), el('label', {}, exc, ' Exclude from new selection set')),
    el('label', { style: 'display:block;margin-top:6px' }, append, ' Append to current selection set'));
  const ok = await modal('Quick Select', body, [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: null }]);
  if (!ok) return null;
  const ids = quickSelect(ents, selIds, { applyTo: apply.value, type: type.value, prop: prop.value, op: op.value, value: valWrap.firstChild.value, exclude: exc.checked, append: append.checked });
  app.vp.setSelection(ids);
  toast(`${ids.length} objects selected`, 2500);
  return ids;
}

/** SELECTSIMILAR: with objects selected, or select then press Enter */
export function selectSimilarCommand(app) {
  const run = () => {
    const ids = selectSimilar(app.doc.entities, [...app.vp.selection]);
    app.vp.setSelection(ids);
    toast(`${ids.length} objects selected`, 2500);
  };
  if (app.vp.selection.size) { run(); return; }
  app.pendingEnter = () => { app.pendingEnter = null; if (app.vp.selection.size) run(); };
  toast('SELECTSIMILAR: select objects, then press Enter.', 4000);
}

/** PURGE: unused named items of the whole drawing, one undo step */
export async function purgeDialog(app) {
  const doc = app.fileDoc, currentLayer = app.state.layer, currentLinetype = app.state.linetype;
  const items = purgeable(doc, { currentLayer, currentLinetype });
  const geo = zeroLengthCleanup(doc).reduce((n, g) => n + g.removed, 0);
  const boxes = [];
  const groups = KINDS.map((k) => el('fieldset', { style: 'margin:4px 0' }, el('legend', { text: `${k} (${items[k].length})` }),
    items[k].length ? items[k].map((n) => { const b = el('input', { type: 'checkbox', checked: true, 'data-kind': k, 'data-name': n }); boxes.push(b); return el('label', { style: 'display:block' }, b, ` ${n}`); })
      : el('span', { style: 'opacity:.7', text: 'none unused' })));
  const nested = el('input', { type: 'checkbox', name: 'purge-nested', checked: true });
  const zero = el('input', { type: 'checkbox', name: 'purge-zero' });
  const body = el('div', { class: 'purge', style: 'max-height:60vh;overflow:auto;min-width:22em' }, groups,
    el('label', { style: 'display:block;margin-top:6px' }, nested, ' Purge nested items'),
    el('label', { style: 'display:block' }, zero, ` Purge zero-length geometry and empty text objects (${geo})`));
  const how = await modal('Purge', body, [{ label: 'Purge checked', value: 'checked' }, { label: 'Purge all', value: 'all', primary: true }, { label: 'Close', value: null }]);
  if (!how) return null;
  const pick = how === 'all' ? 'all' : Object.fromEntries(KINDS.map((k) => [k, boxes.filter((b) => b.checked && b.dataset.kind === k).map((b) => b.dataset.name)]));
  const plan = planPurge(doc, { pick, nested: nested.checked, currentLayer, currentLinetype });
  if (!plan.length && !(zero.checked && geo)) { toast('Nothing to purge.'); return null; }
  const r = applyPurge(app.session, doc, plan, { zeroLength: zero.checked });
  toast(`Purged ${r.items} item(s)${r.geometry ? `, ${r.geometry} zero-length/empty object(s)` : ''}.`, 3000);
  return r;
}
