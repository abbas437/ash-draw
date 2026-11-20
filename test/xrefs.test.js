import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, addBlock, addEntity } from '../src/core/model.js';
import { joinRel, loadXrefs, refNotes, refusalTracker, relativePath, samePath } from '../renderer/xrefs.js';

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

test('refusalTracker: a reference main refused (outside the host folder) is "not found", its paths are collected once', async () => {
  const doc = fileDoc({ IN: 'in.dxf', OUT: '/far/out.dxf', OUT2: '/far/out.dxf' });
  const t = refusalTracker();
  const read = t.wrap(async (ref) => (ref === 'in.dxf' ? { path: '/w/in.dxf', bytes: '/w/in.dxf' } : { refused: [ref], declined: false }));
  const st = await loadXrefs(doc, read, async () => fileDoc({}));
  assert.deepEqual(st, { IN: 'loaded', OUT: 'notfound', OUT2: 'notfound' });
  assert.deepEqual(t.refused, ['/far/out.dxf']);
  assert.equal(t.declined, false);
  assert.equal(await t.wrap(async () => ({ refused: ['/x.dxf'], declined: true }))(), null);
  assert.equal(t.declined, true);
});

test('refusalTracker.held: the last answer for a reference was a refusal (a later answer clears it)', async () => {
  const t = refusalTracker();
  let allow = false;
  const read = t.wrap(async (host, ref) => (ref === 'out.png' && !allow ? { refused: ['/far/out.png'], declined: false } : null));
  await read('/w/h.dxf', 'out.png');
  await read('/w/h.dxf', 'gone.png');
  assert.equal(t.held('out.png'), true);
  assert.equal(t.held('gone.png'), false);
  allow = true;
  await read('/w/h.dxf', 'out.png');
  assert.equal(t.held('out.png'), false, 'allowed, then looked for: no longer held');
});

test('refNotes: missing xrefs named by file name, held ones said to be outside the folder, long lists cut after 5', () => {
  assert.deepEqual(refNotes({ xrefs: ['..\\..\\..\\..\\Model\\PAVA\\Level 102 Model.dwg', '..\\..\\..\\..\\Background\\102ALL.dwg'] }),
    ['2 external references not found (shown as their paths in red): Level 102 Model.dwg, 102ALL.dwg.']);
  assert.deepEqual(refNotes({ heldXrefs: ['D:/far/site.dwg'] }), ['1 external reference not loaded (outside the drawing folder): site.dwg.']);
  const many = Array.from({ length: 7 }, (_, i) => `x${i}.dwg`);
  assert.equal(refNotes({ xrefs: many })[0], '7 external references not found (shown as their paths in red): x0.dwg, x1.dwg, x2.dwg, x3.dwg, x4.dwg …and 2 more.');
  assert.deepEqual(refNotes({ images: ['./img/logo.png'], heldImages: ['D:\\far\\a.jpg'] }),
    ['Raster images not found (shown as a red frame with the file name): ./img/logo.png.', '1 raster image not loaded (outside the drawing folder): a.jpg.']);
  assert.deepEqual(refNotes({}), []);
});

test('xrefReads: nested xrefs that were not found or not loaded (outside the folder) are reported, once each, in reading order', async () => {
  const { xrefReads } = await import('../renderer/xrefs.js');
  const files = { '/w/host.dxf': { A: './a.dxf', GONE: 'gone.dxf' }, '/w/a.dxf': { B: '../out/b.dxf', C: 'c.dxf', A2: 'a2.dxf' }, '/w/a2.dxf': { B: '../out/b.dxf' } };
  const inner = fsRead(files);
  const read = async (ref) => (ref.includes('out') ? { refused: ['/out/b.dxf'], declined: true } : inner(ref));
  const t = refusalTracker(), reads = xrefReads();
  const host = fileDoc(files['/w/host.dxf']);
  await loadXrefs(host, reads.wrap(t.wrap(read)), (b) => fileDoc(files[b]), { chain: ['/w/host.dxf'], depth: 3, host: '/w/host.dxf' });
  const x = reads.unloaded(t.held);
  assert.deepEqual(x, { missing: ['c.dxf', 'gone.dxf'], held: ['../out/b.dxf'] }, JSON.stringify(x));
  assert.deepEqual(refNotes({ xrefs: x.missing, heldXrefs: x.held }), [
    '2 external references not found (shown as their paths in red): c.dxf, gone.dxf.',
    '1 external reference not loaded (outside the drawing folder): b.dxf.',
  ]);
});
