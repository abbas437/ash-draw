// ASH Draw Studio - review markups: a dashed red circle or rectangle (or a note alone) with a short comment beside it.
// Every part is an ordinary DXF entity on layer ASH-MARKUP, so markups plot, print and open in AutoCAD. The review
// metadata (number, author, date, status, comment) is XDATA of application ASH_MARKUP on each part, so it round-trips:
//   1000 "key=value" strings; keys: uid, no, role (shape | leader | text), kind (circle | rect | text), author, date,
//   status (Open | Closed), comment (repeated in 200-character pieces when long).
// Pure ES module (no DOM).
import { makeCircle, makeRect, makeLine, makeMText, addLinetype } from './model.js';
import { bboxOf, unionBox } from './geom.js';

export const MARKUP_LAYER = 'ASH-MARKUP';
export const MARKUP_APP = 'ASH_MARKUP';
export const MARKUP_LINETYPE = 'DASHED';
const RED = 1;
const PIECE = 200;

/** the markup metadata of an entity, or null when it is not part of a markup */
export function markupData(e) {
  const tags = e?.xdata?.[MARKUP_APP];
  if (!tags) return null;
  const d = { comment: '' };
  for (const [c, v] of tags) {
    if (c !== 1000) continue;
    const i = String(v).indexOf('=');
    if (i < 0) continue;
    const k = v.slice(0, i), val = v.slice(i + 1);
    if (k === 'comment') d.comment += val; else d[k] = k === 'no' ? Number(val) : val;
  }
  return d.uid ? d : null;
}

/** XDATA for `data` (see the header for the keys) */
export function markupXData(data) {
  const tags = [];
  for (const k of ['uid', 'no', 'role', 'kind', 'author', 'date', 'status']) if (data[k] != null) tags.push([1000, `${k}=${data[k]}`]);
  const c = String(data.comment ?? '');
  for (let i = 0; i < Math.max(c.length, 1); i += PIECE) tags.push([1000, `comment=${c.slice(i, i + PIECE)}`]);
  return { [MARKUP_APP]: tags };
}

const nextNo = (doc) => doc.entities.reduce((m, e) => Math.max(m, markupData(e)?.no ?? 0), 0) + 1;
const today = () => new Date().toISOString().slice(0, 10);
const newUid = () => `MK${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

/**
 * Entities of one markup (not yet added). kind 'circle' {c, r} | 'rect' {p1, p2} | 'text' {p}.
 * opts: comment, author, date, status, height (comment text height; default from the shape size), no, uid.
 */
export function makeMarkup(doc, kind, geo, opts = {}) {
  const meta = {
    uid: opts.uid ?? newUid(), no: opts.no ?? nextNo(doc), kind, author: opts.author || 'unknown',
    date: opts.date ?? today(), status: opts.status ?? 'Open', comment: String(opts.comment ?? '').trim(),
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
  const label = meta.comment ? `${meta.no}: ${meta.comment}` : String(meta.no);
  out.push(tag(makeMText(at, h, label.replace(/\r?\n/g, '\\P'), { ...base, attach: 7 }), 'text'));
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

/** every markup of the drawing: [{uid, no, kind, comment, author, date, status, ids, bbox}] by number */
export function listMarkups(doc) {
  const by = new Map();
  for (const e of doc.entities) {
    const d = markupData(e);
    if (!d) continue;
    let m = by.get(d.uid);
    if (!m) by.set(d.uid, (m = { uid: d.uid, no: d.no, kind: d.kind, comment: d.comment, author: d.author, date: d.date, status: d.status, ids: [], bbox: null }));
    if (d.role === 'shape' || (d.role === 'text' && m.kind === 'text')) Object.assign(m, { comment: d.comment, status: d.status, author: d.author, date: d.date });
    m.ids.push(e.id);
    let b = null;
    try { b = bboxOf(e, doc); } catch { b = null; }
    if (b) m.bbox = m.bbox ? unionBox(m.bbox, b) : b;
  }
  return [...by.values()].sort((a, b) => a.no - b.no);
}

/** change the status (Open / Closed) of markup `uid`: one undo step */
export function setMarkupStatus(s, uid, status) {
  return s.transact('Markup status', (tx) => {
    let n = 0;
    for (const e of s.doc.entities) {
      const d = markupData(e);
      if (d?.uid !== uid || d.status === status) continue;
      tx.replace({ ...structuredClone(e), xdata: markupXData({ ...d, status }) });
      n++;
    }
    return n;
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

/** the markup list as CSV (RFC 4180 quoting) */
export function markupsCsv(list) {
  const q = (v) => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return ['No,Comment,Author,Date,Status', ...list.map((m) => [m.no, m.comment, m.author, m.date, m.status].map(q).join(','))].join('\r\n') + '\r\n';
}
