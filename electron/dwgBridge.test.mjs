// Unit tests for the DWG bridge using fake POSIX shell-script converters.
// Run: node --test electron/
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDwgBridge, converterPath, MAX_BYTES, STDERR_LIMIT } from './dwgBridge.js';

const posix = process.platform !== 'win32';
const skip = posix ? false : 'fake converters are POSIX shell scripts';

async function fakeDir(body) {
  // Deliberately awkward path: spaces and shell metacharacters prove no shell is used.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-fake dwg $(x);'));
  for (const name of ['dwg2dxf', 'dxf2dwg']) {
    const f = path.join(dir, name);
    await fs.writeFile(f, `#!/bin/sh\nNAME=${name}\n${body}\n`);
    await fs.chmod(f, 0o755);
  }
  const tmpRoot = path.join(dir, 'tmp root');
  await fs.mkdir(tmpRoot);
  return { dir, tmpRoot, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// Success script: echo version, or write "NAME|args" followed by the input bytes to -o.
const OK = `[ "$1" = "--version" ] && { echo "$NAME 0.13.3"; exit 0; }
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; last="$a"; done
printf '%s|%s\\n' "$NAME" "$*" > "$out"; cat "$last" >> "$out"; echo "warning: noise" >&2`;

test('converterPath adds .exe only on win32', () => {
  assert.equal(converterPath('/x', 'win32', 'dwg2dxf'), path.join('/x', 'dwg2dxf.exe'));
  assert.equal(converterPath('/x', 'linux', 'dxf2dwg'), path.join('/x', 'dxf2dwg'));
});

test('available() reports version from --version, or a reason when missing', { skip }, async () => {
  const f = await fakeDir(OK);
  try {
    assert.deepEqual(await createDwgBridge(f.dir, 'linux').available(), { available: true, version: '0.13.3' });
    const missing = await createDwgBridge(path.join(f.dir, 'nope'), 'linux').available();
    assert.equal(missing.available, false);
    assert.match(missing.reason, /missing: dwg2dxf/);
  } finally { await f.cleanup(); }
});

test('toDxf runs dwg2dxf with fixed args and returns output; temp dir removed', { skip }, async () => {
  const f = await fakeDir(OK);
  try {
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot });
    const { dxfBytes } = await b.toDxf(new TextEncoder().encode('AC1015-data'));
    assert.ok(dxfBytes instanceof Uint8Array);
    const text = Buffer.from(dxfBytes).toString();
    const [head, body] = text.split('\n');
    assert.match(head, /^dwg2dxf\|-y -o \S.*output\.dxf \S.*input\.dwg$/);
    assert.equal(body, 'AC1015-data');
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally { await f.cleanup(); }
});

test('fromDxf passes --as r2000 by default and rejects unsupported versions without spawning', { skip }, async () => {
  const f = await fakeDir(OK);
  try {
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot });
    const { dwgBytes } = await b.fromDxf(new TextEncoder().encode('0\nEOF\n'));
    assert.match(Buffer.from(dwgBytes).toString(), /^dxf2dwg\|--as r2000 -y -o /);
    assert.match(Buffer.from((await b.fromDxf(new Uint8Array([48]), 'r14')).dwgBytes).toString(), /--as r14 /);
    for (const v of ['r2018', 'r12', '; rm -rf /', 2000]) {
      await assert.rejects(b.fromDxf(new Uint8Array([48]), v), /unsupported DWG output version/);
    }
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally { await f.cleanup(); }
});

test('non-zero exit surfaces stderr trimmed to 4 KB and cleans up', { skip }, async () => {
  const f = await fakeDir(`head -c 10000 /dev/zero | tr '\\0' 'E' >&2; echo "bad DWG" >&2; exit 3`);
  try {
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot });
    const err = await b.toDxf(new Uint8Array([1, 2, 3])).then(() => null, (e) => e);
    assert.ok(err, 'expected rejection');
    assert.match(err.message, /^dwg2dxf failed \(exit code 3\): EEEE/);
    assert.ok(err.stderr.length <= STDERR_LIMIT + 20, `stderr length ${err.stderr.length}`);
    assert.match(err.stderr, /\[truncated\]$/);
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally { await f.cleanup(); }
});

test('timeout kills the converter, reports it and cleans up', { skip }, async () => {
  const f = await fakeDir('exec sleep 5');
  try {
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot, timeoutMs: 300 });
    const t0 = Date.now();
    await assert.rejects(b.toDxf(new Uint8Array([1])), /dwg2dxf failed \(timed out after 0 s\)/);
    assert.ok(Date.now() - t0 < 4000);
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally { await f.cleanup(); }
});

test('exit 0 without an output file is an error', { skip }, async () => {
  const f = await fakeDir('echo "nothing written" >&2; exit 0');
  try {
    const b = createDwgBridge(f.dir, 'linux', { tmpRoot: f.tmpRoot });
    await assert.rejects(b.toDxf(new Uint8Array([1])), /produced no output: nothing written/);
    assert.deepEqual(await fs.readdir(f.tmpRoot), []);
  } finally { await f.cleanup(); }
});

test('size cap and input type are enforced before spawning', async () => {
  assert.equal(MAX_BYTES, 200 * 1024 * 1024);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-cap-'));
  try {
    // Directory does not exist: if anything were spawned the error would be ENOENT instead.
    const b = createDwgBridge(path.join(tmpRoot, 'none'), 'linux', { tmpRoot, maxBytes: 16 });
    await assert.rejects(b.toDxf(new Uint8Array(17)), /limit is 16 bytes/);
    await assert.rejects(b.toDxf(new Uint8Array(0)), /empty/);
    await assert.rejects(b.toDxf('C:\\secret.dwg'), /Uint8Array or ArrayBuffer/);
    await assert.rejects(b.fromDxf({ length: 3 }), /Uint8Array or ArrayBuffer/);
    assert.deepEqual(await fs.readdir(tmpRoot), []);
  } finally { await fs.rm(tmpRoot, { recursive: true, force: true }); }
});
