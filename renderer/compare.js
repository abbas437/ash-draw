// ASH Draw Studio - File > Compare… (command COMPARE). Compares two drawings (open tabs or a file) and shows the
// result in a new tab: unchanged grey, added (B only) green, removed (A only) red, changed amber, a dotted rectangle
// around each change cluster (no revision clouds), and a side panel to step through the clusters, switch the view
// (differences, overlay, A only, B only) and plot it. A is aligned onto B automatically, by picked points, or not at all.
import * as core from '../src/core/compare.js'; // namespace: transformFromPoints may not exist yet (feature-detected)
import { OPEN_FILTERS, loadDrawing, prepareView } from './files.js';
import { runSliced } from '../src/core/slice.js';
import { Tool } from './tools.js';
import { el, modal, message, toast, progressToast } from './ui.js';

const { buildCompareDoc, defaultTolerance, defaultClusterGap, setCompareView, reclusterCompare, clusterMark, COMPARE_LAYERS } = core;
const VIEWS = [['differences', 'Differences'], ['overlay', 'Overlay'], ['a', 'A only'], ['b', 'B only']];
const UNIT_NAMES = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const CLUSTER_PAGE = 200; // rows of the cluster list shown at a time
const num = (v) => String(+(+v).toFixed(4) + 0);

/** one row of the cluster list */
export function clusterRow(k, i, onclick) {
  const who = k.moved ? `${k.moved === '*Model_Space' ? 'Other objects' : `Block ${k.moved}`} moved: ` : '';
  const t = who + (k.unbounded
    ? `${k.unbounded} unbounded objects (XLINE/RAY…)`
    : [k.added && `+${k.added} added`, k.removed && `−${k.removed} removed`, k.changed && `~${k.changed} changed`].filter(Boolean).join(', '));
  return el('div', { class: 'cmp-row', role: 'option', onclick }, `${i + 1}.`, el('span', { text: t }));
}

/** the offset line of the panel: how A was moved onto B, in words */
export function offsetText(c) {
  const o = c.r.offset ?? {};
  const m = Array.isArray(o.m) ? o.m : null;
  const dx = o.dx ?? m?.[4] ?? 0, dy = o.dy ?? m?.[5] ?? 0;
  const rot = m ? (Math.atan2(m[1], m[0]) * 180) / Math.PI : 0;
  if (c.align === 'auto' && !o.votes) return 'Not aligned: no common objects found to align A to B.';
  if (c.align === 'none' || (!dx && !dy && !rot && c.align !== 'auto')) return 'Not aligned (A compared where it is).';
  let t = `A aligned to B: moved ${num(dx)}, ${num(dy)}`;
  if (Math.abs(rot) > 1e-9) t += `; rotated ${num(rot)}°`;
  if (c.align === 'auto') t += ` (automatic; match ${(o.confidence ?? 0) >= 0.5 ? 'good' : 'weak'})`;
  else if (c.align === 'pick') t += ' (picked points)';
  return t;
}

/** one line per group of A aligned on its own (r.realigned), so the reviewer knows a group moved */
export function realignedLines(r) {
  return (r.realigned ?? []).map((g) => {
    const n = g.pieces != null ? ` (${g.pieces} pieces)` : '';
    const who = g.name === '*Model_Space' ? `The other objects${n}` : `Block ${g.name}${n}`;
    if (!g.moved || !g.rel) return `${who} lined up with B on their own (within tolerance of the rest).`;
    const rel = g.name === '*Model_Space' ? (g.ref?.length ? `${g.ref.length > 1 ? 'blocks' : 'block'} ${g.ref.join(', ')}` : 'the blocks') : 'the rest';
    const rot = Math.abs(g.rel.rot) > 1e-9 ? ` (rotated ${num(g.rel.rot)}°)` : '';
    return `${who} moved by ${num(g.rel.dx)}, ${num(g.rel.dy)}${rot} relative to ${rel} — shown as moved`;
  });
}

export class ComparePanel {
  constructor(app) {
    this.app = app;
    this.cur = -1;
    this.counts = el('div', { class: 'cmp-counts', role: 'status' });
    this.pos = el('span', { class: 'cmp-pos' });
    this.list = el('div', { class: 'cmp-list', role: 'listbox', 'aria-label': 'Change clusters' });
    this.offset = el('div', { class: 'cmp-offset' });
    this.showProps = el('input', { type: 'checkbox', id: 'cmp-showprops', checked: true, onchange: () => this.setShowProps(this.showProps.checked) });
    this.listProps = el('input', { type: 'checkbox', id: 'cmp-listprops', onchange: () => this.setListProps(this.listProps.checked) });
    this.view = el('select', { id: 'cmp-view', title: 'What the compare drawing shows', onchange: () => this.setView(this.view.value) },
      VIEWS.map(([v, label]) => el('option', { value: v, text: label })));
    const btn = (label, title, fn, id) => el('button', { id, title, onclick: fn }, label);
    this.box = el('div', { id: 'compare-panel', hidden: true, role: 'region', 'aria-label': 'Compare' },
      el('div', { class: 'phead' }, 'Compare', el('span', { class: 'spacer' }), btn('×', 'Hide panel', () => { this.box.hidden = true; }, 'cmp-close')),
      this.offset,
      this.counts,
      el('label', { class: 'cmp-opt', title: 'Draw objects that differ only in colour, linetype, lineweight or layer (dashed cyan, layer COMPARE-PROPS)' }, this.showProps, ' Show property-only changes'),
      el('label', { class: 'cmp-opt', title: 'Also group the property-only changes into the cluster list' }, this.listProps, ' Include property-only changes in the list'),
      el('div', { class: 'cmp-btns' }, el('label', {}, 'View ', this.view), el('span', { class: 'spacer' }), btn('Plot to PDF…', 'Plot or publish this compare drawing (the Plot dialog)', () => this.app.exportPdf(), 'cmp-plot')),
      el('div', { class: 'cmp-btns' }, btn('◀ Previous', 'Zoom to the previous change', () => this.step(-1), 'cmp-prev'), btn('Next ▶', 'Zoom to the next change', () => this.step(1), 'cmp-next'), this.pos),
      this.list);
    document.getElementById('stage').append(this.box);
  }

  /** show the panel for a compare tab, hide it for any other tab */
  sync() {
    const c = this.app.active?.compare;
    this.box.hidden = !c;
    if (!c || this.shown === c) return;
    this.shown = c; this.cur = -1;
    const sw = (cls, label, n) => el('span', { class: `cmp-n ${cls}`, 'data-kind': cls }, el('i'), `${label} ${n}`);
    this.offset.replaceChildren(el('div', { text: offsetText(c) }), ...realignedLines(c.r).map((t) => el('div', { class: 'cmp-realigned', text: t })));
    this.view.value = c.view ?? 'differences';
    this.showProps.checked = c.showProps !== false; this.listProps.checked = !!c.clusterProps;
    this.counts.replaceChildren(el('div', { class: 'cmp-files', text: `A: ${c.nameA}  →  B: ${c.nameB}` }),
      el('div', { class: 'cmp-files', text: 'Pieces (blocks counted by their parts):' }),
      sw('added', 'Added', c.r.added.length), sw('removed', 'Removed', c.r.removed.length), sw('changed', 'Changed (shape/position)', (c.r.changedGeometry ?? c.r.changed).length), sw('props', 'Changed (properties only)', (c.r.changedProps ?? []).length), sw('same', 'Unchanged', c.r.same.length));
    if (c.r.ignored > 0) this.counts.append(el('div', { class: 'cmp-ignored', text: `${c.r.ignored} pieces on ignored layers not compared` }));
    this.shownRows = 0;
    this.list.replaceChildren();
    this.more(); // the first page of the list
    this.mark();
  }
  /** append the next page of the cluster list (CLUSTER_PAGE rows); a "Show more…" row stays while rows remain */
  more() {
    const cl = this.app.active?.compare?.r.clusters ?? [];
    this.list.querySelector('.cmp-more')?.remove();
    for (let i = this.shownRows; i < Math.min(cl.length, this.shownRows + CLUSTER_PAGE); i++) this.list.append(clusterRow(cl[i], i, () => this.go(i)));
    this.shownRows = Math.min(cl.length, this.shownRows + CLUSTER_PAGE);
    if (this.shownRows < cl.length) this.list.append(el('div', { class: 'cmp-more', role: 'button', onclick: () => { this.more(); this.mark(); } }, `Show more… (${cl.length - this.shownRows} left)`));
  }
  /** show / hide the layer of the property-only changes (the view keeps its colours) */
  setShowProps(on) {
    const c = this.app.active?.compare; if (!c) return;
    c.showProps = on;
    this.applyShowProps(c);
    this.app.vp.refreshStructure();
    this.app.refreshPanels();
  }
  applyShowProps(c) {
    const layer = this.app.fileDoc?.layers.get(COMPARE_LAYERS.props.name);
    if (layer) layer.visible = c.showProps !== false;
  }
  /** property-only changes in / out of the cluster list: only the clusters are recomputed, from the stored result */
  setListProps(on) {
    const c = this.app.active?.compare; if (!c) return;
    c.clusterProps = on;
    c.r.clusters = reclusterCompare(c.a, c.b, c.r, on);
    for (const k of c.r.clusters) k.mark = clusterMark(k);
    this.cur = -1; this.shownRows = 0;
    this.list.replaceChildren();
    this.more();
    this.mark();
  }
  /** show the compare tab as differences / overlay / A only / B only (layer colours and visibility) */
  setView(v) {
    const c = this.app.active?.compare; if (!c) return;
    setCompareView(this.app.fileDoc, v);
    c.view = v; this.view.value = v;
    this.applyShowProps(c);
    this.app.vp.refreshStructure();
    this.app.refreshPanels();
  }
  mark() {
    const c = this.app.active?.compare, n = c?.r.clusters.length ?? 0;
    const diffs = c ? c.r.added.length + c.r.removed.length + c.r.changedGeometry.length : 0;
    this.pos.textContent = n ? `${this.cur < 0 ? '–' : this.cur + 1} of ${n}` : diffs ? `${diffs} differences` : c?.r.changedProps.length ? `${c.r.changedProps.length} property-only changes` : 'No differences';
    [...this.list.querySelectorAll('.cmp-row')].forEach((r, i) => { r.classList.toggle('cur', i === this.cur); r.setAttribute('aria-selected', String(i === this.cur)); });
  }
  go(i) {
    const c = this.app.active?.compare; if (!c?.r.clusters[i]) return;
    this.cur = i;
    while (i >= this.shownRows) this.more();
    this.app.vp.zoomBox(c.r.clusters[i].mark);
    this.list.children[i]?.scrollIntoView({ block: 'nearest' });
    this.mark();
  }
  step(d) {
    const n = this.app.active?.compare?.r.clusters.length ?? 0; if (!n) return;
    this.go(this.cur < 0 ? (d > 0 ? 0 : n - 1) : (this.cur + d + n) % n);
  }
}

/** ask for the two drawings: A (original) and B (revised); each an open tab or a file */
async function chooseDrawings(app) {
  const sources = app.tabs.filter((t) => !t.compare).map((t) => ({ label: t.file.name, doc: t.doc, tab: t }));
  const opt = (s, i) => el('option', { value: String(i), text: s.label });
  const selA = el('select', { id: 'cmp-a' }), selB = el('select', { id: 'cmp-b' });
  const fill = () => { for (const s of [selA, selB]) { const v = s.value; s.replaceChildren(...sources.map(opt)); if (v) s.value = v; } };
  fill();
  // defaults: B = the drawing shown, A = the tab before it (else the first other one)
  const cur = Math.max(sources.findIndex((s) => s.doc === app.doc), 0);
  const others = sources.map((s, i) => i).filter((i) => i !== cur);
  selB.value = String(cur);
  selA.value = String(others.filter((i) => i < cur).pop() ?? others[0] ?? cur);
  const browse = (sel) => el('button', { type: 'button', title: 'Compare with a drawing file', onclick: async () => {
    let files;
    try { files = await window.api.openFiles({ filters: OPEN_FILTERS, multiple: false }); } catch (err) { toast(`Could not open: ${err.message}`); return; }
    const f = files?.[0]; if (!f) return;
    try {
      const { doc } = await loadDrawing(window.api, f.name, f.bytes ?? await window.api.readFile(f.path));
      sources.push({ label: f.name, doc, file: { path: f.path ?? null, name: f.name, format: /\.dwg$/i.test(f.name) ? 'dwg' : 'dxf' } });
      fill(); sel.value = String(sources.length - 1); sel.dispatchEvent(new Event('change'));
    } catch (err) { await message('Cannot open this file', err.message || String(err)); }
  } }, 'File…');
  const align = el('select', { id: 'cmp-align' }, el('option', { value: 'none', text: 'None (compare where they are)' }),
    el('option', { value: 'auto', text: 'Automatic' }), el('option', { value: 'pick', text: 'Pick points (base point, optional second point)' }));
  align.value = 'auto';
  const tol = el('input', { id: 'cmp-tol', type: 'number', step: 'any', min: '0', style: 'width:8em' });
  const tolUnit = el('span');
  let tolEdited = false;
  tol.addEventListener('input', () => { tolEdited = true; });
  const tolDefault = () => {
    const u = sources[Number(selB.value)]?.doc.units;
    tolUnit.textContent = ` drawing units (1 mm${UNIT_NAMES[u] ? `; units: ${UNIT_NAMES[u]}` : ''})`;
    if (!tolEdited) tol.value = String(+defaultTolerance(u).toPrecision(6));
  };
  selB.addEventListener('change', tolDefault);
  tolDefault();
  const gap = el('input', { id: 'cmp-gap', type: 'number', step: 'any', min: '0', style: 'width:8em' });
  const gapUnit = el('span');
  let gapEdited = false;
  gap.addEventListener('input', () => { gapEdited = true; });
  const ignore = el('select', { id: 'cmp-ignore', multiple: true, size: 5, title: 'Layers of B left out of the compare (Ctrl+click to choose several), e.g. a revision table' });
  const bDefaults = () => {
    const d = sources[Number(selB.value)]?.doc;
    gapUnit.textContent = ' drawing units (1.5 m): changes closer than this form one group';
    if (!gapEdited) gap.value = String(+defaultClusterGap(d?.units).toPrecision(6));
    const keep = new Set([...ignore.selectedOptions].map((o) => o.value));
    ignore.replaceChildren(...[...(d?.layers?.keys() ?? [])].sort((p, q) => p.localeCompare(q)).map((n) => el('option', { value: n, text: n, selected: keep.has(n) })));
  };
  selB.addEventListener('change', bDefaults);
  bDefaults();
  const ok = await modal('Compare drawings', el('div', { class: 'cmp-pick' },
    el('label', {}, 'Original (A) — shown red where removed', el('div', {}, selA, browse(selA))),
    el('label', {}, 'Revised (B) — shown green where added', el('div', {}, selB, browse(selB))),
    el('label', {}, 'Align A to B', el('div', {}, align)),
    el('label', {}, 'Tolerance', el('div', {}, tol, tolUnit)),
    el('label', {}, 'Group distance', el('div', {}, gap, gapUnit)),
    el('label', {}, 'Ignore layers…', el('div', {}, ignore)),
    el('p', { text: 'Changed objects are amber, unchanged grey; each group of changes is framed by a dotted rectangle.' })),
  [{ label: 'Compare', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return null;
  const A = sources[Number(selA.value)], B = sources[Number(selB.value)];
  if (!A || !B) return null;
  if (A === B) { toast('Choose two different drawings.'); return null; }
  const t = Number(tol.value), g = Number(gap.value);
  return { A, B, align: align.value, tol: t > 0 ? t : defaultTolerance(B.doc.units), clusterGap: g > 0 ? g : defaultClusterGap(B.doc.units),
    ignoreLayers: [...ignore.selectedOptions].map((o) => o.value) };
}

// ---- Pick points: a temporary tool asks for a base point (and an optional second point) in A's tab, then in B's ----
const PROMPTS = ['Compare: pick a base point in A', 'Compare: pick a second point in A (Enter for none)',
  'Compare: pick a base point in B', 'Compare: pick a second point in B (Enter for none)'];
class ComparePickTool extends Tool {
  constructor(h) { super(h); this.job = null; this.name = 'COMPARE'; }
  get prompt() { return this.job ? PROMPTS[this.job.step] : ''; }
  click(p) {
    const j = this.job; if (!j) return;
    j.pts[j.step] = { x: p.x, y: p.y };
    this.next();
  }
  next() {
    const j = this.job;
    j.step++;
    if (j.step === 3 && !j.pts[1]) j.step++; // no second point in A: none in B either
    if (j.step === 2) { this.h.switchTo(j.tabB); this.vp.lastPoint = null; }
    if (j.step >= 4) { this.end(j.pts); return; }
    this.h.refreshPrompt();
  }
  key(e) {
    if (e.key === 'Escape') { this.end(null); return true; }
    if (e.key === 'Enter') { if (this.job && (this.job.step === 1 || this.job.step === 3)) this.next(); return true; }
    return false;
  }
  end(pts) {
    const j = this.job; this.job = null;
    if (this.h.toolId === 'comparepick') this.h.setTool('select');
    j?.resolve(pts);
  }
  deactivate() {
    super.deactivate();
    // a tab switch re-activates this tool; another command (or closing a tab) ends the picking
    queueMicrotask(() => { if (this.job && this.h.toolId !== 'comparepick') this.end(null); });
  }
}

/** ask for the alignment points; null = cancelled. Drawings opened from a file are shown in a tab first. */
function pickPoints(app, A, B) {
  const tabOf = (s) => {
    if (s.tab && app.tabs.includes(s.tab)) return s.tab;
    app.installDoc(s.doc, s.file ?? { path: null, name: s.label, format: 'dxf' });
    return (s.tab = app.active);
  };
  const tabA = tabOf(A), tabB = tabOf(B);
  app.tools.comparepick ??= new ComparePickTool(app);
  return new Promise((resolve) => {
    if (app.active !== tabA) app.switchTo(tabA);
    app.tools.comparepick.job = { step: 0, pts: [null, null, null, null], tabB, resolve };
    app.setTool('comparepick');
  });
}

/** compareDocs options for the chosen alignment; pts = [a1, a2, b1, b2] picked points (a2/b2 may be null) */
export function compareOptions(align, tol, pts, extra = {}) {
  const o = (x) => ({ ...x, ...extra });
  if (align === 'auto') return o({ tol, align: 'auto' });
  if (align !== 'pick') return o({ tol });
  const [a1, a2, b1, b2] = pts;
  if (typeof core.transformFromPoints === 'function') return o({ tol, transform: core.transformFromPoints(a1, a2 && b2 ? a2 : null, b1, a2 && b2 ? b2 : null) });
  return o({ tol, dx: b1.x - a1.x, dy: b1.y - a1.y }); // translation only (core without transformFromPoints)
}

/** COMPARE: choose the drawings, compare, and show the result in a new tab */
export async function runCompare(app) {
  if (running) { toast('A compare is already running.'); return; }
  const pick = await chooseDrawings(app);
  if (!pick) return;
  let pts = null;
  if (pick.align === 'pick') {
    pts = await pickPoints(app, pick.A, pick.B);
    if (!pts) { toast('Compare cancelled.', 2000); return; }
  }
  await showComparison(app, pick.A.doc, pick.B.doc, pick.A.label, pick.B.label, { align: pick.align, opts: compareOptions(pick.align, pick.tol, pts, { clusterGap: pick.clusterGap, ...(pick.ignoreLayers.length ? { ignoreLayers: pick.ignoreLayers } : {}) }) });
}

/** the two drawings of the compare that is running (null = none): their tabs cannot be closed meanwhile */
let running = null;
export const compareUses = (doc) => !!running && (running.a === doc || running.b === doc);

/** compare and show the result in a new tab. The work is time-sliced (progress toast with Cancel); while it runs no
 *  second compare starts and the tabs of A and B cannot be closed. */
export async function showComparison(app, a, b, nameA, nameB, { align = 'auto', opts = { align: 'auto', tol: defaultTolerance(b.units) } } = {}) {
  if (running) { toast('A compare is already running.'); return; }
  running = { a, b };
  const ac = new AbortController();
  const pt = progressToast('Comparing…', () => ac.abort());
  try {
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0))); // let the toast paint
    const cancelMessage = 'Compare was cancelled.';
    const r = await runSliced(core.compareSteps(a, b, opts), { signal: ac.signal, onProgress: (f) => pt.set(0.8 * f), cancelMessage });
    const doc = await runSliced(core.buildCompareSteps(a, b, r), { signal: ac.signal, onProgress: (f) => pt.set(0.8 + 0.1 * f), cancelMessage });
    const prepared = await prepareView(doc, { signal: ac.signal, onProgress: (f) => pt.set(0.9 + 0.1 * f) });
    app.installDoc(doc, { path: null, name: `Compare ${nameA} vs ${nameB}`, format: 'dxf' }, { prepared });
    app.active.compare = { r, a, b, nameA, nameB, align, view: 'differences', showProps: true, clusterProps: !!opts.clusterProps };
    app.comparePanel.sync();
    toast(`${r.added.length} added, ${r.removed.length} removed, ${r.changedGeometry.length} changed, ${r.changedProps.length} property-only (pieces)`, 3000);
  } catch (err) {
    if (err.code === 'CANCELLED') toast('Compare cancelled.', 2500);
    else toast(`Compare failed: ${err?.message || err}`, 8000); // replaces the progress toast (and its dead Cancel button)
  } finally { running = null; }
}
