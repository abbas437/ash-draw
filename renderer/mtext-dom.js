// MTEXT editor DOM <-> model, and DOM points <-> cell positions (as counted by the src/core/mtext.js helpers: one per
// text character, one per stack, raw code run and non-breaking space span, one per paragraph break).
// Uses only nodeType, data, tagName, childNodes, parentNode and getAttribute, so it runs on any DOM-like tree.
//   readEditor(root, base, points) -> { paras, at }   at[i] = cell position of points[i] ({ node, offset }) or null
//   pointAt(root, pos)             -> { node, offset } for a cell position in a tree written by the editor's render()
const attr = (n, k) => (n.nodeType === 1 ? n.getAttribute(k) : null);
const isAtom = (n) => n.nodeType === 1 && (attr(n, 'data-raw') != null || attr(n, 'data-stack') != null || attr(n, 'data-nbsp') != null);
const isPara = (n) => n.nodeType === 1 && (n.tagName === 'DIV' || n.tagName === 'P');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (n, anc) => { for (; n; n = n.parentNode) if (n === anc) return true; return false; };

/** properties of the text inside `node`: those of the innermost run span (data-p), else `base` */
export function propsAt(root, base, node) {
  for (let n = node.nodeType === 1 ? node : node.parentNode; n && n !== root; n = n.parentNode) {
    const p = attr(n, 'data-p');
    if (p) return JSON.parse(p);
  }
  return base;
}
const alignOf = (div, d) => { const a = attr(div, 'data-align'); return a != null && a !== '' ? +a : d; };

export function readEditor(root, base, points = []) {
  const paras = [];
  const at = points.map(() => null);
  let para = null, pos = 0;
  const resolve = (test, p) => points.forEach((q, i) => { if (at[i] == null && test(q)) at[i] = p; });
  const newPara = (align) => { if (paras.length) pos++; para = { align, runs: [] }; paras.push(para); };
  const addText = (t, props) => {
    const last = para.runs.at(-1);
    if (last && last.text != null && same(last.props, props)) last.text += t; else para.runs.push({ text: t, props });
    pos += t.length;
  };
  const visit = (c) => {
    if (c.nodeType === 3) {
      points.forEach((q, i) => { if (q.node === c) at[i] = pos + c.data.slice(0, q.offset).replace(/[\r\n]/g, '').length; });
      // the browser types U+00A0 for runs of spaces: plain text spaces. A real \~ is a data-nbsp span (below).
      const t = c.data.replace(/\u00A0/g, ' ').replace(/[\r\n]/g, '');
      if (t) addText(t, propsAt(root, base, c));
      return;
    }
    if (c.nodeType !== 1) return;
    if (isAtom(c)) {
      resolve((q) => q.node !== c && within(q.node, c), pos);
      if (attr(c, 'data-raw') != null) { para.runs.push({ raw: attr(c, 'data-raw') }); pos++; } else if (attr(c, 'data-stack') != null) { para.runs.push(JSON.parse(attr(c, 'data-stack'))); pos++; } else addText('\u00A0', propsAt(root, base, c));
      return;
    }
    if (c.tagName === 'BR') { if (c.nextSibling) newPara(para.align); return; }
    if (isPara(c)) newPara(alignOf(c, para?.align ?? null));
    kids(c);
  };
  const kids = (c) => {
    [...c.childNodes].forEach((k, i) => { resolve((q) => q.node === c && q.offset === i, pos); visit(k); });
    resolve((q) => q.node === c && q.offset >= c.childNodes.length, pos);
  };
  let stray = false;
  [...root.childNodes].forEach((c, i) => {
    resolve((q) => q.node === root && q.offset === i, pos);
    if (isPara(c)) { newPara(alignOf(c, null)); stray = false; kids(c); } else { if (!stray) { newPara(null); stray = true; } visit(c); }
  });
  if (!paras.length) newPara(null);
  resolve(() => true, pos);   // a point outside the editor, or at its very end
  return { paras, at };
}

export function pointAt(root, pos) {
  let n = 0;
  const go = (c) => {
    const ks = [...c.childNodes];
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      if (k.nodeType === 3) { const l = k.data.length; if (pos <= n + l) return { node: k, offset: pos - n }; n += l; continue; }
      if (k.nodeType !== 1 || k.tagName === 'BR') continue;
      if (isAtom(k)) { if (pos === n) return { node: c, offset: i }; n++; continue; }
      const r = go(k);
      if (r) return r;
    }
    return null;
  };
  const divs = [...root.childNodes].filter(isPara);
  for (let pi = 0; pi < divs.length; pi++) {
    if (pi) n++;
    const d = divs[pi];
    const r = go(d);
    if (r) return r;
    if (pos <= n || pi === divs.length - 1) return { node: d, offset: [...d.childNodes].filter((k) => k.tagName !== 'BR').length };
  }
  return { node: root, offset: root.childNodes.length };
}
