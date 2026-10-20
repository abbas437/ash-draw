// Unit tests for the converter process registry (quit kill + temp folders), the timeout escalation, the Cancel kill
// and the start-up temp sweep, with fake converters (executable Node scripts).
// Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConverterRegistry, sweepConverterTemp, CONVERTER_TEMP, taskkillPath } from './converterProcs.js';
import { createDwgBridge } from './dwgBridge.js';
import { createOdaBridge, createDwgService } from './odaConverter.js';

const skip = process.platform === 'win32' ? 'the fake converters are shebang scripts' : false;

// a folder with dwg2dxf / dxf2dwg (and an ODAFileConverter) running `body` as Node scripts
async function fakes(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-procs test '));
  for (const name of ['dwg2dxf', 'dxf2dwg', 'ODAFileConverter']) {
    const f = path.join(dir, name);
    await fs.writeFile(f, `#!${process.execPath}\nconst fs = require('fs'), path = require('path'), cp = require('child_process');\nconst DIR = ${JSON.stringify(dir)};\n${body}\n`);
    await fs.chmod(f, 0o755);
  }
  const tmpRoot = path.join(dir, 'tmp root');
  await fs.mkdir(tmpRoot);
  return { dir, tmpRoot, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
async function until(fn, ms = 4000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 20))) { const v = fn(); if (v) return v; }
  throw new Error('timed out waiting');
}
const LONG = 'fs.writeFileSync(path.join(DIR, "pid"), String(process.pid)); setInterval(() => {}, 1000);';

test('quit: killAll kills a running converter and removes its temp folder at once', { skip, timeout: 10000 }, async () => {
  const f = await fakes(LONG);
  try {
    const registry = createConverterRegistry();
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot, registry });
    const open = b.toDxf(new Uint8Array([1, 2, 3])).then(() => null, (e) => e);
    const live = await until(() => { const l = registry.live(); return l.children.length === 1 && existsSync(path.join(f.dir, 'pid')) ? l : null; });
    const [tmp] = live.dirs;
    assert.match(path.basename(tmp), CONVERTER_TEMP);
    assert.ok(existsSync(tmp));
    const pid = live.children[0].pid;
    registry.killAll();
    assert.equal(existsSync(tmp), false, 'the temp folder is removed before killAll returns');
    assert.ok(await open, 'the open rejects');
    assert.ok(gone(pid), 'the converter process is gone');
    assert.deepEqual(registry.live(), { children: [], dirs: [] });
  } finally { await f.cleanup(); }
});

test('timeout: a converter ignoring SIGTERM is killed after the grace period', { skip, timeout: 10000 }, async () => {
  const f = await fakes(`process.on('SIGTERM', () => {}); ${LONG}`);
  try {
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot, timeoutMs: 200, graceMs: 400, registry: createConverterRegistry() });
    const t0 = Date.now();
    await assert.rejects(b.toDxf(new Uint8Array([1])), /^Error: dwg2dxf failed \(timed out after 0 s\)$/);
    assert.ok(Date.now() - t0 >= 550, 'SIGTERM first, the hard kill only after the grace period');
    assert.ok(gone(Number(await fs.readFile(path.join(f.dir, 'pid'), 'utf8'))));
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally { await f.cleanup(); }
});

test('timeout: a converter that never closes (a child holds its output) is given up with a plain message', { skip, timeout: 10000 }, async () => {
  // the grandchild inherits stderr, so 'close' never comes after the converter itself is killed
  const f = await fakes(`process.on('SIGTERM', () => {});
const g = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
fs.writeFileSync(path.join(DIR, 'gpid'), String(g.pid)); ${LONG}`);
  let gpid = null;
  try {
    const reg = createConverterRegistry();
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot, timeoutMs: 200, graceMs: 200, closeWaitMs: 300, registry: reg });
    await assert.rejects(b.toDxf(new Uint8Array([1])), /^Error: dwg2dxf failed \(timed out after 0 s and did not stop when it was ended\)$/);
    assert.equal(reg.live().children.length, 1, 'a converter given up as stuck stays registered, so quitting tries again');
    reg.killAll();
    assert.equal(reg.live().children.length, 0);
    gpid = Number(await fs.readFile(path.join(f.dir, 'gpid'), 'utf8'));
    assert.ok(gone(Number(await fs.readFile(path.join(f.dir, 'pid'), 'utf8'))));
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally {
    if (gpid) try { process.kill(gpid, 'SIGKILL'); } catch { /* gone */ }
    await f.cleanup();
  }
});

test('cancel: an aborted signal kills the converter at once and no other engine is tried', { skip, timeout: 10000 }, async () => {
  const f = await fakes(LONG);
  try {
    const registry = createConverterRegistry();
    const libre = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot, registry });
    let odaRuns = 0;
    const svc = createDwgService({ libre, getConfig: () => ({ mode: 'auto' }), detectOda: async () => path.join(f.dir, 'ODAFileConverter'),
      makeOda: (exe) => { const o = createOdaBridge(exe, { tmpRoot: f.tmpRoot, registry }); return { ...o, toDxf: (...a) => { odaRuns++; return o.toDxf(...a); } }; } });
    const ac = new AbortController();
    const open = svc.toDxf(new Uint8Array([1]), { signal: ac.signal }).then(() => null, (e) => e);
    await until(() => registry.live().children.length === 1 && existsSync(path.join(f.dir, 'pid')));
    const pid = registry.live().children[0].pid;
    ac.abort();
    const err = await open;
    assert.equal(err?.code, 'CANCELLED');
    assert.equal(odaRuns, 0);
    assert.ok(gone(pid));
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally { await f.cleanup(); }
});

test('start-up sweep: old ash-dwg-/ash-oda- folders go; young, other names and symlinks stay', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-sweep test '));
  try {
    const now = Date.now();
    const old = new Date(now - 3 * 3600_000);
    const mk = async (name, time) => { const p = path.join(root, name); await fs.mkdir(p); await fs.writeFile(path.join(p, 'output.dxf'), 'x'); await fs.utimes(p, time, time); return p; };
    await mk('ash-dwg-x1Ab2C', old);
    await mk('ash-oda-Zz9yy8', old);
    await mk('ash-dwg-young1', new Date(now - 10 * 60_000));
    await mk('ash-draw-print-abc123', old); // the print folder: not a converter's
    await mk('ash-dwg-toolongname', old);
    await mk('other', old);
    const target = await mk('elsewhere', old);
    await fs.symlink(target, path.join(root, 'ash-dwg-link01'));
    await fs.lutimes(path.join(root, 'ash-dwg-link01'), old, old);
    const removed = await sweepConverterTemp(root, { now });
    assert.deepEqual(removed.sort(), ['ash-dwg-x1Ab2C', 'ash-oda-Zz9yy8']);
    assert.deepEqual((await fs.readdir(root)).sort(), ['ash-draw-print-abc123', 'ash-dwg-link01', 'ash-dwg-toolongname', 'ash-dwg-young1', 'elsewhere', 'other']);
    assert.equal(await fs.readFile(path.join(target, 'output.dxf'), 'utf8'), 'x', 'a symlink is never followed');
    assert.deepEqual(await sweepConverterTemp(path.join(root, 'missing')), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('taskkill is Windows\' own System32 copy, never a bare name searched in the current folder', () => {
  const saved = process.env.SystemRoot;
  try {
    process.env.SystemRoot = 'D:\\Win';
    assert.equal(taskkillPath(), 'D:\\Win\\System32\\taskkill.exe');
    delete process.env.SystemRoot;
    assert.equal(taskkillPath(), 'C:\\Windows\\System32\\taskkill.exe');
  } finally { if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved; }
});
