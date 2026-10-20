// ASH Draw Studio - the unit of a unitless drawing ($INSUNITS 0) for this session.
// Before the first scaled plot, compare or measure of a unitless drawing the user is asked once what one drawing unit is;
// the answer belongs to the drawing's tab for this session (tab.assumedUnits) and is never written into the file.
import { el, modal } from './ui.js';

/** the choices offered, as $INSUNITS codes */
export const ASSUMED_UNITS = [[4, 'Millimetre'], [6, 'Metre'], [1, 'Inch'], [2, 'Foot']];

/** the unit code `tab`'s drawing is measured, plotted and compared in: its $INSUNITS, or for a unitless drawing the
 *  unit chosen for this session (0 = not asked yet) */
export const unitsOf = (tab) => tab?.doc?.units || tab?.assumedUnits || 0;

/** the units of `tab`, asking once for a unitless drawing; null when the user cancels */
export async function ensureUnits(tab) {
  const u = unitsOf(tab);
  if (u || !tab) return u;
  const r = await modal('Drawing units', el('p', { text: 'This drawing has no units set. Treat 1 drawing unit as:' }),
    [...ASSUMED_UNITS.map(([code, label], i) => ({ label, value: code, primary: i === 0 })), { label: 'Cancel', value: null }]);
  if (!r) return null;
  tab.assumedUnits = r;
  return r;
}
