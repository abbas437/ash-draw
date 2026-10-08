// ASH Draw Studio - review markups UI: the Markup circle / rectangle / note tools (MKC, MKR, MKT) and the Markups panel.
// A markup is a dashed red circle or rectangle (or a note alone) plus a short comment on the sheet - never a revision
// cloud and never a bare reference number, so the tools insist on a comment. The data model lives in src/core/markup.js.
// tools.js owns the Tool base class and passes it to createMarkupTools (a factory, so this module does not import tools.js).
import { addMarkup, listMarkups, setMarkupStatus, deleteMarkup, setMarkupsVisible, markupsCsv, MARKUP_LAYER } from '../src/core/markup.js';
import { dist } from '../src/core/geom.js';
import { el, toast, promptDialog } from './ui.js';

export const DEFAULT_AUTHOR = 'ASH user';
const PREVIEW = '#e02020';
const authorOf = (h) => h.markupAuthor || DEFAULT_AUTHOR;

export function createMarkupTools(h, { Tool }) {
  /** shared: ask for the comment, then add the markup (one undo step); an empty comment adds nothing */
  class MarkupTool extends Tool {
    activate() { super.activate(); this.a = null; this.busy = false; }
    autoHeight() { const v = this.vp.view; return this.h.defaults.textHeight ?? +(v.height / v.zoom / 50).toPrecision(2); }
    async finish(kind, geo, height) {
      this.busy = true; this.vp.lastPoint = null;
      try {
        const r = await this.h.askText({ title: 'Markup comment', value: '', height });
        const comment = r?.text.replace(/\r/g, '').trim();
        if (!comment) { if (r) this.h.toast('A markup needs a short comment; nothing was added.'); return; }
        addMarkup(this.h.session, kind, geo, { comment: comment.split('\n').join(' '), author: authorOf(this.h), height: r.height });
      } finally { this.a = null; this.busy = false; this.h.refreshPrompt(); this.vp.requestRender(); }
    }
    key(e) { if (e.key === 'Escape') { if (this.a) { this.a = null; this.vp.lastPoint = null; } else this.cancel(); return true; } return e.key === 'Enter'; }
    pen(c) { c.strokeStyle = PREVIEW; c.setLineDash([6, 4]); c.lineWidth = 1.5; }
  }

  class MarkupCircleTool extends MarkupTool {
    get prompt() { return this.a ? 'MARKUP CIRCLE  radius (click or type)' : 'MARKUP CIRCLE  center point'; }
    click(p) {
      if (this.busy) return;
      if (!this.a) { this.a = p; this.vp.lastPoint = p; return; }
      const r = dist(this.a, p);
      if (r > 1e-12) return this.finish('circle', { c: this.a, r }, +(r / 4).toPrecision(2));
    }
    text(s) {
      const v = Number(s);
      if (this.a && !this.busy && v > 0) { this.finish('circle', { c: this.a, r: v }, +(v / 4).toPrecision(2)); return true; }
      return false;
    }
    draw(c) {
      if (!this.a || this.busy) return;
      const r = dist(this.a, this.vp.cursor), s = this.vp.toScreen(this.a);
      this.pen(c); c.beginPath(); c.arc(s.x, s.y, r * this.vp.view.zoom, 0, Math.PI * 2); c.stroke();
    }
  }

  class MarkupRectTool extends MarkupTool {
    get prompt() { return this.a ? 'MARKUP RECTANGLE  opposite corner' : 'MARKUP RECTANGLE  first corner'; }
    click(p) {
      if (this.busy) return;
      if (!this.a) { this.a = p; this.vp.lastPoint = p; return; }
      const w = Math.abs(p.x - this.a.x), ht = Math.abs(p.y - this.a.y);
      if (w > 1e-12 && ht > 1e-12) return this.finish('rect', { p1: this.a, p2: p }, +(Math.max(w, ht) / 8).toPrecision(2));
    }
    draw(c) {
      if (!this.a || this.busy) return;
      const q = this.vp.cursor;
      this.pen(c); this.poly(c, [this.a, { x: q.x, y: this.a.y }, q, { x: this.a.x, y: q.y }], true);
    }
  }

  class MarkupNoteTool extends MarkupTool {
    get prompt() { return 'MARKUP NOTE  location of the comment'; }
    click(p) { if (!this.busy) return this.finish('text', { p }, this.autoHeight()); }
  }

  return { mkc: new MarkupCircleTool(h), mkr: new MarkupRectTool(h), mkt: new MarkupNoteTool(h) };
}

/** true when the drawing shows its markups (no ASH-MARKUP layer yet counts as shown) */
export function markupsShown(doc) { return doc?.layers.get(MARKUP_LAYER)?.visible !== false; }

/** View > Show markups */
export function toggleMarkups(app) {
  if (!setMarkupsVisible(app.session, !markupsShown(app.doc))) app.toast('This drawing has no markups.');
}

/** the Markups panel in #side: list, status toggle, delete, filter, CSV export and the author name */
export class MarkupPanel {
  constructor(app) {
    this.app = app;
    this.list = document.getElementById('markups');
    this.filter = document.getElementById('mk-filter');
    this.filter.addEventListener('change', () => this.render());
    document.getElementById('mk-author').onclick = () => this.editAuthor();
    document.getElementById('mk-csv').onclick = () => this.exportCsv();
    app.markupAuthor = DEFAULT_AUTHOR;
    window.api.settingsGet?.('markup.author').then((a) => { if (typeof a === 'string' && a.trim()) app.markupAuthor = a.trim(); this.render(); }).catch(() => {});
    app.vp.on('change', () => this.render());
    this.render();
  }
  async editAuthor() {
    const a = (await promptDialog('Markup author', this.app.markupAuthor))?.trim();
    if (!a) return;
    this.app.markupAuthor = a;
    await window.api.settingsSet?.('markup.author', a)?.catch?.(() => {});
    this.render();
  }
  async exportCsv() {
    const all = listMarkups(this.app.doc);
    if (!all.length) { toast('This drawing has no markups.'); return; }
    const name = String(this.app.file?.name ?? 'drawing').replace(/\.[^.]*$/, '');
    await window.api.saveFile({ defaultPath: `${name}-markups.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }], bytes: new TextEncoder().encode(markupsCsv(all)) });
  }
  render() {
    const doc = this.app.doc;
    document.getElementById('mk-author').title = `Markup author: ${this.app.markupAuthor} (click to change)`;
    if (!doc) { this.list.replaceChildren(); return; }
    const f = this.filter.value, s = this.app.session;
    const rows = listMarkups(doc).filter((m) => f === 'all' || (m.status ?? 'Open') === f);
    this.list.replaceChildren(...rows.map((m) => {
      const status = m.status ?? 'Open';
      const row = el('div', { class: `mk-row${status === 'Closed' ? ' closed' : ''}`, title: 'Click to zoom to this markup', onclick: () => this.show(m) },
        el('span', { class: 'mk-no', text: String(m.no) }),
        el('span', { class: 'mk-text' }, el('span', { class: 'mk-comment', text: m.comment }), el('span', { class: 'mk-meta', text: `${m.author ?? ''} · ${m.date ?? ''}` })),
        el('button', { class: 'mk-status', title: 'Toggle Open / Closed', onclick: (e) => { e.stopPropagation(); setMarkupStatus(s, m.uid, status === 'Open' ? 'Closed' : 'Open'); } }, status),
        el('button', { class: 'mk-del', title: 'Delete this markup', onclick: (e) => { e.stopPropagation(); deleteMarkup(s, m.uid); } }, '×'));
      return row;
    }));
  }
  show(m) {
    const vp = this.app.vp, b = m.bbox;
    if (b) { const pad = Math.max(b.maxx - b.minx, b.maxy - b.miny) * 0.25 || 1; vp.zoomBox({ minx: b.minx - pad, miny: b.miny - pad, maxx: b.maxx + pad, maxy: b.maxy + pad }); }
    vp.setSelection(m.ids);
  }
}
