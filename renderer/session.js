// ASH Draw Studio - last session and recent files (desktop app only). Main owns both lists: this module reports the
// open tabs' file paths, offers the previous session in the drawing area at start-up and shows File > Recent files.
import { el, modal, toast } from './ui.js';

const fileLabel = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return { name: p.slice(i + 1), folder: p.slice(0, Math.max(i, 0)) };
};

export function initSession(app) {
  const api = window.api;
  const electron = !!api.isElectron;

  // Called whenever the tabs may have changed (App.updateTitle); reports only when paths or the shown file differ.
  let last = '';
  function changed() {
    if (!electron) return;
    const files = app.tabs.filter((t) => t.file.path).map((t) => t.file.path);
    const active = app.active?.file.path ?? null;
    const sig = JSON.stringify([files, active]);
    if (sig === last) return;
    last = sig;
    api.sessionUpdate({ files, active }).catch(() => {});
  }

  const missingList = (paths) => el('div', { class: 'session-missing' },
    el('p', { text: 'These files are no longer available:' }),
    el('ul', { class: 'file-list' }, paths.map((p) => {
      const { name, folder } = fileLabel(p);
      return el('li', {}, el('span', { class: 'file-name', text: name }), el('span', { class: 'file-folder', text: folder }));
    })),
    el('p', { class: 'file-note', text: 'They may have been deleted, moved or renamed.' }));

  async function restore() {
    let r;
    try { r = await api.sessionRestore(); } catch (err) { toast(`Could not reopen the last session: ${err.message}`); return; }
    if (!r) return;
    for (const f of r.files) await app.openFromFile(f);
    const active = r.active && app.tabs.find((t) => t.file.path === r.active);
    if (active && active !== app.active) app.switchTo(active);
    if (r.missing?.length) await modal('Some files are not available', missingList(r.missing));
  }

  // Offers (or, with startup.mode 'restore', reopens) the previous session, once.
  async function start() {
    if (!electron) return;
    let info;
    try { info = await api.sessionInfo(); } catch { return; }
    const offer = info?.offer;
    if (!offer) return;
    if (offer.auto) { await restore(); return; }
    const always = el('input', { type: 'checkbox' });
    const choose = async (mode) => {
      panel.remove();
      if (always.checked) await api.settingsSet('startup.mode', mode).catch(() => {});
      if (mode === 'restore') await restore();
      else await api.sessionDismiss().catch(() => {});
    };
    const n = offer.count;
    const panel = el('div', { class: 'session-offer', role: 'group', 'aria-label': 'Last session' },
      el('div', { class: 'session-offer-buttons' },
        el('button', { class: 'primary', type: 'button', 'data-session': 'reopen', onclick: () => choose('restore') }, `Reopen last session (${n} file${n === 1 ? '' : 's'})`),
        el('button', { type: 'button', 'data-session': 'new', onclick: () => choose('new') }, 'Start new')),
      el('label', { class: 'session-always' }, always, ' Always do this'));
    document.getElementById('stage').append(panel);
  }

  async function showRecent() {
    if (!electron) { toast('Recent files are available in the desktop app'); return; }
    const list = await api.recentList();
    let chosen = null;
    const body = list.length
      ? el('ul', { class: 'file-list recent-files' }, list.map((e) => el('li', {},
        el('button', {
          class: 'recent-item', type: 'button', disabled: !e.exists, title: e.path,
          onclick: () => { chosen = e.path; document.getElementById('dlg').close(); },
        }, el('span', { class: 'file-name', text: e.name }), el('span', { class: 'file-folder', text: e.folder }),
        !e.exists && el('span', { class: 'file-missing', text: 'Not found' })))))
      : el('p', { class: 'file-note', text: 'No recent files.' });
    const r = await modal('Recent files', body, [{ label: 'Clear list', value: 'clear' }, { label: 'Close', value: null, primary: true }]);
    if (r === 'clear') { await api.recentClear(); toast('Recent files list cleared'); return; }
    if (!chosen) return;
    const file = await api.recentOpen(chosen);
    if (file) await app.openFromFile(file);
    else await modal('File not available', missingList([chosen]));
  }

  return { changed, start, showRecent };
}
