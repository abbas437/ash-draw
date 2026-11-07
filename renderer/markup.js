// ASH Draw Studio - review markups UI: the Markup circle / rectangle / note tools (MKC, MKR, MKT) and the Markups panel.
// A markup is a dashed red circle or rectangle (or a note alone) plus a short comment on the sheet - never a revision
// cloud and never a bare reference number, so the tools insist on a comment. The data model lives in src/core/markup.js.
// tools.js owns the Tool base class and passes it to createMarkupTools (a factory, so this module does not import tools.js).
import {
  addMarkup, listMarkups, setMarkupStatus, setMarkupCode, deleteMarkup, setMarkupsVisible, renumberMarkups, markupsCsv, markupsCrsSheet,
  saveFollowUps, statusForCode, codeForStatus, latestRevLabel, nextRevLabel, MARKUP_LAYER, MARKUP_CODES, MARKUP_STATUSES,
} from '../src/core/markup.js';
import { alignForImportSteps, importMarkups } from '../src/core/markupImport.js';
import { runSliced } from '../src/core/slice.js';
import { ROUND_KEY, defaultRound, cleanRounds, recallRound, rememberRound, roundOf, useRound, roundLabel } from './markup-round.js';
import { unitKey } from './unit-memory.js';
import { xlsxBytes } from '../src/core/xlsx.js';
import { dist } from '../src/core/geom.js';
import { el, toast, promptDialog, modal, message, progressToast } from './ui.js';
import { savePathIn, OPEN_FILTERS, loadPicked } from './files.js';

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
        const rev = this.h.markupPanel?.round() || undefined;
        addMarkup(this.h.session, kind, geo, { comment: comment.split('\n').join(' '), author: authorOf(this.h), rev, height: r.height, no: this.h.markupStartNo ?? undefined });
        if (rev) await this.h.markupPanel.useRound(this.h.active, rev); // the round is remembered for the drawing once used
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

/** the Markups panel in #side: list, status toggle, review code, delete, filter, reviewer name, start number, renumber, CSV and CRS (xlsx) export,
 *  import from the previous revision */
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
    document.getElementById('mk-import').onclick = () => this.importFromFile();
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
  /** the current review round (roundOf): the one stored for this drawing (typed, or first used: a markup placed, a follow-up
   *  saved, an import), else the one kept for this tab, else defaultRound of the markups it had when first shown (Rev.00
   *  with none; pinned per tab, so adding markups does not move it) */
  round() {
    const tab = this.app.active;
    if (!tab) return 'Rev.00';
    if (!this.tabDefaults.has(tab)) this.tabDefaults.set(tab, defaultRound(this.app.doc ? listMarkups(this.app.doc) : []));
    return roundOf(this.rounds, this.fileKey(), this.tabRounds.get(tab), this.tabDefaults.get(tab));
  }
  /** set the round of this drawing (an empty one goes back to the default), remembered as setting 'markup.round' */
  async setRound(label) {
    const key = this.fileKey(), l = roundLabel(label);
    this.rounds = rememberRound(this.rounds, key, l);
    if (l) this.tabRounds.set(this.app.active, l); else this.tabRounds.delete(this.app.active); // also for a drawing with no key (this session)
    await this.saveRounds();
  }
  async saveRounds() { await window.api.settingsSet?.(ROUND_KEY, this.rounds)?.catch?.(() => {}); this.render(); }
  /** round `label` was used in `tab`: kept for the tab and, the first time for its drawing, stored for its key (useRound) */
  async useRound(tab, label) {
    if (!tab || !roundLabel(label)) return;
    if (!this.tabRounds.has(tab)) this.tabRounds.set(tab, roundLabel(label));
    const next = useRound(this.rounds, unitKey(tab.file), label);
    if (next !== this.rounds) { this.rounds = next; await this.saveRounds(); }
  }
  /** the round stored or kept for `tab` ('' = none: the default applies) */
  tabRound(tab) { return tab ? recallRound(this.rounds, unitKey(tab.file)) || this.tabRounds.get(tab) || '' : ''; }
  /** app.afterSave: `tab` was saved under a new file; `label` (tabRound before the save) is stored for its new key */
  fileSaved(tab, label) { if (label) this.useRound(tab, label); }
  /** the settings key of the drawing shown (unit-memory.js unitKey; null before a drawing is shown) */
  fileKey() { return this.app.active ? unitKey(this.app.file) : null; }
  /** Follow-up…: the original comment, its follow-ups (edit / remove), and a form for this round's follow-up (edited when it
   *  exists). Remove is queued and Save applies it with the form as one undo step, so Cancel changes nothing. Editing keeps
   *  the follow-up's author; its date becomes today only when the text, code or status changes. */
  async followUp(uid) {
    const app = this.app, s = app.session, tab = app.active, round = this.round();
    const m = listMarkups(app.doc).find((k) => k.uid === uid);
    if (!m) return;
    const text = el('textarea', { id: 'mk-fu-text', rows: 4, style: 'width:100%', 'aria-labelledby': 'mk-fu-head' });
    const code = el('select', { id: 'mk-fu-code' }, ['', ...MARKUP_CODES].map((c) => el('option', { value: c, text: c || '–' })));
    const status = el('select', { id: 'mk-fu-status' }, MARKUP_STATUSES.map((v) => el('option', { value: v, text: v })));
    // the same rule as the panel's row selects (src/core/markup.js statusForCode / codeForStatus)
    code.addEventListener('change', () => { status.value = statusForCode(code.value, status.value); });
    status.addEventListener('change', () => { code.value = codeForStatus(status.value, code.value); });
    const formHead = el('div', { class: 'mk-fu-head', id: 'mk-fu-head' });
    const removed = new Set(); // follow-ups Remove marked (indices of m.followUps), applied on Save
    let index = -1; // the follow-up the form edits (-1 = a new one)
    const head = () => { const f = m.followUps[index]; formHead.textContent = f ? `Edit follow-up ${f.rev || `#${index + 1}`}` : `New follow-up (${round})`; };
    const load = (i) => {
      index = i;
      const f = m.followUps[i];
      text.value = f?.text ?? ''; code.value = f?.code ?? ''; status.value = f?.status ?? 'Open';
      head();
    };
    const list = el('div', { class: 'mk-fu-list' });
    const fill = () => {
      const shown = m.followUps.map((f, i) => [f, i]).filter(([, i]) => !removed.has(i));
      list.replaceChildren(...(shown.length ? shown.map(([f, i]) => el('div', { class: 'mk-fu-item' },
        el('span', { class: 'mk-fu-line', text: `${f.rev ? `${f.rev}: ` : ''}${f.text}` }),
        el('span', { class: 'mk-meta', text: ` ${f.code || '–'} · ${f.status} · ${f.author} · ${f.date}` }),
        el('button', { type: 'button', class: 'mk-fu-edit', onclick: () => load(i) }, 'Edit'),
        // the form keeps what was typed; removing the follow-up it edits makes it a new one
        el('button', { type: 'button', class: 'mk-fu-del', onclick: () => { removed.add(i); if (index === i) { index = -1; head(); } fill(); } }, 'Remove')))
        : [el('p', { class: 'mk-meta', text: 'No follow-ups yet.' })]));
    };
    fill();
    load(m.followUps.findIndex((f) => f.rev === round));
    const r = await modal(`Follow-up on markup ${m.no}`, el('div', { class: 'mk-fu' },
      el('p', { class: 'mk-fu-orig' }, el('b', { text: `${m.no}${m.rev ? ` (${m.rev})` : ''}: ` }), m.comment),
      list, formHead, text,
      el('div', {}, el('label', {}, 'Code ', code), ' ', el('label', {}, 'Status ', status)),
      el('p', { class: 'mk-meta', text: 'Code A closes the item; for leftover minor points add a new markup.' })),
    [{ label: 'Save', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
    if (r !== 'ok') return;
    if (app.active !== tab || app.session !== s) { toast('Follow-up not saved: the drawing was switched.'); return; }
    const t = text.value.replace(/\r/g, '').trim();
    if (!t && !removed.size) { toast('A follow-up needs a short text; nothing was saved.'); return; }
    const date = new Date().toISOString().slice(0, 10), op = { remove: [...removed] };
    if (t && index >= 0) {
      const f = m.followUps[index], fu = { text: t, code: code.value, status: status.value };
      if (fu.text !== f.text || fu.code !== f.code || fu.status !== f.status) Object.assign(op, { index, changes: { ...fu, date } });
    } else if (t) op.add = { text: t, code: code.value, status: status.value, author: authorOf(app), date, rev: round };
    if (!op.changes && !op.add && !op.remove.length) return;
    try {
      saveFollowUps(s, uid, op);
      if (op.add || m.followUps[index]?.rev === round) await this.useRound(tab, round);
    } catch (err) { if (err instanceof RangeError) toast(err.message); else throw err; }
  }
  /** Import… (MKIMPORT): the markups of the previous revision's file (read without a tab), aligned onto this drawing's
   *  content automatically (time-sliced, with Cancel) or placed at the same coordinates; one undo step. Into the tab shown
   *  when it started: switching tab (or closing it) before the import is applied cancels it. app.importHold (tests): a
   *  function returning a promise awaited once the alignment is done, so a test can switch tab mid-way. */
  async importFromFile() {
    const app = this.app;
    if (!app.doc) return;
    const tab = app.active, session = app.session;
    const switched = () => {
      if (app.active === tab && app.session === session && app.tabs.includes(tab)) return false;
      toast('Import cancelled: the drawing was switched', 4000);
      return true;
    };
    if (this.importing) { toast('An import is already running.'); return; }
    let f;
    try { [f] = await window.api.openFiles({ filters: OPEN_FILTERS, multiple: false }); } catch (err) { toast(`Could not open: ${err.message}`); return; }
    if (!f) return;
    this.importing = true;
    try {
      let src;
      try { ({ doc: src } = await loadPicked(window.api, f)); } catch (err) { await message('Cannot open this file', err.message || String(err)); return; }
      const all = [listMarkups(src), ...(src.layouts ?? []).map((l) => listMarkups({ ...src, entities: l.entities ?? [] }))].flat();
      if (!all.length) { toast(`No markups in ${f.name}`); return; }
      if (switched()) return;
      const target = app.doc.modelDoc ?? app.doc;
      const ac = new AbortController();
      const pt = progressToast('Aligning…', () => ac.abort());
      let a;
      try {
        await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0))); // let the toast paint
        a = await runSliced(alignForImportSteps(src, target), { signal: ac.signal, onProgress: (v) => pt.set(v), cancelMessage: 'Import was cancelled.' });
        await app.importHold?.();
        toast('', 1);
      } catch (err) {
        if (err.code === 'CANCELLED') toast('Import cancelled.', 2500); else toast(`Alignment failed: ${err?.message || err}`, 8000);
        return;
      }
      if (switched()) return;
      const only = el('select', { id: 'mk-imp-only' }, el('option', { value: 'all', text: 'All' }), el('option', { value: 'open', text: 'Only open (not closed and not code A)' }));
      const auto = a.method === 'auto';
      const place = el('select', { id: 'mk-imp-place' }, ...(auto ? [el('option', { value: 'auto', text: 'Aligned to the content' })] : []), el('option', { value: 'same', text: 'Place at same coordinates' }));
      const r = await modal('Import markups', el('div', { class: 'mk-imp' },
        el('p', { id: 'mk-imp-src', text: `${f.name}: ${all.length} markup${all.length === 1 ? '' : 's'} found` }),
        el('label', {}, 'Bring ', only),
        el('p', { id: 'mk-imp-align', text: auto ? `Aligned automatically (quality ${a.quality} %)` : `Could not align automatically (${a.quality} %)` }),
        el('label', {}, 'Placement ', place)),
      [{ label: 'Import', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
      if (r !== 'ok' || switched()) return;
      const spaceUids = (d) => [listMarkups(d), ...(d.layouts ?? []).map((l) => listMarkups({ ...d, entities: l.entities ?? [] }))].flat().map((m) => m.uid);
      const before = new Set(spaceUids(target));
      const res = importMarkups(session, src, { transform: place.value === 'auto' ? a.transform : undefined, only: only.value });
      const skipped = [res.skippedClosed && `${res.skippedClosed} closed`, res.skippedDuplicate && `${res.skippedDuplicate} already here`, res.skippedNoLayout && `${res.skippedNoLayout} on a layout this drawing lacks`].filter(Boolean);
      const parts = [`Imported ${res.imported} markup${res.imported === 1 ? '' : 's'}`];
      if (skipped.length) parts.push(`skipped ${skipped.join(', ')}`);
      if (res.numberCollisions.length) parts.push(`numbers already used: ${res.numberCollisions.join(', ')}`);
      if (res.imported) parts.push('Undo removes them');
      toast(`${parts.join('; ')}.`, 6000);
      if (!res.imported) return;
      const now = new Set(spaceUids(app.doc.modelDoc ?? app.doc));
      const got = all.filter((m) => !before.has(m.uid) && now.has(m.uid));
      const ids = new Set(got.map((m) => m.uid));
      const here = listMarkups(app.doc).filter((m) => ids.has(m.uid));
      if (here.length) this.showAll(here);
      // an import is a use of the round; into a drawing with no round of its own yet, the next after the imported ones
      await this.useRound(tab, this.tabRound(tab) || nextRevLabel(got.flatMap((m) => [m.rev, ...(m.followUps ?? []).map((u) => u.rev)])));
    } finally { this.importing = false; }
  }
  /** zoom to (and select) several markups */
  showAll(ms) {
    const bs = ms.map((m) => m.bbox).filter(Boolean);
    if (!bs.length) return;
    const b = { minx: Math.min(...bs.map((q) => q.minx)), miny: Math.min(...bs.map((q) => q.miny)), maxx: Math.max(...bs.map((q) => q.maxx)), maxy: Math.max(...bs.map((q) => q.maxy)) };
    const pad = Math.max(b.maxx - b.minx, b.maxy - b.miny) * 0.25 || 1;
    this.app.vp.zoomBox({ minx: b.minx - pad, miny: b.miny - pad, maxx: b.maxx + pad, maxy: b.maxy + pad });
    this.app.vp.setSelection(ms.flatMap((m) => m.ids));
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
