// An export's warnings box appears only when the file was written: a cancelled Save As (or print) dialog shows nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverWithWarnings } from '../renderer/files.js';

test('export with warnings and a cancelled save dialog: no warnings box', async () => {
  const shown = [];
  const show = async (title, text) => { shown.push([title, text]); };
  const warnings = ['2 text characters could not be drawn'];
  for (const cancelled of [null, false, undefined]) {
    assert.equal(await deliverWithWarnings(async () => cancelled, warnings, 'PDF exported with warnings', show), false);
  }
  assert.deepEqual(shown, [], 'nothing shown after a cancel');
  assert.equal(await deliverWithWarnings(async () => true, warnings, 'PDF exported with warnings', show), true);
  assert.deepEqual(shown, [['PDF exported with warnings', '2 text characters could not be drawn']]);
  assert.equal(await deliverWithWarnings(async () => true, [], 'SVG exported with warnings', show), true);
  assert.equal(shown.length, 1, 'no box without warnings');
});
