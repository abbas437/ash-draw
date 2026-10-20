// Where a Save dialog opens: the folder of the drawing's file (when the renderer sends a full path and that folder
// exists), else the Documents folder. Only the dialog's starting point; the user still picks the final path.
import path from 'node:path';

const WIN_ABS = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]|\/\/[^\\/])/;
const POSIX_ABS = /^\//;

/** `defaultPath` is a bare file name or a full path (Windows or POSIX); `isDir(p)` tells whether a folder exists. */
export function saveDialogDefault(defaultPath, { documents, isDir, fallbackName = 'drawing.dxf', hostSep = path.sep }) {
  const raw = defaultPath ? String(defaultPath) : '';
  const name = path.win32.basename(raw) || fallbackName; // win32 splits on both / and \ on any host
  const win = WIN_ABS.test(raw);
  // a Windows path only makes sense on Windows (and a POSIX one off it): a mismatch falls back to Documents
  if ((win && hostSep === '\\') || (!win && POSIX_ABS.test(raw) && hostSep === '/')) {
    const f = win ? path.win32 : path.posix;
    const dir = f.normalize(f.dirname(raw));
    if (isDir(dir)) return f.join(dir, name);
  }
  return (hostSep === '\\' ? path.win32 : path.posix).join(documents, name);
}

/** Where an Open dialog starts: `dir` (the active drawing's folder, as the renderer sends it) when it is a folder of this
 *  host that exists, else undefined, which leaves the dialog in the folder it used last. */
export function openDialogDir(dir, { isDir, hostSep = path.sep }) {
  const raw = dir ? String(dir) : '';
  const win = WIN_ABS.test(raw);
  if (!((win && hostSep === '\\') || (!win && POSIX_ABS.test(raw) && hostSep === '/'))) return undefined;
  const f = win ? path.win32 : path.posix;
  const d = f.dirname(f.join(raw, 'x')); // the folder without a trailing separator
  return isDir(d) ? d : undefined;
}
