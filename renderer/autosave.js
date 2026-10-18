// ASH Draw Studio - timed autosave of drawings with unsaved changes, and their recovery at start-up (reviewer #29).
// Main keeps the copies in <userData>/autosave (electron/autosave.js); this module names them by id only. Desktop only.
import { el, modal, toast } from './ui.js';
import { dxfBytesAsync } from './files.js';
import { noteSavedSpace } from './layouts-ui.js';
import { AUTOSAVE_DEFAULT, AUTOSAVE_KEY, autosaveMinutesFrom, dueTabs, newAutosaveId, recoveryFile, sessionSignature } from '../src/core/autosave.js';

export function initAutosave(app) {
  const api = window.api;
  const enabled = !!api.autosaveWrite;
  const busy = new Set(); // tabs being autosaved
  const inflight = new Map(); // tab -> {ac, done}: its autosave being written (discard aborts it and waits for it to settle)
  const discarding = new Set(); // tabs whose copy is being removed: not autosaved meanwhile
  // the default until the saved setting has loaded (Preferences awaits `ready` so it shows and saves the loaded value)
  let minutes = AUTOSAVE_DEFAULT, timer = null, stopped = false;

  const idOf = (tab) => (tab.autosaveId ??= newAutosaveId());
  /** remove a tab's autosave copy (after a save, or when it is closed with "Don't save"). An autosave of the tab still
   *  being written is cancelled and waited for first: a write landing after the removal would leave a stale copy. */
  async function discard(tab) {
    if (!enabled || !tab) return;
    discarding.add(tab);
    try {
      const w = inflight.get(tab);
      if (w) { w.ac.abort(); await w.done; }
      if (!tab.autosaveId) return;
      tab.autosavedSig = null;
      await api.autosaveDiscard(tab.autosaveId).catch(() => {});
    } finally { discarding.delete(tab); }
  }
  /** write one tab's copy; false when it changed while being written (tried again next time), was cancelled or failed */
  async function saveTab(tab) {
    busy.add(tab);
    const ac = new AbortController();
    const done = (async () => {
      const sig = sessionSignature(tab.session);
      noteSavedSpace(tab); // a recovered copy opens in the space shown now, as a saved file would
      const bytes = await dxfBytesAsync(tab.doc, undefined, { signal: ac.signal });
      // the writer read the live document between slices: an edit, undo or redo meanwhile makes this copy inconsistent
      if (ac.signal.aborted || !app.tabs.includes(tab) || tab.saving || sessionSignature(tab.session) !== sig || !tab.session.dirty) return false;
      const from = tab.recoveredFrom ?? tab.file;
      await api.autosaveWrite(idOf(tab), bytes, { originalPath: from.path ?? null, name: from.name, format: tab.file.format });
      // back to its saved state while the copy was written: nothing unsaved is left to keep. (A save or a close with
      // "Don't save" removes the copy through discard(), which waits for this write.)
      if (!tab.session.dirty) { await api.autosaveDiscard(tab.autosaveId).catch(() => {}); return false; }
      tab.autosavedSig = sig;
      return true;
    })().catch((err) => {
      if (err?.code !== 'CANCELLED') console.warn('autosave failed:', err?.message ?? err);
      return false;
    }).finally(() => { busy.delete(tab); inflight.delete(tab); });
    inflight.set(tab, { ac, done });
    return done;
  }
  /** autosave every due tab now (the timer; also window.app.autosaveNow() for tests); the number written */
  async function now() {
    if (!enabled || stopped) return 0;
    let n = 0;
    for (const tab of dueTabs(app.tabs, { has: (t) => busy.has(t) || discarding.has(t) })) if (!stopped && await saveTab(tab)) n++;
    return n;
  }
  /** the window is closing: no further autosaves (copies being written still finish, or are discarded) */
  function stop() { stopped = true; clearInterval(timer); timer = null; }
  function setMinutes(m, save = true) {
    minutes = autosaveMinutesFrom(m);
    clearInterval(timer); timer = null;
    if (enabled && !stopped && minutes > 0) timer = setInterval(() => { now(); }, minutes * 60_000);
    if (save) api.settingsSet?.(AUTOSAVE_KEY, minutes)?.catch?.(() => {});
  }
  const ready = enabled ? api.settingsGet(AUTOSAVE_KEY).then((v) => setMinutes(v, false)).catch(() => setMinutes(undefined, false)) : Promise.resolve();

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
      await app.loadFile(recoveryFile(e, bytes)); // always DXF bytes: read as DXF, also for a drawing opened from DWG
      const tab = app.tabs.find((t) => !before.has(t));
      if (!tab) continue; // could not be read: the copy stays for the next start
      tab.recoveredFrom = { path: e.originalPath ?? null, name: e.name }; // Save As starts there (the file path stays null)
      tab.autosaveId = e.id; // later autosaves replace this copy; saving or closing the tab removes it
      tab.session.markSaved(-1); // unsaved, even after undoing everything
      app.updateTitle();
    }
  }

  return { now, discard, stop, recover, setMinutes, ready, get minutes() { return minutes; }, enabled };
}
