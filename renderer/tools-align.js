// ASH Draw Studio - ALIGN tool (AutoCAD LT ALIGN, 2D): the UI over src/core/align.js.
// tools.js passes the Tool / ModifyTool base classes in (no import cycle). The whole ALIGN is one transformEntities
// call, so one undo step.
import { transformEntities } from '../src/core/edit.js';
import { alignTransform } from '../src/core/align.js';

const PROMPTS = {
  s1: 'specify first source point', d1: 'specify first destination point',
  s2: 'specify second source point (Enter = move only)', d2: 'specify second destination point',
  scale: 'Scale objects based on alignment points? [Yes/No] <N>',
};

export function createAlignTools(h, { ModifyTool }) {
  class AlignTool extends ModifyTool {
    constructor(host) { super(host); this.name = 'ALIGN'; }
    begin() { this.pts = []; }
    reset() { this.pts = []; this.vp.lastPoint = null; }
    get state() { return ['s1', 'd1', 's2', 'd2', 'scale'][this.pts.length]; }
    get prompt() { return this.phase === 'select' ? this.selPrompt : `ALIGN  ${PROMPTS[this.state]}`; }
    click(p) {
      if (this.phase !== 'go' || this.state === 'scale') return;
      this.pts.push(p); this.vp.lastPoint = p;
    }
    text(s) {
      if (this.phase !== 'go' || this.state !== 'scale') return false;
      const v = String(s).trim().toLowerCase();
      if (v === 'y' || v === 'yes') { this.apply(true); return true; }
      if (v === 'n' || v === 'no') { this.apply(false); return true; }
      return false;
    }
    key(e) {
      if (e.key === 'Enter' && this.phase === 'go') {
        if (this.state === 's2') this.apply(false);
        else if (this.state === 'scale') this.apply(false);
        else if (this.state === 's1') this.cancel();
        return true;
      }
      return super.key(e);
    }
    apply(scale) {
      const [s1, d1, s2, d2] = this.pts;
      let m;
      try { m = alignTransform(s1, d1, s2, d2, scale); } catch (err) { h.toast(err.message); this.done(); return; }
      this.report(transformEntities(h.session, this.ids, m, { label: 'Align' }), 'Align');
      this.done();
    }
    draw(c) {
      if (this.phase !== 'go' || !this.pts.length) return;
      c.save(); c.strokeStyle = this.vp.inkColor; c.lineWidth = 1; c.setLineDash([6, 4]);
      const [s1, d1, s2, d2] = this.pts;
      this.line(c, s1, d1 ?? this.vp.cursor);
      if (s2) this.line(c, s2, d2 ?? this.vp.cursor);
      c.restore();
    }
  }
  return { align: new AlignTool(h) };
}
