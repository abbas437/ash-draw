// ASH Draw Studio - review markups: a dashed red circle or rectangle (or a note alone) with a short comment beside it.
// Every part is an ordinary DXF entity on layer ASH-MARKUP, so markups plot, print and open in AutoCAD. The review
// metadata (number, author, date, status, comment) is XDATA of application ASH_MARKUP on each part, so it round-trips:
//   1000 "key=value" strings; keys: uid, no, role (shape | leader | text), kind (circle | rect | text), author, date,
//   status (Open | In progress | Closed), code (review code A | B | C; absent = none), comment (repeated in 200-character pieces when long).
// Review rounds (Rev.xx follow-ups on a resubmission), values %-escaped (see escX: '%' and control characters as %XX):
//   rev (the round the markup was raised in, e.g. Rev.00; absent = unknown); per follow-up n = 1, 2, ... in order:
//   fu<n>.rev, fu<n>.code, fu<n>.status, fu<n>.author, fu<n>.date and fu<n>.text (repeated in pieces of at most 200
//   characters and 255 bytes as written to the DXF). With follow-ups, status and code are the latest follow-up's (so a
//   reader that knows no follow-ups sees the current state) and ostatus / ocode keep the original round's.
// Pure ES module (no DOM).
import { makeCircle, makeRect, makeLine, makeMText, addLinetype } from './model.js';
import { bboxOf, unionBox } from './geom.js';
import { csvText } from './csv.js';
import { colName } from './xlsx.js';

export const MARKUP_LAYER = 'ASH-MARKUP';
export const MARKUP_APP = 'ASH_MARKUP';
export const MARKUP_LINETYPE = 'DASHED';
export const MARKUP_STATUSES = ['Open', 'In progress', 'Closed'];
export const MARKUP_CODES = ['A', 'B', 'C'];
const RED = 1;
const PIECE = 200;

/** %-escape of a stored value: '%' and the control characters (newlines included) as %XX, so the DXF writer keeps them */
const escX = (v) => String(v ?? '').replace(/[%\x00-\x1f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const unescX = (v) => String(v).replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
/** bytes of a string as the DXF writer writes it (non-ASCII as \U+XXXX, outside the BMP as '?') */
const dxfLen = (v) => { let n = 0; for (const ch of String(v)) { const c = ch.codePointAt(0); n += c > 0x7e && c <= 0xffff ? 7 : 1; } return n; };
/** an escaped value cut into pieces of at most PIECE characters and, with `prefix`, 255 DXF bytes; never inside a %XX */
function xPieces(prefix, escaped) {
  const out = [], room = 255 - dxfLen(prefix);
  let cur = '', chars = 0, bytes = 0;
  for (const tok of escaped.match(/%[0-9A-F]{2}|[^]/gu) ?? []) {
    const b = dxfLen(tok);
    if (cur && (chars + tok.length > PIECE || bytes + b > room)) { out.push(cur); cur = ''; chars = 0; bytes = 0; }
    cur += tok; chars += tok.length; bytes += b;
  }
  out.push(cur);
  return out.map((p) => `${prefix}${p}`);
}
/** the most XDATA bytes one entity may carry (DXF / AutoCAD limit); counted as written to the DXF plus 3 bytes a string */
export const MARKUP_XDATA_LIMIT = 16383;
const xdataBytes = (tags) => tags.reduce((t, [, v]) => t + 3 + dxfLen(v), 3 + MARKUP_APP.length);

/** a follow-up with every field set: an unknown code is none, no status is Closed for code A and Open otherwise, Closed with no code is A */
function normFollowUp(f = {}) {
  let code = MARKUP_CODES.includes(f.code) ? f.code : '';
  const status = MARKUP_STATUSES.includes(f.status) ? f.status : code === 'A' ? 'Closed' : 'Open';
  if (status === 'Closed' && !code) code = 'A';
  return { rev: String(f.rev ?? '').trim(), text: String(f.text ?? '').trim(), code, status, author: String(f.author || 'unknown'), date: String(f.date ?? today()) };
}

/**
 * the markup metadata of an entity, or null when it is not part of a markup: { uid, no, role, kind, author, date, status, code
 * (absent = none), comment, rev ('' = unknown), followUps: [{ rev, text, code, status, author, date }], origStatus, origCode }.
 * status and code are the latest round's (the last follow-up's); origStatus / origCode the original comment's.
 */
export function markupData(e) {
  const tags = e?.xdata?.[MARKUP_APP];
  if (!tags) return null;
  const d = { comment: '' }, fus = new Map();
  for (const [c, v] of tags) {
    if (c !== 1000) continue;
    const i = String(v).indexOf('=');
    if (i < 0) continue;
    const k = v.slice(0, i), val = v.slice(i + 1);
    const fu = /^fu(\d+)\.(rev|text|code|status|author|date)$/.exec(k);
    if (fu) {
      const n = Number(fu[1]);
      if (!fus.has(n)) fus.set(n, {});
      const f = fus.get(n);
      f[fu[2]] = (fu[2] === 'text' ? (f.text ?? '') : '') + unescX(val);
    } else if (k === 'comment') d.comment += val;
    else if (k === 'rev') d.rev = unescX(val);
    else d[k] = k === 'no' ? Number(val) : val;
  }
  if (!d.uid) return null;
  const { ostatus, ocode, ...out } = d;
  out.rev ??= '';
  out.followUps = [...fus.keys()].sort((a, b) => a - b).map((n) => normFollowUp(fus.get(n)));
  out.origStatus = out.followUps.length ? (ostatus ?? 'Open') : out.status;
  out.origCode = (out.followUps.length ? ocode : out.code) ?? '';
  return out;
}

/** XDATA for `data` (see the header for the keys); with follow-ups, status and code are taken from the last one */
export function markupXData(data) {
  const tags = [];
  const fus = (data.followUps ?? []).map(normFollowUp), last = fus.at(-1);
  const cur = last ? { ...data, status: last.status, code: last.code } : data;
  for (const k of ['uid', 'no', 'role', 'kind', 'author', 'date', 'status', 'code']) if (cur[k] != null && cur[k] !== '') tags.push([1000, `${k}=${cur[k]}`]);
  const c = String(data.comment ?? '');
  for (let i = 0; i < Math.max(c.length, 1); i += PIECE) tags.push([1000, `comment=${c.slice(i, i + PIECE)}`]);
  if (data.rev) tags.push([1000, `rev=${escX(data.rev)}`]);
  if (fus.length) {
    const os = data.origStatus ?? data.status, oc = data.origCode ?? data.code;
    if (os) tags.push([1000, `ostatus=${os}`]);
    if (oc) tags.push([1000, `ocode=${oc}`]);
    fus.forEach((f, i) => {
      for (const k of ['rev', 'code', 'status', 'author', 'date']) if (f[k]) tags.push([1000, `fu${i + 1}.${k}=${escX(f[k])}`]);
      for (const p of xPieces(`fu${i + 1}.text=`, escX(f.text))) tags.push([1000, p]);
    });
  }
  return { [MARKUP_APP]: tags };
}

/** MTEXT text of a follow-up line: \, { and } escaped, line breaks as \P */
const escMText = (t) => String(t).replace(/[\\{}]/g, (ch) => `\\${ch}`).replace(/\r\n|\r|\n/g, '\\P');
/** the comment text drawn for markup `meta`: "<no>: <comment>", then one blue (ACI 5) paragraph "Rev.xx: <text>" per follow-up */
export function markupLabel(meta) {
  const head = meta.comment ? `${meta.no}: ${meta.comment}` : String(meta.no);
  const fus = (meta.followUps ?? []).map((f) => `\\P{\\C5;${escMText(f.rev ? `${f.rev}: ${f.text}` : f.text)}}`);
  return head.replace(/\r?\n/g, '\\P') + fus.join('');
}

const nextNo = (doc) => doc.entities.reduce((m, e) => Math.max(m, markupData(e)?.no ?? 0), 0) + 1;
const today = () => new Date().toISOString().slice(0, 10);
const newUid = () => `MK${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

/**
 * Entities of one markup (not yet added). kind 'circle' {c, r} | 'rect' {p1, p2} | 'text' {p}.
 * opts: comment, author, date, status, code, rev, followUps, height (comment text height; default from the shape size), no, uid.
 */
export function makeMarkup(doc, kind, geo, opts = {}) {
  const meta = {
    uid: opts.uid ?? newUid(), no: opts.no ?? nextNo(doc), kind, author: opts.author || 'unknown',
    date: opts.date ?? today(), status: opts.status ?? 'Open', code: opts.code || '', comment: String(opts.comment ?? '').trim(),
    rev: String(opts.rev ?? '').trim(), followUps: (opts.followUps ?? []).map(normFollowUp),
  };
  const base = { layer: MARKUP_LAYER, color: RED };
  const tag = (e, role) => { e.xdata = markupXData({ ...meta, role }); return e; };
  const out = [];
  let tip, size;
  if (kind === 'circle') {
    size = geo.r;
    tip = { x: geo.c.x + geo.r * Math.SQRT1_2, y: geo.c.y + geo.r * Math.SQRT1_2 };
    out.push(tag(makeCircle(geo.c, geo.r, { ...base, linetype: MARKUP_LINETYPE, ltscale: size / 4 }), 'shape'));
  } else if (kind === 'rect') {
    const maxx = Math.max(geo.p1.x, geo.p2.x), maxy = Math.max(geo.p1.y, geo.p2.y);
    size = Math.max(Math.abs(geo.p2.x - geo.p1.x), Math.abs(geo.p2.y - geo.p1.y)) / 2;
    tip = { x: maxx, y: maxy };
    out.push(tag(makeRect(geo.p1, geo.p2, { ...base, linetype: MARKUP_LINETYPE, ltscale: size / 4 }), 'shape'));
  } else {
    size = (opts.height ?? 1) * 4;
    tip = null;
  }
  const h = opts.height ?? Math.max(size / 4, 1e-6);
  const at = tip ? { x: tip.x + size * 0.5, y: tip.y + size * 0.5 } : geo.p;
  if (tip) out.push(tag(makeLine(tip, at, base), 'leader'));
  out.push(tag(makeMText(at, h, markupLabel(meta), { ...base, attach: 7 }), 'text'));
  return out;
}

/** the DASHED linetype and the ASH-MARKUP layer (red, dashed, plotted) inside transaction tx */
export function ensureMarkupLayer(tx) {
  const doc = tx.doc;
  if (!doc.linetypes.has(MARKUP_LINETYPE)) addLinetype(doc, { name: MARKUP_LINETYPE, description: 'Dashed __ __ __ __', pattern: [0.5, -0.25] });
  if (!doc.layers.has(MARKUP_LAYER)) tx.layer(MARKUP_LAYER, { color: RED, linetype: MARKUP_LINETYPE, plot: true });
}

/** add a markup as one undo step; returns the added entities */
export function addMarkup(s, kind, geo, opts = {}) {
  return s.transact('Markup', (tx) => {
    ensureMarkupLayer(tx);
    return makeMarkup(s.doc, kind, geo, opts).map((e) => tx.add(e));
  });
}

/** every markup of the drawing: [{uid, no, kind, comment, author, date, status, code ('' = none), rev, followUps, ids, bbox}] by number;
 *  status and code are the latest round's */
export function listMarkups(doc) {
  const by = new Map();
  for (const e of doc.entities) {
    const d = markupData(e);
    if (!d) continue;
    let m = by.get(d.uid);
    if (!m) by.set(d.uid, (m = { uid: d.uid, no: d.no, kind: d.kind, comment: d.comment, author: d.author, date: d.date, status: d.status, code: d.code ?? '', rev: d.rev, followUps: d.followUps, ids: [], bbox: null }));
    if (d.role === 'shape' || (d.role === 'text' && m.kind === 'text')) Object.assign(m, { comment: d.comment, status: d.status, code: d.code ?? '', author: d.author, date: d.date, rev: d.rev, followUps: d.followUps });
    m.ids.push(e.id);
    let b = null;
    try { b = bboxOf(e, doc); } catch { b = null; }
    if (b) m.bbox = m.bbox ? unionBox(m.bbox, b) : b;
  }
  return [...by.values()].sort((a, b) => a.no - b.no);
}

/**
 * rewrite every part of markup `uid` with metadata change(d) (null = leave the part), as one undo step labelled `label`;
 * text: redraw the comment text (markupLabel). Throws a RangeError, changing nothing, when a part's XDATA would pass
 * MARKUP_XDATA_LIMIT. Returns the parts changed.
 */
function rewriteMarkup(s, uid, label, change, { text = false } = {}) {
  const out = [];
  for (const e of s.doc.entities) {
    const d = markupData(e);
    if (d?.uid !== uid) continue;
    const nd = change(d);
    if (!nd) continue;
    const xdata = markupXData(nd);
    if (xdataBytes(xdata[MARKUP_APP]) > MARKUP_XDATA_LIMIT) throw new RangeError('Markup text too long: the drawing cannot store it (XDATA limit)');
    const ne = { ...structuredClone(e), xdata };
    if (text && d.role === 'text' && typeof ne.text === 'string') ne.text = markupLabel(markupData(ne));
    if (JSON.stringify(ne.xdata) === JSON.stringify(e.xdata) && ne.text === e.text) continue;
    out.push(ne);
  }
  return s.transact(label, (tx) => { for (const ne of out) tx.replace(ne); return out.length; });
}

/** a change of the follow-up list: `fn` gets a copy of the list and returns the new one */
const withFollowUps = (fn) => (d) => ({ ...d, followUps: fn(d.followUps.map((f) => ({ ...f }))) });

/**
 * change the status (Open / In progress / Closed) of markup `uid` (of its latest follow-up when it has any): one undo step.
 * Closing with no review code gives code A (addressed = Code A); a code already chosen is never changed.
 */
export function setMarkupStatus(s, uid, status) {
  if (!MARKUP_STATUSES.includes(status)) return 0;
  return rewriteMarkup(s, uid, 'Markup status', (d) => {
    if (d.followUps.length) return withFollowUps((l) => { Object.assign(l.at(-1), { status, code: status === 'Closed' && !l.at(-1).code ? 'A' : l.at(-1).code }); return l; })(d);
    return { ...d, status, code: status === 'Closed' && !d.code ? 'A' : (d.code ?? '') };
  });
}

/** change the review code (A / B / C, '' = none) of markup `uid` (of its latest follow-up when it has any): one undo step */
export function setMarkupCode(s, uid, code) {
  const c = MARKUP_CODES.includes(code) ? code : '';
  return rewriteMarkup(s, uid, 'Markup code', (d) => (d.followUps.length
    ? withFollowUps((l) => { l.at(-1).code = c; return l; })(d) : { ...d, code: c }));
}

/**
 * add a follow-up { rev, text, code, status, author, date } to markup `uid` as one undo step (normFollowUp fills the gaps;
 * no rev = nextRevLabel of the markup's rounds). The markup's status and code become the follow-up's. Returns the parts changed.
 */
export function addFollowUp(s, uid, fu = {}) {
  return rewriteMarkup(s, uid, 'Markup follow-up', (d) => withFollowUps((l) => [...l, {
    ...fu, rev: fu.rev ?? nextRevLabel([d.rev, ...l.map((f) => f.rev)]),
  }])(d), { text: true });
}

/**
 * change follow-up `index` (0 = the first) of markup `uid` by `changes` (any of rev, text, code, status, author, date) as one
 * undo step; setting code A without a status closes it. Returns the parts changed (0 for no such follow-up).
 */
export function editFollowUp(s, uid, index, changes = {}) {
  return rewriteMarkup(s, uid, 'Edit follow-up', (d) => {
    if (!d.followUps[index]) return null;
    return withFollowUps((l) => {
      const f = { ...l[index], ...changes };
      if (changes.code === 'A' && changes.status == null) delete f.status;
      l[index] = f;
      return l;
    })(d);
  }, { text: true });
}

/** remove follow-up `index` of markup `uid` as one undo step; with none left, the original status and code come back */
export function removeFollowUp(s, uid, index) {
  return rewriteMarkup(s, uid, 'Remove follow-up', (d) => {
    if (!d.followUps[index]) return null;
    const followUps = d.followUps.filter((_, i) => i !== index);
    return followUps.length ? { ...d, followUps } : { ...d, followUps, status: d.origStatus, code: d.origCode };
  }, { text: true });
}

/** set the review round markup `uid` was raised in (e.g. 'Rev.00'; '' = unknown): one undo step */
export const setMarkupRev = (s, uid, rev) => rewriteMarkup(s, uid, 'Markup revision', (d) => ({ ...d, rev: String(rev ?? '').trim() }));

/** a revision label split: { prefix, n (number) | letter, width } or null; 'Rev.01', 'Rev 1', 'R00', 'Rev.A' */
function parseRev(label) {
  const m = /^\s*(rev|r)([.\s_-]*)(\d+|[a-z])\s*$/i.exec(String(label ?? ''));
  if (!m) return null;
  const digits = /\d/.test(m[3]);
  return { prefix: m[1] + m[2], digits, value: digits ? Number(m[3]) : m[3].toUpperCase().charCodeAt(0) - 64, width: m[3].length, lower: m[3] !== m[3].toUpperCase() };
}
/** order of parsed labels: letters (Rev.A, B, ...) before numbers (Rev.00, 01, ...) */
const revRank = (p) => (p.digits ? 1e6 : 0) + p.value;
/** the highest revision label of `labels` ('' when none parses) */
export function latestRevLabel(labels) {
  let best = null, bestLabel = '';
  for (const l of labels ?? []) { const p = parseRev(l); if (p && (!best || revRank(p) > revRank(best))) { best = p; bestLabel = String(l).trim(); } }
  return bestLabel;
}
/** the label after the highest of `labels`, in its style: ['Rev.00', 'Rev.01'] -> 'Rev.02', 'R00' -> 'R01', 'Rev 1' -> 'Rev 2', 'Rev.A' -> 'Rev.B'; none -> 'Rev.01' */
export function nextRevLabel(labels) {
  const top = latestRevLabel(labels);
  if (!top) return 'Rev.01';
  const p = parseRev(top);
  if (p.digits) return p.prefix + String(p.value + 1).padStart(p.width, '0');
  const letter = p.value >= 26 ? 'AA' : String.fromCharCode(65 + p.value);
  return p.prefix + (p.lower ? letter.toLowerCase() : letter);
}

/**
 * renumber every markup of the drawing start, start+1, ... in their present order (number, then drawing order), as one
 * undo step; the number drawn at the start of each comment text changes with it (redrawn in full for a markup with
 * follow-ups). Returns the number of markups renumbered.
 */
export function renumberMarkups(s, start = 1) {
  const first = Math.trunc(Number(start)) || 1;
  const order = new Map(listMarkups(s.doc).map((m, i) => [m.uid, first + i]));
  return s.transact('Renumber markups', (tx) => {
    const changed = new Set();
    for (const e of s.doc.entities) {
      const d = markupData(e), no = d && order.get(d.uid);
      if (!d || no === d.no) continue;
      const ne = { ...structuredClone(e), xdata: markupXData({ ...d, no }) };
      if (d.role === 'text' && typeof ne.text === 'string') {
        ne.text = d.followUps.length ? markupLabel({ ...d, no }) : ne.text.replace(new RegExp(`^${d.no}(?=:|$)`), String(no));
      }
      tx.replace(ne);
      changed.add(d.uid);
    }
    return changed.size;
  });
}

/** erase every part of markup `uid`: one undo step */
export function deleteMarkup(s, uid) {
  const ids = s.doc.entities.filter((e) => markupData(e)?.uid === uid).map((e) => e.id);
  return s.transact('Delete markup', (tx) => tx.remove(ids).length);
}

/** show / hide the ASH-MARKUP layer */
export function setMarkupsVisible(s, on) {
  if (!s.doc.layers.has(MARKUP_LAYER)) return false;
  s.transact(on ? 'Show markups' : 'Hide markups', (tx) => tx.layer(MARKUP_LAYER, { visible: !!on }));
  return true;
}

/** the markup list as CSV for Excel (src/core/csv.js: quoting, BOM, formula guard) */
export function markupsCsv(list) {
  return csvText(['No', 'Comment', 'Author', 'Date', 'Status'], list.map((m) => [m.no, m.comment, m.author, m.date, m.status]));
}

/** CRS (comment review sheet) fill colour of the Status cell for a review code: A green, B orange, C red, none no fill */
export const CRS_CODE_FILLS = { A: '00B050', B: 'FFC000', C: 'FF0000' };
const CRS_HEAD = ['No.', 'Rev.', 'Sheet / Layout', 'Comment', 'Reviewer', 'Date', 'Status', 'Code'];
/** the CRS colour of follow-up lines (blue, plain) */
export const CRS_FOLLOWUP_COLOR = '0070C0';

/** the Comment cell of a markup: plain text, or with follow-ups rich text: the comment, then a blue "Rev.xx: <text>" line each */
function crsComment(m) {
  const fus = m.followUps ?? [];
  if (!fus.length) return m.comment ?? '';
  return { runs: [{ text: m.comment ?? '' }, ...fus.map((f) => ({ text: `\n${f.rev ? `${f.rev}: ` : ''}${f.text}`, color: CRS_FOLLOWUP_COLOR, bold: false }))] };
}

/**
 * the CRS sheet for xlsxBytes (src/core/xlsx.js): a header block (title, drawing file name, export date, the latest review
 * round when markups carry revision labels), then one row per markup: No. | Rev. | Sheet / Layout | Comment | Reviewer |
 * Date | Status | Code. Every cell Calibri 11; the Comment column wraps, follow-ups under the comment in blue; Status and
 * Code are the latest round's and the Status cell is filled in the colour of that code; Status and Code have drop-down lists.
 * spaces: [{ name: 'Model' | layout name, markups: listMarkups(...) }].
 */
export function markupsCrsSheet(spaces, { drawing = '', date = today() } = {}) {
  const top = { vAlign: 'top' }, wrap = { vAlign: 'top', wrap: true };
  const round = latestRevLabel(spaces.flatMap(({ markups }) => markups.flatMap((m) => [m.rev, ...(m.followUps ?? []).map((f) => f.rev)])));
  const rows = [
    [{ v: 'Comment Review Sheet (CRS) - drawing markups', style: { bold: true } }],
    [{ v: 'Drawing', style: { bold: true } }, drawing],
    [{ v: 'Export date', style: { bold: true } }, date],
    ...(round ? [[{ v: 'Review round', style: { bold: true } }, round]] : []),
    [],
    CRS_HEAD.map((v) => ({ v, style: { bold: true, wrap: true, vAlign: 'top' } })),
  ];
  const first = rows.length + 1;
  for (const { name, markups } of spaces) {
    for (const m of markups) {
      const code = MARKUP_CODES.includes(m.code) ? m.code : '';
      rows.push([
        { v: m.no, style: top }, { v: m.rev ?? '', style: top }, { v: name, style: top }, { v: crsComment(m), style: wrap }, { v: m.author ?? '', style: top },
        { v: m.date ?? '', style: top }, { v: m.status ?? 'Open', style: code ? { ...top, fill: CRS_CODE_FILLS[code] } : top }, { v: code, style: top },
      ]);
    }
  }
  const last = Math.max(rows.length, first);
  const col = (name) => colName(CRS_HEAD.indexOf(name));
  return {
    name: 'CRS', rows, boldRows: [], colWidths: [6, 8, 16, 60, 18, 12, 10, 8],
    validations: [
      { sqref: `${col('Status')}${first}:${col('Status')}${last}`, list: MARKUP_STATUSES },
      { sqref: `${col('Code')}${first}:${col('Code')}${last}`, list: MARKUP_CODES },
    ],
  };
}
