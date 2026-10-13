// The right-hand side panel (Layers, Markups, Properties): collapse to a thin strip, fold single sections, window title.
// State is saved like the other UI prefs: settings 'side.shown' (boolean) and 'side.folded' (section keys).

/** the foldable sections, by the data-sec of their .panel in index.html */
export const SIDE_SECTIONS = ['layers', 'markups', 'props'];
/** saved settings -> state; never-set values keep the panel shown and every section unfolded */
export const sideShownFrom = (saved) => saved !== false;
export const sideFoldedFrom = (saved) => (Array.isArray(saved) ? SIDE_SECTIONS.filter((k) => saved.includes(k)) : []);
/** "• plan.dxf — ASH Draw Studio 0.2.0-beta.22": the build version tells test builds apart; left out while unknown */
export const windowTitle = (name, dirty, version) => `${dirty ? '• ' : ''}${name} — ASH Draw Studio${version ? ` ${version}` : ''}`;

const STRIP_TITLE = { shown: 'Hide the side panel (Ctrl+3)', hidden: 'Show the side panel: Layers, Markups, Properties (Ctrl+3)' };

/** wire the strip toggle and the section headers; restores the saved state through api.settingsGet */
export function initSidePanel(app, api) {
  const side = document.getElementById('side');
  const btn = document.createElement('button');
  btn.id = 'side-toggle';
  btn.type = 'button';
  btn.addEventListener('click', () => app.setSidePanel(!app.sideShown));
  side.prepend(btn);
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
  app.sideShown = true;
  app.sideFolded = [];
  applySide(app);
  api.settingsGet?.('side.shown').then((v) => app.setSidePanel(sideShownFrom(v), false)).catch(() => {});
  api.settingsGet?.('side.folded').then((v) => { app.sideFolded = sideFoldedFrom(v); applySide(app); }).catch(() => {});
}

/** reflect app.sideShown / app.sideFolded in the DOM; the canvas follows its new width through the viewport's ResizeObserver */
export function applySide(app) {
  document.getElementById('app').classList.toggle('no-side', !app.sideShown);
  const btn = document.getElementById('side-toggle');
  btn.textContent = app.sideShown ? '»' : '«';
  btn.title = STRIP_TITLE[app.sideShown ? 'shown' : 'hidden'];
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-expanded', String(app.sideShown));
  for (const p of document.querySelectorAll('#side .panel[data-sec]')) {
    const folded = app.sideFolded.includes(p.dataset.sec);
    p.classList.toggle('folded', folded);
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
