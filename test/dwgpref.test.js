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
import { dwgVersionFromHeader, dwgSaveVersionFrom, ODA_SAVE_HINT, DWG_SAVE_VERSIONS } from '../src/core/dwgpref.js';
test('DWG header -> save version; older than 2000 -> 2000; not a DWG -> null', () => {
  const m = { AC1032: 'acad2018', AC1027: 'acad2013', AC1024: 'acad2010', AC1021: 'acad2007', AC1018: 'acad2004', AC1015: 'acad2000', AC1014: 'acad2000', AC1012: 'acad2000', AC1009: 'acad2000' };
  for (const [h, v] of Object.entries(m)) assert.equal(dwgVersionFromHeader(h), v, h);
  assert.equal(dwgVersionFromHeader(new TextEncoder().encode('AC1027\0\0rest')), 'acad2013', 'bytes');
  for (const h of ['', 'AC1099', '  0\nSE', undefined]) assert.equal(dwgVersionFromHeader(h), null, String(h));
});
test('DWG save version choice: stored value if offered, else 2018; the ODA hint names 2018', () => {
  assert.equal(DWG_SAVE_VERSIONS[0].id, 'acad2018');
  assert.equal(dwgSaveVersionFrom('acad2004'), 'acad2004');
  for (const v of [undefined, 'r2000', 'ACAD2013', 3]) assert.equal(dwgSaveVersionFrom(v), 'acad2018');
  assert.equal(ODA_SAVE_HINT, 'Install the free ODA File Converter for reliable DWG 2018 saving.');
});
