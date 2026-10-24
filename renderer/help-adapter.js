// ASH Draw Studio side of the in-app help (renderer/help/help-engine.js is app-agnostic, shared with ASH PDF Studio).
// Help menu: User guide (F1), Guided tours…, Keyboard shortcuts; F1 context help via help/context*.json;
// modal dialogs get data-help and a "?" (ui.js setDialogDecorator); tours hear app events.
import data from './help/help-data.js';
import { initHelp, openHelp, helpEvent, helpButton, maybeWelcome } from './help/help-engine.js';
import { setDialogDecorator } from './ui.js';

const PANEL = {
  layers: '.panel[data-sec="layers"]', props: '.panel[data-sec="props"]', symbols: '#sym-panel', markups: '#mk-panel',
  tools: '#tools', side: '#side', qat: '#qat', status: '#status', tabs: '#tabbar', canvas: '#cv', menubar: '#menubar',
};

/** Selector for a target id: tool:<id>, el:<id>, status:<key>, cmd:<name>, panel:<name>, menu:<Name>, or a bare name. */
function selectorFor(id) {
  const i = id.indexOf(':');
  const [kind, name] = i > 0 ? [id.slice(0, i), id.slice(i + 1)] : ['', id];
  const q = (s) => CSS.escape(s);
  if (kind === 'tool') return `#tools button[data-tool="${q(name)}"]`;
  if (kind === 'el') return `#${q(name)}`;
  if (kind === 'status') return `#status button[data-key="${q(name)}"]`;
  if (kind === 'cmd') return `#qat button[data-cmd="${q(name)}"]`;
  if (kind === 'panel') return PANEL[name];
  if (kind === 'menu') return `#menubar .menu > button[data-menu="${q(name)}"]`;
  if (!kind) return PANEL[name] ?? (document.getElementById(name) ? `#${q(name)}` : document.querySelector(`#tools button[data-tool="${q(name)}"]`) ? `#tools button[data-tool="${q(name)}"]` : undefined);
  return undefined;
}

/** A visible stand-in for a hidden control: its tool group's header or overflow button, the menu's button. */
function fallback(id, el) {
  if (!el) return null;
  const group = el.closest('.tgroup');
  if (group) return [...group.querySelectorAll('.gmore, [data-head]')].find((n) => n.getClientRects().length) ?? group;
  const menu = el.closest('#menubar .menu');
  if (menu) return menu.firstElementChild;
  return null;
}

/** Context help from help/context*.json selector keys: the deepest matching element wins. */
function contextOf(el) {
  let best = null, depth = -1;
  for (const [sel, ref] of Object.entries(data.context ?? {})) {
    if (sel.startsWith('dialog:')) continue;
    let m;
    try { m = el.closest(sel); } catch { continue; }
    if (!m) continue;
    let d = 0;
    for (let n = m; n; n = n.parentElement) d++;
    if (d > depth) { best = ref; depth = d; }
  }
  return best;
}

/** Topic for a dialog title: an exact "dialog:<Title>" key, else the longest "dialog:<Prefix>*" key that matches. */
function dialogTopic(title) {
  const ctx = data.context ?? {};
  if (ctx[`dialog:${title}`]) return ctx[`dialog:${title}`];
  let best = null, len = -1;
  for (const [k, v] of Object.entries(ctx)) {
    if (!k.startsWith('dialog:') || !k.endsWith('*')) continue;
    const p = k.slice(7, -1);
    if (title.startsWith(p) && p.length > len) { best = v; len = p.length; }
  }
  return best;
}

export function initHelpAdapter(app, api) {
  const known = new Set(data.topics.map((t) => t.id));
  initHelp({
    appName: 'ASH Draw Studio',
    data,
    targets: new Proxy({}, { get: (_, id) => (typeof id === 'string' ? selectorFor(id) : undefined) }),
    fallback,
    contextOf,
    container: () => document.querySelector('dialog[open]') ?? document.body, // a modal <dialog> is in the top layer
    getPref: (k) => api.settingsGet?.(k),
    setPref: (k, v) => api.settingsSet?.(k, v),
    openUrl: (url) => api.openExternal?.(url)?.catch?.(() => {}),
    top: () => document.getElementById('menubar')?.getBoundingClientRect().bottom ?? 0,
    home: known.has('welcome') ? 'welcome' : data.topics[0]?.id,
  });
  setDialogDecorator(({ dialog, titleEl, title }) => {
    const ref = dialogTopic(title);
    if (!ref || !known.has(String(ref).split('/')[0])) return;
    dialog.setAttribute('data-help', ref);
    titleEl.append(helpButton(ref));
  });
  return {
    hasTours: !!data.tours?.length,
    open: (id) => openHelp(id && known.has(id) ? id : undefined),
    event: (name) => helpEvent(name),
    // First start only (pref help.welcomeShown); not under test automation unless a test asks for it.
    welcome: () => { if (!navigator.webdriver || window.__ashHelpWelcome) maybeWelcome(); },
  };
}
