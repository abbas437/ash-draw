// Unit tests for the .bak copy made before Save overwrites a drawing. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { backupPathOf, saveDrawingFile, writeWithBackup } from './backup.js';

const write = (p, b) => fs.writeFile(p, b);

test('backupPathOf: <name>.bak next to a .dwg (as AutoCAD), <name>.dxf.bak next to a .dxf; other files get none', () => {
  assert.equal(backupPathOf(path.join('/j', 'Plan A.dwg')), path.join('/j', 'Plan A.bak'));
  assert.equal(backupPathOf(path.join('/j', 'Plan A.DWG')), path.join('/j', 'Plan A.bak'));
  assert.equal(backupPathOf(path.join('/j', 'Plan A.dxf')), path.join('/j', 'Plan A.dxf.bak'));
  assert.equal(backupPathOf(path.join('/j', 'Plan A.DXF')), path.join('/j', 'Plan A.DXF.bak'));
  assert.equal(backupPathOf(path.join('/j', 'plot.pdf')), null);
});

test('writeWithBackup: an existing drawing is copied to .bak (replacing an older one) before it is overwritten', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-bak-'));
  try {
    const f = path.join(dir, 'Plan A.dwg'), bak = path.join(dir, 'Plan A.bak');
    assert.equal(await writeWithBackup(f, 'v1', write), null, 'new file: no backup');
    assert.deepEqual(await fs.readdir(dir), ['Plan A.dwg']);
    assert.equal(await writeWithBackup(f, 'v2', write), bak);
    assert.equal(await fs.readFile(bak, 'utf8'), 'v1');
    assert.equal(await fs.readFile(f, 'utf8'), 'v2');
    await writeWithBackup(f, 'v3', write);
    assert.equal(await fs.readFile(bak, 'utf8'), 'v2', 'the older .bak is replaced');
    const png = path.join(dir, 'x.png');
    await writeWithBackup(png, 'a', write); await writeWithBackup(png, 'b', write);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['Plan A.bak', 'Plan A.dwg', 'x.png']);
    // the backup cannot be made (a folder sits at the .bak path): nothing is written
    const g = path.join(dir, 'B.dxf');
    await fs.writeFile(g, 'orig'); await fs.mkdir(path.join(dir, 'B.dxf.bak'));
    await assert.rejects(writeWithBackup(g, 'new', write), /Could not make the backup copy B\.dxf\.bak/);
    assert.equal(await fs.readFile(g, 'utf8'), 'orig');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a .dwg and a .dxf of the same name keep separate backups', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-bak-'));
  try {
    const dwg = path.join(dir, 'Plan A.dwg'), dxf = path.join(dir, 'Plan A.dxf');
    await fs.writeFile(dwg, 'dwg1'); await fs.writeFile(dxf, 'dxf1');
    await writeWithBackup(dwg, 'dwg2', write); await writeWithBackup(dxf, 'dxf2', write);
    assert.equal(await fs.readFile(path.join(dir, 'Plan A.bak'), 'utf8'), 'dwg1');
    assert.equal(await fs.readFile(path.join(dir, 'Plan A.dxf.bak'), 'utf8'), 'dxf1');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('saveDrawingFile (main\'s file:write / dialog:save write): .bak first, then an atomic write; no temp file left', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-bak-'));
  try {
    const f = path.join(dir, 'Plan A.dwg');
    assert.deepEqual(await saveDrawingFile(f, new Uint8Array([1, 2])), { path: f, backup: null });
    assert.deepEqual(await saveDrawingFile(f, new Uint8Array([3])), { path: f, backup: path.join(dir, 'Plan A.bak') });
    assert.deepEqual([...await fs.readFile(path.join(dir, 'Plan A.bak'))], [1, 2]);
    assert.deepEqual([...await fs.readFile(f)], [3]);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('main.js: both file:write and dialog:save write through saveDrawingFile', () => {
  const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  for (const ch of ['dialog:save', 'file:write']) {
    const at = src.indexOf(`handle('${ch}'`);
    assert.ok(at >= 0, ch);
    const body = src.slice(at, src.indexOf('\n  });', at));
    assert.match(body, /saveDrawingFile\(/, `${ch} uses saveDrawingFile`);
    assert.doesNotMatch(body, /atomicWrite\(|fs\.writeFile\(/, `${ch} has no write that skips the backup`);
  }
});
