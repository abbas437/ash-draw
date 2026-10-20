import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { loadPicked } from '../renderer/files.js';
import { pickXref } from '../renderer/xref-panel.js';

// reviewer #23: dialog:open returns a .dwg as {path, name} without bytes; XATTACH (pickXref), the xref panel's Browse
// and Compare's File… load it through loadPicked, which has main convert it from the path (dwg:open)
const dxf = fixture('basic_r2000.dxf');
const desktopApi = (calls, picked) => ({
  isElectron: true,
  openFiles: async () => [picked],
  dwgAvailable: async () => ({ available: true }),
  dwgOpen: async (src) => { calls.push(src); return { url: `data:application/octet-stream;base64,${Buffer.from(dxf).toString('base64')}`, warnings: [] }; },
  dwgToDxf: async () => { throw new Error('a picked DWG must be converted from its path'); },
  readFile: async () => { throw new Error('a picked DWG must not be read into the window'); },
});

test('loadPicked: a DWG chosen in the open dialog (no bytes) is converted by main from its path', async () => {
  const calls = [];
  const f = { path: '/d/plan.dwg', name: 'plan.dwg' };
  const { doc, format } = await loadPicked(desktopApi(calls, f), f);
  assert.equal(format, 'dwg');
  assert.deepEqual(calls, ['/d/plan.dwg']);
  assert.ok(doc.entities.length > 0);
});

test('loadPicked: a DXF (or a browser pick without a path) is read from its bytes', async () => {
  const { doc, format } = await loadPicked({ isElectron: false }, { path: null, name: 'a.dxf', bytes: dxf });
  assert.equal(format, 'dxf');
  assert.ok(doc.entities.length > 0);
});

test('pickXref (XATTACH): a DWG chosen in the dialog is attached by path', async () => {
  const calls = [];
  globalThis.window = { api: desktopApi(calls, { path: '/d/x/ref.dwg', name: 'ref.dwg' }) };
  try {
    const r = await pickXref({ file: { path: '/d/host.dxf' } });
    assert.ok(r, 'the xref was read');
    assert.deepEqual(calls, ['/d/x/ref.dwg']);
    assert.ok(r.xdoc.entities.length > 0);
  } finally { delete globalThis.window; }
});
