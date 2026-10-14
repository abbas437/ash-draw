// ASH Draw Studio - .pat hatch pattern file parser (acad.pat / acadiso.pat style). Pure: text in, definitions out.
//
//   ;; comment                       a line starting with ';' (a trailing '; ...' after a definition is also ignored)
//   ;%UNITS=MM   ;%TYPE=MODEL        directives (Revit style); kept as metadata on the patterns that follow
//   *NAME, description               a pattern header
//   angle, x-origin, y-origin, delta-x, delta-y [, dash1, dash2, ...]
//                                    one line family; dash > 0 pen down, < 0 pen up, 0 a dot
//
// The result's definitions have the shape of the built-in ones in patterns.js: { angle, base: [x, y], delta: [dx, dy],
// dashes: [...] }. Units are not converted (AutoCAD does not either: acad.pat and acadiso.pat are simply two files).

/** limits for malformed or hostile input */
export const PAT_LIMITS = Object.freeze({ maxChars: 4 << 20, maxPatterns: 1000, maxLinesPerPattern: 256, maxDashes: 64, maxErrors: 100 });

const num = (s) => {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
  return Number(t);
};

/**
 * Parse the text of a .pat file.
 * @returns {{ patterns: Array<{ name, description, units, type, lines: Array<{angle, base, delta, dashes}> }>,
 *             errors: Array<{ line: number, message: string }> }}  line numbers are 1-based
 */
export function parsePat(text, limits = {}) {
  const L = { ...PAT_LIMITS, ...limits };
  const patterns = [], errors = [];
  const err = (line, message) => { if (errors.length < L.maxErrors) errors.push({ line, message }); };
  let src = String(text ?? '');
  if (src.length > L.maxChars) { err(0, `File is larger than ${L.maxChars} characters; the rest is ignored.`); src = src.slice(0, L.maxChars); }
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const rows = src.split(/\r\n|\r|\n/);
  const meta = { units: null, type: null };
  const seen = new Set();
  let cur = null, skip = false, full = false;
  const close = () => {
    if (cur && !skip) {
      if (!cur.lines.length) err(cur.at, `Pattern ${cur.name} has no definition lines.`);
      else { const { at, over, ...p } = cur; void at; void over; patterns.push(p); }
    }
    cur = null; skip = false;
  };
  for (let i = 0; i < rows.length; i++) {
    const n = i + 1, raw = rows[i].trim();
    if (!raw) continue;
    if (raw[0] === ';') {
      const d = /^;\s*%\s*(UNITS|TYPE)\s*=\s*([A-Za-z]+)/i.exec(raw);
      if (d) {
        const k = d[1].toLowerCase(), v = d[2].toUpperCase();
        meta[k] = v;
        if (cur && !cur.lines.length) cur[k] = v; // Revit puts ;%TYPE right after the header
      }
      continue;
    }
    if (raw[0] === '*') {
      close();
      if (full) continue;
      if (patterns.length >= L.maxPatterns) { err(n, `More than ${L.maxPatterns} patterns; the rest of the file is ignored.`); full = true; continue; }
      const c = raw.indexOf(',');
      const name = (c < 0 ? raw.slice(1) : raw.slice(1, c)).trim().toUpperCase();
      const description = c < 0 ? '' : raw.slice(c + 1).trim();
      if (!name) { err(n, 'Pattern header without a name.'); skip = true; cur = { at: n, lines: [] }; continue; }
      if (seen.has(name)) { err(n, `Pattern ${name} is defined again; the first definition is kept.`); skip = true; }
      seen.add(name);
      cur = { at: n, name, description, units: meta.units, type: meta.type, lines: [] };
      continue;
    }
    if (full) continue;
    if (!cur) { err(n, 'Definition line before any *NAME header.'); continue; }
    if (skip) continue;
    const body = raw.replace(/;.*$/, '');
    const parts = body.split(',');
    if (parts.length && !parts[parts.length - 1].trim()) parts.pop(); // tolerate a trailing comma
    const v = parts.map(num);
    const bad = v.findIndex((x) => !Number.isFinite(x));
    if (bad >= 0) { err(n, `Not a number in field ${bad + 1}: "${parts[bad].trim()}".`); continue; }
    if (v.length < 5) { err(n, `A definition line needs angle, x-origin, y-origin, delta-x, delta-y (found ${v.length} values).`); continue; }
    if (v.length - 5 > L.maxDashes) { err(n, `More than ${L.maxDashes} dash values.`); continue; }
    if (v[4] === 0) { err(n, 'Line spacing (delta-y) is zero.'); continue; }
    if (cur.lines.length >= L.maxLinesPerPattern) { if (!cur.over) err(n, `Pattern ${cur.name} has more than ${L.maxLinesPerPattern} lines; the rest are ignored.`); cur.over = true; continue; }
    cur.lines.push({ angle: v[0], base: [v[1], v[2]], delta: [v[3], v[4]], dashes: v.slice(5) });
  }
  close();
  return { patterns, errors };
}
