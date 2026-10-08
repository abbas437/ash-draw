// MTEXT inline formatting: parser, serialiser and layout (pure, no DOM).
//   parseMText(raw, { height = 1 })  -> { paras: [{ align, runs: [Run] }] }
//     Run = { text, props } | { stack: { a, b, type }, props } | { raw }   (raw = unknown code kept verbatim)
//     props = { font, bold, italic, u, o, k, color: null | { aci } | { rgb: [r,g,b] }, h, oblique, wf, track, valign }
//   mtextPlain(raw)                   -> displayed string (paragraphs joined with '\n', stacks as a/b)
//   serializeMText(model, { height }) -> raw MTEXT codes for the model
//   layoutMText(model, { width, attach, lineSpacing, measure }) -> { lines, glyphs, rules, width, height }
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
      case '~': buf += ' '; i += 2; continue;
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
const escText = (t) => t.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/ /g, '\\~');
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
export const approxMeasure = (t, p) => [...t].length * p.h * (p.bold ? 0.66 : 0.6);
const STACK_H = 0.7;

export function layoutMText(model, { width = 0, attach = 1, lineSpacing = 1, measure = approxMeasure } = {}) {
  const adv = (t, p) => measure(t, p) * p.wf * p.track;
  const lines = [];
  for (const para of model.paras) {
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
    let cur = { parts: [], w: 0, align: para.align };
    const trimEnd = (l) => { while (l.parts.length && l.parts.at(-1).text?.trim() === '') l.w -= l.parts.pop().w; };
    for (const u of units) {
      if (width > 0 && !u.space && cur.parts.length && cur.w + u.w > width + 1e-9) {
        trimEnd(cur); lines.push(cur); cur = { parts: [], w: 0, align: para.align };
      }
      if (u.space && !cur.parts.length && lines.length && lines.at(-1).align === para.align && lines.at(-1).wrapped) continue;
      cur.parts.push(...u.parts); cur.w += u.w;
      if (width > 0 && !u.space && cur.w > width) cur.wrapped = true;
    }
    trimEnd(cur);
    cur.h = Math.max(0, ...para.runs.filter((r) => r.props).map((r) => r.props.h)) || model.baseH || 1;
    lines.push(cur);
  }
  // per line height from its own parts
  for (const l of lines) if (l.parts.length) l.h = Math.max(...l.parts.map((p) => p.props.h));
  const boxW = width > 0 ? width : Math.max(0, ...lines.map((l) => l.w));
  const col = (attach - 1) % 3, row = Math.floor((attach - 1) / 3);
  const x0 = col === 0 ? 0 : col === 1 ? -boxW / 2 : -boxW;
  let y = 0;
  lines.forEach((l, i) => { y += i === 0 ? 0.9 * l.h : 1.25 * l.h * lineSpacing; l.y = y; });
  const total = lines.length ? lines.at(-1).y + 0.25 * lines.at(-1).h : 0;
  const dy = row === 0 ? 0 : row === 1 ? -total / 2 : -total;
  const glyphs = [], rules = [];
  for (const l of lines) {
    l.y += dy;
    const a = l.align ?? col;
    let x = x0 + (a === 1 ? (boxW - l.w) / 2 : a === 2 ? boxW - l.w : 0);
    l.x = x;
    for (const p of l.parts) {
      const pr = p.props;
      const shift = pr.valign === 1 ? -(l.h - pr.h) * 0.45 : pr.valign === 2 ? -(l.h - pr.h) * 0.9 : 0;
      const by = l.y + shift;
      const g = { font: pr.font, bold: pr.bold, italic: pr.italic, color: pr.color, oblique: pr.oblique, wf: pr.wf, track: pr.track };
      if (p.stack) {
        const st = p.stack, sp = p.sp, w = p.w;
        if (st.type === '#') {
          glyphs.push({ ...g, text: st.a, x, y: by - pr.h * 0.45, h: sp.h });
          glyphs.push({ ...g, text: '/', x: x + p.wa, y: by, h: sp.h });
          glyphs.push({ ...g, text: st.b, x: x + w - p.wb, y: by, h: sp.h });
        } else {
          glyphs.push({ ...g, text: st.a, x: x + (w - p.wa) / 2, y: by - pr.h * 0.55, h: sp.h });
          glyphs.push({ ...g, text: st.b, x: x + (w - p.wb) / 2, y: by + pr.h * 0.15, h: sp.h });
          if (st.type === '/') rules.push({ x1: x, x2: x + w, y: by - pr.h * 0.4, h: pr.h, color: pr.color });
        }
      } else if (p.text) {
        glyphs.push({ ...g, text: p.text, x, y: by, h: pr.h, w: p.w });
      }
      if (pr.u) rules.push({ x1: x, x2: x + p.w, y: by + pr.h * 0.15, h: pr.h, color: pr.color });
      if (pr.o) rules.push({ x1: x, x2: x + p.w, y: by - pr.h * 1.0, h: pr.h, color: pr.color });
      if (pr.k) rules.push({ x1: x, x2: x + p.w, y: by - pr.h * 0.3, h: pr.h, color: pr.color });
      x += p.w;
    }
  }
  return { lines, glyphs, rules, width: boxW, height: total, x0, y0: dy };
}
