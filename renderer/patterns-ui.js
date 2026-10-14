// ASH Draw Studio - hatch patterns loaded from .pat files: Format > Load patterns from .pat file…, Format > Patterns…,
// and the Hatch group's pattern list. The parsed definitions (not the file path) are kept in the setting 'hatch.patterns'.
import { parsePat, PAT_LIMITS } from '../src/core/patfile.js';
import { PATTERN_NAMES, setLoadedPatterns, loadedPatterns } from '../src/core/patterns.js';
import { el, modal, toast } from './ui.js';

export const PATTERNS_KEY = 'hatch.patterns';
const SETTINGS_MAX = 60 * 1024; // the desktop settings store refuses a value over 64 KB

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** the setting's value, checked entry by entry (the settings file can be edited by hand) */
export function cleanPatterns(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const p of v.slice(0, PAT_LIMITS.maxPatterns)) {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.lines)) continue;
    const lines = p.lines.slice(0, PAT_LIMITS.maxLinesPerPattern).filter((l) => l && finite(l.angle) && Array.isArray(l.base) && Array.isArray(l.delta)
      && l.base.length === 2 && l.delta.length === 2 && [...l.base, ...l.delta].every(finite) && l.delta[1] !== 0
      && Array.isArray(l.dashes) && l.dashes.length <= PAT_LIMITS.maxDashes && l.dashes.every(finite));
    if (!lines.length) continue;
    out.push({ name: p.name.trim().toUpperCase(), description: String(p.description ?? ''), units: p.units ?? null, type: p.type ?? null, lines });
  }
  return out;
}

/** fill the Hatch group's pattern list: the built-in names, then the loaded ones in a "Loaded" group */
export function refreshPatternSelect(app) {
  const sel = app.patternSel;
  if (!sel) return;
  const loaded = loadedPatterns().map((p) => p.name);
  const own = PATTERN_NAMES.filter((n) => !loaded.includes(n));
  const opt = (n) => el('option', { value: n, text: n });
  sel.replaceChildren(...own.map(opt), ...(loaded.length ? [el('optgroup', { label: 'Loaded' }, loaded.map(opt))] : []));
  if (![...own, ...loaded].includes(app.defaults.hatchPattern)) app.defaults.hatchPattern = 'ANSI31';
  sel.value = app.defaults.hatchPattern;
}

/** install `list` as the loaded patterns, save it and show it; the active drawing is redrawn (hatches found by name) */
async function apply(app, list, api) {
  setLoadedPatterns(list);
  refreshPatternSelect(app);
  app.vp?.refreshStructure?.();
  await api.settingsSet?.(PATTERNS_KEY, list)?.catch?.(() => {});
}

export async function loadSavedPatterns(app, api) {
  const v = await api.settingsGet?.(PATTERNS_KEY);
  setLoadedPatterns(cleanPatterns(v));
  refreshPatternSelect(app);
}

/** Format > Load patterns from .pat file…: parse, add (a name already loaded is replaced), report what was read */
export async function loadPatFile(app, api) {
  const files = await api.openFiles({ filters: [{ name: 'Hatch patterns (*.pat)', extensions: ['pat'] }], multiple: true });
  if (!files?.length) return;
  const got = [], problems = [];
  for (const f of files) {
    const { patterns, errors } = parsePat(new TextDecoder('utf-8').decode(f.bytes));
    got.push(...patterns);
    for (const e of errors) problems.push(`${f.name}${e.line ? `, line ${e.line}` : ''}: ${e.message}`);
  }
  const byName = new Map(loadedPatterns().map((p) => [p.name, p]));
  for (const p of got) { byName.delete(p.name); byName.set(p.name, p); }
  let list = [...byName.values()];
  let dropped = 0;
  while (list.length && JSON.stringify(list).length > SETTINGS_MAX) { list.shift(); dropped++; }
  await apply(app, list, api);
  const head = got.length ? `${got.length} pattern${got.length === 1 ? '' : 's'} loaded: ${got.slice(0, 12).map((p) => p.name).join(', ')}${got.length > 12 ? ', …' : ''}.` : 'No patterns were found in the file.';
  const more = dropped ? [el('p', { text: `${dropped} older loaded pattern${dropped === 1 ? ' was' : 's were'} removed to keep the saved list within the settings size limit.` })] : [];
  if (problems.length || dropped || !got.length) {
    await modal('Load hatch patterns', [el('p', { text: head }), ...more, ...(problems.length ? [el('p', { text: 'Lines that were skipped:' }), el('pre', { class: 'list-text', text: problems.slice(0, 50).join('\n') + (problems.length > 50 ? `\n… ${problems.length - 50} more` : '') })] : [])]);
  } else toast(head, 4000);
}

/** Format > Patterns…: the loaded patterns, each with Remove */
export async function patternsDialog(app, api) {
  const body = el('div', { id: 'patterns-list' });
  const fill = () => {
    const list = loadedPatterns();
    body.replaceChildren(list.length
      ? el('table', { class: 'pat-table' }, [
        el('tr', {}, ['Name', 'Description', 'Lines', 'Units', ''].map((t) => el('th', { text: t }))),
        ...list.map((p) => el('tr', {}, [
          el('td', { text: p.name }), el('td', { text: p.description }), el('td', { text: String(p.lines.length) }), el('td', { text: p.units ?? '' }),
          el('td', {}, el('button', { 'data-remove': p.name, onclick: async () => { await apply(app, loadedPatterns().filter((q) => q !== p), api); fill(); } }, 'Remove')),
        ])),
      ])
      : el('p', { text: 'No patterns are loaded. Format > Load patterns from .pat file… adds the patterns of an acad.pat / acadiso.pat style file.' }));
  };
  fill();
  await modal('Hatch patterns', [body, el('p', { text: 'Hatches already drawn keep their pattern lines in the drawing; removing a pattern only affects new hatches.' })]);
}
