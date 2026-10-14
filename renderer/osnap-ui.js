// ASH Draw Studio - Drafting Settings dialog (OSNAP / DSETTINGS; right-click on SNAP or POLAR in the status bar):
// running object snap modes and polar tracking. Saved as settings 'osnap.on', 'osnap.modes', 'polar.step', 'polar.extra'.
import { el, modal } from './ui.js';
import { OSNAP_MODES, POLAR_STEPS, cleanModes, parseAngles, snapGlyph } from '../src/core/osnap.js';
import { glyphPath } from './viewport.js';

const api = window.api;

/** read the saved snap / polar settings into vp.settings (start-up) */
export async function loadDraftingSettings(app) {
  const st = app.vp.settings, get = (k) => api.settingsGet?.(k)?.catch?.(() => undefined);
  const [on, modes, step, extra] = await Promise.all([get('osnap.on'), get('osnap.modes'), get('polar.step'), get('polar.extra')]);
  if (typeof on === 'boolean') st.snap = on;
  const m = cleanModes(modes); if (m) st.kinds = new Set(m);
  if (POLAR_STEPS.includes(step)) st.polarStep = step;
  if (Array.isArray(extra)) st.polarExtra = parseAngles(extra.join(','));
  app.refreshToggles();
}
export function saveDraftingSettings(st) {
  api.settingsSet?.('osnap.on', !!st.snap)?.catch?.(() => {});
  api.settingsSet?.('osnap.modes', [...st.kinds])?.catch?.(() => {});
  api.settingsSet?.('polar.step', st.polarStep)?.catch?.(() => {});
  api.settingsSet?.('polar.extra', st.polarExtra)?.catch?.(() => {});
}

function glyphIcon(kind, dark) {
  const cv = el('canvas', { width: 18, height: 18, class: 'osnap-glyph' });
  const c = cv.getContext('2d');
  c.strokeStyle = dark ? '#ffd400' : '#b35c00'; c.lineWidth = 1.5; glyphPath(c, snapGlyph(kind), 9, 9, 6); c.stroke();
  return cv;
}

export async function draftingSettings(app) {
  const st = app.vp.settings;
  const box = (id, checked, label, extra = {}) => { const i = el('input', { type: 'checkbox', id, ...extra }); i.checked = checked; return [i, el('label', { for: id, text: label })]; };
  const [snapOn, snapOnL] = box('osnap-on', st.snap, 'Object Snap On (F3)');
  const modes = OSNAP_MODES.map(([k, label, ok]) => {
    const [i, l] = box(`osnap-${k}`, ok && st.kinds.has(k), ok ? label : `${label} (not yet)`, ok ? {} : { disabled: true });
    i.dataset.kind = k;
    return { k, ok, i, row: el('div', { class: 'osnap-mode' }, i, glyphIcon(k, st.dark), l) };
  });
  const setAll = (on) => { for (const m of modes) if (m.ok) m.i.checked = on; };
  const [polarOn, polarOnL] = box('polar-on', st.polar, 'Polar Tracking On (F10)');
  const step = el('select', { id: 'polar-step' }, POLAR_STEPS.map((a) => el('option', { value: String(a), text: `${a}°` })));
  step.value = String(st.polarStep);
  const extra = el('input', { id: 'polar-extra', type: 'text', value: st.polarExtra.join(', '), placeholder: 'e.g. 12.5, 80', style: 'width:12em' });
  const body = el('div', { id: 'osnap-dialog' },
    el('h3', { text: 'Object Snap' }), el('div', {}, snapOn, snapOnL),
    el('div', { class: 'osnap-grid', style: 'display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin:6px 0' }, modes.map((m) => m.row)),
    el('div', {}, el('button', { id: 'osnap-all', onclick: () => setAll(true) }, 'Select All'), ' ', el('button', { id: 'osnap-none', onclick: () => setAll(false) }, 'Clear All')),
    el('h3', { text: 'Polar Tracking' }), el('div', {}, polarOn, polarOnL),
    el('p', {}, el('label', { for: 'polar-step', text: 'Increment angle: ' }), step),
    el('p', {}, el('label', { for: 'polar-extra', text: 'Additional angles: ' }), extra));
  const r = await modal('Drafting Settings', body, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  if (r !== 'ok') return false;
  st.snap = snapOn.checked;
  st.kinds = new Set(modes.filter((m) => m.ok && m.i.checked).map((m) => m.k));
  st.polar = polarOn.checked; if (st.polar) st.ortho = false;
  st.polarStep = Number(step.value);
  st.polarExtra = parseAngles(extra.value);
  saveDraftingSettings(st);
  app.refreshToggles(); app.vp.requestRender();
  return true;
}
