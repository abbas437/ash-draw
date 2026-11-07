// ASH Draw Studio - the unit answered for a unitless drawing, remembered per file (setting 'draw.unitAnswers').
// Pure functions over a list of [key, unit code] pairs, oldest first; no DOM, so they are unit-tested (test/unit-memory.test.js).

export const UNIT_ANSWERS_KEY = 'draw.unitAnswers';
export const UNIT_ANSWERS_MAX = 200;
const KEY_MAX = 240; // the settings value is limited to 64 KB: 200 entries of at most this key length fit
const CODES = [1, 2, 4, 6]; // inch, foot, millimetre, metre ($INSUNITS)

/** the key of a drawing: its full path (Windows paths compare case-insensitively); without a path (the browser build)
 *  its file name and size; null when neither identifies it */
export function unitKey(file) {
  if (!file) return null;
  const path = typeof file.path === 'string' ? file.path : '';
  if (path) return `p:${(/^[A-Za-z]:[\\/]|^\\\\/.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path).slice(-KEY_MAX)}`;
  if (typeof file.name === 'string' && file.name && Number.isFinite(file.size)) return `n:${file.name.toLowerCase().slice(-KEY_MAX)}:${file.size}`;
  return null;
}

/** a stored value made safe: only [string, known unit code] pairs, newest 200, one entry per key */
export function cleanUnitAnswers(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Map();
  for (const p of v) if (Array.isArray(p) && typeof p[0] === 'string' && p[0] && CODES.includes(p[1])) { seen.delete(p[0]); seen.set(p[0], p[1]); }
  return [...seen].slice(-UNIT_ANSWERS_MAX);
}

/** the remembered unit code for key, or 0 */
export const recallUnit = (list, key) => (key ? list.find((p) => p[0] === key)?.[1] ?? 0 : 0);

/** a new list with key -> code as the newest entry; beyond 200 entries the oldest are dropped */
export function rememberUnit(list, key, code) {
  if (!key || !CODES.includes(code)) return list;
  return [...list.filter((p) => p[0] !== key), [key, code]].slice(-UNIT_ANSWERS_MAX);
}
