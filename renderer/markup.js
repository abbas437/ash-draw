// ASH Draw Studio - review markups UI: the Markup circle / rectangle / note tools (MKC, MKR, MKT) and the Markups panel.
// A markup is a dashed red circle or rectangle (or a note alone) plus a short comment on the sheet - never a revision
// cloud and never a bare reference number, so the tools insist on a comment. The data model lives in src/core/markup.js.
// tools.js owns the Tool base class and passes it to createMarkupTools (a factory, so this module does not import tools.js).
import {
  addMarkup, listMarkups, setMarkupStatus, setMarkupCode, deleteMarkup, setMarkupsVisible, renumberMarkups, markupsCsv, markupsCrsSheet,
  addFollowUp, editFollowUp, removeFollowUp, latestRevLabel, MARKUP_LAYER, MARKUP_CODES, MARKUP_STATUSES,
} from '../src/core/markup.js';
import { ROUND_KEY, defaultRound, cleanRounds, recallRound, rememberRound } from './markup-round.js';
import { unitKey } from './unit-memory.js';
import { xlsxBytes } from '../src/core/xlsx.js';
import { dist } from '../src/core/geom.js';
import { el, toast, promptDialog, modal } from './ui.js';
import { savePathIn } from './files.js';

export const DEFAULT_AUTHOR = 'ASH user';
const PREVIEW = '#e02020';
const authorOf = (h) => h.markupAuthor || DEFAULT_AUTHOR;

/** set the reviewer name / initials put on new markups, remembered as setting 'markup.author' */
async function setMarkupAuthor(app, a) {
  app.markupAuthor = a;
  await window.api.settingsSet?.('markup.author', a)?.catch?.(() => {});
  app.markupPanel?.render();
}

/** on the first markup while the reviewer is still the default: ask once for the name or initials (Cancel keeps the default) */
async function ensureReviewer(h) {
  if ((h.markupAuthor && h.markupAuthor !== DEFAULT_AUTHOR) || h.markupAuthorAsked) return;
  h.markupAuthorAsked = true;
  const a = (await promptDialog('Reviewer name or initials (shown on every markup)', ''))?.trim();
  if (a) await setMarkupAuthor(h, a);
}

/** a whole number from a prompt answer, or null */
const wholeNo = (v) => { const n = Number(String(v ?? '').trim()); return String(v ?? '').trim() && Number.isInteger(n) && n >= 0 ? n : null; };

export function createMarkupTools(h, { Tool }) {
  /** shared: ask for the comment, then add the markup (one undo step); an empty comment adds nothing */
  class MarkupTool extends Tool {
    activate() { super.activate(); this.a = null; this.busy = false; }
    autoHeight() { const v = this.vp.view; return this.h.defaults.textHeight ?? +(v.height / v.zoom / 50).toPrecision(2); }
    async finish(kind, geo, height) {
      this.busy = true; this.vp.lastPoint = null;
      try {
        await ensureReviewer(this.h);
        const r = await this.h.askText({ title: 'Markup comment', value: '', height });
        const comment = r?.text.replace(/\r/g, '').trim();
        if (!comment) { if (r) this.h.toast('A markup needs a short comment; nothing was added.'); return; }
        addMarkup(this.h.session, kind, geo, { comment: comment.split('\n').join(' '), author: authorOf(this.h), rev: this.h.markupPanel?.round() || undefined, height: r.height, no: this.h.markupStartNo ?? undefined });
        if (this.h.markupStartNo != null) { this.h.markupStartNo = null; this.h.markupPanel?.render(); } // a start number applies to one markup
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

/** the Markups panel in #side: list, status toggle, review code, delete, filter, reviewer name, start number, renumber, CSV and CRS (xlsx) export */
export class MarkupPanel {
  constructor(app) {
    this.app = app;
    this.list = document.getElementById('markups');
    this.filter = document.getElementById('mk-filter');
    this.filter.addEventListener('change', () => this.render());
    document.getElementById('mk-author').onclick = () => this.editAuthor();
    document.getElementById('mk-csv').onclick = () => this.exportCsv();
    document.getElementById('mk-start').onclick = () => this.startNumber();
    document.getElementById('mk-renum').onclick = () => this.renumber();
    document.getElementById('mk-crs').onclick = () => this.exportCrs();
    this.roundIn = document.getElementById('mk-round');
    this.roundIn.addEventListener('change', () => this.setRound(this.roundIn.value));
    this.rounds = []; this.tabRounds = new WeakMap(); this.tabDefaults = new WeakMap();
    window.api.settingsGet?.(ROUND_KEY).then((v) => { this.rounds = cleanRounds(v); this.render(); }).catch(() => {});
    app.markupAuthor = DEFAULT_AUTHOR;
    app.markupStartNo = null;
    window.api.settingsGet?.('markup.author').then((a) => { if (typeof a === 'string' && a.trim()) app.markupAuthor = a.trim(); this.render(); }).catch(() => {});
    app.vp.on('change', () => this.render());
    this.render();
  }
  /** the current review round: the one set for this drawing, else defaultRound of the markups it had when first shown
   *  (Rev.00 with none; pinned per tab, so adding markups does not move it) */
  round() {
    const set = this.setRoundOf();
    if (set) return set;
    const tab = this.app.active;
    if (!tab) return 'Rev.00';
    if (!this.tabDefaults.has(tab)) this.tabDefaults.set(tab, defaultRound(this.app.doc ? listMarkups(this.app.doc) : []));
    return this.tabDefaults.get(tab);
  }
  /** set the round of this drawing (an empty one goes back to the default), remembered as setting 'markup.round' */
  async setRound(label) {
    const key = this.fileKey(), l = String(label ?? '').trim();
    this.rounds = rememberRound(this.rounds, key, l);
    if (l) this.tabRounds.set(this.app.active, l); else this.tabRounds.delete(this.app.active); // also for a drawing with no key (this session)
    await window.api.settingsSet?.(ROUND_KEY, this.rounds)?.catch?.(() => {});
    this.render();
  }
  /** the settings key of the drawing shown (unit-memory.js unitKey; null before a drawing is shown) */
  fileKey() { return this.app.active ? unitKey(this.app.file) : null; }
  /** the round the reviewer set for this drawing ('' = none) */
  setRoundOf() { return recallRound(this.rounds, this.fileKey()) || (this.app.active && this.tabRounds.get(this.app.active)) || ''; }
  /** Follow-up…: the original comment, its follow-ups (edit / remove), and a form for this round's follow-up (edited when it exists) */
  async followUp(uid) {
    const s = this.app.session, round = this.round();
    const find = () => listMarkups(this.app.doc).find((k) => k.uid === uid);
    let m = find();
    if (!m) return;
    const text = el('textarea', { id: 'mk-fu-text', rows: 4, style: 'width:100%' });
    const code = el('select', { id: 'mk-fu-code' }, ['', ...MARKUP_CODES].map((c) => el('option', { value: c, text: c || '–' })));
    const status = el('select', { id: 'mk-fu-status' }, MARKUP_STATUSES.map((v) => el('option', { value: v, text: v })));
    code.addEventListener('change', () => { if (code.value === 'A') status.value = 'Closed'; });
    const formHead = el('div', { class: 'mk-fu-head' });
    let index = -1; // the follow-up the form edits (-1 = a new one)
    const load = (i) => {
      index = i;
      const f = m.followUps[i];
      text.value = f?.text ?? ''; code.value = f?.code ?? ''; status.value = f?.status ?? 'Open';
      formHead.textContent = f ? `Edit follow-up ${f.rev || `#${i + 1}`}` : `New follow-up (${round})`;
    };
    const list = el('div', { class: 'mk-fu-list' });
    const fill = () => {
      list.replaceChildren(...(m.followUps.length ? m.followUps.map((f, i) => el('div', { class: 'mk-fu-item' },
        el('span', { class: 'mk-fu-line', text: `${f.rev ? `${f.rev}: ` : ''}${f.text}` }),
        el('span', { class: 'mk-meta', text: ` ${f.code || '–'} · ${f.status} · ${f.author} · ${f.date}` }),
        el('button', { type: 'button', class: 'mk-fu-edit', onclick: () => load(i) }, 'Edit'),
        el('button', { type: 'button', class: 'mk-fu-del', onclick: () => { removeFollowUp(s, uid, i); m = find() ?? m; fill(); load(m.followUps.findIndex((g) => g.rev === round)); } }, 'Remove')))
        : [el('p', { class: 'mk-meta', text: 'No follow-ups yet.' })]));
    };
    fill();
    load(m.followUps.findIndex((f) => f.rev === round));
    const r = await modal(`Follow-up on markup ${m.no}`, el('div', { class: 'mk-fu' },
      el('p', { class: 'mk-fu-orig' }, el('b', { text: `${m.no}${m.rev ? ` (${m.rev})` : ''}: ` }), m.comment),
      list, formHead, text,
      el('label', {}, 'Code ', code, ' Status ', status),
      el('p', { class: 'mk-meta', text: 'Code A closes the item; for leftover minor points add a new markup.' })),
    [{ label: 'Save', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
    if (r !== 'ok') return;
    const t = text.value.replace(/\r/g, '').trim();
    if (!t) { toast('A follow-up needs a short text; nothing was saved.'); return; }
    const fu = { text: t, code: code.value, status: status.value, author: authorOf(this.app), date: new Date().toISOString().slice(0, 10) };
    try {
      if (index >= 0) editFollowUp(s, uid, index, fu); else addFollowUp(s, uid, { ...fu, rev: round });
    } catch (err) { if (err instanceof RangeError) toast(err.message); else throw err; }
  }
  async editAuthor() {
    const a = (await promptDialog('Reviewer name or initials (shown on every markup)', this.app.markupAuthor))?.trim();
    if (a) await setMarkupAuthor(this.app, a);
  }
  /** Start no.: the number of the next new markup (once); later markups continue from the highest number */
  async startNumber() {
    const next = listMarkups(this.app.doc ?? { entities: [] }).reduce((m, k) => Math.max(m, k.no || 0), 0) + 1;
    const v = await promptDialog('Number of the next markup', String(this.app.markupStartNo ?? next));
    if (v == null) return;
    const n = wholeNo(v);
    if (n == null) { toast('Type a whole number, e.g. 1.'); return; }
    this.app.markupStartNo = n;
    this.render();
  }
  /** Renumber: every markup of the drawing in its present order, from a start number (one undo step) */
  async renumber() {
    if (!this.app.doc || !listMarkups(this.app.doc).length) { toast('This drawing has no markups.'); return; }
    const v = await promptDialog('Renumber all markups in order, starting at', String(this.app.markupStartNo ?? 1));
    if (v == null) return;
    const n = wholeNo(v);
    if (n == null) { toast('Type a whole number, e.g. 1.'); return; }
    renumberMarkups(this.app.session, n);
    this.app.markupStartNo = null;
    this.render();
  }
  /** Export to CRS (xlsx): one row per markup of model space and every layout, saved as <drawing>-CRS.xlsx beside the drawing */
  async exportCrs() {
    const doc = this.app.fileDoc ?? this.app.doc;
    const spaces = [{ name: 'Model', markups: listMarkups(doc) }, ...(doc.layouts ?? []).map((l) => ({ name: l.name, markups: listMarkups({ ...doc, entities: l.entities ?? [] }) }))]
      .filter((sp) => sp.markups.length);
    if (!spaces.length) { toast('This drawing has no markups.'); return; }
    const file = String(this.app.file?.name ?? 'drawing'), name = file.replace(/\.[^.]*$/, '');
    const bytes = xlsxBytes([markupsCrsSheet(spaces, { drawing: file, date: new Date().toISOString().slice(0, 10) })]);
    await window.api.saveFile({ defaultPath: savePathIn(this.app.file?.path, `${name}-CRS.xlsx`), filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }], bytes });
  }
  async exportCsv() {
    const all = listMarkups(this.app.doc);
    if (!all.length) { toast('This drawing has no markups.'); return; }
    const name = String(this.app.file?.name ?? 'drawing').replace(/\.[^.]*$/, '');
    await window.api.saveFile({ defaultPath: savePathIn(this.app.file?.path, `${name}-markups.csv`), filters: [{ name: 'CSV', extensions: ['csv'] }], bytes: new TextEncoder().encode(markupsCsv(all)) });
  }
  render() {
    const doc = this.app.doc;
    document.getElementById('mk-author').title = `Reviewer: ${this.app.markupAuthor} (click to change)`;
    const start = this.app.markupStartNo;
    document.getElementById('mk-start').textContent = start != null ? `Start no. ${start}…` : 'Start no.…';
    if (document.activeElement !== this.roundIn) this.roundIn.value = this.round();
    if (!doc) { this.list.replaceChildren(); return; }
    const f = this.filter.value, s = this.app.session;
    const rows = listMarkups(doc).filter((m) => f === 'all' || (m.status ?? 'Open') === f);
    this.list.replaceChildren(...rows.map((m) => {
      const status = m.status ?? 'Open';
      const rev = latestRevLabel([m.rev, ...(m.followUps ?? []).map((f) => f.rev)]);
      const row = el('div', { class: `mk-row${status === 'Closed' ? ' closed' : ''}`, title: 'Click to zoom to this markup; double-click for a follow-up', onclick: () => this.show(m), ondblclick: () => this.followUp(m.uid) },
        el('span', { class: 'mk-no', text: String(m.no) }),
        el('span', { class: 'mk-text' }, el('span', { class: 'mk-comment', text: m.comment }), el('span', { class: 'mk-meta', text: `${m.author ?? ''} · ${m.date ?? ''}` }), rev ? el('span', { class: 'mk-rev', text: rev }) : null),
        el('select', { class: 'mk-status', title: 'Status (closing a markup without a code sets code A)', onclick: (e) => e.stopPropagation(), onchange: (e) => setMarkupStatus(s, m.uid, e.target.value) },
          MARKUP_STATUSES.map((v) => el('option', { value: v, text: v, selected: status === v }))),
        el('select', { class: 'mk-code', title: 'Review code (A / B / C)', onclick: (e) => e.stopPropagation(), onchange: (e) => setMarkupCode(s, m.uid, e.target.value) },
          ['', ...MARKUP_CODES].map((c) => el('option', { value: c, text: c || '–', selected: (m.code ?? '') === c }))),
        el('button', { class: 'mk-fu-btn', title: 'Add or edit the follow-up of this review round', onclick: (e) => { e.stopPropagation(); this.followUp(m.uid); } }, 'Follow-up…'),
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
