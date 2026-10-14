// ASH Draw Studio - timed autosave of drawings with unsaved changes, and their recovery at start-up (reviewer #29).
// Main keeps the copies in <userData>/autosave (electron/autosave.js); this module names them by id only. Desktop only.
import { el, modal, toast } from './ui.js';
import { dxfBytesAsync } from './files.js';
import { AUTOSAVE_KEY, autosaveMinutesFrom, dueTabs, newAutosaveId, recoveredName, sessionSignature } from '../src/core/autosave.js';

export function initAutosave(app) {
  const api = window.api;
  const enabled = !!api.autosaveWrite;
  const busy = new Set(); // tabs being autosaved
  let minutes = 0, timer = null;

  const idOf = (tab) => (tab.autosaveId ??= newAutosaveId());
  /** remove a tab's autosave copy (after a save, or when it is closed - also with "Don't save") */
  async function discard(tab) {
    if (!enabled || !tab?.autosaveId) return;
    tab.autosavedSig = null;
    await api.autosaveDiscard(tab.autosaveId).catch(() => {});
  }
  /** write one tab's copy; false when it changed while being written (tried again next time) or failed */
  async function saveTab(tab) {
    busy.add(tab);
    try {
      const sig = sessionSignature(tab.session);
      const bytes = await dxfBytesAsync(tab.doc);
      // the writer read the live document between slices: an edit, undo or redo meanwhile makes this copy inconsistent
      if (!app.tabs.includes(tab) || tab.saving || sessionSignature(tab.session) !== sig || !tab.session.dirty) return false;
      const from = tab.recoveredFrom ?? tab.file;
      await api.autosaveWrite(idOf(tab), bytes, { originalPath: from.path ?? null, name: from.name, format: tab.file.format });
      // saved or closed while the copy was written: it must not outlive the drawing
      if (!app.tabs.includes(tab) || !tab.session.dirty) { await api.autosaveDiscard(tab.autosaveId).catch(() => {}); return false; }
      tab.autosavedSig = sig;
      return true;
    } catch (err) {
      console.warn('autosave failed:', err?.message ?? err);
      return false;
    } finally { busy.delete(tab); }
  }
  /** autosave every due tab now (the timer; also window.app.autosaveNow() for tests); the number written */
  async function now() {
    if (!enabled) return 0;
    let n = 0;
    for (const tab of dueTabs(app.tabs, busy)) if (await saveTab(tab)) n++;
    return n;
  }
  function setMinutes(m, save = true) {
    minutes = autosaveMinutesFrom(m);
    clearInterval(timer); timer = null;
    if (enabled && minutes > 0) timer = setInterval(() => { now(); }, minutes * 60_000);
    if (save) api.settingsSet?.(AUTOSAVE_KEY, minutes)?.catch?.(() => {});
  }
  if (enabled) api.settingsGet(AUTOSAVE_KEY).then((v) => setMinutes(v, false)).catch(() => setMinutes(undefined, false));

  /** start-up: offer the copies left by a run that ended without saving them - Recover / Discard / Later */
  async function recover() {
    if (!enabled) return;
    let list;
    try { list = await api.autosaveList(); } catch { return; }
    if (!list?.length) return;
    const when = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(); };
    const body = el('div', { class: 'autosave-recover' },
      el('p', { text: 'These drawings had unsaved changes when the program last closed. Recover them?' }),
      el('ul', { class: 'file-list' }, list.map((e) => el('li', {},
        el('span', { class: 'file-name', text: e.name }),
        el('span', { class: 'file-folder', text: e.originalPath ?? 'Never saved' }),
        el('span', { class: 'file-note', text: `Autosaved ${when(e.savedAt)}` })))),
      el('p', { class: 'file-note', text: 'Later keeps the copies and asks again at the next start.' }));
    const r = await modal('Recover unsaved drawings', body, [{ label: 'Recover', value: 'recover', primary: true }, { label: 'Discard', value: 'discard' }, { label: 'Later', value: null }]);
    if (r === 'discard') { for (const e of list) await api.autosaveDiscard(e.id).catch(() => {}); return; }
    if (r !== 'recover') return;
    for (const e of list) {
      let bytes;
      try { bytes = await api.autosaveRead(e.id); } catch (err) { toast(`Could not recover ${e.name}: ${err.message}`, 5000); continue; }
      const before = new Set(app.tabs);
      await app.loadFile({ path: null, name: recoveredName(e.name), bytes });
      const tab = app.tabs.find((t) => !before.has(t));
      if (!tab) continue; // could not be read: the copy stays for the next start
      tab.recoveredFrom = { path: e.originalPath ?? null, name: e.name }; // Save As starts there (the file path stays null)
      tab.autosaveId = e.id; // later autosaves replace this copy; saving or closing the tab removes it
      tab.session.markSaved(-1); // unsaved, even after undoing everything
      app.updateTitle();
    }
  }

  return { now, discard, recover, setMinutes, get minutes() { return minutes; }, enabled };
}
