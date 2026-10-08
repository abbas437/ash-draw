// ASH Draw Studio - File > Compare… (command COMPARE). Compares two drawings (open tabs or a file) and shows the
// result in a new tab: unchanged grey, added (B only) green, removed (A only) red, changed amber, a dotted rectangle
// around each change cluster (no revision clouds), and a side panel to step through the clusters.
import { compareDocs, buildCompareDoc } from '../src/core/compare.js';
import { OPEN_FILTERS, loadDrawing } from './files.js';
import { el, modal, message, toast } from './ui.js';

export class ComparePanel {
  constructor(app) {
    this.app = app;
    this.cur = -1;
    this.counts = el('div', { class: 'cmp-counts', role: 'status' });
    this.pos = el('span', { class: 'cmp-pos' });
    this.list = el('div', { class: 'cmp-list', role: 'listbox', 'aria-label': 'Change clusters' });
    const btn = (label, title, fn, id) => el('button', { id, title, onclick: fn }, label);
    this.box = el('div', { id: 'compare-panel', hidden: true, role: 'region', 'aria-label': 'Compare' },
      el('div', { class: 'phead' }, 'Compare', el('span', { class: 'spacer' }), btn('×', 'Hide panel', () => { this.box.hidden = true; }, 'cmp-close')),
      this.counts,
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
    this.counts.replaceChildren(el('div', { class: 'cmp-files', text: `A: ${c.nameA}  →  B: ${c.nameB}` }),
      sw('added', 'Added', c.r.added.length), sw('removed', 'Removed', c.r.removed.length), sw('changed', 'Changed', c.r.changed.length), sw('same', 'Unchanged', c.r.same.length));
    this.list.replaceChildren(...c.r.clusters.map((k, i) => el('div', { class: 'cmp-row', role: 'option', onclick: () => this.go(i) },
      `${i + 1}.`, el('span', { text: [k.added && `+${k.added} added`, k.removed && `−${k.removed} removed`, k.changed && `~${k.changed} changed`].filter(Boolean).join(', ') }))));
    this.mark();
  }
  mark() {
    const c = this.app.active?.compare, n = c?.r.clusters.length ?? 0;
    this.pos.textContent = n ? `${this.cur < 0 ? '–' : this.cur + 1} of ${n}` : 'No differences';
    [...this.list.children].forEach((r, i) => { r.classList.toggle('cur', i === this.cur); r.setAttribute('aria-selected', String(i === this.cur)); });
  }
  go(i) {
    const c = this.app.active?.compare; if (!c?.r.clusters[i]) return;
    this.cur = i;
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
  const sources = app.tabs.filter((t) => !t.compare).map((t) => ({ label: t.file.name, doc: t.doc }));
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
      sources.push({ label: f.name, doc }); fill(); sel.value = String(sources.length - 1);
    } catch (err) { await message('Cannot open this file', err.message || String(err)); }
  } }, 'File…');
  const ok = await modal('Compare drawings', el('div', { class: 'cmp-pick' },
    el('label', {}, 'Original (A) — shown red where removed', el('div', {}, selA, browse(selA))),
    el('label', {}, 'Revised (B) — shown green where added', el('div', {}, selB, browse(selB))),
    el('p', { text: 'Changed objects are amber, unchanged grey; each group of changes is framed by a dotted rectangle.' })),
  [{ label: 'Compare', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return null;
  const A = sources[Number(selA.value)], B = sources[Number(selB.value)];
  if (!A || !B) return null;
  if (A === B) { toast('Choose two different drawings.'); return null; }
  return { A, B };
}

/** COMPARE: choose the drawings, compare, and show the result in a new tab */
export async function runCompare(app) {
  const pick = await chooseDrawings(app);
  if (!pick) return;
  showComparison(app, pick.A.doc, pick.B.doc, pick.A.label, pick.B.label);
}

export function showComparison(app, a, b, nameA, nameB) {
  const r = compareDocs(a, b);
  const doc = buildCompareDoc(a, b, r);
  app.installDoc(doc, { path: null, name: `Compare ${nameA} vs ${nameB}`, format: 'dxf' });
  app.active.compare = { r, nameA, nameB };
  app.comparePanel.sync();
  toast(`${r.added.length} added, ${r.removed.length} removed, ${r.changed.length} changed`, 3000);
}
