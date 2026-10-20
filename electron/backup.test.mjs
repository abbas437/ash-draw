// Unit tests for the .bak copy made before Save overwrites a drawing. Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { backupPathOf, keptPathOf, RENAME_RETRY_MS, saveDrawingFile, writeWithBackup } from './backup.js';

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
    assert.deepEqual(await writeWithBackup(f, 'v1', write), { backup: null }, 'new file: no backup');
    assert.deepEqual(await fs.readdir(dir), ['Plan A.dwg']);
    assert.deepEqual(await writeWithBackup(f, 'v2', write), { backup: bak });
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
/** what a path next to "Plan A.dwg" is, in calls.log: target, bak, tmp (the new content), prev (the previous content
 *  before an in-place write), copy (the previous content on its way to the .bak) */
const kindOf = (p) => {
  const n = path.basename(p);
  return n === 'Plan A.dwg' ? 'target' : n === 'Plan A.bak' ? 'bak' : n.endsWith('.prev') ? 'prev'
    : n.startsWith('.Plan A.bak.') ? 'copy' : n.endsWith('.tmp') ? 'tmp' : n;
};
/**
 * node's fs.promises with Windows file sharing modelled, and the rename over `target` refused (EPERM) while
 * `renameFails(attempt)`. As on Windows, a file this process holds open for writing (r+, w, wx, a) cannot be copied
 * (CopyFileW opens its source without write sharing) or opened again for reading: EBUSY, until that handle is closed.
 * `calls.open`: the flags `target` itself was opened with; `calls.log`: "<op> <kind>" (kindOf) in order.
 */
function syncedFs(target, renameFails, over = {}) {
  const calls = { rename: 0, open: [], log: [] };
  const writers = new Map();
  const held = (p) => (writers.get(p) ?? 0) > 0;
  const note = (s) => calls.log.push(s);
  const sfs = {
    ...fs,
    rename: async (a, b) => {
      note(`rename ${kindOf(a)}>${kindOf(b)}`);
      if (b === target) { calls.rename++; if (renameFails(calls.rename)) throw errOf('EPERM'); }
      return fs.rename(a, b);
    },
    copyFile: async (a, b, mode) => { if (held(a)) throw errOf('EBUSY'); note(`copy ${kindOf(b)}`); return fs.copyFile(a, b, mode); },
    readFile: async (p, o) => { if (typeof p === 'string' && held(p)) throw errOf('EBUSY'); return fs.readFile(p, o); },
    open: async (p, flags = 'r') => {
      if (p === target) calls.open.push(flags);
      const writing = /[+wax]/.test(flags);
      if (!writing && held(p)) throw errOf('EBUSY');
      const h = await fs.open(p, flags);
      if (!writing) return h;
      writers.set(p, (writers.get(p) ?? 0) + 1);
      let open = true;
      return {
        readFile: (o) => h.readFile(o),
        write: (...a) => { note(`write ${kindOf(p)}`); return h.write(...a); },
        truncate: (n) => h.truncate(n),
        sync: () => { note(`sync ${kindOf(p)}`); return h.sync(); },
        close: () => { if (open) { open = false; writers.set(p, writers.get(p) - 1); } return h.close(); },
      };
    },
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
    // flushed to the disk before the rename replaces the file: the new content (tmp) and the previous one (copy)
    const over = calls.log.indexOf('rename tmp>target');
    assert.ok(calls.log.indexOf('sync tmp') >= 0 && calls.log.indexOf('sync tmp') < over, calls.log.join(', '));
    assert.ok(calls.log.indexOf('sync copy') > calls.log.indexOf('copy copy') && calls.log.indexOf('sync copy') < over, calls.log.join(', '));
    assert.equal(await t.read(t.f), 'v2');
    assert.equal(await t.read(t.bak), 'v1');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: the rename always refused -> the content is written over the file in place (Windows sharing: the file we hold open for writing is not copied or reopened); .bak made; no temp file', async () => {
  const t = await planFolder();
  try {
    const { sfs, calls } = syncedFs(t.f, () => true);
    assert.deepEqual(await saveDrawingFile(t.f, bytesOf('v2 longer'), { fs: sfs, ...quick }), { path: t.f, backup: t.bak });
    assert.equal(calls.rename, 6, '6 tries');
    assert.deepEqual(calls.open, ['r+']);
    // the previous content is written to `prev` through a handle of our own and flushed before the first byte of the
    // file changes; the .bak copy too
    const first = calls.log.indexOf('write target'), log = calls.log.join(', ');
    assert.ok(first >= 0, log);
    assert.ok(calls.log.indexOf('write prev') >= 0 && calls.log.indexOf('write prev') < calls.log.indexOf('sync prev'), log);
    assert.ok(calls.log.indexOf('sync prev') < first, log);
    assert.ok(calls.log.indexOf('sync copy') >= 0 && calls.log.indexOf('sync copy') < first, log);
    assert.ok(!calls.log.includes('copy prev'), log);
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
    const { sfs } = syncedFs(t.f, () => true, { open: async (p, flags) => { if (p === t.f) throw errOf('EBUSY'); return fs.open(p, flags); } });
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
    const { sfs } = syncedFs(t.f, () => true, { open: async (p, flags) => { if (p === t.f) throw errOf('EPERM'); return fs.open(p, flags); } });
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
        if (p !== t.f) return h;
        return {
          readFile: (o) => h.readFile(o),
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

test('save: the in-place write fails part-way and so does writing the previous content back -> the error names the kept copy, which holds it (and a later save does not sweep it)', async () => {
  const t = await planFolder();
  try {
    let writes = 0;
    const { sfs } = syncedFs(t.f, () => true, {
      open: async (p, flags) => {
        const h = await fs.open(p, flags);
        if (p !== t.f) return h;
        return {
          readFile: (o) => h.readFile(o),
          write: async (buf, off, len, pos) => { if (++writes >= 2) throw errOf('ENOSPC'); return h.write(buf, off, Math.min(len, 3), pos); },
          truncate: (n) => h.truncate(n), sync: () => h.sync(), close: () => h.close(),
        };
      },
    });
    let kept;
    await assert.rejects(saveDrawingFile(t.f, bytesOf('v2 much longer'), { fs: sfs, ...quick }), (err) => {
      assert.equal(err.code, 'ENOSPC');
      assert.match(err.message, /^The disk is full/);
      kept = err.message.match(/ Its previous content is kept in (.+)\.$/)?.[1];
      assert.ok(kept, err.message);
      return true;
    });
    assert.ok(writes > 2, 'writing the previous content back was tried');
    assert.equal(path.dirname(kept), t.dir);
    assert.equal(await t.read(kept), 'v1');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), [path.basename(kept), 'Plan A.bak', 'Plan A.dwg'].sort());
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await fs.utimes(kept, old, old);
    await saveDrawingFile(t.f, bytesOf('v3'));
    assert.equal(await t.read(kept), 'v1', 'the copy to recover from is not a stale temporary file');
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: a rename error other than busy (EPERM/EBUSY/EACCES) -> no retry and no in-place write; plain-language error; nothing changed', async () => {
  const t = await planFolder();
  try {
    const { sfs, calls } = syncedFs(t.f, () => false);
    const rename = sfs.rename;
    sfs.rename = async (a, b) => { if (b === t.f) { calls.rename++; throw errOf('EXDEV'); } return rename(a, b); };
    await assert.rejects(saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }), { code: 'EXDEV', message: new RegExp(`^${t.f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be saved`) });
    assert.equal(calls.rename, 1, 'not retried');
    assert.deepEqual(calls.open, [], 'no in-place write');
    assert.equal(await t.read(t.f), 'v1');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: something other than a file at the .bak path -> refused before anything is written; no temp file', async () => {
  const t = await planFolder();
  try {
    await fs.rm(t.bak); await fs.mkdir(t.bak);
    let wrote = false;
    await assert.rejects(writeWithBackup(t.f, 'v2', async () => { wrote = true; }), { message: 'Could not make the backup copy Plan A.bak (EISDIR); the file was not saved.' });
    assert.equal(wrote, false);
    await assert.rejects(saveDrawingFile(t.f, bytesOf('v2')), /Could not make the backup copy Plan A\.bak/);
    assert.equal(await t.read(t.f), 'v1');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: the older .bak cannot be replaced (open elsewhere) -> saved; the previous version kept under a visible name of its own and a warning says so; no temp file', async () => {
  const t = await planFolder();
  try {
    const sfs = { ...fs, rename: async (a, b) => { if (b === t.bak) throw errOf('EBUSY'); return fs.rename(a, b); } };
    const r = await saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick });
    assert.equal(r.path, t.f);
    assert.match(path.basename(r.backup), /^Plan A \(previous \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\)\.bak$/);
    assert.equal(path.dirname(r.backup), t.dir);
    assert.equal(r.warning, `The previous version could not be kept as Plan A.bak (it may be open in another program or held by a sync client); it is kept as ${path.basename(r.backup)}.`);
    assert.equal(await t.read(t.f), 'v2');
    assert.equal(await t.read(r.backup), 'v1');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), [path.basename(r.backup), 'Plan A.bak', 'Plan A.dwg'].sort());
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: neither the .bak nor another name can take the previous version -> saved, and the warning says the .bak is older; no temp file', async () => {
  const t = await planFolder();
  try {
    const sfs = { ...fs, rename: async (a, b) => { if (path.basename(a).startsWith('.Plan A.bak.')) throw errOf('EBUSY'); return fs.rename(a, b); } };
    assert.deepEqual(await saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }), { path: t.f, backup: null,
      warning: 'The previous version could not be kept as Plan A.bak (it may be open in another program or held by a sync client); Plan A.bak still holds an older version.' });
    assert.equal(await t.read(t.f), 'v2');
    assert.equal(await t.read(t.bak), 'v0');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('keptPathOf: the .bak name with "(previous <date time>)", no characters Windows refuses', () => {
  const d = new Date(2026, 9, 20, 14, 3, 5);
  assert.equal(keptPathOf(path.join('/j', 'Plan A.bak'), d), path.join('/j', 'Plan A (previous 2026-10-20 14-03-05).bak'));
  assert.equal(keptPathOf(path.join('/j', 'Plan A.dxf.bak'), d), path.join('/j', 'Plan A.dxf (previous 2026-10-20 14-03-05).bak'));
});

test('save: removing a temporary file held for a moment (sync client) is retried -> no temp file left', async () => {
  const t = await planFolder();
  try {
    const refused = new Map();
    const { sfs } = syncedFs(t.f, () => true, {
      rm: async (p, o) => {
        const n = refused.get(p) ?? 0;
        if (n < 2) { refused.set(p, n + 1); throw errOf('EBUSY'); }
        return fs.rm(p, o);
      },
    });
    assert.deepEqual(await saveDrawingFile(t.f, bytesOf('v2'), { fs: sfs, ...quick }), { path: t.f, backup: t.bak });
    assert.ok([...refused.keys()].some((p) => kindOf(p) === 'tmp') && [...refused.keys()].some((p) => kindOf(p) === 'prev'), [...refused.keys()].join(', '));
    assert.equal(await t.read(t.f), 'v2');
    assert.deepEqual(await t.list(), ['Plan A.bak', 'Plan A.dwg']);
  } finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test('save: stale temporary files of an earlier save of this drawing (over 10 minutes old) are swept; young ones and other files are kept', async () => {
  const t = await planFolder();
  try {
    const old = new Date(Date.now() - 11 * 60 * 1000);
    const stale = ['.Plan A.dwg.4242-0123abcd.tmp', '.Plan A.dwg.7-deadbeef.tmp'];
    const keep = [
      '.Plan A.dwg.4242-89abcdef.tmp', // young
      '.Plan A.dwg.4242-0123abcd.prev', // a copy to recover from
      '.Plan A.bak.4242-0123abcd.tmp', // a .bak copy
      '.Other.dwg.4242-0123abcd.tmp', // another drawing
      'Plan A.dwg.4242-0123abcd.tmp', '.Plan A.dwg.4242-0123abcd.tmp.keep', '.Plan A.dwg.x-0123abcd.tmp', '.Plan A.dwg.4242-0123ABCD.tmp', 'notes.txt',
    ];
    for (const n of [...stale, ...keep]) {
      await fs.writeFile(path.join(t.dir, n), n);
      if (n !== keep[0]) await fs.utimes(path.join(t.dir, n), old, old);
    }
    await fs.mkdir(path.join(t.dir, '.Plan A.dwg.4242-00000000.tmp')); // a folder, not a file
    await fs.utimes(path.join(t.dir, '.Plan A.dwg.4242-00000000.tmp'), old, old);
    await saveDrawingFile(t.f, bytesOf('v2'));
    assert.equal(await t.read(t.f), 'v2');
    assert.deepEqual(await t.list(), [...keep, '.Plan A.dwg.4242-00000000.tmp', 'Plan A.bak', 'Plan A.dwg'].sort());
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
