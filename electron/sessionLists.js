// ASH Draw Studio - last-session and recent-files lists (pure helpers, no Electron; used by main.js).
import path from 'node:path';

export const RECENT_MAX = 15;
export const SESSION_MAX_FILES = 200;
export const STARTUP_MODES = ['ask', 'restore', 'new'];

/** an absolute path string of sane length */
export const isPathString = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p);

/** the start-up mode setting, 'ask' when unset or unknown */
export const startupModeOf = (v) => (STARTUP_MODES.includes(v) ? v : 'ask');

/**
 * A session `{ files: [path], active }` keeping only paths that pass `accept`, without duplicates
 * (compared by `key`); `active` is null unless it is one of the kept files. null when `v` is not a session.
 */
export function cleanSession(v, accept, key = (p) => p) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.files)) return null;
  const files = [];
  const seen = new Set();
  for (const p of v.files.slice(0, SESSION_MAX_FILES)) {
    if (!isPathString(p) || seen.has(key(p)) || !accept(p)) continue;
    seen.add(key(p));
    files.push(p);
  }
  const active = isPathString(v.active) && seen.has(key(v.active)) ? files.find((p) => key(p) === key(v.active)) : null;
  return { files, active };
}

/** the recent list after opening `paths` (in that order): newest first, no duplicates, at most `max` */
export function pushRecent(list, paths, key = (p) => p, max = RECENT_MAX) {
  let out = list.filter(isPathString);
  for (const p of paths) if (isPathString(p)) out = [p, ...out.filter((q) => key(q) !== key(p))];
  return out.slice(0, max);
}
