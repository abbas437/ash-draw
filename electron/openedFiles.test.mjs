import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openedFiles } from './openedFiles.js';

test('dialog:open: a .dwg comes back as {path, name} without being read; other files with their bytes', async () => {
  const granted = [], read = [];
  const files = await openedFiles([path.resolve('/d/plan.DWG'), path.resolve('/d/site.dxf'), path.resolve('/d/a.las')], {
    grant: (p) => { granted.push(p); return p; },
    read: async (p) => { read.push(p); return new Uint8Array([7]); },
  });
  assert.deepEqual(files, [
    { path: path.resolve('/d/plan.DWG'), name: 'plan.DWG' },
    { path: path.resolve('/d/site.dxf'), name: 'site.dxf', bytes: new Uint8Array([7]) },
    { path: path.resolve('/d/a.las'), name: 'a.las', bytes: new Uint8Array([7]) },
  ]);
  assert.equal(granted.length, 3, 'every chosen file is granted');
  assert.deepEqual(read, [path.resolve('/d/site.dxf'), path.resolve('/d/a.las')], 'the DWG is not read');
});
