// ASH Draw Studio - the review round (Rev.00, Rev.01 ...) of the Markups panel, remembered per drawing (setting 'markup.round').
// Pure functions over a list of [drawing key (unit-memory.js unitKey), round label] pairs, oldest first; no DOM, so they are
// unit-tested (test/markup-round.test.js).
import { nextRevLabel } from '../src/core/markup.js';

export const ROUND_KEY = 'markup.round';
export const ROUND_MAX = 200;
export const LABEL_MAX = 20; // as MARKUP_REV_MAX, the most characters of a rev label in the XDATA
/** a label trimmed and cut to LABEL_MAX characters (code points) */
export const roundLabel = (l) => [...String(l ?? '').trim()].slice(0, LABEL_MAX).join('');

/** the round a drawing's markups suggest: nextRevLabel of every rev and follow-up rev they carry; none -> 'Rev.00' */
export function defaultRound(markups) {
  const labels = (markups ?? []).flatMap((m) => [m.rev, ...(m.followUps ?? []).map((f) => f.rev)]).filter((l) => String(l ?? '').trim());
  return labels.length ? nextRevLabel(labels) : 'Rev.00';
}

/** a stored value made safe: only [non-empty string, non-empty label] pairs, one per key, newest 200 */
export function cleanRounds(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Map();
  for (const p of v) {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || !p[0] || typeof p[1] !== 'string' || !p[1].trim()) continue;
    seen.delete(p[0]); seen.set(p[0], roundLabel(p[1]));
  }
  return [...seen].slice(-ROUND_MAX);
}

/** the remembered round of key, or '' */
export const recallRound = (list, key) => (key ? list.find((p) => p[0] === key)?.[1] ?? '' : '');

/** a new list with key -> label as the newest entry; an empty label forgets the key; beyond 200 entries the oldest go */
export function rememberRound(list, key, label) {
  if (!key) return list;
  const rest = list.filter((p) => p[0] !== key), l = roundLabel(label);
  return (l ? [...rest, [key, l]] : rest).slice(-ROUND_MAX);
}

/** the round of a drawing: the one stored for its key, else the one kept for its tab (typed or used this session), else
 *  `fallback` (the panel: defaultRound of the markups the tab had when first shown) */
export const roundOf = (list, key, tabRound, fallback) => recallRound(list, key) || tabRound || fallback || 'Rev.00';

/** a round label used in a drawing (a markup placed, a follow-up saved, an import): stored for its key the first time
 *  only, so reopening the drawing keeps the round; returns the list (the same one when nothing changes) */
export const useRound = (list, key, label) => (key && !recallRound(list, key) && roundLabel(label) ? rememberRound(list, key, label) : list);
