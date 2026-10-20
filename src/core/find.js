// Find and replace in drawing text (pure helpers, no DOM).
//   textTokens(raw)                              -> [{ rs, re, out }] raw pieces and the text each one displays
//   displayText(raw)                             -> the displayed string (same result as dxfRead.plainText)
//   findInText(plain, query, opts)               -> [[start, end], ...] matches in a displayed string
//   replaceInRaw(raw, query, repl, opts, o)      -> { text, count } raw text with matches replaced
//   findInDocument(doc, query, opts)             -> [{ id, type, layer, text, start, end, index, editable, space, place, where, ... }]
//   replaceInDocument(session, query, repl, opts, targets) -> number of matches replaced, as ONE undo step
// opts: { matchCase = false, wholeWord = false }.
//
// Matching runs on the DISPLAYED text, so MTEXT formatting codes (\f…; \C…; {…} \P …) and %%c / \U+ codes
// never get in the way of a match. Replacing writes back into the raw text: codes before and after the match
// are kept untouched; codes INSIDE the match (formatting that covered only part of the matched words) are kept
// too, but moved after the replacement, so they no longer format any of it. A match that covers only part of
// a stacked fraction (\S1/2;) turns the rest of that fraction into plain text.
// Searched: model space and every layout; TEXT, MTEXT, dimension overrides, INSERT attributes (the shown ones) and
// the text an INSERT's block draws (nested blocks too), reported on the INSERT.
// TEXT, MTEXT and attributes are replaceable; a dimension's text override is find-only, because the drawing shows
// the dimension's own block, not the override; text inside a block definition is find-only (shared by every INSERT).
import { blockContentView, ATT_INVISIBLE } from './blocks.js';

const SPECIAL = { c: 'Ø', d: '°', p: '±' };
const STACK = /\\S([^;^#\\]*)[\^#/]([^;]*);/y;
const CODE = /\\[fFHCcQWATpMLlOoKk][^;\\]*;/y;

/** Split raw DXF text into tokens: each token is a raw slice [rs, re) and the text it displays ('' for codes). */
export function textTokens(raw) {
  const s = String(raw ?? '');
  const out = [];
  const tok = (rs, re, text) => out.push({ rs, re, out: text });
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '%' && s[i + 1] === '%') {
      const k = s[i + 2] ?? '';
      if (SPECIAL[k.toLowerCase()]) { tok(i, i + 3, SPECIAL[k.toLowerCase()]); i += 3; continue; }
      if (/[uUoO]/.test(k)) { tok(i, i + 3, ''); i += 3; continue; }
      if (/^\d{3}$/.test(s.slice(i + 2, i + 5))) { tok(i, i + 5, String.fromCharCode(Number(s.slice(i + 2, i + 5)))); i += 5; continue; }
    }
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'U' && /^\+[0-9A-Fa-f]{4}$/.test(s.slice(i + 2, i + 7))) { tok(i, i + 7, String.fromCharCode(parseInt(s.slice(i + 3, i + 7), 16))); i += 7; continue; }
      if (n === 'P') { tok(i, i + 2, '\n'); i += 2; continue; }
      if (n === '~') { tok(i, i + 2, '\u00A0'); i += 2; continue; }
      if (n === 'S') { STACK.lastIndex = i; const m = STACK.exec(s); if (m) { tok(i, i + m[0].length, `${m[1]}/${m[2]}`); i += m[0].length; continue; } }
      CODE.lastIndex = i;
      const m = CODE.exec(s);
      if (m) { tok(i, i + m[0].length, ''); i += m[0].length; continue; }
      if (n === '\\' || n === '{' || n === '}') { tok(i, i + 2, n); i += 2; continue; }
      if (/[LlOoKk]/.test(n ?? '')) { tok(i, i + 2, ''); i += 2; continue; }
    }
    if (c === '{' || c === '}') { tok(i, i + 1, ''); i += 1; continue; }
    tok(i, i + 1, c); i += 1;
  }
  return out;
}

export const displayText = (raw) => textTokens(raw).map((t) => t.out).join('');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Non-overlapping matches of `query` in `plain`, left to right, as [start, end] pairs. */
export function findInText(plain, query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return [];
  let src = escapeRe(query);
  if (wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  const re = new RegExp(src, matchCase ? 'gu' : 'giu');
  return [...String(plain).matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}

/** Escape a replacement string for the raw text of an entity type. */
function encode(text, mtext) {
  if (!mtext) return text.replace(/\r?\n/g, ' ');
  return text.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\P');
}

/**
 * Replace matches of `query` in raw TEXT/MTEXT content. `only` (a Set of match indices, counted on the
 * original text) limits which matches are replaced; null replaces all. Returns { text, count }.
 */
export function replaceInRaw(raw, query, replacement, opts = {}, { mtext = false, only = null } = {}) {
  const s = String(raw ?? '');
  const toks = textTokens(s);
  const owner = []; // displayed char index -> [token index, offset in token]
  toks.forEach((t, ti) => { for (let k = 0; k < t.out.length; k++) owner.push([ti, k]); });
  const plain = toks.map((t) => t.out).join('');
  const matches = findInText(plain, query, opts).map((m, i) => [...m, i]).filter((m) => !only || only.has(m[2]));
  const rep = encode(String(replacement ?? ''), mtext);
  let text = s;
  for (const [a, b] of matches.reverse()) { // back to front keeps earlier raw offsets valid
    const [t0, k0] = owner[a], [t1, k1] = owner[b - 1];
    const first = toks[t0], last = toks[t1];
    const before = encode(first.out.slice(0, k0), mtext); // rest of a partly matched multi-char token
    const after = encode(last.out.slice(k1 + 1), mtext);
    const codes = toks.slice(t0 + 1, t1).filter((t) => t.out === '').map((t) => s.slice(t.rs, t.re)).join('');
    text = text.slice(0, first.rs) + before + rep + codes + after + text.slice(last.re);
  }
  return { text, count: matches.length };
}

const EDITABLE = new Set(['TEXT', 'MTEXT']);
/** at most this many block-definition results (one per INSERT occurrence and match) per search */
export const BLOCK_HIT_CAP = 2000;
const MAX_DEPTH = 8; // nested blocks searched this deep

/** Text content searched for an entity, or null. ATTRIBs are TEXT entities after reading. */
function rawOf(e) {
  if (EDITABLE.has(e.type)) return e.text ?? '';
  if (e.type === 'DIMENSION' && e.text) return e.text; // override ('<>' stands for the measured value)
  return null;
}

/** [attrib, index in e.attribs] of the attributes an INSERT shows (invisible ones are not drawn, so not found) */
const shownAttribs = (e) => (e.attribs ?? []).map((a, k) => [a, k]).filter(([a]) => !((a.attrib?.flags ?? 0) & ATT_INVISIBLE));

/** the spaces searched: model space, then every layout's paper space in tab order (the block editor: its block only) */
function spacesOf(doc) {
  if (doc.blockEdit) return [{ space: null, place: `Block ${doc.blockEdit.name}`, list: doc.entities }];
  const root = doc.modelDoc ?? doc;
  return [{ space: 'Model', place: 'Model', list: root.entities },
    ...[...(root.layouts ?? [])].sort((a, b) => a.tab - b.tab).map((lo) => ({ space: lo.name, place: `Layout ${lo.name}`, list: lo.entities ?? [] }))];
}

/** matches inside block `name` as drawn by an INSERT (constant ATTDEFs show their value, others are not drawn),
 *  nested INSERTs and their attributes included; xrefs are not searched. Memoised per search in `memo`. */
function blockHits(blocks, name, query, opts, memo, depth = 0) {
  if (memo.has(name)) return memo.get(name);
  memo.set(name, []); // a block that contains itself stops here
  const blk = blocks.get(name), out = [];
  const add = (v, where) => {
    const raw = rawOf(v);
    if (raw == null) return;
    const text = displayText(raw), ms = findInText(text, query, opts);
    if (ms.length) out.push({ type: v.type, text, ms, where });
  };
  if (blk && !blk.xref && depth < MAX_DEPTH) {
    for (const be of blk.entities ?? []) {
      const v = blockContentView(be);
      if (!v) continue;
      add(v, `in block ${name}`);
      if (v.type !== 'INSERT') continue;
      for (const [a] of shownAttribs(v)) add(a, `attribute ${a.attrib.tag} of block ${v.block} in block ${name}`);
      for (const h of blockHits(blocks, v.block, query, opts, memo, depth + 1)) out.push({ ...h, where: `${h.where} in block ${name}` });
    }
  }
  memo.set(name, out);
  return out;
}

/**
 * Every match in the drawing: model space, then each layout, in drawing order. Searched: TEXT, MTEXT, dimension
 * overrides, the shown attributes of INSERTs, and the text drawn by the INSERT's block (reported on the INSERT, one
 * result per INSERT occurrence, find-only; at most BLOCK_HIT_CAP of them - `blockHitsCapped` is set when more were left out).
 * Result: { id, type, layer, text, start, end, index, editable, space ('Model', a layout name, or null in the block
 * editor), place ('Model' / 'Layout NAME'), where ('' / 'attribute TAG of block B' / 'in block B'), attrib? (index in
 * the INSERT's attribs), inBlock? }.
 */
export function findInDocument(doc, query, opts = {}) {
  const out = [];
  if (!query) return out;
  const blocks = (doc.modelDoc ?? doc).blocks ?? new Map(), memo = new Map();
  let blockN = 0;
  for (const { space, place, list } of spacesOf(doc)) {
    for (const e of list) {
      const raw = rawOf(e);
      const push = (text, extra) => (start, end, index) => out.push({ id: e.id, type: e.type, layer: e.layer ?? '0', text, start, end, index, space, place, where: '', ...extra });
      if (raw != null) {
        const text = displayText(raw);
        findInText(text, query, opts).forEach(([a, b], i) => push(text, { editable: EDITABLE.has(e.type) })(a, b, i));
      }
      if (e.type !== 'INSERT') continue;
      for (const [at, k] of shownAttribs(e)) {
        const text = displayText(at.text ?? '');
        findInText(text, query, opts).forEach(([a, b], i) => push(text, { type: 'ATTRIB', layer: at.layer ?? e.layer ?? '0', editable: true, attrib: k, where: `attribute ${at.attrib.tag} of block ${e.block}` })(a, b, i));
      }
      for (const h of blockHits(blocks, e.block, query, opts, memo)) {
        for (const [[a, b], i] of h.ms.map((m, i) => [m, i])) {
          if (blockN >= BLOCK_HIT_CAP) { out.blockHitsCapped = true; break; }
          blockN++;
          push(h.text, { type: h.type, editable: false, inBlock: true, where: h.where })(a, b, i);
        }
      }
    }
  }
  return out;
}

/**
 * Replace matches in TEXT/MTEXT entities and INSERT attributes (every space) as one undo step ('Replace text').
 * targets: null = every match in the drawing; otherwise [{ id, index, attrib? }] from findInDocument.
 * Find-only matches (dimension overrides, text inside block definitions) are skipped: a block definition is shared
 * by all its INSERTs, so it is never changed from here. Returns the number of matches replaced.
 */
export function replaceInDocument(session, query, replacement, opts = {}, targets = null) {
  const want = new Map(); // id -> Map(part -> Set of match indices); part = attribute index, -1 the entity's own text
  if (targets) {
    for (const t of targets) {
      if (t.inBlock) continue;
      const parts = want.get(t.id) ?? want.set(t.id, new Map()).get(t.id), part = t.attrib ?? -1;
      (parts.get(part) ?? parts.set(part, new Set()).get(part)).add(t.index);
    }
  }
  return session.transact('Replace text', (tx) => {
    let n = 0;
    for (const { list } of spacesOf(session.doc)) {
      list.forEach((e, i) => {
        const w = targets ? want.get(e.id) : null;
        if (targets && !w) return;
        let c = null;
        if (EDITABLE.has(e.type) && (!w || w.has(-1))) {
          const r = replaceInRaw(e.text, query, replacement, opts, { mtext: e.type === 'MTEXT', only: w?.get(-1) ?? null });
          if (r.count && r.text !== e.text) { c = { ...structuredClone(e), text: r.text }; n += r.count; }
        }
        if (e.type === 'INSERT') {
          for (const [a, k] of shownAttribs(e)) {
            if (w && !w.has(k)) continue;
            const r = replaceInRaw(a.text, query, replacement, opts, { mtext: a.type === 'MTEXT', only: w?.get(k) ?? null });
            if (!r.count || r.text === a.text) continue;
            c ??= structuredClone(e);
            c.attribs[k].text = r.text; n += r.count;
          }
        }
        if (!c) return;
        if (list === session.doc.entities) tx.replace(c); else tx.set(list, i, c); // another space's list
      });
    }
    return n;
  });
}
