// ASH Draw Studio - the unit of a unitless drawing ($INSUNITS 0) for this session.
// Before the first scaled plot, compare or measure of a unitless drawing the user is asked once what one drawing unit is;
// the answer belongs to the drawing's tab for this session (tab.assumedUnits) and is never written into the file;
// it is also remembered per file in the settings (unit-memory.js) and preselected the next time.
import { el, modal } from './ui.js';
import { UNIT_ANSWERS_KEY, cleanUnitAnswers, recallUnit, rememberUnit, unitKey } from './unit-memory.js';

// the answers remembered per file (a list of [key, unit code], oldest first), loaded on first use
let answers = null;
const loadAnswers = async () => answers ??= cleanUnitAnswers(await window.api?.settingsGet?.(UNIT_ANSWERS_KEY)?.catch?.(() => undefined));

/** the choices offered, as $INSUNITS codes */
export const ASSUMED_UNITS = [[4, 'Millimetre'], [6, 'Metre'], [1, 'Inch'], [2, 'Foot']];

/** the unit code `tab`'s drawing is measured, plotted and compared in: its $INSUNITS, or for a unitless drawing the
 *  unit chosen for this session (0 = not asked yet) */
export const unitsOf = (tab) => tab?.doc?.units || tab?.assumedUnits || 0;

/** the units of `tab`, asking once for a unitless drawing; null when the user cancels */
export async function ensureUnits(tab) {
  const u = unitsOf(tab);
  if (u || !tab) return u;
  const key = unitKey(tab.file), kept = recallUnit(await loadAnswers(), key);
  const keptName = ASSUMED_UNITS.find(([code]) => code === kept)?.[1];
  const r = await modal('Drawing units', el('div', {}, el('p', { text: 'This drawing has no units set. Treat 1 drawing unit as:' }),
    keptName ? el('p', { id: 'units-remembered', text: `${keptName} (remembered from last time)` }) : null),
    [...ASSUMED_UNITS.map(([code, label], i) => ({ label, value: code, primary: kept ? code === kept : i === 0 })), { label: 'Cancel', value: null }]);
  if (!r) return null;
  tab.assumedUnits = r;
  if (key) { // a confirmed remembered answer is saved too, so it becomes the newest entry
    answers = rememberUnit(answers, key, r);
    window.api?.settingsSet?.(UNIT_ANSWERS_KEY, answers)?.catch?.(() => {});
  }
  return r;
}
