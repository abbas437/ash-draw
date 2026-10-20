// Second-copy detection. Electron's single-instance lock is per userData; a second copy that shares userData (the
// installed build and the zip build) quits at the lock and passes {exe, version} to the running copy as `additionalData`
// of its 'second-instance' event (Electron 21+). These pure helpers compare exe paths and build the message text.
// (The Portable build has its own userData, so it never shares the lock or the settings.)

/** the lock data this copy hands to a running one */
export const lockData = ({ exe, version }) => ({ exe, version });

const samePath = (a, b, win) => (win ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** Whether `data` (a second copy's additionalData) names a different exe than `exe`; malformed data counts as the same. */
export function isForeignCopy(data, { exe, win = process.platform === 'win32' }) {
  return !!data && typeof data === 'object' && typeof data.exe === 'string' && data.exe !== '' && !samePath(data.exe, exe, win);
}

/** The message the running copy shows about the copy that was refused. */
export function foreignCopyMessage(data, { exe, version }, opened = 0) {
  return `ASH Draw Studio ${version} is already running from ${exe}. The copy you started (${data.version ?? 'unknown version'}, ${data.exe}) `
    + 'shares the same settings, so it was not opened. Close this window first to use the other copy.'
    + (opened ? ` The ${opened === 1 ? 'drawing' : `${opened} drawings`} you opened ${opened === 1 ? 'is' : 'are'} shown in this window.` : '');
}

/**
 * The running copy's 'second-instance' handler (reviewer #21). The started copy quit at the lock; the drawings it was
 * given (double-clicked files) open here in every case, and this window comes to the front. When the started copy is a
 * different build sharing our settings, a notice says so. Electron-free: main passes
 * `{ me, drawingArgs(argv, cwd), openFile(path), notify(message), focus() }`.
 */
export function onSecondInstance({ argv, cwd, additionalData }, { me, drawingArgs, openFile, notify, focus }) {
  const files = drawingArgs(argv, cwd);
  for (const p of files) openFile(p);
  focus();
  if (isForeignCopy(additionalData, me)) notify(foreignCopyMessage(additionalData, me, files.length));
}
