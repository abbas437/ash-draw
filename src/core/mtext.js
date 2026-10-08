// MTEXT inline formatting: parser, serialiser and layout (pure, no DOM).
//   parseMText(raw, { height = 1 })  -> { paras: [{ align, runs: [Run] }] }
//     Run = { text, props } | { stack: { a, b, type }, props } | { raw }   (raw = unknown code kept verbatim)
//     props = { font, bold, italic, u, o, k, color: null | { aci } | { rgb: [r,g,b] }, h, oblique, wf, track, valign }
//   mtextPlain(raw)                   -> displayed string (paragraphs joined with '\n', stacks as a/b)
//   serializeMText(model, { height }) -> raw MTEXT codes for the model
//   layoutMText(model, { width, attach, lineSpacing, measure }) -> { lines, glyphs, rules, width, height }
//     a run whose props.stroke is set is an SHX stroke-font run (render.js): cap-height first baseline, glyphs / rules flagged stroke
// Reference: AutoCAD MTEXT format codes. \H<n>x; is relative to the CURRENT height; \c<n>; is BGR (0xBBGGRR).

const SPECIAL = { c: 'Ø', d: '°', p: '±' };
export const DEFAULT_PROPS = { font: null, bold: false, italic: false, u: false, o: false, k: false, color: null, h: 1, oblique: 0, wf: 1, track: 1, valign: 0 };

const num = (s, d) => { const v = parseFloat(s); return Number.isFinite(v) ? v : d; };

export function parseMText(raw, { height = 1 } = {}) {
  const s = String(raw ?? '');
  const paras = [];
  let para = { align: null, runs: [] };
  paras.push(para);
  let props = { ...DEFAULT_PROPS, h: height };
  const stackOf = [];
  let buf = '';
  const flush = () => { if (buf) { para.runs.push({ text: buf, props: { ...props } }); buf = ''; } };
  const set = (k, v) => { flush(); props = { ...props, [k]: v }; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '%' && s[i + 1] === '%') {
      const k = (s[i + 2] ?? '').toLowerCase();
      if (SPECIAL[k]) { buf += SPECIAL[k]; i += 3; continue; }
      if (k === 'u') { set('u', !props.u); i += 3; continue; }
      if (k === 'o') { set('o', !props.o); i += 3; continue; }
      if (/^\d{3}$/.test(s.slice(i + 2, i + 5))) { buf += String.fromCharCode(Number(s.slice(i + 2, i + 5))); i += 5; continue; }
    }
    if (c === '{') { flush(); stackOf.push(props); i++; continue; }
    if (c === '}') { flush(); if (stackOf.length) props = stackOf.pop(); i++; continue; }
    if (c !== '\\') { buf += c; i++; continue; }
    const n = s[i + 1] ?? '';
    const semi = s.indexOf(';', i + 2);
    const arg = semi < 0 ? s.slice(i + 2) : s.slice(i + 2, semi);
    const next = semi < 0 ? s.length : semi + 1;
    switch (n) {
      case '\\': case '{': case '}': buf += n; i += 2; continue;
      case 'P': flush(); para = { align: para.align, runs: [] }; paras.push(para); i += 2; continue;
      case '~': buf += '\u00A0'; i += 2; continue;
      case 'L': case 'l': set('u', n === 'L'); i += 2; continue;
      case 'O': case 'o': set('o', n === 'O'); i += 2; continue;
      case 'K': case 'k': set('k', n === 'K'); i += 2; continue;
      case 'U':
        if (/^\+[0-9A-Fa-f]{4}$/.test(s.slice(i + 2, i + 7))) { buf += String.fromCharCode(parseInt(s.slice(i + 3, i + 7), 16)); i += 7; continue; }
        break;
      case 'C': { const v = Math.trunc(num(arg, 256)); set('color', v === 0 || v === 256 ? null : { aci: v }); i = next; continue; }
      case 'c': { const v = Math.trunc(num(arg, 0)) & 0xffffff; set('color', { rgb: [v & 255, (v >> 8) & 255, (v >> 16) & 255] }); i = next; continue; }
      case 'H': { const rel = /x$/i.test(arg); const v = num(rel ? arg.slice(0, -1) : arg, 1); set('h', rel ? props.h * v : v); i = next; continue; }
      case 'F': case 'f': {
        const [name, ...flags] = arg.split('|');
        flush();
        props = { ...props, font: name || null, bold: flags.includes('b1'), italic: flags.includes('i1') };
        i = next; continue;
      }
      case 'Q': set('oblique', num(arg, 0)); i = next; continue;
      case 'W': set('wf', num(arg, 1)); i = next; continue;
      case 'T': set('track', num(arg, 1)); i = next; continue;
      case 'A': set('valign', Math.max(0, Math.min(2, Math.trunc(num(arg, 0))))); i = next; continue;
      case 'p': {
        const q = /q([lrcjd])/.exec(arg);
        if (q) { para.align = { l: 0, c: 1, r: 2, j: 0, d: 0 }[q[1]]; if (!para.runs.length && !buf) { i = next; continue; } }
        flush(); para.runs.push({ raw: s.slice(i, next) }); i = next; continue;
      }
      case 'S': {
        if (semi < 0) break;
        const m = /^(.*?)([/#^])(.*)$/s.exec(arg);
        if (!m) break;
        flush();
        const unesc = (t) => t.replace(/\\(.)/g, '$1');
        para.runs.push({ stack: { a: unesc(m[1]), b: unesc(m[3].replace(/^ /, m[2] === '^' ? '' : ' ')), type: m[2] }, props: { ...props } });
        i = next; continue;
      }
      default: break;
    }
    // unknown code: keep it verbatim (to its ';' when it takes an argument, else the 2 characters)
    flush();
    const len = /[A-Za-z]/.test(n) && semi >= 0 && !/[\\{}]/.test(arg) ? next - i : 2;
    para.runs.push({ raw: s.slice(i, i + len) });
    i += len;
  }
  flush();
  return { paras };
}

const stackText = (st) => `${st.a}/${st.b}`;
export function mtextPlain(raw) {
  return parseMText(raw).paras.map((p) => p.runs.map((r) => (r.stack ? stackText(r.stack) : r.text ?? '')).join('')).join('\n');
}

// ---------------------------------------------------------------------------------------------
// serialiser: each run whose properties differ from the base is written as one {…} group.
const escText = (t) => t.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/\u00A0/g, '\\~');   // only a real non-breaking space
const fmtNum = (v) => String(+v.toFixed(6));
function codesFor(p, base) {
  let out = '';
  if (p.font !== base.font || p.bold !== base.bold || p.italic !== base.italic) out += `\\f${p.font ?? 'Arial'}|b${p.bold ? 1 : 0}|i${p.italic ? 1 : 0};`;
  if (JSON.stringify(p.color) !== JSON.stringify(base.color)) {
    if (!p.color) out += '\\C256;';
    else if (p.color.aci != null) out += `\\C${p.color.aci};`;
    else { const [r, g, b] = p.color.rgb; out += `\\c${r | (g << 8) | (b << 16)};`; }
  }
  if (Math.abs(p.h - base.h) > 1e-9) out += `\\H${fmtNum(p.h)};`;
  if (p.oblique !== base.oblique) out += `\\Q${fmtNum(p.oblique)};`;
  if (p.wf !== base.wf) out += `\\W${fmtNum(p.wf)};`;
  if (p.track !== base.track) out += `\\T${fmtNum(p.track)};`;
  if (p.valign !== base.valign) out += `\\A${p.valign};`;
  if (p.u) out += '\\L';
  if (p.o) out += '\\O';
  if (p.k) out += '\\K';
  return out;
}
const ALIGN = ['l', 'c', 'r'];
export function serializeMText(model, { height = 1 } = {}) {
  const base = { ...DEFAULT_PROPS, h: height };
  return model.paras.map((para, pi) => {
    let out = para.align != null && (pi === 0 || model.paras[pi - 1].align !== para.align) ? `\\pxq${ALIGN[para.align]};` : '';
    for (const r of para.runs) {
      if (r.raw != null) { out += r.raw; continue; }
      const body = r.stack ? `\\S${r.stack.a.replace(/[\\;/#^]/g, (c) => `\\${c}`)}${r.stack.type}${r.stack.type === '^' ? ' ' : ''}${r.stack.b.replace(/[\\;]/g, (c) => `\\${c}`)};` : escText(r.text);
      const codes = codesFor(r.props, base);
      out += codes ? `{${codes}${body}}` : body;
    }
    return out;
  }).join('\\P');
}

// ---------------------------------------------------------------------------------------------
// layout. measure(text, props) -> advance width in drawing units at height props.h (before wf / tracking).
const INDENT = /^\\pxi(-?[\d.]+)(?:,l(-?[\d.]+))?/;
/** the paragraph's \pxi first-line / left indent from its raw code run ({ i: 0, l: 0 } when none) */
function paraIndent(para) {
  for (const r of para.runs) {
    if (r.raw == null) break;
    const m = INDENT.exec(r.raw);
    if (m) return { i: num(m[1], 0), l: num(m[2], 0) };
  }
  return { i: 0, l: 0 };
}
export const approxMeasure = (t, p) => [...t].length * p.h * (p.bold ? 0.66 : 0.6);
const STACK_H = 0.7;

export function layoutMText(model, { width = 0, attach = 1, lineSpacing = 1, measure = approxMeasure } = {}) {
  const adv = (t, p) => measure(t, p) * p.wf * p.track;
  const lines = [];
  for (const para of model.paras) {
    // paragraph indent \pxi<first>,l<left>: first line at left + first, the others at left (drawing units)
    const ind = paraIndent(para), first0 = lines.length;
    const indOf = () => (lines.length === first0 ? ind.l + ind.i : ind.l);
    const mk = () => ({ parts: [], w: 0, align: para.align, ind: indOf() });
    // pieces: words (one or more runs without a breaking space), spaces and stacks
    const units = [];
    let word = null;
    const endWord = () => { if (word) { units.push(word); word = null; } };
    for (const r of para.runs) {
      if (r.raw != null) continue;
      if (r.stack) {
        const sp = { ...r.props, h: r.props.h * STACK_H };
        const wa = adv(r.stack.a, sp), wb = adv(r.stack.b, sp);
        const w = r.stack.type === '#' ? wa + wb + adv('/', sp) : Math.max(wa, wb);
        (word ??= { parts: [], w: 0 }).parts.push({ stack: r.stack, props: r.props, sp, wa, wb, w }); word.w += w;
        continue;
      }
      for (const t of r.text.split(/( +)/)) {
        if (!t) continue;
        if (t[0] === ' ') { endWord(); units.push({ space: true, parts: [{ text: t, props: r.props, w: adv(t, r.props) }], w: adv(t, r.props) }); continue; }
        const w = adv(t, r.props);
        (word ??= { parts: [], w: 0 }).parts.push({ text: t, props: r.props, w }); word.w += w;
      }
    }
    endWord();
    let cur = mk();
    const trimEnd = (l) => { while (l.parts.length && l.parts.at(-1).text?.trim() === '') l.w -= l.parts.pop().w; };
    for (const u of units) {
      if (width > 0 && !u.space && cur.parts.length && cur.w + u.w > width - cur.ind + 1e-9) {
        trimEnd(cur); lines.push(cur); cur = mk();
      }
      if (u.space && !cur.parts.length && lines.length && lines.at(-1).align === para.align && lines.at(-1).wrapped) continue;
      cur.parts.push(...u.parts); cur.w += u.w;
      if (width > 0 && !u.space && cur.w > width - cur.ind) cur.wrapped = true;
    }
    trimEnd(cur);
    cur.h = Math.max(0, ...para.runs.filter((r) => r.props).map((r) => r.props.h)) || model.baseH || 1;
    lines.push(cur);
  }
  // per line height from its own parts
  for (const l of lines) if (l.parts.length) l.h = Math.max(...l.parts.map((p) => p.props.h));
  const boxW = width > 0 ? width : Math.max(0, ...lines.map((l) => l.w + l.ind));
  const col = (attach - 1) % 3, row = Math.floor((attach - 1) / 3);
  const x0 = col === 0 ? 0 : col === 1 ? -boxW / 2 : -boxW;
  let y = 0;
  // first baseline: 0.9 h below the top for canvas fonts, the cap height for stroke (SHX, props.stroke) runs
  const ascent = (l) => Math.max(0, ...l.parts.map((p) => (p.props.stroke ? 1 : 0.9) * p.props.h)) || 0.9 * l.h;
  lines.forEach((l, i) => { y += i === 0 ? ascent(l) : 1.25 * l.h * lineSpacing; l.y = y; });
  const total = lines.length ? lines.at(-1).y + 0.25 * lines.at(-1).h : 0;
  const dy = row === 0 ? 0 : row === 1 ? -total / 2 : -total;
  const glyphs = [], rules = [];
  for (const l of lines) {
    l.y += dy;
    const a = l.align ?? col;
    let x = x0 + l.ind + (a === 1 ? (boxW - l.ind - l.w) / 2 : a === 2 ? boxW - l.ind - l.w : 0);
    l.x = x;
    for (const p of l.parts) {
      const pr = p.props;
      const shift = pr.valign === 1 ? -(l.h - pr.h) * 0.45 : pr.valign === 2 ? -(l.h - pr.h) * 0.9 : 0;
      const by = l.y + shift;
      const g = { font: pr.font, bold: pr.bold, italic: pr.italic, color: pr.color, oblique: pr.oblique, wf: pr.wf, track: pr.track, stroke: !!pr.stroke };
      if (p.stack) {
        const st = p.stack, sp = p.sp, w = p.w;
        if (st.type === '#') {
          glyphs.push({ ...g, text: st.a, x, y: by - pr.h * 0.45, h: sp.h });
          glyphs.push({ ...g, text: '/', x: x + p.wa, y: by, h: sp.h });
          glyphs.push({ ...g, text: st.b, x: x + w - p.wb, y: by, h: sp.h });
        } else {
          glyphs.push({ ...g, text: st.a, x: x + (w - p.wa) / 2, y: by - pr.h * 0.55, h: sp.h });
          glyphs.push({ ...g, text: st.b, x: x + (w - p.wb) / 2, y: by + pr.h * 0.15, h: sp.h });
          if (st.type === '/') rules.push({ x1: x, x2: x + w, y: by - pr.h * 0.4, h: pr.h, color: pr.color, stroke: !!pr.stroke });
        }
      } else if (p.text) {
        glyphs.push({ ...g, text: p.text, x, y: by, h: pr.h, w: p.w });
      }
      if (pr.u) rules.push({ x1: x, x2: x + p.w, y: by + pr.h * 0.15, h: pr.h, color: pr.color, stroke: !!pr.stroke });
      if (pr.o) rules.push({ x1: x, x2: x + p.w, y: by - pr.h * 1.0, h: pr.h, color: pr.color, stroke: !!pr.stroke });
      if (pr.k) rules.push({ x1: x, x2: x + p.w, y: by - pr.h * 0.3, h: pr.h, color: pr.color, stroke: !!pr.stroke });
      x += p.w;
    }
  }
  return { lines, glyphs, rules, width: boxW, height: total, x0, y0: dy };
}

// ---------------------------------------------------------------------------------------------
// editing helpers (pure). Positions count cells: one per text character (UTF-16 unit), one per stack or raw run,
// one per paragraph break. An empty range (a === b) means the whole text. Each returns { model, a, b }.
const sameProps = (p, q) => JSON.stringify(p) === JSON.stringify(q);
function cellsOf(model) {
  const cells = [];
  model.paras.forEach((para, pi) => {
    if (pi) cells.push({ br: true, align: para.align });
    for (const r of para.runs) {
      if (r.text != null) for (const ch of r.text.split('')) cells.push({ ch, props: r.props });
      else cells.push(r);
    }
  });
  return cells;
}
function modelOf(cells, align) {
  const paras = [{ align, runs: [] }];
  for (const c of cells) {
    const runs = paras.at(-1).runs, last = runs.at(-1);
    if (c.br) paras.push({ align: c.align, runs: [] });
    else if (c.ch == null) runs.push(c);
    else if (last?.text != null && sameProps(last.props, c.props)) last.text += c.ch;
    else runs.push({ text: c.ch, props: c.props });
  }
  return { paras };
}
const span = (cells, a, b) => (a === b ? [0, cells.length] : [Math.min(a, b), Math.max(a, b)]);

/** apply a props patch (object, or function of the run's props) to the text and stacks in [a, b) */
export function formatMText(model, a, b, patch) {
  const cells = cellsOf(model);
  [a, b] = span(cells, a, b);
  const up = (p) => ({ ...p, ...(typeof patch === 'function' ? patch(p) : patch) });
  const out = cells.map((c, i) => (i < a || i >= b || !c.props ? c : c.ch != null ? { ch: c.ch, props: up(c.props) } : { ...c, props: up(c.props) }));
  return { model: modelOf(out, model.paras[0]?.align ?? null), a, b };
}
/** toggle a boolean property (bold, italic, u, o) from the state of the first character in [a, b) */
export function toggleMText(model, a, b, key) {
  const cells = cellsOf(model), [i, j] = span(cells, a, b);
  const first = cells.slice(i, j).find((c) => c.props);
  return formatMText(model, a, b, { [key]: !(first && first.props[key]) });
}
/** replace [a, b) (a === b: insert at a) with plain text in the properties of the character before a */
export function insertMText(model, a, b, text) {
  const cells = cellsOf(model);
  const [i, j] = [Math.min(a, b), Math.max(a, b)];
  const near = cells.slice(0, i).reverse().find((c) => c.br || c.props) ?? cells[i];
  const props = near?.props ?? { ...DEFAULT_PROPS, h: model.baseH ?? 1 };
  cells.splice(i, j - i, ...String(text).split('').map((ch) => ({ ch, props })));
  const end = i + String(text).length;
  return { model: modelOf(cells, model.paras[0]?.align ?? null), a: end, b: end };
}
/** turn the selected text "a/b", "a#b" or "a^b" into one stack; null when the selection is not stackable */
export function stackMText(model, a, b) {
  const cells = cellsOf(model), [i, j] = [Math.min(a, b), Math.max(a, b)];
  const sel = cells.slice(i, j);
  if (!sel.length || sel.some((c) => c.ch == null)) return null;
  const m = /^(.*?)([/#^])(.*)$/s.exec(sel.map((c) => c.ch).join(''));
  if (!m) return null;
  cells.splice(i, j - i, { stack: { a: m[1], b: m[3], type: m[2] }, props: sel[0].props });
  return { model: modelOf(cells, model.paras[0]?.align ?? null), a: i, b: i + 1 };
}
/** turn the stacks in [a, b) back into text "a/b" (also "#", "^") */
export function unstackMText(model, a, b) {
  const cells = cellsOf(model);
  [a, b] = span(cells, a, b);
  const out = [];
  let end = b;
  cells.forEach((c, k) => {
    if (k < a || k >= b || !c.stack) { out.push(c); return; }
    const t = `${c.stack.a}${c.stack.type}${c.stack.b}`;
    for (const ch of t.split('')) out.push({ ch, props: c.props });
    end += t.length - 1;
  });
  return { model: modelOf(out, model.paras[0]?.align ?? null), a, b: end };
}

// ---- bulleted / numbered lists. A list paragraph starts with the raw code run LIST_CODE and then the text "• " or "1. "
// (the DXF writer turns tabs into spaces and the reader does not decode ^I, so no tab is used).
export const LIST_CODE = '\\pxi-3,l3,t3;';
const LIST_RAW = /^\\pxi-?[\d.]+,l[\d.]+,t[\d.]+;$/;
const MARK = /^(?:• |\d+\. )/;
function paraRanges(cells) {
  const out = [];
  let start = 0;
  cells.forEach((c, k) => { if (c.br) { out.push({ start, end: k }); start = k + 1; } });
  out.push({ start, end: cells.length });
  return out;
}
/** the list marker of the paragraph in cells [start, end): { kind: 'bullet' | 'number', len } or null (len counts cells incl. the code run) */
function listOf(cells, { start, end }) {
  if (end - start < 3 || !cells[start].raw || !LIST_RAW.test(cells[start].raw)) return null;
  const txt = cells.slice(start + 1, Math.min(end, start + 12)).map((c) => c.ch ?? '\u0000').join('');
  const m = MARK.exec(txt);
  return m ? { kind: m[0] === '• ' ? 'bullet' : 'number', len: 1 + m[0].length } : null;
}
/** toggle a bulleted (kind 'bullet') or numbered ('number') list on the paragraphs touched by [a, b] (all when a === b).
 *  Already that kind on all of them: removes it. Numbered paragraphs are renumbered 1., 2., 3. in each consecutive run. */
export function listMText(model, a, b, kind) {
  let cells = cellsOf(model);
  const all = a === b, lo = Math.min(a, b), hi = Math.max(a, b);
  const sel = (r) => all || (r.start <= hi && r.end >= lo && !(r.start === hi && hi > lo));
  const ranges = paraRanges(cells), chosen = ranges.filter(sel);
  const remove = chosen.every((r) => listOf(cells, r)?.kind === kind);
  const shifts = [];   // [cell position, delta]
  const out = [];
  ranges.forEach((r, pi) => {
    if (pi) out.push(cells[r.start - 1]);
    let body = cells.slice(r.start, r.end);
    if (sel(r)) {
      const cur = listOf(cells, r);
      if (cur) { body = body.slice(cur.len); shifts.push([r.start, -cur.len]); }
      if (!remove) {
        const props = (body.find((c) => c.props) ?? cells.slice(r.start, r.end).find((c) => c.props))?.props ?? { ...DEFAULT_PROPS, h: model.baseH ?? 1 };
        const pre = [{ raw: LIST_CODE }, ...(kind === 'bullet' ? '• ' : '1. ').split('').map((ch) => ({ ch, props }))];
        body = [...pre, ...body]; shifts.push([r.start, pre.length]);
      }
    }
    out.push(...body);
  });
  // renumber every consecutive run of numbered paragraphs
  const rr = paraRanges(out);
  let n = 0;
  for (const r of rr) {
    const cur = listOf(out, r);
    if (cur?.kind !== 'number') { n = 0; continue; }
    const digits = out.slice(r.start + 1, r.start + cur.len - 2).length;
    const props = out[r.start + 1].props;
    out.splice(r.start + 1, digits + 2, ...`${++n}. `.split('').map((ch) => ({ ch, props })));
    const d = `${n}. `.length - (digits + 2);
    if (d) for (let k = rr.indexOf(r) + 1; k < rr.length; k++) { rr[k].start += d; rr[k].end += d; }
    r.end += d;
  }
  const map = (x) => { let y = x; for (const [at, d] of shifts) if (x > at) y += Math.max(d, at - x); return Math.max(0, y); };
  const m = modelOf(out, model.paras[0]?.align ?? null);
  // a first paragraph keeps its alignment; the others come from their break cells
  return { model: m, a: all ? 0 : map(lo), b: all ? out.length : map(hi) };
}
