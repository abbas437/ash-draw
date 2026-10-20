// Unit tests for the second-copy helpers. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foreignCopyMessage, isForeignCopy, lockData, onSecondInstance } from './instance.js';

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

// reviewer #21: a double-clicked drawing opens in the running window, whichever copy was started
function secondInstance(additionalData) {
  const log = [];
  onSecondInstance({ argv: ['ASH.exe', '--flag', 'Plan A.dwg', 'b.dxf'], cwd: '/work', additionalData }, {
    me: { ...mine, win: false },
    drawingArgs: (argv, cwd) => argv.slice(1).filter((a) => !a.startsWith('-')).map((a) => `${cwd}/${a}`),
    openFile: (p) => log.push(['open', p]),
    notify: (m) => log.push(['notice', m]),
    focus: () => log.push(['focus']),
  });
  return log;
}

test('second instance, the same copy: its files are opened here and the window is focused; no notice', () => {
  assert.deepEqual(secondInstance(lockData(mine)), [['open', '/work/Plan A.dwg'], ['open', '/work/b.dxf'], ['focus']]);
  assert.deepEqual(secondInstance(undefined), [['open', '/work/Plan A.dwg'], ['open', '/work/b.dxf'], ['focus']], 'an older copy sends no data');
});

test('second instance, a different copy: its files are opened here too, the window is focused, and the notice is shown', () => {
  const other = { exe: '/Program Files/ASH/ASH.exe', version: '1.1.0' };
  assert.deepEqual(secondInstance(other), [['open', '/work/Plan A.dwg'], ['open', '/work/b.dxf'], ['focus'],
    ['notice', `${foreignCopyMessage(other, mine)} The 2 drawings you opened are shown in this window.`]]);
  assert.match(foreignCopyMessage(other, mine, 1), / The drawing you opened is shown in this window\.$/);
});

test('main.js hands its second-instance event to onSecondInstance with forwardFile', () => {
  const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const at = src.indexOf("app.on('second-instance'");
  assert.ok(at >= 0);
  const body = src.slice(at, src.indexOf('\n}));', at));
  assert.match(body, /onSecondInstance\(/);
  assert.match(body, /openFile: forwardFile/);
  assert.match(body, /drawingArgs,/);
});
