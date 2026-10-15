// The right-hand side panel (Layers, Markups, Symbols, Properties): collapse to a thin strip, fold single sections, window title.
// State is saved like the other UI prefs: settings 'side.mode' (expanded / collapsed / hidden; older builds saved 'side.shown')
// and 'side.folded' (section keys). Collapsed is a 40 px icon rail: a rail button opens its section as a flyout over the canvas.
import { iconHtml } from './icons.js';

/** the foldable sections, by the data-sec of their .panel in index.html */
export const SIDE_SECTIONS = ['layers', 'markups', 'symbols', 'props'];
/** saved settings -> state; never-set values keep the panel shown and every section unfolded */
export const sideShownFrom = (saved) => saved !== false;
/** side panel modes, View > Side panel: Expanded / Collapsed (icon rail) / Hidden (no rail) */
export const SIDE_MODES = ['expanded', 'collapsed', 'hidden'];
/** saved 'side.mode' -> mode; never set: the older 'side.shown' (false was the thin strip, now the rail) */
export const sideModeFrom = (mode, shown) => (SIDE_MODES.includes(mode) ? mode : sideShownFrom(shown) ? 'expanded' : 'collapsed');
export const sideFoldedFrom = (saved) => (Array.isArray(saved) ? SIDE_SECTIONS.filter((k) => saved.includes(k)) : []);
/** "• plan.dxf — ASH Draw Studio 0.2.0-beta.22": the build version tells test builds apart; left out while unknown */
export const windowTitle = (name, dirty, version) => `${dirty ? '• ' : ''}${name} — ASH Draw Studio${version ? ` ${version}` : ''}`;

/** side panel width in px: default 340 shows a ~20 character layer name in full; user range 220 .. half the window; saved as setting 'side.width' */
export const SIDE_W_DEFAULT = 340, SIDE_W_MIN = 220;
export const sideWidthClamp = (w, winW = window.innerWidth) => Math.round(Math.max(SIDE_W_MIN, Math.min(Number(w), Math.max(SIDE_W_MIN, winW / 2))));
export const sideWidthFrom = (saved) => (Number.isFinite(Number(saved)) && saved !== null && saved !== '' && saved !== false ? sideWidthClamp(saved) : SIDE_W_DEFAULT);

const STRIP_TITLE = { shown: 'Collapse the side panel to icons (Ctrl+3)', hidden: 'Expand the side panel: Layers, Markups, Symbols, Properties (Ctrl+3)' };
/** rail buttons: section key, name, icon id (icons.js) */
const RAIL = [
  ['layers', 'Layers', 'layers'],
  ['markups', 'Markups', 'mkc'],
  ['symbols', 'Symbols', 'rail-symbols'],
  ['props', 'Properties', 'rail-props'],
];
let sideApi = null;

/** wire the strip toggle and the section headers; restores the saved state through api.settingsGet */
export function initSidePanel(app, api) {
  const side = document.getElementById('side');
  const btn = document.createElement('button');
  btn.id = 'side-toggle';
  btn.type = 'button';
  btn.addEventListener('click', () => app.setSidePanel(!app.sideShown));
  side.prepend(btn);
  sideApi = api;
  const rail = document.createElement('div');
  rail.id = 'side-rail'; rail.setAttribute('role', 'toolbar'); rail.setAttribute('aria-label', 'Side panel sections'); rail.setAttribute('aria-orientation', 'vertical');
  for (const [key, label, icon] of RAIL) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rail-btn'; b.dataset.sec = key; b.title = `${label}: open over the drawing`; b.setAttribute('aria-label', label);
    b.innerHTML = iconHtml(icon, 20);
    b.addEventListener('click', () => (app.sideFly === key ? closeSideFly(app) : openSideFly(app, key)));
    rail.append(b);
  }
  const bar = document.createElement('div');
  bar.id = 'side-flybar';
  const pin = document.createElement('button');
  pin.type = 'button'; pin.id = 'side-pin'; pin.title = 'Pin: keep the side panel open beside the drawing'; pin.setAttribute('aria-label', pin.title);
  pin.innerHTML = iconHtml('pin', 20);
  pin.addEventListener('click', () => app.setSideMode('expanded'));
  bar.append(Object.assign(document.createElement('span'), { className: 'fly-title' }), Object.assign(document.createElement('span'), { className: 'spacer' }), pin);
  side.append(rail, bar);
  // the flyout closes on a click outside it (dialogs and pop-up menus it opened count as inside) or on Esc
  document.addEventListener('pointerdown', (e) => { if (app.sideFly && !e.target.closest?.('#side, dialog, .popmenu, #sym-float')) closeSideFly(app); }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !app.sideFly || document.getElementById('dlg')?.open) return;
    e.preventDefault(); e.stopPropagation(); closeSideFly(app); app.vp?.canvas?.focus();
  }, true);
  const foldKey = (e) => {
    const head = e.target.closest?.('.phead');
    if (!head || e.target.closest('button, select, input, textarea, label')) return null; // the header's own controls keep their clicks
    return head.closest('.panel[data-sec]')?.dataset.sec ?? null;
  };
  side.addEventListener('click', (e) => { const k = foldKey(e); if (k) app.foldSideSection(k); });
  side.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const k = foldKey(e); if (!k) return;
    e.preventDefault(); e.stopPropagation(); app.foldSideSection(k);
  });
  const grip = document.createElement('div');
  grip.id = 'side-grip'; grip.title = 'Drag to resize the side panel';
  side.append(grip);
  const appEl = document.getElementById('app');
  const setWidth = (w) => { app.sideWidth = sideWidthClamp(w); appEl.style.setProperty('--side-user', `${app.sideWidth}px`); };
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
    const move = (ev) => setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      grip.classList.remove('drag'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      api.settingsSet?.('side.width', app.sideWidth)?.catch?.(() => {});
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  window.addEventListener('resize', () => setWidth(app.sideWidth)); // half the window shrinks with it
  setWidth(SIDE_W_DEFAULT);
  api.settingsGet?.('side.width').then((v) => { if (v != null) setWidth(sideWidthFrom(v)); }).catch(() => {});
  app.sideMode = 'expanded';
  app.sideFly = null;
  app.sideFolded = [];
  applySide(app);
  Promise.all([api.settingsGet?.('side.mode'), api.settingsGet?.('side.shown')]).then(([m, v]) => app.setSideMode(sideModeFrom(m, v), false)).catch(() => {});
  api.settingsGet?.('side.folded').then((v) => { app.sideFolded = sideFoldedFrom(v); applySide(app); }).catch(() => {});
}

/** expanded / collapsed / hidden (app.sideMode), saved as 'side.mode'; any open flyout closes */
export function setSideMode(app, mode, save = true) {
  app.sideMode = SIDE_MODES.includes(mode) ? mode : 'expanded';
  app.sideFly = null;
  applySide(app);
  if (save) sideApi?.settingsSet?.('side.mode', app.sideMode)?.catch?.(() => {});
}
/** collapsed or hidden: show one section as a flyout over the canvas (unfolded); expanded: just unfold it */
export function openSideFly(app, key) {
  if (key === 'symbols' && app.symbolsPanel && app.symbolsPanel.dock !== 'side') { closeSideFly(app); app.symbolsPanel.show(); return; } // its own column, floating or hidden
  if (app.sideFolded.includes(key)) app.foldSideSection(key, false);
  app.sideFly = app.sideMode === 'expanded' ? null : key;
  applySide(app);
}
export function closeSideFly(app) { if (!app.sideFly) return; app.sideFly = null; applySide(app); }
/** PR / LA / SYMBOLS: bring a section into view in the current mode (a flyout unless the panel is expanded) */
export function revealSection(app, key) {
  if (app.sideMode !== 'expanded') { openSideFly(app, key); return; }
  if (app.sideFolded.includes(key)) app.foldSideSection(key, false);
  else applySide(app);
}

/** reflect app.sideMode / app.sideFly / app.sideFolded in the DOM; the canvas follows its new width through the viewport's ResizeObserver */
export function applySide(app) {
  app.sideShown = app.sideMode === 'expanded';
  const appEl = document.getElementById('app');
  appEl.classList.toggle('no-side', !app.sideShown);
  appEl.classList.toggle('side-collapsed', app.sideMode === 'collapsed');
  appEl.classList.toggle('side-hidden', app.sideMode === 'hidden');
  appEl.classList.toggle('side-fly', !!app.sideFly);
  for (const b of document.querySelectorAll('#side-rail .rail-btn')) b.setAttribute('aria-pressed', String(b.dataset.sec === app.sideFly));
  const t = document.querySelector('#side-flybar .fly-title');
  if (t) t.textContent = RAIL.find((r) => r[0] === app.sideFly)?.[1] ?? '';
  const btn = document.getElementById('side-toggle');
  btn.textContent = app.sideShown ? '»' : '«';
  btn.title = STRIP_TITLE[app.sideShown ? 'shown' : 'hidden'];
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-expanded', String(app.sideShown));
  for (const p of document.querySelectorAll('#side .panel[data-sec]')) {
    const folded = app.sideFolded.includes(p.dataset.sec);
    p.classList.toggle('folded', folded);
    p.classList.toggle('fly', p.dataset.sec === app.sideFly);
    markHead(p);
  }
}

/** the header of a section as a fold button (Properties re-renders its header, so this runs again after each render) */
export function markHead(panel) {
  const head = panel?.querySelector('.phead');
  if (!head) return;
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', String(!panel.classList.contains('folded')));
  head.title = 'Click to fold or unfold this section';
}
