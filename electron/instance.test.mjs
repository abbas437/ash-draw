// Unit tests for the second-copy helpers. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignCopyMessage, isForeignCopy, lockData } from './instance.js';

const mine = { exe: '/apps/zip/ASH.exe', version: '1.2.0' };

test('a different exe is foreign; the message names both copies', () => {
  const other = { exe: '/Program Files/ASH/ASH.exe', version: '1.1.0' };
  assert.equal(isForeignCopy(other, { ...mine, win: false }), true);
  assert.equal(foreignCopyMessage(other, mine),
    'ASH Draw Studio 1.2.0 is already running from /apps/zip/ASH.exe. The copy you started (1.1.0, /Program Files/ASH/ASH.exe) '
    + 'shares the same settings, so it was not opened. Close this window first to use the other copy.');
});

test('the same exe is not foreign; Windows compares case-insensitively, others do not', () => {
  assert.equal(isForeignCopy({ exe: 'c:\\apps\\ash.exe' }, { exe: 'C:\\Apps\\ASH.exe', win: true }), false);
  assert.equal(isForeignCopy({ exe: '/a/ash' }, { exe: '/a/ASH', win: false }), true);
  assert.equal(isForeignCopy({ exe: mine.exe }, { ...mine, win: false }), false);
});

test('missing or malformed lock data is not foreign (an older copy sends none)', () => {
  for (const d of [undefined, null, 'x', {}, { exe: 5 }, { exe: '' }]) assert.equal(isForeignCopy(d, { ...mine, win: false }), false);
});

test('lockData carries the exe and version only', () => {
  assert.deepEqual(lockData({ ...mine, extra: 1 }), mine);
});
