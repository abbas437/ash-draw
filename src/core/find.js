// Find and replace in drawing text (pure helpers, no DOM).
//   textTokens(raw)                              -> [{ rs, re, out }] raw pieces and the text each one displays
//   displayText(raw)                             -> the displayed string (same result as dxfRead.plainText)
//   findInText(plain, query, opts)               -> [[start, end], ...] matches in a displayed string
//   replaceInRaw(raw, query, repl, opts, o)      -> { text, count } raw text with matches replaced
//   findInDocument(doc, query, opts)             -> [{ id, type, layer, text, start, end, index, editable }]
//   replaceInDocument(session, query, repl, opts, targets) -> number of matches replaced, as ONE undo step
// opts: { matchCase = false, wholeWord = false }.
//
// Matching runs on the DISPLAYED text, so MTEXT formatting codes (\f…; \C…; {…} \P …) and %%c / \U+ codes
// never get in the way of a match. Replacing writes back into the raw text: codes before and after the match
// are kept untouched; codes INSIDE the match (formatting that covered only part of the matched words) are kept
// too, but moved after the replacement, so they no longer format any of it. A match that covers only part of
// a stacked fraction (\S1/2;) turns the rest of that fraction into plain text.
// TEXT (including attributes, which are read as TEXT) and MTEXT are replaceable; a dimension's text override
// is find-only, because the drawing shows the dimension's own block, not the override.
import { getEntity } from './model.js';

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

/** Text content searched for an entity, or null. ATTRIBs are TEXT entities after reading. */
function rawOf(e) {
  if (EDITABLE.has(e.type)) return e.text ?? '';
  if (e.type === 'DIMENSION' && e.text) return e.text; // override ('<>' stands for the measured value)
  return null;
}

/** Every match in the drawing's model space, in drawing order. */
export function findInDocument(doc, query, opts = {}) {
  const out = [];
  for (const e of doc.entities) {
    const raw = rawOf(e);
    if (raw == null) continue;
    const text = displayText(raw);
    findInText(text, query, opts).forEach(([start, end], index) => out.push({
      id: e.id, type: e.type, layer: e.layer ?? '0', text, start, end, index, editable: EDITABLE.has(e.type),
    }));
  }
  return out;
}

/**
 * Replace matches in TEXT/MTEXT entities as one undo step ('Replace text').
 * targets: null = every match in the drawing; otherwise [{ id, index }] from findInDocument.
 * Find-only matches (dimension overrides) are skipped. Returns the number of matches replaced.
 */
export function replaceInDocument(session, query, replacement, opts = {}, targets = null) {
  const want = new Map(); // id -> Set of match indices, or null for all
  if (targets) for (const t of targets) { if (!want.has(t.id)) want.set(t.id, new Set()); want.get(t.id).add(t.index); }
  return session.transact('Replace text', (tx) => {
    let n = 0;
    const ids = targets ? [...want.keys()] : session.doc.entities.map((e) => e.id);
    for (const id of ids) {
      const e = getEntity(session.doc, id);
      if (!e || !EDITABLE.has(e.type)) continue;
      const r = replaceInRaw(e.text, query, replacement, opts, { mtext: e.type === 'MTEXT', only: targets ? want.get(id) : null });
      if (!r.count || r.text === e.text) continue;
      tx.replace({ ...structuredClone(e), text: r.text });
      n += r.count;
    }
    return n;
  });
}
