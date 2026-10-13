import test from 'node:test';
import assert from 'node:assert/strict';
import { dwgSaveAllowed, DWG_SAVE_DISABLED_TEXT, DWG_SAVE_PREF_LABEL, dwgOriginSaveText } from '../src/core/dwgpref.js';

test('DWG save is off unless the stored preference is exactly true', () => {
  for (const v of [undefined, null, false, 0, 1, 'true', 'yes', {}]) assert.equal(dwgSaveAllowed(v), false, String(v));
  assert.equal(dwgSaveAllowed(true), true);
});
test('messages name the problem, the way to enable it and DXF', () => {
  assert.match(DWG_SAVE_DISABLED_TEXT, /AutoCAD/); assert.match(DWG_SAVE_DISABLED_TEXT, /Preferences/); assert.match(DWG_SAVE_DISABLED_TEXT, /DXF/);
  assert.match(DWG_SAVE_PREF_LABEL, /layouts may not display correctly in AutoCAD/);
  assert.equal(dwgOriginSaveText('C:\\x\\Plan A.dwg'), 'This drawing was opened from DWG. It will be saved as DXF (Plan A.dxf) next to the original; the DWG is not changed.');
});
