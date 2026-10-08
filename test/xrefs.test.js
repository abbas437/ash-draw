import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addBlock, addEntity } from '../src/core/model.js';
import { joinRel, loadXrefs, relativePath, samePath } from '../renderer/xrefs.js';

test('xref paths: relative to the host folder on the same drive, absolute otherwise', () => {
  assert.equal(relativePath('C:\\w\\host.dwg', 'C:\\w\\sub\\ref.dxf'), '.\\sub\\ref.dxf');
  assert.equal(relativePath('C:\\w\\a\\host.dwg', 'c:\\W\\b\\ref.dxf'), '..\\b\\ref.dxf');
  assert.equal(relativePath('C:\\w\\host.dwg', 'D:\\p\\ref.dxf'), 'D:\\p\\ref.dxf');
  assert.equal(relativePath('/w/host.dxf', '/w/sub/ref.dxf'), './sub/ref.dxf');
  assert.equal(relativePath('/w/x/host.dxf', '/other/ref.dxf'), '../../other/ref.dxf');
  assert.equal(relativePath(null, '/w/ref.dxf'), '/w/ref.dxf');
  assert.equal(joinRel('./sub', 'n.dxf'), 'sub/n.dxf');
  assert.equal(joinRel('.\\sub', '..\\n.dxf'), 'n.dxf');
  assert.equal(joinRel('../x', '../n.dxf'), '../n.dxf');
  assert.equal(joinRel('sub', '/abs/n.dxf'), '/abs/n.dxf');
  assert.ok(samePath('C:\\W\\a.dxf', 'c:/w/A.DXF') && !samePath('/w/a', '/w/A'));
});

// in-memory files: path -> doc with xref blocks { name: refPath } and one LINE on layer L
const fileDoc = (refs) => {
  const d = newDocument();
  addEntity(d, { type: 'LINE', layer: '0', p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } });
  for (const [n, p] of Object.entries(refs)) addBlock(d, n, { x: 0, y: 0 }, []).xref = { path: p, status: 'pending' };
  return d;
};
const fsRead = (files) => async (ref) => { const p = joinRel('/w', ref.replace(/^\.\//, '')); return files[p] ? { path: p, bytes: p } : null; };

test('xref loading: nested xrefs, cycle protection, missing files', async () => {
  const files = {
    '/w/host.dxf': { R: './sub/ref.dxf', GONE: 'gone.dxf' },
    '/w/sub/ref.dxf': { N: 'n.dxf', BACK: '../host.dxf' },
    '/w/sub/n.dxf': {},
  };
  const host = fileDoc(files['/w/host.dxf']);
  const st = await loadXrefs(host, fsRead(files), (b) => fileDoc(files[b]), { chain: ['/w/host.dxf'], depth: 3, host: '/w/host.dxf' });
  assert.deepEqual(st, { R: 'loaded', GONE: 'notfound' });
  assert.equal(host.blocks.get('R').entities.length, 1);
  assert.equal(host.blocks.get('R|N').entities.length, 1, 'nested xref (relative to the xref folder) loaded');
  assert.ok(host.blocks.get('R|BACK') && host.blocks.get('R|BACK').entities.length === 0, 'the cycle back to the host is not followed');
  assert.ok(!host.blocks.get('R|N').xref && host.blocks.get('R|N').xrefDep === 'R');
});
