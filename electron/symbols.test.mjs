// Unit tests for the symbol folder listing. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSymbolFiles, symbolFilePath, readSymbolFile, createSymbolLibrary, checkPng, pruneThumbCache, MAX_THUMB_BYTES } from './symbols.js';
import { thumbKey } from '../src/core/symbols-lib.js';

async function withTree(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-symbols-'));
  try {
    for (const f of ['Fire alarms/Smoke.dxf', 'Fire alarms/Smoke.jpg', 'Ventilation/Air Terminals/Grille.DXF', 'Ventilation/Air Terminals/Fan.dwg', 'readme.txt', 'Top.dxf']) {
      await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true });
      await fs.writeFile(path.join(root, f), '0\nEOF\n');
    }
    await fn(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('lists only .dxf/.dwg, recursively, with subfolders as categories', () => withTree(async (root) => {
  const l = await listSymbolFiles(root);
  assert.deepEqual(l.map((f) => f.rel), ['Fire alarms/Smoke.dxf', 'Top.dxf', 'Ventilation/Air Terminals/Fan.dwg', 'Ventilation/Air Terminals/Grille.DXF']);
  assert.equal(l[2].category, 'Ventilation/Air Terminals');
  assert.equal(l[1].category, '');
  assert.ok(l.every((f) => f.size === 6 && Number.isInteger(f.mtimeMs)));
  assert.equal(l.truncated, false);
}));

test('the listing is capped', () => withTree(async (root) => {
  const l = await listSymbolFiles(root, { max: 2 });
  assert.equal(l.length, 2);
  assert.equal(l.truncated, true);
}));

test('reads only listed-style symbol paths inside the folder', () => withTree(async (root) => {
  assert.equal((await readSymbolFile(root, 'Fire alarms/Smoke.dxf')).bytes.length, 6);
  for (const bad of ['../x.dxf', 'Fire alarms/../../x.dxf', '/etc/passwd', 'C:/x.dxf', 'Fire alarms/Smoke.jpg', 'readme.txt', '', null, 'a\0.dxf', './Top.dxf']) {
    assert.throws(() => symbolFilePath(root, bad), TypeError, String(bad));
    await assert.rejects(readSymbolFile(root, bad), TypeError, String(bad));
  }
}));

// ---- the IPC handlers (createSymbolLibrary) with an injected dialog and converter ----
const PNG = (n = 64, fill = 7) => { const b = new Uint8Array(n).fill(fill); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };

async function withLibrary(fn, opts = {}) {
  await withTree(async (root) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-symdata-'));
    try {
      let n = 0;
      const picks = [root];
      const lib = createSymbolLibrary({
        dir: () => data, pickFolder: async () => picks.shift() ?? null, newId: () => (++n).toString(16).padStart(16, '0'),
        toDxf: async (bytes) => ({ dxfBytes: new TextEncoder().encode(`converted ${bytes.length}`) }), ...opts,
      });
      await fn({ lib, root, data, picks });
    } finally { await fs.rm(data, { recursive: true, force: true }); }
  });
}

test('addFolder stores only the dialog\'s folder, in its own userData file; cancel stores nothing', () => withLibrary(async ({ lib, root, data, picks }) => {
  const f = await lib.addFolder();
  assert.equal(f.id, '0000000000000001');
  assert.equal(f.path, root);
  assert.equal(f.files.length, 4);
  assert.equal(f.truncated, false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'symbol-folders.json'), 'utf8')), [{ id: f.id, path: root, name: path.basename(root) }]);
  picks.push(root);
  assert.equal((await lib.addFolder()).id, f.id, 'the same folder is stored once');
  assert.equal(await lib.addFolder(), null, 'cancelled');
  assert.deepEqual(await lib.folders(), [{ id: f.id, path: root, name: path.basename(root) }]);
  assert.equal((await lib.list(f.id)).files[0].rel, 'Fire alarms/Smoke.dxf');
  assert.equal(await lib.removeFolder(f.id), true);
  assert.deepEqual(await lib.folders(), []);
  await assert.rejects(lib.list(f.id), /unknown symbol folder/);
}));

test('unknown or malformed folder ids and traversing paths are rejected by every handler', () => withLibrary(async ({ lib }) => {
  const { id } = await lib.addFolder();
  for (const bad of ['0000000000000009', '../x', 'ABCDEF0123456789', '', null, 7, { id }]) {
    await assert.rejects(lib.list(bad), String(bad));
    await assert.rejects(lib.read(bad, 'Top.dxf'), String(bad));
    await assert.rejects(lib.thumbGet(bad, 'Top.dxf'), String(bad));
    await assert.rejects(lib.thumbPut(bad, 'Top.dxf', PNG()), String(bad));
    await assert.rejects(lib.removeFolder(bad), String(bad));
  }
  for (const rel of ['../x.dxf', 'Fire alarms/../../x.dxf', '/etc/passwd', 'readme.txt', 'Fire alarms/Smoke.jpg']) {
    await assert.rejects(lib.read(id, rel), TypeError, rel);
    await assert.rejects(lib.thumbGet(id, rel), TypeError, rel);
    await assert.rejects(lib.thumbPut(id, rel, PNG()), TypeError, rel);
  }
}));

test('read: DXF as is, DWG through the converter', () => withLibrary(async ({ lib }) => {
  const { id } = await lib.addFolder();
  const dxf = await lib.read(id, 'Top.dxf');
  assert.deepEqual([dxf.name, dxf.format, dxf.sourceFormat, new TextDecoder().decode(dxf.bytes)], ['Top.dxf', 'dxf', 'dxf', '0\nEOF\n']);
  const dwg = await lib.read(id, 'Ventilation/Air Terminals/Fan.dwg');
  assert.deepEqual([dwg.format, dwg.sourceFormat, new TextDecoder().decode(dwg.bytes)], ['dxf', 'dwg', 'converted 6']);
}));

test('thumbnails: keyed by path + mtime + size from stat; PNG signature and size checked', () => withLibrary(async ({ lib, root, data }) => {
  const { id } = await lib.addFolder();
  assert.equal(await lib.thumbGet(id, 'Top.dxf'), null);
  const png = PNG();
  assert.equal(await lib.thumbPut(id, 'Top.dxf', png), true);
  const p = path.join(root, 'Top.dxf');
  const st = await fs.stat(p);
  assert.deepEqual(await fs.readdir(path.join(data, 'symbol-cache')), [`${thumbKey(p, st.mtimeMs, st.size)}.png`]);
  assert.deepEqual(await lib.thumbGet(id, 'Top.dxf'), png);
  await fs.writeFile(p, '0\nEOF\n\n'); // a changed file gets a new key: the old thumbnail is not served
  assert.equal(await lib.thumbGet(id, 'Top.dxf'), null);
  await assert.rejects(lib.thumbPut(id, 'Top.dxf', new Uint8Array(64)), /not a PNG/);
  await assert.rejects(lib.thumbPut(id, 'Top.dxf', PNG(MAX_THUMB_BYTES + 1)), RangeError);
  await assert.rejects(lib.thumbPut(id, 'Top.dxf', [...png]), TypeError);
  assert.equal(checkPng(png), png);
}));

test('the thumbnail cache is pruned least recently used first', () => withLibrary(async ({ lib, root, data }) => {
  const { id } = await lib.addFolder();
  const rels = ['Fire alarms/Smoke.dxf', 'Top.dxf', 'Ventilation/Air Terminals/Grille.DXF'];
  let t = Date.now() / 1000 - 100;
  const keyFile = async (rel) => { const p = path.join(root, rel); const st = await fs.stat(p); return path.join(data, 'symbol-cache', `${thumbKey(p, st.mtimeMs, st.size)}.png`); };
  for (const rel of rels.slice(0, 2)) { await lib.thumbPut(id, rel, PNG(1000)); await fs.utimes(await keyFile(rel), t, t); t += 10; }
  await lib.thumbGet(id, rels[0]); // touched: now the most recently used
  await lib.thumbPut(id, rels[2], PNG(1000)); // 3000 bytes > 2500: the least recently used (Top.dxf) goes
  const left = await fs.readdir(path.join(data, 'symbol-cache'));
  assert.equal(left.length, 2);
  assert.ok(!left.includes(path.basename(await keyFile(rels[1]))), 'Top.dxf was pruned');
  assert.equal(await pruneThumbCache(path.join(data, 'symbol-cache'), 0), 0);
}, { maxCacheBytes: 2500 }));
