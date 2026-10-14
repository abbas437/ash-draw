// Unit tests for the two-copies-running marker. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foreignInstance, readMarker, writeMarker, removeMarker, warningText, MARKER } from './instance.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ash-inst-'));
const mine = { exe: '/apps/portable/ASH.exe', version: '1.2.0', pid: 100 };
const put = (d, o) => fs.writeFile(path.join(d, MARKER), typeof o === 'string' ? o : JSON.stringify(o));

test('alive pid with a different exe: warns, naming the other exe and version', async () => {
  const d = await tmp();
  await put(d, { pid: 200, exe: '/Program Files/ASH/ASH.exe', version: '1.1.0', started: 'x' });
  const m = await foreignInstance(d, { ...mine, alive: () => true, win: false });
  assert.equal(m.pid, 200);
  assert.match(warningText(m), /\/Program Files\/ASH\/ASH\.exe.*1\.1\.0.*Close one of them/);
});

test('same exe: no warning (Windows compares case-insensitively)', async () => {
  const d = await tmp();
  await put(d, { pid: 200, exe: 'C:\\Apps\\ASH.exe', version: '1.2.0', started: 'x' });
  assert.equal(await foreignInstance(d, { exe: 'c:\\apps\\ash.exe', pid: 100, alive: () => true, win: true }), null);
});

test('dead pid: no warning, and writing the marker replaces the stale file', async () => {
  const d = await tmp();
  await put(d, { pid: 200, exe: '/other/ASH.exe', version: '1.0.0', started: 'x' });
  assert.equal(await foreignInstance(d, { ...mine, alive: () => false, win: false }), null);
  await writeMarker(d, mine);
  const m = await readMarker(d);
  assert.equal(m.pid, 100); assert.equal(m.exe, mine.exe); assert.equal(m.version, '1.2.0'); assert.ok(m.started);
});

test('corrupt or missing file: no warning', async () => {
  const d = await tmp();
  assert.equal(await foreignInstance(d, { ...mine, alive: () => true, win: false }), null);
  await put(d, '{not json');
  assert.equal(await foreignInstance(d, { ...mine, alive: () => true, win: false }), null);
  await put(d, { pid: 'x' });
  assert.equal(await foreignInstance(d, { ...mine, alive: () => true, win: false }), null);
});

test('removeMarker deletes our marker but leaves another copy\'s', async () => {
  const d = await tmp();
  await writeMarker(d, mine);
  await removeMarker(d, 999);
  assert.ok(await readMarker(d));
  await removeMarker(d, 100);
  assert.equal(await readMarker(d), null);
});
