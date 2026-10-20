// Unit tests for the .bak copy made before Save overwrites a drawing. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { backupPathOf, RENAME_RETRY_MS, saveDrawingFile, writeWithBackup } from './backup.js';

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

// ---- reviewer #19: a save on a synced folder (OneDrive, Google Drive) or over a file open in another program ----
const errOf = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const quick = { delays: [1, 1, 1, 1, 1], sleep: async () => {} };
const bytesOf = (s) => new TextEncoder().encode(s);
/** a real folder with "Plan A.dwg" = v1 and an older "Plan A.bak" = v0 */
async function planFolder() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-bak-'));
  const f = path.join(dir, 'Plan A.dwg'), bak = path.join(dir, 'Plan A.bak');
  await fs.writeFile(f, 'v1'); await fs.writeFile(bak, 'v0');
  return { dir, f, bak, read: (p) => fs.readFile(p, 'utf8'), list: async () => (await fs.readdir(dir)).sort() };
}
/** node's fs.promises with the rename over `target` refused (EPERM) while `renameFails(attempt)` */
function syncedFs(target, renameFails, over = {}) {
  const calls = { rename: 0, open: [] };
  const sfs = {
    ...fs,
    rename: async (a, b) => { if (b === target) { calls.rename++; if (renameFails(calls.rename)) throw errOf('EPERM'); } return fs.rename(a, b); },
    open: async (p, flags) => { calls.open.push(flags); return fs.open(p, flags); },
    ...over,
  };
  return { sfs, calls };
}

test('the busy rename is tried 6 times over about 2 s', () => {
  assert.equal(RENAME_RETRY_MS.length, 5);
  const total = RENAME_RETRY_MS.reduce((a, b) => a + b, 0);
  assert.ok(total >= 1500 && total <= 2500, String(total));
});

test('save: the rename refused (EPERM) twice, then accepted -> saved, one .bak with the previous content, no temp file', async () => {
  const t = await planFolder();
  try {
    const { sfs, calls } = syncedFs(t.f, (n) => n <= 2);
    assert.deepEqual(await saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }), { path: t.f, backup: t.bak });
    assert.equal(calls.rename, 3);
    assert.deepEqual(calls.open, [], 'no in-place write');
    assert.equal(await t.read(t.f), 'v2');
    assert.equal(await t.read(t.bak), 'v1');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: the rename always refused -> the content is written over the file in place; .bak made; no temp file', async () => {
  const t = await planFolder();
  try {
    const { sfs, calls } = syncedFs(t.f, () => true);
    assert.deepEqual(await saveDrawingFile(t.f, bytesOf('v2 longer'), { fs: sfs, ...quick }), { path: t.f, backup: t.bak });
    assert.equal(calls.rename, 6, '6 tries');
    assert.deepEqual(calls.open, ['r+']);
    assert.equal(await t.read(t.f), 'v2 longer');
    assert.equal(await t.read(t.bak), 'v1');
    await saveDrawingFile(t.f, bytesOf('v3'), { fs: sfs, ...quick });
    assert.equal(await t.read(t.f), 'v3', 'a shorter content is not left with the old tail');
    assert.equal(await t.read(t.bak), 'v2 longer');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: the rename always refused and the file locked by another program -> plain-language error; file and .bak unchanged; no temp file', async () => {
  const t = await planFolder();
  try {
    const { sfs } = syncedFs(t.f, () => true, { open: async () => { throw errOf('EBUSY'); } });
    await assert.rejects(saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }), (err) => {
      assert.equal(err.message, `The file is in use by another program (for example AutoCAD or a sync client): ${t.f}. Close it there and save again, or use Save As.`);
      assert.equal(err.code, 'EBUSY');
      return true;
    });
    assert.equal(await t.read(t.f), 'v1');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: a read-only file (open for writing refused) -> permission message naming the file; nothing changed', async () => {
  const t = await planFolder();
  try {
    const { sfs } = syncedFs(t.f, () => true, { open: async () => { throw errOf('EPERM'); } });
    await assert.rejects(saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }),
      { message: `You don't have permission to write to ${t.f} (the file may be read-only). Use Save As to save it under another name or in another folder.` });
    assert.equal(await t.read(t.f), 'v1');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: the temp file cannot be written (disk full / no permission) -> plain-language error; nothing changed', async () => {
  for (const [code, message] of [
    ['ENOSPC', (t) => `The disk is full: ${t.f} could not be saved. Free some space on that drive and save again, or use Save As to save it on another drive.`],
    ['EACCES', (t) => `You don't have permission to write to this folder: ${t.dir}. Plan A.dwg was not saved; use Save As to save it in another folder.`],
  ]) {
    const t = await planFolder();
    try {
      const sfs = { ...fs, writeFile: async (p, b, o) => { await fs.writeFile(p, b.subarray(0, 1), o); throw errOf(code); } }; // a part written, then the error
      await assert.rejects(saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }), { message: message(t), code });
      assert.equal(await t.read(t.f), 'v1');
      assert.equal(await t.read(t.bak), 'v0');
      assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg'], code);
    } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
  }
});

test('save: the in-place write fails part-way (disk full) -> the previous content is written back; .bak unchanged; no temp file', async () => {
  const t = await planFolder();
  try {
    let writes = 0;
    const { sfs } = syncedFs(t.f, () => true, {
      open: async (p, flags) => {
        const h = await fs.open(p, flags);
        return {
          write: async (buf, off, len, pos) => { if (++writes === 2) throw errOf('ENOSPC'); return h.write(buf, off, Math.min(len, 3), pos); },
          truncate: (n) => h.truncate(n), sync: () => h.sync(), close: () => h.close(),
        };
      },
    });
    await assert.rejects(saveDrawingFile(t.f, bytesOf('v2 much longer'), { fs: sfs, ...quick }), { code: 'ENOSPC', message: /^The disk is full/ });
    assert.ok(writes > 2, 'the previous content was written back');
    assert.equal(await t.read(t.f), 'v1');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: the older .bak cannot be replaced (open elsewhere) -> the drawing is saved, the older .bak stays, no temp file', async () => {
  const t = await planFolder();
  try {
    const sfs = { ...fs, rename: async (a, b) => { if (b === t.bak) throw errOf('EBUSY'); return fs.rename(a, b); } };
    assert.deepEqual(await saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }), { path: t.f, backup: null });
    assert.equal(await t.read(t.f), 'v2');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: a new file whose temp file cannot be renamed is written directly; no temp file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-bak-'));
  try {
    const f = path.join(dir, 'New.dxf');
    const { sfs } = syncedFs(f, () => true);
    assert.deepEqual(await saveDrawingFile(f, bytesOf('n1'), { fs: sfs, ...quick }), { path: f, backup: null });
    assert.equal(await fs.readFile(f, 'utf8'), 'n1');
    assert.deepEqual(await fs.readdir(dir), ['New.dxf']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
