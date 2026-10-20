// Unit tests for the xref / image path policy (reviewer #22). Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRefAccess } from './refAccess.js';

const dwgOrDxf = (ext) => ext === '.dxf' || ext === '.dwg';

test('refAccess: host folder and subfolders load without asking; other folders and UNC paths only after "Load", never touched before', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-refs-'));
  try {
    const proj = path.join(root, 'proj'), other = path.join(root, 'other');
    for (const f of [path.join(proj, 'in.dxf'), path.join(proj, 'sub', 'deep.dwg'), path.join(other, 'far.dxf')]) {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, '0\nEOF\n');
    }
    const host = path.join(proj, 'a.dwg');
    const touched = [];
    const isFile = (p) => { touched.push(p); return fs.stat(p).then((s) => s.isFile(), () => false); };
    const refs = createRefAccess({ pathLib: path, isFile });
    const UNC = '\\\\server\\share\\x.dwg';
    const viaUnc = (p) => /server/i.test(p);

    // inside: relative, subfolder, an absolute path that points into the folder, the bare file name
    assert.deepEqual(await refs.find(host, 'in.dxf', dwgOrDxf), { path: path.join(proj, 'in.dxf') });
    assert.deepEqual(await refs.find(host, 'sub\\deep.dwg', dwgOrDxf), { path: path.join(proj, 'sub', 'deep.dwg') });
    assert.deepEqual(await refs.find(host, path.join(proj, 'sub', 'deep.dwg'), dwgOrDxf), { path: path.join(proj, 'sub', 'deep.dwg') });
    assert.deepEqual(await refs.find(host, '/elsewhere/in.dxf', dwgOrDxf), { path: path.join(proj, 'in.dxf') }, 'the file name in the host folder');

    // outside: an absolute path elsewhere, a relative path leaving the folder, a UNC path - refused, not stat'ed
    const far = path.join(other, 'far.dxf');
    assert.deepEqual(await refs.find(host, far, dwgOrDxf), { refused: [far], declined: false });
    assert.deepEqual(await refs.find(host, '../other/far.dxf', dwgOrDxf), { refused: [far], declined: false });
    const unc = await refs.find(host, UNC, dwgOrDxf);
    assert.equal(unc.refused.length, 1);
    assert.ok(viaUnc(unc.refused[0]), unc.refused[0]);
    assert.ok(!touched.includes(far), 'an outside path is not looked at before the decision');
    assert.ok(!touched.some(viaUnc), 'a UNC path is never passed to fs before the decision');

    // a decision cannot approve a path main never reported, nor one reported for another host
    assert.equal(refs.decide(host, true, ['/etc/passwd.dxf']), true);
    assert.equal(await refs.find(host, '/etc/passwd.dxf', dwgOrDxf).then((r) => r.refused?.length), 1);
    const other2 = path.join(other, 'b.dwg');
    assert.deepEqual(await refs.find(other2, 'far.dxf', dwgOrDxf), { path: far }, 'its own folder for that host');

    // "Load": the listed paths are now read
    refs.decide(host, true, [far, unc.refused[0]]);
    assert.deepEqual(await refs.find(host, far, dwgOrDxf), { path: far });
    assert.equal(await refs.find(host, UNC, dwgOrDxf), null, 'approved, looked for (does not exist)');
    assert.ok(touched.some(viaUnc), 'after the decision the UNC path is read');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('refAccess: "Don\'t load" holds for the host for the session; granted paths and Windows rules', async () => {
  const touched = [];
  const refs = createRefAccess({ pathLib: path.win32, isFile: async (p) => { touched.push(p); return false; }, isGranted: (p) => p.toLowerCase() === 'e:\\chosen\\c.dwg' });
  const host = 'D:\\Proj\\a.dwg';
  assert.equal(refs.inside(host, 'd:\\proj\\SUB\\x.dwg'), true, 'case-insensitive');
  assert.equal(refs.inside(host, 'D:\\Proj2\\x.dwg'), false, 'a sibling folder with the same prefix');
  assert.equal(refs.inside(host, '\\\\server\\share\\x.dwg'), false);
  assert.equal(refs.inside(host, 'Z:\\Proj\\x.dwg'), false, 'a mapped drive is just another absolute path');
  assert.deepEqual(await refs.find(host, '//server/share/n.dwg', dwgOrDxf), { refused: ['\\\\server\\share\\n.dwg'], declined: false });
  assert.equal(await refs.find(host, 'E:\\chosen\\c.dwg', dwgOrDxf), null, 'a granted path is looked for without asking');
  assert.ok(touched.includes('E:\\chosen\\c.dwg'));
  refs.decide(host, false, []);
  assert.deepEqual(await refs.find(host, '//server/share/n.dwg', dwgOrDxf), { refused: ['\\\\server\\share\\n.dwg'], declined: true });
  assert.equal(refs.decide(host, true, ['\\\\server\\share\\n.dwg']), false, 'declined for the session');
  assert.deepEqual(await refs.find(host, '\\\\server\\share\\n.dwg', dwgOrDxf), { refused: ['\\\\server\\share\\n.dwg'], declined: true });
  assert.ok(!touched.some((p) => /server/i.test(p)));
});
