// The Symbols panel's source facade (renderer/symbols-source.js) over a fake window.api.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { newDocument, addEntity, addBlock, makeLine, makeCircle } from '../src/core/model.js';
import { writeDxf } from '../src/core/dxfWrite.js';
import { builtinSymbols } from '../src/core/symbols-builtin.js';
import { createSymbolSource, BUILTIN_SOURCE } from '../renderer/symbols-source.js';

const model = (r) => { const d = newDocument(); d.units = 4; addEntity(d, makeCircle({ x: 0, y: 0 }, r)); addEntity(d, makeLine({ x: -r, y: 0 }, { x: r, y: 0 })); return writeDxf(d); };
const library = () => { // empty model space, two top-level blocks
  const d = newDocument();
  addBlock(d, 'VALVE', { x: 0, y: 0 }, [makeLine({ x: -2, y: 0 }, { x: 2, y: 0 })]);
  addBlock(d, 'DAMPER', { x: 0, y: 0 }, [makeCircle({ x: 0, y: 0 }, 1)]);
  return writeDxf(d);
};
const FILES = {
  'Ventilation/Air Terminals/Mech_Vent_AirTerminals_Ceiling_Return.dxf': model(2),
  'Ventilation/Mech_Vent_Dampers_Fire_Damper.dxf': model(3),
  'Pipework/Valves.dxf': library(),
  'Pipework/Pump.dwg': null,
};

function fakeApi() {
  const calls = [];
  const thumbs = new Map();
  const files = Object.keys(FILES).sort().map((rel) => ({ rel, name: rel.split('/').pop(), category: rel.slice(0, rel.lastIndexOf('/')), size: 10, mtimeMs: 1000 }));
  const api = {
    calls, thumbs,
    symbolsFolders: async () => [{ id: 'aaaaaaaaaaaaaaaa', path: 'C:\\CIBSE', name: 'CIBSE' }],
    symbolsList: async (id) => { calls.push(['list', id]); return { files, truncated: false }; },
    symbolsRead: async (id, rel) => {
      calls.push(['read', id, rel]);
      if (FILES[rel] == null) throw Object.assign(new Error('DWG symbols require the desktop app'), { code: 'DWG_DESKTOP_ONLY' });
      return { name: rel.split('/').pop(), format: 'dxf', sourceFormat: 'dxf', bytes: new TextEncoder().encode(FILES[rel]) };
    },
    symbolsThumbGet: async (id, rel) => { calls.push(['thumbGet', rel]); return thumbs.get(rel) ?? null; },
    symbolsThumbPut: async (id, rel, png) => { calls.push(['thumbPut', rel]); thumbs.set(rel, png); return true; },
  };
  return api;
}
const opts = { canvas: (w, h) => createCanvas(w, h), encode: async (c) => new Uint8Array(await c.encode('png')) };

test('listSources: Built-in first, then the stored folders', async () => {
  const src = createSymbolSource(fakeApi(), opts);
  assert.deepEqual(await src.listSources(), [BUILTIN_SOURCE, { id: 'aaaaaaaaaaaaaaaa', kind: 'folder', name: 'CIBSE', path: 'C:\\CIBSE' }]);
});

test('listSymbols: built-in set; folder files with the subfolder as category and CIBSE names cleaned', async () => {
  const src = createSymbolSource(fakeApi(), opts);
  const b = await src.listSymbols(BUILTIN_SOURCE);
  assert.equal(b.length, builtinSymbols().length);
  assert.ok(b.every((i) => i.key.startsWith('builtin:') && i.name && i.category));
  const [, folder] = await src.listSources();
  const items = await src.listSymbols(folder);
  assert.deepEqual(items.map((i) => [i.name, i.category, i.format]), [
    ['Pump', 'Pipework', 'dwg'],
    ['Valves', 'Pipework', 'dxf'],
    ['Ceiling Return', 'Ventilation/Air Terminals', 'dxf'],
    ['Fire Damper', 'Ventilation', 'dxf'],
  ]);
});

test('loadSymbol: parsed once per file and cached; a block library gives one symbol per block; errors are not cached', async () => {
  const api = fakeApi();
  const src = createSymbolSource(api, opts);
  const [, folder] = await src.listSources();
  const items = await src.listSymbols(folder);
  const ceiling = items.find((i) => i.name === 'Ceiling Return');
  const [s] = await src.loadSymbol(folder, ceiling);
  assert.equal(s.name, 'Ceiling Return');
  assert.equal(s.category, 'Ventilation/Air Terminals');
  assert.equal(s.entities.length, 2);
  assert.equal(await src.loadSymbol(folder, ceiling).then((x) => x[0]), s, 'cached');
  assert.equal(api.calls.filter((c) => c[0] === 'read').length, 1);
  const lib = await src.loadSymbol(folder, items.find((i) => i.name === 'Valves'));
  assert.deepEqual(lib.map((x) => x.name).sort(), ['DAMPER', 'VALVE']);
  const pump = items.find((i) => i.name === 'Pump');
  await assert.rejects(src.loadSymbol(folder, pump), (e) => e.code === 'DWG_DESKTOP_ONLY');
  await assert.rejects(src.loadSymbol(folder, pump));
  assert.equal(api.calls.filter((c) => c[0] === 'read' && c[2] === pump.rel).length, 2, 'a failed load is retried');
  const [valve] = await src.loadSymbol(BUILTIN_SOURCE, (await src.listSymbols(BUILTIN_SOURCE))[0]);
  assert.ok(valve.entities.length);
});

test('thumbnail: rendered once and put in the cache; a cached one is served without rendering; undrawable -> null', async () => {
  const api = fakeApi();
  const [, folder] = await createSymbolSource(api, opts).listSources();
  const items = await createSymbolSource(api, opts).listSymbols(folder);
  const ceiling = items.find((i) => i.name === 'Ceiling Return');
  const blob = await createSymbolSource(api, opts).thumbnail(folder, ceiling);
  assert.equal(blob.type, 'image/png');
  await new Promise((r) => setImmediate(r));
  const png = api.thumbs.get(ceiling.rel);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const fresh = createSymbolSource(api, opts);
  const again = await fresh.thumbnail(folder, ceiling);
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), png);
  assert.equal(api.calls.filter((c) => c[0] === 'read' && c[2] === ceiling.rel).length, 1, 'the cached thumbnail needs no read');
  assert.equal(await fresh.thumbnail(folder, items.find((i) => i.name === 'Pump')), null);
  assert.equal((await fresh.thumbnail(BUILTIN_SOURCE, (await fresh.listSymbols(BUILTIN_SOURCE))[0])).type, 'image/png');
});

test('listSymbols: a capped folder listing is flagged truncated (non-enumerable, so the items compare as before)', async () => {
  const api = fakeApi();
  const src = createSymbolSource(api, opts);
  const folder = (await src.listSources())[1];
  assert.equal((await src.listSymbols(folder)).truncated, false);
  api.symbolsList = async () => ({ files: [{ rel: 'A.dxf', name: 'A.dxf', category: '', size: 1, mtimeMs: 1 }], truncated: true });
  const items = await src.listSymbols(folder);
  assert.equal(items.truncated, true);
  assert.deepEqual(Object.keys(items), ['0']);
});
