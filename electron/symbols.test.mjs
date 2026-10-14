// Unit tests for the symbol folder listing. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSymbolFiles, symbolFilePath, readSymbolFile } from './symbols.js';

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
