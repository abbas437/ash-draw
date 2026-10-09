// Unit tests for the ODA File Converter bridge and the engine fallback, using a stub converter (an executable Node script).
// Run: node --test "electron/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOdaBridge, createDwgService, findOdaConverter, odaVersion, ODA_HINT, ODA_TIMEOUT_MS } from './odaConverter.js';

const skip = process.platform === 'win32' ? 'the stub converter is a shebang script' : false;
const KNOWN_DXF = '  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n0\n 20\n0\n 11\n10\n 21\n10\n  0\nENDSEC\n  0\nEOF\n';

// The stub records its argv and the input folder listing to <stub dir>/calls.json, then behaves as `body` says.
async function stub(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-oda stub $(x);'));
  const exeDir = path.join(dir, 'ODAFileConverter 25.12.0');
  await fs.mkdir(exeDir);
  const exe = path.join(exeDir, 'ODAFileConverter');
  await fs.writeFile(exe, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'calls.json'))}, JSON.stringify({ argv: a, input: fs.readdirSync(a[0]) }));
${body}
`);
  await fs.chmod(exe, 0o755);
  const tmpRoot = path.join(dir, 'tmp root');
  await fs.mkdir(tmpRoot);
  return { dir, exe, tmpRoot, calls: async () => JSON.parse(await fs.readFile(path.join(dir, 'calls.json'), 'utf8')), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
const WRITE_DXF = `fs.writeFileSync(path.join(a[1], a[6].replace(/\\.dwg$/i, '.dxf')), ${JSON.stringify(KNOWN_DXF)});`;
const dwg = new TextEncoder().encode('AC1032 fake dwg');

test('ODA converter: argument array order, fixed input name, output picked up, temp folder removed', { skip }, async () => {
  const s = await stub(WRITE_DXF);
  try {
    const b = createOdaBridge(s.exe, { tmpRoot: s.tmpRoot });
    const { dxfBytes } = await b.toDxf(dwg);
    assert.equal(Buffer.from(dxfBytes).toString(), KNOWN_DXF);
    const { argv, input } = await s.calls();
    assert.equal(argv.length, 7);
    assert.match(argv[0], /ash-oda-[^/]+\/in$/);
    assert.match(argv[1], /ash-oda-[^/]+\/out$/);
    assert.deepEqual(argv.slice(2), ['ACAD2018', 'DXF', '0', '1', 'drawing.dwg']);
    assert.ok(argv[0].startsWith(s.tmpRoot), 'temp folders live under tmpRoot (path with spaces passed as one argument)');
    assert.deepEqual(input, ['drawing.dwg']);
    assert.deepEqual(await fs.readdir(s.tmpRoot), []);
    assert.equal(b.version, '25.12.0');
    assert.equal(ODA_TIMEOUT_MS, 300_000);
  } finally { await s.cleanup(); }
});

test('ODA converter: failure without output reports the .err file and cleans up', { skip }, async () => {
  const s = await stub(`fs.writeFileSync(path.join(a[1], 'drawing.dwg.err'), 'Error: bad section'); process.exit(0);`);
  try {
    await assert.rejects(createOdaBridge(s.exe, { tmpRoot: s.tmpRoot }).toDxf(dwg), /produced no DXF: Error: bad section/);
    assert.deepEqual(await fs.readdir(s.tmpRoot), []);
  } finally { await s.cleanup(); }
  const t = await stub('process.exit(3);');
  try {
    await assert.rejects(createOdaBridge(t.exe, { tmpRoot: t.tmpRoot }).toDxf(dwg), /ODA File Converter failed \(exit code 3\)/);
    assert.deepEqual(await fs.readdir(t.tmpRoot), []);
  } finally { await t.cleanup(); }
});

test('ODA converter: timeout kills it, reports it and cleans up', { skip }, async () => {
  const s = await stub('setTimeout(() => {}, 10000);');
  try {
    const t0 = Date.now();
    await assert.rejects(createOdaBridge(s.exe, { tmpRoot: s.tmpRoot, timeoutMs: 400 }).toDxf(dwg), /timed out after 0 s/);
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(await fs.readdir(s.tmpRoot), []);
  } finally { await s.cleanup(); }
});

test('auto-detect picks the newest ODAFileConverter version folder that has the exe', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ash-progfiles-'));
  try {
    const mk = async (name, exe = true) => { await fs.mkdir(path.join(root, 'ODA', name), { recursive: true }); if (exe) await fs.writeFile(path.join(root, 'ODA', name, 'ODAFileConverter.exe'), ''); };
    await mk('ODAFileConverter 21.9.0'); await mk('ODAFileConverter 25.4.0'); await mk('ODAFileConverter 25.12.0');
    await mk('ODAFileConverter 26.1.0', false); await mk('Teigha 99.0.0');
    const found = await findOdaConverter([path.join(root, 'missing'), root]);
    assert.equal(found, path.join(root, 'ODA', 'ODAFileConverter 25.12.0', 'ODAFileConverter.exe'));
    assert.equal(odaVersion(found), '25.12.0');
    assert.equal(await findOdaConverter([path.join(root, 'missing')]), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// fake engines for the fallback order
const fakeLibre = (ok) => ({ calls: 0, available: async () => ({ available: true, version: '0.13.3' }), async toDxf() { this.calls++; if (!ok) throw new Error('ERROR: read_R2004_section_info out of range'); return { dxfBytes: new Uint8Array([1]) }; } });
const service = (libre, cfg, exe, odaOk = true) => {
  const used = [];
  const svc = createDwgService({ libre, getConfig: () => cfg, detectOda: async () => exe, makeOda: (p) => ({ async toDxf() { used.push(p); if (!odaOk) throw new Error('ODA crashed'); return { dxfBytes: new Uint8Array([2]) }; } }) });
  return { svc, used };
};

test('fallback: Automatic uses ODA when installed, else LibreDWG; each falls back to the other', async () => {
  let lib = fakeLibre(false);
  let { svc, used } = service(lib, { mode: 'auto' }, '/x/ODAFileConverter.exe');
  assert.equal((await svc.toDxf(dwg)).engine, 'oda'); // installed: ODA first
  assert.deepEqual(used, ['/x/ODAFileConverter.exe']);
  lib = fakeLibre(true);
  ({ svc, used } = service(lib, { mode: 'auto' }, '/x/ODAFileConverter.exe', false));
  const r = await svc.toDxf(dwg); // ODA fails -> LibreDWG
  assert.equal(r.engine, 'libredwg');
  assert.equal(lib.calls, 1);
  assert.equal((await svc.available()).engine, 'oda');
});

test('fallback: ODA missing and LibreDWG fails -> error with the install hint; Built-in never runs ODA', async () => {
  const { svc } = service(fakeLibre(false), { mode: 'auto' }, null);
  const err = await svc.toDxf(dwg).then(() => null, (e) => e);
  assert.ok(err?.message.startsWith(ODA_HINT), err?.message);
  assert.match(err.message, /read_R2004_section_info/);
  assert.equal(err.odaHint, true);
  const b = service(fakeLibre(false), { mode: 'libredwg' }, '/x/ODAFileConverter.exe');
  await assert.rejects(b.svc.toDxf(dwg), /Install the free ODA File Converter[\s\S]*Preferences/);
  assert.deepEqual(b.used, []);
  const both = service(fakeLibre(false), { mode: 'auto' }, '/x/ODAFileConverter.exe', false);
  await assert.rejects(both.svc.toDxf(dwg), /could not be converted \(ODA File Converter: ODA crashed; LibreDWG: ERROR/);
});

test('ODA path setting must name ODAFileConverter[.exe]; ODA mode without ODA is unavailable', async () => {
  const { svc, used } = service(fakeLibre(true), { mode: 'oda', odaPath: '/bin/sh' }, '/x/ODAFileConverter.exe');
  const av = await svc.available();
  assert.equal(av.available, false);
  assert.match(av.reason, /not found at \/bin\/sh/);
  await assert.rejects(svc.toDxf(dwg), /Install the free ODA File Converter/);
  assert.deepEqual(used, []);
});
