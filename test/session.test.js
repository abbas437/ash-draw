import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSession, pushRecent, startupModeOf, isPathString, RECENT_MAX } from '../electron/sessionLists.js';

const lower = (p) => p.toLowerCase();

test('pushRecent puts the newest first, removes duplicates and keeps at most 15', () => {
  assert.deepEqual(pushRecent([], ['/a.dxf', '/b.dxf']), ['/b.dxf', '/a.dxf']);
  assert.deepEqual(pushRecent(['/b.dxf', '/a.dxf'], ['/a.dxf']), ['/a.dxf', '/b.dxf']);
  assert.deepEqual(pushRecent(['/X/A.DXF'], ['/x/a.dxf'], lower), ['/x/a.dxf']);
  const many = Array.from({ length: 20 }, (_, i) => `/f${i}.dxf`);
  const r = pushRecent([], many);
  assert.equal(r.length, RECENT_MAX);
  assert.equal(r[0], '/f19.dxf');
  assert.equal(r.at(-1), '/f5.dxf');
});

test('pushRecent drops entries that are not absolute paths', () => {
  assert.deepEqual(pushRecent(['rel.dxf', 7, '/ok.dxf'], ['', 'x.dxf', '/n.dxf']), ['/n.dxf', '/ok.dxf']);
});

test('cleanSession keeps accepted, unique, absolute paths and a valid active file', () => {
  const v = { files: ['/a.dxf', '/b.dxf', '/A.dxf', 'rel.dxf', '/never.dxf', 5], active: '/b.dxf' };
  const r = cleanSession(v, (p) => p !== '/never.dxf', lower);
  assert.deepEqual(r, { files: ['/a.dxf', '/b.dxf'], active: '/b.dxf' });
  assert.equal(cleanSession({ files: ['/a.dxf'], active: '/never.dxf' }, (p) => p !== '/never.dxf').active, null);
  assert.equal(cleanSession({ files: '/a.dxf' }, () => true), null);
  assert.equal(cleanSession(null, () => true), null);
  assert.equal(cleanSession([], () => true), null);
});

test('startupModeOf defaults to ask', () => {
  assert.equal(startupModeOf(undefined), 'ask');
  assert.equal(startupModeOf('bogus'), 'ask');
  assert.equal(startupModeOf('restore'), 'restore');
  assert.equal(startupModeOf('new'), 'new');
  assert.equal(isPathString('/a\0b'), false);
});
