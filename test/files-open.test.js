import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { loadDrawing } from '../renderer/files.js';

// a DWG opened from a granted path: main converts it from the path (dwg:open) and hands the DXF back as a URL that
// the reader fetches; neither the DWG nor the DXF bytes go through the window's IPC
test('loadDrawing: a DWG path is converted by main and its DXF read from the returned URL', async () => {
  const dxf = fixture('basic_r2000.dxf');
  const calls = [];
  const api = {
    isElectron: true,
    dwgAvailable: async () => ({ available: true }),
    dwgOpen: async (src) => { calls.push(src); return { url: `data:application/octet-stream;base64,${Buffer.from(dxf).toString('base64')}`, warnings: [] }; },
    dwgToDxf: async () => { throw new Error('the DXF must not come back through dwg:toDxf'); },
  };
  const { doc, format } = await loadDrawing(api, 'plan.dwg', null, { path: '/drawings/plan.dwg' });
  assert.equal(format, 'dwg');
  assert.deepEqual(calls, ['/drawings/plan.dwg']);
  assert.ok(doc.entities.length > 0);
});
