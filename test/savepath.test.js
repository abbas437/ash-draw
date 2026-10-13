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
