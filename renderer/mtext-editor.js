// MTEXT in-place rich editor: a contenteditable box over the MTEXT at the current zoom, with a small toolbar
// (bold, italic, underline, height, colour, paragraph alignment), and the MT tool (two corners).
//   Enter = new paragraph, Ctrl+Enter or a click outside = commit (one undo step), Esc = cancel.
// The DOM mirrors the parseMText model: one <div> per paragraph, one <span data-p> per run; formatting applied in
// the editor wraps the selection in <span data-set> patches (newest wins). Unknown codes and stacks are kept as
// non-editable spans and written back verbatim.
import { parseMText, serializeMText, DEFAULT_PROPS } from '../src/core/mtext.js';
import { aciToRgb } from '../src/core/aci.js';
import { makeMText } from '../src/core/model.js';
import { addEntities, setText } from '../src/core/edit.js';

const ACI = [[1, 'Red'], [2, 'Yellow'], [3, 'Green'], [4, 'Cyan'], [5, 'Blue'], [6, 'Magenta'], [7, 'White / black']];
const ALIGN_CSS = ['left', 'center', 'right'];
const cssColor = (c) => (!c || c.aci === 7 ? '' : `rgb(${(c.rgb ?? aciToRgb(c.aci)).join(',')})`);
const h = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, attrs); n.append(...kids); return n; };

let current = null;   // the open editor

function styleRun(el, p, zoom) {
  const s = el.style;
  s.fontWeight = p.bold ? 'bold' : 'normal';
  s.fontStyle = p.italic ? 'italic' : 'normal';
  s.textDecoration = [p.u && 'underline', p.o && 'overline', p.k && 'line-through'].filter(Boolean).join(' ') || 'none';
  s.fontSize = `${Math.max(4, p.h * zoom)}px`;
  s.color = cssColor(p.color);
  s.fontFamily = p.font ? `"${p.font}", Arial, sans-serif` : '';
}

class MTextEditor {
  /** ent: the MTEXT being edited, or null for a new one placed at opts {p, width, height} */
  constructor(app, ent, opts) {
    this.app = app; this.ent = ent;
    this.height = ent ? ent.height : opts.height;
    this.zoom = app.vp.view.zoom;
    this.base = { ...DEFAULT_PROPS, h: this.height };
    this.seq = 0;
    const p = ent ? ent.p : opts.p, width = ent ? ent.width : opts.width, attach = ent ? ent.attach || 1 : 1;
    this.newAt = ent ? null : { p, width };
    this.original = ent ? ent.text : '';

    this.root = h('div', { contentEditable: 'true', className: 'mt-edit', spellcheck: false });
    Object.assign(this.root.style, {
      minWidth: '60px', minHeight: `${this.height * this.zoom}px`, width: width > 0 ? `${width * this.zoom}px` : '',
      whiteSpace: 'pre-wrap', outline: '1px dashed #3b82f6', background: 'rgba(255,255,255,0.92)', color: '#000',
      fontFamily: 'Arial, sans-serif', fontSize: `${this.height * this.zoom}px`, lineHeight: '1.25', padding: '1px 2px',
    });
    this.toolbar = this.buildToolbar();
    this.box = h('div', { className: 'mt-editor' }, this.toolbar, this.root);
    const rect = app.vp.canvas.getBoundingClientRect(), s = app.vp.toScreen(p);
    const col = (attach - 1) % 3, row = Math.floor((attach - 1) / 3);
    Object.assign(this.box.style, {
      position: 'fixed', left: `${rect.left + s.x}px`, top: `${rect.top + s.y}px`, zIndex: 50,
      transform: `translate(${-50 * col}%, ${-50 * row}%)`,
    });
    this.toolbar.style.cssText = 'position:absolute;bottom:100%;left:0;display:flex;gap:2px;white-space:nowrap;background:#f3f4f6;border:1px solid #9ca3af;padding:2px;font:12px "Segoe UI",sans-serif;color:#111';

    this.render(parseMText(this.original, { height: this.height }));
    document.body.append(this.box);
    this.onKey = (e) => this.key(e);
    this.root.addEventListener('keydown', this.onKey);
    this.onSel = () => { const sel = getSelection(); if (sel.rangeCount && this.root.contains(sel.getRangeAt(0).commonAncestorContainer)) this.saved = sel.getRangeAt(0).cloneRange(); };
    document.addEventListener('selectionchange', this.onSel);
    this.onDown = (e) => { if (!this.box.contains(e.target)) this.commit(); };
    setTimeout(() => document.addEventListener('mousedown', this.onDown, true));
    this.root.focus();
    const r = document.createRange(); r.selectNodeContents(this.root); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  }

  buildToolbar() {
    const btn = (cmd, label, title, fn) => {
      const b = h('button', { type: 'button', textContent: label, title });
      b.dataset.cmd = cmd;
      b.style.cssText = 'min-width:22px;padding:0 4px';
      b.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
      return b;
    };
    const height = h('input', { type: 'number', min: '0', step: 'any', value: String(this.height), title: 'Height of the selected text' });
    height.dataset.cmd = 'height'; height.style.width = '64px';
    height.addEventListener('change', () => { const v = +height.value; if (v > 0) this.apply(() => ({ h: v })); });
    const color = h('select', { title: 'Colour of the selected text' },
      h('option', { value: '', textContent: 'ByLayer' }), ...ACI.map(([i, n]) => h('option', { value: String(i), textContent: `${i} ${n}` })));
    color.dataset.cmd = 'color';
    color.addEventListener('change', () => { const v = color.value; this.apply(() => ({ color: v ? { aci: +v } : null })); });
    const rgb = h('input', { type: 'color', title: 'True colour of the selected text' });
    rgb.dataset.cmd = 'rgb'; rgb.style.width = '28px';
    rgb.addEventListener('change', () => { const n = parseInt(rgb.value.slice(1), 16); this.apply(() => ({ color: { rgb: [n >> 16, (n >> 8) & 255, n & 255] } })); });
    return h('div', { className: 'mt-toolbar' },
      btn('bold', 'B', 'Bold (Ctrl+B)', () => this.toggle('bold')),
      btn('italic', 'I', 'Italic (Ctrl+I)', () => this.toggle('italic')),
      btn('underline', 'U', 'Underline (Ctrl+U)', () => this.toggle('u')),
      height, color, rgb,
      btn('left', '⇤', 'Align left', () => this.align(0)),
      btn('center', '≡', 'Centre', () => this.align(1)),
      btn('right', '⇥', 'Align right', () => this.align(2)),
      btn('ok', 'OK', 'Commit (Ctrl+Enter)', () => this.commit()));
  }

  // ---- model <-> DOM --------------------------------------------------------------------------------
  render(model) {
    this.root.textContent = '';
    for (const para of model.paras) {
      const div = h('div');
      this.setAlign(div, para.align);
      for (const r of para.runs) {
        const s = h('span');
        if (r.raw != null || r.stack) {
          // kept verbatim, not editable here
          s.contentEditable = 'false';
          if (r.raw != null) { s.dataset.raw = r.raw; s.textContent = r.raw; s.title = 'Formatting code kept as is'; s.style.cssText = 'font-size:70%;color:#6b7280;background:#e5e7eb'; } else { s.dataset.stack = JSON.stringify(r); s.textContent = `${r.stack.a}/${r.stack.b}`; styleRun(s, r.props, this.zoom); }
        } else { s.dataset.p = JSON.stringify(r.props); styleRun(s, r.props, this.zoom); s.textContent = r.text; }
        div.append(s);
      }
      if (!div.childNodes.length) div.append(h('br'));
      this.root.append(div);
    }
  }

  /** properties of the text inside `node`: the innermost data-p run, then the data-set patches oldest first */
  propsAt(node) {
    let base = this.base;
    const sets = [];
    for (let n = node.nodeType === 1 ? node : node.parentNode; n && n !== this.root; n = n.parentNode) {
      if (n.dataset?.p && base === this.base) base = JSON.parse(n.dataset.p);
      if (n.dataset?.set) sets.push(JSON.parse(n.dataset.set));
    }
    sets.sort((a, b) => a.seq - b.seq);
    let p = { ...base };
    for (const { seq, ...patch } of sets) p = { ...p, ...patch };
    return p;
  }

  model() {
    const paras = [];
    let para = null;
    const newPara = (align) => { para = { align, runs: [] }; paras.push(para); };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const visit = (c) => {
      if (c.nodeType === 3) {
        const t = c.data.replace(/ /g, ' ').replace(/[\r\n]/g, '');
        if (!t) return;
        const props = this.propsAt(c), last = para.runs.at(-1);
        if (last && last.text != null && same(last.props, props)) last.text += t; else para.runs.push({ text: t, props });
        return;
      }
      if (c.nodeType !== 1) return;
      if (c.dataset.raw != null) { para.runs.push({ raw: c.dataset.raw }); return; }
      if (c.dataset.stack) { para.runs.push(JSON.parse(c.dataset.stack)); return; }
      if (c.tagName === 'BR') { if (c.nextSibling) newPara(para.align); return; }
      if (c.tagName === 'DIV' || c.tagName === 'P') newPara(this.alignOf(c, para?.align ?? null));
      for (const k of c.childNodes) visit(k);
    };
    let stray = false;
    for (const c of this.root.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'DIV' || c.tagName === 'P')) { newPara(this.alignOf(c, null)); stray = false; for (const k of c.childNodes) visit(k); } else { if (!stray) { newPara(null); stray = true; } visit(c); }
    }
    if (!paras.length) newPara(null);
    return { paras };
  }

  alignOf(div, d) { return div.dataset.align != null && div.dataset.align !== '' ? +div.dataset.align : d; }
  setAlign(div, a) { if (a == null) return; div.dataset.align = String(a); div.style.textAlign = ALIGN_CSS[a]; }

  // ---- formatting -----------------------------------------------------------------------------------
  range() {
    const sel = getSelection();
    if (sel.rangeCount && this.root.contains(sel.getRangeAt(0).commonAncestorContainer)) return sel.getRangeAt(0);
    if (this.saved) { sel.removeAllRanges(); sel.addRange(this.saved); return this.saved; }
    return null;
  }
  firstText(r) {
    if (r.startContainer.nodeType === 3) return r.startContainer;
    const w = document.createTreeWalker(r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (r.intersectsNode(n) && n.data) return n;
    return null;
  }
  toggle(k) {
    const r = this.range();
    if (!r || r.collapsed) return;
    const t = this.firstText(r);
    const on = t ? !!this.propsAt(t)[k] : false;
    this.apply(() => ({ [k]: !on }));
  }
  /** wrap the selection (split per paragraph) in a <span data-set> carrying patch() */
  apply(patch) {
    const r = this.range();
    if (!r || r.collapsed) return;
    const divs = [...this.root.children].filter((d) => r.intersectsNode(d));
    const made = [];
    for (const d of divs.length ? divs : [this.root]) {
      const sub = document.createRange();
      sub.selectNodeContents(d);
      if (r.compareBoundaryPoints(Range.START_TO_START, sub) > 0) sub.setStart(r.startContainer, r.startOffset);
      if (r.compareBoundaryPoints(Range.END_TO_END, sub) < 0) sub.setEnd(r.endContainer, r.endOffset);
      if (sub.collapsed) continue;
      const span = h('span');
      span.dataset.set = JSON.stringify({ ...patch(), seq: ++this.seq });
      span.append(sub.extractContents());
      sub.insertNode(span);
      made.push(span);
    }
    for (const el of this.root.querySelectorAll('span[data-p], span[data-set]')) styleRun(el, this.propsAt(el), this.zoom);
    if (!made.length) return;
    const nr = document.createRange(); nr.setStartBefore(made[0]); nr.setEndAfter(made.at(-1));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(nr);
    this.saved = nr.cloneRange();
  }
  align(a) {
    const r = this.range();
    if (!r) return;
    const divs = [...this.root.children].filter((d) => r.intersectsNode(d));
    for (const d of divs) this.setAlign(d, a);
  }

  key(e) {
    e.stopPropagation();   // the drawing's shortcuts do not apply while typing here
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Enter' && ctrl) { e.preventDefault(); this.commit(); return; }
    const k = e.key.toLowerCase();
    if (ctrl && (k === 'b' || k === 'i' || k === 'u')) { e.preventDefault(); this.toggle({ b: 'bold', i: 'italic', u: 'u' }[k]); }
  }

  commit() {
    if (current !== this) return;
    const text = serializeMText(this.model(), { height: this.height });
    this.close();
    const { app } = this;
    if (this.ent) {
      if (text !== this.original) setText(app.session, this.ent.id, { text });
    } else if (text.replace(/\\P/g, '').trim()) {
      app.defaults.textHeight = this.height;
      addEntities(app.session, [makeMText(this.newAt.p, this.height, text, { ...app.newProps(), width: this.newAt.width, attach: 1 })]);
    }
  }
  close() {
    if (current !== this) return;
    current = null;
    document.removeEventListener('mousedown', this.onDown, true);
    document.removeEventListener('selectionchange', this.onSel);
    this.box.remove();
    this.app.vp.canvas.focus?.();
  }
}

/** open the editor on an MTEXT entity, or for a new one ({p, width, height}) */
export function openMTextEditor(app, ent, opts = {}) {
  current?.commit();
  current = new MTextEditor(app, ent, opts);
  return current;
}

/** MT tool (two corners) and double-click editing of MTEXT */
export function createMTextTools(h, { Tool }) {
  if (!h.vp.canvas.dataset.mtextDbl) {
    h.vp.canvas.dataset.mtextDbl = '1';
    h.vp.canvas.addEventListener('dblclick', (ev) => {
      if (current || h.toolId !== 'select') return;
      const r = h.vp.canvas.getBoundingClientRect();
      const e = h.vp.pick(h.vp.toWorld(ev.clientX - r.left, ev.clientY - r.top));
      if (e?.type === 'MTEXT') { ev.preventDefault(); openMTextEditor(h, e); }
    });
  }
  class MTextTool extends Tool {
    activate() { super.activate(); this.a = null; }
    get prompt() { return this.a ? 'MTEXT  opposite corner' : 'MTEXT  first corner'; }
    click(p) {
      if (!this.a) { this.a = p; this.vp.lastPoint = p; return; }
      const a = this.a;
      this.a = null; this.vp.lastPoint = null;
      const v = this.vp.view, height = this.h.defaults.textHeight ?? +(v.height / v.zoom / 50).toPrecision(2);
      this.h.setTool('select');
      openMTextEditor(this.h, null, { p: { x: Math.min(a.x, p.x), y: Math.max(a.y, p.y) }, width: Math.abs(p.x - a.x), height });
    }
    key(e) { if (e.key === 'Escape') { if (this.a) { this.a = null; this.vp.lastPoint = null; } else this.cancel(); return true; } return false; }
    draw(c) {
      if (!this.a) return;
      const q = this.vp.cursor;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]);
      this.poly(c, [this.a, { x: q.x, y: this.a.y }, q, { x: this.a.x, y: q.y }], true);
    }
  }
  return { mtext: new MTextTool(h) };
}
