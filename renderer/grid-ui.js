// ASH Draw Studio - drawing grid settings: the GRID command (On/Off/Spacing/Major/Style, as in AutoCAD LT), F7 and the
// GRID status bar button (app.js). Saved as settings 'grid.on', 'grid.spacing', 'grid.major', 'grid.style' and
// 'grid.paperSpacing' (layouts, paper millimetres). The grid itself is drawn by viewport.js (src/core/grid.js).
import { cleanSpacing, cleanMajor, cleanStyle } from '../src/core/grid.js';

const api = () => globalThis.window?.api ?? {}; // read when used: this module is also loaded by node tests (via tools.js)
const save = (k, v) => api().settingsSet?.(k, v)?.catch?.(() => {});

/** read the saved grid settings into vp.settings (start-up) */
export async function loadGridSettings(app) {
  const st = app.vp.settings, get = (k) => api().settingsGet?.(k)?.catch?.(() => undefined);
  const [on, spacing, major, style, paper] = await Promise.all(['grid.on', 'grid.spacing', 'grid.major', 'grid.style', 'grid.paperSpacing'].map(get));
  if (typeof on === 'boolean') st.grid = on;
  st.gridSpacing = cleanSpacing(spacing) ?? st.gridSpacing;
  st.gridMajor = cleanMajor(major) ?? st.gridMajor;
  st.gridStyle = cleanStyle(style) ?? st.gridStyle;
  st.gridPaperSpacing = cleanSpacing(paper) ?? st.gridPaperSpacing;
  app.refreshToggles(); app.vp.requestRender();
}

/** change grid settings ({ on, spacing, major, style }; spacing applies to the space shown), save them and redraw */
export function setGrid(app, { on, spacing, major, style }) {
  const st = app.vp.settings;
  if (on !== undefined) { st.grid = !!on; save('grid.on', st.grid); }
  if (spacing !== undefined) {
    if (app.vp.layout) { st.gridPaperSpacing = spacing; save('grid.paperSpacing', spacing); } else { st.gridSpacing = spacing; save('grid.spacing', spacing); }
  }
  if (major !== undefined) { st.gridMajor = major; save('grid.major', major); }
  if (style !== undefined) { st.gridStyle = style; save('grid.style', style); }
  app.refreshToggles(); app.vp.requestRender();
}

/** GRID [ON/OFF/Spacing/Major/Style] <spacing>: a number typed at the first prompt sets the spacing and turns it on */
export function createGridTools(h, { Tool }) {
  class GridTool extends Tool {
    activate() { super.activate(); this.ask = null; }
    get spacing() { const st = h.vp.settings; return h.vp.layout ? st.gridPaperSpacing : st.gridSpacing; }
    get prompt() {
      const st = h.vp.settings;
      if (this.ask === 'spacing') return `GRID  grid spacing${h.vp.layout ? ' on paper (mm)' : ''} <${this.spacing}>`;
      if (this.ask === 'major') return `GRID  grid lines per major line, 1 to 100 <${st.gridMajor}>`;
      if (this.ask === 'style') return `GRID  grid style [Lines/Dots] <${st.gridStyle === 'dots' ? 'Dots' : 'Lines'}>`;
      return `GRID  specify grid spacing or [ON/OFF/Spacing/Major/Style] <${this.spacing}> (grid is ${st.grid ? 'on' : 'off'})`;
    }
    finish(patch, msg) { this.cancel(); setGrid(h, patch); h.toast(msg, 2500); return true; }
    text(s) {
      const t = s.trim().toLowerCase();
      if (!t) return false;
      const num = /^[+]?\d*\.?\d+(e[-+]?\d+)?$/.test(t) ? Number(t) : NaN;
      if (this.ask === 'spacing') {
        if (!(num > 0) || !Number.isFinite(num)) { h.toast('GRID: the spacing must be a number greater than 0.'); return true; }
        return this.finish({ spacing: num, on: true }, `Grid spacing = ${num}${h.vp.layout ? ' mm' : ''}`);
      }
      if (this.ask === 'major') {
        if (cleanMajor(num) === null) { h.toast('GRID: requires a whole number from 1 to 100.'); return true; }
        return this.finish({ major: num, on: true }, `Major grid line every ${num} lines`);
      }
      if (this.ask === 'style') {
        const style = 'lines'.startsWith(t) ? 'lines' : 'dots'.startsWith(t) ? 'dots' : null;
        if (!style) { h.toast('GRID: type Lines or Dots.'); return true; }
        return this.finish({ style, on: true }, `Grid style = ${style}`);
      }
      if (t === 'on') return this.finish({ on: true }, 'Grid on');
      if (t === 'off') return this.finish({ on: false }, 'Grid off');
      if (num > 0 && Number.isFinite(num)) return this.finish({ spacing: num, on: true }, `Grid spacing = ${num}${h.vp.layout ? ' mm' : ''}`);
      // S = Spacing, St = Style, M = Major
      const opt = t === 's' ? 'spacing' : ['spacing', 'major', 'style'].find((o) => o.startsWith(t));
      if (opt) { this.ask = opt; return true; }
      h.toast('GRID: type a spacing, ON, OFF, Spacing, Major or Style.');
      return true;
    }
    key(e) { if (e.key === 'Enter') { this.cancel(); return true; } return super.key(e); } // Enter keeps <current>
  }
  return { grid: new GridTool(h) };
}
