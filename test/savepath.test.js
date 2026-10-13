import test from 'node:test';
import assert from 'node:assert/strict';
import { savePathIn } from '../renderer/files.js';
import { saveDxf, saveDwg } from '../renderer/files.js';
import { saveDialogDefault } from '../electron/savePath.js';

test('savePathIn: the open file folder + the suggested name; no path = just the name', () => {
  assert.equal(savePathIn('C:\\Proj\\Plans\\site.dwg', 'site.pdf'), 'C:\\Proj\\Plans\\site.pdf');
  assert.equal(savePathIn('/home/a/proj/site.dxf', 'site.svg'), '/home/a/proj/site.svg');
  assert.equal(savePathIn(null, 'x.pdf'), 'x.pdf');
  assert.equal(savePathIn(undefined, 'x.pdf'), 'x.pdf');
  assert.equal(savePathIn('site.dxf', 'x.pdf'), 'x.pdf');
});

test('saveDxf / saveDwg pass the drawing folder to the save dialog', async () => {
  const seen = [];
  const api = { isElectron: true, saveFile: async (o) => { seen.push(o.defaultPath); return { path: 'p' }; },
    dwgAvailable: async () => ({ available: true }), dxfToDwg: async () => ({ dwgBytes: new Uint8Array([1]) }),
    dwgToDxf: async () => { throw new Error('skip verify'); } };
  const { newDocument } = await import('../src/core/model.js');
  await saveDxf(api, newDocument(), { path: null, name: 'a.dwg', fromPath: 'D:\\Jobs\\a.dwg' });
  await saveDwg(api, newDocument(), { name: 'a.dxf', fromPath: '/srv/jobs/a.dxf' });
  await saveDxf(api, newDocument(), { path: null, name: 'Untitled-1' });
  assert.deepEqual(seen, ['D:\\Jobs\\a.dxf', '/srv/jobs/a.dwg', 'Untitled-1.dxf']);
});

const dirs = (...d) => (p) => d.includes(p);
test('saveDialogDefault: POSIX host', () => {
  const o = { documents: '/home/u/Documents', isDir: dirs('/srv/jobs'), hostSep: '/' };
  assert.equal(saveDialogDefault('/srv/jobs/a.pdf', o), '/srv/jobs/a.pdf');
  assert.equal(saveDialogDefault('a.pdf', o), '/home/u/Documents/a.pdf');           // bare name: Documents
  assert.equal(saveDialogDefault('/missing/a.pdf', o), '/home/u/Documents/a.pdf');   // folder gone: Documents
  assert.equal(saveDialogDefault('C:\\Jobs\\a.pdf', o), '/home/u/Documents/a.pdf');  // foreign path: Documents, name kept
  assert.equal(saveDialogDefault('', o), '/home/u/Documents/drawing.dxf');
});
test('saveDialogDefault: Windows host', () => {
  const o = { documents: 'C:\\Users\\u\\Documents', isDir: dirs('D:\\Job Files\\Plans', '\\\\srv\\share\\p'), hostSep: '\\' };
  assert.equal(saveDialogDefault('D:\\Job Files\\Plans\\a.pdf', o), 'D:\\Job Files\\Plans\\a.pdf');
  assert.equal(saveDialogDefault('D:/Job Files/Plans/a.pdf', o), 'D:\\Job Files\\Plans\\a.pdf');
  assert.equal(saveDialogDefault('\\\\srv\\share\\p\\a.pdf', o), '\\\\srv\\share\\p\\a.pdf');
  assert.equal(saveDialogDefault('E:\\gone\\a.pdf', o), 'C:\\Users\\u\\Documents\\a.pdf');
  assert.equal(saveDialogDefault('a.pdf', o), 'C:\\Users\\u\\Documents\\a.pdf');
  assert.equal(saveDialogDefault('..\\..\\evil\\a.pdf', o), 'C:\\Users\\u\\Documents\\a.pdf'); // relative: Documents, name only
});

test('saveDwg: ODA versions get the full DXF (real dimensions); LibreDWG gets dimensions as geometry; a path overwrites in place', async () => {
  const { readDxf } = await import('../src/core/dxfRead.js');
  const { readFileSync } = await import('node:fs');
  const doc = readDxf(readFileSync(new URL('./fixtures/dims_r2000.dxf', import.meta.url)));
  const sent = [], wrote = [];
  const api = { isElectron: true, dwgAvailable: async () => ({ available: true }),
    dxfToDwg: async (dxf, v) => { sent.push([v, new TextDecoder().decode(dxf)]); return { dwgBytes: new Uint8Array([1]) }; },
    dwgToDxf: async () => { throw new Error('skip verify'); },
    writeFile: async (p) => { wrote.push(p); return { path: p, backup: '/j/a.bak' }; }, saveFile: async () => ({ path: '/j/new.dwg' }) };
  const r = await saveDwg(api, doc, { name: 'a.dwg', version: 'acad2013', path: '/j/a.dwg' });
  assert.deepEqual([r.path, r.version, r.backup, wrote], ['/j/a.dwg', 'acad2013', '/j/a.bak', ['/j/a.dwg']]);
  await saveDwg(api, doc, { name: 'a.dwg', version: 'r2000' });
  assert.deepEqual(sent.map((x) => x[0]), ['acad2013', 'r2000']);
  assert.match(sent[0][1], /\r?\n0\r?\nDIMENSION\r?\n/, 'ODA: the DIMENSION entity is written');
  assert.doesNotMatch(sent[1][1], /\r?\n0\r?\nDIMENSION\r?\n/, 'LibreDWG: dimensions as geometry');
});

test('saveDwg over a path: declining the read-back differences writes nothing', async () => {
  const { newDocument } = await import('../src/core/model.js');
  const writes = [];
  const api = { isElectron: true, dwgAvailable: async () => ({ available: true }), dxfToDwg: async () => ({ dwgBytes: new Uint8Array([1]) }),
    dwgToDxf: async () => { throw new Error('unreadable'); },
    writeFile: async (p) => { writes.push(p); return { path: p }; }, saveFile: async (o) => { writes.push(o.defaultPath); return { path: 'x' }; } };
  const seen = [];
  const r = await saveDwg(api, newDocument(), { name: 'a.dwg', version: 'acad2018', path: '/j/a.dwg', confirmDifferences: async (v) => { seen.push(v); return false; } });
  assert.equal(r, null);
  assert.equal(seen.length, 1);
  assert.deepEqual(writes, []);
});

test('saveDwg reports which converter read the DWG back, and the message names it', async () => {
  const { newDocument } = await import('../src/core/model.js');
  const { verificationMessage } = await import('../renderer/files.js');
  const KNOWN = '  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n0\n 20\n0\n 11\n10\n 21\n10\n  0\nENDSEC\n  0\nEOF\n';
  for (const converter of ['ODA', 'LibreDWG']) {
    const api = { isElectron: true, dwgAvailable: async () => ({ available: true }), dxfToDwg: async () => ({ dwgBytes: new Uint8Array([1]) }),
      dwgToDxf: async () => ({ dxfBytes: new TextEncoder().encode(KNOWN), converter }), writeFile: async (p) => ({ path: p }) };
    const r = await saveDwg(api, newDocument(), { name: 'a.dwg', version: 'acad2018', path: '/j/a.dwg' });
    assert.equal(r.readBack, converter);
    assert.equal(r.verification.ok, false, 'an extra LINE read back');
    const m = verificationMessage(r.verification, { oda: true });
    assert.match(m, converter === 'ODA' ? /read back through the ODA File Converter/ : /read back through the built-in LibreDWG converter/);
  }
});
