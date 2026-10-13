// Unit tests for the .bak copy made before Save overwrites a drawing. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupPathOf, writeWithBackup } from './backup.js';

const write = (p, b) => fs.writeFile(p, b);

test('backupPathOf: <name>.bak next to a .dxf/.dwg; other files get none', () => {
  assert.equal(backupPathOf(path.join('/j', 'Plan A.dwg')), path.join('/j', 'Plan A.bak'));
  assert.equal(backupPathOf(path.join('/j', 'Plan A.DXF')), path.join('/j', 'Plan A.bak'));
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
    await fs.writeFile(g, 'orig'); await fs.mkdir(path.join(dir, 'B.bak'));
    await assert.rejects(writeWithBackup(g, 'new', write), /Could not make the backup copy B\.bak/);
    assert.equal(await fs.readFile(g, 'utf8'), 'orig');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
