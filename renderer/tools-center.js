// ASH Draw Studio - DIMCENTER, CENTERMARK and CENTERLINE: the UI over src/core/center.js. tools.js passes the Tool base
// class in (no import cycle). The marks are plain LINEs (not associative: they do not follow the circle when it is
// edited). Each run is one undo step: the marks picked so far are previewed and added together when the command ends.
import { addEntities } from '../src/core/edit.js';
import { getEntity, makeLine } from '../src/core/model.js';
import { resolveDimStyle } from '../src/core/dimsStyle.js';
import { dimCenOf, dimCenterSegs, centerlineSeg } from '../src/core/center.js';
import { dimVarsOf } from './tools-dims.js';

const ROUND = new Set(['CIRCLE', 'ARC']);

export function createCenterTools(h, { Tool }) {
  const dimcen = () => dimCenOf(resolveDimStyle(h.doc, dimVarsOf(h.doc).style));

  class MarkTool extends Tool {
    /** ext: true = CENTERMARK (extension lines always on), false = DIMCENTER (DIMCEN decides) */
    constructor(host, ext) { super(host); this.ext = ext; this.name = ext ? 'CENTERMARK' : 'DIMCENTER'; }
    activate() { super.activate(); this.segs = []; this.vp.setSelection([]); }
    get prompt() { return `${this.name}  select arc or circle${this.segs.length ? ' (Enter = done)' : ''}`; }
    click(p, ev) {
      const hit = this.vp.pick(ev?.raw ?? p);
      if (!hit) return;
      if (!ROUND.has(hit.type)) { this.h.toast(`${this.name}: select an arc or a circle.`); return; }
      const d = dimcen();
      if (d === 0) { this.h.toast(`${this.name}: DIMCEN is 0 in the current dimension style; no center mark.`); return; }
      this.segs.push(...dimCenterSegs(getEntity(this.h.doc, hit.id), this.ext ? -Math.abs(d) : d));
      this.h.refreshPrompt(); this.vp.requestRender();
    }
    finish() {
      const segs = this.segs; this.segs = [];
      if (segs.length) addEntities(this.h.session, segs.map(([a, b]) => makeLine(a, b, this.props())), this.ext ? 'Center Mark' : 'Dim Center');
      this.cancel();
    }
    key(e) { if (e.key === 'Enter' || e.key === 'Escape') { this.finish(); return true; } return false; }
    draw(c) {
      if (!this.segs.length) return;
      c.save(); c.strokeStyle = this.vp.inkColor; c.lineWidth = 1;
      for (const [a, b] of this.segs) this.line(c, a, b);
      c.restore();
    }
  }

  class CenterlineTool extends Tool {
    constructor(host) { super(host); this.name = 'CENTERLINE'; }
    activate() { super.activate(); this.first = null; this.vp.setSelection([]); }
    get prompt() { return `CENTERLINE  select ${this.first ? 'second' : 'first'} line`; }
    click(p, ev) {
      const hit = this.vp.pick(ev?.raw ?? p);
      if (!hit) return;
      if (hit.type !== 'LINE') { this.h.toast('CENTERLINE: select a line.'); return; }
      if (!this.first) { this.first = hit.id; this.vp.setSelection([hit.id]); this.h.refreshPrompt(); return; }
      if (hit.id === this.first) return;
      const doc = this.h.doc;
      let seg;
      try { seg = centerlineSeg(getEntity(doc, this.first), getEntity(doc, hit.id), Math.abs(dimcen()) || 2.5); } catch (err) {
        if (!err.code) throw err;
        this.h.toast(`CENTERLINE: ${err.message}.`); return;
      }
      const lt = [...doc.linetypes.keys()].find((k) => k.toUpperCase() === 'CENTER');
      if (!lt) this.h.toast('CENTERLINE: the CENTER linetype is not loaded; drawn with the current linetype.');
      addEntities(this.h.session, [makeLine(seg[0], seg[1], { ...this.props(), ...(lt ? { linetype: lt } : {}) })], 'Centerline');
      this.vp.setSelection([]); this.cancel();
    }
    key(e) { if (e.key === 'Enter' || e.key === 'Escape') { this.vp.setSelection([]); this.cancel(); return true; } return false; }
  }

  return { dimcenter: new MarkTool(h, false), centermark: new MarkTool(h, true), centerline: new CenterlineTool(h) };
}
