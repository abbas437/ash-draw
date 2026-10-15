// ASH Draw Studio - the tool panel's three layouts: Full (the panel as built by tool-panel.js), Compact rail (one button per
// group, each opening a flyout of the group's tools) and Floating (the Full panel in a small window dragged by its title strip).
// The flyout borrows the group's own body from the Full panel and gives it back on close, so every tool and setting stays the same element.
import { iconSvg, iconHtml } from './icons.js';

export const TOOL_MODES = ['full', 'rail', 'float'];
export const MODE_LABELS = { full: 'Full', rail: 'Compact rail', float: 'Floating' };
export const modeFrom = (saved) => (TOOL_MODES.includes(saved) ? saved : 'full');
/** the icon a group's rail button shows until one of its tools is used: the group's most typical tool */
const GROUP_ICON = { select: 'select', draw: 'line', modify: 'move', block: 'insert', annotate: 'dimlinear', inquiry: 'measure', markup: 'mkc' };
/** small icons of the layout controls (the panel's convention: every button carries an <svg>) */
const PIN_SVG = iconHtml('pin', 14);
const DOTS_SVG = iconHtml('dots', 14);
const ARROW_SVG = iconHtml('chevron', 8, 12);

/** keep a w x h box at (x, y) inside the window; returns the clamped [x, y] */
export const clampPos = (x, y, w, h, W, H) => [Math.max(0, Math.min(x, W - w)), Math.max(0, Math.min(y, H - h))];
/** saved 'tools.floatOpacity' -> a whole percentage, 30 to 100 (100 when never set) */
export const opacityFrom = (saved) => (typeof saved === 'number' && Number.isFinite(saved) ? Math.max(30, Math.min(100, Math.round(saved))) : 100);
/** how near (px) the floating panel must come to the canvas's left or right edge to dock there */
export const DOCK_SNAP = 24;
/** the side a floating panel with rect `r` docks to when dropped over the canvas rect `s`: 'left', 'right' or null */
export const dockSideAt = (r, s, snap = DOCK_SNAP) => (r.left <= s.left + snap ? 'left' : r.right >= s.right - snap ? 'right' : null);
/** whether layout `mode` can sit at tool panel placement `place`: Full anywhere, Compact rail left, right or Top (a one-row band), Floating left or right (its dock side) */
export const modeAllows = (mode, place) => mode === 'full' || place === 'left' || place === 'right' || (mode === 'rail' && place === 'top');

/**
 * Wire the layouts to the app: `app.setTool`, `#tools` built by app.renderToolPanel, and `api.settingsGet/Set`.
 * Settings: 'tools.mode' (full | rail | float), 'tools.railPins' (pinned group keys), 'tools.floatPos' ({x, y}),
 * 'tools.floatOpacity' (30-100 %: the floating panel and the rail flyouts over the drawing), 'tools.floatOpaqueHover' (fully opaque under the pointer).
 * The dock side is the app's placement (left | right); Compact rail and Floating keep it.
 */
export function initToolModes(app, api, el) {
  const box = document.getElementById('tools'), root = document.getElementById('app');
  const S = { mode: 'full', pins: [], pos: null, last: {}, open: null, op: 100, opHover: true, dock: 'full' }; // open: { key, moved: [[node, home tgroup]], btn }; dock: the last docked layout
  const save = (k, v) => api.settingsSet?.(k, v)?.catch?.(() => {});
  /** a layout control: a role=button element like the panel's "Aa" toggle (the panel's <button>s are its labelled tools) */
  const ctl = (attrs, run, ...kids) => el('div', { role: 'button', tabindex: '0', ...attrs, class: `tp-ctl ${attrs.class}`, onclick: run, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(e); } } }, ...kids);

  const rail = el('div', { class: 'rail', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': 'Tool groups' });
  const fly = el('div', { class: 'rail-fly', role: 'dialog', hidden: true });
  const flyName = el('span', { class: 'rail-name' });
  const pin = ctl({ class: 'rail-pin', 'aria-pressed': 'false' }, () => togglePin());
  pin.innerHTML = PIN_SVG;
  fly.append(el('div', { class: 'rail-head' }, flyName, pin));
  const head = el('div', { class: 'float-head', title: 'Drag to move the tool panel. Drop it on the left or right edge of the drawing, or double-click here, to dock it.' }, el('span', { text: 'Tools' }));
  const hint = el('div', { class: 'dock-hint', hidden: true, 'aria-hidden': 'true' }); // where a dragged floating panel will dock
  document.getElementById('stage').append(hint);
  const more = ctl({ class: 'tp-mode', title: 'Tool panel layout: Full, Compact rail or Floating', 'aria-label': 'Tool panel layout', 'aria-haspopup': 'true' }, (e) => { e.stopPropagation(); modeMenu(); });
  more.innerHTML = DOTS_SVG;
  box.prepend(head, rail);
  box.append(more, fly);
  root.classList.add('tools-full');

  const groups = () => [...box.querySelectorAll(':scope > .tgroup[data-group]')];
  const groupName = (tg) => tg.querySelector(':scope > .group')?.textContent || tg.dataset.group;
  const toolBtn = (key, id) => box.querySelector(`.tgroup[data-group="${CSS.escape(key)}"] button[data-tool="${CSS.escape(id)}"], .rail-fly button[data-tool="${CSS.escape(id)}"][data-group="${CSS.escape(key)}"]`);
  /** the group whose flyout also carries the Hatch pattern and scale: the one holding the Hatch tool, else Draw, else the first */
  const hatchHome = () => box.querySelector('button[data-tool="hatch"]')?.dataset.group ?? (groups().some((g) => g.dataset.group === 'draw') ? 'draw' : groups()[0]?.dataset.group);

  /** rebuild the rail buttons from the panel's groups (after app.renderToolPanel); a Top band lays them out in one row */
  function refresh() {
    rail.setAttribute('aria-orientation', app.toolPlacement === 'top' ? 'horizontal' : 'vertical');
    rail.replaceChildren(...groups().map((tg) => {
      const key = tg.dataset.group, name = groupName(tg);
      if (S.last[key] && !toolBtn(key, S.last[key])) delete S.last[key]; // hidden or moved by Customize tools
      const last = S.last[key], lb = last && toolBtn(key, last);
      const icon = last || GROUP_ICON[key] || tg.querySelector('button[data-tool]')?.dataset.tool || 'select';
      const main = ctl({ class: `rail-btn g-${key}`, 'data-rail': key, 'data-rail-tool': last || '', 'aria-label': last ? lb.getAttribute('aria-label') : `${name} tools`,
        title: last ? `${lb.title}: click to repeat; the arrow opens ${name}` : name }, () => (last ? app.setTool(last) : toggle(key, main)), iconSvg(icon, 18));
      const arrow = ctl({ class: `rail-more g-${key}`, 'data-rail-more': key, title: `${name} tools`, 'aria-label': `${name} tools`, 'aria-haspopup': 'true', 'aria-expanded': String(S.open?.key === key) }, () => toggle(key, main));
      arrow.innerHTML = ARROW_SVG;
      return el('div', { class: 'rail-item' }, main, arrow);
    }));
    mark();
  }

  /** press the rail button of the group holding the current tool, however that tool was chosen */
  function mark() {
    const key = box.querySelector(`button[data-tool="${CSS.escape(app.toolId ?? '')}"][data-group]`)?.dataset.group;
    for (const b of rail.querySelectorAll('.rail-btn')) b.setAttribute('aria-pressed', String(b.dataset.rail === key));
  }

  function toggle(key, btn) { if (S.open?.key === key) close(true); else open(key, btn); }

  /** open a group's flyout beside the rail (below it in a Top band): its tool buttons (and their settings) moved in from the Full panel */
  function open(key, btn) {
    close();
    const tg = groups().find((g) => g.dataset.group === key); if (!tg) return;
    const moved = [];
    const take = (g) => { const b = g?.querySelector(':scope > .gbody, :scope > .xbody'); if (b) { moved.push([b, g]); fly.append(b); } };
    take(tg);
    if (key === hatchHome()) take(box.querySelector(':scope > .tgroup[data-extra="hatch"]'));
    S.open = { key, moved, btn };
    flyName.textContent = groupName(tg);
    fly.className = `rail-fly g-${key}`;
    setPin();
    fly.hidden = false;
    rail.querySelector(`[data-rail-more="${CSS.escape(key)}"]`)?.setAttribute('aria-expanded', 'true');
    const b = btn.getBoundingClientRect(), r = box.getBoundingClientRect(), h = fly.offsetHeight;
    if (app.toolPlacement === 'top') { // under the band, starting at the group's button
      fly.style.left = `${Math.max(4, Math.min(b.left, innerWidth - fly.offsetWidth - 4))}px`;
      fly.style.top = `${r.bottom + 2}px`;
      fly.style.maxHeight = `${innerHeight - r.bottom - 8}px`;
      return;
    }
    fly.style.left = `${app.toolPlacement === 'right' ? r.left - 2 - fly.offsetWidth : r.right + 2}px`; // a right-docked rail opens its flyouts to the left
    fly.style.top = `${Math.max(4, Math.min(b.top, innerHeight - h - 4))}px`;
    fly.style.maxHeight = `${innerHeight - 8}px`;
  }

  /** give the bodies back to their groups; `refocus` returns focus to the rail button */
  function close(refocus = false) {
    if (!S.open) return;
    const { moved, btn, key } = S.open; S.open = null;
    for (const [b, g] of moved) g.insertBefore(b, g.querySelector(':scope > .gmore'));
    fly.hidden = true;
    rail.querySelector(`[data-rail-more="${CSS.escape(key)}"]`)?.setAttribute('aria-expanded', 'false');
    if (refocus && btn.isConnected) btn.focus();
  }

  const pinned = () => !!S.open && S.pins.includes(S.open.key);
  function setPin() {
    const on = pinned();
    pin.setAttribute('aria-pressed', String(on));
    pin.title = on ? 'Unpin: close this group after choosing a tool' : 'Pin: keep this group open after choosing a tool';
    pin.setAttribute('aria-label', pin.title);
  }
  function togglePin() {
    if (!S.open) return;
    const k = S.open.key;
    S.pins = S.pins.includes(k) ? S.pins.filter((p) => p !== k) : [...S.pins, k];
    setPin(); save('tools.railPins', S.pins);
  }

  // choosing a tool: the rail button takes it over (AutoCAD flyout); the flyout closes unless pinned
  fly.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b === pin || !S.open) return;
    if (b.dataset.tool && b.dataset.group) { S.last[b.dataset.group] = b.dataset.tool; refresh(); }
    if (!pinned()) close();
  });
  // Escape and clicks outside close it; a pinned flyout stays, except for Escape pressed inside it
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !S.open) return;
    if (!pinned() || fly.contains(document.activeElement)) close(fly.contains(document.activeElement));
  }, true);
  document.addEventListener('pointerdown', (e) => { if (S.open && !pinned() && !fly.contains(e.target) && !rail.contains(e.target)) close(); }, true);

  // ---- Floating: drag by the title strip, kept inside the window ----
  function place(x, y) {
    const [cx, cy] = clampPos(x, y, box.offsetWidth, box.offsetHeight, innerWidth, innerHeight);
    S.pos = { x: Math.round(cx), y: Math.round(cy) };
    box.style.left = `${S.pos.x}px`; box.style.top = `${S.pos.y}px`;
  }
  // dropped within DOCK_SNAP of the canvas's left or right edge it docks there as a Full panel; a hint shows that side while dragging
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || S.mode !== 'float' || e.target.closest('.tp-ctl')) return;
    e.preventDefault();
    const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top, from = { ...S.pos };
    head.setPointerCapture(e.pointerId);
    let side = null, moved = false;
    const move = (ev) => {
      moved ||= Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 3;
      place(ev.clientX - dx, ev.clientY - dy);
      side = moved ? dockSideAt(box.getBoundingClientRect(), document.getElementById('stage').getBoundingClientRect()) : null;
      hint.hidden = !side;
      if (side) hint.dataset.side = side;
    };
    const up = (ev) => {
      head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up);
      hint.hidden = true;
      if (side && ev.type === 'pointerup') { place(from.x, from.y); save('tools.floatPos', S.pos); dock(side, 'full'); return; } // floats again where it was
      save('tools.floatPos', S.pos);
    };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  head.addEventListener('dblclick', (e) => { if (S.mode === 'float' && !e.target.closest('.tp-ctl')) dock(app.toolPlacement, S.dock); });
  /** leave Floating: dock on `side` (left | right) in `mode` (full | rail) */
  function dock(side, mode) {
    if (side !== 'left' && side !== 'right') side = 'left';
    if (app.toolPlacement !== side) app.setToolPlacement(side);
    setMode(mode === 'rail' ? 'rail' : 'full');
  }
  addEventListener('resize', () => { if (S.mode === 'float' && S.pos) place(S.pos.x, S.pos.y); });

  /** switch layout; a placement the layout cannot take (modeAllows) moves the panel to the left: a hidden panel always, a Top band for Floating */
  function setMode(mode, persist = true) {
    mode = modeFrom(mode);
    close();
    S.mode = mode;
    if (mode !== 'float') S.dock = mode;
    if (!modeAllows(mode, app.toolPlacement)) app.setToolPlacement('left', persist);
    for (const m of TOOL_MODES) root.classList.toggle(`tools-${m}`, m === mode);
    if (mode === 'float') head.append(more); else box.insertBefore(more, fly); // floating: the ⋯ menu sits in the title strip
    if (mode === 'float') {
      if (!S.pos) { const s = document.getElementById('stage').getBoundingClientRect(); S.pos = { x: s.left + DOCK_SNAP + 16, y: s.top + 8 }; } // clear of the dock edge
      place(S.pos.x, S.pos.y);
    } else box.style.left = box.style.top = '';
    if (mode === 'rail') refresh();
    app.fitBand?.();
    if (persist) save('tools.mode', mode);
  }

  /** the opacity of the floating panel and the rail flyouts (CSS --tools-op), and whether the pointer makes them opaque */
  function setOpacity(op, hover = S.opHover, persist = true) {
    S.op = opacityFrom(op); S.opHover = hover !== false;
    root.style.setProperty('--tools-op', String(S.op / 100));
    root.classList.toggle('tools-ophover', S.opHover);
    if (persist) { save('tools.floatOpacity', S.op); save('tools.floatOpaqueHover', S.opHover); }
  }

  /** the ⋯ menu: Full / Compact rail / Floating; with Compact rail or Floating also the opacity over the drawing */
  function modeMenu() {
    document.querySelector('.tp-menu')?.remove();
    const done = () => { menu.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
    const menu = el('div', { class: 'tp-menu', role: 'menu' }, TOOL_MODES.map((m) => el('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(S.mode === m), 'data-mode': m,
      onclick: () => { done(); setMode(m); more.focus(); } }, el('span', { class: 'chk', text: S.mode === m ? '✓' : '' }), MODE_LABELS[m])));
    if (S.mode !== 'full') {
      const pct = el('span', { class: 'tp-op-val', text: `${S.op} %` });
      const range = el('input', { type: 'range', min: '30', max: '100', step: '5', value: String(S.op), 'aria-label': 'Tool panel opacity over the drawing',
        oninput: (e) => { setOpacity(Number(e.target.value), S.opHover, false); pct.textContent = `${S.op} %`; }, onchange: (e) => setOpacity(Number(e.target.value)) });
      const hov = el('button', { type: 'button', role: 'menuitemcheckbox', class: 'tp-op-hover', 'aria-checked': String(S.opHover), title: 'Show the tools fully opaque while the pointer is over them',
        onclick: () => { setOpacity(S.op, !S.opHover); hov.setAttribute('aria-checked', String(S.opHover)); hov.firstChild.textContent = S.opHover ? '✓' : ''; } },
      el('span', { class: 'chk', text: S.opHover ? '✓' : '' }), 'Opaque on hover');
      menu.append(el('div', { role: 'separator', class: 'tp-sep' }),
        el('label', { class: 'tp-op', title: S.mode === 'float' ? 'Opacity of the floating tool panel' : 'Opacity of the tool flyouts over the drawing' }, el('span', { text: 'Opacity' }), range, pct), hov);
    }
    const away = (e) => { if (!menu.contains(e.target) && e.target !== more) done(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); more.focus(); } };
    document.body.append(menu);
    const b = more.getBoundingClientRect(), r = box.getBoundingClientRect(), w = menu.offsetWidth;
    // floating: beside the panel, so its opacity can be seen while it changes
    const x = S.mode !== 'float' ? Math.min(b.left, innerWidth - w - 4) : r.right + 4 + w <= innerWidth ? r.right + 4 : Math.max(4, r.left - 4 - w);
    menu.style.left = `${x}px`;
    menu.style.top = `${Math.max(4, Math.min(S.mode === 'float' ? r.top : b.bottom + 2, innerHeight - menu.offsetHeight - 4))}px`;
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true);
    menu.querySelector('[aria-checked="true"]')?.focus();
  }

  setOpacity(100, true, false);
  Promise.all(['tools.railPins', 'tools.floatPos', 'tools.mode', 'tools.floatOpacity', 'tools.floatOpaqueHover'].map((k) => api.settingsGet?.(k)?.catch?.(() => undefined))).then(([pins, pos, mode, op, hover]) => {
    setOpacity(op, hover, false);
    if (Array.isArray(pins)) S.pins = pins.filter((k) => typeof k === 'string');
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) S.pos = { x: pos.x, y: pos.y };
    if (mode != null) setMode(mode, false);
  }).catch(() => {});

  return { get mode() { return S.mode; }, get opacity() { return S.op; }, setMode, setOpacity, refresh, close, mark };
}
