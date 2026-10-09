// MTEXT in-place rich editor: a contenteditable box over the MTEXT at the current zoom, with a toolbar strip above it
// (font, height, bold/italic/underline/overline, colour, stack, symbols, justification, width factor, oblique,
// paragraph alignment), and the MT tool (two corners).
//   Enter = new paragraph, Ctrl+Enter or a click outside = commit (one undo step), Esc = cancel.
// The DOM mirrors the parseMText model: one <div> per paragraph, one <span data-p> per run. Unknown codes, stacks and
// non-breaking spaces (\~) are non-editable spans written back verbatim. A toolbar action reads the DOM into the model
// with the selection as cell positions (mtext-dom.js), applies a src/core/mtext.js helper, re-renders and puts the
// selection back. An empty selection applies to the whole text.
import { parseMText, serializeMText, DEFAULT_PROPS, formatMText, toggleMText, listMText, insertMText, stackMText, unstackMText } from '../src/core/mtext.js';
import { aciToRgb } from '../src/core/aci.js';
import { makeMText } from '../src/core/model.js';
import { addEntities, setText } from '../src/core/edit.js';
import { ACI_CHOICES } from './ui.js';
import { readEditor, pointAt } from './mtext-dom.js';

const ALIGN_CSS = ['left', 'center', 'right'];
const FONTS = ['Arial', 'Arial Narrow', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'];
const SYMBOLS = [['°', 'Degree'], ['±', 'Plus / minus'], ['Ø', 'Diameter'], ['≈', 'Almost equal'], ['∠', 'Angle'], ['℄', 'Centre line'], ['Δ', 'Delta'], ['≠', 'Not equal'], ['Ω', 'Ohm'], ['²', 'Squared'], ['³', 'Cubed'], ['\u00A0', 'Non-breaking space']];
const ATTACH = ['Top left', 'Top centre', 'Top right', 'Middle left', 'Middle centre', 'Middle right', 'Bottom left', 'Bottom centre', 'Bottom right'];
const cssColor = (c) => (!c || c.aci === 7 || c.aci === 256 ? '' : `rgb(${(c.rgb ?? aciToRgb(c.aci)).join(',')})`);
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
  s.display = p.wf !== 1 || p.oblique ? 'inline-block' : '';
  s.transform = p.wf !== 1 || p.oblique ? `scaleX(${p.wf}) skewX(${-p.oblique}deg)` : '';
  s.transformOrigin = 'left';
}

class MTextEditor {
  /** ent: the MTEXT being edited, or null for a new one placed at opts {p, width, height} */
  constructor(app, ent, opts) {
    this.app = app; this.ent = ent;
    this.height = ent ? ent.height : opts.height;
    this.zoom = app.vp.view.zoom;
    this.base = { ...DEFAULT_PROPS, h: this.height };
    const p = ent ? ent.p : opts.p, width = ent ? ent.width : opts.width;
    this.attach = ent ? ent.attach || 1 : 1;
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
    Object.assign(this.box.style, { position: 'fixed', left: `${rect.left + s.x}px`, top: `${rect.top + s.y}px`, zIndex: 50 });
    this.place();

    this.render(parseMText(this.original, { height: this.height }));
    document.body.append(this.box);
    this.onKey = (e) => this.key(e);
    this.root.addEventListener('keydown', this.onKey);
    this.toolbar.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); this.close(); } });
    this.onSel = () => { const sel = getSelection(); if (sel.rangeCount && this.root.contains(sel.getRangeAt(0).commonAncestorContainer)) this.saved = sel.getRangeAt(0).cloneRange(); };
    document.addEventListener('selectionchange', this.onSel);
    this.onDown = (e) => { if (!this.box.contains(e.target)) this.commit(); };
    setTimeout(() => document.addEventListener('mousedown', this.onDown, true));
    this.root.focus();
    const r = document.createRange(); r.selectNodeContents(this.root); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  }

  /** the box sits on the insertion point according to the attachment point */
  place() {
    const col = (this.attach - 1) % 3, row = Math.floor((this.attach - 1) / 3);
    this.box.style.transform = `translate(${-50 * col}%, ${-50 * row}%)`;
  }

  buildToolbar() {
    const tag = (n, cmd, title) => { n.dataset.cmd = cmd; n.title = title; n.setAttribute('aria-label', title); return n; };
    const btn = (cmd, label, title, fn) => {
      const b = tag(h('button', { type: 'button', textContent: label }), cmd, title);
      b.addEventListener('mousedown', (e) => e.preventDefault());   // keep the text selection
      b.addEventListener('click', fn);
      return b;
    };
    const num = (cmd, title, value, min, fn) => {
      const n = tag(h('input', { type: 'number', min, step: 'any', value: String(value) }), cmd, title);
      n.addEventListener('change', () => { const v = +n.value; if (n.value !== '' && Number.isFinite(v) && v >= +min) fn(v); });
      return n;
    };
    const pick = (cmd, title, options, fn) => {
      const s = tag(h('select', {}, ...options.map(([v, t]) => h('option', { value: String(v), textContent: t }))), cmd, title);
      s.addEventListener('change', () => fn(s.value, s));
      return s;
    };
    const styleFonts = [...(this.app.doc?.textStyles?.values() ?? [])].map((st) => String(st.font ?? '').replace(/\.(ttf|otf)$/i, '')).filter(Boolean);
    const fonts = [...new Set([...FONTS, ...styleFonts])];
    const fmt = (patch) => this.act((m, a, b) => formatMText(m, a, b, patch));
    const bar = h('div', { className: 'mt-toolbar', role: 'toolbar', ariaLabel: 'Text formatting' },
      pick('font', 'Font of the selected text', [['', 'Font'], ...fonts.map((f) => [f, f])], (v, s) => { if (v) fmt({ font: v }); s.value = ''; }),
      num('height', 'Height of the selected text', this.height, '0', (v) => v > 0 && fmt({ h: v })),
      btn('bold', 'B', 'Bold (Ctrl+B)', () => this.toggle('bold')),
      btn('italic', 'I', 'Italic (Ctrl+I)', () => this.toggle('italic')),
      btn('underline', 'U', 'Underline (Ctrl+U)', () => this.toggle('u')),
      btn('overline', 'O', 'Overline', () => this.toggle('o')),
      pick('color', 'Colour of the selected text', [['', 'Colour'], ...ACI_CHOICES], (v, s) => { if (v) fmt({ color: { aci: +v } }); s.value = ''; }),
      btn('stack', 'a/b', 'Stack the selected "a/b", "a#b" or "a^b"', () => this.act((m, a, b) => stackMText(m, a, b))),
      btn('unstack', 'a b', 'Unstack', () => this.act((m, a, b) => unstackMText(m, a, b))),
      btn('bullets', '•≡', 'Bulleted list (selected paragraphs, all when nothing is selected)', () => this.act((m, a, b) => listMText(m, a, b, 'bullet'))),
      btn('numbering', '1.', 'Numbered list (selected paragraphs, all when nothing is selected)', () => this.act((m, a, b) => listMText(m, a, b, 'number'))),
      pick('symbol', 'Insert a symbol', [['', 'Symbol'], ...SYMBOLS.map(([c, n]) => [c, c === '\u00A0' ? n : `${c}  ${n}`])], (v, s) => { if (v) this.act((m, a, b) => insertMText(m, a, b, v)); s.value = ''; }),
      pick('attach', 'Justification (attachment point)', ATTACH.map((t, i) => [i + 1, t]), (v) => { this.attach = +v; this.place(); this.root.focus(); }),
      num('wf', 'Width factor of the selected text', 1, '0.01', (v) => fmt({ wf: v })),
      num('oblique', 'Oblique angle of the selected text (degrees)', 0, '-85', (v) => v <= 85 && fmt({ oblique: v })),
      btn('left', '⇤', 'Align paragraph left', () => this.align(0)),
      btn('center', '≡', 'Centre paragraph', () => this.align(1)),
      btn('right', '⇥', 'Align paragraph right', () => this.align(2)),
      btn('ok', 'OK', 'Commit (Ctrl+Enter)', () => this.commit()));
    bar.querySelector('[data-cmd="attach"]').value = String(this.attach);
    return bar;
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
          if (r.raw != null) { s.dataset.raw = r.raw; s.textContent = r.raw; s.title = 'Formatting code kept as is'; s.className = 'mt-raw'; } else { s.dataset.stack = JSON.stringify(r); s.textContent = `${r.stack.a}/${r.stack.b}`; styleRun(s, r.props, this.zoom); }
        } else {
          s.dataset.p = JSON.stringify(r.props); styleRun(s, r.props, this.zoom);
          // a real non-breaking space (\~) is its own non-editable span: the browser's own U+00A0 in typed text is a space
          r.text.split('\u00A0').forEach((t, i) => { if (i) s.append(this.nbsp()); if (t) s.append(t); });
        }
        div.append(s);
      }
      if (!div.childNodes.length) div.append(h('br'));
      this.root.append(div);
    }
  }

  nbsp() { const n = h('span', { contentEditable: 'false', className: 'mt-nbsp', title: 'Non-breaking space', textContent: '\u00A0' }); n.dataset.nbsp = ''; return n; }
  model() { return readEditor(this.root, this.base); }
  setAlign(div, a) { if (a == null) return; div.dataset.align = String(a); div.style.textAlign = ALIGN_CSS[a]; }

  // ---- formatting -----------------------------------------------------------------------------------
  range() {
    const sel = getSelection();
    if (sel.rangeCount && this.root.contains(sel.getRangeAt(0).commonAncestorContainer)) return sel.getRangeAt(0);
    if (this.saved) { sel.removeAllRanges(); sel.addRange(this.saved); return this.saved; }
    return null;
  }
  /** read the DOM with the selection as cell positions, apply fn(model, a, b) -> { model, a, b } | null, re-render, reselect */
  act(fn) {
    const r = this.range();
    const pts = r ? [{ node: r.startContainer, offset: r.startOffset }, { node: r.endContainer, offset: r.endOffset }] : [];
    const { paras, at } = readEditor(this.root, this.base, pts);
    const [a, b] = r ? at : [0, 0];
    const res = fn({ paras, baseH: this.height }, a, b);
    if (!res) return;
    this.render(res.model);
    this.select(res.a, res.b);
  }
  select(a, b) {
    this.root.focus();
    const s = pointAt(this.root, a), e = pointAt(this.root, b);
    const r = document.createRange();
    r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    this.saved = r.cloneRange();
  }
  toggle(k) { this.act((m, a, b) => toggleMText(m, a, b, k)); }
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
      const patch = {};
      if (text !== this.original) patch.text = text;
      if (this.attach !== (this.ent.attach || 1)) patch.attach = this.attach;
      if (Object.keys(patch).length) setText(app.session, this.ent.id, patch);
    } else if (text.replace(/\\P/g, '').trim()) {
      app.defaults.textHeight = this.height;
      addEntities(app.session, [makeMText(this.newAt.p, this.height, text, { ...app.newProps(), width: this.newAt.width, attach: this.attach })]);
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
