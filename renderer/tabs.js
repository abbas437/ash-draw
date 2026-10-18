// ASH Draw Studio - per-drawing state for the file tabs (pure helpers, no DOM).
import { Session } from '../src/core/edit.js';

let nextId = 1;

/** Everything one open drawing owns: document, file, undo/redo (its own Session), view, selection, current layer. */
export function createDocState(doc, file) {
  return {
    id: nextId++,
    doc,
    session: new Session(doc), // each tab has its own undo/redo stacks
    file: { ...file },
    state: { layer: doc.layers.has('0') ? '0' : [...doc.layers.keys()][0], color: 256, linetype: 'BYLAYER', lineweight: -1 },
    view: null,       // {cx, cy, zoom} while the tab is in the background; null = zoom to fit when shown
    selection: [],
    lastPoint: null,
    scene: null,      // cached scene and spatial index while in the background
    index: null,
  };
}

export const pathKey = (p) => (/^[A-Za-z]:[\\/]|^\\\\/.test(p) ? p.replace(/\//g, '\\').toLowerCase() : p);

/** the tab showing the file at `path`, if any (Windows paths compare case-insensitively) */
export function findTabByPath(tabs, path) {
  if (!path) return null;
  const k = pathKey(path);
  return tabs.find((t) => t.file.path && pathKey(t.file.path) === k) ?? null;
}

/** the session's `files` ({path, name}) minus those already open as recovered drawings (tab.recoveredFrom.path) */
export function withoutRecovered(files, tabs) {
  const rec = new Set(tabs.filter((t) => t.recoveredFrom?.path).map((t) => pathKey(t.recoveredFrom.path)));
  return files.filter((f) => !f.path || !rec.has(pathKey(f.path)));
}

/** index of the tab to show after closing tab `closing` of `count`, when tab `active` was shown (-1 when none remain) */
export function indexAfterClose(count, closing, active) {
  if (count <= 1) return -1;
  if (closing < active) return active - 1;
  if (closing > active) return active;
  return Math.min(closing, count - 2);
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the next (step 1) or previous (step -1) tab index, wrapping around */
export const cycleIndex = (count, active, step) => (count ? (((active + step) % count) + count) % count : -1);

/** an unchanged, never-saved empty drawing: opening a file replaces it instead of adding a tab */
export const isBlankTab = (t) => !!t && !t.file.path && !t.session.dirty && t.doc.entities.length === 0;

/** ids a tab's context menu closes, in strip order: which = 'this' | 'others' | 'left' | 'right' | 'all' */
export function tabsToClose(ids, id, which) {
  const i = ids.indexOf(id);
  if (which === 'all') return [...ids];
  if (i < 0) return [];
  if (which === 'this') return [id];
  if (which === 'others') return ids.filter((x) => x !== id);
  if (which === 'left') return ids.slice(0, i);
  if (which === 'right') return ids.slice(i + 1);
  return [];
}
