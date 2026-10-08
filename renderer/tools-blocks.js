// ASH Draw Studio - BLOCK, ATTDEF, INSERT and EATTEDIT tools: the UI over src/core/blocks.js.
// Dialogs follow AutoCAD LT. tools.js owns the Tool / ModifyTool base classes and passes them to
// createBlockTools (a factory, so this module does not import tools.js back).
import {
  blockNameError, makeBlock, makeAttdef, insertableBlocks, attdefsOf, instantiate, withAttribValues, blockContentView,
  ATT_INVISIBLE, ATT_CONSTANT, ATT_VERIFY, ATT_PRESET,
} from '../src/core/blocks.js';
import { getEntity } from '../src/core/model.js';
import { tessellate, explode, boxOfPoints } from '../src/core/geom.js';
import { attachXref, uniqueXrefName } from '../src/core/xref.js';
import { pickXref } from './xref-panel.js';
import { el, modal } from './ui.js';

const num = (s) => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) && String(s).trim() !== '' ? v : null; };
const fmt = (v) => String(Math.round(v * 1e6) / 1e6);
const OKCANCEL = [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }];
const input = (name, value, attrs = {}) => el('input', { type: 'text', name, value: String(value), ...attrs });
const row = (label, ...kids) => el('label', { style: 'display:block;margin:4px 0' }, label, ' ', ...kids);

/** Attribute values dialog for the non-constant ATTDEFs `defs`; `current` = { TAG: value }. Resolves { TAG: value } or null. */
export async function attribValuesDialog(title, defs, current = {}) {
  const fields = defs.map((d) => [d, input(`att-${d.attdef.tag}`, current[d.attdef.tag] ?? d.attdef.default ?? '', { style: 'width:16em' })]);
  const body = el('div', {}, fields.map(([d, inp]) => row(d.attdef.prompt || d.attdef.tag, inp)));
  if ((await modal(title, body, OKCANCEL)) !== 'ok') return null;
  return Object.fromEntries(fields.map(([d, inp]) => [d.attdef.tag, inp.value]));
}

/** EATTEDIT on one INSERT: edit its attribute values as one undo step. Returns true when the dialog was shown. */
export async function editAttributes(h, ins) {
  if (ins?.type !== 'INSERT' || !ins.attribs?.length) return false;
  const defs = ins.attribs.map((a) => ({ attdef: { tag: a.attrib.tag, prompt: attdefsOf(h.doc.blocks.get(ins.block)).find((d) => d.attdef.tag === a.attrib.tag)?.attdef.prompt ?? '' } }));
  const values = await attribValuesDialog(`Edit attributes — ${ins.block}`, defs, Object.fromEntries(ins.attribs.map((a) => [a.attrib.tag, a.text])));
  const cur = values && getEntity(h.doc, ins.id);
  if (!cur) return true;
  const c = withAttribValues(cur, values);
  if (c.attribs.some((a, i) => a.text !== cur.attribs[i].text)) h.session.transact('Edit attributes', (tx) => { tx.replace(c); });
  return true;
}

/** Double-click on the canvas (select tool): an INSERT with attributes opens EATTEDIT. Returns true when handled. */
export function blockDoubleClick(h, ev) {
  const r = h.vp.canvas.getBoundingClientRect();
  const hit = h.vp.pick(h.vp.toWorld(ev.clientX - r.left, ev.clientY - r.top));
  if (hit?.type !== 'INSERT' || !hit.attribs?.length) return false;
  editAttributes(h, hit);
  return true;
}

/** Small preview of a block definition on a canvas. */
function drawThumb(cv, blk, doc, ink) {
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  if (!blk) return;
  const pls = [];
  for (const be of blk.entities) { const v = blockContentView(be.attdef ? { ...be, attdef: { ...be.attdef, flags: ATT_CONSTANT } } : be); if (v) try { pls.push(...tessellate(v, doc, 0)); } catch { /* skip */ } }
  const b = boxOfPoints(pls.flat());
  if (!b) return;
  const w = Math.max(b.maxx - b.minx, 1e-9), hgt = Math.max(b.maxy - b.miny, 1e-9);
  const k = Math.min((cv.width - 10) / w, (cv.height - 10) / hgt);
  const ox = (cv.width - w * k) / 2, oy = (cv.height - hgt * k) / 2;
  c.strokeStyle = ink; c.lineWidth = 1;
  for (const pl of pls) {
    c.beginPath();
    pl.forEach((q, i) => { const x = ox + (q.x - b.minx) * k, y = cv.height - (oy + (q.y - b.miny) * k); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.stroke();
  }
}

export function createBlockTools(h, { Tool, ModifyTool }) {
  // ---- BLOCK: name, base point, objects, retain / convert / delete ------------------------------
  class BlockTool extends ModifyTool {
    constructor(host) { super(host); this.name = 'BLOCK'; }
    activate() {
      Tool.prototype.activate.call(this);
      this.ids = [...this.vp.selection];
      this.st = { name: '', base: { x: 0, y: 0 }, mode: 'convert' };
      this.begin();
    }
    get prompt() { return this.phase === 'select' ? this.selPrompt : this.phase === 'base' ? 'BLOCK  specify base point' : 'BLOCK'; }
    reset() {}
    finishSelect() { this.ids = [...this.vp.selection]; this.begin(); }
    async begin() {
      this.phase = 'dialog'; this.h.refreshPrompt();
      const st = this.st;
      const name = input('name', st.name, { style: 'width:16em' });
      const bx = input('baseX', fmt(st.base.x), { style: 'width:7em' }), by = input('baseY', fmt(st.base.y), { style: 'width:7em' });
      const modes = [['retain', 'Retain'], ['convert', 'Convert to block'], ['delete', 'Delete']].map(([v, t]) =>
        el('label', { style: 'margin-right:10px' }, el('input', { type: 'radio', name: 'mode', value: v, checked: st.mode === v }), ` ${t}`));
      const body = el('div', {}, row('Name', name),
        el('fieldset', {}, el('legend', { text: 'Base point' }), row('X', bx), row('Y', by)),
        el('fieldset', {}, el('legend', { text: `Objects — ${this.ids.length} selected` }), el('div', {}, modes)));
      const r = await modal('Block definition', body, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Pick point', value: 'pick' }, { label: 'Select objects', value: 'select' }, { label: 'Cancel', value: null }]);
      st.name = name.value; st.base = { x: num(bx.value) ?? st.base.x, y: num(by.value) ?? st.base.y };
      st.mode = body.querySelector('input[name=mode]:checked')?.value ?? 'convert';
      if (r === 'pick') { this.phase = 'base'; this.h.refreshPrompt(); return; }
      if (r === 'select') { this.vp.setSelection(this.ids); this.phase = 'select'; this.h.refreshPrompt(); return; }
      if (r !== 'ok') { this.done(); return; }
      const err = blockNameError(this.h.doc, st.name);
      if (err || !this.ids.length) { this.h.toast(`BLOCK: ${err ?? 'Select objects for the block.'}`); this.begin(); return; }
      const ents = this.ids.map((id) => getEntity(this.h.doc, id)).filter(Boolean);
      const { block, insert } = makeBlock(this.h.doc, st.name, ents, st.base);
      Object.assign(insert, this.props());
      this.h.session.transact('Block', (tx) => {
        tx.block(block.name, block);
        if (st.mode !== 'retain') tx.remove(this.ids);
        if (st.mode === 'convert') tx.add(insert);
      });
      this.h.toast(`Block "${block.name}" defined (${ents.length} objects)`, 2000);
      this.done();
    }
    click(p) { if (this.phase === 'base') { this.st.base = { x: p.x, y: p.y }; this.begin(); } }
  }

  // ---- ATTDEF: tag, prompt, default, height, flags, then the position --------------------------
  class AttdefTool extends Tool {
    get prompt() { return this.def ? 'ATTDEF  specify start point' : 'ATTDEF'; }
    async activate() {
      super.activate();
      this.def = null;
      const v = this.vp.view;
      const tag = input('tag', '', { style: 'width:14em' }), prm = input('prompt', ''), dflt = input('default', '');
      const ht = input('height', this.h.defaults.textHeight ?? +(v.height / v.zoom / 50).toPrecision(2), { style: 'width:7em' });
      const flags = [[ATT_INVISIBLE, 'Invisible'], [ATT_CONSTANT, 'Constant'], [ATT_VERIFY, 'Verify'], [ATT_PRESET, 'Preset']]
        .map(([f, t]) => [f, el('input', { type: 'checkbox', name: t.toLowerCase() })]);
      const body = el('div', {}, row('Tag', tag), row('Prompt', prm), row('Default', dflt), row('Text height', ht),
        el('fieldset', {}, el('legend', { text: 'Mode' }), flags.map(([, cb], i) => el('label', { style: 'margin-right:10px' }, cb, ` ${['Invisible', 'Constant', 'Verify', 'Preset'][i]}`))));
      for (;;) {
        if ((await modal('Attribute definition', body, OKCANCEL)) !== 'ok') { this.cancel(); return; }
        const t = tag.value.trim();
        const err = !t ? 'Enter a tag.' : /\s/.test(t) ? 'Tags cannot contain spaces.' : !(num(ht.value) > 0) ? 'Enter a text height above 0.' : null;
        if (!err) break;
        this.h.toast(`ATTDEF: ${err}`);
      }
      this.def = { tag: tag.value.trim(), prompt: prm.value, default: dflt.value, height: num(ht.value), flags: flags.reduce((a, [f, cb]) => a | (cb.checked ? f : 0), 0) };
      this.h.defaults.textHeight = this.def.height;
      this.h.refreshPrompt();
    }
    click(p) {
      if (!this.def) return;
      const d = this.def;
      this.add(makeAttdef(p, d.height, d.tag, { ...this.props(), prompt: d.prompt, default: d.default, flags: d.flags }));
      this.def = null;
      this.h.setTool('select');
    }
  }

  // ---- INSERT: block, scale, rotation, explode; live preview at the cursor; attribute values -----
  const last = { name: '', sx: 1, sy: 1, rot: 0, uniform: true, explode: false };
  class InsertTool extends Tool {
    get prompt() { return this.o ? 'INSERT  specify insertion point' : 'INSERT'; }
    async activate() {
      super.activate();
      this.o = null; this.cur = null;
      const doc = this.h.doc, names = insertableBlocks(doc);
      if (!names.length) { this.h.toast('INSERT: this drawing has no blocks. Define one with BLOCK.'); this.cancel(); return; }
      const list = el('select', { name: 'block', size: Math.min(8, Math.max(2, names.length)), style: 'width:14em' }, names.map((n) => el('option', { value: n, text: n })));
      list.value = names.includes(last.name) ? last.name : names[0];
      const thumb = el('canvas', { width: 120, height: 120, class: 'block-thumb', style: 'border:1px solid #8884;margin-left:10px' });
      const show = () => drawThumb(thumb, doc.blocks.get(list.value), doc, getComputedStyle(document.body).color || '#000');
      list.onchange = show;
      const sx = input('sx', last.sx, { style: 'width:6em' }), sy = input('sy', last.sy, { style: 'width:6em' }), rot = input('rot', last.rot, { style: 'width:6em' });
      const uni = el('input', { type: 'checkbox', name: 'uniform', checked: last.uniform }), exp = el('input', { type: 'checkbox', name: 'explode', checked: last.explode });
      const sync = () => { sy.disabled = uni.checked; if (uni.checked) sy.value = sx.value; };
      uni.onchange = sync; sx.oninput = sync; sync();
      const body = el('div', {}, el('div', { style: 'display:flex;align-items:flex-start' }, list, thumb),
        row('Scale X', sx), row('Scale Y', sy), el('label', {}, uni, ' Uniform scale'), row('Rotation', rot), el('label', {}, exp, ' Explode'));
      show();
      for (;;) {
        if ((await modal('Insert', body, OKCANCEL)) !== 'ok') { this.cancel(); return; }
        if (num(sx.value) && num(sy.value) && num(rot.value) !== null) break;
        this.h.toast('INSERT: scale must be a non-zero number and rotation a number.');
      }
      Object.assign(last, { name: list.value, sx: num(sx.value), sy: uni.checked ? num(sx.value) : num(sy.value), rot: num(rot.value), uniform: uni.checked, explode: exp.checked });
      this.o = { ...last };
      this.h.refreshPrompt();
    }
    move(p) { if (this.o) { this.cur = p; this.vp.requestRender(); } }
    draw(c) {
      const blk = this.o && this.cur && this.h.doc.blocks.get(this.o.name);
      if (!blk) return;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); c.lineWidth = 1;
      let pls; try { pls = tessellate(instantiate(blk, this.cur, this.o), this.h.doc, this.vp.tolWorld / 4); } catch { return; }
      for (const pl of pls.slice(0, 2000)) this.poly(c, pl);
      c.setLineDash([]);
    }
    async click(p) {
      if (!this.o || this.busy) return;
      const o = this.o, doc = this.h.doc, blk = doc.blocks.get(o.name);
      const ask = attdefsOf(blk).filter((d) => !(d.attdef.flags & (ATT_CONSTANT | ATT_PRESET)));
      this.busy = true;
      const values = ask.length ? await attribValuesDialog(`Edit attributes — ${o.name}`, ask) : {};
      this.busy = false;
      if (!values) return; // back to picking the point
      const ins = instantiate(blk, p, { ...o, values, ...this.props() });
      this.h.session.transact('Insert', (tx) => {
        if (!o.explode) { tx.add(ins); return; }
        for (const part of explode(ins, doc)) {
          part.id = 0;
          if (part.layer === '0') part.layer = ins.layer;
          if (part.color === 0) part.color = ins.color;
          tx.add(part);
        }
      });
      this.o = null; this.cur = null;
      this.h.setTool('select');
    }
  }

  // ---- EATTEDIT: pick an INSERT with attributes ---------------------------------------------------
  class AttEditTool extends Tool {
    get prompt() { return 'EATTEDIT  select a block with attributes'; }
    activate() {
      super.activate();
      const sel = this.vp.selectedEntities();
      if (sel.length === 1 && sel[0].type === 'INSERT' && sel[0].attribs?.length) this.run(sel[0]);
    }
    async run(ins) { this.h.setTool('select'); await editAttributes(this.h, ins); }
    click(p, ev) {
      const hit = this.vp.pick(ev?.raw ?? p);
      if (hit?.type === 'INSERT' && hit.attribs?.length) this.run(hit);
      else this.h.toast('EATTEDIT: select a block that has attributes.');
    }
  }

  // ---- XATTACH: pick a DXF/DWG, then the point; one undo step adds the xref block (+ its layers/blocks) and the INSERT ----
  class XAttachTool extends Tool {
    get prompt() { return this.x ? `XATTACH  ${this.x.name}: specify insertion point` : 'XATTACH'; }
    async activate() {
      super.activate();
      this.cur = null;
      if (!this.x) {
        const x = await pickXref(this.h);
        if (!x) { this.cancel(); return; }
        this.x = x;
      }
      this.h.refreshPrompt();
    }
    deactivate() { this.x = null; super.deactivate(); }
    move(p) { if (this.x) { this.cur = p; this.vp.requestRender(); } }
    click(p) {
      const x = this.x;
      if (!x) return;
      const doc = this.h.doc;
      const name = uniqueXrefName(doc, x.file.name); // taken now, not when the file was picked
      this.h.session.transact('Attach xref', (tx) => {
        const blk = attachXref(tx, name, x.path, x.xdoc, x.file.path ?? null);
        tx.add(instantiate(blk, p, { sx: 1, sy: 1, rot: 0, ...this.props() }));
      });
      this.x = null;
      this.h.toast(`XATTACH: ${name} attached`);
      this.h.setTool('select');
    }
  }

  return { block: new BlockTool(h), attdef: new AttdefTool(h), insert: new InsertTool(h), eattedit: new AttEditTool(h), xattach: new XAttachTool(h) };
}
