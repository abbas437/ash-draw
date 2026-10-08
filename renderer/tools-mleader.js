// ASH Draw Studio - MLEADER tool: arrowhead point, landing point, then the text (via the shared text dialog).
// tools.js owns the Tool base class and passes it to createMLeaderTools (a factory, so this module does not import tools.js back).
import { makeMLeader, mleaderParts } from '../src/core/mleader.js';
import { tessellate, dist } from '../src/core/geom.js';

export function createMLeaderTools(h, { Tool }) {
  class MLeaderTool extends Tool {
    activate() { super.activate(); this.tip = null; this.landing = null; this.busy = false; }
    get prompt() { return !this.tip ? 'MLEADER  arrowhead location' : !this.landing ? 'MLEADER  landing location' : 'MLEADER  enter the text'; }
    height() { const v = this.vp.view; return this.h.defaults.textHeight ?? +(v.height / v.zoom / 50).toPrecision(2); }
    build(landing, text) {
      const th = this.height();
      return makeMLeader(this.tip, landing, text, { ...this.props(), textHeight: th, arrowSize: th, landingGap: th * 0.4, doglegLen: th });
    }
    async click(p) {
      if (this.busy) return;
      if (!this.tip) { this.tip = p; this.vp.lastPoint = p; return; }
      if (dist(this.tip, p) < 1e-9) return;
      this.landing = p; this.busy = true; this.vp.lastPoint = null;
      try {
        const r = await this.h.askText({ title: 'Multileader text', value: '', height: this.height() });
        if (r && r.text.trim()) {
          this.h.defaults.textHeight = r.height;
          this.add(this.build(p, r.text.replace(/\r/g, '').split('\n').join('\\P')));
        }
      } finally { this.busy = false; }
      this.h.setTool('select');
    }
    key(e) { if (e.key === 'Escape' || e.key === 'Enter') { this.cancel(); return true; } return false; }
    draw(c) {
      if (!this.tip || this.busy) return;
      const to = this.landing ?? this.vp.cursor;
      if (dist(this.tip, to) < 1e-9) return;
      c.strokeStyle = this.vp.inkColor; c.setLineDash([4, 3]); c.lineWidth = 1;
      for (const sub of mleaderParts(this.build(to, ''))) for (const pl of tessellate(sub, this.vp.doc, this.vp.tolWorld / 4)) this.poly(c, pl);
    }
  }
  return { mleader: new MLeaderTool(h) };
}
