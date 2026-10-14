// ASH Draw Studio - autosave and crash recovery (reviewer #29): pure helpers (no DOM, no IPC).

/** Preferences: autosave interval in minutes (0 = Off); saved as setting 'autosave.minutes' */
export const AUTOSAVE_KEY = 'autosave.minutes';
export const AUTOSAVE_CHOICES = [0, 5, 10, 20, 30];
export const AUTOSAVE_DEFAULT = 10;
export const autosaveMinutesFrom = (v) => (AUTOSAVE_CHOICES.includes(v) ? v : AUTOSAVE_DEFAULT);

/** a stable id for one tab's autosave entry: 'tab-' + 12 of [a-z0-9] (the store accepts only /^[a-z0-9-]{1,64}$/) */
export function newAutosaveId(random = Math.random) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'tab-';
  for (let i = 0; i < 12; i++) s += abc[Math.floor(random() * abc.length) % abc.length];
  return s;
}

/** the session's undo state: it changes with every edit, undo and redo. An autosave whose signature changed while it
 *  was being written read a document that was changing under it and is dropped. */
export const sessionSignature = (session) => `${session.undoStack.at(-1)?.id ?? 0}:${session.redoStack.length}`;

/** the tabs to autosave now: unsaved changes, not being saved (tab.saving) or autosaved (`busy`), and changed since
 *  their last autosave (tab.autosavedSig) */
export const dueTabs = (tabs, busy = new Set()) => tabs.filter((t) => t.session.dirty && !t.saving && !busy.has(t) && t.autosavedSig !== sessionSignature(t.session));

/** "Plan A.dxf" / "Plan A.dwg" -> "Plan A (recovered).dxf": the name of the tab a recovered drawing opens in. An
 *  autosave copy is always DXF (whatever the drawing was opened from), and the name is what the loader reads the
 *  format from; the original name stays in tab.recoveredFrom (shown in the recovery list, the Save As default). */
export function recoveredName(name) {
  const n = String(name || 'Drawing.dxf').replace(/^.*[\\/]/, '');
  return `${n.replace(/\.(dxf|dwg)$/i, '')} (recovered).dxf`;
}

/** the file app.loadFile opens for an autosave entry ({name, ...}) and its bytes: no path (Save As asks where), and the
 *  recovered name, so the DXF bytes are read as DXF even when the drawing came from a DWG */
export const recoveryFile = (entry, bytes) => ({ path: null, name: recoveredName(entry.name), bytes });

/** after the save prompt of a tab being closed: may its autosave copy go? `choice`: 'clean' (nothing to save),
 *  'save' or 'dont-save'; `dirtyAfter`: the tab still has unsaved changes. A Save that left the drawing unsaved (a DWG
 *  that differs from it) keeps the copy: it may be the only copy of those edits. */
export const shouldDiscardAutosave = ({ choice, dirtyAfter }) => choice === 'dont-save' || !dirtyAfter;
