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

/** "Plan A.dxf" -> "Plan A (recovered).dxf"; the name of the tab a recovered drawing opens in */
export function recoveredName(name) {
  const n = String(name || 'Drawing.dxf').replace(/^.*[\\/]/, '');
  const m = /^(.+?)(\.[^.]*)?$/.exec(n);
  return `${m[1]} (recovered)${m[2] ?? ''}`;
}
