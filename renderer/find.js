// ASH Draw Studio - Find and Replace panel (Ctrl+F, command FIND). Searches the drawing shown in the
// current tab: TEXT (attributes are read as TEXT), MTEXT and dimension text overrides (find only).
// Matching and replacing live in src/core/find.js; Replace / Replace all are one undo step each.
import { getEntity } from '../src/core/model.js';
import { findInDocument, replaceInDocument } from '../src/core/find.js';
import { el, toast } from './ui.js';

const MAX_ROWS = 500;

export class FindPanel {
  constructor(app) {
    this.app = app;
    this.results = [];
    this.cur = -1;
    this.q = el('input', { type: 'text', id: 'find-q', 'aria-label': 'Find what', spellcheck: 'false', autocomplete: 'off' });
    this.r = el('input', { type: 'text', id: 'find-r', 'aria-label': 'Replace with', spellcheck: 'false', autocomplete: 'off' });
    this.mc = el('input', { type: 'checkbox', id: 'find-case' });
    this.ww = el('input', { type: 'checkbox', id: 'find-word' });
    this.count = el('span', { class: 'find-count', role: 'status' });
    this.list = el('div', { class: 'find-list', role: 'listbox', 'aria-label': 'Results' });
    const btn = (label, title, fn, id) => el('button', { id, title, onclick: fn }, label);
    this.box = el('div', { id: 'find-panel', class: 'find-panel', hidden: true, role: 'dialog', 'aria-label': 'Find and replace' },
      el('div', { class: 'phead' }, 'Find and replace', el('span', { class: 'spacer' }), btn('×', 'Close (Esc)', () => this.close(), 'find-close')),
      el('label', {}, 'Find what', this.q), el('label', {}, 'Replace with', this.r),
      el('div', { class: 'find-opts' }, el('label', {}, this.mc, ' Match case'), el('label', {}, this.ww, ' Whole words')),
      el('div', { class: 'find-btns' },
        btn('▲', 'Find previous (Shift+Enter)', () => this.step(-1), 'find-prev'), btn('▼', 'Find next (Enter)', () => this.step(1), 'find-next'),
        btn('Replace', 'Replace the selected match', () => this.replaceOne(), 'find-replace'), btn('Replace all', 'Replace every match in this drawing', () => this.replaceAll(), 'find-all')),
      this.count, this.list);
    document.getElementById('stage').append(this.box);
    const rerun = () => this.search();
    this.q.addEventListener('input', rerun);
    this.mc.addEventListener('change', rerun);
    this.ww.addEventListener('change', rerun);
    this.box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if (e.key === 'Enter' && (e.target === this.q || e.target === this.r)) { e.preventDefault(); e.stopPropagation(); this.step(e.shiftKey ? -1 : 1); }
    });
    // the drawing changed (edit, undo, another tab): refresh the results, keeping the position
    app.vp.on('change', () => { if (this.isOpen && !this.busy) this.search(true); });
  }

  get isOpen() { return !this.box.hidden; }
  get opts() { return { matchCase: this.mc.checked, wholeWord: this.ww.checked }; }

  open() {
    this.box.hidden = false;
    this.search();
    this.q.focus(); this.q.select();
  }
  close() { this.box.hidden = true; this.app.vp.canvas.focus(); }

  search(keep = false) {
    const prev = this.cur;
    this.results = findInDocument(this.app.doc, this.q.value, this.opts);
    this.cur = keep && this.results.length ? Math.min(Math.max(prev, 0), this.results.length - 1) : -1;
    this.renderList();
  }

  renderList() {
    const n = this.results.length;
    this.count.textContent = !this.q.value ? '' : n ? `${n} match${n === 1 ? '' : 'es'}` : 'No matches';
    this.list.replaceChildren(...this.results.slice(0, MAX_ROWS).map((r, i) => el('div', {
      class: `find-row${i === this.cur ? ' cur' : ''}`, role: 'option', 'aria-selected': i === this.cur ? 'true' : 'false',
      title: r.editable ? '' : 'Dimension text: find only', onclick: () => this.goTo(i),
    }, el('span', { class: 'find-text' }, r.text.slice(Math.max(0, r.start - 20), r.start).replace(/\n/g, ' '),
      el('mark', { text: r.text.slice(r.start, r.end) }), r.text.slice(r.end, r.end + 30).replace(/\n/g, ' ')),
    el('span', { class: 'find-layer', text: r.editable ? r.layer : `${r.layer} (dim)` }))));
    if (n > MAX_ROWS) this.list.append(el('div', { class: 'find-row', text: `… ${n - MAX_ROWS} more` }));
  }

  /** zoom to result i and select its object */
  goTo(i) {
    const r = this.results[i];
    if (!r) return;
    this.cur = i;
    const { vp } = this.app;
    const e = getEntity(this.app.doc, r.id);
    const b = e && vp.index.bboxOf(e);
    if (b) {
      const pad = Math.max(b.maxx - b.minx, b.maxy - b.miny, 1e-6) * 1.5;
      vp.zoomBox({ minx: b.minx - pad, miny: b.miny - pad, maxx: b.maxx + pad, maxy: b.maxy + pad });
    }
    vp.setSelection([r.id]);
    this.renderList();
    this.list.children[i]?.scrollIntoView?.({ block: 'nearest' });
  }

  step(dir) {
    if (!this.results.length) { if (this.q.value) toast('No matches.', 1500); return; }
    const n = this.results.length;
    this.goTo(this.cur < 0 ? (dir > 0 ? 0 : n - 1) : (this.cur + dir + n) % n);
  }

  run(fn) { this.busy = true; try { return fn(); } finally { this.busy = false; } }

  replaceOne() {
    const r = this.results[this.cur];
    if (!r) { this.step(1); return; }
    if (!r.editable) { toast('Dimension text can be found but not replaced.', 2500); return; }
    const at = this.cur;
    this.run(() => replaceInDocument(this.app.session, this.q.value, this.r.value, this.opts, [{ id: r.id, index: r.index }]));
    this.search();
    if (this.results.length) this.goTo(Math.min(at, this.results.length - 1));
  }

  replaceAll() {
    if (!this.q.value) return;
    const n = this.run(() => replaceInDocument(this.app.session, this.q.value, this.r.value, this.opts));
    const left = this.results.filter((x) => !x.editable).length;
    toast(`${n} replaced${left ? ` (${left} in dimension text not changed)` : ''}`, 2500);
    this.search();
  }
}
