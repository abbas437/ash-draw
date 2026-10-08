// ASH Draw Studio - DOM helpers, dialogs, layers panel and properties panel.
import { setLayerProps, setEntityProps, setText, deleteLayer } from '../src/core/edit.js';
import { tessellate, dist, DEG } from '../src/core/geom.js';
import { aciToRgb } from '../src/core/aci.js';
import { editEntity } from './grips.js';

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

// ---------------------------------------------------------------------------------------------
// dialogs
const dlg = () => document.getElementById('dlg');

/** generic modal: body = DOM node, buttons = [{label, value, primary}] -> resolves with the chosen value (null on Esc) */
export function modal(title, body, buttons = [{ label: 'OK', value: true, primary: true }]) {
  return new Promise((resolve) => {
    const d = dlg();
    d.replaceChildren(
      el('h2', { text: title }), el('div', { class: 'dlg-body' }, body),
      el('div', { class: 'dlg-btns' }, buttons.map((b) => el('button', { class: b.primary ? 'primary' : '', onclick: () => { d.close(); resolve(b.value); } }, b.label))),
    );
    d.onclose = () => { if (!d.open) resolve(null); }; // Esc. A button's close() fires its event later, maybe after the next modal() opened: ignore that stale one
    d.showModal();
    d.querySelector('input,textarea,select,button.primary')?.focus();
  });
}
export const message = (title, text, extra) => modal(title, [el('p', { text }), extra]);
export async function confirmDialog(title, text, yes = 'Yes', no = 'No', cancel = 'Cancel') {
  return modal(title, el('p', { text }), [{ label: yes, value: 'yes', primary: true }, { label: no, value: 'no' }, ...(cancel ? [{ label: cancel, value: null }] : [])]);
}
export async function promptDialog(title, value = '') {
  const input = el('input', { type: 'text', value, style: 'width:100%' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg().querySelector('button.primary').click(); } });
  const r = await modal(title, input, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  return r === 'ok' ? input.value : null;
}
export async function textDialog({ title, value = '', height = 1 }) {
  const ta = el('textarea', { rows: 4, style: 'width:100%' }); ta.value = value;
  const h = el('input', { type: 'number', step: 'any', min: '0', value: String(height), style: 'width:8em' });
  const r = await modal(title, [el('label', {}, 'Text (Enter = new line)'), ta, el('label', { style: 'display:block;margin-top:8px' }, 'Text height (drawing units) ', h)],
    [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  if (r !== 'ok') return null;
  const hv = Number(h.value);
  return { text: ta.value, height: hv > 0 ? hv : height };
}

let toastTimer = 0;
export function toast(text, ms = 4500) {
  const t = document.getElementById('toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------------------------------------------------------------------------------------
// shared option lists
export const ACI_CHOICES = [[256, 'ByLayer'], [1, '1 Red'], [2, '2 Yellow'], [3, '3 Green'], [4, '4 Cyan'], [5, '5 Blue'], [6, '6 Magenta'], [7, '7 White/Black'], [8, '8 Grey'], [9, '9 Light grey']];
export const LW_CHOICES = [[-1, 'ByLayer'], [-3, 'Default'], [0.13, '0.13 mm'], [0.18, '0.18 mm'], [0.25, '0.25 mm'], [0.35, '0.35 mm'], [0.5, '0.50 mm'], [0.7, '0.70 mm'], [1, '1.00 mm'], [1.4, '1.40 mm'], [2, '2.00 mm']];
const cssOfAci = (c) => { if (c === 7 || c === 256) return '#dddddd'; const [r, g, b] = aciToRgb(c); return `rgb(${r},${g},${b})`; };
const colorKey = (c) => (c && typeof c === 'object' ? `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` : String(c));

function select(options, current, onchange, extraClass = '') {
  const s = el('select', { class: extraClass, onchange: (e) => onchange(e.target.value) });
  for (const [v, label] of options) s.append(el('option', { value: String(v), text: label }));
  if (![...s.options].some((o) => o.value === String(current))) s.append(el('option', { value: String(current), text: String(current) }));
  s.value = String(current);
  return s;
}

// ---------------------------------------------------------------------------------------------
// layers panel
export function renderLayers(app) {
  const box = document.getElementById('layers');
  const { doc, session } = app;
  const rows = [...doc.layers.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const used = new Map();
  for (const e of doc.entities) used.set(e.layer, (used.get(e.layer) ?? 0) + 1);
  box.replaceChildren(...rows.map((l) => el('div', { class: `layer${app.state.layer === l.name ? ' current' : ''}` },
    // On/Off and Freeze/Thaw are independent flags (AutoCAD): toggling one never touches the other
    el('button', { class: 'icon lay-on', title: l.visible !== false ? 'Turn layer off' : 'Turn layer on', onclick: () => { setLayerProps(session, l.name, { visible: l.visible === false }); } }, l.visible !== false ? '◉' : '○'),
    el('button', { class: 'icon lay-frz', title: l.frozen ? 'Thaw layer' : 'Freeze layer', onclick: () => { setLayerProps(session, l.name, { frozen: !l.frozen }); } }, l.frozen ? '❄' : '☀'),
    el('button', { class: 'icon', title: l.locked ? 'Unlock layer' : 'Lock layer', onclick: () => { setLayerProps(session, l.name, { locked: !l.locked }); } }, l.locked ? '🔒' : '🔓'),
    el('span', { class: 'swatch', style: `background:${cssOfAci(Math.abs(l.color))}`, title: 'Layer colour (click to change)', onclick: (e) => colorMenu(e, (c) => setLayerProps(session, l.name, { color: c })) }),
    el('span', { class: 'lname', title: `${used.get(l.name) ?? 0} object(s)`, ondblclick: () => { app.state.layer = l.name; app.refreshPanels(); }, text: l.name }),
    app.state.layer === l.name ? el('span', { class: 'cur', text: '●', title: 'Current layer' }) : el('button', { class: 'icon', title: 'Make current', onclick: () => { app.state.layer = l.name; app.refreshPanels(); } }, '○'),
  )));
  document.getElementById('layer-add').onclick = async () => {
    const name = (await promptDialog('New layer name'))?.trim();
    if (!name) return;
    if (doc.layers.has(name)) { toast('A layer with that name already exists.'); return; }
    setLayerProps(session, name, { color: 7 });
    app.state.layer = name; app.refreshPanels();
  };
  document.getElementById('layer-del').onclick = () => {
    const n = app.state.layer;
    if (!deleteLayer(session, n)) toast(n === '0' ? 'Layer 0 cannot be deleted.' : 'Only empty layers can be deleted.');
    else { app.state.layer = '0'; app.refreshPanels(); }
  };
}

function colorMenu(ev, pick) {
  document.querySelector('.popmenu')?.remove();
  const m = el('div', { class: 'popmenu', style: `left:${ev.clientX}px;top:${ev.clientY}px` },
    ACI_CHOICES.filter(([c]) => c !== 256).map(([c, label]) => el('button', { onclick: () => { m.remove(); pick(c); } }, el('span', { class: 'swatch', style: `background:${cssOfAci(c)}` }), ` ${label}`)));
  document.body.append(m);
  setTimeout(() => document.addEventListener('pointerdown', () => m.remove(), { once: true }), 0);
}

// ---------------------------------------------------------------------------------------------
// properties panel
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(4)).replace(/\.?0+$/, '');

function describe(e, doc) {
  switch (e.type) {
    case 'LINE': return [['Length', fmt(dist(e.p1, e.p2))], ['Angle', `${fmt(((Math.atan2(e.p2.y - e.p1.y, e.p2.x - e.p1.x) / DEG) + 360) % 360)}°`]];
    case 'CIRCLE': return [['Circumference', fmt(2 * Math.PI * e.r)], ['Area', fmt(Math.PI * e.r * e.r)]];
    case 'ARC': return [];
    case 'LWPOLYLINE': {
      const pl = tessellate(e, doc, 0)[0] ?? [];
      let len = 0; for (let i = 1; i < pl.length; i++) len += dist(pl[i - 1], pl[i]);
      return [['Vertices', String(e.vertices.length)], ['Closed', e.closed ? 'yes' : 'no'], ['Length', fmt(len)]];
    }
    case 'INSERT': return [['Block', e.block], ['Position', `${fmt(e.p.x)}, ${fmt(e.p.y)}`], ['Scale', `${fmt(e.sx)} × ${fmt(e.sy)}`], ['Rotation', `${fmt(e.rot)}°`]];
    case 'TEXT': case 'MTEXT': return [['Position', `${fmt(e.p.x)}, ${fmt(e.p.y)}`]];
    case 'HATCH': return [['Pattern', e.pattern], ['Loops', String(e.loops.length)]];
    default: return [];
  }
}

export function renderProperties(app) {
  const box = document.getElementById('props');
  const { doc, session, vp } = app;
  const ents = vp.selectedEntities();
  const apply = (props) => { if (ents.length) setEntityProps(session, ents.map((e) => e.id), props); else Object.assign(app.state, props); app.refreshPanels(); };
  const common = (k, dflt) => (ents.length ? (ents.every((e) => colorKey(e[k]) === colorKey(ents[0][k])) ? ents[0][k] : null) : app.state[k] ?? dflt);
  const layerNames = [...doc.layers.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const layerVal = ents.length ? (ents.every((e) => e.layer === ents[0].layer) ? ents[0].layer : null) : app.state.layer;
  const mixed = (v, make) => (v === null ? (() => { const s = make('__mixed__'); s.prepend(el('option', { value: '__mixed__', text: '— varies —' })); s.value = '__mixed__'; return s; })() : make(v));
  const rowsInfo = ents.length === 1 ? describe(ents[0], doc) : [];
  const lts = [['BYLAYER', 'ByLayer'], ...[...doc.linetypes.keys()].map((n) => [n, n])];

  const kids = [
    el('div', { class: 'phead', text: ents.length ? `${ents.length} selected${ents.length === 1 ? ` — ${ents[0].type}` : ''}` : 'Defaults for new objects' }),
    el('label', {}, 'Layer', mixed(layerVal, (v) => select(layerNames.map((n) => [n, n]), v, (x) => x !== '__mixed__' && apply({ layer: x })))),
    el('label', {}, 'Colour', mixed(common('color', 256) === null ? null : colorKey(common('color', 256)), (v) => select(ACI_CHOICES, v, (x) => x !== '__mixed__' && apply({ color: Number(x) })))),
    el('label', {}, 'Linetype', mixed(common('linetype', 'BYLAYER') === null ? null : String(common('linetype', 'BYLAYER')).toUpperCase(), (v) => select(lts, v, (x) => x !== '__mixed__' && apply({ linetype: x })))),
    el('label', {}, 'Lineweight', mixed(common('lineweight', -1), (v) => select(LW_CHOICES, v, (x) => x !== '__mixed__' && apply({ lineweight: Number(x) })))),
    ...rowsInfo.map(([k, v]) => el('div', { class: 'info' }, el('span', { text: k }), el('b', { text: v }))),
  ];
  if (ents.length === 1) kids.push(...geometryFields(app, ents[0]));
  if (ents.length === 1 && (ents[0].type === 'TEXT' || ents[0].type === 'MTEXT')) {
    const e = ents[0];
    const ta = el('textarea', { rows: 3 }); ta.value = e.text.replace(/\\P/g, '\n');
    ta.onchange = () => { setText(session, e.id, { text: e.type === 'MTEXT' ? ta.value.replace(/\n/g, '\\P') : ta.value.replace(/\n/g, ' ') }); };
    kids.push(el('label', {}, 'Text', ta));
  }
  box.replaceChildren(...kids);
}

// ---- editable geometry (single selection); every change is one undo step -------------------------
const polyVertex = { id: 0, i: 0 }; // vertex shown in the palette for the selected polyline
function geometryFields(app, e) {
  const edit = (fn) => editEntity(app.session, e.id, (c) => fn(c) ?? c, 'Properties');
  const field = (label, value, set, ok = Number.isFinite) => {
    const inp = el('input', { type: 'text', 'data-prop': label, value: fmtField(value) });
    inp.onchange = () => { const v = Number(inp.value.trim().replace(',', '.')); if (inp.value.trim() !== '' && ok(v)) edit((c) => set(c, v)); else inp.value = fmtField(value); };
    return el('label', {}, label, inp);
  };
  const pos = (v) => Number.isFinite(v) && v > 0;
  const xy = (name, get) => [field(`${name} X`, get(e).x, (c, v) => { get(c).x = v; }), field(`${name} Y`, get(e).y, (c, v) => { get(c).y = v; })];
  switch (e.type) {
    case 'LINE': return [...xy('Start', (x) => x.p1), ...xy('End', (x) => x.p2)];
    case 'CIRCLE': return [...xy('Center', (x) => x.c), field('Radius', e.r, (c, v) => { c.r = v; }, pos), field('Diameter', 2 * e.r, (c, v) => { c.r = v / 2; }, pos)];
    case 'ARC': return [...xy('Center', (x) => x.c), field('Radius', e.r, (c, v) => { c.r = v; }, pos),
      field('Start angle', e.a0, (c, v) => { c.a0 = v; }), field('End angle', e.a1, (c, v) => { c.a1 = v; })];
    case 'ELLIPSE': {
      const R = Math.hypot(e.major.x, e.major.y);
      return [...xy('Center', (x) => x.c), field('Major radius', R, (c, v) => { c.major = { x: (e.major.x / R) * v, y: (e.major.y / R) * v }; }, pos),
        field('Ratio', e.ratio, (c, v) => { c.ratio = v; }, (v) => v > 0 && v <= 1)];
    }
    case 'INSERT': { // editEntity carries the ATTRIBs to the new placement
      const nz = (v) => Number.isFinite(v) && v !== 0;
      return [...xy('Position', (x) => x.p), field('Scale X', e.sx ?? 1, (c, v) => { c.sx = v; }, nz), field('Scale Y', e.sy ?? 1, (c, v) => { c.sy = v; }, nz),
        field('Rotation', e.rot ?? 0, (c, v) => { c.rot = v; })];
    }
    case 'TEXT': case 'MTEXT': return [field('Height', e.height, (c, v) => { c.height = v; }, pos), field('Rotation', e.rot ?? 0, (c, v) => { c.rot = v; })];
    case 'LWPOLYLINE': {
      if (polyVertex.id !== e.id || polyVertex.i >= e.vertices.length) Object.assign(polyVertex, { id: e.id, i: 0 });
      const i = polyVertex.i, n = e.vertices.length;
      const step = (d) => { polyVertex.i = (i + d + n) % n; app.refreshPanels(true); };
      return [el('label', {}, 'Vertex', el('span', {}, el('button', { class: 'icon', title: 'Previous vertex', onclick: () => step(-1) }, '‹'), ` ${i + 1} / ${n} `,
        el('button', { class: 'icon', title: 'Next vertex', onclick: () => step(1) }, '›'))), ...xy('Vertex', (x) => x.vertices[i])];
    }
    default: return [];
  }
}
const fmtField = (v) => String(Math.round(v * 1e6) / 1e6);
